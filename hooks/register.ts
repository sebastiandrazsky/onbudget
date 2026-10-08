// onbudget: the Claude Code side. Hooks only; every decision is made in core.ts.
//
// Everything this module does:
//   reads    the session's cost ledger and rate-limit readings, its id and model, the environment variables
//            ONBUDGET, ONBUDGET_EFFORT and ONBUDGET_LOG, and its own store;
//   writes   its own store (each session's budget; calibration records of dollars spent and points moved),
//            its status line, and, only when ONBUDGET_LOG names a file, an event log there;
//   changes  only while a budget is set: the effort of each model request (lowered to the cap, never raised),
//            one line of context after each tool result and with each later prompt, and the refusal of requests
//            the budget cannot cover.
// It runs no commands and makes no model or network calls of its own. With no budget set, every hook passes
// its event through unchanged; the only work left is the calibration record kept at session.measure.
import type { EngineInterface, PromptOrigin, Register, SessionUsage, TurnStepInput, TurnStepResult } from 'claude-code'
import {
  type Budget, type CalMark, type CalRecord, type Effort, type Rate, type Reading, type WindowKind,
  BOOTSTRAP_RESERVE_USD, DAY_MS, MAX_AGE_DAYS, MIN_OBSERVED_POINTS, NAME,
  cappedEffort, extendCalibration, failClosedText, fold, isEffortCap, meterLine, money, observeWindow, parseCommand, poolRate,
  protocol, refusalText, reminder, reserveOf, round4, shown, statusText, stepCostOf, stopCheck, stopLabel, windowName,
} from './core.ts'

type Engine = EngineInterface
const WINDOWS: readonly WindowKind[] = ['five_hour', 'seven_day']
const TYPED = new RegExp(`^\\s*/${NAME}(?:\\s+([\\s\\S]*))?$`) // the command arriving as prompt text (slash commands off, SDK hosts)
const OWN_NAME = new RegExp(`^${NAME}: `)
const LOG_CHUNK = 200

// Session state. The store is the record: a reload, a resumed session or a switch to another session reads it back.
// Store keys: budget:<session>, env:<session> (ONBUDGET was used or cancelled there), and
// cal:<window>:<day>:<session>:<model> (one calibration record; the day lets old ones be deleted unread).
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
let logPath: string | undefined
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

/** The event log, for evaluation and debugging; off unless ONBUDGET_LOG names a file. Never changes a run. */
async function log($: Engine, kind: string, data: unknown): Promise<void> {
  if (!logPath) return
  try {
    if (logRows.length >= LOG_CHUNK) { logRows = []; logChunk += 1 }
    logRows.push(JSON.stringify({ t: (await $.clock.now()) - t0, kind, data }))
    const path = logChunk === 0 ? logPath : `${logPath}.${logChunk}`
    const body = logRows.join('\n') + '\n'
    logWrites = logWrites.then(() => $.fs.write(path, body)).catch(() => undefined)
    await logWrites
  } catch { /* ignore */ }
}

const say = ($: Engine, text: string) => { try { $.ui.log(text) } catch { /* a host with no transcript */ } }

/** Reads this session's saved state: once per load of the module, and again after the process changes session. */
const ready = ($: Engine) => (boot ??= load($).catch(err => { boot = null; throw err }))

async function load($: Engine): Promise<void> {
  const now = await $.clock.now()
  if (t0 === 0) t0 = now
  calDay = Math.floor(now / DAY_MS)
  sid = await $.session.id()
  // The engine wants each variable read by its literal name, so that what a module reads can be listed.
  const env = (read: Promise<string | undefined>) => read.then(v => v?.trim() || undefined, () => undefined)
  logPath = await env($.env.get('ONBUDGET_LOG'))
  const effort = (await env($.env.get('ONBUDGET_EFFORT')))?.toLowerCase()
  if (isEffortCap(effort)) effortCap = effort
  envBudget = (await $.store.get(`env:${sid}`)) === undefined ? await env($.env.get('ONBUDGET')) : undefined
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
      } else if ((key.startsWith('budget:') || key.startsWith('env:')) && !key.endsWith(`:${sid}`)) {
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
    if (!budget) $.ui.status(undefined)
    else if (budget.state === 'stopped') $.ui.status(`stopped at ${money(budget.spent)} of ${shown(budget)}: ${stopLabel(budget.stop)} · /${NAME} off to continue`)
    else $.ui.status(meterLine(budget).replace('[budget] ', ''))
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
    return { say: statusText(budget, { five_hour: await rateFor($, 'five_hour'), seven_day: await rateFor($, 'seven_day') }) + pending }
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
  const notes: string[] = []
  if (c.spec.kind === 'usd') usd = c.spec.usd
  else {
    const kind = c.spec.window
    rate = await rateFor($, kind)
    if (rate) {
      usd = round4(c.spec.points * rate.usdPerPoint)
      notes.push(`Converted at 1 point ≈ ${money(rate.usdPerPoint)} (${rate.source === 'config' ? 'your setting' : `learned from ${Math.round(rate.points)} points of movement seen on this machine; it errs low, so the budget errs small`}).`)
    } else if (c.spec.points < MIN_OBSERVED_POINTS) {
      return { say: `${NAME}: cannot enforce ${c.raw} yet. The ${windowName(kind)} window is reported in whole points for the whole account, and ${NAME} has not yet seen enough usage to convert a point into dollars. Until it has, the smallest percentage budget is ${MIN_OBSERVED_POINTS}%; a dollar budget works now.` }
    } else {
      notes.push(`No conversion to dollars is known yet, so the budget is enforced on the window's own reading: whole points, account-wide. It stops when the window has moved ${c.spec.points} points, whoever used them, and can be off by a point or by one request.`)
    }
  }
  if (usd !== null && usd <= BOOTSTRAP_RESERVE_USD) return { say: `${NAME}: ${shown({ spec: c.spec, usd })} is too small to send a single request under (a ${money(BOOTSTRAP_RESERVE_USD)} reserve is held back). Nothing was sent.` }

  const startedAt = await $.clock.now()
  const task = c.task.split('\n')[0].slice(0, 120)
  const spec = c.spec
  const prev = budget
  const prevMark = stepMark
  // The old budget's last reading and the new budget's first are one queued read, so nothing spent in between
  // is counted twice or lost.
  const { closed, usage } = await sync($, (ledger, usage) => {
    const closed = prev ? spendOf(prev) : undefined
    budget = {
      v: 1, raw: c.raw, spec, task, usd, rate, spent: 0, ledger, maxStep: 0, steps: 0, refused: 0, state: 'active',
      window: spec.kind === 'pct' ? { kind: spec.window, last: null, moved: 0, blind: 0 } : undefined, effortCap, remind: false, startedAt,
    }
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
  await log($, 'budget', { raw: c.raw, spec, usd, rate, effortCap, task, base: b.ledger, replaced: closed ?? null })
  if (closed) notes.unshift(`The previous budget was closed (${closed}).`)
  const reading = spec.kind === 'pct' ? usage.rateLimits.find(r => r.kind === spec.window) : undefined
  if (reading && spec.kind === 'pct' && spec.points > 100 - reading.percentUsed) notes.push(`Note: the window is already at ${reading.percentUsed}%, so less than the budget is left before the account's own limit.`)
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
      await $.command.register({ name: 'onbudget', description: 'Run a task under a usage budget', argumentHint: '<$X | N% 5h | N% week> <task> · off' })
    } catch (err) { await log($, 'hookfail', { where: 'command.register', error: errText(err) }) }
    try {
      await ready($)
      showStatus($)
      await log($, 'session.start', { sid, budget: budget?.raw ?? envBudget ?? null, restored: budget !== null, effortCap, version: await $.session.version().catch(() => null) })
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
      } else if (budget?.state === 'active' && person) {
        const b = budget
        await sync($)
        const note = `${meterLine(b)}\nThe budget set earlier for this task still applies to this message.` + (b.remind ? `\n${reminder(b)}` : '')
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
    sent.add(stepKey(e))
    inFlight += 1
    let r: TurnStepResult
    try { r = yield* next(ev) } finally { inFlight -= 1 }
    try {
      const model = await calModel($).catch(() => '')
      const { ledger, usage, stepCost, grew } = await sync($, (ledger, usage) => {
        const stepCost = stepCostOf(ledger, stepMark, sentAt)
        stepMark = ledger
        if (budget === b) {
          if (stepCost > b.maxStep) b.maxStep = stepCost
          b.steps += 1
          if (r?.stopReason != null) observeWindow(b, usage.rateLimits) // the reading that came with this answer
        }
        return { ledger, usage, stepCost, grew: noteCalibration(usage.rateLimits, ledger, model) }
      })
      if (budget === b) {
        await save($)
        showStatus($)
      }
      await log($, 'step', {
        agentId: e.agentId ?? null, index: e.index, model: r?.usage?.model ?? e.model, effort: ev.effort ?? null, callerEffort: e.effort ?? null,
        stopReason: r?.stopReason ?? null, usage: r?.usage ?? null, tools: (r?.toolUses ?? []).map(t => t.name), costUsd: ledger, rateLimits: usage.rateLimits,
        spent: b.spent, reserve: reserveOf(b), stepCost, maxStep: b.maxStep, inFlight, budget: b.usd, window: b.window ?? null,
      })
      await saveCalibration($, grew)
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
      const line = meterLine(b)
      const reminded = b.remind && e.agentId === undefined
      const lines = reminded ? [reminder(b), line] : [line]
      if (reminded) b.remind = false
      await log($, 'tool', { tool: e.tool, agentId: e.agentId ?? null, isError: r.isError ?? false, injected: line, reminded })
      return { ...r, context: [...(r.context ?? []), ...lines] }
    } catch (err) {
      await log($, 'hookfail', { where: 'tool.call', error: errText(err) })
      return r
    }
  }).catch(($, e, next) => next(e))

  // Readings as the engine reports them: the calibration record, in every session.
  on('session.measure', async ($, e, next) => {
    try {
      await ready($)
      const model = await calModel($)
      await saveCalibration($, await sync($, (ledger, usage) => noteCalibration(usage.rateLimits, ledger, model)))
      if (budget) { await save($); showStatus($) }
      await log($, 'measure', { rateLimits: e.rateLimits, cost: e.cost ?? null, context: e.context, changed: e.changed, spent: budget?.spent ?? null })
    } catch (err) { await log($, 'hookfail', { where: 'session.measure', error: errText(err) }) }
    return next(e)
  }).catch(($, e, next) => next(e))

  // After a compaction the prompt that carried the protocol may be gone: send it again with the next reading.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    try {
      if (budget && e.agentId === undefined && e.trigger !== 'precompute' && !('skip' in r && r.skip)) {
        budget.remind = true
        await save($)
        await log($, 'compact', { trigger: e.trigger })
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
        if (e.reason === 'clear') await $.store.delete(`budget:${id}`)
        else { b.savedAt = await $.clock.now(); await $.store.set(`budget:${id}`, b) }
        if (leaving) showStatus($)
      }
      await log($, 'end', { reason: e.reason, ...usage, spent: b?.spent ?? null, state: b?.state ?? null })
    } catch { /* ignore */ }
    return next(e)
  }).catch(($, e, next) => next(e))
}
