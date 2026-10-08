// Zero-cost self-test double (harness, not product; ported from the within-lab v0 mock model). It answers every model request
// from a script and never calls next, so no request is sent.
// Env: MOCK_SCRIPT (json list; a string is a Bash command, an object is {name, input} for any tool), MOCK_LOG (json path),
// MOCK_FINAL (optional path of the text to answer with once the script is used up; default "mock done").
import type { Register } from 'claude-code'

let script: any[] | undefined
let final = 'mock done'
let i = 0
const seen: any[] = []

export const register: Register = (on: any) => {
  on('turn.step', async function* ($: any, e: any) {
    if (!script) {
      script = JSON.parse(String(await $.fs.read(await $.env.get('MOCK_SCRIPT'))))
      const fp = await $.env.get('MOCK_FINAL')
      if (fp) final = String(await $.fs.read(fp))
    }
    seen.push({ kind: 'step', index: e.index, effort: e.effort, model: e.model, messageCount: e.messageCount })
    await $.fs.write(await $.env.get('MOCK_LOG'), JSON.stringify(seen))
    if (script && i < script.length) {
      const item = script[i++]
      const name = typeof item === 'string' ? 'Bash' : item.name
      const input = typeof item === 'string' ? { command: item, description: 'self-test' } : item.input
      yield { kind: 'tool', index: 0, id: `toolu_mock_${i}`, name }
      yield { kind: 'input', index: 0, json: JSON.stringify(input) }
      yield { kind: 'stop', stopReason: 'tool_use', usage: null }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name, input }], stopReason: 'tool_use', usage: null }
    }
    yield { kind: 'text', index: 0, text: final }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: final, toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('tool.call', async ($: any, e: any, next: any) => {
    const r = await next(e)
    try {
      seen.push({ kind: 'tool', tool: e.tool, input: JSON.stringify(e.input ?? e.args ?? null).slice(0, 300), result: JSON.stringify(r).slice(0, 160) + ' ... ' + JSON.stringify(r).slice(-260) })
      await $.fs.write(await $.env.get('MOCK_LOG'), JSON.stringify(seen))
    } catch { /* ignore */ }
    return r
  })
}
