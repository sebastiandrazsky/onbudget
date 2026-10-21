#!/usr/bin/env python3
"""Shows that two builds of onbudget send the model the same bytes.

Renders every text the model can receive from onbudget (tests/e2e/modeltext.render.ts: the meter line, the task and
its protocol, the note with a follow-up prompt, the reminder after a compaction, the refusal and fail-closed answers,
the effort sent, the countdown attachments) over a matrix of states, in each of two plugin folders, and compares them.
The harness (the render file and tests/world.ts) is taken from this repository and copied into both, so only the
plugins differ. Exits 1 when any text differs or a render did not run.

usage: python3 tests/e2e/modeltext.py <plugin folder A> <plugin folder B> [--out DIR]
       (ONBUDGET_CLAUDE_BIN selects the Claude Code build that runs the tests)
"""
import hashlib, json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CLAUDE = os.environ.get('ONBUDGET_CLAUDE_BIN', 'claude')


COVER = [
    ('task with protocol', 'You have a hard usage budget of '), ('meter', '[budget] '), ('tier HIGH', 'tier HIGH'), ('tier MEDIUM', 'tier MEDIUM'),
    ('tier LOW', 'tier LOW'), ('tier CRITICAL', 'tier CRITICAL'), ('in points', 'usage window has moved'), ('not sized yet', 'is not known yet'),
    ('a binding limit', "set by the account's 5-hour limit"), ('follow-up note', 'still applies to this message'), ('reminder', 'Reminder, in case'),
    ('reserve stop', 'and the next request could cost up to'), ('stop with requests running', 'still running'), ('wall stop', 'usage limit is close'),
    ('window stop', 'budgeted). The reading is account-wide'), ('calibrated window stop', 'more than twice the'), ('no reading', 'is not being reported'),
    ('subagent refusal', 'This subagent was stopped'), ('fail closed: ONBUDGET', 'the budget in ONBUDGET did not start'),
    ('fail closed: hook', 'its hook failed or timed out'), ('effort low', '"low"'), ('effort medium', '"medium"'), ('effort max', '"max"'),
    ('countdown left out', 'null'), ('countdown kept', '15000000 tokens left'),
]


def render(plugin, scratch, label):
    d = os.path.join(scratch, label)
    os.makedirs(os.path.join(d, 'tests'))
    for part in ('hooks', '.claude-plugin'):
        shutil.copytree(os.path.join(plugin, part), os.path.join(d, part))
    if os.path.exists(os.path.join(plugin, 'tsconfig.json')): shutil.copy(os.path.join(plugin, 'tsconfig.json'), d)
    shutil.copy(os.path.join(HERE, '..', 'world.ts'), os.path.join(d, 'tests', 'zz_world.ts'))
    shutil.copy(os.path.join(HERE, 'modeltext.render.ts'), os.path.join(d, 'tests', 'zz_modeltext.test.ts'))
    p = subprocess.run([CLAUDE, 'plugin', 'test', d], capture_output=True, text=True)
    text = p.stdout + '\n' + p.stderr  # a test's console output goes to one stream or the other, by build
    rows = [json.loads(l[len('MODELTEXT '):]) for l in text.splitlines() if l.startswith('MODELTEXT ')]
    tail = [l for l in text.strip().splitlines() if not l.startswith('MODELTEXT ')][-3:]
    return p.returncode, rows, tail


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    out = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else None
    if out: args = [a for a in args if a != out]
    if len(args) != 2: sys.exit(__doc__)
    scratch = tempfile.mkdtemp(prefix='onbudget-modeltext-')
    try:
        (ca, a, ta), (cb, b, tb) = render(args[0], scratch, 'a'), render(args[1], scratch, 'b')
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    blob = lambda rows: '\n'.join(json.dumps(r, ensure_ascii=False, sort_keys=True) for r in rows).encode()
    if out:
        os.makedirs(out, exist_ok=True)
        for name, rows in (('a', a), ('b', b)): open(os.path.join(out, f'modeltext-{name}.jsonl'), 'wb').write(blob(rows) + b'\n')
    ka, kb = {(r['part'], r['key']): r['value'] for r in a}, {(r['part'], r['key']): r['value'] for r in b}
    differ = sorted(k for k in set(ka) | set(kb) if ka.get(k, '<missing>') != kb.get(k, '<missing>'))
    for name, code, rows, tail in (('A', ca, a, ta), ('B', cb, b, tb)):
        parts = {}
        for r in rows: parts[r['part']] = parts.get(r['part'], 0) + 1
        print(f'{name}: {args[0] if name == "A" else args[1]}\n   tests exit {code}; {tail[-2] if len(tail) > 1 else tail}; texts {len(rows)} {parts}; sha256 {hashlib.sha256(blob(rows)).hexdigest()}')
    strings = sum(len(json.dumps(v, ensure_ascii=False)) for v in ka.values())
    print(f'compared {len(set(ka) | set(kb))} keys ({strings} characters of JSON); differing: {len(differ)}')
    for k in differ[:10]: print(f'  {k}:\n    A {json.dumps(ka.get(k, "<missing>"))[:300]}\n    B {json.dumps(kb.get(k, "<missing>"))[:300]}')
    # What the matrix reaches, counted on B's texts from the plugin's own hooks: each must be there at least once.
    hooks = json.dumps([r['value'] for r in b if r['part'] == 'hooks'], ensure_ascii=False)
    reach = {name: hooks.count(needle) for name, needle in COVER}
    print('coverage (hooks):', ', '.join(f'{k} {v}' for k, v in reach.items()))
    ok = ca == 0 and cb == 0 and len(a) > 0 and len(a) == len(b) and not differ and all(reach.values())
    print('IDENTICAL' if ok else 'DIFFERENT')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
