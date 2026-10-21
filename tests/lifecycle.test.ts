// Headless entry points, percentage budgets, calibration, and what survives a compaction, a reload, a resume, a /clear.
import { describe, test, expect } from 'claude-code/testing'
import { world, step, start, run, prompt, tool, measure, compact, rows, logChunks, LOG } from './world.ts'

const near = (got: number, want: number) => expect(Math.abs(got - want) < 1e-9 ? 'near' : `${got} is not ${want}`).toBe('near')
const NOW = 1_700_000_000_000
const DAY = Math.floor(NOW / 86_400_000)
const cal = (kind: string, usd: number, points: number, model = 'claude-opus-5-5') => ({ kind, model, usd, points, segments: 1, at: NOW - 1000 })
const calKey = (session: string, kind = 'five_hour', model = 'claude-opus-5-5', day = DAY) => `cal:${kind}:${day}:${session}:${model}`
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
    expect((await tool($)).context).toEqual(['[budget] the 5-hour usage window has moved 0 of 3 points | left before the stop 3 points (100%) | tier HIGH'])
    await step($)
    expect((await tool($)).context).toEqual(['[budget] the 5-hour usage window has moved 2 of 3 points | left before the stop 1 point (33%) | tier CRITICAL'])
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
    for (let i = 0; i < 3; i++) await step($)
    const s = await step($)
    expect(w.requests.length).toBe(3)
    expect(s.result.answer).toContain('the weekly usage window is not being reported in this session')
    expect((await run($, '')).text).toContain('STOPPED (the usage window is not being reported)')
  })
  test('a request that got no answer does not count as an answer without a reading', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '5% week task')
    w.reply = () => ({ none: true }) // interrupted or failed before any response
    for (let i = 0; i < 6; i++) await step($)
    w.reply = () => ({ cost: 0.1 })
    expect((await step($)).result.answer).toBe('ok')
    expect(w.requests.length).toBe(7)
  })
  test('a window at its wall stops an unconverted budget before the account\'s own limit would', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '30% 5h task')
    const answers = [98, 100]
    w.reply = () => { w.readings = fiveHour(answers.shift()!); return { cost: 0.5 } }
    await step($)
    const s = await step($)
    expect(w.requests.length).toBe(1)
    expect(s.result.answer).toContain("the account's 5-hour usage limit is close: the window is at 98% (resets 2026-10-08 22:10 UTC)")
  })
  test('with a calibration it is converted to dollars at the learned rate, which errs low', async ($, on) => {
    const w = world(on, { env: LOG, store: { [calKey('older-1')]: cal('five_hour', 19.4, 20), [calKey('older-2')]: cal('five_hour', 9.7, 10) } })
    w.readings = fiveHour(20)
    await start($)
    const out = await run($, '4% 5h task')
    const rate = 29.1 / (30 + 2 * 0.41 * Math.sqrt(2))
    expect(rate < 0.97).toBe(true)
    const b = rows(w, 'budget')[0]
    near(b.rate.usdPerPoint, rate)
    near(b.usd, Math.round(4 * rate * 10000) / 10000)
    expect(out.text).toContain(`budget $${(4 * rate).toFixed(2)} (4% of the 5-hour usage window) set`)
    expect(out.text).toContain('learned from 30 points of movement')
    w.reply = () => ({ cost: 1.3 })
    await step($); await step($) // 2.60 spent, dearest 1.30: the next would cross 3.74
    const s = await step($)
    expect(w.requests.length).toBe(2)
    expect(s.result.answer).toContain('Stopped: $2.60 of $3.74 (4% of the 5-hour usage window) is used')
  })
  test('the reading backstops a calibration gone wrong: more than twice the budget moved', async ($, on) => {
    const w = world(on, { store: { [calKey('older-1')]: cal('five_hour', 29.1, 30) } })
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
    const w = world(on, { store: { [calKey('older-1', 'five_hour', 'claude-haiku-5-5')]: cal('five_hour', 29.1, 30, 'claude-haiku-5-5') } })
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
    expect((await run($, '10% 5h task')).text).toContain("The account's 5-hour window is at 96%, so less is left in it than the budget: about 1 point before onbudget stops for it. The task runs against that.")
  })
  test('a budget set without a conversion keeps the rule it was set with; what the session learns serves the next one', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '10% 5h task')
    const answers = [30, 31, 33, 35]
    w.reply = () => { w.readings = fiveHour(answers.shift()!); return { cost: 1 } }
    for (let i = 0; i < 4; i++) { await step($); await measure($, w) }
    expect((await tool($)).context[0]).toBe('[budget] the 5-hour usage window has moved 5 of 10 points | left before the stop 5 points (50%) | tier MEDIUM')
    const next = await run($, '10% 5h another task')
    expect(next.text).toContain('(10% of the 5-hour usage window) set')
    expect(next.text).toContain('learned from 5 points of movement')
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
    expect(status).toContain('calibration, 5-hour window: 1 point ≈ $0.78 (4 points observed in 1 session)') // 4 dollars over 4 points in two segments
    expect(status).toContain('calibration, weekly window: not enough data yet')
    await step($, { effort: 'xhigh' })
    expect(w.requests[0].effort).toBe('xhigh')
  })
  test('old records are deleted by the day in their key, recent ones from other sessions are pooled', async ($, on) => {
    const w = world(on, { store: { [calKey('ancient', 'five_hour', 'claude-opus-5-5', DAY - 31)]: cal('five_hour', 100, 100), [calKey('recent')]: cal('five_hour', 9.7, 10), 'unrelated': 1 } })
    await start($)
    const status = (await run($, '')).text
    expect(status).toContain('1 point ≈ $0.90 (10 points observed in 1 session)')
    expect([...w.store.keys()].sort()).toEqual([calKey('recent'), 'pruned', 'unrelated'])
  })
  test('a change of model starts a record of its own; one model\'s rate is not another\'s', async ($, on) => {
    const w = world(on)
    await start($)
    w.cost = 0; w.readings = fiveHour(10); await measure($, w)
    w.cost = 5; w.readings = fiveHour(15); await measure($, w)
    w.model = 'claude-sonnet-5-5'
    w.cost = 6; w.readings = fiveHour(19); await measure($, w) // began on the other model: not counted for either
    w.cost = 7; w.readings = fiveHour(23); await measure($, w)
    expect(w.store.get(calKey('session-1'))).toEqual({ ...cal('five_hour', 5, 5), at: NOW })
    expect(w.store.get(calKey('session-1', 'five_hour', 'claude-sonnet-5-5'))).toEqual({ ...cal('five_hour', 1, 4, 'claude-sonnet-5-5'), at: NOW })
    expect((await run($, '')).text).toContain('1 point ≈ $0.21 (4 points observed in 1 session)')
  })
  test('stale budgets and flags of other sessions are deleted after 30 days without use', async ($, on) => {
    const old = NOW - 31 * 86_400_000
    const w = world(on, { store: { 'budget:gone': { v: 1, spec: { kind: 'usd', usd: 1 }, spent: 0, ledger: 0, startedAt: old - 5, savedAt: old }, 'env:gone': { at: old }, 'budget:kept': { v: 1, spec: { kind: 'usd', usd: 1 }, spent: 0, ledger: 0, startedAt: old, savedAt: NOW - 1000 } } })
    await start($)
    expect([...w.store.keys()]).toEqual(['budget:kept', 'pruned'])
  })
  test('other sessions\' budgets and flags are gone through at most once a day', async ($, on) => {
    const old = NOW - 31 * 86_400_000
    const stale = { 'budget:gone': { v: 1, spec: { kind: 'usd', usd: 1 }, spent: 0, ledger: 0, startedAt: old - 5, savedAt: old }, 'env:gone': { at: old } }
    const w = world(on, { store: { ...stale, pruned: DAY } })
    await start($)
    expect([...w.store.keys()]).toEqual(['budget:gone', 'env:gone', 'pruned']) // already gone through today
  })
  test('the first session of a new day goes through them again', async ($, on) => {
    const old = NOW - 31 * 86_400_000
    const w = world(on, { store: { 'env:gone': { at: old }, pruned: DAY - 1 } })
    await start($)
    expect([...w.store.keys()]).toEqual(['pruned'])
    expect(w.store.get('pruned')).toBe(DAY)
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
    expect(w.status[w.status.length - 1]).toBe('tier MEDIUM · $2.30 left · budget $4.00')
    await step($)
    expect((await tool($)).context).toEqual(['[budget] spent $1.70 of $4.00 | left before the stop $2.10 (53%) | tier MEDIUM'])
  })
  test('a resumed session whose ledger starts over: nothing is counted twice or lost', async ($, on) => {
    const w = world(on, { store: { 'budget:session-1': saved() } })
    w.cost = 0
    await start($)
    await step($)
    expect((await tool($)).context).toEqual(['[budget] spent $1.60 of $4.00 | left before the stop $2.20 (55%) | tier MEDIUM'])
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

describe('a process that moves to another session (/resume inside a session)', () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    v: 1, raw: '$9', spec: { kind: 'usd', usd: 9 }, task: 'the other task', usd: 9, rate: null, spent: 0.5, ledger: 0, maxStep: 0.1, steps: 3, refused: 0,
    state: 'active', effortCap: 'keep', remind: false, startedAt: NOW - 5000, savedAt: NOW - 4000, ...over,
  })
  const resumeTo = async ($: any, w: any, sid: string) => {
    await $.session.end({ reason: 'resume', sessionId: w.sid, resume: { id: w.sid } })
    w.sid = sid
  }
  test('into a session with a budget of its own: that budget applies, and is charged only what it spends', async ($, on) => {
    const w = world(on, { store: { 'budget:session-2': stored() } })
    await start($)
    await run($, '$1 first task')
    w.reply = () => ({ cost: 0.3 })
    await step($)
    await resumeTo($, w, 'session-2')
    w.reply = () => ({ cost: 0.1 })
    await step($, { effort: 'xhigh' })
    expect(w.requests[1].effort).toBe('xhigh') // session-2's budget keeps effort
    expect((await tool($)).context).toEqual(['[budget] spent $0.60 of $9.00 | left before the stop $8.30 (92%) | tier HIGH'])
    near((w.store.get('budget:session-1') as any).spent, 0.3)
    near((w.store.get('budget:session-2') as any).spent, 0.6)
  })
  test('into a session whose budget had stopped: its requests are refused', async ($, on) => {
    const stop = { event: 'reserve-stop', spent: 8.95, reserve: 0.1, budget: 9, inFlight: 0 }
    const w = world(on, { store: { 'budget:session-2': stored({ state: 'stopped', stop, spent: 8.95 }) } })
    await start($)
    await step($)
    await resumeTo($, w, 'session-2')
    const s = await step($)
    expect(w.requests.length).toBe(1)
    expect(s.result.answer).toContain('[onbudget] Stopped')
  })
  test('into a session with no budget: nothing of the old one follows', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$1 first task')
    await step($)
    await resumeTo($, w, 'session-2')
    await step($, { effort: 'xhigh' })
    expect(w.requests[1].effort).toBe('xhigh')
    expect(await tool($)).toEqual({ result: 'tool output', text: 'tool output' })
    expect(w.status[w.status.length - 1]).toBe(undefined)
    expect((w.store.get('budget:session-1') as any).state).toBe('active') // kept for when that session is resumed
  })
  test('a session change nothing announced is noticed at the next prompt', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$1 first task')
    await step($)
    w.sid = 'session-2'
    const p = await prompt($, 'a prompt in the other session')
    expect(p.context).toBe(undefined)
    await step($, { effort: 'xhigh' })
    expect(w.requests[1].effort).toBe('xhigh')
    near((w.store.get('budget:session-1') as any).spent, 0.1)
  })
})

describe('percentage budgets across processes', () => {
  const pct = (over: Record<string, unknown> = {}) => ({
    v: 1, raw: '5% 5h', spec: { kind: 'pct', window: 'five_hour', points: 5 }, task: 't', usd: null, rate: null, spent: 2, ledger: 2, maxStep: 0.5, steps: 4, refused: 0,
    state: 'active', window: { kind: 'five_hour', last: 40, moved: 2, blind: 0 }, effortCap: 'medium', remind: false, startedAt: NOW - 5000, ...over,
  })
  test('an unconverted budget keeps its baseline: the window\'s movement counts whichever process saw it', async ($, on) => {
    const w = world(on, { store: { 'budget:session-1': pct() } })
    await start($)
    w.reply = () => { w.readings = fiveHour(43); return { cost: 0.1 } }
    await step($) // the reading that came with it: 40 -> 43, five points moved in all
    const s = await step($)
    expect(w.requests.length).toBe(1)
    expect(s.result.answer).toContain('has moved 5 points since the budget started (5 budgeted)')
  })
  test('a converted budget starts a new baseline: what the window did while the session was away is not held against it', async ($, on) => {
    const w = world(on, { store: { 'budget:session-1': pct({ usd: 4, rate: { usdPerPoint: 0.8, points: 30, intervals: 3, source: 'learned' } }) } })
    await start($)
    const answers = [90, 91]
    w.reply = () => { w.readings = fiveHour(answers.shift()!); return { cost: 0.1 } }
    await step($); await step($)
    expect((await run($, '')).text).toContain('5-hour window under the budget: moved 3 points since the budget started')
  })
})

describe('ONBUDGET, once', () => {
  test('/onbudget off cancels a pending ONBUDGET, and a reload does not arm it again', async ($, on) => {
    const w = world(on, { env: { ONBUDGET: '$1' } })
    await start($)
    expect((await run($, '')).text).toContain('pending: ONBUDGET=$1 applies to the next prompt')
    expect((await run($, 'off')).text).toContain('the budget in ONBUDGET was cancelled')
    expect((await prompt($, 'just a question', 'sdk')).text).toBe('just a question')
    await step($, { effort: 'xhigh' })
    expect(w.requests[0].effort).toBe('xhigh')
    expect(w.store.has('env:session-1')).toBe(true)
  })
  test('a session that already used its ONBUDGET does not get it again after the budget is removed', async ($, on) => {
    const w = world(on, { env: { ONBUDGET: '$1' }, store: { 'env:session-1': { at: NOW - 1000 } } })
    await start($)
    expect((await prompt($, 'after a reload', 'sdk')).text).toBe('after a reload')
    expect(w.requests.length).toBe(0)
  })
})

describe('the event log', () => {
  test('is off unless ONBUDGET_LOG is 1', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$2 task')
    await step($)
    expect(w.files.size).toBe(0)
  })
  test('a path in ONBUDGET_LOG is never written: the log has one fixed place, and a path does not turn it on', async ($, on) => {
    const w = world(on, { env: { ONBUDGET_LOG: '/home/user/.zshrc' } })
    await start($)
    await run($, '$2 task')
    await step($)
    expect(w.files.size).toBe(0)
  })
  test('rows are JSON, one per event, in chunks of 200, in log/events.jsonl of the plugin\'s own folder', async ($, on) => {
    const w = world(on, { env: LOG })
    await start($)
    await run($, '$500 task')
    w.reply = () => ({ cost: 0.01 })
    for (let i = 0; i < 205; i++) await step($)
    const paths = logChunks(w).map(([p]) => p)
    expect(paths.length).toBe(2)
    expect(paths[0].endsWith('/log/events.jsonl') && paths[1] === paths[0].replace('events.jsonl', 'events.1.jsonl') && paths[0].startsWith('/')).toBe(true)
    expect([...w.files.keys()].every(p => paths.includes(p))).toBe(true)
    expect(logChunks(w)[0][1].trim().split('\n').length).toBe(200)
    expect(rows(w, 'step').length).toBe(205)
    expect(rows(w, 'session.start')[0]).toEqual({ sid: 'session-1', budget: null, restored: false, effortCap: 'medium', history: false, version: { version: 'test' } })
  })
  test('the chunks an earlier, longer process left are emptied, so the log is this process\'s alone', async ($, on) => {
    const w = world(on, { env: LOG })
    w.exists = p => /\/log\/events\.[12]\.jsonl$/.test(p) // an earlier run left log/events.1.jsonl and log/events.2.jsonl
    await start($)
    const chunks = logChunks(w)
    expect(chunks.map(([p]) => p.replace(/^.*\/log\//, 'log/'))).toEqual(['log/events.jsonl', 'log/events.1.jsonl', 'log/events.2.jsonl'])
    expect(chunks.slice(1).every(([, text]) => text === '')).toBe(true)
    expect(rows(w, 'session.start').length).toBe(1)
  })
})
