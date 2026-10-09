// capmod: the evaluation's external spending cap for the baseline arms (A and B). Not part of onbudget.
// It applies onbudget's stop rule and nothing else: a model request is refused when the session's spend plus a reserve
// (the dearest request seen, for it and for each request still in flight) would reach CAP_USD. The model is told
// nothing: no protocol, no meter line, no effort change, and the refused request is answered with an empty end of turn.
// Every request and every usage reading is logged to CAP_LOG in the format onbudget's own log uses.
// Env: CAP_USD (dollars; required), CAP_LOG (jsonl path), CAP_RULE ("reserve", the default, is the rule above;
// "simple" refuses only once the spend has reached the cap: no reserve, nothing held back for requests in flight).
import type { EngineInterface, Register, SessionUsage, TurnStepInput, TurnStepResult } from 'claude-code'

const BOOTSTRAP_RESERVE_USD = 0.05 // as in onbudget
const LOG_CHUNK = 200
let boot: Promise<void> | null = null
let cap = NaN
let simple = false
let base = 0 // the ledger when the session started (0 in a fresh run)
let stepMark = 0
let maxStep = 0
let inFlight = 0
let stopped = false
let reads: Promise<unknown> = Promise.resolve()
const sent = new Set<string>()
let logPath: string | undefined
let logRows: string[] = []
let logChunk = 0
let logWrites: Promise<unknown> = Promise.resolve()
let t0 = 0

const stepKey = (e: TurnStepInput) => `${e.agentId ?? ''}|${e.turnId}|${e.index}`
const errText = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 300)

function ledgerOf(u: SessionUsage): number {
  const usd = u.cost?.usd
  if (typeof usd !== 'number' || !Number.isFinite(usd)) throw new Error('this session reports no cost')
  return usd
}

async function log($: EngineInterface, kind: string, data: unknown): Promise<void> {
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

const ready = ($: EngineInterface) => (boot ??= (async () => {
  t0 = await $.clock.now()
  logPath = (await $.env.get('CAP_LOG'))?.trim() || undefined
  cap = Number((await $.env.get('CAP_USD'))?.trim())
  simple = (await $.env.get('CAP_RULE'))?.trim() === 'simple'
  base = stepMark = ledgerOf(await $.session.usage())
})().catch(err => { boot = null; throw err }))

/** Reads the ledger. Reads are queued, so what follows a reading runs in the order the readings were taken. */
function read<T>($: EngineInterface, then: (ledger: number, usage: SessionUsage) => T): Promise<T> {
  const run = async () => { const usage = await $.session.usage(); return then(ledgerOf(usage), usage) }
  const p = reads.then(run, run)
  reads = p.catch(() => undefined)
  return p
}

async function* refuse(e: TurnStepInput): AsyncGenerator<any, TurnStepResult> {
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try { await ready($); await log($, 'session.start', { cap, rule: simple ? 'simple' : 'reserve', version: await $.session.version().catch(() => null) }) } catch (err) { await log($, 'hookfail', { where: 'session.start', error: errText(err) }) }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    await ready($)
    if (!(cap > 0)) throw new Error('CAP_USD is not set')
    const sentAt = await read($, ledger => ledger)
    const spent = sentAt - base
    const reserve = maxStep > 0 ? maxStep : BOOTSTRAP_RESERVE_USD
    if (stopped || (simple ? spent >= cap : spent + reserve * (inFlight + 1) >= cap)) {
      stopped = true
      await log($, 'stop', { event: 'cap-stop', spent, reserve, budget: cap, inFlight, agentId: e.agentId ?? null, index: e.index })
      return yield* refuse(e)
    }
    sent.add(stepKey(e))
    inFlight += 1
    let r: TurnStepResult
    try { r = yield* next(e) } finally { inFlight -= 1 }
    try {
      const { ledger, usage, stepCost } = await read($, (ledger, usage) => {
        // As in onbudget: the ledger's growth since the last request completed, and no more than since this one was sent.
        const stepCost = Math.max(0, Math.min(ledger - stepMark, ledger - sentAt))
        stepMark = ledger
        if (stepCost > maxStep) maxStep = stepCost
        return { ledger, usage, stepCost }
      })
      await log($, 'step', {
        agentId: e.agentId ?? null, index: e.index, model: r?.usage?.model ?? e.model, effort: e.effort ?? null, callerEffort: e.effort ?? null,
        stopReason: r?.stopReason ?? null, usage: r?.usage ?? null, tools: (r?.toolUses ?? []).map(t => t.name), costUsd: ledger, rateLimits: usage.rateLimits,
        spent: ledger - base, reserve: maxStep > 0 ? maxStep : BOOTSTRAP_RESERVE_USD, stepCost, maxStep, inFlight, budget: cap,
      })
    } catch (err) { await log($, 'hookfail', { where: 'step.after', error: errText(err) }) }
    return r
  }).catch(async function* ($, e, next) {
    // Fail closed, as onbudget does: a request whose check did not finish is not sent.
    if (sent.has(stepKey(e))) return yield* next(e)
    try { await log($, 'stopfail', { where: 'turn.step', agentId: e.agentId ?? null, index: e.index }) } catch { /* ignore */ }
    return yield* refuse(e)
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    await log($, 'tool', { tool: e.tool, agentId: e.agentId ?? null, isError: r?.isError ?? false, deny: r?.deny })
    return r
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await log($, 'measure', { rateLimits: e.rateLimits, cost: e.cost ?? null, context: e.context, changed: e.changed })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    try { await log($, 'end', { reason: e.reason, ...(await $.session.usage()) }) } catch { /* ignore */ }
    return next(e)
  }).catch(($, e, next) => next(e))
}
