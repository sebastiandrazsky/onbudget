#!/usr/bin/env python3
"""Keeps the README's statements about what onbudget puts in prompts, reads and hooks exact.

Renders the texts the plugin builds (tests/e2e/readme.render.ts, run by `claude plugin test` in a scratch copy of the
plugin) and checks, or with --write fills in, the README between the markers `<!-- readme.py: prompts -->` and
`<!-- /readme.py -->`. It also checks that the README's list of hooks is the plugin's (every `on('...')` in
hooks/register.ts), that its list of environment variables is what `claude plugin validate` says the plugin reads, and
that its block of engine calls is the validator's. Zero cost. Exits 1 when the README is out of date.

usage: python3 tests/e2e/readme.py [--write]      (ONBUDGET_CLAUDE_BIN selects the Claude Code build)
"""
import json, os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
CLAUDE = os.environ.get('ONBUDGET_CLAUDE_BIN', 'claude')
START, END = '<!-- readme.py: prompts -->', '<!-- /readme.py -->'
FOLLOW = 'The budget set earlier for this task still applies to this message.'
REMIND = 'Reminder, in case the earlier instruction was summarised away:'


def render():
    d = tempfile.mkdtemp(prefix='onbudget-readme-')
    try:
        os.makedirs(os.path.join(d, 'tests'))
        for part in ('hooks', '.claude-plugin'): shutil.copytree(os.path.join(REPO, part), os.path.join(d, part), ignore=shutil.ignore_patterns('types'))
        shutil.copy(os.path.join(REPO, 'tests', 'world.ts'), os.path.join(d, 'tests', 'zz_world.ts'))
        shutil.copy(os.path.join(HERE, 'readme.render.ts'), os.path.join(d, 'tests', 'zz_readme.test.ts'))
        p = subprocess.run([CLAUDE, 'plugin', 'test', d], capture_output=True, text=True)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    text = p.stdout + '\n' + p.stderr
    got = {r['key']: r['value'] for r in (json.loads(l[len('README '):]) for l in text.splitlines() if l.startswith('README '))}
    if p.returncode != 0 or len(got) < 9: sys.exit(f'the render did not run: {text[-800:]}')
    return got


def fence(text): return '```\n' + text + '\n```'


def section(t):
    """The README's section, from the rendered texts. Each quoted text is checked against how the plugin builds it."""
    proto = t['protocol']
    with_budget = proto.replace('<budget>', '$3.00')
    assert t['task'] == 'TASK\n\n' + with_budget, 'the submitted task is not the task, a blank line and the protocol'
    meter = t['meter'][-1]; assert meter.startswith('[budget] ') and len(t['meter']) == 1, t['meter']
    note = t['note'][-1]; assert note == f'{meter}\n{FOLLOW}', note
    reminded = t['after-compaction']; assert reminded[0] == f'{REMIND}\n{with_budget}' and reminded[1].startswith('[budget] '), reminded
    examples = [t['meter-usd'], t['meter-limit'], t['meter-points'], t['meter-pending']]
    return '\n'.join([
        START,
        'Only while a budget is set. These texts are rendered from the plugin\'s code by `tests/e2e/readme.py`, which checks them on every run; `<...>` marks what varies.',
        '',
        '**The task, with the protocol.** `/onbudget <budget> <task>` (or `ONBUDGET` in a headless run) submits your task as your own prompt, followed by a blank line and this protocol. `<budget>` is the budget as `/onbudget` states it, such as `$3.00`, `$2.40 (3% of the 5-hour usage window)` or `81 points of the weekly usage window (what it had left)`.',
        '',
        fence('<task>\n\n' + proto),
        '',
        '**The meter, after each tool result.** One line of context, which Claude reads; four examples, under a dollar budget, when the 5-hour limit is closer than the budget, under a `week` budget counted in points, and before a `week` budget is sized:',
        '',
        fence('\n'.join(examples)),
        '',
        '**A note with each follow-up prompt**, while the budget is open:',
        '',
        fence(f'<meter line>\n{FOLLOW}'),
        '',
        '**The reminder, once after a compaction**, before the next meter line or with the next follow-up note:',
        '',
        fence(f'{REMIND}\n<the protocol, as above>'),
        '',
        'It also leaves Claude Code\'s own token countdown out of new requests while a budget is open (see "How it works"). When it refuses a request, its notice (`[onbudget] Stopped: ...`) stands in for Claude\'s answer and stays in the conversation.',
        END,
    ])


def main():
    readme_path = os.path.join(REPO, 'README.md'); readme = open(readme_path).read()
    problems = []
    if START not in readme or END not in readme: sys.exit(f'README.md has no {START} ... {END} section')
    new = section(render())
    i, j = readme.index(START), readme.index(END) + len(END)
    if readme[i:j] != new:
        if '--write' in sys.argv: readme = readme[:i] + new + readme[j:]; open(readme_path, 'w').write(readme); print('README.md: the prompts section was rewritten')
        else: problems.append('the prompts section differs from what the plugin builds (run with --write)')
    # The hooks the README describes are the ones register.ts registers.
    code = open(os.path.join(REPO, 'hooks', 'register.ts')).read()
    hooks = set(re.findall(r"\bon\('([a-z.]+)'", code))
    hs = readme.split('### What each hook does', 1)
    listed = set(re.findall(r'^- `([a-z.]+)`', hs[1].split('\n## ', 1)[0], re.M)) if len(hs) > 1 else set()
    if hooks != listed: problems.append(f'hooks registered {sorted(hooks)} but README lists {sorted(listed)}')
    # The environment variables and engine calls are the validator's.
    v = subprocess.run([CLAUDE, 'plugin', 'validate', '--strict', os.path.join(REPO, '.claude-plugin', 'plugin.json')], capture_output=True, text=True)
    lines = [l.strip().lstrip('❯ ').strip() for l in (v.stdout + v.stderr).splitlines() if re.search(r'register\.ts (calls|env)', l)]
    reads = next((l.split('env reads:', 1)[1] for l in lines if 'env reads:' in l), '')
    env = {x.strip() for x in reads.split(',') if x.strip() and x.strip() != 'nothing'}
    rs = readme.split('### What it reads', 1)
    listed_env = set(re.findall(r'^  - `([A-Z_]+)`', rs[1].split('\n### ', 1)[0], re.M)) if len(rs) > 1 else set()
    if env != listed_env: problems.append(f'the plugin reads {sorted(env)} but README lists {sorted(listed_env)}')
    block = re.search(r'```\n(\./register\.ts calls:.*?)```', readme, re.S)
    if not block or [b.strip() for b in block.group(1).strip().splitlines()] != lines[:3]: problems.append('the block of engine calls differs from the validator\'s')
    for p in problems: print('FAIL ', p)
    print('README.md is exact' if not problems else f'{len(problems)} problem(s)')
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()
