// The world beneath the plugin for the tests: a cost ledger, rate-limit readings, a model that answers from
// a script, a store, a clock. Nothing here is part of the plugin.
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

export type Reply = { cost?: number; text?: string; hold?: Promise<void>; tools?: string[]; none?: boolean } // none: no response arrived

export function world(on: On, init: { env?: Record<string, string>; store?: Record<string, unknown>; sid?: string } = {}) {
  const w = {
    cost: 0, // the session ledger, in dollars
    hasLedger: true,
    readings: [] as { kind: string; percentUsed: number; resetsAt?: string }[],
    contextTokens: 0,
    startedAt: Date.now(), // when the session began (real time, as the plugin compares it with its own load); earlier = resumed
    sid: init.sid ?? 'session-1',
    model: 'claude-opus-5-5',
    requests: [] as any[], // model requests that were really sent, as the engine received them
    reply: (_e: any): Reply => ({ cost: 0.1 }),
    tool: (_e: any): any => ({ result: 'tool output', text: 'tool output' }), // what a tool call answers
    enter: (e: any): any => ({ text: e.text, context: e.context }), // what the engine answers a prompt with
    storeFails: (_key: string): boolean => false, // which writes of the plugin's store are refused
    status: [] as (string | undefined)[],
    logs: [] as string[],
    prompts: [] as any[], // prompts that entered the session
    commands: [] as any[],
    files: new Map<string, string>(),
    store: new Map<string, unknown>(Object.entries(init.store ?? {})), // the plugin's own store
    clock: mock.clock(on, { now: 1_700_000_000_000 }),
    usage() {
      return { startedAt: w.startedAt, context: { window: 1_000_000, tokens: w.contextTokens }, rateLimits: w.readings.map(r => ({ ...r })), ...(w.hasLedger ? { cost: { usd: w.cost } } : {}) }
    },
  }
  mock.env(on, init.env ?? {})
  const value = (v?: unknown) => ({ value: v }) as any
  on('store.get', (_$, e) => value(w.store.has(e.key) ? JSON.parse(JSON.stringify(w.store.get(e.key))) : undefined))
  on('store.set', (_$, e) => {
    if (w.storeFails(e.key)) throw new Error('the store is full')
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return value()
  })
  on('store.delete', (_$, e) => { w.store.delete(e.key); return value() })
  on('store.keys', () => value([...w.store.keys()]))
  on('session.usage', () => value(w.usage()))
  on('session.id', () => value(w.sid))
  on('session.model', () => value(w.model))
  on('session.version', () => value({ version: 'test' }))
  on('command.register', (_$, e) => { w.commands.push(e); return value() })
  on('ui.status', (_$, e: any) => { w.status.push(e.text); return value() })
  on('ui.log', (_$, e: any) => { w.logs.push(e.text); return value() })
  on('fs.write', (_$, e: any) => { w.files.set(e.path, e.text); return value() })
  on('prompt.submit', (_$, e) => {
    const answer = w.enter(e)
    if (answer.drop === undefined) w.prompts.push(e)
    return answer
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.compact', (_$, e) => ({ messages: e.messages }) as any)
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  on('tool.call', (_$, e) => w.tool(e))
  on('turn.step', async function* (_$, e) {
    w.requests.push(e)
    const reply = w.reply(e)
    if (reply.hold) await reply.hold
    if (reply.none) return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null } as any
    w.cost += reply.cost ?? 0
    const toolUses = (reply.tools ?? []).map(name => ({ name, input: {} }))
    yield { kind: 'text', index: 0, text: reply.text ?? 'ok' } as any
    yield { kind: 'stop', stopReason: toolUses.length ? 'tool_use' : 'end_turn', usage: null } as any
    return { turnId: e.turnId, index: e.index, answer: reply.text ?? 'ok', toolUses, stopReason: toolUses.length ? 'tool_use' : 'end_turn', usage: null } as any
  })
  return w
}

export type World = ReturnType<typeof world>

/** Runs a stream to its end: the chunks it yielded and the result it returned. */
export async function drain(stream: AsyncGenerator<any, any>): Promise<{ chunks: any[]; result: any }> {
  const chunks: any[] = []
  for (;;) {
    const n = await stream.next()
    if (n.done) return { chunks, result: n.value }
    chunks.push(n.value)
  }
}

let turn = 0
/** One model request as the engine raises it. */
export const step = ($: any, over: Record<string, unknown> = {}) =>
  drain($.turn.step({ turnId: `turn-${++turn}`, index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 1, ...over }))

export const start = ($: any) => $.session.start({ cwd: '/work', surface: null, isInteractive: false })
export const run = ($: any, args: string) => $.command.run({ command: 'onbudget', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
export const prompt = ($: any, text: string, kind = 'composer') => $.prompt.submit({ text, wait: false, origin: { kind } })
export const tool = ($: any, over: Record<string, unknown> = {}) => $.tool.call({ tool: 'Bash', input: { command: 'true' }, tool_use_id: 'toolu_1', ...over })
/** One attachment as the engine asks about it while building a request: what the model will read for it (null: left out). */
export const attach = async ($: any, text: string, over: Record<string, unknown> = {}) =>
  (await $.prompt.attachment({ type: 'total_tokens_reminder', text, origin: { kind: 'engine' }, ...over })).text
export const compact = ($: any, trigger: string) => $.session.compact({ trigger, messages: [{ role: 'user', text: 'earlier', toolUses: [] }] })
export const measure = ($: any, w: World, changed: string[] = ['cost']) => $.session.measure({ context: w.usage().context, rateLimits: w.usage().rateLimits, cost: { usd: w.cost }, changed })

export function deferred() {
  let open!: () => void
  const promise = new Promise<void>(r => { open = r })
  return { promise, open }
}

/** The plugin's event log (ONBUDGET_LOG=/log in the test's env), as rows of one kind. */
export function rows(w: World, kind: string): any[] {
  const out: any[] = []
  for (const [path, text] of w.files) {
    if (!path.startsWith('/log')) continue
    for (const line of text.split('\n')) if (line) { const r = JSON.parse(line); if (r.kind === kind) out.push(r.data) }
  }
  return out
}

export const LOG = { ONBUDGET_LOG: '/log' }
