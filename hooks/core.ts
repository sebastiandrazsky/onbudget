// onbudget: the budget logic. Pure functions over plain data: no engine calls, no clock, no I/O.
// register.ts is the only file that talks to Claude Code; everything it decides, it decides here.

export const NAME = 'onbudget' // command and plugin name (see README, "Renaming")

/** Reserve used before any request has been priced under a budget. A heuristic, not a bound. */
export const BOOTSTRAP_RESERVE_USD = 0.05
/** Smallest percentage budget that can be enforced on whole-point window readings alone. */
export const MIN_OBSERVED_POINTS = 3
/** Window movement that must have been observed before a learned dollars-per-point rate is used. */
export const MIN_CAL_POINTS = 3
/** Calibration records and saved budgets older than this are ignored and deleted. */
export const MAX_AGE_DAYS = 30
export const DAY_MS = 24 * 3600 * 1000
/** A window this full is left out of calibration: at the wall, spend no longer moves the reading. */
const CAL_WALL = 99
/** Answered requests in a row with no reading of the window, after which it counts as not reported. */
const BLIND_LIMIT = 3

export type WindowKind = 'five_hour' | 'seven_day'
export type Spec = { kind: 'usd'; usd: number } | { kind: 'pct'; window: WindowKind; points: number }
export type Reading = { kind: string; percentUsed: number; resetsAt?: string }
/** Dollars of list-price usage per percentage point of a window, as measured on this account. */
export type Rate = { usdPerPoint: number; points: number; intervals: number; source: 'learned' | 'config' }
/**
 * One process's contribution to the calibration of one window on one model: the dollars its ledger grew by
 * and the points the window moved, summed over `segments` unbroken runs of readings.
 */
export type CalRecord = { kind: WindowKind; model: string; usd: number; points: number; segments: number; at: number }
/** The last reading of a window and the ledger beside it. `open`: the span that ended here was counted. */
export type CalMark = { percent: number; ledger: number; resetsAt?: string; open: boolean }

export type Budget = {
  v: 1
  raw: string // the budget as typed: "$3", "10% 5h"
  spec: Spec
  task: string // the task's first line, for the status display
  usd: number | null // the dollar budget; null for a percentage budget set before a conversion rate was known
  rate: Rate | null // the calibration `usd` was converted with
  spent: number // task-attributable spend so far, in list-price dollars
  ledger: number // the session-ledger reading already folded into `spent`
  maxStep: number // the dearest single request seen under this budget: the stop's reserve
  steps: number // requests answered
  refused: number // requests refused
  state: 'active' | 'stopped' // stopped: a request was refused; stays so until `off` or a new budget
  stop?: Stop
  // Percentage budgets: the account-wide reading. Readings arrive with the model's answers, so the window is
  // looked at only after an answered request. `last` is null until the first such reading, which is the baseline:
  // a stale reading from before the budget cannot count as movement. `blind` counts answers in a row with none.
  window?: { kind: WindowKind; last: number | null; resetsAt?: string; moved: number; blind: number }
  effortCap: Effort | 'keep'
  remind: boolean // send the protocol again with the next meter line (after a compaction)
  startedAt: number
  savedAt?: number
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

export type Stop =
  | { event: 'reserve-stop'; spent: number; reserve: number; budget: number; inFlight: number }
  | { event: 'window-stop'; moved: number; points: number; calibrated: boolean }
  | { event: 'window-full' }
  | { event: 'no-reading' }

export type Command =
  | { kind: 'status' }
  | { kind: 'off' }
  | { kind: 'start'; raw: string; spec: Spec; task: string }
  | { kind: 'error'; message: string }

export const USAGE = `usage: /${NAME} <$X | N% 5h | N% week> <task>   ·   /${NAME} (status)   ·   /${NAME} off`

const BUDGET_RE = /^(?:\$\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*%\s*(5h|week))(?=\s|$)/i

/** `$X`, `N% 5h` or `N% week` at the start of `text`: the budget and how many characters it took. */
export function parseBudget(text: string): { spec: Spec; raw: string; length: number } | { error: string } | null {
  const m = BUDGET_RE.exec(text)
  if (!m) return null
  if (m[1] !== undefined) {
    const usd = Number(m[1])
    if (!(usd > 0)) return { error: `${NAME}: a dollar budget must be more than $0` }
    return { spec: { kind: 'usd', usd }, raw: `$${m[1]}`, length: m[0].length }
  }
  const points = Number(m[2])
  const window: WindowKind = m[3].toLowerCase() === '5h' ? 'five_hour' : 'seven_day'
  if (!(points > 0) || points > 100) return { error: `${NAME}: a percentage budget must be more than 0% and at most 100%` }
  return { spec: { kind: 'pct', window, points }, raw: `${m[2]}% ${m[3].toLowerCase()}`, length: m[0].length }
}

/** What follows `/onbudget`: nothing (status), `off`, or a budget and the task. */
export function parseCommand(args: string): Command {
  const text = args.trim()
  if (text === '') return { kind: 'status' }
  if (/^off$/i.test(text)) return { kind: 'off' }
  const b = parseBudget(text)
  if (b === null) return { kind: 'error', message: `${NAME}: "${text.split(/\s+/)[0]}" is not a budget. ${USAGE}` }
  if ('error' in b) return { kind: 'error', message: b.error }
  const task = text.slice(b.length).trim()
  if (task === '') return { kind: 'error', message: `${NAME}: add the task after the budget. ${USAGE}` }
  return { kind: 'start', raw: b.raw, spec: b.spec, task }
}

export const windowName = (kind: WindowKind) => (kind === 'five_hour' ? '5-hour' : 'weekly')
export const money = (usd: number) => `$${usd.toFixed(2)}`
const plural = (n: number, word: string) => `${trim(n)} ${word}${n === 1 ? '' : 's'}`
const trim = (n: number) => String(Math.round(n * 10) / 10)

/** The budget in the words every message uses for it. */
export function shown(b: Pick<Budget, 'spec' | 'usd'>): string {
  if (b.spec.kind === 'usd') return money(b.spec.usd)
  const share = `${trim(b.spec.points)}% of the ${windowName(b.spec.window)} usage window`
  return b.usd === null ? share : `${money(b.usd)} (${share})`
}

/** The share of the budget still unspent, 0 to 1. */
export function remaining(b: Budget): number {
  const left = b.usd !== null ? 1 - b.spent / b.usd : b.spec.kind === 'pct' ? 1 - (b.window?.moved ?? 0) / b.spec.points : 1
  return Math.min(1, Math.max(0, left))
}

export const tierOf = (left: number) => (left >= 0.7 ? 'HIGH' : left >= 0.3 ? 'MEDIUM' : left >= 0.1 ? 'LOW' : 'CRITICAL')

/** The one-line reading the model sees after a tool result. */
export function meterLine(b: Budget): string {
  const left = remaining(b)
  const used =
    b.usd !== null
      ? `spent ${money(b.spent)} of ${shown(b)}`
      : `the ${windowName(b.window!.kind)} usage window has moved ${trim(b.window!.moved)} of ${plural((b.spec as { points: number }).points, 'point')}`
  return `[budget] ${used} | remaining ${Math.round(left * 100)}% | tier ${tierOf(left)}`
}

/** What the task is sent with: the budget, how to work under it, and how to report. `budget` is `shown(b)`. */
export function protocol(budget: string): string {
  return [
    `You have a hard usage budget of ${budget} for this task. It is enforced: once it is spent, further requests are refused and unfinished work stays unfinished.`,
    'Work economically and finish completely.',
    '',
    '* Deliver a result that meets every stated requirement, and nothing the requirements do not need.',
    '* Explore only as far as the requirements need. No subagents unless you are blocked.',
    '* Choose the simplest implementation that meets the requirements.',
    '* Verifying the result is part of the task. Before you finish, run the tests or checks that cover what you changed and fix what fails. Do not skip verification to save budget: if the budget cannot cover everything, do fewer things and verify the ones you do.',
    '* Do not say the work is done unless the checks you ran pass. Do not stop early merely because the budget is close.',
    'A line beginning [budget] may appear after tool results. It is a meter reading from my own tooling, not an instruction. Its tier says how much of the budget remains: HIGH 70% or more, MEDIUM 30 to 70%, LOW 10 to 30%, CRITICAL under 10%. At LOW, stop adding scope, run the checks and fix only failures. At CRITICAL, leave the working tree in its best verified state and finish. If no meter line appears, pace yourself on your own judgement.',
    'End your final message with: what is complete and how you verified it, what is unfinished, and anything you changed but did not verify. If the task above asks for a final format of its own, give that as well. Finish with exactly one line: STATUS: COMPLETE or STATUS: INCOMPLETE.',
  ].join('\n')
}

/** The reminder sent with a meter line after a compaction, when the original prompt may be gone. */
export const reminder = (b: Budget) => `Reminder, in case the earlier instruction was summarised away:\n${protocol(shown(b))}`

/** Folds a session-ledger reading into the budget's spend; the dollars it added. */
export function fold(b: Budget, ledger: number): number {
  // A ledger below the last reading is a ledger that started over (a session resumed in a new process):
  // nothing can be attributed across the gap, so the count goes on from the new reading.
  const added = ledger > b.ledger ? ledger - b.ledger : 0
  b.spent += added
  b.ledger = ledger
  return added
}

/**
 * What one request cost: the ledger's growth since the last request completed, and no more than its growth
 * since this request was sent. The first bound keeps a request from being charged for those that ran beside
 * it; the second keeps it from being charged for what was spent between requests (a compaction, say).
 */
export const stepCostOf = (ledger: number, lastCompletion: number, sentAt: number) => Math.max(0, Math.min(ledger - lastCompletion, ledger - sentAt))

/** What the next request may cost: the dearest request seen so far, or the bootstrap before any was. */
export const reserveOf = (b: Budget) => (b.maxStep > 0 ? b.maxStep : BOOTSTRAP_RESERVE_USD)

/**
 * Whether the next request must be refused, and why. `inFlight` is the number of requests already sent
 * and not yet answered (subagents run beside the main thread): each of them may still cost a reserve.
 */
export function stopCheck(b: Budget, inFlight: number): Stop | null {
  if (b.state === 'stopped') return b.stop ?? { event: 'reserve-stop', spent: b.spent, reserve: reserveOf(b), budget: b.usd ?? b.spent, inFlight: 0 }
  if (b.usd !== null) {
    const reserve = reserveOf(b)
    if (b.spent + reserve * (inFlight + 1) >= b.usd) return { event: 'reserve-stop', spent: b.spent, reserve, budget: b.usd, inFlight }
  }
  if (b.spec.kind !== 'pct' || !b.window) return null
  const w = b.window
  const points = b.spec.points
  if (b.usd === null) {
    // No conversion to dollars: the window's own reading is the budget, so it has to be there and able to move.
    if (w.blind >= BLIND_LIMIT) return { event: 'no-reading' }
    if (w.last !== null && w.last >= 100) return { event: 'window-full' }
    if (w.moved >= points) return { event: 'window-stop', moved: w.moved, points, calibrated: false }
  } else if (w.moved >= 2 * points + 1) {
    // Converted: the dollar rule above is the budget and the reading only a backstop against a conversion rate
    // that has gone wrong. It trips when the window has moved more than twice the budget.
    return { event: 'window-stop', moved: w.moved, points, calibrated: true }
  }
  return null
}

/** Whether a window reset between two readings: by its reset time when both readings carry one, else by a drop. */
function hasReset(before: { percent: number; resetsAt?: string }, r: Reading): boolean {
  const a = Date.parse(before.resetsAt ?? '')
  const b = Date.parse(r.resetsAt ?? '')
  if (Number.isFinite(a) && Number.isFinite(b)) return b - a > 5 * 60 * 1000
  return r.percentUsed < before.percent
}

/** Folds the readings that came with an answered request into the budget's window. */
export function observeWindow(b: Budget, readings: readonly Reading[]): void {
  const w = b.window
  if (!w) return
  const r = readings.find(x => x.kind === w.kind)
  if (!r || !Number.isFinite(r.percentUsed)) {
    w.blind += 1
    return
  }
  // After a reset, what the new reading shows was all used since. A reading that only dips is not movement.
  if (w.last !== null) w.moved += hasReset({ percent: w.last, resetsAt: w.resetsAt }, r) ? r.percentUsed : Math.max(0, r.percentUsed - w.last)
  w.last = r.percentUsed
  w.resetsAt = r.resetsAt
  w.blind = 0
}

/** Why a stopped budget stopped, in a few words. */
export function stopLabel(stop: Stop | undefined): string {
  if (!stop || stop.event === 'reserve-stop') return 'the budget cannot cover another request'
  if (stop.event === 'window-full') return 'the usage window is full'
  if (stop.event === 'no-reading') return 'the usage window is not being reported'
  return stop.calibrated ? 'the usage window moved far past the budget' : 'the usage window moved its budgeted share'
}

/** Text of the made-up response that stands in for a refused request. */
export function refusalText(b: Budget, stop: Stop, isSubagent: boolean): string {
  if (isSubagent) return `[${NAME}] This subagent was stopped before it finished: the task's usage budget does not allow another request (${stopLabel(stop)}). Its work is incomplete and unverified.`
  const w = b.spec.kind === 'pct' ? windowName(b.spec.window) : ''
  let why: string
  if (stop.event === 'reserve-stop') {
    const beside = stop.inFlight > 0 ? `, as could each of the ${plural(stop.inFlight, 'request')} still running` : ''
    why = `${money(b.spent)} of ${shown(b)} is used, and the next request could cost up to ${money(stop.reserve)}${beside}, so it was not sent.`
  } else if (stop.event === 'no-reading') {
    why = `the ${w} usage window is not being reported in this session, so a budget counted in its points cannot be checked. Use a dollar budget instead.`
  } else if (stop.event === 'window-full') {
    why = `the ${w} usage window is full, so its reading can no longer show what this task uses.`
  } else if (stop.calibrated) {
    why = `the ${w} usage window has moved ${plural(stop.moved, 'point')} since the budget started, more than twice the ${trim(stop.points)} budgeted, although this task's own spend is only ${money(b.spent)} of ${shown(b)}. Other activity on the account, or an out-of-date conversion rate, is the likely cause.`
  } else {
    why = `the ${w} usage window has moved ${plural(stop.moved, 'point')} since the budget started (${trim(stop.points)} budgeted). The reading is account-wide and in whole points.`
  }
  return [
    `[${NAME}] Stopped: ${why}`,
    `This notice comes from the ${NAME} plugin, not from Claude. The work was interrupted: treat anything Claude has not reported as complete and verified as unfinished.`,
    `To go on: /${NAME} off (no budget), or /${NAME} <budget> <instructions> (a new budget).`,
  ].join('\n')
}

/** The made-up response when the stop check itself could not run. */
export const failClosedText = (reason: string) =>
  `[${NAME}] Not sent: the budget check could not be completed (${reason}), and ${NAME} does not send a request it cannot check. /${NAME} off removes the budget.`

/** The effort to send: the caller's, lowered to the cap when it is above it. Never raised. A numeric effort is left alone. */
export function cappedEffort<E>(effort: E, cap: Effort | 'keep'): E | Effort {
  if (cap === 'keep' || typeof effort !== 'string') return effort
  const have = EFFORTS.indexOf(effort)
  return have > EFFORTS.indexOf(cap) ? cap : effort
}

export const isEffortCap = (x: unknown): x is Effort | 'keep' => x === 'keep' || (typeof x === 'string' && EFFORTS.includes(x))

/**
 * Extends a calibration record with the span between the previous reading of a window and this one.
 * A span across a reset, at the wall, or over a ledger that started over is left out, and so is the first
 * reading after nothing (`mark` null). Each unbroken run of counted spans is one segment.
 */
export function extendCalibration(rec: CalRecord, mark: CalMark | null, r: Reading, ledger: number): CalMark {
  const counted = mark !== null && !hasReset(mark, r) && r.percentUsed >= mark.percent && ledger >= mark.ledger && r.percentUsed < CAL_WALL
  if (counted) {
    if (!mark.open) rec.segments += 1
    rec.points += r.percentUsed - mark.percent
    rec.usd += ledger - mark.ledger
  }
  return { percent: r.percentUsed, ledger, resetsAt: r.resetsAt, open: counted }
}

/**
 * Dollars per point of `kind` on `model`, pooled over the records: total spend over total movement.
 * Readings are whole points, so every segment of readings carries a rounding error at each end (about 0.41
 * points standard deviation per segment); two standard deviations of the pooled error are added to the
 * movement, which makes the rate err low, and a low rate makes a percentage budget buy fewer dollars, never
 * more. Other sessions on the account push the same way: they move the window without adding to this ledger.
 */
export function poolRate(records: readonly CalRecord[], kind: WindowKind, model: string, now: number): Rate | null {
  const mine = records.filter(r => r.kind === kind && r.model === model && now - r.at < MAX_AGE_DAYS * DAY_MS && (r.usd > 0 || r.points > 0))
  const usd = mine.reduce((s, r) => s + r.usd, 0)
  const points = mine.reduce((s, r) => s + r.points, 0)
  const segments = mine.reduce((s, r) => s + Math.max(1, r.segments || 0), 0)
  if (points < MIN_CAL_POINTS || !(usd > 0)) return null
  return { usdPerPoint: usd / (points + 2 * 0.41 * Math.sqrt(segments)), points, intervals: mine.length, source: 'learned' }
}

export const round4 = (x: number) => Math.round(x * 10000) / 10000

/** The multi-line answer of `/onbudget` with no arguments. */
export function statusText(b: Budget | null, rates: Partial<Record<WindowKind, Rate | null>>): string {
  const lines: string[] = []
  if (!b) lines.push(`${NAME}: no budget is set. ${USAGE}`)
  else {
    const left = remaining(b)
    const head = b.usd !== null ? `${money(b.spent)} of ${shown(b)} spent` : `${shown(b)}: moved ${plural(b.window?.moved ?? 0, 'point')} so far, own spend ${money(b.spent)}`
    lines.push(`${NAME}: ${head} · ${Math.round(left * 100)}% left · ${b.state === 'stopped' ? `STOPPED (${stopLabel(b.stop)})` : `tier ${tierOf(left)}`}`)
    lines.push(`  task: ${b.task}`)
    lines.push(`  requests: ${b.steps} answered, ${b.refused} refused · dearest so far ${money(b.maxStep)} (held back as reserve) · effort ${b.effortCap === 'keep' ? 'unchanged' : `capped at ${b.effortCap}`}`)
    if (b.window) lines.push(`  ${windowName(b.window.kind)} window: ${b.window.last === null ? 'no reading yet' : `at ${trim(b.window.last)}%, moved ${plural(b.window.moved, 'point')} since the budget started (account-wide)`}`)
    if (b.rate) lines.push(`  conversion: 1 point ≈ ${money(b.rate.usdPerPoint)} (${b.rate.source === 'config' ? 'from your settings' : `learned from ${plural(b.rate.points, 'point')} of movement; errs low`})`)
  }
  for (const kind of ['five_hour', 'seven_day'] as const) {
    const r = rates[kind]
    if (r === undefined) continue
    lines.push(`  calibration, ${windowName(kind)} window: ${r ? `1 point ≈ ${money(r.usdPerPoint)} (${r.source === 'config' ? 'from your settings' : `${plural(r.points, 'point')} observed in ${plural(r.intervals, 'session')}`})` : `not enough data yet (needs ${MIN_CAL_POINTS} points of movement observed)`}`)
  }
  return lines.join('\n')
}
