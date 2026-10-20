// Claude Code's own token countdown while a budget is open, the receipt in window points, and an effort cap that another
// plugin overrides.
import { describe, test, expect } from 'claude-code/testing'
import { world, step, start, run, attach, compact, rows, LOG } from './world.ts'
import { effortBeneath, isDefaultCountdown } from '../hooks/core.ts'

const cd = (n: number | string) => `<total_tokens>${n} tokens left</total_tokens>`
const five = (percentUsed: number) => ({ kind: 'five_hour', percentUsed, resetsAt: '2026-10-08T22:10:00.000Z' })
const week = (percentUsed: number) => ({ kind: 'seven_day', percentUsed, resetsAt: '2026-10-12T00:00:00.000Z' })

describe('the countdown', () => {
  test('the default one is known by its form and size; a smaller one may be a budget the person set, and is not', () => {
    expect([cd(15000000), cd(1000000), cd('Infinite'), ` ${cd(14998760)}\n`].map(isDefaultCountdown)).toEqual([true, true, true, true])
    expect([cd(999999), cd(200000), 'tokens left', `${cd(15000000)} and more`].map(isDefaultCountdown)).toEqual([false, false, false, false])
  })
  test('left out while a budget is open, from the first request on, and kept with no budget', async ($, on) => {
    const w = world(on, { env: LOG })
    await start($)
    expect(await attach($, cd(15000000))).toBe(cd(15000000))
    await run($, '$5 task')
    expect(await attach($, cd(15000000))).toBe(null)
    await step($)
    expect(await attach($, cd(14998760), { agentId: 'agent-1' })).toBe(null) // a subagent's request too
    await run($, 'off')
    expect(await attach($, cd(14990000))).toBe(cd(14990000))
    expect(rows(w, 'countdown').map(r => r.left)).toEqual([false, true, true, false])
  })
  test('a countdown the person configured, or a small one, is kept under a budget', async ($, on) => {
    const w = world(on, { env: { CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'fixed' } })
    await start($)
    await run($, '$5 task')
    expect(await attach($, cd(5000000))).toBe(cd(5000000))
  })
  test('a countdown under a million tokens is kept', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$5 task')
    expect(await attach($, cd(200000))).toBe(cd(200000))
  })
  test('a resumed session: during its first request the countdowns already sent are answered as they were, by text and order', async ($, on) => {
    // The same text recurs: each prompt's countdown starts at 15000000. The first was sent before the budget, the second under it.
    const w = world(on, { store: { 'hid:session-1': { at: 0, hidden: { [cd(15000000)]: [1], [cd(14998760)]: [0] } } } })
    w.startedAt = Date.now() - 3600_000 // the session began an hour before this process
    await start($)
    await run($, '$5 task')
    const history = [await attach($, cd(15000000)), await attach($, cd(14998760)), await attach($, cd(15000000)), await attach($, cd(15000000))]
    expect(history).toEqual([cd(15000000), null, null, cd(15000000)]) // the fourth is new: kept, it cannot be told from history
    await step($) // the first request of this process has gone out: from now on a countdown is new
    expect(await attach($, cd(15000000))).toBe(null)
    expect((w.store.get('hid:session-1') as any).hidden[cd(15000000)]).toEqual([1, 3])
  })
  test('a compaction starts the numbering again, and /clear forgets the session\'s record', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, '$5 task')
    await attach($, cd(15000000))
    expect(w.store.has('hid:session-1')).toBe(true)
    await compact($, 'auto')
    expect(w.store.has('hid:session-1')).toBe(false)
    await attach($, cd(15000000))
    expect((w.store.get('hid:session-1') as any).hidden[cd(15000000)]).toEqual([0])
    await $.session.end({ reason: 'clear', sessionId: w.sid })
    expect(w.store.has('hid:session-1')).toBe(false)
  })
})

describe('the receipt', () => {
  test('the end-of-task line and the status say what the task moved each window, in whole points', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/work', surface: null, isInteractive: true })
    await run($, '$5 task')
    const readings = [[five(40), week(10)], [five(42), week(10)], [five(43), week(11)]]
    w.reply = () => { w.readings = readings.shift() ?? [five(43), week(11)]; return { cost: 0.5 } }
    await step($); await step($)
    w.reply = () => { w.readings = [five(43), week(11)]; return { cost: 0.5, text: 'Done.\nSTATUS: COMPLETE' } }
    await step($)
    expect(w.logs[w.logs.length - 1]).toBe('onbudget: Claude ended the task with STATUS: COMPLETE, at $1.50 of $5.00; the 5-hour window moved 3 points, the weekly window moved 1 point (whole points, whole account). The budget is still open: a follow-up prompt draws on it, and /onbudget off removes it.')
    const status = (await run($, '')).text
    expect(status).toContain('account limit, 5-hour window: at 43% (resets 2026-10-08 22:10 UTC), moved 3 points since the budget started (whole points, whole account)')
    expect(status).toContain('onbudget 0.1.0, tested on Claude Code')
  })
})

describe('an effort cap another plugin overrides', () => {
  const link = (plugin: string, effort: string) => ({ plugin, received: { effort } })
  test('the effort the engine received is what was sent; the link before the change is the plugin that made it', () => {
    expect(effortBeneath([link('effortless', 'medium'), link('engine', 'xhigh')], 'medium', 'medium')).toEqual({ effort: 'xhigh', by: 'effortless' })
    expect(effortBeneath([link('other', 'medium'), link('effortless', 'medium'), link('engine', 'high')], 'medium', 'medium')).toEqual({ effort: 'high', by: 'effortless' })
    expect(effortBeneath([link('effortless', 'medium'), link('engine', 'low')], 'medium', 'medium')).toBe(null) // lowered further: within the cap
    expect(effortBeneath([link('engine', 'medium')], 'medium', 'medium')).toBe(null)
    expect(effortBeneath([link('effortless', 'medium'), link('engine', 'max')], 'medium', 'keep')).toBe(null)
    expect(effortBeneath(undefined, 'medium', 'medium')).toBe(null)
  })
})
