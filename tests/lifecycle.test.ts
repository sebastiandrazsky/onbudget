// Headless entry points, percentage budgets, calibration, and what survives a compaction, a reload, a resume, a /clear.
import { describe, test, expect } from 'claude-code/testing'
import { world, step, start, run, prompt, tool, measure, compact, rows, LOG } from './world.ts'

const near = (got: number, want: number) => expect(Math.abs(got - want) < 1e-9 ? 'near' : `${got} is not ${want}`).toBe('near')
const NOW = 1_700_000_000_000
const cal = (kind: string, usd: number, points: number, model = 'claude-opus-5-5') => ({ kind, model, usd, points, at: NOW - 1000 })
const fiveHour = (percentUsed: number) => [{ kind: 'five_hour', percentUsed, resetsAt: '2026-10-08T22:10:00.000Z' }, { kind: 'seven_day', percentUsed: 4 }]

describe('without the slash command (headless, SDK hosts)', () => {
  test('ONBUDGET applies to the first prompt: the budget is set and the protocol appended', async ($, on) => {
    const w = world(on, { env: { ONBUDGET: '$4.20' } })
    await start($)
    const p = await prompt($, 'Fix the seven tasks.\nSecond line.', 'sdk')
    expect(p.text.startsWith('Fix the seven tasks.\nSecond line.\n\nYou have a hard usage budget of $4.20 for this task.')).toBe(true)
    expect(w.logs[0]).toContain('budget $4.20 set')
    await step($, { effort: 'xhigh' })
    expect(w.requests[0].effort).toBe('medium')
    const again = await prompt($, 'next', 'sdk') // the variable is used once
    expect(again.text).toBe('next')
    expect(again.context?.[0]).toContain('[budget] spent $0.10 of $4.20')
  })
  test('an unusable ONBUDGET drops the prompt rather than run it unbudgeted', async ($, on) => {
    const w = world(on, { env: { ONBUDGET: 'lots' } })
    await start($)
    const p = await prompt($, 'do it', 'sdk')
    expect(p.drop).toContain('"lots" is not a budget')
    expect(w.prompts.length).toBe(0)
    const s = await step($) // and should a request be raised anyway, it is not sent
    expect(w.requests.length).toBe(0)
    expect(s.result.answer).toContain('the budget in ONBUDGET did not start')
  })
  test('a background notification does not consume ONBUDGET', async ($, on) => {
    const w = world(on, { env: { ONBUDGET: '$1' } })
    await start($)
    expect((await prompt($, 'task finished', 'task-notification')).text).toBe('task finished')
    expect((await prompt($, 'the real task', 'sdk')).text).toContain('hard usage budget of $1.00')
  })
  test('the command typed as prompt text works where slash commands are off', async ($, on) => {
    const w = world(on)
    await start($)
    const p = await prompt($, '/onbudget $0.50 Say hi.\nTwice.', 'sdk')
    expect(p.text.startsWith('Say hi.\nTwice.\n\nYou have a hard usage budget of $0.50')).toBe(true)
    expect((await prompt($, '/onbudget', 'sdk')).drop).toContain('onbudget: $0.00 of $0.50 spent')
    expect((await prompt($, '/onbudget off', 'sdk')).drop).toContain('budget removed')
    expect((await prompt($, '/onbudgets are nice', 'sdk')).text).toBe('/onbudgets are nice')
  })
})

describe('percentage budgets', () => {
  test('with no calibration a budget under 3 points is refused, with the reason', async ($, on) => {
    const w = world(on)
    w.readings = fiveHour(20)
    await start($)
    const out = await run($, '2% 5h task')
    expect(out.text).toContain('cannot enforce 2% 5h yet')
    expect(out.text).toContain('a dollar budget works now')
    await w.clock.advance(5)
    expect(w.prompts.length).toBe(0)
  })
  test('with no calibration it is enforced on the window reading, from the first reading under the budget', async ($, on) => {
    const w = world(on, { env: LOG })
    w.readings = fiveHour(20) // a stale reading from before the budget: not the baseline
    await start($)
    const out = await run($, '3% 5h task')
    expect(out.text).toContain('budget 3% of the 5-hour usage window set')
    expect(out.text).toContain('whole points, account-wide')
    await w.clock.advance(5)
    expect(w.prompts[0].text).toContain('hard usage budget of 3% of the 5-hour usage window')
    // Each answer brings a fresh reading with it. Other sessions used the window while this one sat idle: 20 -> 31.
    const answers = [31, 33, 34]
    w.reply = () => { w.readings = fiveHour(answers.shift()!); return { cost: 0.1 } }
    await step($)
    expect((await tool($)).context).toEqual(['[budget] the 5-hour usage window has moved 0 of 3 points | remaining 100% | tier HIGH'])
    await step($)
    expect((await tool($)).context).toEqual(['[budget] the 5-hour usage window has moved 2 of 3 points | remaining 33% | tier MEDIUM'])
    await step($) // sent: the reading that shows the third point arrives with its answer
    const refused = await step($)
    expect(w.requests.length).toBe(3)
    expect(refused.result.answer).toContain('the 5-hour usage window has moved 3 points since the budget started (3 budgeted)')
    expect(rows(w, 'stop')[0].event).toBe('window-stop')
  })
  test('an account that reports no window cannot take a percentage budget for long', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '5% week task')
    await step($)
    await step($)
    const s = await step($)
    expect(w.requests.length).toBe(2)
    expect(s.result.answer).toContain('this account reports no weekly usage window')
  })
  test('with a calibration it is converted to dollars at the learned rate, which errs low', async ($, on) => {
    const w = world(on, { env: LOG, store: { 'cal:five_hour:older-1': cal('five_hour', 19.4, 20), 'cal:five_hour:older-2': cal('five_hour', 9.7, 10) } })
    w.readings = fiveHour(20)
    await start($)
    const out = await run($, '4% 5h task')
    const rate = 29.1 / (30 + 2 * 0.41 * Math.sqrt(2))
    expect(rate < 0.97).toBe(true)
    const b = rows(w, 'budget')[0]
    near(b.rate.usdPerPoint, rate)
    near(b.usd, Math.round(4 * rate * 10000) / 10000)
    expect(out.text).toContain(`budget $${(4 * rate).toFixed(2)} (4% of the 5-hour usage window) set`)
    expect(out.text).toContain('learned on this account from 30 points')
    w.reply = () => ({ cost: 1.3 })
    await step($); await step($) // 2.60 spent, dearest 1.30: the next would cross 3.74
    const s = await step($)
    expect(w.requests.length).toBe(2)
    expect(s.result.answer).toContain('Stopped: $2.60 of $3.74 (4% of the 5-hour usage window) is used')
  })
  test('the reading backstops a calibration gone wrong: more than twice the budget moved', async ($, on) => {
    const w = world(on, { store: { 'cal:five_hour:older-1': cal('five_hour', 29.1, 30) } })
    await start($)
    await run($, '4% 5h task')
    const answers = [50, 58, 59] // 8 points is twice the budget and still tolerated; 9 is not
    w.reply = () => { w.readings = fiveHour(answers.shift()!); return { cost: 0.01 } }
    await step($); await step($); await step($)
    const s = await step($)
    expect(w.requests.length).toBe(3)
    expect(s.result.answer).toContain('has moved 9 points since the budget started, more than twice the 4 budgeted')
  })
  test('a calibration for another model is not used', async ($, on) => {
    const w = world(on, { store: { 'cal:five_hour:older-1': cal('five_hour', 29.1, 30, 'claude-haiku-5-5') } })
    await start($)
    expect((await run($, '2% 5h task')).text).toContain('cannot enforce 2% 5h yet')
  })
  test('your own dollars-per-point setting is used as given', { options: { usdPerPointWeek: 12.65 } }, async ($, on) => {
    const w = world(on)
    await start($)
    const out = await run($, '0.5% week task')
    expect(out.text).toContain('budget $6.33 (0.5% of the weekly usage window) set')
    expect(out.text).toContain('your setting')
  })
  test('a budget larger than what the window has left says so', async ($, on) => {
    const w = world(on)
    w.readings = fiveHour(96)
    await start($)
    expect((await run($, '10% 5h task')).text).toContain('the window is already at 96%')
  })
  test('an unconverted budget is converted as soon as this session has seen enough movement', async ($, on) => {
    const w = world(on, { env: LOG })
    await start($)
    await run($, '10% 5h task')
    const answers = [30, 31, 33]
    w.reply = () => { w.readings = fiveHour(answers.shift()!); return { cost: 1 } }
    await step($); await measure($, w)
    await step($); await measure($, w)
    expect(rows(w, 'calibrated').length).toBe(0) // one point seen so far: not enough to convert
    expect((await tool($)).context[0]).toContain('has moved 1 of 10 points')
    await step($); await measure($, w) // three points for two dollars since the first reading
    const c = rows(w, 'calibrated')[0]
    near(c.rate.usdPerPoint, 2 / (3 + 2 * 0.41))
    near(c.usd, Math.round(10 * c.rate.usdPerPoint * 10000) / 10000)
    expect((await tool($)).context[0]).toContain('spent $3.00 of $5.24 (10% of the 5-hour usage window)')
  })
})

describe('calibration, in every session', () => {
  test('readings and the ledger are recorded per session and window; nothing else changes', async ($, on) => {
    const w = world(on)
    await start($)
    w.cost = 1; w.readings = fiveHour(10); await measure($, w, ['cost', 'rateLimits'])
    w.cost = 3; w.readings = fiveHour(12); await measure($, w)
    w.cost = 4; w.readings = fiveHour(1); await measure($, w) // the window reset: this span is left out
    w.cost = 6; w.readings = fiveHour(3); await measure($, w)
    const status = (await run($, '')).text
    expect(status).toContain('calibration, 5-hour window: 1 point ≈ $0.83 (4 points observed in 1 session)')
    expect(status).toContain('calibration, weekly window: not enough data yet')
    await step($, { effort: 'xhigh' })
    expect(w.requests[0].effort).toBe('xhigh')
  })
  test('old records are deleted, recent ones from other sessions are pooled', async ($, on) => {
    const old = { ...cal('five_hour', 100, 100), at: NOW - 31 * 24 * 3600 * 1000 }
    const w = world(on, { store: { 'cal:five_hour:ancient': old, 'cal:five_hour:recent': cal('five_hour', 9.7, 10), 'unrelated': 1 } })
    await start($)
    const status = (await run($, '')).text
    expect(status).toContain('1 point ≈ $0.90 (10 points observed in 1 session)')
    expect([...w.store.keys()].sort()).toEqual(['cal:five_hour:recent', 'unrelated'])
  })
})

describe('what a budget survives', () => {
  const saved = (over: Record<string, unknown> = {}) => ({
    v: 1, raw: '$4', spec: { kind: 'usd', usd: 4 }, task: 'the task', usd: 4, rate: null, spent: 1.5, ledger: 6.5, maxStep: 0.2, steps: 12, refused: 0,
    state: 'active', effortCap: 'medium', remind: false, startedAt: NOW - 5000, ...over,
  })
  test('a compaction: the protocol is sent again, once, with the next reading on the main thread', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$2 task')
    await compact($, 'precompute') // installs nothing
    expect((await tool($)).context.length).toBe(1)
    await compact($, 'auto')
    expect((await tool($, { agentId: 'agent-1' })).context.length).toBe(1) // not spent on a subagent
    const after = (await tool($)).context
    expect(after.length).toBe(2)
    expect(after[0]).toContain('Reminder, in case the earlier instruction was summarised away:\nYou have a hard usage budget of $2.00')
    expect(after[1]).toContain('[budget] spent')
    expect((await tool($)).context.length).toBe(1)
  })
  test('a reload or a restarted process with the ledger intact: spend goes on from the store', async ($, on) => {
    const w = world(on, { store: { 'budget:session-1': saved() } })
    w.cost = 6.6 // ten cents were spent after the last save
    await start($)
    expect(w.status[w.status.length - 1]).toContain('spent $1.50 of $4.00')
    await step($)
    expect((await tool($)).context).toEqual(['[budget] spent $1.70 of $4.00 | remaining 58% | tier MEDIUM'])
  })
  test('a resumed session whose ledger starts over: nothing is counted twice or lost', async ($, on) => {
    const w = world(on, { store: { 'budget:session-1': saved() } })
    w.cost = 0
    await start($)
    await step($)
    expect((await tool($)).context).toEqual(['[budget] spent $1.60 of $4.00 | remaining 60% | tier MEDIUM'])
  })
  test('a stopped budget is still stopped after a resume', async ($, on) => {
    const stop = { event: 'reserve-stop', spent: 3.9, reserve: 0.2, budget: 4 }
    const w = world(on, { store: { 'budget:session-1': saved({ state: 'stopped', stop, spent: 3.9 }) } })
    await start($)
    const s = await step($)
    expect(w.requests.length).toBe(0)
    expect(s.result.answer).toContain('[onbudget] Stopped')
  })
  test('another session has its own budget, or none', async ($, on) => {
    const w = world(on, { sid: 'session-2', store: { 'budget:session-1': saved() } })
    await start($)
    await step($, { effort: 'xhigh' })
    expect(w.requests[0].effort).toBe('xhigh')
    expect((await run($, '')).text).toContain('no budget is set')
  })
  test('ONBUDGET does not restart a budget the session already has', async ($, on) => {
    const w = world(on, { env: { ONBUDGET: '$9' }, store: { 'budget:session-1': saved() } })
    w.cost = 6.5
    await start($)
    const p = await prompt($, 'go on', 'sdk')
    expect(p.text).toBe('go on')
    expect(p.context[0]).toContain('[budget] spent $1.50 of $4.00')
  })
  test('/clear ends the budget with the conversation it belonged to', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$2 task')
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    w.sid = 'session-1b'
    await step($, { effort: 'xhigh' })
    expect(w.requests[0].effort).toBe('xhigh')
    expect(w.status[w.status.length - 1]).toBe(undefined)
    expect(w.store.has('budget:session-1')).toBe(false)
  })
  test('an exit keeps it for the next resume', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$2 task')
    await step($)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })
    const kept: any = w.store.get('budget:session-1')
    near(kept.spent, 0.1)
    expect(kept.state).toBe('active')
  })
})

describe('the event log', () => {
  test('is written only when ONBUDGET_LOG names a file', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$2 task')
    await step($)
    expect(w.files.size).toBe(0)
  })
  test('rows are JSON, one per event, in chunks of 200', async ($, on) => {
    const w = world(on, { env: LOG })
    await start($)
    await run($, '$500 task')
    w.reply = () => ({ cost: 0.01 })
    for (let i = 0; i < 205; i++) await step($)
    expect([...w.files.keys()].sort()).toEqual(['/log', '/log.1'])
    expect(w.files.get('/log')!.trim().split('\n').length).toBe(200)
    expect(rows(w, 'step').length).toBe(205)
    expect(rows(w, 'session.start')[0]).toEqual({ sid: 'session-1', budget: null, restored: false, effortCap: 'medium', version: { version: 'test' } })
  })
})
