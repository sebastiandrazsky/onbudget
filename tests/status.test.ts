// The status line under the prompt. Claude Code shows 63 characters of a mod's status text and cuts the rest, so every
// state must fit in STATUS_MAX (60) with its most important fields: the tier, what is left before the stop in its unit,
// the budget, and the account limit when one binds. The model never sees this line; tests/e2e/modeltext.py shows that.
import { describe, test, expect } from 'claude-code/testing'
import { type Budget, type Stop, type Wall, type WindowKind, STATUS_MAX, binding, cash, endText, statusLine } from '../hooks/core.ts'
import { world, step, start, run, LOG, rows } from './world.ts'

const budget = (over: Partial<Budget>): Budget => ({
  v: 1, raw: '$1', spec: { kind: 'usd', usd: 1 }, task: 'task', usd: 1, rate: null, spent: 0, ledger: 0, maxStep: 0, steps: 0, refused: 0,
  state: 'active', effortCap: 'medium', remind: false, startedAt: 0, ...over,
})
const wall = (last: number, over: Partial<Wall> = {}): Wall => ({ last, first: last, at: 0, rate: null, stepPts: 1, moved: 0, ...over })
const SHORT: Record<WindowKind, string> = { five_hour: '5h', seven_day: 'week' }
const pts = (n: number) => { const t = String(Math.round(n * 10) / 10); return `${t} pt${t === '1' ? '' : 's'}` }

/** Every budget form, at a size: a dollar budget, a percentage converted or in points, 5h/week in dollars, in points, not sized. */
function forms(usd: number, points: number, kind: WindowKind): Budget[] {
  const win = { kind, last: 20, moved: 0, blind: 0 }
  const rate = { usdPerPoint: usd / points, points: 30, intervals: 3, source: 'learned' as const }
  return [
    budget({ raw: `$${usd}`, spec: { kind: 'usd', usd }, usd }),
    budget({ raw: `${points}% ${SHORT[kind]}`, spec: { kind: 'pct', window: kind, points }, usd, rate, window: { ...win } }),
    budget({ raw: `${points}% ${SHORT[kind]}`, spec: { kind: 'pct', window: kind, points }, usd: null, window: { ...win } }),
    budget({ raw: SHORT[kind], spec: { kind: 'rest', window: kind }, usd, rate, window: { ...win } }),
    budget({ raw: SHORT[kind], spec: { kind: 'rest', window: kind }, usd: null, allowance: points, window: { ...win } }),
    budget({ raw: SHORT[kind], spec: { kind: 'rest', window: kind }, usd: null, pending: true, window: { ...win, last: null } }),
  ]
}

/** The account's windows as walls: none, one without a rate, one with a rate, both, at a given reading. */
function wallSets(at: number, rate: number): Partial<Record<WindowKind, Wall>>[] {
  return [
    {},
    { five_hour: wall(at) },
    { five_hour: wall(at, { first: Math.max(0, at - 20), stepPts: 4 }) },
    { five_hour: wall(at, { rate }) },
    { seven_day: wall(at) },
    { five_hour: wall(at, { rate }), seven_day: wall(Math.min(97, at + 3), { rate: rate * 3 }) },
  ]
}

const STOPS: Stop[] = [
  { event: 'reserve-stop', spent: 1, reserve: 0.1, budget: 1, inFlight: 0 },
  { event: 'window-stop', moved: 100, points: 100, calibrated: false },
  { event: 'window-stop', moved: 201, points: 100, calibrated: true },
  { event: 'wall-stop', window: 'five_hour', percent: 97, inFlight: 0 },
  { event: 'wall-stop', window: 'seven_day', percent: 97, inFlight: 2 },
  { event: 'window-full' },
  { event: 'no-reading' },
]

/** The fields an active line must hold, checked against the binding limit the meter and the stop use. */
function checkActive(b: Budget, inFlight: number): string[] {
  const line = statusLine(b, inFlight)
  const bad: string[] = []
  if (line.length > STATUS_MAX) bad.push(`${line.length} characters`)
  if (line.includes('…')) bad.push('cut')
  const m = binding(b, inFlight)
  const inPoints = b.usd === null
  if (!m) {
    if (!line.startsWith('no reading yet · budget ')) bad.push('no reading yet, then the budget')
  } else {
    if (!line.startsWith(`tier ${m.tier} · `) && !line.startsWith(`${m.tier} · `)) bad.push(`tier ${m.tier} first`)
    const room = Math.max(0, m.room)
    const w = m.by === 'budget' ? undefined : b.walls?.[m.by]
    const amount = m.unit !== 'usd' ? pts(room) : inPoints && w?.rate ? pts(Math.floor((room / w.rate) * 10) / 10) : cash(room)
    if (!line.includes(` · ${amount} left`)) bad.push(`${amount} left`)
    if (inPoints && / · \$\S* left/.test(line)) bad.push('dollars under a budget in points')
    const own = m.by === 'budget' || (b.spec.kind === 'rest' && b.spec.window === m.by)
    if (!own && !line.includes(` left (${SHORT[m.by as WindowKind]} limit)`)) bad.push(`(${SHORT[m.by as WindowKind]} limit)`)
    if (own && line.includes(' limit)')) bad.push('a limit named that does not bind')
  }
  if (!line.includes(' · budget ')) bad.push('the budget')
  const s = b.spec
  const figure = s.kind === 'usd' ? cash(s.usd) : s.kind === 'pct' ? (b.usd === null ? `${pts(s.points)} (${SHORT[s.window]})` : `${s.points}% ${SHORT[s.window]}`) : SHORT[s.window]
  if (!line.includes(figure)) bad.push(`budget figure ${figure}`)
  return bad.length ? [`${JSON.stringify(line)}: ${bad.join(', ')} (${b.raw}, inFlight ${inFlight})`] : []
}

function checkStopped(b: Budget): string[] {
  const line = statusLine(b, 0)
  const bad: string[] = []
  if (line.length > STATUS_MAX) bad.push(`${line.length} characters`)
  if (line.includes('…')) bad.push('cut')
  if (!line.startsWith('STOPPED')) bad.push('STOPPED first')
  if (!line.endsWith(' · /onbudget off')) bad.push('/onbudget off')
  const inPoints = b.usd === null && (b.spec.kind === 'pct' || b.allowance !== undefined)
  const spend = inPoints ? `${Math.round(b.window!.moved * 10) / 10} of ` : `${cash(b.spent)} of `
  if (!line.includes(` · ${spend}`)) bad.push(spend)
  return bad.length ? [`${JSON.stringify(line)}: ${bad.join(', ')} (${b.raw}, ${b.stop?.event})`] : []
}

describe('the status line fits and keeps its fields', () => {
  test('every budget form, wall, spend and size, in flight or not, and every stop event', () => {
    const bad: string[] = []
    let n = 0
    const sizes: [number, number][] = [[0.6, 3], [3, 10], [500, 50], [12_345.67, 99.5], [999_999.99, 100], [10_000_000, 100], [1e15, 100]]
    for (const [usd, points] of sizes) {
      for (const kind of ['five_hour', 'seven_day'] as WindowKind[]) {
        for (const walls of wallSets(60, usd / 40)) {
          for (const f of [0, 0.1, 0.5, 0.92, 1, 1.4]) {
            for (const b of forms(usd, points, kind)) {
              Object.assign(b, { walls: JSON.parse(JSON.stringify(walls)), spent: usd * f, maxStep: usd * 0.04 })
              if (b.window) b.window.moved = Math.round(points * f * 10) / 10
              for (const inFlight of [0, 2]) { bad.push(...checkActive(b, inFlight)); n++ }
              for (const stop of STOPS) { bad.push(...checkStopped({ ...b, state: 'stopped', stop })); n++ }
            }
          }
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([])
    expect(n > 10_000).toBe(true)
  })
  test('walls at every reading, with and without requests in flight', () => {
    const bad: string[] = []
    for (let at = 0; at <= 98; at += 7) {
      for (const b of forms(25, 30, 'seven_day')) {
        b.walls = { five_hour: wall(at, { first: Math.max(0, at - 9), stepPts: 3, moved: 9 }), seven_day: wall(Math.min(98, at + 1)) }
        for (const inFlight of [0, 1, 5]) bad.push(...checkActive(b, inFlight))
      }
    }
    expect(bad).toEqual([])
  })
})

describe('the status line, state by state', () => {
  test('a dollar budget: tier, what is left, the budget', () => {
    expect(statusLine(budget({ raw: '$0.60', spec: { kind: 'usd', usd: 0.6 }, usd: 0.6, spent: 0.09, maxStep: 0.07 }))).toBe('tier HIGH · $0.44 left · budget $0.60')
    expect(statusLine(budget({ raw: '$3', spec: { kind: 'usd', usd: 3 }, usd: 3, spent: 2.6, maxStep: 0.2 }))).toBe('tier CRITICAL · $0.20 left · budget $3.00')
  })
  test('the 5-hour limit binding a large dollar budget, with and without a rate', () => {
    const big = { raw: '$500', spec: { kind: 'usd' as const, usd: 500 }, usd: 500, spent: 0.02, maxStep: 0.02 }
    expect(statusLine(budget({ ...big, walls: { five_hour: wall(91.8, { rate: 8.5 }) } }))).toBe('tier HIGH · $61.16 left (5h limit) · budget $500.00')
    expect(statusLine(budget({ ...big, walls: { five_hour: wall(95, { first: 80, stepPts: 2 }) } }))).toBe('tier CRITICAL · 0 pts left (5h limit) · budget $500.00')
  })
  test('large figures stay whole', () => {
    expect(statusLine(budget({ raw: '$12345.67', spec: { kind: 'usd', usd: 12_345.67 }, usd: 12_345.67, spent: 1_000, maxStep: 2 }))).toBe('tier HIGH · $11344 left · budget $12346')
    expect(statusLine(budget({ raw: '$5000000', spec: { kind: 'usd', usd: 5e6 }, usd: 5e6, spent: 4.9e6, maxStep: 2 }))).toBe('tier CRITICAL · $99998 left · budget $5M')
  })
  test('a percentage budget: in dollars when converted, in points when not', () => {
    const rate = { usdPerPoint: 0.8, points: 12, intervals: 2, source: 'learned' as const }
    const win = { kind: 'five_hour' as const, last: 20, moved: 1, blind: 0 }
    expect(statusLine(budget({ raw: '3% 5h', spec: { kind: 'pct', window: 'five_hour', points: 3 }, usd: 2.4, rate, spent: 0.5, maxStep: 0.1, window: win }))).toBe('tier HIGH · $1.80 left · budget $2.40 (3% 5h)')
    expect(statusLine(budget({ raw: '3% 5h', spec: { kind: 'pct', window: 'five_hour', points: 3 }, usd: null, window: win }))).toBe('tier CRITICAL · 2 pts left · budget 3 pts (5h)')
    expect(statusLine(budget({ raw: '100% week', spec: { kind: 'pct', window: 'seven_day', points: 100 }, usd: null, window: { ...win, kind: 'seven_day', moved: 0 } }))).toBe('tier HIGH · 100 pts left · budget 100 pts (week)')
  })
  test('5h and week: in dollars, in points, and before they are sized', () => {
    const rate = { usdPerPoint: 0.82, points: 30, intervals: 4, source: 'learned' as const }
    expect(statusLine(budget({ raw: '5h', spec: { kind: 'rest', window: 'five_hour' }, usd: 63.61, rate, spent: 0.05, maxStep: 0.05, window: { kind: 'five_hour', last: 21, moved: 0, blind: 0 } })))
      .toBe('tier HIGH · $63.51 left · budget $63.61 (5h)')
    const week = budget({ raw: 'week', spec: { kind: 'rest', window: 'seven_day' }, usd: null, allowance: 81, window: { kind: 'seven_day', last: 18, moved: 0, blind: 0 }, walls: { seven_day: wall(18) } })
    expect(statusLine(week)).toBe('tier HIGH · 79 pts left · budget 81 pts (week)')
    // A 5-hour limit with a learned rate binding a budget in points: shown in its window's points, not dollars.
    expect(statusLine({ ...week, spent: 0.3, maxStep: 0.3, walls: { seven_day: wall(18), five_hour: wall(96, { rate: 0.9 }) } })).toBe('tier HIGH · 2.3 pts left (5h limit) · budget 81 pts (week)')
    // The worst case in points: the shortest form, which still has every field.
    const tight = budget({ raw: '100% 5h', spec: { kind: 'pct', window: 'five_hour', points: 100 }, usd: null, window: { kind: 'five_hour', last: 0, moved: 99.5, blind: 0 }, walls: { seven_day: wall(0, { stepPts: 0.25 }) } })
    expect(statusLine(tight)).toBe('tier CRITICAL · 0.5 pts left · budget 100 pts (5h)')
    expect(statusLine({ ...tight, window: { kind: 'five_hour', last: 0, moved: 0, blind: 0 }, walls: { seven_day: wall(96.5, { first: 0, stepPts: 0.5 }) } })).toBe('CRITICAL · 1.5 pts left (week limit) · budget 100 pts (5h)')
    const pending = budget({ raw: 'week', spec: { kind: 'rest', window: 'seven_day' }, usd: null, pending: true, window: { kind: 'seven_day', last: null, moved: 0, blind: 0 } })
    expect(statusLine(pending)).toBe('no reading yet · budget week (not sized yet)')
    expect(statusLine({ ...pending, walls: { five_hour: wall(40) } })).toBe('tier HIGH · 57 pts left (5h limit) · budget week')
  })
  test('stopped: that it stopped, the spend against the budget, how to go on', () => {
    const usd = budget({ raw: '$0.12', spec: { kind: 'usd', usd: 0.12 }, usd: 0.12, spent: 0.07, state: 'stopped', stop: STOPS[0] })
    expect(statusLine(usd)).toBe('STOPPED · $0.07 of $0.12 · /onbudget off')
    expect(statusLine({ ...usd, raw: '$500', spec: { kind: 'usd', usd: 500 }, usd: 500, stop: STOPS[3] })).toBe('STOPPED (5h limit) · $0.07 of $500.00 · /onbudget off')
    const week = budget({ raw: 'week', spec: { kind: 'rest', window: 'seven_day' }, usd: null, allowance: 81, window: { kind: 'seven_day', last: 97, moved: 79, blind: 0 }, state: 'stopped', stop: STOPS[4] })
    expect(statusLine(week)).toBe('STOPPED · 79 of 81 pts (week) · /onbudget off')
    expect(statusLine({ ...week, stop: STOPS[3] })).toBe('STOPPED (5h limit) · 79 of 81 pts (week) · /onbudget off')
    const pct = budget({ raw: '3% 5h', spec: { kind: 'pct', window: 'five_hour', points: 3 }, usd: 2.4, spent: 0.6, window: { kind: 'five_hour', last: 30, moved: 7, blind: 0 }, state: 'stopped', stop: { event: 'window-stop', moved: 7, points: 3, calibrated: true } })
    expect(statusLine(pct)).toBe('STOPPED (5h moved 7 pts) · $0.60 of 3% 5h · /onbudget off')
    const blind = budget({ raw: 'week', spec: { kind: 'rest', window: 'seven_day' }, usd: null, pending: true, spent: 0.02, window: { kind: 'seven_day', last: null, moved: 0, blind: 3 }, state: 'stopped', stop: STOPS[6] })
    expect(statusLine(blind)).toBe('STOPPED (no reading) · $0.02 of week · /onbudget off')
  })
})

describe('the end-of-task line', () => {
  test('under a budget counted in points: the points moved against those budgeted, and the spend apart', () => {
    const b = budget({ raw: 'week', spec: { kind: 'rest', window: 'seven_day' }, usd: null, allowance: 81, spent: 0.16, window: { kind: 'seven_day', last: 19, moved: 1, blind: 0 },
      walls: { five_hour: wall(30, { moved: 2 }), seven_day: wall(19, { moved: 1 }) } })
    expect(endText(b, 'COMPLETE')).toBe('onbudget: Claude ended the task with STATUS: COMPLETE: the weekly window moved 1 of the 81 points budgeted, the 5-hour window moved 2 points (whole points, whole account); the task\'s own spend was $0.16. The budget is still open: a follow-up prompt draws on it, and /onbudget off removes it.')
    const pct = budget({ raw: '3% 5h', spec: { kind: 'pct', window: 'five_hour', points: 3 }, usd: null, spent: 0.4, window: { kind: 'five_hour', last: 22, moved: 2, blind: 0 } })
    expect(endText(pct, 'INCOMPLETE')).toBe('onbudget: Claude ended the task with STATUS: INCOMPLETE: the 5-hour window moved 2 of the 3 points budgeted (whole points, whole account); the task\'s own spend was $0.40. The budget is still open: a follow-up prompt draws on it, and /onbudget off removes it.')
  })
  test('in a terminal session, once, with one prefix: the engine adds the plugin\'s name', async ($, on) => {
    const w = world(on, { env: LOG })
    w.readings = [{ kind: 'five_hour', percentUsed: 30, resetsAt: '2030-01-01T00:00:00.000Z' }, { kind: 'seven_day', percentUsed: 18, resetsAt: '2030-01-08T00:00:00.000Z' }]
    await $.session.start({ cwd: '/work', surface: null, isInteractive: true })
    expect((await run($, 'week a task')).text).toContain('budget 81 points of the weekly usage window (what it had left) set')
    await w.clock.advance(5)
    w.reply = () => ({ cost: 0.16, text: 'Done.\nSTATUS: COMPLETE' })
    w.readings = [{ kind: 'five_hour', percentUsed: 32, resetsAt: '2030-01-01T00:00:00.000Z' }, { kind: 'seven_day', percentUsed: 19, resetsAt: '2030-01-08T00:00:00.000Z' }]
    await step($)
    expect(w.logs).toEqual(['Claude ended the task with STATUS: COMPLETE: the weekly window moved 1 of the 81 points budgeted, the 5-hour window moved 0 points (whole points, whole account); the task\'s own spend was $0.16. The budget is still open: a follow-up prompt draws on it, and /onbudget off removes it.'])
    expect(w.status[w.status.length - 1]).toBe('tier HIGH · 65 pts left (5h limit) · budget 81 pts (week)')
    expect(rows(w, 'hookfail')).toEqual([])
  })
})
