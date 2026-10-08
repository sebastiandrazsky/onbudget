import { describe, test, expect } from 'claude-code/testing'
import {
  type Budget, type CalRecord, BOOTSTRAP_RESERVE_USD, CAL_MAX_AGE_MS, NAME,
  cappedEffort, extendCalibration, fold, meterLine, observeWindow, parseCommand, poolRate, protocol, refusalText, remaining, stopCheck, tierOf,
} from '../hooks/core.ts'

const near = (got: number, want: number) => expect(Math.abs(got - want) < 1e-9 ? 'near' : `${got} is not ${want}`).toBe('near')
const usd = (over: Partial<Budget> = {}): Budget => ({
  v: 1, raw: '$4', spec: { kind: 'usd', usd: 4 }, task: 't', usd: 4, rate: null, spent: 0, ledger: 0, maxStep: 0, steps: 0, refused: 0,
  state: 'active', effortCap: 'medium', remind: false, startedAt: 0, ...over,
})
const pct = (points: number, over: Partial<Budget> = {}): Budget =>
  usd({ raw: `${points}% 5h`, spec: { kind: 'pct', window: 'five_hour', points }, usd: null, window: { kind: 'five_hour', last: null, moved: 0, blind: 0 }, ...over })

describe('the command', () => {
  test('the name the engine registers is the one core uses', () => { expect(NAME).toBe('onbudget') })
  test('nothing is the status, off is off', () => {
    expect(parseCommand('  ')).toEqual({ kind: 'status' })
    expect(parseCommand(' OFF ')).toEqual({ kind: 'off' })
  })
  test('every budget form', () => {
    expect(parseCommand('$3 Implement authentication')).toEqual({ kind: 'start', raw: '$3', spec: { kind: 'usd', usd: 3 }, task: 'Implement authentication' })
    expect(parseCommand('$0.50 x')).toEqual({ kind: 'start', raw: '$0.50', spec: { kind: 'usd', usd: 0.5 }, task: 'x' })
    expect(parseCommand('10% 5h Build this application')).toEqual({ kind: 'start', raw: '10% 5h', spec: { kind: 'pct', window: 'five_hour', points: 10 }, task: 'Build this application' })
    expect(parseCommand('5% week Fix these bugs')).toEqual({ kind: 'start', raw: '5% week', spec: { kind: 'pct', window: 'seven_day', points: 5 }, task: 'Fix these bugs' })
    expect(parseCommand('2.5%5H  two\nlines')).toEqual({ kind: 'start', raw: '2.5% 5h', spec: { kind: 'pct', window: 'five_hour', points: 2.5 }, task: 'two\nlines' })
  })
  test('what is not a budget is refused with the usage', () => {
    for (const bad of ['banana split', '$0 x', '0% 5h x', '150% week x', '10% 4h x', '10% x', '3 dollars x', '$3', '10% 5h', '$3x do it', '-$3 x']) {
      const c = parseCommand(bad)
      expect(c.kind).toBe('error')
    }
  })
})

describe('the meter', () => {
  test('tiers at their edges', () => {
    expect([1, 0.7, 0.6999, 0.3, 0.2999, 0.1, 0.0999, 0].map(tierOf)).toEqual(['HIGH', 'HIGH', 'MEDIUM', 'MEDIUM', 'LOW', 'LOW', 'CRITICAL', 'CRITICAL'])
  })
  test('a dollar budget reads in dollars', () => {
    expect(meterLine(usd({ spent: 1.234 }))).toBe('[budget] spent $1.23 of $4.00 | remaining 69% | tier MEDIUM')
    expect(meterLine(usd({ spent: 9 }))).toBe('[budget] spent $9.00 of $4.00 | remaining 0% | tier CRITICAL')
  })
  test('a converted percentage budget reads in dollars and names the share', () => {
    expect(meterLine(pct(4, { usd: 3.2, spent: 0.8 }))).toBe('[budget] spent $0.80 of $3.20 (4% of the 5-hour usage window) | remaining 75% | tier HIGH')
  })
  test('an unconverted percentage budget reads in points', () => {
    expect(meterLine(pct(5, { window: { kind: 'five_hour', last: 40, moved: 2, blind: 0 } }))).toBe('[budget] the 5-hour usage window has moved 2 of 5 points | remaining 60% | tier MEDIUM')
  })
  test('the protocol states the budget, demands verification and the status line', () => {
    const p = protocol('$4.20')
    expect(p).toContain('hard usage budget of $4.20')
    expect(p).toContain('Verifying the result is part of the task')
    expect(p).toContain('STATUS: COMPLETE or STATUS: INCOMPLETE')
  })
})

describe('the ledger', () => {
  test('growth is spend, a repeat is nothing', () => {
    const b = usd({ ledger: 1 })
    near(fold(b, 1.25), 0.25)
    expect(fold(b, 1.25)).toBe(0)
    near(b.spent, 0.25)
  })
  test('a ledger that starts over is counted on from where it restarts', () => {
    const b = usd({ ledger: 5, spent: 1 })
    expect(fold(b, 0)).toBe(0)
    near(fold(b, 0.4), 0.4)
    near(b.spent, 1.4)
  })
})

describe('the stop', () => {
  test('before any request is priced the bootstrap reserve is held back', () => {
    expect(stopCheck(usd({ usd: 1, spent: 0 }), 0)).toBeNull()
    expect(stopCheck(usd({ usd: 1, spent: 1 - BOOTSTRAP_RESERVE_USD }), 0)?.event).toBe('reserve-stop')
  })
  test('the dearest request seen is held back', () => {
    expect(stopCheck(usd({ spent: 3.69, maxStep: 0.3 }), 0)).toBeNull()
    expect(stopCheck(usd({ spent: 3.7, maxStep: 0.3 }), 0)).toEqual({ event: 'reserve-stop', spent: 3.7, reserve: 0.3, budget: 4 })
  })
  test('each request already in flight holds back a reserve of its own', () => {
    const b = usd({ spent: 3.3, maxStep: 0.3 })
    expect(stopCheck(b, 0)).toBeNull()
    expect(stopCheck(b, 1)).toBeNull()
    expect(stopCheck(b, 2)?.event).toBe('reserve-stop') // 3.3 + 3 x 0.3 = 4.2
  })
  test('once stopped it stays stopped', () => {
    const stop = { event: 'reserve-stop', spent: 3.9, reserve: 0.3, budget: 4 } as const
    expect(stopCheck(usd({ state: 'stopped', stop, spent: 0 }), 0)).toEqual(stop)
    expect(stopCheck(usd({ state: 'stopped', spent: 0 }), 0)?.event).toBe('reserve-stop')
  })
  test('an unconverted percentage budget stops when the window has moved that far', () => {
    expect(stopCheck(pct(5, { window: { kind: 'five_hour', last: 44, moved: 4, blind: 0 } }), 0)).toBeNull()
    expect(stopCheck(pct(5, { window: { kind: 'five_hour', last: 45, moved: 5, blind: 0 } }), 0)).toEqual({ event: 'window-stop', moved: 5, points: 5, calibrated: false })
  })
  test('a converted one stops on dollars; the reading only trips past twice the budget', () => {
    const b = pct(4, { usd: 3.2, maxStep: 0.2, spent: 1, window: { kind: 'five_hour', last: 48, moved: 8, blind: 0 } })
    expect(stopCheck(b, 0)).toBeNull()
    b.window!.moved = 9
    expect(stopCheck(b, 0)).toEqual({ event: 'window-stop', moved: 9, points: 4, calibrated: true })
    expect(stopCheck(pct(4, { usd: 3.2, maxStep: 0.2, spent: 3.0, window: { kind: 'five_hour', last: 42, moved: 2, blind: 0 } }), 0)?.event).toBe('reserve-stop')
  })
  test('no reading after two answered requests: the percentage budget cannot be enforced', () => {
    const b = pct(5)
    observeWindow(b, [])
    expect(stopCheck(b, 0)).toBeNull()
    observeWindow(b, [{ kind: 'seven_day', percentUsed: 3 }])
    expect(stopCheck(b, 0)).toEqual({ event: 'no-reading' })
    observeWindow(b, [{ kind: 'five_hour', percentUsed: 3 }])
    expect(stopCheck(b, 0)).toBeNull()
    const converted = pct(5, { usd: 4 })
    observeWindow(converted, []); observeWindow(converted, []); observeWindow(converted, [])
    expect(stopCheck(converted, 0)).toBeNull() // converted: dollars need no reading
  })
  test('the notice says who is speaking and that the work is unverified', () => {
    const b = usd({ spent: 3.9, maxStep: 0.3 })
    const text = refusalText(b, stopCheck(b, 0)!, false)
    expect(text).toContain('[onbudget] Stopped: $3.90 of $4.00 is used')
    expect(text).toContain('not from Claude')
    expect(text).toContain('/onbudget off')
    expect(refusalText(b, stopCheck(b, 0)!, true)).toContain('This subagent was stopped')
  })
})

describe('the window', () => {
  test('the first reading under the budget is the baseline; movement counts from it', () => {
    const b = pct(5)
    observeWindow(b, [{ kind: 'seven_day', percentUsed: 80 }, { kind: 'five_hour', percentUsed: 40 }])
    expect(b.window).toEqual({ kind: 'five_hour', last: 40, moved: 0, blind: 0 })
    observeWindow(b, [{ kind: 'five_hour', percentUsed: 42 }])
    observeWindow(b, [{ kind: 'five_hour', percentUsed: 42 }])
    observeWindow(b, [])
    expect(b.window).toEqual({ kind: 'five_hour', last: 42, moved: 2, blind: 0 })
  })
  test('a reset is counted from zero', () => {
    const b = pct(5, { window: { kind: 'five_hour', last: 98, moved: 2, blind: 0 } })
    observeWindow(b, [{ kind: 'five_hour', percentUsed: 1 }])
    expect(b.window).toEqual({ kind: 'five_hour', last: 1, moved: 3, blind: 0 })
  })
  test('remaining follows whichever unit the budget is enforced in', () => {
    near(remaining(pct(5, { window: { kind: 'five_hour', last: 44, moved: 4, blind: 0 } })), 0.2)
    near(remaining(pct(5, { usd: 4, spent: 1, window: { kind: 'five_hour', last: 44, moved: 4, blind: 0 } })), 0.75)
  })
})

describe('calibration', () => {
  const rec = (over: Partial<CalRecord> = {}): CalRecord => ({ kind: 'five_hour', model: 'm', usd: 0, points: 0, at: 1000, ...over })
  test('a span between two readings adds its dollars and its points', () => {
    const r = rec()
    let mark = extendCalibration(r, null, 10, 1.0)
    mark = extendCalibration(r, mark, 12, 3.0)
    mark = extendCalibration(r, mark, 12, 3.5)
    expect(r).toEqual(rec({ usd: 2.5, points: 2 }))
    expect(mark).toEqual({ percent: 12, ledger: 3.5 })
  })
  test('a reset, a ledger that started over, and a window at its wall are left out', () => {
    const r = rec()
    let mark = extendCalibration(r, null, 97, 10)
    mark = extendCalibration(r, mark, 2, 11) // reset
    mark = extendCalibration(r, mark, 3, 0.2) // ledger started over
    mark = extendCalibration(r, mark, 99, 50) // at the wall
    mark = extendCalibration(r, mark, 100, 60)
    expect(r).toEqual(rec())
    expect(mark).toEqual({ percent: 100, ledger: 60 })
  })
  test('the pooled rate is total dollars over total points, widened for rounding, so it errs low', () => {
    const records = [rec({ usd: 4.85, points: 5 }), rec({ usd: 3.88, points: 4 }), rec({ usd: 0.5, points: 0 })]
    const rate = poolRate(records, 'five_hour', 'm', 2000)!
    expect(rate.points).toBe(9)
    expect(rate.intervals).toBe(3)
    near(rate.usdPerPoint, 9.23 / (9 + 2 * 0.41 * Math.sqrt(3)))
    expect(rate.usdPerPoint).toBeLessThan(9.23 / 9)
  })
  test('too little movement, another model, another window or old records give no rate', () => {
    expect(poolRate([rec({ usd: 2, points: 2 })], 'five_hour', 'm', 2000)).toBeNull()
    expect(poolRate([rec({ usd: 9, points: 9 })], 'five_hour', 'other', 2000)).toBeNull()
    expect(poolRate([rec({ usd: 9, points: 9 })], 'seven_day', 'm', 2000)).toBeNull()
    expect(poolRate([rec({ usd: 9, points: 9 })], 'five_hour', 'm', 1000 + CAL_MAX_AGE_MS)).toBeNull()
    expect(poolRate([rec({ usd: 0, points: 9 })], 'five_hour', 'm', 2000)).toBeNull()
  })
  test('simulated whole-point readings: the pooled rate stays at or under the true rate', () => {
    // 40 sessions on an account where one point is truly $0.97; each starts at a pseudo-random phase of a point.
    const truth = 0.97
    const records: CalRecord[] = []
    let seed = 7
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let i = 0; i < 40; i++) {
      const startPct = rand() * 60
      const spend = 0.3 + rand() * 6
      const r = rec()
      extendCalibration(r, extendCalibration(r, null, Math.floor(startPct), 0), Math.floor(startPct + spend / truth), spend)
      records.push(r)
    }
    const rate = poolRate(records, 'five_hour', 'm', 2000)!
    expect(rate.usdPerPoint).toBeLessThan(truth)
    expect(rate.usdPerPoint).toBeGreaterThan(truth * 0.85)
  })
  test('other sessions on the account only make the rate smaller', () => {
    const alone = poolRate([rec({ usd: 9.7, points: 10 })], 'five_hour', 'm', 2000)!
    const shared = poolRate([rec({ usd: 9.7, points: 17 })], 'five_hour', 'm', 2000)!
    expect(shared.usdPerPoint).toBeLessThan(alone.usdPerPoint)
  })
})

describe('effort', () => {
  test('lowered to the cap, never raised, and left alone when it is not a named level', () => {
    expect(cappedEffort('xhigh', 'medium')).toBe('medium')
    expect(cappedEffort('max', 'high')).toBe('high')
    expect(cappedEffort('low', 'medium')).toBe('low')
    expect(cappedEffort('medium', 'medium')).toBe('medium')
    expect(cappedEffort('xhigh', 'keep')).toBe('xhigh')
    expect(cappedEffort(undefined, 'medium')).toBe(undefined)
    expect(cappedEffort(32000, 'medium')).toBe(32000)
  })
})
