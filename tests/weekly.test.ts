// Weekly budgets: `week` and `N% week` count the weekly window's own points unless usdPerPointWeek is set, because the
// rate learned for that window errs far low (README, "Window readings"). Other budgets keep the learned rate for the
// weekly limit.
import { describe, test, expect } from 'claude-code/testing'
import { world, step, start, run, tool, rows, LOG } from './world.ts'

const NOW = 1_700_000_000_000
const DAY = Math.floor(NOW / 86_400_000)
const five = (percentUsed: number) => ({ kind: 'five_hour', percentUsed, resetsAt: '2026-10-08T22:10:00.000Z' })
const week = (percentUsed: number) => ({ kind: 'seven_day', percentUsed, resetsAt: '2026-10-12T00:00:00.000Z' })
const wcal = (usd: number, points: number) => ({ kind: 'seven_day', model: 'claude-opus-5-5', usd, points, segments: 1, at: NOW - 1000 })
const wcalKey = (session: string) => `cal:seven_day:${DAY}:${session}:claude-opus-5-5`
// A learned weekly rate: $20 over 6 points in two sessions, about $2.79 a point after the widening for rounding.
const LEARNED = { [wcalKey('older-1')]: wcal(10, 3), [wcalKey('older-2')]: wcal(10, 3) }
const tierOf = (line: string) => /tier (\w+)/.exec(line)?.[1]

/** Sends requests one at a time, each followed by a tool result, until one is refused: the tier each meter line read. */
async function drive($: any, w: any, n = 60): Promise<{ tiers: string[]; lines: string[]; refused: any }> {
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

/** Replies that move the weekly reading one point every third request, as small requests do. */
function everyThird(w: any, from: number) {
  let k = 0
  w.reply = () => { k += 1; w.readings = [five(10), week(from + Math.floor(k / 3))]; return { cost: 0.5 } }
}

describe('weekly budgets', () => {
  test('N% week with a learned weekly rate: counted in the window\'s own points, not converted, and stopped at N points', async ($, on) => {
    const w = world(on, { env: LOG, store: LEARNED })
    w.readings = [five(10), week(30)]
    await start($)
    const out = await run($, '5% week task')
    expect(out.text).toContain('budget 5% of the weekly usage window set')
    expect(out.text).toContain("A weekly budget is counted in the weekly window's own points unless usdPerPointWeek is set")
    expect(rows(w, 'budget')[0].usd).toBe(null)
    everyThird(w, 30)
    const { tiers, lines, refused } = await drive($, w)
    expect(lines[0]).toBe('[budget] the weekly usage window has moved 0 of 5 points | left before the stop 5 points (100%) | tier HIGH')
    expect(lines.at(-1)).toBe('[budget] the weekly usage window has moved 5 of 5 points | left before the stop 0 points (0%) | tier CRITICAL')
    expect(tiers.length).toBe(15) // five points at one point per three requests
    expect(tiers.indexOf('CRITICAL')).toBe(8) // two points left: read for the last seven requests
    expect(refused.answer).toContain('[onbudget]')
  })
  test('week with a learned weekly rate: what the window has left, in points, stopping about two points before 99%', async ($, on) => {
    const w = world(on, { env: LOG, store: LEARNED })
    w.readings = [five(10), week(90)]
    await start($)
    const out = await run($, 'week task')
    expect(out.text).toContain('budget 9 points of the weekly usage window (what it had left) set')
    expect(out.text).toContain('9 points are left below 99%, and it stops about two points before that, at 97%')
    const b = rows(w, 'budget')[0]
    expect([b.usd, b.allowance]).toEqual([null, 9])
    everyThird(w, 90)
    const { lines, refused } = await drive($, w)
    expect(lines[0]).toBe('[budget] the weekly usage window has moved 0 of 9 points | left before the stop 7 points of the weekly window (100%) | tier HIGH')
    expect(refused.answer).toContain('the window is at 97%')
  })
  test('with usdPerPointWeek set, weekly budgets are in dollars at that rate', { options: { usdPerPointWeek: 10 } }, async ($, on) => {
    const w = world(on, { env: LOG, store: LEARNED })
    w.readings = [five(10), week(90)]
    await start($)
    const pct = await run($, '5% week task')
    expect(pct.text).toContain('budget $50.00 (5% of the weekly usage window) set')
    expect(pct.text).toContain('Converted at 1 point ≈ $10.00 (your setting)')
    await run($, 'off')
    const rest = await run($, 'week task')
    expect(rest.text).toContain('budget $90.00 (what the weekly usage window had left) set')
  })
  test('1% and 2% week are refused: in points the smallest weekly budget is 3%', async ($, on) => {
    const w = world(on, { store: LEARNED })
    w.readings = [five(10), week(30)]
    await start($)
    for (const raw of ['1% week', '2% week']) {
      const out = await run($, `${raw} task`)
      expect(out.text).toContain(`cannot enforce ${raw}. Weekly budgets are counted in the weekly window's own whole points unless usdPerPointWeek is set, so the smallest is 3%`)
    }
    expect(w.requests.length).toBe(0)
  })
  test('a week budget set before the first reading is sized in points from it, even with a learned rate', async ($, on) => {
    const w = world(on, { env: LOG, store: LEARNED })
    await start($)
    const out = await run($, 'week task')
    expect(out.text).toContain('budget what the weekly usage window has left set')
    w.reply = () => { w.readings = [five(10), week(50)]; return { cost: 0.3 } }
    await step($)
    const sized = rows(w, 'sized')[0]
    expect([sized.usd, sized.allowance]).toEqual([null, 49])
  })
  test('a dollar budget keeps the learned weekly rate for the weekly limit, as before', async ($, on) => {
    const w = world(on, { env: LOG, store: LEARNED })
    w.readings = [five(10), week(98)]
    await start($)
    const out = await run($, '$5 task')
    expect(out.text).toContain("The account's weekly window is at 98%, so less is left in it than the budget: about $2.")
  })
  test('the status says the learned weekly rate is not used by weekly budgets', async ($, on) => {
    const w = world(on, { store: LEARNED })
    w.readings = [five(10), week(30)]
    await start($)
    const out = await run($, '')
    expect(out.text).toContain('calibration, weekly window: 1 point ≈ $2.79 (6 points observed in 2 sessions; used only for the weekly limit under other budgets')
  })
})
