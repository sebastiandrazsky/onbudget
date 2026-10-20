import { describe, test, expect } from 'claude-code/testing'
import {
  type Budget, type CalMark, type CalRecord, BOOTSTRAP_RESERVE_USD, DAY_MS, MAX_AGE_DAYS, NAME,
  binding, cappedEffort, extendCalibration, fold, meterLine, observeWalls, observeWindow, parseCommand, poolRate, protocol, refusalText, sizeRest, stepCostOf, stopCheck, stopLabel, tierOf,
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
    expect(parseCommand('5h Build this application')).toEqual({ kind: 'start', raw: '5h', spec: { kind: 'rest', window: 'five_hour' }, task: 'Build this application' })
    expect(parseCommand('WEEK fix it')).toEqual({ kind: 'start', raw: 'week', spec: { kind: 'rest', window: 'seven_day' }, task: 'fix it' })
  })
  test('what is not a budget is refused with the usage', () => {
    for (const bad of ['banana split', '$0 x', '0% 5h x', '150% week x', '10% 4h x', '10% x', '3 dollars x', '$3', '10% 5h', '$3x do it', '-$3 x', '5h', 'week', '5hours x', 'weekly x']) {
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
    expect(meterLine(usd({ spent: 1.234, maxStep: 0.1 }))).toBe('[budget] spent $1.23 of $4.00 | left before the stop $2.67 (67%) | tier MEDIUM')
    expect(meterLine(usd({ spent: 9 }))).toBe('[budget] spent $9.00 of $4.00 | left before the stop $0.00 (0%) | tier CRITICAL')
  })
  test('a converted percentage budget reads in dollars and names the share', () => {
    expect(meterLine(pct(4, { usd: 3.2, spent: 0.8, maxStep: 0.1 }))).toBe('[budget] spent $0.80 of $3.20 (4% of the 5-hour usage window) | left before the stop $2.30 (72%) | tier HIGH')
  })
  test('an unconverted percentage budget reads in points', () => {
    expect(meterLine(pct(5, { window: { kind: 'five_hour', last: 40, moved: 2, blind: 0 } }))).toBe('[budget] the 5-hour usage window has moved 2 of 5 points | left before the stop 3 points (60%) | tier MEDIUM')
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

describe('what one request cost', () => {
  test('the ledger growth since the last request completed', () => {
    near(stepCostOf(1.5, 1.2, 0.2), 0.3) // sent long ago; others completed meanwhile and are not charged to it
  })
  test('and no more than the growth since it was sent', () => {
    near(stepCostOf(3.1, 1.0, 3.0), 0.1) // a compaction cost 2.00 between the last completion and this request
  })
  test('never negative', () => { expect(stepCostOf(1, 2, 3)).toBe(0) })
})

describe('the stop', () => {
  test('before any request is priced the bootstrap reserve is held back', () => {
    expect(stopCheck(usd({ usd: 1, spent: 0 }), 0)).toBeNull()
    expect(stopCheck(usd({ usd: 1, spent: 1 - BOOTSTRAP_RESERVE_USD }), 0)?.event).toBe('reserve-stop')
  })
  test('the dearest request seen is held back', () => {
    expect(stopCheck(usd({ spent: 3.69, maxStep: 0.3 }), 0)).toBeNull()
    expect(stopCheck(usd({ spent: 3.7, maxStep: 0.3 }), 0)).toEqual({ event: 'reserve-stop', spent: 3.7, reserve: 0.3, budget: 4, inFlight: 0 })
  })
  test('each request already in flight holds back a reserve of its own', () => {
    const b = usd({ spent: 3.3, maxStep: 0.3 })
    expect(stopCheck(b, 0)).toBeNull()
    expect(stopCheck(b, 1)).toBeNull()
    expect(stopCheck(b, 2)).toEqual({ event: 'reserve-stop', spent: 3.3, reserve: 0.3, budget: 4, inFlight: 2 }) // 3.3 + 3 x 0.3 = 4.2
  })
  test('once stopped it stays stopped', () => {
    const stop = { event: 'reserve-stop', spent: 3.9, reserve: 0.3, budget: 4, inFlight: 0 } as const
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
    b.window = { kind: 'five_hour', last: 100, moved: 3, blind: 9 }
    expect(stopCheck(b, 0)).toBeNull() // a full or unreported window does not stop a budget counted in dollars
    expect(stopCheck(pct(4, { usd: 3.2, maxStep: 0.2, spent: 3.0, window: { kind: 'five_hour', last: 42, moved: 2, blind: 0 } }), 0)?.event).toBe('reserve-stop')
  })
  test('three answers in a row with no reading: an unconverted percentage budget cannot be checked', () => {
    const b = pct(5)
    observeWindow(b, [])
    observeWindow(b, [{ kind: 'seven_day', percentUsed: 3 }])
    expect(stopCheck(b, 0)).toBeNull()
    observeWindow(b, [])
    expect(stopCheck(b, 0)).toEqual({ event: 'no-reading' })
    observeWindow(b, [{ kind: 'five_hour', percentUsed: 3 }])
    expect(stopCheck(b, 0)).toBeNull()
    for (let i = 0; i < 3; i++) observeWindow(b, []) // and the same when a window that was reported goes away
    expect(stopCheck(b, 0)).toEqual({ event: 'no-reading' })
    const converted = pct(5, { usd: 4 })
    for (let i = 0; i < 5; i++) observeWindow(converted, [])
    expect(stopCheck(converted, 0)).toBeNull() // converted: dollars need no reading
  })
  test('a budget saved by an earlier build that stopped on a full window still reads', () => {
    expect(stopLabel({ event: 'window-full' })).toBe('the usage window is full')
  })
  test('the notice says who is speaking, what stopped it, and that the work is unverified', () => {
    const b = usd({ spent: 3.9, maxStep: 0.3 })
    const text = refusalText(b, stopCheck(b, 0)!, false)
    expect(text).toContain('[onbudget] Stopped: $3.90 of $4.00 is used, and the next request could cost up to $0.30, so it was not sent.')
    expect(text).toContain('not from Claude')
    expect(text).toContain('/onbudget off')
    expect(refusalText(b, stopCheck(b, 0)!, true)).toContain('This subagent was stopped')
    const busy = usd({ spent: 3.3, maxStep: 0.3 })
    expect(refusalText(busy, stopCheck(busy, 2)!, false)).toContain('could cost up to $0.30, as could each of the 2 requests still running, so it was not sent')
  })
})

describe('the window', () => {
  const at = (b: Budget) => [b.window!.last, b.window!.moved, b.window!.blind]
  test('the first reading under the budget is the baseline; movement counts from it', () => {
    const b = pct(5)
    observeWindow(b, [{ kind: 'seven_day', percentUsed: 80 }, { kind: 'five_hour', percentUsed: 40 }])
    expect(at(b)).toEqual([40, 0, 0])
    observeWindow(b, [{ kind: 'five_hour', percentUsed: 42 }])
    observeWindow(b, [{ kind: 'five_hour', percentUsed: 42 }])
    expect(at(b)).toEqual([42, 2, 0])
    observeWindow(b, [])
    expect(at(b)).toEqual([42, 2, 1])
  })
  test('a reset is counted from zero: seen by the reset time when readings carry one', () => {
    const b = pct(5)
    observeWindow(b, [{ kind: 'five_hour', percentUsed: 2, resetsAt: '2026-10-08T22:10:00.000Z' }])
    observeWindow(b, [{ kind: 'five_hour', percentUsed: 3, resetsAt: '2026-10-09T03:10:00.327Z' }]) // a new window, already at 3
    expect(at(b)).toEqual([3, 3, 0])
  })
  test('a reset is seen by a drop when readings carry no reset time', () => {
    const b = pct(5, { window: { kind: 'five_hour', last: 98, moved: 2, blind: 0 } })
    observeWindow(b, [{ kind: 'five_hour', percentUsed: 1 }])
    expect(at(b)).toEqual([1, 3, 0])
  })
  test('a reading that dips inside one window is not movement', () => {
    const b = pct(5)
    observeWindow(b, [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-08T22:10:00.000Z' }])
    observeWindow(b, [{ kind: 'five_hour', percentUsed: 23.4, resetsAt: '2026-10-08T22:10:00.327Z' }])
    observeWindow(b, [{ kind: 'five_hour', percentUsed: 24.4, resetsAt: '2026-10-08T22:10:00.000Z' }])
    near(b.window!.moved, 1)
  })
  test('what is left follows whichever unit the budget is enforced in', () => {
    near(binding(pct(5, { window: { kind: 'five_hour', last: 44, moved: 4, blind: 0 } }), 0)!.left, 0.2)
    near(binding(pct(5, { usd: 4, spent: 1, maxStep: 0.2, window: { kind: 'five_hour', last: 44, moved: 4, blind: 0 } }), 0)!.left, 0.7)
  })
})

describe('calibration', () => {
  const rec = (over: Partial<CalRecord> = {}): CalRecord => ({ kind: 'five_hour', model: 'm', usd: 0, points: 0, segments: 0, at: 1000, ...over })
  const read = (percentUsed: number, resetsAt?: string) => ({ kind: 'five_hour', percentUsed, resetsAt })
  test('a span between two readings adds its dollars and its points; an unbroken run is one segment', () => {
    const r = rec()
    let mark: CalMark | null = extendCalibration(r, null, read(10), 1.0)
    mark = extendCalibration(r, mark, read(12), 3.0)
    mark = extendCalibration(r, mark, read(12), 3.5)
    expect(r).toEqual(rec({ usd: 2.5, points: 2, segments: 1 }))
    expect([mark.percent, mark.ledger, mark.open]).toEqual([12, 3.5, true])
  })
  test('a reset, a ledger that started over, and a window at its wall are left out, and each starts a new segment', () => {
    const r = rec()
    let mark: CalMark | null = extendCalibration(r, null, read(90), 10)
    mark = extendCalibration(r, mark, read(97), 17) // counted: segment 1
    mark = extendCalibration(r, mark, read(2), 18) // reset
    mark = extendCalibration(r, mark, read(4), 20) // counted: segment 2
    mark = extendCalibration(r, mark, read(5), 0.2) // ledger started over
    mark = extendCalibration(r, mark, read(99), 50) // at the wall
    mark = extendCalibration(r, mark, read(100), 60)
    expect(r).toEqual(rec({ usd: 9, points: 9, segments: 2 }))
    expect(mark.open).toBe(false)
  })
  test('a reset is seen by the reset time even when the new reading is not lower', () => {
    const r = rec()
    const mark = extendCalibration(r, null, read(2, '2026-10-08T22:10:00.000Z'), 1)
    extendCalibration(r, mark, read(3, '2026-10-09T03:10:00.000Z'), 9)
    expect(r).toEqual(rec())
  })
  test('the pooled rate is total dollars over total points, widened for rounding per segment, so it errs low', () => {
    const records = [rec({ usd: 4.85, points: 5, segments: 1 }), rec({ usd: 3.88, points: 4, segments: 2 }), rec({ usd: 0.5, points: 0, segments: 1 })]
    const rate = poolRate(records, 'five_hour', 'm', 2000)!
    expect(rate.points).toBe(9)
    expect(rate.intervals).toBe(3)
    near(rate.usdPerPoint, 9.23 / (9 + 2 * 0.41 * Math.sqrt(4)))
    expect(rate.usdPerPoint).toBeLessThan(9.23 / 9)
  })
  test('too little movement, another model, another window or old records give no rate', () => {
    expect(poolRate([rec({ usd: 2, points: 2 })], 'five_hour', 'm', 2000)).toBeNull()
    expect(poolRate([rec({ usd: 9, points: 9 })], 'five_hour', 'other', 2000)).toBeNull()
    expect(poolRate([rec({ usd: 9, points: 9 })], 'seven_day', 'm', 2000)).toBeNull()
    expect(poolRate([rec({ usd: 9, points: 9 })], 'five_hour', 'm', 1000 + MAX_AGE_DAYS * DAY_MS)).toBeNull()
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
      extendCalibration(r, extendCalibration(r, null, read(Math.floor(startPct)), 0), read(Math.floor(startPct + spend / truth)), spend)
      records.push(r)
    }
    const rate = poolRate(records, 'five_hour', 'm', 2000)!
    expect(rate.usdPerPoint).toBeLessThan(truth)
    expect(rate.usdPerPoint).toBeGreaterThan(truth * 0.85)
  })
  test('other sessions on the account only make the rate smaller', () => {
    const alone = poolRate([rec({ usd: 9.7, points: 10, segments: 1 })], 'five_hour', 'm', 2000)!
    const shared = poolRate([rec({ usd: 9.7, points: 17, segments: 1 })], 'five_hour', 'm', 2000)!
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

describe('where the stop is', () => {
  test('with requests one at a time, each no dearer than the dearest before it, CRITICAL is read before at least two requests that are then sent', () => {
    let seed = 11
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let run = 0; run < 2000; run++) {
      const budget = 0.2 + rand() * 6
      const b = usd({ usd: budget, spec: { kind: 'usd', usd: budget } })
      const first = rand() * budget / 10
      let seen = false
      let sentAfter = 0
      for (let i = 0; ; i++) {
        if (stopCheck(b, 0)) break
        if (seen) sentAfter += 1
        const cost = i === 0 ? first : rand() * b.maxStep
        b.spent += cost
        b.maxStep = Math.max(b.maxStep, cost)
        if (binding(b, 0)!.tier === 'CRITICAL') seen = true // the meter line after this request's tool result
      }
      if (!(seen && sentAfter >= 2)) throw new Error(`budget ${budget}: CRITICAL seen ${seen}, ${sentAfter} requests sent after it`)
    }
  })
  test('the meter reads 0 left exactly when the next request is refused', () => {
    const b = usd({ usd: 1, maxStep: 0.2 })
    b.spent = 0.79
    expect(meterLine(b)).toContain('left before the stop $0.01 (1%)')
    expect(stopCheck(b, 0)).toBeNull()
    b.spent = 0.8
    expect(meterLine(b)).toContain('left before the stop $0.00 (0%)')
    expect(stopCheck(b, 0)?.event).toBe('reserve-stop')
  })
  test('the old meter read CRITICAL at $2.27 of $2.47, one request before the stop; this one from $1.97', () => {
    const b = usd({ usd: 2.47, spec: { kind: 'usd', usd: 2.47 }, maxStep: 0.169, spent: 1.96 })
    expect(binding(b, 0)!.tier).toBe('LOW')
    b.spent = 1.97
    expect(binding(b, 0)!.tier).toBe('CRITICAL')
    b.spent = 2.32
    expect(stopCheck(b, 0)?.event).toBe('reserve-stop')
  })
})

describe('the account\'s windows as walls', () => {
  const r = (kind: string, percentUsed: number, resetsAt = '2030-01-01T00:00:00.000Z') => ({ kind, percentUsed, resetsAt })
  test('with a rate a window is a wall in dollars: the task\'s spend at which it would reach 99%', () => {
    const b = usd({ usd: 10, spec: { kind: 'usd', usd: 10 }, maxStep: 0.5 })
    observeWalls(b, [r('five_hour', 95)], 2, { five_hour: { usdPerPoint: 1, points: 9, intervals: 1, source: 'config' } }, 0)
    b.spent = 2.5
    // ceiling 2 + (99 - 95) x 1 = 6; held back 0.5: 3 left
    expect(meterLine(b)).toBe("[budget] spent $2.50 of $10.00 | left before the stop $3.00 (50%), set by the account's 5-hour limit | tier MEDIUM")
    b.spent = 5.5
    expect(stopCheck(b, 0)).toEqual({ event: 'wall-stop', window: 'five_hour', percent: 95, resetsAt: '2030-01-01T00:00:00.000Z', inFlight: 0 })
  })
  test('without one, in points: a point for the request the reading may lag, one for each in flight and one for the next', () => {
    const b = usd({ usd: 100 })
    observeWalls(b, [r('seven_day', 96)], 0, {}, 0)
    expect(stopCheck(b, 0)).toBeNull()
    expect(stopCheck(b, 1)?.event).toBe('wall-stop')
    observeWalls(b, [r('seven_day', 97)], 0, {}, 0)
    expect(stopCheck(b, 0)).toEqual({ event: 'wall-stop', window: 'seven_day', percent: 97, resetsAt: '2030-01-01T00:00:00.000Z', inFlight: 0 })
  })
  test('a bigger step between two readings is reckoned as one request\'s, except from a reading taken before the budget', () => {
    const b = usd({ usd: 100 })
    observeWalls(b, [r('five_hour', 50)], 0, {}, 0, true)
    observeWalls(b, [r('five_hour', 80)], 0, {}, 0) // others used the window while the session sat idle
    expect(b.walls!.five_hour!.stepPts).toBe(1)
    observeWalls(b, [r('five_hour', 83)], 0, {}, 0)
    expect(b.walls!.five_hour!.stepPts).toBe(3)
  })
  test('a reading whose window has reset is not a wall, and a wall whose window has reset is dropped', () => {
    const b = usd({ usd: 100 })
    observeWalls(b, [r('five_hour', 98, '2020-01-01T00:00:00.000Z')], 0, {}, Date.parse('2021-01-01'))
    expect(b.walls?.five_hour).toBeUndefined()
  })
  test('5h and week are sized from a reading: dollars with a rate, the window\'s own points without', () => {
    const rest = (over: Partial<Budget> = {}) => usd({ raw: '5h', spec: { kind: 'rest', window: 'five_hour' }, usd: null, pending: true, window: { kind: 'five_hour', last: null, moved: 0, blind: 0 }, ...over })
    const a = rest()
    sizeRest(a, r('five_hour', 39), { usdPerPoint: 0.5, points: 9, intervals: 1, source: 'learned' }, 1)
    expect([a.usd, a.pending, a.allowance]).toEqual([31, false, undefined])
    const p = rest()
    sizeRest(p, r('five_hour', 39), null, 1)
    expect([p.usd, p.allowance, p.window!.last]).toEqual([null, 60, 39])
    expect(meterLine(p)).toBe('[budget] the 5-hour usage window has moved 0 of 60 points | left before the stop 60 points (100%) | tier HIGH')
  })
})
