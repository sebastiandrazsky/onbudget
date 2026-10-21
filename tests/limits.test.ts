// Where the stop is, and the account's own limits: the meter against the stop rule, the 5-hour and weekly windows as
// walls under every budget, and the budgets `5h` and `week`.
import { describe, test, expect } from 'claude-code/testing'
import { world, step, start, run, prompt, tool, measure, rows, LOG } from './world.ts'

const near = (got: number, want: number) => expect(Math.abs(got - want) < 1e-9 ? 'near' : `${got} is not ${want}`).toBe('near')
const NOW = 1_700_000_000_000
const DAY = Math.floor(NOW / 86_400_000)
const R1 = '2026-10-08T22:10:00.000Z' // a reset time after the tests' clock
const R2 = '2026-10-09T03:10:00.000Z' // the window after it
const five = (percentUsed: number, resetsAt = R1) => ({ kind: 'five_hour', percentUsed, resetsAt })
const week = (percentUsed: number) => ({ kind: 'seven_day', percentUsed, resetsAt: '2026-10-12T00:00:00.000Z' })
const cal = (usd: number, points: number) => ({ kind: 'five_hour', model: 'claude-opus-5-5', usd, points, segments: 1, at: NOW - 1000 })
const calKey = (session: string) => `cal:five_hour:${DAY}:${session}:claude-opus-5-5`
const tierOf = (line: string) => /tier (\w+)/.exec(line)?.[1]

/** Sends requests one at a time, each followed by a tool result, until one is refused: the tier each meter line read. */
async function drive($: any, w: any, n = 40): Promise<{ tiers: string[]; lines: string[]; refused: any }> {
  const tiers: string[] = []
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    const before = w.requests.length
    const s = await step($)
    if (w.requests.length === before) return { tiers, lines, refused: s.result }
    const line = (await tool($)).context?.[0] ?? ''
    lines.push(line)
    tiers.push(tierOf(line) ?? '?')
  }
  return { tiers, lines, refused: null }
}

/** How many requests were sent after the meter first read CRITICAL: the tiers are those read after each request. */
const sentAfterCritical = (tiers: string[]) => (tiers.indexOf('CRITICAL') < 0 ? -1 : tiers.length - 1 - tiers.indexOf('CRITICAL'))

describe('the meter and the stop agree', () => {
  test('requests one at a time: CRITICAL is read before at least two requests, and only then can one be refused', async ($, on) => {
    const w = world(on, { env: LOG })
    await start($)
    await run($, '$1 task')
    const costs = [0.08, 0.05, 0.06, 0.08, 0.07, 0.04, 0.08, 0.06, 0.05, 0.08, 0.07, 0.08, 0.06]
    w.reply = () => ({ cost: costs.shift() ?? 0.08 })
    const { tiers, lines, refused } = await drive($, w)
    expect(refused.answer).toContain('[onbudget] Stopped:')
    expect(sentAfterCritical(tiers) >= 2).toBe(true)
    // What the meter calls left is what the stop allows: 0 left, and the next request is refused.
    expect(lines[lines.length - 1]).toContain('left before the stop $0.00 (0%)')
    const stop = rows(w, 'stop')[0]
    expect(stop.event).toBe('reserve-stop')
    expect(stop.spent + stop.reserve >= 1).toBe(true)
  })
  test('the run that ended without a report ($2.47, dearest request $0.169) now reads CRITICAL from $1.97, not $2.27', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$2.47 task')
    w.reply = () => ({ cost: 0.169 })
    await step($) // the dearest request of the run; the others cost less
    const spends: [number, string][] = []
    w.reply = () => ({ cost: 0.1 })
    for (let i = 0; i < 25; i++) {
      const before = w.requests.length
      await step($)
      if (w.requests.length === before) break
      const line = (await tool($)).context[0]
      spends.push([Number(/spent \$(\d+\.\d+)/.exec(line)![1]), tierOf(line)!])
    }
    const firstCritical = spends.find(([, t]) => t === 'CRITICAL')!
    expect(firstCritical[0]).toBe(1.97) // $2.47 less the reserve and two requests' worth ($0.507)
    expect(spends.filter(([, t]) => t === 'CRITICAL').length >= 3).toBe(true)
  })
  test('with requests in flight the meter takes off their reserves too, as the stop does', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$2 task')
    w.reply = () => ({ cost: 0.2 })
    await step($) // dearest $0.20
    let open!: () => void
    w.reply = () => ({ cost: 0.2, hold: new Promise<void>(r => { open = r }) })
    const held = step($, { agentId: 'agent-1' }) // in flight
    await new Promise(r => setTimeout(r, 5))
    expect((await tool($, { agentId: 'agent-2' })).context).toEqual(['[budget] spent $0.20 of $2.00 | left before the stop $1.40 (70%) | tier HIGH'])
    open()
    await held
  })
})

describe('the account\'s windows are walls under every budget', () => {
  test('a dollar budget larger than the 5-hour window has left: said at the start, and the task runs against the window', { options: { usdPerPoint5h: 1 } }, async ($, on) => {
    const w = world(on, { env: LOG })
    w.readings = [five(90), week(10)]
    await start($)
    const out = await run($, '$10 task')
    expect(out.text).toContain("The account's 5-hour window is at 90%, so less is left in it than the budget: about $8.95 before onbudget stops for it. The task runs against that.")
    let pct = 90
    w.reply = () => { w.readings = [five(++pct), week(10)]; return { cost: 1 } } // a dollar moves the window a point
    const { tiers, lines, refused } = await drive($, w)
    expect(lines[0]).toBe("[budget] spent $1.00 of $10.00 | left before the stop $6.00 (75%), set by the account's 5-hour limit | tier HIGH")
    expect(tiers).toEqual(['HIGH', 'MEDIUM', 'MEDIUM', 'MEDIUM', 'CRITICAL', 'CRITICAL', 'CRITICAL'])
    expect(sentAfterCritical(tiers)).toBe(2)
    expect(refused.answer).toContain("[onbudget] Stopped: the account's 5-hour usage limit is close: the window is at 97% (resets 2026-10-08 22:10 UTC)")
    expect(refused.answer).toContain("so that Claude Code's own limit does not end the session in the middle of a request")
    const stop = rows(w, 'stop')[0]
    expect([stop.event, stop.window, stop.percent]).toEqual(['wall-stop', 'five_hour', 97])
    expect(Math.max(...rows(w, 'step').map(r => r.rateLimits[0].percentUsed))).toBe(97) // the account's limit was never reached
  })
  test('a wall reached during a task: a dollar budget that fitted when it was set', { options: { usdPerPoint5h: 1 } }, async ($, on) => {
    const w = world(on)
    w.readings = [five(50)]
    await start($)
    expect((await run($, '$5 task')).text).not.toContain('less is left')
    const readings = [52, 70, 96, 97] // other sessions on the account use the window meanwhile
    w.reply = () => { w.readings = [five(readings.shift() ?? 98)]; return { cost: 0.5 } }
    const { lines, refused } = await drive($, w)
    expect(lines[0]).toContain('| left before the stop $4.00 (80%) | tier HIGH') // the budget binds
    expect(lines[2]).toContain("set by the account's 5-hour limit")
    expect(refused.answer).toContain("the account's 5-hour usage limit is close: the window is at 98%")
  })
  test('the other window: a 5-hour percentage budget stopped by the weekly limit', async ($, on) => {
    const w = world(on, { env: LOG })
    w.readings = [five(20), week(95)]
    await start($)
    const out = await run($, '5% 5h task')
    expect(out.text).toContain("The account's weekly window is at 95%, so less is left in it than the budget: about 2 points before onbudget stops for it.")
    let wk = 95
    w.reply = () => { w.readings = [five(20), week(++wk)]; return { cost: 0.1 } }
    const { lines, refused } = await drive($, w)
    expect(lines[0]).toBe("[budget] the 5-hour usage window has moved 0 of 5 points | left before the stop 1 point of the weekly window (50%), set by the account's weekly limit | tier CRITICAL")
    expect(lines.length).toBe(2)
    expect(refused.answer).toContain("the account's weekly usage limit is close: the window is at 97%")
  })
  test('without a rate a window is a wall in points: it stops when the reading leaves room for no more requests', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$50 task')
    let pct = 93
    w.reply = () => { w.readings = [five(++pct)]; return { cost: 0.1 } }
    const { tiers, refused } = await drive($, w)
    expect(tiers).toEqual(['HIGH', 'CRITICAL', 'CRITICAL', 'CRITICAL']) // 94 to 97: a lagging request and the next, a point each
    expect(refused.answer).toContain('the window is at 97%')
  })
  test('a window that has nothing left refuses the budget in one line, and nothing is sent', async ($, on) => {
    const w = world(on)
    w.readings = [five(99), week(40)]
    await start($)
    for (const args of ['$3 task', '5h task', '10% week task']) {
      const out = await run($, args)
      expect(out.text).toBe('the 5-hour usage window is at 99% (resets 2026-10-08 22:10 UTC), so nothing is left to run a budget on before it resets. Nothing was sent.')
    }
    await w.clock.advance(5)
    expect(w.prompts.length).toBe(0)
    expect(w.store.has('budget:session-1')).toBe(false)
  })
  test('a new session with no reading yet uses the last one seen on this machine, if its window has not reset', async ($, on) => {
    const w = world(on, { store: { 'seen:five_hour': { percentUsed: 99, resetsAt: R1, at: NOW - 1000 }, 'seen:seven_day': { percentUsed: 99, resetsAt: '2020-01-01T00:00:00.000Z', at: 0 } } })
    await start($)
    expect((await run($, '$3 task')).text).toContain('the 5-hour usage window is at 99%')
    w.store.set('seen:five_hour', { percentUsed: 99, resetsAt: '2020-01-01T00:00:00.000Z', at: 0 }) // that window has since reset
    expect((await run($, '$3 task')).text).toContain('budget $3.00 set')
  })
  test('readings are kept for that: the newest of each window, written when it changes', async ($, on) => {
    const w = world(on)
    await start($)
    w.reply = () => { w.readings = [five(12), week(30)]; return { cost: 0.1 } }
    await step($); await measure($, w); await step($); await measure($, w)
    expect(w.store.get('seen:five_hour')).toEqual({ percentUsed: 12, resetsAt: R1, at: NOW })
    expect((w.store.get('seen:seven_day') as any).percentUsed).toBe(30)
  })
  test('with no window reported (an API key, a gateway) a dollar budget works as before', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$1 task')
    w.reply = () => ({ cost: 0.1 })
    const { lines } = await drive($, w)
    expect(lines[0]).toBe('[budget] spent $0.10 of $1.00 | left before the stop $0.80 (80%) | tier HIGH')
    expect(lines.every(l => !l.includes('account'))).toBe(true)
  })
})

describe('/onbudget 5h and /onbudget week', () => {
  test('5h with a learned rate: what the window has left below 99%, in dollars', async ($, on) => {
    const w = world(on, { env: LOG, store: { [calKey('older-1')]: cal(19.4, 20), [calKey('older-2')]: cal(9.7, 10) } })
    w.readings = [five(40)]
    await start($)
    const out = await run($, '5h task')
    const rate = 29.1 / (30 + 2 * 0.41 * Math.sqrt(2))
    const usd = Math.round(59 * rate * 10000) / 10000
    near(rows(w, 'budget')[0].usd, usd)
    expect(out.text).toContain(`budget $${usd.toFixed(2)} (what the 5-hour usage window had left) set`)
    expect(out.text).toContain('The window is at 40%: 59 points are left below 99%')
    await w.clock.advance(5)
    expect(w.prompts[0].text).toContain(`hard usage budget of $${usd.toFixed(2)} (what the 5-hour usage window had left)`)
    w.reply = () => ({ cost: 1 })
    await step($)
    expect((await tool($)).context[0]).toContain(`[budget] spent $1.00 of $${usd.toFixed(2)} (what the 5-hour usage window had left) | left before the stop`)
  })
  test('week without a rate: the window\'s own points, stopping a little before its wall', async ($, on) => {
    const w = world(on)
    w.readings = [week(30)]
    await start($)
    const out = await run($, 'week task')
    expect(out.text).toContain('budget 69 points of the weekly usage window (what it had left) set')
    expect(out.text).toContain("A weekly budget is counted in the weekly window's own points unless usdPerPointWeek is set")
    w.reply = () => { w.readings = [week(31)]; return { cost: 0.1 } }
    await step($)
    expect((await tool($)).context[0]).toBe('[budget] the weekly usage window has moved 1 of 69 points | left before the stop 66 points of the weekly window (99%) | tier HIGH')
  })
  test('set before the session has a reading: sized from the first one, which comes with the first answer', { options: { usdPerPoint5h: 0.5 } }, async ($, on) => {
    const w = world(on, { env: LOG })
    await start($)
    const out = await run($, '5h task')
    expect(out.text).toContain('budget what the 5-hour usage window has left set')
    expect(out.text).toContain('sized from the first reading')
    w.reply = () => { w.readings = [five(59)]; return { cost: 0.3 } }
    await step($)
    const sized = rows(w, 'sized')[0]
    expect([sized.usd, sized.allowance]).toEqual([20, null]) // 40 points at $0.50, on top of $0 spent before the request
    expect((await tool($)).context[0]).toContain('[budget] spent $0.30 of $20.00 (what the 5-hour usage window had left)')
  })
  test('set where no window is ever reported: refused after three answers without one', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, 'week task')
    w.reply = () => ({ cost: 0.1 })
    const { refused } = await drive($, w)
    expect(w.requests.length).toBe(3)
    expect(refused.answer).toContain('the weekly usage window is not being reported in this session')
  })
  test('a reset during the task frees the wall but does not enlarge the budget (dollars)', { options: { usdPerPoint5h: 1 } }, async ($, on) => {
    const w = world(on)
    w.readings = [five(90)]
    await start($)
    expect((await run($, '5h task')).text).toContain('budget $9.00 (what the 5-hour usage window had left) set')
    const next = [five(92), five(1, R2)]
    w.reply = () => { w.readings = [next.shift()!]; return { cost: 1 } }
    await step($)
    expect((await tool($)).context[0]).toBe('[budget] spent $1.00 of $9.00 (what the 5-hour usage window had left) | left before the stop $5.00 (71%) | tier HIGH')
    await step($) // the window reset: the account's limit is far away again, the budget is what it was
    expect((await tool($)).context[0]).toBe('[budget] spent $2.00 of $9.00 (what the 5-hour usage window had left) | left before the stop $6.00 (67%) | tier MEDIUM')
  })
  test('a reset during the task: in points, the movement before and after it both count', async ($, on) => {
    const w = world(on)
    w.readings = [five(90)]
    await start($)
    await run($, '5h task')
    const next = [five(92), five(1, R2)]
    w.reply = () => { w.readings = [next.shift()!]; return { cost: 0.1 } }
    await step($); await step($)
    expect((await tool($)).context[0]).toBe('[budget] the 5-hour usage window has moved 3 of 9 points | left before the stop 6 points (67%) | tier MEDIUM')
  })
})

describe('when Claude ends the task', () => {
  const ends = (text: string) => () => ({ cost: 0.1, text })
  test('in a terminal session, a line from the plugin: the spend, how it ended, and that the budget is still open', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/work', surface: null, isInteractive: true })
    await run($, '$1 task')
    w.reply = ends('All done.\nSTATUS: COMPLETE')
    await step($)
    expect(w.logs).toContain('onbudget: Claude ended the task with STATUS: COMPLETE, at $0.10 of $1.00. The budget is still open: a follow-up prompt draws on it, and /onbudget off removes it.')
    expect((await prompt($, 'one more thing')).context[0]).toContain('The budget set earlier for this task still applies')
  })
  test('not in a headless run, and not for a subagent or an answer without the line', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$1 task')
    w.reply = ends('STATUS: COMPLETE')
    await step($)
    expect(w.logs.length).toBe(0)
  })
})
