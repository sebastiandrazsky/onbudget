// Renders the texts the README quotes from the plugin's own code: the protocol, examples of the meter line, and what the
// hooks put in the prompts they submit. tests/e2e/readme.py copies this file into a scratch copy of the plugin (as
// tests/zz_readme.test.ts, beside tests/world.ts as tests/zz_world.ts), runs it there and fills the README in. Its name
// does not end in .test.ts, so the suite does not run it here.
import { describe, test } from 'claude-code/testing'
import { type Budget, type Wall, meterLine, protocol } from '../hooks/core.ts'
import { world, step, start, run, prompt, tool, compact, LOG } from './zz_world.ts'

const out = (key: string, value: unknown) => console.log('README ' + JSON.stringify({ key, value }))
const budget = (over: Partial<Budget>): Budget => ({
  v: 1, raw: '$3', spec: { kind: 'usd', usd: 3 }, task: 'task', usd: 3, rate: null, spent: 0, ledger: 0, maxStep: 0, steps: 0, refused: 0,
  state: 'active', effortCap: 'medium', remind: false, startedAt: 0, ...over,
})
const wall = (last: number, over: Partial<Wall> = {}): Wall => ({ last, first: last, at: 0, rate: null, stepPts: 1, moved: 0, ...over })

describe('readme', () => {
  test('the protocol and examples of the meter line', () => {
    out('protocol', protocol('<budget>'))
    out('meter-usd', meterLine(budget({ spent: 1.23, maxStep: 0.17 })))
    out('meter-limit', meterLine(budget({ raw: '$500', spec: { kind: 'usd', usd: 500 }, usd: 500, spent: 2.1, maxStep: 0.2, walls: { five_hour: wall(95, { rate: 0.85, at: 1.7 }) } })))
    out('meter-points', meterLine(budget({ raw: 'week', spec: { kind: 'rest', window: 'seven_day' }, usd: null, allowance: 81, spent: 0.6, maxStep: 0.2,
      window: { kind: 'seven_day', last: 21, moved: 3, blind: 0 }, walls: { seven_day: wall(21, { first: 18, moved: 3 }) } })))
    out('meter-pending', meterLine(budget({ raw: 'week', spec: { kind: 'rest', window: 'seven_day' }, usd: null, pending: true, spent: 0.04,
      window: { kind: 'seven_day', last: null, moved: 0, blind: 0 } })))
  })
  test('what the hooks put in the prompts they submit', async ($, on) => {
    const w = world(on, { env: LOG })
    await start($)
    await run($, '$3 TASK')
    await w.clock.advance(5)
    w.reply = () => ({ cost: 0.2, tools: ['Bash'] })
    await step($)
    const meter = await tool($)
    const note = await prompt($, 'A follow-up.')
    await compact($, 'manual')
    const after = await tool($)
    out('task', w.prompts[0].text)
    out('meter', meter.context)
    out('note', note.context)
    out('after-compaction', after.context)
  })
})
