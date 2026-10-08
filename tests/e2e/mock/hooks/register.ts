// The world for onbudget's end-to-end tests. Loaded beside the plugin in a real Claude Code process, it
//  - answers every model request from a script and never calls next, so no request leaves the machine;
//  - answers $.session.usage() with a scripted cost ledger and scripted usage windows.
// Env: MOCK_SCRIPT (a json file: a list of replies, one per model request; when it runs out the reply is the text
// "mock done"), MOCK_LOG (json path: what the mock saw), MOCK_LEDGER (json path: the ledger and readings, kept across
// processes so a resumed session can be given a ledger that survives or one that starts over).
// A reply: { bash?: command to call the Bash tool with, text?: answer text, cost?: dollars it adds to the ledger,
//            five_hour?: number, seven_day?: number (the readings that arrive with this answer),
//            sleep_ms?: how long the answer takes (for interrupting a request in flight) }
// A compaction is answered here too (a one-line summary), since the engine's own would need the model.
import type { Register } from 'claude-code'

type Reply = { bash?: string; text?: string; cost?: number; five_hour?: number; seven_day?: number; sleep_ms?: number }
let script: Reply[] | undefined
let i = 0
let world: { cost: number; five_hour?: number; seven_day?: number } | undefined
const seen: unknown[] = []

async function load($: any): Promise<void> {
  if (script) return
  script = JSON.parse(String(await $.fs.read(await $.env.get('MOCK_SCRIPT'))))
  world = { cost: 0 }
  const kept = await $.env.get('MOCK_LEDGER')
  if (kept && (await $.fs.exists(kept))) world = JSON.parse(String(await $.fs.read(kept)))
}

async function note($: any, row: unknown): Promise<void> {
  seen.push(row)
  await $.fs.write(await $.env.get('MOCK_LOG'), JSON.stringify(seen))
  const kept = await $.env.get('MOCK_LEDGER')
  if (kept) await $.fs.write(kept, JSON.stringify(world))
}

export const register: Register = (on: any) => {
  on('turn.step', async function* ($: any, e: any, next: any) {
    await load($)
    const reply: Reply = script![i++] ?? { text: 'mock done' }
    await note($, { kind: 'request', index: e.index, agentId: e.agentId ?? null })
    if (reply.sleep_ms) await $.clock.sleep(reply.sleep_ms, { signal: next?.signal })
    world!.cost += reply.cost ?? 0
    if (reply.five_hour !== undefined) world!.five_hour = reply.five_hour
    if (reply.seven_day !== undefined) world!.seven_day = reply.seven_day
    await note($, { kind: 'step', index: e.index, agentId: e.agentId ?? null, effort: e.effort ?? null, model: e.model, messageCount: e.messageCount, reply })
    if (reply.bash !== undefined) {
      const input = { command: reply.bash, description: 'mock' }
      yield { kind: 'tool', index: 0, id: `toolu_mock_${i}`, name: 'Bash' }
      yield { kind: 'input', index: 0, json: JSON.stringify(input) }
      yield { kind: 'stop', stopReason: 'tool_use', usage: null }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Bash', input }], stopReason: 'tool_use', usage: null }
    }
    const text = reply.text ?? 'mock done'
    yield { kind: 'text', index: 0, text }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
  })

  // The ledger and the usage windows, as scripted, in place of the engine's own.
  on('session.usage', async ($: any, e: any, next: any) => {
    const r = await next(e)
    await load($)
    const rateLimits = (['five_hour', 'seven_day'] as const).filter(k => world![k] !== undefined).map(k => ({ kind: k, percentUsed: world![k], resetsAt: '2030-01-01T00:00:00.000Z' }))
    return { value: { ...r.value, cost: { usd: world!.cost }, rateLimits } }
  })

  on('session.compact', async ($: any, e: any) => {
    await note($, { kind: 'compact', trigger: e.trigger, messages: e.messages.length })
    return { messages: [{ role: 'user', text: 'Summary of the earlier conversation: the user set a task; work is in progress.', toolUses: [] }] }
  })

  // What reached the model beside each tool result (the meter line), and each prompt as it entered.
  on('tool.call', async ($: any, e: any, next: any) => {
    const r = await next(e)
    try { await note($, { kind: 'tool', tool: e.tool, agentId: e.agentId ?? null, context: r?.context ?? null, isError: r?.isError ?? false, deny: r?.deny ?? null }) } catch { /* ignore */ }
    return r
  })
  on('prompt.submit', async ($: any, e: any, next: any) => {
    const r = await next(e)
    try { await note($, { kind: 'prompt', text: r?.text ?? null, context: r?.context ?? null, drop: r?.drop ?? null, origin: e.origin }) } catch { /* ignore */ }
    return r
  })
}
