// onbudget: the Claude Code side. Hooks only; every decision is made in core.ts.
//
// Everything this module does:
//   reads    the session's cost ledger and rate-limit readings, its id and model, the environment variables
//            ONBUDGET, ONBUDGET_EFFORT and ONBUDGET_LOG, and its own store;
//   writes   its own store (each session's budget; one calibration record per session and window), its status
//            line, and, only when ONBUDGET_LOG names a file, an event log there;
//   changes  only while a budget is set: the effort of each model request (lowered to the cap, never raised),
//            one line of context after each tool result, and the refusal of requests the budget cannot cover.
// It runs no commands and makes no model or network calls of its own. With no budget set, every hook passes
// its event through unchanged; the only work left is the calibration record kept at session.measure.
import type { EngineInterface, Register, SessionUsage, TurnStepInput, TurnStepResult } from 'claude-code'
import {
  type Budget, type CalMark, type CalRecord, type Effort, type Rate, type Reading, type WindowKind,
  CAL_MAX_AGE_MS, BOOTSTRAP_RESERVE_USD, MIN_OBSERVED_POINTS, NAME,
  cappedEffort, extendCalibration, failClosedText, fold, isEffortCap, meterLine, money, observeWindow, parseCommand, poolRate,
  protocol, refusalText, reminder, reserveOf, round4, shown, statusText, stopCheck, windowName,
} from './core.ts'

type Engine = EngineInterface
const WINDOWS: readonly WindowKind[] = ['five_hour', 'seven_day']
const TYPED = new RegExp(`^\\s*/${NAME}(?:\\s+([\\s\\S]*))?$`) // the command arriving as prompt text (slash commands off, SDK hosts)
const OWN_NAME = new RegExp(`^${NAME}: `)
const LOG_CHUNK = 200

// Session state. The store is the record: a reload or a resumed session reads the budget back from it.
let boot: Promise<void> | null = null
let sid = ''
let budget: Budget | null = null
let envBudget: string | undefined // ONBUDGET: the budget for this session's first prompt, until it is used
let effortCap: Effort | 'keep' = 'medium'
let fixedRate: Partial<Record<WindowKind, number>> = {}
let stepMark = 0 // the ledger when the last request completed: the next one's cost is counted from here
let inFlight = 0 // requests sent and not yet answered, over all loops
let reads: Promise<unknown> = Promise.resolve()
const sent = new Set<string>() // requests handed to the engine, for the handler that runs when the step hook fails
const cal: Partial<Record<WindowKind, { rec: CalRecord; mark: CalMark | null }>> = {}
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

/** Reads this session's saved state, once per load of the module. */
const ready = ($: Engine) => (boot ??= load($).catch(err => { boot = null; throw err }))

async function load($: Engine): Promise<void> {
  t0 = await $.clock.now()
  sid = await $.session.id()
  // The engine wants each variable read by its literal name, so that what a module reads can be listed.
  const env = (read: Promise<string | undefined>) => read.then(v => v?.trim() || undefined, () => undefined)
  logPath = await env($.env.get('ONBUDGET_LOG'))
  envBudget = await env($.env.get('ONBUDGET'))
  const effort = (await env($.env.get('ONBUDGET_EFFORT')))?.toLowerCase()
  if (isEffortCap(effort)) effortCap = effort
  for (const kind of WINDOWS) {
    const rec = await $.store.get(`cal:${kind}:${sid}`)
    if (isCalRecord(rec)) cal[kind] = { rec: rec as CalRecord, mark: null }
  }
  const saved = await $.store.get(`budget:${sid}`)
  if (isBudget(saved)) {
    budget = saved
    envBudget = undefined
    stepMark = ledgerOf(await $.session.usage())
    if (stepMark < budget.ledger) budget.ledger = stepMark // the ledger started over with the process
    if (budget.window) { budget.window.last = null; budget.window.blind = 0 } // what the window did while the session was away is not the task's
  }
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

const save = async ($: Engine) => { if (budget) await $.store.set(`budget:${sid}`, budget) }

function showStatus($: Engine): void {
  try {
    // The engine shows the line under the plugin's name, so the text does not repeat it.
    if (!budget) $.ui.status(undefined)
    else if (budget.state === 'stopped') $.ui.status(`budget spent (${money(budget.spent)} of ${shown(budget)}) · /${NAME} off to continue`)
    else $.ui.status(meterLine(budget).replace('[budget] ', ''))
  } catch { /* a host with no status line */ }
}

/** Calibration records of the account's other sessions, read once; expired records and budgets are deleted. */
async function otherRecords($: Engine): Promise<CalRecord[]> {
  if (others) return others
  const now = await $.clock.now()
  const found: CalRecord[] = []
  for (const key of await $.store.keys()) {
    if (key.endsWith(`:${sid}`)) continue
    const value = await $.store.get(key)
    const at = key.startsWith('cal:') && isCalRecord(value) ? value.at : key.startsWith('budget:') && isBudget(value) ? value.startedAt : undefined
    if (at === undefined) continue
    if (now - at >= CAL_MAX_AGE_MS) await $.store.delete(key)
    else if (isCalRecord(value)) found.push(value)
  }
  return (others = found)
}

/** Dollars per point of a window on this account: the user's own figure when configured, else the learned one. */
async function rateFor($: Engine, kind: WindowKind): Promise<Rate | null> {
  const fixed = fixedRate[kind]
  if (fixed !== undefined && fixed > 0) return { usdPerPoint: fixed, points: 0, intervals: 0, source: 'config' }
  const own = cal[kind]?.rec
  return poolRate([...(await otherRecords($)), ...(own ? [own] : [])], kind, await $.session.model(), await $.clock.now())
}

/** Extends this session's calibration records with a reading and the ledger beside it; the windows that grew. */
function noteCalibration(readings: readonly Reading[], ledger: number): WindowKind[] {
  const grew: WindowKind[] = []
  for (const kind of WINDOWS) {
    const r = readings.find(x => x.kind === kind)
    if (!r || !Number.isFinite(r.percentUsed)) continue
    const c = (cal[kind] ??= { rec: { kind, model: '', usd: 0, points: 0, at: 0 }, mark: null })
    const before = c.rec.usd + c.rec.points
    c.mark = extendCalibration(c.rec, c.mark, r.percentUsed, ledger)
    if (c.rec.usd + c.rec.points !== before) grew.push(kind)
  }
  return grew
}

async function saveCalibration($: Engine, kinds: readonly WindowKind[]): Promise<void> {
  for (const kind of kinds) {
    const rec = cal[kind]!.rec
    rec.model = await $.session.model()
    rec.at = await $.clock.now()
    await $.store.set(`cal:${kind}:${sid}`, rec)
  }
}

/** Runs `/onbudget <args>`: what to tell the person, and, for a new budget, the prompt to send. */
async function command($: Engine, args: string): Promise<{ say: string; prompt?: string }> {
  const c = parseCommand(args)
  if (c.kind === 'error') return { say: c.message }
  if (c.kind === 'status') {
    if (budget) await sync($)
    return { say: statusText(budget, { five_hour: await rateFor($, 'five_hour'), seven_day: await rateFor($, 'seven_day') }) }
  }
  const before = budget ? await sync($, () => `${money(budget!.spent)} of ${shown(budget!)} was spent` + (budget!.state === 'stopped' ? ' and the budget had stopped the session' : '')) : undefined
  if (c.kind === 'off') {
    if (!budget) return { say: `${NAME}: no budget is set.` }
    await log($, 'off', { spent: budget.spent, budget: budget.usd, state: budget.state })
    budget = null
    await $.store.delete(`budget:${sid}`)
    showStatus($)
    return { say: `${NAME}: budget removed (${before}). Requests are no longer metered or refused.` }
  }

  const usage = await $.session.usage()
  const ledger = ledgerOf(usage)
  let usd: number | null = null
  let rate: Rate | null = null
  let window: Budget['window']
  const notes: string[] = []
  if (c.spec.kind === 'usd') usd = c.spec.usd
  else {
    const kind = c.spec.window
    const reading = usage.rateLimits.find(r => r.kind === kind)
    rate = await rateFor($, kind)
    window = { kind, last: null, moved: 0, blind: 0 }
    if (rate) {
      usd = round4(c.spec.points * rate.usdPerPoint)
      notes.push(`Converted at 1 point ≈ ${money(rate.usdPerPoint)} (${rate.source === 'config' ? 'your setting' : `learned on this account from ${Math.round(rate.points)} points of movement; it errs low, so the budget errs small`}).`)
    } else if (c.spec.points < MIN_OBSERVED_POINTS) {
      return { say: `${NAME}: cannot enforce ${c.raw} yet. The ${windowName(kind)} window is reported in whole points for the whole account, and ${NAME} has not yet seen enough usage on this account to convert a point into dollars. Until it has, the smallest percentage budget is ${MIN_OBSERVED_POINTS}%; a dollar budget works now.` }
    } else {
      notes.push(`No conversion to dollars is known for this account yet, so the budget is enforced on the window's own reading: whole points, account-wide. It stops when the window has moved ${c.spec.points} points, whoever used them, and can be off by one point.`)
    }
    if (reading && c.spec.points > 100 - reading.percentUsed) notes.push(`Note: the window is already at ${reading.percentUsed}%, so less than the budget is left before the account's own limit.`)
  }
  if (usd !== null && usd <= BOOTSTRAP_RESERVE_USD) return { say: `${NAME}: ${shown({ spec: c.spec, usd })} is too small to send a single request under (a ${money(BOOTSTRAP_RESERVE_USD)} reserve is held back). Nothing was sent.` }

  budget = {
    v: 1, raw: c.raw, spec: c.spec, task: c.task.split('\n')[0].slice(0, 120), usd, rate, spent: 0, ledger, maxStep: 0, steps: 0, refused: 0,
    state: 'active', window, effortCap, remind: false, startedAt: await $.clock.now(),
  }
  stepMark = ledger
  envBudget = undefined
  await save($)
  showStatus($)
  await log($, 'budget', { raw: c.raw, spec: c.spec, usd, rate, effortCap, task: budget.task, base: ledger, replaced: before ?? null })
  if (before) notes.unshift(`The previous budget was closed (${before}).`)
  if ((usage.context?.tokens ?? 0) > 100_000) notes.push('Note: this session already holds a large conversation; if it has been idle, the first request re-reads all of it and can be costly.')
  if (effortCap !== 'keep') notes.push(`Effort is capped at ${effortCap} while the budget is set.`)
  return {
    say: [`${NAME}: budget ${shown(budget)} set.`, ...notes, `/${NAME} shows the status, /${NAME} off removes the budget.`].join(' '),
    prompt: `${c.task}\n\n${protocol(shown(budget))}`,
  }
}

/**
 * Submits the task once the command's own hook has returned: the engine refuses a prompt submitted from inside
 * it (the prompt would wait on the command). In a headless run the session may not be ready for a moment after
 * the command, so a refused submit is tried again a few times before it is given up and logged.
 */
function submitLater($: Engine, text: string, attempt: number): void {
  $.clock.after(attempt === 0 ? 1 : 50 * 2 ** attempt, () => {
    void $.prompt.submit({ text, asUser: true }).catch((err: unknown) => {
      if (attempt < 5) submitLater($, text, attempt + 1)
      else void log($, 'hookfail', { where: 'prompt.submit.call', error: errText(err) })
    })
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
      await ready($)
      // The name is written out here and in the command.run matcher below (the engine reads both as literals); core.ts has NAME.
      await $.command.register({ name: 'onbudget', description: 'Run a task under a usage budget', argumentHint: '<$X | N% 5h | N% week> <task> · off' })
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
    let ev = e
    try {
      await ready($)
      const typed = TYPED.exec(e.text)
      const fromPerson = e.origin.kind === 'composer' || e.origin.kind === 'sdk' || e.origin.kind === 'bridge'
      if (typed || (envBudget && !budget && fromPerson)) {
        const out = await command($, typed ? (typed[1] ?? '') : `${envBudget} ${e.text}`)
        if (out.prompt === undefined) return { drop: out.say }
        try { $.ui.log(out.say) } catch { /* ignore */ }
        ev = { ...e, text: out.prompt }
      } else if (budget?.state === 'active' && fromPerson) {
        const b = budget
        await sync($)
        const note = `${meterLine(b)}\nThe budget set earlier for this task still applies to this message.` + (b.remind ? `\n${reminder(b)}` : '')
        b.remind = false
        ev = { ...e, context: [...(e.context ?? []), note] }
      }
    } catch (err) {
      await log($, 'hookfail', { where: 'prompt.submit', error: errText(err) })
      if (envBudget && !budget) return { drop: `${NAME}: the budget in ONBUDGET could not be started (${errText(err)}), so the prompt was not sent.` }
    }
    return next(ev)
  }).catch(($, e, next) => (envBudget && !budget && !next.called ? { drop: `${NAME}: the budget in ONBUDGET could not be started, so the prompt was not sent.` } : next(e)))

  // The stop, the effort cap and the ledger: every model request of the session, main thread and subagents.
  on('turn.step', async function* ($, e, next) {
    await ready($)
    if (!budget) {
      if (envBudget) return yield* refuse(e, failClosedText('the budget in ONBUDGET did not start'))
      return yield* next(e)
    }
    const b = budget
    await sync($)
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
      const { ledger, usage, stepCost, grew } = await sync($, (ledger, usage) => {
        // Requests complete one at a time, so the ledger's growth since the last completion is this request's
        // own cost, whatever else is still in flight.
        const stepCost = Math.max(0, ledger - stepMark)
        stepMark = ledger
        if (budget === b) observeWindow(b, usage.rateLimits) // the reading that came with this answer
        return { ledger, usage, stepCost, grew: noteCalibration(usage.rateLimits, ledger) }
      })
      await saveCalibration($, grew)
      if (budget === b) {
        if (stepCost > b.maxStep) b.maxStep = stepCost
        b.steps += 1
        await save($)
        showStatus($)
      }
      await log($, 'step', {
        agentId: e.agentId ?? null, index: e.index, model: r?.usage?.model ?? e.model, effort: ev.effort ?? null, callerEffort: e.effort ?? null,
        stopReason: r?.stopReason ?? null, usage: r?.usage ?? null, tools: (r?.toolUses ?? []).map(t => t.name), costUsd: ledger, rateLimits: usage.rateLimits,
        spent: b.spent, reserve: reserveOf(b), stepCost, maxStep: b.maxStep, inFlight, budget: b.usd,
      })
    } catch (err) { await log($, 'hookfail', { where: 'step.after', error: errText(err) }) }
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

  // Readings as the engine reports them: calibration in every session, the window's movement under a budget.
  on('session.measure', async ($, e, next) => {
    try {
      await ready($)
      await saveCalibration($, await sync($, (ledger, usage) => noteCalibration(usage.rateLimits, ledger)))
      const b = budget
      if (b && b.usd === null && b.spec.kind === 'pct') {
        const rate = await rateFor($, b.spec.window)
        if (rate) {
          b.rate = rate; b.usd = round4(b.spec.points * rate.usdPerPoint)
          await log($, 'calibrated', { rate, usd: b.usd, spent: b.spent })
        }
      }
      if (b) { await save($); showStatus($) }
      await log($, 'measure', { rateLimits: e.rateLimits, cost: e.cost ?? null, context: e.context, changed: e.changed, spent: b?.spent ?? null, window: b?.window ?? null })
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
    try {
      const b = budget
      if (b) {
        await sync($).catch(() => undefined)
        if (e.reason === 'clear') {
          // /clear ends the conversation the budget belonged to.
          budget = null
          await $.store.delete(`budget:${sid}`)
          showStatus($)
        } else await save($)
      }
      await log($, 'end', { reason: e.reason, ...(await $.session.usage()), spent: b?.spent ?? null, state: b?.state ?? null })
      if (e.reason === 'clear') {
        // The process goes on under a new session id, and no session.start follows: read the state again then.
        boot = null
        for (const kind of WINDOWS) delete cal[kind]
      }
    } catch { /* ignore */ }
    return next(e)
  }).catch(($, e, next) => next(e))
}
