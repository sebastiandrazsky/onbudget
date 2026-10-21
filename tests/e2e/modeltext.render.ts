// Renders every text the model can receive from onbudget, over a matrix of states, as JSON lines on stdout
// ("MODELTEXT {...}"). tests/e2e/modeltext.py copies this file into two checkouts (as tests/zz_modeltext.test.ts, beside
// a copy of tests/world.ts as tests/zz_world.ts, so the harness is the same for both), runs `claude plugin test` in each,
// and compares the bytes. Not a test of its own: its name does not end in .test.ts, so the suite does not run it here.
//
// Two parts. "core": the functions in hooks/core.ts that build model text, called directly over a large matrix of
// budgets. "hooks": the plugin's own hooks in a scripted world, capturing what reaches the model: the submitted task,
// the line after each tool result, the note with a follow-up prompt, the reminder after a compaction, the made-up
// answer of a refused or unchecked request, the effort each request is sent at, and each countdown attachment.
import { describe, test, expect } from 'claude-code/testing'
import { type Budget, type Stop, type Wall, type WindowKind, failClosedText, isDefaultCountdown, meterLine, protocol, refusalText, reminder, shown } from '../hooks/core.ts'
import { world, step, start, run, prompt, tool, attach, compact, deferred, LOG } from './zz_world.ts'

const out = (part: string, key: string, value: unknown) => console.log('MODELTEXT ' + JSON.stringify({ part, key, value }))

// ---------------------------------------------------------------- core: the model-text builders over a matrix

const budget = (over: Partial<Budget>): Budget => ({
  v: 1, raw: '$1', spec: { kind: 'usd', usd: 1 }, task: 'task', usd: 1, rate: null, spent: 0, ledger: 0, maxStep: 0, steps: 0, refused: 0,
  state: 'active', effortCap: 'medium', remind: false, startedAt: 0, ...over,
})
const wall = (last: number, over: Partial<Wall> = {}): Wall => ({ last, first: last, at: 0, rate: null, stepPts: 1, moved: 0, ...over })
const SHORT: Record<WindowKind, string> = { five_hour: '5h', seven_day: 'week' }

function forms(usd: number, points: number, kind: WindowKind): Budget[] {
  const win = { kind, last: 20, moved: 0, blind: 0, resetsAt: '2030-01-01T00:00:00.000Z' }
  const rate = { usdPerPoint: usd / points, points: 30, intervals: 3, source: 'learned' as const }
  const config = { ...rate, source: 'config' as const }
  return [
    budget({ raw: `$${usd}`, spec: { kind: 'usd', usd }, usd }),
    budget({ raw: `${points}% ${SHORT[kind]}`, spec: { kind: 'pct', window: kind, points }, usd, rate, window: { ...win } }),
    budget({ raw: `${points}% ${SHORT[kind]}`, spec: { kind: 'pct', window: kind, points }, usd, rate: config, window: { ...win } }),
    budget({ raw: `${points}% ${SHORT[kind]}`, spec: { kind: 'pct', window: kind, points }, usd: null, window: { ...win } }),
    budget({ raw: SHORT[kind], spec: { kind: 'rest', window: kind }, usd, rate, window: { ...win } }),
    budget({ raw: SHORT[kind], spec: { kind: 'rest', window: kind }, usd: null, allowance: points, window: { ...win } }),
    budget({ raw: SHORT[kind], spec: { kind: 'rest', window: kind }, usd: null, pending: true, window: { ...win, last: null } }),
  ]
}

function wallSets(at: number, rate: number): Partial<Record<WindowKind, Wall>>[] {
  return [
    {},
    { five_hour: wall(at) },
    { five_hour: wall(at, { first: Math.max(0, at - 20), stepPts: 4, moved: 20, resetsAt: '2030-01-01T05:00:00.000Z' }) },
    { five_hour: wall(at, { rate }) },
    { seven_day: wall(at, { seed: true }) },
    { five_hour: wall(at, { rate }), seven_day: wall(Math.min(97, at + 3), { rate: rate * 3, moved: 3 }) },
  ]
}

const STOPS: Stop[] = [
  { event: 'reserve-stop', spent: 1, reserve: 0.1, budget: 1, inFlight: 0 },
  { event: 'reserve-stop', spent: 0.9, reserve: 0.2, budget: 1, inFlight: 3 },
  { event: 'window-stop', moved: 10, points: 10, calibrated: false },
  { event: 'window-stop', moved: 21, points: 10, calibrated: true },
  { event: 'wall-stop', window: 'five_hour', percent: 97, resetsAt: '2030-01-01T05:00:00.000Z', inFlight: 0 },
  { event: 'wall-stop', window: 'seven_day', percent: 98, inFlight: 2 },
  { event: 'window-full' },
  { event: 'no-reading' },
]

describe('core', () => {
  test('meter lines, the protocol, the reminder and the refusals over a matrix of budgets', () => {
    let n = 0
    const sizes: [number, number][] = [[0.12, 3], [0.6, 10], [3, 25], [500, 50], [12_345.67, 99.5], [1e6, 100]]
    for (const [usd, points] of sizes) {
      for (const kind of ['five_hour', 'seven_day'] as WindowKind[]) {
        for (const [wi, walls] of wallSets(60, usd / 40).entries()) {
          for (const f of [0, 0.05, 0.31, 0.5, 0.75, 0.92, 1, 1.4]) {
            for (const [fi, b] of forms(usd, points, kind).entries()) {
              Object.assign(b, { walls: JSON.parse(JSON.stringify(walls)), spent: usd * f, maxStep: f === 0 ? 0 : usd * 0.04 })
              if (b.window) b.window.moved = Math.round(points * f * 10) / 10
              const key = `${usd}|${points}|${kind}|w${wi}|f${f}|${fi}`
              for (const inFlight of [0, 1, 3]) { out('core', `meter|${key}|i${inFlight}`, meterLine(b, inFlight)); n++ }
              if (f === 0 || f === 1) {
                out('core', `shown|${key}`, shown(b))
                out('core', `protocol|${key}`, protocol(shown(b)))
                out('core', `reminder|${key}`, reminder(b))
                for (const [si, stop] of STOPS.entries()) for (const sub of [false, true]) out('core', `refusal|${key}|s${si}|${sub}`, refusalText({ ...b, state: 'stopped', stop }, stop, sub))
              }
            }
          }
        }
      }
    }
    for (const reason of ['the budget in ONBUDGET did not start', 'its hook failed or timed out', 'x']) out('core', `failclosed|${reason}`, failClosedText(reason))
    const counts = ['<total_tokens>15000000 tokens left</total_tokens>', '<total_tokens>999999 tokens left</total_tokens>', '<total_tokens>1000000 tokens left</total_tokens>',
      '<total_tokens>Infinite tokens left</total_tokens>', ' <total_tokens> 2000000 tokens left </total_tokens>\n', '<total_tokens>15,000,000 tokens left</total_tokens>', 'other', '']
    for (const c of counts) out('core', `countdown|${JSON.stringify(c)}`, isDefaultCountdown(c))
    expect(n > 1000).toBe(true)
  })
})

// ---------------------------------------------------------------- hooks: what reaches the model in a scripted world

const R5 = '2030-01-01T05:00:00.000Z'
const R7 = '2030-01-08T00:00:00.000Z'
const NOW = 1_700_000_000_000
const DAY = Math.floor(NOW / (24 * 3600 * 1000))
const cal = (kind: WindowKind, usd: number, points: number) => ({ [`cal:${kind}:${DAY}:s-old:claude-opus-5-5`]: { kind, model: 'claude-opus-5-5', usd, points, segments: 2, at: NOW - 1000 } })
type W = ReturnType<typeof world>

/** Captures, after a scenario, everything that reached the model in it. */
function capture(name: string, w: W, extra: Record<string, unknown> = {}) {
  out('hooks', `${name}|prompts`, w.prompts.map(p => ({ text: p.text, context: p.context ?? null })))
  out('hooks', `${name}|efforts`, w.requests.map(r => r.effort ?? null))
  for (const [k, v] of Object.entries(extra)) out('hooks', `${name}|${k}`, v)
}
const readings = (w: W, five?: number, seven?: number) => {
  w.readings = [...(five === undefined ? [] : [{ kind: 'five_hour', percentUsed: five, resetsAt: R5 }]), ...(seven === undefined ? [] : [{ kind: 'seven_day', percentUsed: seven, resetsAt: R7 }])]
}

/** Requests with a tool each, at a cost, moving the windows as given, until one is refused or `max` were made. */
async function work($: any, w: W, cost: number, max: number, move: (i: number) => [number?, number?] = () => [undefined, undefined]) {
  const seen: unknown[] = []
  for (let i = 0; i < max; i++) {
    const [five, seven] = move(i)
    w.reply = () => ({ cost, tools: ['Bash'] })
    const s = await step($)
    if (five !== undefined || seven !== undefined) readings(w, five, seven)
    seen.push({ answer: s.result.answer, chunks: s.chunks.filter((c: any) => c.kind === 'text').map((c: any) => c.text) })
    if (s.result.answer !== 'ok') break
    const t = await tool($)
    seen.push({ tool: t?.context ?? null })
  }
  return seen
}

describe('hooks', () => {
  for (const [name, raw, store, five, seven, cost, move] of [
    ['usd', '$1', {}, undefined, undefined, 0.1, undefined],
    ['usd-walls', '$500', {}, 95, 40, 0.02, (i: number) => [95 + Math.min(2, i), 40]],
    ['usd-5h-rate', '$500', cal('five_hour', 30, 10), 80, 40, 0.5, (i: number) => [80 + i, 40]],
    ['pct5h-converted', '10% 5h', cal('five_hour', 9, 10), 20, 30, 0.15, (i: number) => [20 + i, 30]],
    ['pct5h-calibrated-stop', '5% 5h', cal('five_hour', 9, 10), 20, 30, 0.01, (i: number) => [20 + 3 * i, 30]],
    ['pct5h-points', '4% 5h', {}, 20, 30, 0.1, (i: number) => [20 + i, 30]],
    ['pct-week', '5% week', cal('seven_day', 30, 10), 20, 30, 0.1, (i: number) => [20, 30 + i]],
    ['rest5h-converted', '5h', cal('five_hour', 9, 10), 90, 30, 0.5, (i: number) => [90 + i, 30]],
    ['rest5h-points', '5h', {}, 92, 30, 0.1, (i: number) => [92 + i, 30]],
    ['week-points', 'week', {}, 30, 93, 0.1, (i: number) => [30, 93 + i]],
    ['week-pending', 'week', {}, undefined, undefined, 0.1, (i: number) => [30, 90 + i]],
    ['week-blind', 'week', {}, undefined, undefined, 0.1, undefined],
  ] as [string, string, Record<string, unknown>, number | undefined, number | undefined, number, ((i: number) => [number?, number?]) | undefined][]) {
    test(`${name}: the task, the meter after each tool result, a follow-up, a compaction, the refusal`, async ($, on) => {
      const w = world(on, { env: LOG, store })
      readings(w, five, seven)
      await start($)
      await run($, `${raw} Do the task.`)
      await w.clock.advance(5)
      const first = await work($, w, cost, 2, move)
      const note = await prompt($, 'And a follow-up.')
      await compact($, 'manual')
      const after = await work($, w, cost, 1, move && (i => move(i + 2)))
      const note2 = await prompt($, 'After the compaction.')
      const rest = await work($, w, cost, 40, move && (i => move(i + 3)))
      const sub = await step($, { agentId: 'agent-1' })
      const late = await prompt($, 'After the stop.')
      capture(name, w, { first, note: note?.context ?? null, after, note2: note2?.context ?? null, rest, subagent: sub.result.answer, late: late?.context ?? null })
    })
  }

  test('requests in flight and subagents: the meter and the refusal of each', async ($, on) => {
    const w = world(on, { env: LOG })
    await start($)
    await run($, '$1 Parallel task.')
    await w.clock.advance(5)
    const gates = [deferred(), deferred()]
    let k = 0
    w.reply = () => ({ cost: 0.15, tools: ['Bash'], hold: gates[k++]?.promise })
    const a = step($, { agentId: 'agent-a' })
    const b = step($, { agentId: 'agent-b' })
    await w.clock.advance(1)
    const t1 = await tool($, { agentId: 'agent-c' })
    gates[0].open(); await a
    const t2 = await tool($, { agentId: 'agent-a' })
    gates[1].open(); await b
    w.reply = () => ({ cost: 0.3, tools: ['Bash'] })
    const more = await work($, w, 0.3, 6)
    capture('in-flight', w, { t1: t1?.context ?? null, t2: t2?.context ?? null, more })
  })

  test('a stop while other requests are still running', async ($, on) => {
    const w = world(on, { env: LOG })
    await start($)
    await run($, '$1 Busy task.')
    await w.clock.advance(5)
    w.reply = () => ({ cost: 0.25, tools: ['Bash'] })
    await step($)
    const gates = [deferred(), deferred()]
    let k = 0
    w.reply = () => ({ cost: 0.1, tools: ['Bash'], hold: gates[k++]?.promise })
    const a = step($, { agentId: 'agent-a' })
    const b = step($, { agentId: 'agent-b' })
    await w.clock.advance(1)
    const main = await step($)
    const sub = await step($, { agentId: 'agent-c' })
    gates[0].open(); gates[1].open(); await a; await b
    capture('stop-in-flight', w, { main: main.result.answer, sub: sub.result.answer })
  })

  // The effort cap comes from the plugin's `effort` option (ONBUDGET_EFFORT, which set it in earlier builds, was removed).
  test('ONBUDGET in the environment, with the effort cap low', { options: { effort: 'low' } }, async ($, on) => {
    const w = world(on, { env: { ...LOG, ONBUDGET: '$2' } })
    await start($)
    await prompt($, 'The first prompt is the task.')
    capture('env', w, { s: await work($, w, 0.4, 10) })
  })

  test('the command typed as prompt text', async ($, on) => {
    const w = world(on, { env: LOG })
    await start($)
    await prompt($, '/onbudget $0.80 A typed task.')
    capture('typed', w, { s: await work($, w, 0.2, 10) })
  })

  test('effort keep: the effort the caller asked for is sent', { options: { effort: 'keep' } }, async ($, on) => {
    const w = world(on, { env: { ...LOG } })
    await start($)
    await run($, '$1 Keep the effort.')
    await w.clock.advance(5)
    await step($, { effort: 'max' })
    await step($, { effort: 'low' })
    capture('effort-keep', w, {})
  })

  test('not checked: ONBUDGET that did not start', async ($, on) => {
    const w = world(on, { env: { ...LOG, ONBUDGET: '$1' } })
    await start($)
    const s = await step($)
    capture('env-not-started', w, { answer: s.result.answer })
  })

  test('not checked: a hook that failed before the request went out', async ($, on) => {
    const w = world(on, { env: LOG })
    await start($)
    await run($, '$1 A task.')
    await w.clock.advance(5)
    w.hasLedger = false
    const s = await step($)
    capture('hook-failed', w, { answer: s.result.answer })
  })

  test('the countdown: left out under a budget, kept without one, kept when chosen, kept when small', async ($, on) => {
    const w = world(on, { env: LOG })
    await start($)
    const c = '<total_tokens>15000000 tokens left</total_tokens>'
    const seen: unknown[] = [await attach($, c), await attach($, '<total_tokens>500000 tokens left</total_tokens>')]
    await run($, '$1 Count.')
    await w.clock.advance(5)
    seen.push(await attach($, c), await attach($, c), await attach($, '<total_tokens>14999000 tokens left</total_tokens>'), await attach($, '<total_tokens>999999 tokens left</total_tokens>'), await attach($, 'not a countdown'))
    await step($)
    seen.push(await attach($, c))
    await run($, 'off')
    seen.push(await attach($, c), await attach($, '<total_tokens>15000000 tokens left</total_tokens>'))
    capture('countdown', w, { seen })
  })

  test('the countdown when the person set CLAUDE_CODE_TOTAL_TOKENS_REMINDER', async ($, on) => {
    const w = world(on, { env: { ...LOG, CLAUDE_CODE_TOTAL_TOKENS_REMINDER: '1' } })
    await start($)
    await run($, '$1 Count.')
    await w.clock.advance(5)
    capture('countdown-chosen', w, { seen: [await attach($, '<total_tokens>15000000 tokens left</total_tokens>')] })
  })
})
