// onbudget: the budget logic. Pure functions over plain data: no engine calls, no clock, no I/O.
// register.ts is the only file that talks to Claude Code; everything it decides, it decides here.

export const NAME = 'onbudget' // command and plugin name (see README, "Renaming")
export const VERSION = '0.1.2' // as in .claude-plugin/plugin.json (a test compares them)
export const TESTED = 'Claude Code 2.1.288 to 2.1.306' // the builds every suite passed on

/**
 * Claude Code's own countdown, `<total_tokens>N tokens left</total_tokens>`, which 2.1.304 attaches to requests (type
 * `total_tokens_reminder`) counting down from a server-set 15,000,000 that starts again at each prompt. While a budget is
 * open it is left out: it is not this task's budget. A countdown under a million tokens could be a budget the person set
 * themselves (or the context window), so it is kept, and so is any countdown when CLAUDE_CODE_TOTAL_TOKENS_REMINDER is set.
 */
export const COUNTDOWN_TYPE = 'total_tokens_reminder'
export const COUNTDOWN_MIN = 1_000_000
export function isDefaultCountdown(text: string): boolean {
  const m = /^\s*<total_tokens>\s*([0-9]+|Infinite)\s+tokens left\s*<\/total_tokens>\s*$/.exec(text)
  return m !== null && (m[1] === 'Infinite' || Number(m[1]) >= COUNTDOWN_MIN)
}

/** Reserve used before any request has been priced under a budget. A heuristic, not a bound. */
export const BOOTSTRAP_RESERVE_USD = 0.05
/** Smallest percentage budget that can be enforced on whole-point window readings alone. */
export const MIN_OBSERVED_POINTS = 3
/** Window movement that must have been observed before a learned dollars-per-point rate is used. */
export const MIN_CAL_POINTS = 3
/** Calibration records and saved budgets older than this are ignored and deleted. */
export const MAX_AGE_DAYS = 30
export const DAY_MS = 24 * 3600 * 1000
/**
 * The reading at which onbudget treats a usage window as full: one point short of the account's limit, because
 * readings are whole points and the true figure can be up to a point above the reading. Every window the account
 * reports is a wall at this reading while a budget is open, and `5h` and `week` budgets are what is left below it.
 */
export const WALL_AT = 99
/** A window this full is left out of calibration: at the wall, spend no longer moves the reading. */
const CAL_WALL = 99
/** Answered requests in a row with no reading of the window, after which it counts as not reported. */
const BLIND_LIMIT = 3

export type WindowKind = 'five_hour' | 'seven_day'
export const WINDOWS: readonly WindowKind[] = ['five_hour', 'seven_day']
/** `rest`: the budget `5h` or `week`, what that window has left below the wall when the budget is set. */
export type Spec = { kind: 'usd'; usd: number } | { kind: 'pct'; window: WindowKind; points: number } | { kind: 'rest'; window: WindowKind }
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
/**
 * A usage window as a wall while a budget is open. `last` is its newest reading and `at` the task's spend before the
 * request whose answer brought it, so a reading that lags its own request is not trusted for that request. `rate`
 * converts its points into dollars when one is known. `first` is the first reading under the budget, and `stepPts`
 * the largest move between two readings seen, at least one point: what one request is reckoned to move the window
 * by when there is no rate. `seed`: made from a reading taken before the budget, whose gap to the first answer is not
 * one request's movement. `moved`: whole points the window has moved since the first reading under the budget, across
 * resets, whoever moved them (the receipt).
 */
export type Wall = { last: number; resetsAt?: string; at: number; first: number; rate: number | null; stepPts: number; seed?: boolean; moved?: number }

export type Budget = {
  v: 1
  raw: string // the budget as typed: "$3", "10% 5h", "5h"
  spec: Spec
  task: string // the task's first line, for the status display
  usd: number | null // the dollar budget; null for a budget counted in window points, or not sized yet
  rate: Rate | null // the calibration `usd` was converted with
  allowance?: number // `5h` and `week` sized without a rate: the points the window had left below the wall
  pending?: boolean // `5h` and `week` set before any reading of the window: sized from the first one
  spent: number // task-attributable spend so far, in list-price dollars
  ledger: number // the session-ledger reading already folded into `spent`
  maxStep: number // the dearest single request seen under this budget: the stop's reserve
  steps: number // requests answered
  refused: number // requests refused
  state: 'active' | 'stopped' // stopped: a request was refused; stays so until `off` or a new budget
  stop?: Stop
  // Budgets in a window's points (and `5h`/`week` until sized): the account-wide reading. Readings arrive with the
  // model's answers, so the window is looked at only after an answered request. `last` is null until the first such
  // reading, which is the baseline: a stale reading from before the budget cannot count as movement. `blind` counts
  // answers in a row with none.
  window?: { kind: WindowKind; last: number | null; resetsAt?: string; moved: number; blind: number }
  walls?: Partial<Record<WindowKind, Wall>>
  effortCap: Effort | 'keep'
  effortOver?: { effort: string; by: string } // a request went out above the cap: the effort and the plugin that set it
  remind: boolean // send the protocol again with the next meter line (after a compaction)
  startedAt: number
  savedAt?: number
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

export type Stop =
  | { event: 'reserve-stop'; spent: number; reserve: number; budget: number; inFlight: number }
  | { event: 'window-stop'; moved: number; points: number; calibrated: boolean }
  | { event: 'wall-stop'; window: WindowKind; percent: number; resetsAt?: string; inFlight: number }
  | { event: 'window-full' } // written by builds before the walls; kept so that a saved budget still reads
  | { event: 'no-reading' }

export type Command =
  | { kind: 'status' }
  | { kind: 'off' }
  | { kind: 'start'; raw: string; spec: Spec; task: string }
  | { kind: 'error'; message: string }

export const USAGE = `usage: /${NAME} <$X | N% 5h | N% week | 5h | week> <task>   ·   /${NAME} (status)   ·   /${NAME} off`

const BUDGET_RE = /^(?:\$\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*%\s*(5h|week)|(5h|week))(?=\s|$)/i
const windowOf = (word: string): WindowKind => (word.toLowerCase() === '5h' ? 'five_hour' : 'seven_day')

/** `$X`, `N% 5h`, `N% week`, `5h` or `week` at the start of `text`: the budget and how many characters it took. */
export function parseBudget(text: string): { spec: Spec; raw: string; length: number } | { error: string } | null {
  const m = BUDGET_RE.exec(text)
  if (!m) return null
  if (m[1] !== undefined) {
    const usd = Number(m[1])
    if (!(usd > 0)) return { error: `${NAME}: a dollar budget must be more than $0` }
    return { spec: { kind: 'usd', usd }, raw: `$${m[1]}`, length: m[0].length }
  }
  if (m[4] !== undefined) return { spec: { kind: 'rest', window: windowOf(m[4]) }, raw: m[4].toLowerCase(), length: m[0].length }
  const points = Number(m[2])
  if (!(points > 0) || points > 100) return { error: `${NAME}: a percentage budget must be more than 0% and at most 100%` }
  return { spec: { kind: 'pct', window: windowOf(m[3]), points }, raw: `${m[2]}% ${m[3].toLowerCase()}`, length: m[0].length }
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
export const plural = (n: number, word: string) => `${trim(n)} ${word}${trim(n) === '1' ? '' : 's'}`
export const trim = (n: number) => String(Math.round(n * 10) / 10)
/** A reset time as the readings give it, in words: " (resets 2026-10-20 14:05 UTC)". */
export const resetsText = (resetsAt?: string) => (resetsAt && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(resetsAt) ? ` (resets ${resetsAt.slice(0, 10)} ${resetsAt.slice(11, 16)} UTC)` : '')

/** The budget in the words every message uses for it. */
export function shown(b: Pick<Budget, 'spec' | 'usd' | 'allowance'>): string {
  if (b.spec.kind === 'usd') return money(b.spec.usd)
  const name = windowName(b.spec.window)
  if (b.spec.kind === 'rest') {
    if (b.usd !== null) return `${money(b.usd)} (what the ${name} usage window had left)`
    if (b.allowance !== undefined) return `${plural(b.allowance, 'point')} of the ${name} usage window (what it had left)`
    return `what the ${name} usage window has left`
  }
  const share = `${trim(b.spec.points)}% of the ${name} usage window`
  return b.usd === null ? share : `${money(b.usd)} (${share})`
}

/** Whether a reading belongs to a window that has since reset: its reset time has passed. */
export function isStale(r: Reading, now: number): boolean {
  const t = Date.parse(r.resetsAt ?? '')
  return Number.isFinite(t) && t <= now
}

// ---------------------------------------------------------------- what is left, and where the stop is

/**
 * One limit on the task: the budget, or a window of the account. `room` is what can still be spent before the stop
 * refuses a request, with the reserve already taken off; `span` is the whole of it, for the share left; `step` is what
 * one request is reckoned to cost. In dollars (`usd`), or in points of the window named by `unit`.
 */
export type Limit = { by: 'budget' | WindowKind; unit: 'usd' | WindowKind; room: number; span: number; step: number }
export type Tier = 'HIGH' | 'MEDIUM' | 'LOW' | 'CRITICAL'
const RANK: Record<Tier, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, CRITICAL: 3 }

/** What the next request may cost: the dearest request seen so far, or the bootstrap before any was. */
export const reserveOf = (b: Budget) => (b.maxStep > 0 ? b.maxStep : BOOTSTRAP_RESERVE_USD)

/** The points a budget counted in a window allows: the percentage, or what `5h`/`week` was given. Null in dollars. */
function budgetPoints(b: Budget): number | null {
  if (b.usd !== null || !b.window) return null
  if (b.spec.kind === 'pct') return b.spec.points
  return b.allowance ?? null
}

/**
 * Every limit on the task, as the stop rule applies them. `inFlight` is the number of requests already sent and not
 * yet answered (subagents run beside the main thread): each of them may still cost a reserve.
 *
 * The budget in dollars: refuse when `spent + reserve × (in flight + 1) ≥ budget`. In points (no rate known): refuse
 * once the window has moved the budgeted points. A window with a rate: refuse when that sum would carry the window
 * past WALL_AT. A window without one: refuse when the reading leaves no room for the request it may still lag, the
 * requests in flight and the next, each reckoned at `stepPts`.
 */
export function limits(b: Budget, inFlight: number): Limit[] {
  const reserve = reserveOf(b)
  const held = reserve * (inFlight + 1)
  const out: Limit[] = []
  const points = budgetPoints(b)
  if (b.usd !== null) out.push({ by: 'budget', unit: 'usd', room: b.usd - (b.spent + held), span: b.usd, step: reserve })
  else if (points !== null) out.push({ by: 'budget', unit: b.window!.kind, room: points - b.window!.moved, span: points, step: b.walls?.[b.window!.kind]?.stepPts ?? 1 })
  for (const kind of WINDOWS) {
    const w = b.walls?.[kind]
    if (!w) continue
    if (w.rate) {
      const ceiling = w.at + (WALL_AT - w.last) * w.rate // the task's spend at which the window would reach the wall
      out.push({ by: kind, unit: 'usd', room: ceiling - (b.spent + held), span: ceiling, step: reserve })
    } else {
      out.push({ by: kind, unit: kind, room: WALL_AT - w.last - w.stepPts * (inFlight + 2), span: WALL_AT - w.first - 2 * w.stepPts, step: w.stepPts })
    }
  }
  return out
}

export const tierOf = (left: number): Tier => (left >= 0.7 ? 'HIGH' : left >= 0.3 ? 'MEDIUM' : left >= 0.1 ? 'LOW' : 'CRITICAL')

/**
 * A limit's share left, 0 to 1, and its tier. CRITICAL also when two requests' worth or less is left: with requests
 * one at a time, each costing no more than the dearest before it, the meter has then read CRITICAL for at least two
 * requests before the stop can refuse one.
 */
export function grade(l: Limit): { left: number; tier: Tier } {
  const left = l.span > 0 ? Math.min(1, Math.max(0, l.room / l.span)) : 0
  return { left, tier: l.room <= 2 * l.step ? 'CRITICAL' : tierOf(left) }
}

/** The limit that binds: the most severe tier; between two at one tier, the less room left in one unit, else the smaller share. */
export function binding(b: Budget, inFlight: number): (Limit & { left: number; tier: Tier }) | null {
  let best: (Limit & { left: number; tier: Tier }) | null = null
  for (const l of limits(b, inFlight)) {
    const g = { ...l, ...grade(l) }
    if (!best) { best = g; continue }
    const d = RANK[g.tier] - RANK[best.tier]
    if (d > 0 || (d === 0 && (g.unit === best.unit ? g.room < best.room : g.left < best.left))) best = g
  }
  return best
}

/** Whether the next request must be refused, and why. Every limit applies; the budget's own is looked at first. */
export function stopCheck(b: Budget, inFlight: number): Stop | null {
  if (b.state === 'stopped') return b.stop ?? { event: 'reserve-stop', spent: b.spent, reserve: reserveOf(b), budget: b.usd ?? b.spent, inFlight: 0 }
  const w = b.window
  // Counted in points, or not sized yet: the window's own reading has to be there.
  if (w && b.usd === null && w.blind >= BLIND_LIMIT) return { event: 'no-reading' }
  for (const l of limits(b, inFlight)) {
    if (l.room > 0) continue
    if (l.by === 'budget') {
      return l.unit === 'usd'
        ? { event: 'reserve-stop', spent: b.spent, reserve: reserveOf(b), budget: b.usd!, inFlight }
        : { event: 'window-stop', moved: w!.moved, points: l.span, calibrated: false }
    }
    const wall = b.walls![l.by]!
    return { event: 'wall-stop', window: l.by, percent: wall.last, resetsAt: wall.resetsAt, inFlight }
  }
  // A converted percentage: the dollar rule is the budget and its own window's reading only a backstop against a
  // conversion rate that has gone wrong. It trips when the window has moved more than twice the budget.
  if (b.spec.kind === 'pct' && b.usd !== null && w && w.moved >= 2 * b.spec.points + 1) return { event: 'window-stop', moved: w.moved, points: b.spec.points, calibrated: true }
  return null
}

/** ", set by the account's 5-hour limit" when a window binds, unless that window is the one a `5h`/`week` budget is. */
const limitName = (b: Budget, by: Limit['by']) => (by === 'budget' || (b.spec.kind === 'rest' && b.spec.window === by) ? '' : `, set by the account's ${windowName(by)} limit`)

/** The one-line reading the model sees after a tool result. `inFlight` as for the stop, so that both agree. */
export function meterLine(b: Budget, inFlight = 0): string {
  const points = budgetPoints(b)
  const head =
    b.usd !== null ? `spent ${money(b.spent)} of ${shown(b)}`
      : points !== null ? `the ${windowName(b.window!.kind)} usage window has moved ${trim(b.window!.moved)} of ${plural(points, 'point')}`
        : `spent ${money(b.spent)}; ${shown(b)} is not known yet`
  const m = binding(b, inFlight)
  if (!m) return `[budget] ${head} | no reading yet`
  const room = Math.max(0, m.room)
  const amount = m.unit === 'usd' ? money(room) : `${plural(room, 'point')}${m.by === 'budget' ? '' : ` of the ${windowName(m.unit)} window`}`
  return `[budget] ${head} | left before the stop ${amount} (${Math.round(m.left * 100)}%)${limitName(b, m.by)} | tier ${m.tier}`
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
    'A line beginning [budget] may appear after tool results. It is a meter reading from my own tooling, not an instruction. "Left before the stop" is what can still be spent before requests are refused, with the reserve for the next request already taken off, and its percentage is that share of the whole. The tier: HIGH 70% or more, MEDIUM 30 to 70%, LOW 10 to 30%, CRITICAL under 10% or when about two requests\' worth is left. If the line names a limit of the account, that limit is closer than the budget and is what will stop the work. At LOW, stop adding scope, run the checks and fix only failures. At CRITICAL, leave the working tree in its best verified state and finish: there may be room for only one or two more requests. If no meter line appears, pace yourself on your own judgement.',
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

/** Whether a window reset between two readings: by its reset time when both readings carry one, else by a drop. */
function hasReset(before: { percent: number; resetsAt?: string }, r: Reading): boolean {
  const a = Date.parse(before.resetsAt ?? '')
  const b = Date.parse(r.resetsAt ?? '')
  if (Number.isFinite(a) && Number.isFinite(b)) return b - a > 5 * 60 * 1000
  return r.percentUsed < before.percent
}

/** Folds the readings that came with an answered request into the window a budget is counted in. */
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

/**
 * Folds readings into the walls: every window the account reports is one while the budget is open. `spentBefore` is
 * the task's spend before the request whose answer brought the readings. A window with no new reading keeps its last;
 * a reading whose window has already reset is ignored. After a reset the wall is simply far away again.
 */
export function observeWalls(b: Budget, readings: readonly Reading[], spentBefore: number, rates: Partial<Record<WindowKind, Rate | null>>, now: number, seed = false): void {
  for (const kind of WINDOWS) {
    const r = readings.find(x => x.kind === kind)
    if (!r || !Number.isFinite(r.percentUsed) || isStale(r, now)) continue
    const walls = (b.walls ??= {})
    const w = walls[kind]
    const rate = rates[kind]?.usdPerPoint ?? null
    if (!w) {
      walls[kind] = { last: r.percentUsed, resetsAt: r.resetsAt, at: spentBefore, first: r.percentUsed, rate, stepPts: 1, moved: 0, ...(seed ? { seed } : {}) }
      continue
    }
    const reset = hasReset({ percent: w.last, resetsAt: w.resetsAt }, r)
    if (!w.seed) {
      if (!reset) w.stepPts = Math.max(w.stepPts, r.percentUsed - w.last)
      w.moved = (w.moved ?? 0) + (reset ? r.percentUsed : Math.max(0, r.percentUsed - w.last))
    }
    delete w.seed
    Object.assign(w, { last: r.percentUsed, resetsAt: r.resetsAt, at: spentBefore, rate })
  }
}

/** Drops walls whose window has reset since their last reading (a session that was away): the next answer brings new ones. */
export function dropStaleWalls(b: Budget, now: number): void {
  for (const kind of WINDOWS) {
    const w = b.walls?.[kind]
    if (w && isStale({ kind, percentUsed: w.last, resetsAt: w.resetsAt }, now)) delete b.walls![kind]
  }
}

/**
 * Sizes a `5h` or `week` budget from a reading of its window: the points left below the wall, in dollars when a rate
 * is known (added to the spend before the request that brought the reading), else in points from that reading on.
 */
export function sizeRest(b: Budget, r: Reading, rate: Rate | null, spentBefore: number): void {
  const points = Math.max(0, WALL_AT - r.percentUsed)
  if (rate) {
    b.usd = round4(spentBefore + points * rate.usdPerPoint)
    b.rate = rate
  } else {
    b.allowance = points
    if (b.window) Object.assign(b.window, { last: r.percentUsed, resetsAt: r.resetsAt, moved: 0, blind: 0 })
  }
  b.pending = false
}

/**
 * What the task moved the account's windows by, as far as they were read: "the 5-hour window moved 3 points, the weekly
 * window moved 0 points". `lead` goes first, and `except` is a window it already gives.
 */
export function movedText(b: Budget, lead?: string, except?: WindowKind): string | null {
  const parts = WINDOWS.flatMap(kind => {
    const w = b.walls?.[kind]
    return w && !w.seed && kind !== except ? [`${kind === 'five_hour' ? 'the 5-hour window' : 'the weekly window'} moved ${plural(w.moved ?? 0, 'point')}`] : []
  })
  if (lead) parts.unshift(lead)
  return parts.length ? `${parts.join(', ')} (whole points, whole account)` : null
}

/**
 * The line the plugin writes (to the person, not the model) when Claude ends the task with its STATUS line. Under a
 * budget counted in points: the points its window moved against those budgeted, and the task's own spend apart.
 */
export function endText(b: Budget, status: string): string {
  const open = `The budget is still open: a follow-up prompt draws on it, and /${NAME} off removes it.`
  const points = budgetPoints(b)
  if (points === null) {
    const moved = movedText(b)
    return `${NAME}: Claude ended the task with STATUS: ${status}, at ${money(b.spent)} of ${shown(b)}${moved ? `; ${moved}` : ''}. ${open}`
  }
  const own = b.window!.kind
  const moved = movedText(b, `the ${windowName(own)} window moved ${trim(b.window!.moved)} of the ${plural(points, 'point')} budgeted`, own)
  return `${NAME}: Claude ended the task with STATUS: ${status}: ${moved}; the task's own spend was ${money(b.spent)}. ${open}`
}

/** Why a stopped budget stopped, in a few words. */
export function stopLabel(stop: Stop | undefined): string {
  if (!stop || stop.event === 'reserve-stop') return 'the budget cannot cover another request'
  if (stop.event === 'wall-stop') return `the account's ${windowName(stop.window)} limit is close`
  if (stop.event === 'window-full') return 'the usage window is full'
  if (stop.event === 'no-reading') return 'the usage window is not being reported'
  return stop.calibrated ? 'the usage window moved far past the budget' : 'the usage window moved its budgeted share'
}

// ---------------------------------------------------------------- the status line (shown to the person, never sent)

/**
 * The longest status line: Claude Code (2.1.304 to 2.1.306) shows 63 characters of a mod's status text after the mod's
 * name and cuts the rest, so the line is built to fit in 60, its most important fields first.
 */
export const STATUS_MAX = 60
const SHORT: Record<WindowKind, string> = { five_hour: '5h', seven_day: 'week' }

/** Dollars in at most 7 characters: cents below $1,000, whole dollars below a million, then millions. */
export function cash(usd: number): string {
  const x = Math.max(0, usd)
  if (x < 999.995) return `$${x.toFixed(2)}`
  if (x < 999_999.5) return `$${Math.round(x)}`
  if (x < 999.5e6) return `$${Math.round(x / 1e6)}M`
  return '>$999M'
}
const pts = (n: number) => `${trim(n)} pt${trim(n) === '1' ? '' : 's'}`

/** The budget in a few characters; `short` leaves out what a percentage or `5h`/`week` budget came to. */
function budgetLabel(b: Budget, short: boolean): string {
  if (b.spec.kind === 'usd') return cash(b.spec.usd)
  const w = SHORT[b.spec.window]
  const points = budgetPoints(b)
  if (b.spec.kind === 'pct') return b.usd === null ? `${pts(b.spec.points)} (${w})` : short ? `${trim(b.spec.points)}% ${w}` : `${cash(b.usd)} (${trim(b.spec.points)}% ${w})`
  if (b.usd !== null) return short ? w : `${cash(b.usd)} (${w})`
  if (points !== null) return `${pts(points)} (${w})`
  return short ? w : `${w} (not sized yet)`
}

/** Why a stopped budget stopped, in a few characters; empty when the spend against the budget says it. */
function stopShort(b: Budget, stop: Stop | undefined): string {
  if (!stop || stop.event === 'reserve-stop') return ''
  if (stop.event === 'wall-stop') return b.spec.kind === 'rest' && b.spec.window === stop.window ? '' : `${SHORT[stop.window]} limit`
  if (stop.event === 'window-stop') return stop.calibrated && b.window ? `${SHORT[b.window.kind]} moved ${pts(stop.moved)}` : ''
  return stop.event === 'no-reading' ? 'no reading' : 'window full'
}

/** The first of the forms that fits in STATUS_MAX, its fields joined; the last one cut to fit when none does. */
function fit(forms: string[][]): string {
  const lines = forms.map(f => f.filter(Boolean).join(' · '))
  const line = lines.find(l => l.length <= STATUS_MAX) ?? lines[lines.length - 1]
  return line.length <= STATUS_MAX ? line : `${line.slice(0, STATUS_MAX - 1)}…`
}

/**
 * The status line under the prompt, for the person: the tier, what is left before the stop and in what unit, the
 * budget, and which account limit sets the stop when one does rather than the budget. In points under a budget counted
 * in points. A stopped budget: that it stopped, the spend against the budget, and how to go on. Full detail is in
 * `/onbudget`. The model never sees this line; it reads `meterLine`.
 */
export function statusLine(b: Budget, inFlight = 0): string {
  const points = budgetPoints(b)
  const budget = (short: boolean) => `budget ${budgetLabel(b, short)}`
  if (b.state === 'stopped') {
    const why = stopShort(b, b.stop)
    const head = why ? `STOPPED (${why})` : 'STOPPED'
    const spend = (short: boolean) => `${points !== null ? trim(b.window!.moved) : cash(b.spent)} of ${budgetLabel(b, short)}`
    const off = `/${NAME} off`
    return fit([[head, spend(false), off], [head, spend(true), off], ['STOPPED', spend(false), off], ['STOPPED', spend(true), off]])
  }
  const m = binding(b, inFlight)
  if (!m) return fit([['no reading yet', budget(false)], ['no reading yet', budget(true)]])
  const room = Math.max(0, m.room)
  const wall = m.by === 'budget' ? undefined : b.walls?.[m.by]
  // Under a budget counted in points, a limit that converts to dollars is shown in its window's points.
  const amount = m.unit !== 'usd' ? pts(room) : b.usd === null && wall?.rate ? pts(Math.floor((room / wall.rate) * 10) / 10) : cash(room)
  const by = m.by !== 'budget' && !(b.spec.kind === 'rest' && b.spec.window === m.by) ? ` (${SHORT[m.by]} limit)` : ''
  const left = `${amount} left${by}`
  return fit([[`tier ${m.tier}`, left, budget(false)], [`tier ${m.tier}`, left, budget(true)], [m.tier, left, budget(true)]])
}

/** Text of the made-up response that stands in for a refused request. */
export function refusalText(b: Budget, stop: Stop, isSubagent: boolean): string {
  if (isSubagent) return `[${NAME}] This subagent was stopped before it finished: the task's usage budget does not allow another request (${stopLabel(stop)}). Its work is incomplete and unverified.`
  const w = b.spec.kind !== 'usd' ? windowName(b.spec.window) : ''
  let why: string
  if (stop.event === 'reserve-stop') {
    const beside = stop.inFlight > 0 ? `, as could each of the ${plural(stop.inFlight, 'request')} still running` : ''
    why = `${money(b.spent)} of ${shown(b)} is used, and the next request could cost up to ${money(stop.reserve)}${beside}, so it was not sent.`
  } else if (stop.event === 'wall-stop') {
    why = `the account's ${windowName(stop.window)} usage limit is close: the window is at ${trim(stop.percent)}%${resetsText(stop.resetsAt)}. ${NAME} stops here so that Claude Code's own limit does not end the session in the middle of a request. This task had spent ${money(b.spent)} of ${shown(b)}.`
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

/** Why a prompt sent after the budget stopped is not passed on. */
export const stoppedText = (b: Budget) =>
  `${NAME}: the budget has stopped this session (${money(b.spent)} of ${shown(b)} used: ${stopLabel(b.stop)}), so the prompt was not sent. /${NAME} off removes the budget; /${NAME} <budget> <instructions> sets a new one.`

/** The made-up response when the stop check itself could not run. */
export const failClosedText = (reason: string) =>
  `[${NAME}] Not sent: the budget check could not be completed (${reason}), and ${NAME} does not send a request it cannot check. /${NAME} off removes the budget.`

/**
 * Whether a hook beneath this one sent the request above the effort cap, and which: `trace` lists each link beneath,
 * nearest first and the engine last, with what it received. The effort the last one received is what was sent.
 */
export function effortBeneath(trace: readonly { plugin: string; received: unknown }[] | undefined, mine: unknown, cap: Effort | 'keep'): { effort: string; by: string } | null {
  if (cap === 'keep' || !trace?.length) return null
  const effortOf = (x: unknown) => (typeof x === 'object' && x !== null ? (x as { effort?: unknown }).effort : undefined)
  const sentWith = effortOf(trace[trace.length - 1].received)
  if (typeof sentWith !== 'string' || cappedEffort(sentWith, cap) === sentWith) return null
  let by = trace[0].plugin
  for (let i = 1; i < trace.length; i++) if (effortOf(trace[i].received) !== effortOf(trace[i - 1].received)) { by = trace[i - 1].plugin; break }
  return effortOf(trace[0].received) === mine ? { effort: sentWith, by } : null
}

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

/** The `/onbudget` reading of one wall: where the window is and where onbudget stops for it. */
function wallText(b: Budget, kind: WindowKind, w: Wall): string {
  const where = `at ${trim(w.last)}%${resetsText(w.resetsAt)}${w.seed ? '' : `, moved ${plural(w.moved ?? 0, 'point')} since the budget started (whole points, whole account)`}`
  if (w.rate) return `${where}; ${NAME} stops for it after about ${money(Math.max(0, w.at + (WALL_AT - w.last) * w.rate - b.spent))} more (1 point ≈ ${money(w.rate)})`
  return `${where}; no conversion rate is known, so ${NAME} stops for it at about ${trim(WALL_AT - 2 * w.stepPts)}%`
}

/** The multi-line answer of `/onbudget` with no arguments. */
export function statusText(b: Budget | null, rates: Partial<Record<WindowKind, Rate | null>>, inFlight = 0, readings = true): string {
  const lines: string[] = []
  if (!b) {
    lines.push(`${NAME}: no budget is set. ${USAGE}`)
    if (!readings) lines.push(`  No usage-window reading has arrived in this session yet: the first comes with Claude's first answer. A dollar budget works now; 5h, week and percentage budgets are sized or checked from that reading.`)
  }
  else {
    const m = binding(b, inFlight)
    const points = budgetPoints(b)
    const head =
      b.usd !== null ? `${money(b.spent)} of ${shown(b)} spent`
        : points !== null ? `${shown(b)}: moved ${plural(b.window?.moved ?? 0, 'point')} so far, own spend ${money(b.spent)}`
          : `${shown(b)}: not known yet, own spend ${money(b.spent)}`
    const left = m ? ` · left before the stop ${m.unit === 'usd' ? money(Math.max(0, m.room)) : plural(Math.max(0, m.room), 'point')} (${Math.round(m.left * 100)}%)${limitName(b, m.by)}` : ''
    lines.push(`${NAME}: ${head}${left} · ${b.state === 'stopped' ? `STOPPED (${stopLabel(b.stop)})` : m ? `tier ${m.tier}` : 'no reading yet'}`)
    lines.push(`  task: ${b.task}`)
    lines.push(`  requests: ${b.steps} answered, ${b.refused} refused · dearest so far ${money(b.maxStep)} (held back as reserve) · effort ${b.effortCap === 'keep' ? 'unchanged' : `capped at ${b.effortCap}`}`)
    if (b.effortOver) lines.push(`  effort: the plugin ${b.effortOver.by} sent requests at ${b.effortOver.effort}, above the cap; the stop still holds, the cap does not`)
    if (b.window && b.spec.kind === 'pct') lines.push(`  ${windowName(b.window.kind)} window under the budget: ${b.window.last === null ? 'no reading yet' : `moved ${plural(b.window.moved, 'point')} since the budget started (account-wide)`}`)
    for (const kind of WINDOWS) {
      const w = b.walls?.[kind]
      if (w) lines.push(`  account limit, ${windowName(kind)} window: ${wallText(b, kind, w)}`)
    }
    if (b.rate) lines.push(`  conversion: 1 point ≈ ${money(b.rate.usdPerPoint)} (${b.rate.source === 'config' ? 'from your settings' : `learned from ${plural(b.rate.points, 'point')} of movement; errs low`})`)
  }
  lines.push(`  ${NAME} ${VERSION}, tested on ${TESTED}`)
  for (const kind of WINDOWS) {
    const r = rates[kind]
    if (r === undefined) continue
    lines.push(`  calibration, ${windowName(kind)} window: ${r ? `1 point ≈ ${money(r.usdPerPoint)} (${r.source === 'config' ? 'from your settings' : `${plural(r.points, 'point')} observed in ${plural(r.intervals, 'session')}${kind === 'seven_day' ? '; used only for the weekly limit under other budgets, since weekly budgets count points unless usdPerPointWeek is set' : ''}`})` : `not enough data yet (needs ${MIN_CAL_POINTS} points of movement observed)`}`)
  }
  return lines.join('\n')
}
