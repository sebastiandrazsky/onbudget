// onbudget: the Claude Code side. Hooks only; every decision is made in core.ts.
//
// Everything this module does:
//   reads    the session's cost ledger and rate-limit readings, its id and model, the environment variables
//            ONBUDGET, ONBUDGET_LOG and CLAUDE_CODE_TOTAL_TOKENS_REMINDER, and its own store;
//   writes   its own store (each session's budget; calibration records of dollars spent and points moved; the
//            last reading of each usage window), its status line, and, only when ONBUDGET_LOG is 1, an event log
//            in its own folder (log/events.jsonl under the plugin's directory);
//   changes  only while a budget is set: the effort of each model request (lowered to the cap, never raised),
//            one line of context after each tool result and with each later prompt, the refusal of requests the
//            budget cannot cover, and Claude Code's own token countdown, which is left out of new requests.
// It runs no commands and makes no model or network calls of its own. With no budget set, every hook passes
// its event through unchanged; the only work left is the calibration record kept at session.measure.
import type { EngineInterface, PromptOrigin, Register, SessionUsage, TurnStepInput, TurnStepResult } from 'claude-code'
import {
  type Budget, type CalMark, type CalRecord, type Effort, type Rate, type Reading, type Spec, type WindowKind,
  BOOTSTRAP_RESERVE_USD, COUNTDOWN_TYPE, DAY_MS, MAX_AGE_DAYS, MIN_OBSERVED_POINTS, NAME, WALL_AT, WINDOWS,
  binding, cappedEffort, dropStaleWalls, effortBeneath, endText, isDefaultCountdown, plural, extendCalibration, failClosedText, fold, isEffortCap, isStale, meterLine, money, observeWalls, observeWindow,
  parseCommand, poolRate, protocol, refusalText, reminder, reserveOf, resetsText, round4, shown, sizeRest, statusLine, statusText, stepCostOf, stopCheck,
  stoppedText, trim, windowName,
} from './core.ts'

type Engine = EngineInterface
const TYPED = new RegExp(`^\\s*/${NAME}(?:\\s+([\\s\\S]*))?$`) // the command arriving as prompt text (slash commands off, SDK hosts)
const OWN_NAME = new RegExp(`^${NAME}: `)
const LOG_CHUNK = 200

// Session state. The store is the record: a reload, a resumed session or a switch to another session reads it back.
// Store keys: budget:<session>, env:<session> (ONBUDGET was used or cancelled there),
// cal:<window>:<day>:<session>:<model> (one calibration record; the day lets old ones be deleted unread), and
// seen:<window> (the newest reading of that window on this machine, for a budget set before a session has its own), and
// hid:<session> (which countdowns were left out of that session's requests, by text and by the order in which that text
// appeared, so that a resumed session leaves out the same ones).
let boot: Promise<void> | null = null
let sid = ''
let budget: Budget | null = null
let envBudget: string | undefined // ONBUDGET: the budget for this session's first prompt, until it is used
let effortCap: Effort | 'keep' = 'medium'
let fixedRate: Partial<Record<WindowKind, number>> = {}
let stepMark = 0 // the ledger when the last request completed
let inFlight = 0 // requests sent and not yet answered, over all loops
let switched = false // the process moved to another session (/clear, /resume) since the state was read
let reads: Promise<unknown> = Promise.resolve()
const sent = new Set<string>() // requests handed to the engine, for the handler that runs when the step hook fails
const calRecs = new Map<string, CalRecord>() // this process's calibration records, by store key
let calMarks: Partial<Record<WindowKind, CalMark & { model: string }>> = {}
let calDay = 0
let others: CalRecord[] | null = null
const seenMark: Partial<Record<WindowKind, string>> = {}
let interactive = false
let countdownSet = false // CLAUDE_CODE_TOTAL_TOKENS_REMINDER is set: the person chose the countdown, so it is kept
let history = false // a resumed session before this process's first request: the engine asks again about attachments it sent
let hidden: Record<string, number[]> = {} // countdowns left out of this session's requests: text -> occurrences (hid:<session>)
const asked = new Map<string, number>() // how often each countdown text has been asked about in this process
const HIDDEN_KEEP = 2000
const LOADED = Date.now() // when this module loaded: a session that began well before it was resumed
let logOn = false // ONBUDGET_LOG=1: the event log is written, to log/events.jsonl in the plugin's own folder
let logCleared = false // the chunks an earlier process left there were emptied
let logRows: string[] = []
let logChunk = 0
let logWrites: Promise<unknown> = Promise.resolve()
let t0 = 0

const stepKey = (e: TurnStepInput) => `${e.agentId ?? ''}|${e.turnId}|${e.index}`
const errText = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 300)
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null
const isBudget = (x: unknown): x is Budget => isRecord(x) && x.v === 1 && isRecord(x.spec) && typeof x.spent === 'number' && typeof x.ledger === 'number'
const isCalRecord = (x: unknown): x is CalRecord => isRecord(x) && typeof x.usd === 'number' && typeof x.points === 'number' && typeof x.at === 'number'
const fromPerson = (origin: PromptOrigin) => origin.kind === 'composer' || origin.kind === 'sdk' || origin.kind === 'bridge'
const calKey = (kind: WindowKind, model: string) => `cal:${kind}:${calDay}:${sid}:${model}`

function ledgerOf(u: SessionUsage): number {
  const usd = u.cost?.usd
  if (typeof usd !== 'number' || !Number.isFinite(usd)) throw new Error('this session reports no cost')
  return usd
}

/**
 * The event log, for evaluation and debugging. Off unless ONBUDGET_LOG is 1; never changes a run. It is one fixed file
 * in the plugin's own folder, `log/events.jsonl`, continued in `log/events.1.jsonl`, `log/events.2.jsonl`, ... every
 * LOG_CHUNK rows. Each process that logs starts it again. No other path is ever written: without an absolute plugin
 * folder there is no log.
 */
async function log($: Engine, kind: string, data: unknown): Promise<void> {
  if (!logOn) return
  try {
    const root = $.plugin.root
    if (typeof root !== 'string' || !root.startsWith('/')) return
    if (!logCleared) {
      logCleared = true
      for (let n = 1; n <= 1000 && (await $.fs.exists(`${root}/log/events.${n}.jsonl`)); n++) await $.fs.write(`${root}/log/events.${n}.jsonl`, '')
    }
    if (logRows.length >= LOG_CHUNK) { logRows = []; logChunk += 1 }
    logRows.push(JSON.stringify({ t: (await $.clock.now()) - t0, kind, data }))
    const chunk = logChunk
    const body = logRows.join('\n') + '\n'
    logWrites = logWrites.then(() => $.fs.write(chunk === 0 ? `${root}/log/events.jsonl` : `${root}/log/events.${chunk}.jsonl`, body)).catch(() => undefined)
    await logWrites
  } catch { /* ignore */ }
}

// The engine starts a log line with the plugin's name (mods API, $.ui.log), so the text does not repeat it.
const say = ($: Engine, text: string) => { try { $.ui.log(text.startsWith(`${NAME}: `) ? text.slice(NAME.length + 2) : text) } catch { /* a host with no transcript */ } }

/** Reads this session's saved state: once per load of the module, and again after the process changes session. */
const ready = ($: Engine) => (boot ??= load($).catch(err => { boot = null; throw err }))

async function load($: Engine): Promise<void> {
  const now = await $.clock.now()
  if (t0 === 0) t0 = now
  calDay = Math.floor(now / DAY_MS)
  sid = await $.session.id()
  // The engine wants each variable read by its literal name, so that what a module reads can be listed.
  const env = (read: Promise<string | undefined>) => read.then(v => v?.trim() || undefined, () => undefined)
  logOn = (await env($.env.get('ONBUDGET_LOG'))) === '1'
  envBudget = (await $.store.get(`env:${sid}`)) === undefined ? await env($.env.get('ONBUDGET')) : undefined
  countdownSet = (await env($.env.get('CLAUDE_CODE_TOTAL_TOKENS_REMINDER'))) !== undefined
  const kept = await $.store.get(`hid:${sid}`)
  hidden = {}
  if (isRecord(kept) && isRecord(kept.hidden)) for (const [text, at] of Object.entries(kept.hidden)) if (Array.isArray(at)) hidden[text] = at.filter(n => typeof n === 'number')
  // A session that began before this process (a resume, a switch with /resume) has attachments the engine will ask
  // about again before the first request goes out; until then they are answered as they were when first sent.
  const began = (await $.session.usage().catch(() => null))?.startedAt
  history = typeof began === 'number' && (switched || began < LOADED - 10_000)
  await prune($, now)
  const saved = await $.store.get(`budget:${sid}`)
  if (isBudget(saved)) {
    budget = saved
    envBudget = undefined
    stepMark = ledgerOf(await $.session.usage())
    // Counting goes on from the ledger as it stands. In a new process it may have started over, and after a
    // switch inside one process it belongs to the process, not the session: either way the saved mark is not it.
    if (switched || stepMark < budget.ledger) budget.ledger = stepMark
    // A converted budget uses the window only as a backstop on what happens while it runs, so it starts a new
    // baseline. An unconverted one counts the window's movement whoever caused it, so its baseline is kept.
    if (budget.window && budget.usd !== null) { budget.window.last = null; budget.window.blind = 0 }
    dropStaleWalls(budget, now)
  }
  switched = false
}

/** Deletes what has expired: calibration records by the day in their key, other sessions' budgets and flags by age. */
async function prune($: Engine, now: number): Promise<void> {
  try {
    for (const key of await $.store.keys()) {
      if (key.startsWith('cal:')) {
        const day = Number(key.split(':')[2])
        if (!(calDay - day <= MAX_AGE_DAYS)) await $.store.delete(key)
      } else if ((key.startsWith('budget:') || key.startsWith('env:') || key.startsWith('hid:')) && !key.endsWith(`:${sid}`)) {
        const value = await $.store.get(key)
        const at = isBudget(value) ? (value.savedAt ?? value.startedAt) : isRecord(value) && typeof value.at === 'number' ? value.at : 0
        if (now - at >= MAX_AGE_DAYS * DAY_MS) await $.store.delete(key)
      }
    }
  } catch { /* housekeeping never stops a session */ }
}

/** Forgets the session the process is leaving (/clear, /resume): the next hook reads the new one's state. */
function leaveSession(): void {
  budget = null
  boot = null
  others = null
  envBudget = undefined
  switched = true
  calRecs.clear()
  calMarks = {}
  hidden = {}
  asked.clear()
}

/** Reads the ledger and folds it into the budget. Reads are queued, so readings are folded in the order taken. */
function sync<T = void>($: Engine, then?: (ledger: number, usage: SessionUsage) => T): Promise<T> {
  const run = async () => {
    const usage = await $.session.usage()
    const ledger = ledgerOf(usage)
    if (budget) fold(budget, ledger)
    return then ? then(ledger, usage) : (undefined as T)
  }
  const p = reads.then(run, run)
  reads = p.catch(() => undefined)
  return p
}

async function save($: Engine): Promise<void> {
  if (!budget) return
  budget.savedAt = await $.clock.now()
  await $.store.set(`budget:${sid}`, budget)
}

function showStatus($: Engine): void {
  try {
    // The engine shows the line under the plugin's name, so the text does not repeat it.
    $.ui.status(budget ? statusLine(budget, inFlight) : undefined)
  } catch { /* a host with no status line */ }
}

/** Calibration records of the account's other sessions and earlier processes, read once. */
async function otherRecords($: Engine): Promise<CalRecord[]> {
  if (others) return others
  const found: CalRecord[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('cal:') || calRecs.has(key)) continue
    const value = await $.store.get(key)
    if (isCalRecord(value)) found.push(value)
  }
  return (others = found)
}

/** Dollars per point of a window on this account: the user's own figure when configured, else the learned one. */
async function rateFor($: Engine, kind: WindowKind): Promise<Rate | null> {
  const fixed = fixedRate[kind]
  if (fixed !== undefined && fixed > 0) return { usdPerPoint: fixed, points: 0, intervals: 0, source: 'config' }
  return poolRate([...(await otherRecords($)), ...calRecs.values()], kind, await $.session.model(), await $.clock.now())
}

/** The session's model, with this process's calibration records for it ready to be extended. */
async function calModel($: Engine): Promise<string> {
  const model = await $.session.model()
  for (const kind of WINDOWS) {
    const key = calKey(kind, model)
    if (calRecs.has(key)) continue
    const kept = await $.store.get(key) // this process's own record, from before a reload
    calRecs.set(key, isCalRecord(kept) ? { ...kept, segments: kept.segments || 1 } : { kind, model, usd: 0, points: 0, segments: 0, at: 0 })
  }
  return model
}

/** Extends the calibration records with readings and the ledger beside them; the keys of those that grew. */
function noteCalibration(readings: readonly Reading[], ledger: number, model: string): string[] {
  const grew: string[] = []
  for (const kind of WINDOWS) {
    const r = readings.find(x => x.kind === kind)
    const rec = calRecs.get(calKey(kind, model))
    if (!r || !rec || !Number.isFinite(r.percentUsed)) continue
    const mark = calMarks[kind]
    const before = rec.usd + rec.points
    // A span that began on another model is not this model's: it only sets the mark.
    calMarks[kind] = { ...extendCalibration(rec, mark && mark.model === model ? mark : null, r, ledger), model }
    if (rec.usd + rec.points !== before) grew.push(calKey(kind, model))
  }
  return grew
}

async function saveCalibration($: Engine, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    const rec = calRecs.get(key)
    if (!rec) continue
    rec.at = await $.clock.now()
    await $.store.set(key, rec)
  }
}

/** The rates the walls convert with, per window: the same as a percentage budget would use. */
async function wallRates($: Engine): Promise<Record<WindowKind, Rate | null>> {
  return { five_hour: await rateFor($, 'five_hour'), seven_day: await rateFor($, 'seven_day') }
}

/**
 * The rates a budget converts with and its walls use. A weekly budget (`week`, `N% week`) takes a weekly rate only from
 * the user's setting: the learned one errs far low for that window (README, "Window readings"), which would stop the
 * task well short of the share it names, so without a setting the budget counts the window's own points.
 */
async function budgetRates($: Engine, spec: Spec): Promise<Record<WindowKind, Rate | null>> {
  const rates = await wallRates($)
  if (spec.kind !== 'usd' && spec.window === 'seven_day' && rates.seven_day?.source !== 'config') rates.seven_day = null
  return rates
}

/** Keeps the newest reading of each window in the store when it changes, for a budget set before a session has one. */
async function noteSeen($: Engine, readings: readonly Reading[]): Promise<void> {
  for (const kind of WINDOWS) {
    const r = readings.find(x => x.kind === kind)
    if (!r || !Number.isFinite(r.percentUsed) || typeof r.resetsAt !== 'string') continue
    const mark = `${r.percentUsed}|${r.resetsAt}`
    if (seenMark[kind] === mark) continue
    seenMark[kind] = mark
    await $.store.set(`seen:${kind}`, { percentUsed: r.percentUsed, resetsAt: r.resetsAt, at: await $.clock.now() })
  }
}

/** The readings a new budget starts from: the session's own where they are current, else the newest seen on this machine. */
async function startReadings($: Engine, usage: SessionUsage, now: number): Promise<{ live: Reading[]; known: Reading[] }> {
  const live = usage.rateLimits.filter(r => (WINDOWS as readonly string[]).includes(r.kind) && Number.isFinite(r.percentUsed) && !isStale(r, now))
  const known = [...live]
  for (const kind of WINDOWS) {
    if (live.some(r => r.kind === kind)) continue
    const v = await $.store.get(`seen:${kind}`).catch(() => undefined)
    if (isRecord(v) && typeof v.percentUsed === 'number' && typeof v.resetsAt === 'string' && !isStale({ kind, percentUsed: v.percentUsed, resetsAt: v.resetsAt }, now)) {
      known.push({ kind, percentUsed: v.percentUsed, resetsAt: v.resetsAt })
    }
  }
  return { live, known }
}

/** Marks ONBUDGET as dealt with for this session, so that a reload does not arm it again. */
async function retireEnv($: Engine): Promise<void> {
  envBudget = undefined
  await $.store.set(`env:${sid}`, { at: await $.clock.now() })
}

/** Runs `/onbudget <args>`: what to tell the person, and, for a new budget, the prompt to send. */
async function command($: Engine, args: string): Promise<{ say: string; prompt?: string }> {
  const c = parseCommand(args)
  if (c.kind === 'error') return { say: c.message }
  // The latest spend, when the ledger can be read; status and off must work even when it cannot.
  const refresh = () => (budget ? sync($).catch(() => undefined) : Promise.resolve())
  const spendOf = (b: Budget) => `${money(b.spent)} of ${shown(b)} was spent` + (b.state === 'stopped' ? ' and the budget had stopped the session' : '')
  if (c.kind === 'status') {
    await refresh()
    const pending = !budget && envBudget ? `\n  pending: ONBUDGET=${envBudget} applies to the next prompt (/${NAME} off cancels it)` : ''
    const readings = (await $.session.usage()).rateLimits.some(r => (WINDOWS as readonly string[]).includes(r.kind))
    return { say: statusText(budget, await wallRates($), inFlight, readings) + pending }
  }
  if (c.kind === 'off') {
    if (!budget) {
      if (!envBudget) return { say: `${NAME}: no budget is set.` }
      await retireEnv($)
      return { say: `${NAME}: the budget in ONBUDGET was cancelled for this session. Requests are not metered or refused.` }
    }
    await refresh()
    const b = budget
    await $.store.delete(`budget:${sid}`)
    budget = null
    showStatus($)
    await log($, 'off', { spent: b.spent, budget: b.usd, state: b.state })
    return { say: `${NAME}: budget removed (${spendOf(b)}). Requests are no longer metered or refused.` }
  }

  let usd: number | null = null
  let rate: Rate | null = null
  let allowance: number | undefined
  let pending = false
  let restAt: Reading | undefined // `5h`/`week` counted in points: the reading it was sized from, its baseline
  const notes: string[] = []
  const weeklyPoints = 'A weekly budget is counted in the weekly window\'s own points unless usdPerPointWeek is set (the rate learned for that window errs far low), so the budget'
  const startedAt = await $.clock.now()
  const rates = await budgetRates($, c.spec)
  const { live, known } = await startReadings($, await $.session.usage(), startedAt)
  const spec = c.spec
  if (spec.kind === 'usd') usd = spec.usd
  else if (spec.kind === 'pct') {
    const kind = spec.window
    rate = rates[kind]
    if (rate) {
      usd = round4(spec.points * rate.usdPerPoint)
      notes.push(`Converted at 1 point ≈ ${money(rate.usdPerPoint)} (${rate.source === 'config' ? 'your setting' : `learned from ${Math.round(rate.points)} points of movement seen on this machine; it errs low, so the budget errs small`}).`)
    } else if (spec.points < MIN_OBSERVED_POINTS && kind === 'seven_day') {
      return { say: `${NAME}: cannot enforce ${c.raw}. Weekly budgets are counted in the weekly window's own whole points unless usdPerPointWeek is set, so the smallest is ${MIN_OBSERVED_POINTS}%; a dollar budget works now.` }
    } else if (spec.points < MIN_OBSERVED_POINTS) {
      return { say: `${NAME}: cannot enforce ${c.raw} yet. The ${windowName(kind)} window is reported in whole points for the whole account, and ${NAME} has not yet seen enough usage to convert a point into dollars. Until it has, the smallest percentage budget is ${MIN_OBSERVED_POINTS}%; a dollar budget works now.` }
    } else {
      notes.push(`${kind === 'seven_day' ? weeklyPoints : 'No conversion to dollars is known yet, so the budget'} is enforced on the window's own reading: whole points, account-wide. It stops when the window has moved ${spec.points} points, whoever used them, and can be off by a point or by one request.`)
    }
  } else {
    // `5h` or `week`: what the window has left below the wall, read now when the session has a current reading.
    const kind = spec.window
    const r = live.find(x => x.kind === kind)
    if (!r) {
      pending = true
      const seen = known.find(x => x.kind === kind)
      notes.push(`This session has no current reading of the ${windowName(kind)} window yet${seen ? ` (it was at ${trim(seen.percentUsed)}% when last seen on this machine)` : ''}. The budget is sized from the first reading, which arrives with Claude's first answer.`)
    } else {
      const points = Math.max(0, WALL_AT - r.percentUsed)
      rate = rates[kind]
      if (rate) {
        usd = round4(points * rate.usdPerPoint)
        notes.push(`The window is at ${trim(r.percentUsed)}%: ${trim(points)} points are left below ${WALL_AT}%, about ${money(usd)} at 1 point ≈ ${money(rate.usdPerPoint)} (${rate.source === 'config' ? 'your setting' : 'learned on this machine; it errs low'}).`)
      } else {
        allowance = points
        restAt = r
        notes.push(kind === 'seven_day'
          ? `The window is at ${trim(r.percentUsed)}%. ${weeklyPoints} is the window's own reading: ${trim(points)} points are left below ${WALL_AT}%, and it stops about two points before that, at ${WALL_AT - 2}%, because the reading may not yet show the last requests.`
          : `The window is at ${trim(r.percentUsed)}% and no conversion to dollars is known yet, so the budget is the window's own reading: it stops when the window has moved ${trim(points)} points, whoever used them, or a little before.`)
      }
    }
  }
  if (usd !== null && usd <= BOOTSTRAP_RESERVE_USD && spec.kind !== 'rest') return { say: `${NAME}: ${shown({ spec, usd })} is too small to send a single request under (a ${money(BOOTSTRAP_RESERVE_USD)} reserve is held back). Nothing was sent.` }

  // The account's windows as walls, from the readings at hand; a window with nothing left refuses the budget.
  const fresh = (): Budget => ({
    v: 1, raw: c.raw, spec, task: c.task.split('\n')[0].slice(0, 120), usd, rate, allowance, pending: pending || undefined,
    spent: 0, ledger: 0, maxStep: 0, steps: 0, refused: 0, state: 'active',
    window: spec.kind === 'usd' ? undefined : { kind: spec.window, last: restAt?.percentUsed ?? null, resetsAt: restAt?.resetsAt, moved: 0, blind: 0 },
    effortCap, remind: false, startedAt,
  })
  const probe = fresh()
  observeWalls(probe, known, 0, rates, startedAt, true)
  const blocked = stopCheck(probe, 0)
  if (blocked && (blocked.event === 'wall-stop' || spec.kind === 'rest')) {
    const kind = blocked.event === 'wall-stop' ? blocked.window : (spec as { window: WindowKind }).window
    const r = known.find(x => x.kind === kind)
    return { say: `${NAME}: the ${windowName(kind)} usage window is at ${trim(r?.percentUsed ?? WALL_AT)}%${resetsText(r?.resetsAt)}, so nothing is left to run a budget on before it resets. Nothing was sent.` }
  }
  const first = binding(probe, 0)
  if (first && first.by !== 'budget' && !(spec.kind === 'rest' && spec.window === first.by)) {
    const w = probe.walls![first.by]!
    notes.push(`The account's ${windowName(first.by)} window is at ${trim(w.last)}%, so less is left in it than the budget: about ${first.unit === 'usd' ? money(Math.max(0, first.room)) : plural(Math.max(0, first.room), 'point')} before ${NAME} stops for it. The task runs against that.`)
  } else {
    for (const kind of WINDOWS) {
      const w = probe.walls?.[kind]
      if (w && !w.rate && w.last >= 90) notes.push(`The account's ${windowName(kind)} window is at ${trim(w.last)}% and no conversion to dollars is known for it: ${NAME} stops for it at about ${WALL_AT - 2}%, which may come before the budget is spent.`)
    }
  }

  const prev = budget
  const prevMark = stepMark
  // The old budget's last reading and the new budget's first are one queued read, so nothing spent in between
  // is counted twice or lost.
  const { closed, usage } = await sync($, (ledger, usage) => {
    const closed = prev ? spendOf(prev) : undefined
    budget = { ...fresh(), ledger, walls: probe.walls }
    stepMark = ledger
    return { closed, usage }
  })
  const b = budget!
  try {
    await save($)
    if (envBudget) await retireEnv($)
  } catch (err) {
    budget = prev
    stepMark = prevMark
    throw err
  }
  showStatus($)
  await log($, 'budget', { raw: c.raw, spec, usd, rate, allowance: allowance ?? null, pending, walls: b.walls ?? null, effortCap, task: b.task, base: b.ledger, replaced: closed ?? null })
  if (closed) notes.unshift(`The previous budget was closed (${closed}).`)
  if ((usage.context?.tokens ?? 0) > 100_000) notes.push('Note: this session already holds a large conversation; if it has been idle, the first request re-reads all of it and can be costly.')
  if (effortCap !== 'keep') notes.push(`Effort is capped at ${effortCap} while the budget is set.`)
  return {
    say: [`${NAME}: budget ${shown(b)} set.`, ...notes, `/${NAME} shows the status, /${NAME} off removes the budget.`].join(' '),
    prompt: `${c.task}\n\n${protocol(shown(b))}`,
  }
}

/**
 * Submits the task once the command's own hook has returned: the engine refuses a prompt submitted from inside
 * it (the prompt would wait on the command). In a headless run the session may not be ready for a moment after
 * the command, so a refused submit is tried again a few times before the person is told.
 */
function submitLater($: Engine, text: string, attempt: number): void {
  const failed = (why: string) => {
    say($, `${NAME}: the budget is set, but the task could not be submitted (${why}). Send the task yourself: it will run under the budget.`)
    void log($, 'hookfail', { where: 'prompt.submit.call', error: why })
  }
  $.clock.after(attempt === 0 ? 1 : 50 * 2 ** attempt, () => {
    $.prompt.submit({ text, asUser: true }).then(
      r => { if (r && typeof r.drop === 'string') failed(r.drop) },
      (err: unknown) => (attempt < 5 ? submitLater($, text, attempt + 1) : failed(errText(err))),
    )
  })
}

/** Saves which countdowns were left out of this session's requests (at most HIDDEN_KEEP texts, the newest). */
async function saveHidden($: Engine): Promise<void> {
  const texts = Object.keys(hidden)
  for (const text of texts.slice(0, Math.max(0, texts.length - HIDDEN_KEEP))) delete hidden[text]
  await $.store.set(`hid:${sid}`, { at: await $.clock.now(), hidden })
}

/** The made-up response that stands in for a request that is not sent. */
async function* refuse(e: TurnStepInput, text: string): AsyncGenerator<any, TurnStepResult> {
  yield { kind: 'text', index: 0, text }
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
}

export const register: Register = (on, options) => {
  if (isEffortCap(options?.effort)) effortCap = options.effort
  fixedRate = { five_hour: Number(options?.usdPerPoint5h) || undefined, seven_day: Number(options?.usdPerPointWeek) || undefined }

  on('session.start', async ($, e, next) => {
    try {
      // The name is written out here and in the command.run matcher below (the engine reads both as literals); core.ts has NAME.
      await $.command.register({ name: 'onbudget', description: 'Run a task under a usage budget', argumentHint: '<$X | N% 5h | N% week | 5h | week> <task> · off' })
    } catch (err) { await log($, 'hookfail', { where: 'command.register', error: errText(err) }) }
    interactive = e.isInteractive === true
    try {
      await ready($)
      showStatus($)
      await log($, 'session.start', { sid, budget: budget?.raw ?? envBudget ?? null, restored: budget !== null, effortCap, history, version: await $.session.version().catch(() => null) })
    } catch (err) { await log($, 'hookfail', { where: 'session.start', error: errText(err) }) }
    return next(e)
  }).catch(($, e, next) => next(e))

  // /onbudget, typed in a session.
  on('command.run', { command: 'onbudget' }, async ($, e) => {
    try {
      await ready($)
      const out = await command($, e.args)
      if (out.prompt !== undefined) submitLater($, out.prompt, 0)
      return { text: out.say.replace(OWN_NAME, '') } // the engine prints a command's answer under the plugin's name
    } catch (err) {
      await log($, 'hookfail', { where: 'command.run', error: errText(err) })
      return { text: `could not run (${errText(err)}). No budget was changed.` }
    }
  })

  // The same command arriving as prompt text, the ONBUDGET variable applied to the first prompt, and a reading
  // attached to each later prompt while a budget is set.
  on('prompt.submit', async ($, e, next) => {
    const person = fromPerson(e.origin)
    const typed = person ? TYPED.exec(e.text) : null
    let ev = e
    try {
      await ready($)
      if (person && (await $.session.id()) !== sid) {
        // The process is in another session than the one whose state is held, and no session.end said so.
        if (budget) await save($).catch(() => undefined)
        leaveSession()
        await ready($)
      }
      if (typed || (envBudget && !budget && person)) {
        const out = await command($, typed ? (typed[1] ?? '') : `${envBudget} ${e.text}`)
        if (out.prompt === undefined) return { drop: out.say }
        say($, out.say)
        ev = { ...e, text: out.prompt }
      } else if (budget?.state === 'stopped' && person) {
        // Nothing more can be sent under this budget, and a turn that only gets refused still lets Claude Code
        // make requests of its own afterwards (its prompt suggestion), so the prompt is turned away here.
        return { drop: stoppedText(budget) }
      } else if (budget?.state === 'active' && person) {
        const b = budget
        await sync($)
        const note = `${meterLine(b, inFlight)}\nThe budget set earlier for this task still applies to this message.` + (b.remind ? `\n${reminder(b)}` : '')
        b.remind = false
        ev = { ...e, context: [...(e.context ?? []), note] }
      }
    } catch (err) {
      await log($, 'hookfail', { where: 'prompt.submit', error: errText(err) })
      // A budget that was asked for and could not be set: the prompt is not sent without it.
      if (typed) return { drop: `${NAME}: the command could not be run (${errText(err)}), so nothing was sent.` }
      if (envBudget && !budget) return { drop: `${NAME}: the budget in ONBUDGET could not be started (${errText(err)}), so the prompt was not sent.` }
    }
    return next(ev)
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    if (fromPerson(e.origin) && TYPED.test(e.text)) return { drop: `${NAME}: the command could not be run, so nothing was sent.` }
    if (envBudget && !budget) return { drop: `${NAME}: the budget in ONBUDGET could not be started, so the prompt was not sent.` }
    return next(e)
  })

  // The stop, the effort cap and the ledger: every model request of the session, main thread and subagents.
  on('turn.step', async function* ($, e, next) {
    await ready($)
    if (!budget) {
      if (envBudget) return yield* refuse(e, failClosedText('the budget in ONBUDGET did not start'))
      return yield* next(e)
    }
    const b = budget
    const sentAt = await sync($, ledger => ledger)
    const stop = stopCheck(b, inFlight)
    if (stop) {
      b.state = 'stopped'; b.stop = stop; b.refused += 1
      await save($).catch(() => undefined)
      showStatus($)
      await log($, 'stop', { ...stop, spent: b.spent, reserve: reserveOf(b), budget: b.usd, inFlight, agentId: e.agentId ?? null, index: e.index })
      return yield* refuse(e, refusalText(b, stop, e.agentId !== undefined))
    }
    const effort = cappedEffort(e.effort, b.effortCap)
    const ev = effort === e.effort ? e : { ...e, effort }
    const beside = inFlight
    sent.add(stepKey(e))
    inFlight += 1
    let r: TurnStepResult
    // The engine builds the request beneath this hook, asking about its attachments then: a resumed session's history
    // is asked about during its first request, which therefore keeps every countdown as it was.
    try { r = yield* next(ev) } finally { inFlight -= 1; history = false }
    const over = effortBeneath(next.trace, ev.effort, b.effortCap)
    try {
      const model = await calModel($).catch(() => '')
      const now = await $.clock.now()
      const rates = await budgetRates($, b.spec)
      // A converted budget's own window keeps the rate it was converted with when none is learned now.
      if (b.rate && b.spec.kind !== 'usd' && !rates[b.spec.window]) rates[b.spec.window] = b.rate
      const sizing = b.pending === true
      const { ledger, usage, stepCost, grew } = await sync($, (ledger, usage) => {
        const stepCost = stepCostOf(ledger, stepMark, sentAt)
        stepMark = ledger
        if (budget === b) {
          if (stepCost > b.maxStep) b.maxStep = stepCost
          b.steps += 1
          if (r?.stopReason != null) {
            // The readings that came with this answer: the budget's own window, and every window as a wall.
            const before = b.spent - stepCost
            const own = b.pending && b.window ? usage.rateLimits.find(x => x.kind === b.window!.kind) : undefined
            if (own && Number.isFinite(own.percentUsed) && !isStale(own, now)) sizeRest(b, own, rates[b.window!.kind], before)
            observeWindow(b, usage.rateLimits)
            observeWalls(b, usage.rateLimits, before, rates, now)
          }
        }
        return { ledger, usage, stepCost, grew: noteCalibration(usage.rateLimits, ledger, model) }
      })
      if (budget === b) {
        await save($)
        showStatus($)
        if (sizing && !b.pending) await log($, 'sized', { usd: b.usd, rate: b.rate, allowance: b.allowance ?? null, spent: b.spent })
        const status = e.agentId === undefined && r?.stopReason === 'end_turn' ? /STATUS:\s*\**\s*(COMPLETE|INCOMPLETE)/.exec(r.answer ?? '') : null
        if (status && interactive) say($, endText(b, status[1]))
        if (over && !b.effortOver) {
          b.effortOver = over
          await save($)
          say($, `${NAME}: the plugin ${over.by} sent a request at effort ${over.effort}, above the budget's cap of ${b.effortCap}. The budget's stop still holds; the effort cap does not while ${over.by} sets effort.`)
        }
      }
      await log($, 'step', {
        agentId: e.agentId ?? null, index: e.index, model: r?.usage?.model ?? e.model, effort: ev.effort ?? null, callerEffort: e.effort ?? null,
        stopReason: r?.stopReason ?? null, usage: r?.usage ?? null, tools: (r?.toolUses ?? []).map(t => t.name), costUsd: ledger, rateLimits: usage.rateLimits,
        spent: b.spent, reserve: reserveOf(b), stepCost, maxStep: b.maxStep, inFlight, beside, budget: b.usd, window: b.window ?? null,
        effortSent: over?.effort ?? ev.effort ?? null, effortOverBy: over?.by ?? null,
        walls: b.walls ?? null, binding: binding(b, inFlight),
      })
      await saveCalibration($, grew)
      await noteSeen($, usage.rateLimits)
    } catch (err) { await log($, 'hookfail', { where: 'step.after', error: errText(err) }) }
    sent.delete(stepKey(e))
    return r
  }).catch(async function* ($, e, next) {
    // The hook failed. If the request had already gone out, let the engine's own outcome through. If it had not,
    // the stop check never finished: with a budget set (or asked for), the request is not sent.
    if (sent.has(stepKey(e)) || (!budget && !envBudget)) return yield* next(e)
    try { await log($, 'stopfail', { where: 'turn.step', agentId: e.agentId ?? null, index: e.index }) } catch { /* ignore */ }
    return yield* refuse(e, failClosedText('its hook failed or timed out'))
  })

  // The meter: one line after each tool result, for the model to pace itself by.
  on('tool.call', async ($, e, next) => {
    try { await ready($) } catch { /* ignore */ }
    const r = await next(e)
    try {
      const b = budget
      if (!b || b.state !== 'active' || !r || r.deny !== undefined) return r
      await sync($)
      const line = meterLine(b, inFlight)
      const reminded = b.remind && e.agentId === undefined
      const lines = reminded ? [reminder(b), line] : [line]
      if (reminded) b.remind = false
      await log($, 'tool', { tool: e.tool, agentId: e.agentId ?? null, isError: r.isError ?? false, injected: line, inFlight, reminded })
      return { ...r, context: [...(r.context ?? []), ...lines] }
    } catch (err) {
      await log($, 'hookfail', { where: 'tool.call', error: errText(err) })
      return r
    }
  }).catch(($, e, next) => next(e))

  // Claude Code's own token countdown is not this task's budget: while one is open it is left out of new requests. An
  // attachment already sent keeps the answer it was sent with (the engine holds an answer per attachment for the
  // process, and after a resume onbudget gives the same one again), so the prompt cache's prefix never changes.
  on('prompt.attachment', { type: COUNTDOWN_TYPE }, async ($, e, next) => {
    const r = await next(e)
    try {
      await ready($)
      if (r?.text == null) return r
      // The same text recurs (each prompt's countdown starts at the same figure), so a countdown is known by its text
      // and by how many times that text came before it: the order in which the engine asks again after a resume.
      const nth = asked.get(r.text) ?? 0
      asked.set(r.text, nth + 1)
      let leave = hidden[r.text]?.includes(nth) === true
      if (!leave && !history && budget !== null && !countdownSet && isDefaultCountdown(r.text)) {
        leave = true
        ;(hidden[r.text] ??= []).push(nth)
        await saveHidden($)
      }
      await log($, 'countdown', { agentId: e.agentId ?? null, text: r.text.slice(0, 60), nth, left: leave, history, budget: budget !== null })
      return leave ? { text: null } : r
    } catch (err) {
      await log($, 'hookfail', { where: 'prompt.attachment', error: errText(err) })
      return r
    }
  }).catch(($, e, next) => next(e))

  // Readings as the engine reports them: the calibration record, in every session.
  on('session.measure', async ($, e, next) => {
    try {
      await ready($)
      const model = await calModel($)
      const { grew, readings } = await sync($, (ledger, usage) => ({ grew: noteCalibration(usage.rateLimits, ledger, model), readings: usage.rateLimits }))
      await saveCalibration($, grew)
      await noteSeen($, readings)
      if (budget) { await save($); showStatus($) }
      await log($, 'measure', { rateLimits: e.rateLimits, cost: e.cost ?? null, context: e.context, changed: e.changed, spent: budget?.spent ?? null })
    } catch (err) { await log($, 'hookfail', { where: 'session.measure', error: errText(err) }) }
    return next(e)
  }).catch(($, e, next) => next(e))

  // After a compaction the prompt that carried the protocol may be gone: send it again with the next reading.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.agentId === undefined && e.trigger !== 'precompute' && !('skip' in r && r.skip)) {
        // The conversation starts again from the summary: so does the numbering of the countdowns in it.
        asked.clear()
        if (Object.keys(hidden).length) { hidden = {}; await $.store.delete(`hid:${sid}`) }
        if (budget) {
          budget.remind = true
          await save($)
          await log($, 'compact', { trigger: e.trigger })
        }
      }
    } catch { /* ignore */ }
    return r
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    // /clear and /resume leave the session while the process goes on, with no session.start for what follows.
    const b = budget
    const id = sid
    const leaving = e.reason === 'clear' || e.reason === 'resume'
    if (leaving) leaveSession() // first, and without waiting: the hooks that follow must not see the old session
    try {
      const usage = await $.session.usage()
      if (b) {
        try { fold(b, ledgerOf(usage)) } catch { /* no ledger */ }
        // /clear ends the conversation the budget belonged to; any other ending keeps it for a resume.
        if (e.reason === 'clear') { await $.store.delete(`budget:${id}`); await $.store.delete(`hid:${id}`) }
        else { b.savedAt = await $.clock.now(); await $.store.set(`budget:${id}`, b) }
        if (leaving) showStatus($)
      }
      await log($, 'end', { reason: e.reason, ...usage, spent: b?.spent ?? null, state: b?.state ?? null })
    } catch { /* ignore */ }
    return next(e)
  }).catch(($, e, next) => next(e))
}
