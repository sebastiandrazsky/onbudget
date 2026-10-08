// The plugin inside the engine: the tests raise events as Claude Code does, over a mocked ledger, model and store.
import { describe, test, expect } from 'claude-code/testing'
import { world, drain, step, start, run, prompt, tool, measure, deferred, rows, LOG } from './world.ts'

const near = (got: number, want: number) => expect(Math.abs(got - want) < 1e-9 ? 'near' : `${got} is not ${want}`).toBe('near')
const lastStatus = (w: { status: (string | undefined)[] }) => w.status[w.status.length - 1]

describe('with no budget set', () => {
  test('requests, tool results and prompts pass through untouched', async ($, on) => {
    const w = world(on)
    await start($)
    const s = await step($, { effort: 'xhigh' })
    expect(s.result.answer).toBe('ok')
    expect(w.requests[0].effort).toBe('xhigh')
    expect(await tool($)).toEqual({ result: 'tool output', text: 'tool output' })
    expect(await prompt($, 'hello')).toEqual({ text: 'hello', context: undefined })
    expect(w.prompts[0].text).toBe('hello')
    expect(w.status.every(x => x === undefined)).toBe(true)
  })
  test('the command is registered, and with no arguments says there is no budget', async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.commands.map(c => c.name)).toEqual(['onbudget'])
    expect((await run($, '')).text.startsWith('no budget is set')).toBe(true)
    expect((await run($, 'off')).text).toBe('no budget is set.')
    expect((await run($, 'banana')).text).toContain('is not a budget')
  })
})

describe('/onbudget $X <task>', () => {
  test('sets the budget and submits the task with the protocol once the command has returned', async ($, on) => {
    const w = world(on, { env: LOG })
    await start($)
    const out = await run($, '$3 Implement authentication')
    expect(out.text).toContain('budget $3.00 set')
    expect(out.text).toContain('Effort is capped at medium')
    expect(w.prompts.length).toBe(0)
    await w.clock.advance(5)
    expect(w.prompts.length).toBe(1)
    expect(w.prompts[0].text.startsWith('Implement authentication\n\nYou have a hard usage budget of $3.00 for this task.')).toBe(true)
    expect(w.prompts[0].origin).toEqual({ kind: 'plugin', name: 'onbudget', asUser: true })
    expect(lastStatus(w)).toBe('spent $0.00 of $3.00 | remaining 100% | tier HIGH')
    expect(rows(w, 'hookfail')).toEqual([])
  })
  test('only the spend after the budget was set counts', async ($, on) => {
    const w = world(on)
    w.cost = 7.5 // the session had already cost this much
    await start($)
    await run($, '$2 task')
    await step($)
    expect((await tool($)).context).toEqual(['[budget] spent $0.10 of $2.00 | remaining 95% | tier HIGH'])
  })
  test('effort is lowered to the cap and never raised', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$2 task')
    await step($, { effort: 'xhigh' })
    await step($, { effort: 'low' })
    await step($, { effort: undefined })
    expect(w.requests.map(r => r.effort)).toEqual(['medium', 'low', undefined])
  })
  test('the effort option keep leaves effort alone', { options: { effort: 'keep' } }, async ($, on) => {
    const w = world(on)
    await start($)
    expect((await run($, '$2 task')).text).not.toContain('Effort is capped')
    await step($, { effort: 'xhigh' })
    expect(w.requests[0].effort).toBe('xhigh')
  })
  test('ONBUDGET_EFFORT overrides the option', async ($, on) => {
    const w = world(on, { env: { ONBUDGET_EFFORT: 'low' } })
    await start($)
    await run($, '$2 task')
    await step($, { effort: 'high' })
    expect(w.requests[0].effort).toBe('low')
  })
  test('the meter line follows every tool result, the main thread and subagents alike, and keeps other context', async ($, on) => {
    const w = world(on)
    w.tool = e => (e.tool === 'Read' ? { result: 'r', text: 'r', context: ['from another hook'] } : { result: 'tool output', text: 'tool output' })
    await start($)
    await run($, '$1 task')
    w.reply = () => ({ cost: 0.35 })
    await step($)
    expect((await tool($)).context).toEqual(['[budget] spent $0.35 of $1.00 | remaining 65% | tier MEDIUM'])
    await step($, { agentId: 'agent-1' })
    expect((await tool($, { agentId: 'agent-1' })).context).toEqual(['[budget] spent $0.70 of $1.00 | remaining 30% | tier MEDIUM'])
    expect((await tool($, { tool: 'Read', input: { file_path: '/x' } })).context).toEqual(['from another hook', '[budget] spent $0.70 of $1.00 | remaining 30% | tier MEDIUM'])
  })
  test('a denied tool call is returned as it is', async ($, on) => {
    const w = world(on)
    w.tool = () => ({ deny: 'no' })
    await start($)
    await run($, '$1 task')
    expect(await tool($, { tool: 'Write', input: { file_path: '/x', content: '' } })).toEqual({ deny: 'no' })
  })
  test('a later prompt carries the reading; the status shows the budget', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$1 task')
    await step($)
    const p = await prompt($, 'also update the docs')
    expect(p.text).toBe('also update the docs')
    expect(p.context).toEqual(['[budget] spent $0.10 of $1.00 | remaining 90% | tier HIGH\nThe budget set earlier for this task still applies to this message.'])
    const status = (await run($, '')).text
    expect(status.startsWith('$0.10 of $1.00 spent · 90% left · tier HIGH')).toBe(true)
    expect(status).toContain('task: task')
    expect(status).toContain('requests: 1 answered, 0 refused · dearest so far $0.10')
  })
  test('a new budget replaces the old one and says what the old one had spent', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$1 first')
    await step($)
    const out = await run($, '$5 second')
    expect(out.text).toContain('budget $5.00 set')
    expect(out.text).toContain('The previous budget was closed ($0.10 of $1.00 was spent)')
    await step($)
    expect((await tool($)).context).toEqual(['[budget] spent $0.10 of $5.00 | remaining 98% | tier HIGH'])
  })
  test('a budget too small for one request is refused, and nothing changes', async ($, on) => {
    const w = world(on)
    await start($)
    const out = await run($, '$0.05 task')
    expect(out.text).toContain('too small')
    await w.clock.advance(5)
    expect(w.prompts.length).toBe(0)
    await step($, { effort: 'xhigh' })
    expect(w.requests[0].effort).toBe('xhigh')
  })
  test('a large idle conversation gets a warning about its first request', async ($, on) => {
    const w = world(on)
    w.contextTokens = 250_000
    await start($)
    expect((await run($, '$1 task')).text).toContain('already holds a large conversation')
  })
})

describe('the stop', () => {
  test('a request the budget cannot cover is not sent; the answer says so; later ones are refused too', async ($, on) => {
    const w = world(on, { env: LOG })
    await start($)
    await run($, '$1 task')
    w.reply = () => ({ cost: 0.3 })
    for (let i = 0; i < 3; i++) await step($) // 0.90 spent, dearest 0.30
    expect(w.requests.length).toBe(3)
    const refused = await step($)
    expect(w.requests.length).toBe(3)
    expect(refused.result.stopReason).toBe('end_turn')
    expect(refused.result.toolUses).toEqual([])
    expect(refused.result.answer).toContain('[onbudget] Stopped: $0.90 of $1.00 is used, and the next request could cost up to $0.30, so it was not sent.')
    expect(refused.chunks.map(c => c.kind)).toEqual(['text', 'stop'])
    expect(lastStatus(w)).toBe('stopped at $0.90 of $1.00: the budget cannot cover another request · /onbudget off to continue')
    const sub = await step($, { agentId: 'agent-1' })
    expect(sub.result.answer).toContain('This subagent was stopped')
    expect(w.requests.length).toBe(3)
    expect(rows(w, 'stop').map(r => r.event)).toEqual(['reserve-stop', 'reserve-stop'])
    expect((await run($, '')).text).toContain('STOPPED')
    // No meter line once stopped, and a follow-up prompt still enters (its request is what gets refused).
    expect((await tool($)).context).toBe(undefined)
    expect((await prompt($, 'continue')).context).toBe(undefined)
  })
  test('the final cost stays within the budget when requests cost what earlier ones did', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$2.47 task')
    let n = 0
    w.reply = () => ({ cost: 0.05 + (n++ % 7) * 0.03 })
    for (let i = 0; i < 200; i++) await step($)
    expect(w.cost <= 2.47).toBe(true)
    expect(w.cost > 2.47 - 2 * 0.23).toBe(true)
  })
  test('/onbudget off removes the budget and requests flow again', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$0.2 task')
    w.reply = () => ({ cost: 0.19 })
    await step($)
    await step($)
    expect(w.requests.length).toBe(1)
    const off = await run($, 'off')
    expect(off.text).toContain('budget removed ($0.19 of $0.20 was spent and the budget had stopped the session)')
    await step($, { effort: 'xhigh' })
    expect(w.requests.length).toBe(2)
    expect(w.requests[1].effort).toBe('xhigh')
    expect(lastStatus(w)).toBe(undefined)
  })
  test('if the session stops reporting its cost, the request is not sent (fail closed)', async ($, on) => {
    const w = world(on, { env: LOG })
    await start($)
    await run($, '$1 task')
    await step($)
    w.hasLedger = false
    const s = await step($)
    expect(w.requests.length).toBe(1)
    expect(s.result.answer).toContain('[onbudget] Not sent: the budget check could not be completed')
    expect(rows(w, 'stopfail').length).toBe(1)
    w.hasLedger = true
    await step($)
    expect(w.requests.length).toBe(2)
  })
  test('a session with no cost ledger cannot take a budget', async ($, on) => {
    const w = world(on)
    w.hasLedger = false
    await start($)
    const out = await run($, '$1 task')
    expect(out.text).toContain('could not run (this session reports no cost)')
    await w.clock.advance(5)
    expect(w.prompts.length).toBe(0)
  })
})

describe('when things go wrong around the command', () => {
  test('/onbudget off and the status still work when the ledger cannot be read', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$1 task')
    await step($)
    w.hasLedger = false
    expect((await step($)).result.answer).toContain('Not sent: the budget check could not be completed')
    expect((await run($, '')).text.startsWith('$0.10 of $1.00 spent')).toBe(true)
    expect((await run($, 'off')).text).toContain('budget removed ($0.10 of $1.00 was spent)')
    await step($)
    expect(w.requests.length).toBe(2)
  })
  test('the command as prompt text that cannot be run drops the prompt: the task is not sent without its budget', async ($, on) => {
    const w = world(on)
    w.hasLedger = false
    await start($)
    const p = await prompt($, '/onbudget $1 Do the thing.', 'sdk')
    expect(p.drop).toContain('the command could not be run (this session reports no cost), so nothing was sent')
    expect(w.prompts.length).toBe(0)
  })
  test('the command as prompt text is honoured only from the person', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$1 task')
    const p = await prompt($, '/onbudget off', 'peer')
    expect(p.text).toBe('/onbudget off')
    expect((await run($, '')).text.startsWith('$0.00 of $1.00 spent')).toBe(true)
  })
  test('a budget that cannot be saved is not set, and the answer says so', async ($, on) => {
    const w = world(on)
    w.storeFails = key => key === 'budget:session-1'
    await start($)
    const out = await run($, '$1 task')
    expect(out.text).toContain('could not run')
    expect(out.text).toContain('No budget was changed')
    await w.clock.advance(5)
    expect(w.prompts.length).toBe(0)
    await step($, { effort: 'xhigh' })
    expect(w.requests[0].effort).toBe('xhigh')
  })
  test('if the task cannot be submitted after the command, the person is told', async ($, on) => {
    const w = world(on)
    w.enter = () => ({ drop: 'blocked by policy' })
    await start($)
    await run($, '$1 task')
    await w.clock.advance(5)
    expect(w.logs.join(' ')).toContain('the budget is set, but the task could not be submitted (blocked by policy)')
  })
})

describe('spend that is not a request of the conversation', () => {
  test('a compaction between two requests is counted as spend, not as the cost of the request after it', async ($, on) => {
    const w = world(on, { env: LOG })
    await start($)
    await run($, '$10 task')
    await step($)
    w.cost += 2 // the compaction's own model request
    await step($)
    const steps = rows(w, 'step')
    near(steps[1].stepCost, 0.1)
    near(steps[1].maxStep, 0.1)
    near(steps[1].spent, 2.2)
  })
})

describe('concurrent requests (subagents beside the main thread)', () => {
  test('each request is charged its own cost, not what ran beside it', async ($, on) => {
    const w = world(on, { env: LOG })
    await start($)
    await run($, '$10 task')
    const hold = deferred()
    w.reply = e => (e.agentId ? { cost: 0.05 } : { cost: 0.3, hold: hold.promise })
    const main = step($) // a long main-thread request, in flight while a subagent works
    await w.clock.settle()
    for (let i = 0; i < 6; i++) await step($, { agentId: 'agent-1' })
    hold.open()
    await main
    const steps = rows(w, 'step')
    expect(steps.length).toBe(7)
    for (const s of steps) near(s.stepCost, s.agentId ? 0.05 : 0.3)
    near(steps[6].maxStep, 0.3) // the prototype's ledger read 0.60 here: the main request plus all that ran beside it
    near(steps[6].spent, 0.6)
    expect((await run($, '')).text).toContain('dearest so far $0.30')
  })
  test('the total is exact however requests interleave', async ($, on) => {
    const w = world(on, { env: LOG })
    await start($)
    await run($, '$50 task')
    const holds = [deferred(), deferred(), deferred()]
    const costs = [0.4, 0.11, 0.23]
    w.reply = e => ({ cost: costs[Number(e.index)], hold: holds[Number(e.index)].promise })
    const running = [0, 1, 2].map(i => step($, { index: i, agentId: i ? `agent-${i}` : undefined }))
    await w.clock.settle()
    holds[1].open(); await running[1]
    holds[2].open(); await running[2]
    holds[0].open(); await running[0]
    const steps = rows(w, 'step')
    near(steps.reduce((sum, s) => sum + s.stepCost, 0), 0.74)
    near(steps[steps.length - 1].spent, 0.74)
    near(Math.max(...steps.map(s => s.maxStep)), 0.4)
  })
  test('a request in flight holds back a reserve of its own', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$1 task')
    w.reply = () => ({ cost: 0.3 })
    await step($) // spent 0.30, dearest 0.30
    const hold = deferred()
    w.reply = e => (e.agentId ? { cost: 0.3 } : { cost: 0.3, hold: hold.promise })
    const main = step($) // in flight: may cost another 0.30
    await w.clock.settle()
    await step($, { agentId: 'agent-1' }) // 0.30 + 2 x 0.30 < 1.00: sent
    expect(w.requests.length).toBe(3)
    hold.open()
    await main
  })
  test('with two already in flight the third is refused, where a sequential one would have been sent', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$1 task')
    w.reply = () => ({ cost: 0.25 })
    await step($) // spent 0.25, dearest 0.25
    const hold = deferred()
    w.reply = () => ({ cost: 0.25, hold: hold.promise })
    const a = step($)
    const b = step($, { agentId: 'agent-1' })
    await w.clock.settle()
    expect(w.requests.length).toBe(3)
    const c = await step($, { agentId: 'agent-2' }) // 0.25 + 3 x 0.25 = 1.00: not sent
    expect(w.requests.length).toBe(3)
    expect(c.result.answer).toContain('This subagent was stopped')
    hold.open()
    await Promise.all([a, b])
    expect(w.cost <= 1).toBe(true)
  })
})
