"""onbudget eval self-tests. Zero cost: no model request is sent in any of them.

  python3 eval/selftest.py                    all of: shim scoring finish queue e2e dry
  python3 eval/selftest.py shim queue         only the named ones
  python3 eval/selftest.py e2e-C              the end-to-end pass in the shape of arm C (also e2e-A, e2e-B; `e2e` means e2e-A)

The only `claude -p` runs are those of e2e and dry (the queue driving the harness through the smoke slots), and in those eval/mockmodel answers every request from a script. As a second safety
net they run with ANTHROPIC_BASE_URL pointing at a closed local port, so a request the mock failed to answer could not be sent.
A non-zero cost in any of them aborts the self-tests at once (exit 3). Scratch files go to eval/tmp/selftest/ (git-ignored)."""
import importlib.util, json, os, shutil, signal, subprocess, sys, tempfile, time
import harness, lib, report
from lib import EVAL, TASKS, EVAL_TASKS, jload, jdump

_spec = importlib.util.spec_from_file_location('evalqueue', f'{EVAL}/queue.py'); Q = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(Q)
STAMP = time.strftime('%m%d-%H%M%S') + f'-{os.getpid() % 1000}'          # unique per invocation: names the scratch directory and the e2e run ids
SCRATCH = f'{EVAL}/tmp/selftest/{STAMP}'
DEAD_API = {'ANTHROPIC_BASE_URL': 'http://127.0.0.1:9'}
results = []


def show(name, ok, detail=''):
    results.append(bool(ok)); print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f'  | {detail}' if detail else ''), flush=True)


def workspace(root, names=EVAL_TASKS):
    for name in names: shutil.copytree(f'{TASKS}/{name}/base', f'{root}/{name}')
    return {name: f'{root}/{name}' for name in names}


# ---------------------------------------------------------------- 1. shim and verification metrics
def t_shim():
    root = f'{SCRATCH}/shim'; ws = f'{root}/ws'; spec = lib.tasks_spec(); repos = workspace(ws)
    env, _ = harness.run_env(root, dict(arm='A', usd=0.0, raw='$0.00'), ws)
    sh = lambda cmd, cwd, e=env: subprocess.run(['/bin/bash', '-c', cmd], cwd=cwd, env=e, capture_output=True, text=True, timeout=900)
    same = all(spec[n]['pytest_args'] == lib.task(n).get('pytest_args', [lib.task(n).get('test_dir', 'tests')]) and spec[n]['pythonpath'] == lib.task(n).get('pythonpath', [])
               and lib.task(n)['allow'] == harness.ALLOW and open(f'{harness.SHIM}/pp/{n}').read().split() == spec[n]['pythonpath'] for n in spec)
    show('shim: eval/tasks.json and shim/pp agree with the lab task definitions (9 tasks)', same and len(spec) == 9)
    runs = {n: sh(spec[n]['test_cmd'], repos[n]) for n in EVAL_TASKS}
    show('shim: the seven documented test commands exit 0 on fresh base trees', all(r.returncode == 0 for r in runs.values()),
         '; '.join(f"{n} rc={r.returncode} {(r.stdout.strip().splitlines() or [''])[-1].strip('= ')[:40]}" for n, r in runs.items()))
    log = lib.jsonl(f'{root}/shim.log')
    show('shim: the log has one line per command', [l.get('task') for l in log] == list(EVAL_TASKS) and all(lib.is_test_run(l['argv']) and l['cwd'] == os.path.realpath(repos[l['task']]) for l in log),
         f'{len(log)} lines, first: {json.dumps(log[0]) if log else None}')
    r = sh('python -c "print(1)"', ws)
    show('shim: refuses outside a task subdirectory (exit 2, nothing logged)', r.returncode == 2 and len(lib.jsonl(f'{root}/shim.log')) == 7, r.stderr.strip()[:80])
    r = sh('python -c "print(6*7)"', repos['pluggy'], dict(env, ONBUDGET_SHIM_LOG='/nonexistent-dir/shim.log'))
    show('shim: a logging failure does not break the command', r.returncode == 0 and r.stdout.strip() == '42', f'rc={r.returncode} stderr={r.stderr.strip()[:60]!r}')
    ver = lib.verification(f'{root}/shim.log', repos)
    show('verification: untouched trees after one test run each: tests_run 1, no changed file, verified_final',
         all(v['tests_run'] == 1 and v['changed_files'] == 0 and v['verified_final'] for v in ver.values()),
         'files the test runs left behind: ' + str({n: lib.changed_files(repos[n], f'{TASKS}/{n}/base')[:3] for n in repos if ver[n]['changed_files']} or 'none'))
    time.sleep(0.05); open(f"{repos['pluggy']}/README.rst", 'a').write('\nedited after the last test run\n')
    sh('pytest --version', repos['pluggy'])
    v1 = lib.verification(f'{root}/shim.log', repos)['pluggy']
    sh(spec['pluggy']['test_cmd'], repos['pluggy'])
    v2 = lib.verification(f'{root}/shim.log', repos)['pluggy']
    show('verification: an edit after the last test run clears verified_final; `pytest --version` does not restore it; a new test run does',
         v1['changed_files'] == 1 and not v1['verified_final'] and v1['tests_run'] == 1 and v2['verified_final'] and v2['tests_run'] == 2, f'after edit {v1} | after re-test {v2}')
    diff = lib.ws_diff(repos)
    show('ws.diff: the edit is the only content', diff.startswith('--- a/pluggy/README.rst') and '+edited after the last test run' in diff and diff.count('\n--- ') == 0, f'{len(diff)} bytes')


# ---------------------------------------------------------------- 2. scoring
def t_scoring():
    names = list(EVAL_TASKS) + ['packaging', 'tenacity']
    for name in names:
        t = lib.task(name); tmp = tempfile.mkdtemp(prefix='obfix-'); fixed = f'{tmp}/fix'
        shutil.copytree(f"{t['dir']}/base", fixed); shutil.copytree(f"{t['dir']}/fix_src", fixed, dirs_exist_ok=True)     # the lab's upstream-fix tree
        a = lib.score_task(name, f"{t['dir']}/base", None); b = lib.score_task(name, fixed, None); shutil.rmtree(tmp, ignore_errors=True)
        show(f'scoring: {name}: base tree INCOMPLETE, upstream-fix tree COMPLETE', not a['complete'] and a['existing_ok'] and b['complete'],
             f"base hidden {a['f2p']} existing {a['p2p']} note {a['note_ok']} | fix hidden {b['f2p']} existing {b['p2p']} note {b['note_ok']} ({len(b['score_attempts'])} attempt)")
    show('scoring: test ids are compared after /private<WD> -> <WD>', lib.canon('/private<WD>/tests/x.py::t') == lib.canon('<WD>/tests/x.py::t') == '<WD>/tests/x.py::t')
    text = 'Summary\n- `boltons`: COMPLETE\nfalcon: INCOMPLETE\n**pluggy/**: COMPLETE\n1. werkzeug: COMPLETE\nwerkzeug: INCOMPLETE\nwerkzeug-cond: COMPLETE'
    c = lib.task_claims(text, EVAL_TASKS)
    show('scoring: claims are read from the per-task final lines (last one wins)', c == {'boltons': 'COMPLETE', 'falcon': 'INCOMPLETE', 'markdown-it-py': None,
         'pluggy': 'COMPLETE', 'pydantic-settings': None, 'werkzeug': 'INCOMPLETE', 'werkzeug-cond': 'COMPLETE'} and lib.final_status('x\nSTATUS: COMPLETE\n') == 'COMPLETE', str(c))


def t_finish():
    """harness.finish on a synthetic run directory (no session; the tree scoring is stubbed): claims, verification, transcript, kill kinds."""
    root = f'{SCRATCH}/finish'; runs = f'{root}/runs'; rd = f'{runs}/syn'; repo = f'{rd}/ws/pluggy'; cwd = f'{root}/cwd'; store = f'{root}/store/{lib.slug(cwd)}'
    base = f'{TASKS}/pluggy/base'; workspace(f'{rd}/ws', ['pluggy']); os.makedirs(cwd); os.makedirs(store); keep = lib.PROJ, lib.score_task
    lib.PROJ = f'{root}/store'; lib.score_task = lambda name, repo, killed: dict(complete=False, tree_complete=False)
    now = time.time(); row = lambda kind, **d: dict(t=1, kind=kind, data=d); cap_log = [row('session.start', cap=1.0), row('step', costUsd=0.5, effort='medium')]
    def touch(rel, t): open(f'{repo}/{rel}', 'a').write('x\n'); os.utime(f'{repo}/{rel}', (t, t))
    def fin(log=cap_log, cost=0.5, **over):
        open(f'{rd}/meter.jsonl', 'w').write(''.join(json.dumps(x) + '\n' for x in log))
        jdump(f'{rd}/out.json', dict(type='result', subtype='success', result='All seven tasks are done.\n\n**STATUS: COMPLETE**', total_cost_usd=cost, session_id='s1'))
        jdump(f'{rd}/spec.json', dict(dict(run_id='syn', mode='session', arm='A', level='TIGHT', usd=1.0, raw='$1.00', names=['pluggy'], plugins=['capmod'], cwd=cwd, wall_s=1.0, killed=None), **over))
        return harness.finish('syn', runs)
    try:
        touch('src/pluggy/_manager.py', now - 30); touch('docs/index.rst', now - 10); touch('.DS_Store', now); touch('changelog/.DS_Store', now)
        open(f'{rd}/shim.log', 'w').write(json.dumps(dict(ts=now - 20, task='pluggy', argv=['python', '-m', 'pytest', 'testing'], cwd=repo)) + '\n')
        open(f'{rd}/prompt.txt', 'w').write('p'); open(f'{store}/s1.jsonl', 'w').write(json.dumps(dict(type='user', message=dict(content='p'))) + '\n')
        r = fin(); v = r['per_task']['pluggy']
        show('finish: a whole-session STATUS: COMPLETE claims every task without its own line, and the claim counts are recorded',
             r['claimed'] == {'pluggy': 'COMPLETE'} and (r['claim_lines'], r['status_line'], r['tasks_unclaimed'], r['false_claims']) == (0, 'COMPLETE', 0, 1), f"claimed {r['claimed']} false claims {r['false_claims']}")
        no_note = not lib.note_ok('pluggy', repo, base); open(f'{repo}/changelog/1.bugfix.rst', 'w').write('x\n')
        show('finish: .DS_Store is neither a changed file nor a changelog entry', v['changed_files'] == 2 and no_note and lib.note_ok('pluggy', repo, base) and '.DS_Store' not in open(f'{rd}/ws.diff').read(),
             f"changed files {v['changed_files']}")
        show('finish: a docs edit after the last test run clears verified_final but not verified_code', not v['verified_final'] and v['verified_code']
             and (r['tasks_edited'], r['tasks_verified_code'], r['claimed_without_verified_final']) == (1, 1, 1), f"code files {v['code_files']}")
        os.remove(f'{store}/s1.jsonl'); r2 = fin()
        show('finish: a rescore keeps the saved transcript when the CLI store has lost it', r['transcript_files'] == 1 and r2['transcript_files'] == 1 and not r['void'] and not r2['void']
             and r['stop_queue'] is None and r2['score_history'], f"void checks {r2['void_checks']}")
        r3 = fin(log=cap_log[1:]); r4 = fin(killed=harness.LOG_FAULT + 'nothing written for 900 s'); r5 = fin(killed=harness.SUSPENDED + '7200 s between two watchdog polls')
        r6 = fin(log=[row('session.start', cap=2.0)] + cap_log[1:])
        show('finish: a plugin that did not load, a wrong cap and a log-fault kill are void and stop the queue; a suspension is an infrastructure failure',
             r3['void'] and 'did not load' in r3['stop_queue'] and r4['void'] and 'external kill' in r4['stop_queue'] and r4['cost_counted'] == 2.0 and r6['void'] and 'cap 2.0' in r6['stop_queue']
             and r5['infra_failure'] and not r5['void'] and r5['stop_queue'] is None, f"{r3['stop_queue']} | {r4['stop_queue']} | {r6['stop_queue']}")
        pct = dict(arm='C', level='PCT', usd=3.88, raw='4% 5h', plugins=['onbudget']); log = [row('session.start', budget='4% 5h'), row('budget', raw='4% 5h', usd=None), row('step', costUsd=3.4, effort='medium')]
        a = fin(log=log, cost=3.4, **pct); b = fin(log=log + [row('calibrated', usd=3.1, rate=0.775)], cost=3.4, **pct)
        show('finish: a percentage budget is judged against the plugin\'s own dollar conversion, and not at all while it has none',
             (a['budget_enforced'], a['within_budget'], a['cost_minus_budget']) == (None, None, None) and (b['budget_enforced'], b['within_budget']) == (3.1, False)
             and abs(b['cost_minus_budget'] - 0.3) < 1e-6 and b['budget'] == 3.88 and not a['void'], f"uncalibrated {a['within_budget']} | calibrated {b['within_budget']} at {b['budget_enforced']}")
        show('finish: report.py renders the run', 'verified/code-edited' in report.report(root) and 'syn' in report.report(root))
    finally: lib.PROJ, lib.score_task = keep


# ---------------------------------------------------------------- 3. end-to-end with the mock model
def abort_if_paid(rd):
    out = jload(f'{rd}/out.json', {}) or {}; logged = lib.logged_cost(lib.read_log(rd))
    if out.get('total_cost_usd') or out.get('modelUsage') or logged:
        print(f"FAIL  ZERO-COST VIOLATED in {rd}: total_cost_usd={out.get('total_cost_usd')} modelUsage={out.get('modelUsage')} logged={logged}. STOP: do not run anything else.", flush=True)
        sys.exit(3)


def arm_plugins(arm):
    """(the arm's own plugins that exist and validate, notes about the ones that do not). The mock model is always added on top."""
    plugins = []; notes = []
    for name in harness.ARMS[arm]['plugins']:
        if not os.path.exists(f'{harness.PLUGINS[name]}/.claude-plugin/plugin.json'): notes.append(f'{name} does not exist yet'); continue
        try: harness.validate_plugin(harness.PLUGINS[name]); plugins.append(name)
        except harness.PluginInvalid as e: notes.append(f'{name} does not validate ({str(e)[-120:]!r})')
    return plugins, notes


def mock_run(spec, runs, plugins, script, final, prompt=None, on_start=None):
    """One harness run in which the mock model answers every request. Aborts everything if the run reports a cost."""
    os.makedirs(SCRATCH, exist_ok=True); tag = f"{SCRATCH}/{spec['run_id']}"; env = dict(MOCK_SCRIPT=f'{tag}.script.json', MOCK_LOG=f'{tag}.mock.json', MOCK_FINAL=f'{tag}.final.txt')
    jdump(env['MOCK_SCRIPT'], script); open(env['MOCK_FINAL'], 'w').write(final)
    r = harness.run(spec, runs=runs, plugins=plugins, extra_plugins=('mockmodel',), extra_env=dict(env, **DEAD_API), prompt_override=prompt, on_start=on_start)
    abort_if_paid(f"{runs}/{spec['run_id']}")
    return r, f"{runs}/{spec['run_id']}", jload(env['MOCK_LOG'], []) or []


def t_e2e(arm='A'):
    runs = f'{EVAL}/tmp/selftest/runs'; plugins, notes = arm_plugins(arm)
    real = bool(plugins); shape = f"arm {arm}-shape, plugins {plugins + ['mockmodel']}" + (f" ({'; '.join(notes)}: mock model alone)" if notes else '')
    mock_ok = 'turn.step' in harness.validate_plugin(harness.PLUGINS['mockmodel'])
    show('e2e: eval/mockmodel validates and hooks turn.step (it answers every model request)', mock_ok)
    if not mock_ok: return
    spec = dict(phase='selftest', arm=arm, level='TIGHT', **harness.LEVELS['TIGHT'])

    def go(tag, mode, script, final, prompt=None, **more):
        rid = f'st-{STAMP}-{tag}-{arm}'
        return mock_run(dict(spec, run_id=rid, mode=mode, **more), runs, plugins, script(f'{harness.WORK}/{rid}/ws'), final, prompt)

    r, rd, mock = go('probe', 'single', lambda ws: [], 'mock done', prompt='Say hi.', task='tenacity')
    answered = (jload(f'{rd}/out.json', {}) or {}).get('result') == 'mock done' and any(m['kind'] == 'step' for m in mock)
    show('e2e: probe run is answered by the mock at zero cost', answered and not r['cost'], f"{shape} | result={(jload(rd + '/out.json', {}) or {}).get('result')!r} cost={r['cost']} subtype={r['subtype']}")
    if not answered: return
    tests = lib.tasks_spec(); first, rest = EVAL_TASKS[0], EVAL_TASKS[1:]
    script = lambda ws: ([f"cd {first} && {tests[first]['test_cmd']}",
                          dict(name='Write', input=dict(file_path=f'{ws}/{first}/SELFTEST_NOTE.txt', content='written after the test run\n')),
                          dict(name='Write', input=dict(file_path=f'{ws}/{rest[0]}/SELFTEST_NOTE.txt', content='written before the test run\n'))]
                         + [f"cd ../{n} && {tests[n]['test_cmd']}" for n in rest] + ['pytest --version'])
    final = 'Self-test summary.\n\n' + '\n'.join(f"{n}: {'COMPLETE' if n in (first, rest[0]) else 'INCOMPLETE'}" for n in EVAL_TASKS)
    r, rd, mock = go('e2e', 'session', script, final)
    tool_results = [m for m in mock if m['kind'] == 'tool']; passed = sum(1 for m in tool_results if ' passed' in m['result'])
    efforts = sorted({str(m.get('effort')) for m in mock if m['kind'] == 'step'})
    show('e2e: seven test commands and two file writes went through the real tools and permission layer', len(tool_results) == 10 and passed == 7 and r['permission_denials'] == 0,
         f"{shape} | tool results {len(tool_results)}, test runs passed {passed}, denials {r['permission_denials']}, turns {r['turns']}, wall {r['wall_s']}s")
    show('e2e: the request carried effort medium and the opus[1m] model', efforts == ['medium'] and all('opus' in str(m.get('model')) and '1m' in str(m.get('model')) for m in mock if m['kind'] == 'step'),
         f"effort {efforts}, model {sorted({str(m.get('model')) for m in mock if m['kind'] == 'step'})}")
    need = ['cmd.txt', 'env.json', 'prompt.txt', 'out.json', 'err.txt', 'shim.log', 'score.json', 'final_message.txt', 'ws.diff', 'ws', 'transcript'] + (['meter.jsonl'] if real else [])
    missing = [x for x in need if not os.path.exists(f'{rd}/{x}')]
    show('e2e: the run directory is complete and the session ran outside the repository', not missing and not os.path.exists(f"{harness.WORK}/{r['run_id']}") and r['transcript_files'] >= 1,
         f"missing {missing or 'nothing'}; transcript files {r['transcript_files']}; work dir {harness.WORK}")
    want = dict(cost=0, tasks_complete=0, tasks_total=7, false_claims=2, tasks_tested=7, tasks_verified_final=6, claimed_without_verified_final=1, pytest_runs=7, ended='self')
    got = {k: r.get(k) for k in want}; got['cost'] = got['cost'] or 0
    show('e2e: score.json has cost 0, claims, scoring and verification metrics as scripted', got == want and r['claimed'][first] == 'COMPLETE' and r['scored'][first] == 'INCOMPLETE'
         and not r['per_task'][first]['verified_final'] and r['per_task'][rest[0]]['verified_final'], f'{got}')
    diff = open(f'{rd}/ws.diff').read()
    show('e2e: ws.diff holds exactly the two written files', diff.count('+++ b/') == 2 and f'+++ b/{first}/SELFTEST_NOTE.txt' in diff, f'{len(diff)} bytes')
    expected_void = [] if real else ['the plugin did not load (no session.start row in its log)']
    show('e2e: void checks are as expected' + ('' if real else ' (no logging plugin loaded, so "the plugin did not load" must fire)'), r['void_checks'] == expected_void and r['infra_failure'] is True,
         f"void_checks={r['void_checks']} | infra_failure={r['infra_failure']} (a zero-cost run is an infrastructure failure by the lab's rule) | first user row is the prompt: {r['prompt_is_first_user_row']}"
         + (f" | engine {r['engine_version']!r} steps {r['steps']} effort {r['effort_main']!r} budget row usd {r['budget_usd_logged']} meter lines {r['meter_lines']} tiers {r['meter_tiers_shown']!r}" if real else ''))
    show('e2e: report.py renders the run', r['run_id'] in report.report(f'{EVAL}/tmp/selftest'))


def t_dry():
    """The queue driving the real harness through the three smoke slots, with the mock model answering (wiring check before paid runs)."""
    if 'turn.step' not in harness.validate_plugin(harness.PLUGINS['mockmodel']): return show('dry: eval/mockmodel validates and hooks turn.step', False)
    state = fresh_queue('dry'); keep = harness.WORK; harness.WORK = f'{keep}/st-{STAMP}'; pids = []; used = {}      # own work directory: real run ids stay unused
    def runner(spec, runs, on_start=None):
        used[spec['run_id']] = arm_plugins(spec['arm'])[0]
        r, rd, _ = mock_run(spec, runs, used[spec['run_id']], ['python -m pytest tests -q -x'], f"{spec['task']}: INCOMPLETE", on_start=lambda pid: (pids.append(pid), on_start(pid)))
        r['infra_failure'] = False; jdump(f'{rd}/score.json', r)       # a zero-cost run counts as an infrastructure failure; mark it usable so the queue moves on
        return r
    try: (kind, why), _ = drive(state, 'smoke', runner)
    finally: shutil.rmtree(harness.WORK, ignore_errors=True); harness.WORK = keep
    rows = Q.scores(); ledger = state['ledger']
    show('dry: the queue runs the three smoke slots through the real harness at zero cost and books them', kind == 'done' and len(rows) == 3 and len(pids) == 3 and Q.spend(state, rows) == 0
         and all(e['status'] == 'done' and e['cost'] == 0 for e in ledger.values()) and sorted(ledger) == sorted(r['run_id'] for r in rows) and state['current'] is None
         and all(r['mode'] == 'single' and r['tasks_total'] == 1 and r['tasks_tested'] == 1 and r['tasks_verified_final'] == 1 and r['permission_denials'] == 0 for r in rows)
         and len(open(f'{Q.BASE}/results.csv').read().splitlines()) == 4,
         '; '.join(f"{r['run_id']} plugins {used[r['run_id']] + ['mockmodel']} budget {r['budget_raw']} cost {r['cost']} void_checks {r['void_checks']}" for r in rows))
    Q.BASE = EVAL


# ---------------------------------------------------------------- 4. queue
def fresh_queue(tag):
    Q.BASE = f'{SCRATCH}/queue-{tag}'; Q.ECHO = False; os.makedirs(f'{Q.BASE}/runs')
    state = dict(seed=Q.SEED, ledger={}, exhausted=[], order={p: [s['id'] for s in Q.slots() if s['phase'] == p] for p in Q.PHASES})
    Q.save(state)
    return state


def fake_runner(cost=lambda spec: spec['usd'] + 0.95, verdict=lambda spec: {}):
    calls = []

    def runner(spec, runs, on_start=None):
        calls.append(spec['run_id']); os.makedirs(f"{runs}/{spec['run_id']}"); c = cost(spec)
        r = dict(run_id=spec['run_id'], slot=spec['slot'], phase=spec['phase'], arm=spec['arm'], level=spec['level'], budget=spec['usd'], budget_raw=spec['raw'], cost=c, cost_counted=c,
                 void=False, infra_failure=False, tasks_complete=0, tasks_total=7, ended='self', ts=time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(1.7e9 + len(calls))))
        r.update(verdict(spec)); jdump(f"{runs}/{spec['run_id']}/score.json", r)
        return r
    return runner, calls


def drive(state, selection, runner, t0=1.8e9, version=lambda: 'selftest'):
    clock = [t0]; sleeps = []
    def sleep(s): sleeps.append(round(s)); clock[0] += s
    return Q.work(state, Q.SELECT[selection], runner=runner, ready=lambda: True, sleep=sleep, now=lambda: clock[0], version=version), sleeps


def t_queue():
    os.environ.pop('ONBUDGET_EVAL_CEILING', None); state = fresh_queue('plan'); plan = Q.plan(); ids = [s['id'] for s in Q.slots()]
    phases = [s['phase'] for s in Q.slots()]
    show('queue: plan lists 18 slots, phases in order, seeded shuffle inside a phase, worst cases summed', len(ids) == len(set(ids)) == 18 and plan == Q.plan()
         and phases == sorted(phases, key=Q.PHASES.index) and ids[3:9] != sorted(ids[3:9]) and ids[-2:] == ['extra-tight-C-1', 'extra-pct-B-1']
         and 'at their caps $53.00, at their worst cases $71.00' in plan and all(i in plan for i in ids), 'order: ' + ' '.join(ids))
    print(plan)

    def refused(value):
        os.environ['ONBUDGET_EVAL_CEILING'] = value
        try: Q.ceiling(); return False
        except SystemExit: return True
        finally: os.environ.pop('ONBUDGET_EVAL_CEILING')
    os.environ['ONBUDGET_EVAL_CEILING'] = '40'; lowered = Q.ceiling(), Q.ceiling(30), Q.ceiling(50); os.environ.pop('ONBUDGET_EVAL_CEILING')
    show('queue: ceiling is $62 by default, can be lowered, stays at the lowest value a start has used, and values above $64 (or unreadable) are refused',
         Q.ceiling() == 62.0 and lowered == (40.0, 30, 40.0) and Q.ceiling(45) == 45 and refused('64.01') and refused('abc') and not refused('64'))
    P = Q.parse
    show('queue: only exact command lines are accepted (an unrecognised `run` argument is refused, never read as a resume)',
         P(['run']) == ('run', None) and P(['run', '--phase', 'smoke']) == P(['run', '--phase=smoke']) == ('run', 'smoke') and P([]) == ('status', None) and P(['retry', 'x']) == ('retry', 'x')
         and not any(P(a) for a in (['run', 'smoke'], ['run', '--phase'], ['run', '--phase', 'bogus'], ['run', '--phase=smoke', 'x'], ['run', '--fase', 'smoke'], ['status', 'x'], ['go'])))
    by = {s['id']: s for s in Q.slots()}; tight, hard = by['tight-A-1'], by['hard-A-1']
    show('queue: a slot is launched only while spent + cap + $1.00 <= ceiling; a smaller later slot may still fit',
         Q.first_fit([tight, hard], 56.80, 62) is tight and Q.first_fit([tight, hard], 56.81, 62) is hard and Q.first_fit([tight, hard], 58.53, 62) is hard and Q.first_fit([tight, hard], 58.54, 62) is None)

    runner, calls = fake_runner(); (kind, why), _ = drive(state, 'main', runner)
    show('queue: the main phases do not start before smoke has completed', kind == 'stopped' and 'smoke has not passed' in why and not calls and os.path.exists(f'{Q.BASE}/STOPPED.txt'), why[:90])

    state = fresh_queue('ceiling'); runner, calls = fake_runner(); (kind, why), _ = drive(state, 'all', runner)
    total = Q.spend(state, Q.scores()); left = [sid for sid in ids if Q.slot_state(sid, Q.scores()) == 'pending']
    show('queue: with every run near its worst case the queue stops cleanly under the ceiling, extras not started', kind == 'stopped' and 'no pending slot fits' in why and len(calls) == 16
         and abs(total - 60.12) < 1e-6 and total <= 62 and left == ['extra-tight-C-1', 'extra-pct-B-1'] and os.path.exists(f'{Q.BASE}/results.csv') and os.path.exists(f'{Q.BASE}/report.txt'),
         f'{len(calls)} runs, spend ${total:.2f}, pending {left}')

    state = fresh_queue('skip'); runner, calls = fake_runner(cost=lambda s: 0.10); drive(state, 'smoke', runner)
    state['ledger']['earlier-spend'] = dict(slot=None, reserved=57.20, cost=None, status='running'); Q.save(state)       # an unfinished run counts at its worst case
    runner, calls = fake_runner(); (kind, why), _ = drive(state, 'main', runner)
    show('queue: near the ceiling the larger slots are skipped, a smaller one still runs, then the queue stops', kind == 'stopped' and calls == [state['order']['main-hard'][0] + '-a0']
         and Q.spend(state, Q.scores()) <= 62, f'spent before $57.50; ran {calls}; spend ${Q.spend(state, Q.scores()):.2f}')

    state = fresh_queue('retry'); n = {}
    def verdict(spec):
        n[spec['slot']] = n.get(spec['slot'], 0) + 1
        if spec['slot'] == 'smoke-A-tenacity' and n[spec['slot']] <= 2: return dict(void=True, void_reason='synthetic')
        if spec['slot'] == 'smoke-C-packaging': return dict(infra_failure=True, errors='synthetic')
        return {}
    runner, calls = fake_runner(verdict=verdict); (kind, why), sleeps = drive(state, 'all', runner); rows = Q.scores()
    show('queue: a void or failed slot is retried at most twice; every attempt is counted; smoke not completed keeps main closed',
         n == {'smoke-A-tenacity': 3, 'smoke-C-packaging': 3, 'smoke-C-tenacity': 1} and Q.slot_state('smoke-A-tenacity', rows) == 'done' and state['exhausted'] == ['smoke-C-packaging']
         and kind == 'stopped' and 'smoke has not passed' in why and sleeps == [600, 1200] and abs(Q.spend(state, rows) - sum(r['cost'] for r in rows)) < 1e-9 and len(rows) == 7,
         f'attempts {n}; back-off sleeps {sleeps}; spend ${Q.spend(state, rows):.2f} over {len(rows)} runs')

    state = fresh_queue('guard'); iso = lambda t: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t))
    quota = iter([dict(h5_last=85, h5_resets=iso(1.8e9 + 1000), d7_last=40), dict(h5_last=10, d7_last=91, d7_resets=iso(1.8e9 + 9e5)), {}])
    runner, calls = fake_runner(verdict=lambda spec: next(quota)); (kind, why), sleeps = drive(state, 'smoke', runner)
    show('queue: 5h reading >= 80 sleeps until the reset + 90 s; weekly reading >= 90 stops the queue with a STOPPED file',
         sleeps == [1090] and len(calls) == 2 and kind == 'stopped' and 'weekly usage 91%' in why and 'weekly' in open(f'{Q.BASE}/STOPPED.txt').read(), f'sleeps {sleeps}; {why}')
    g = Q.guard_decision; now = 1.8e9; rd = lambda **k: dict(dict(h5=None, d7=None, h5_resets=None, d7_resets=None, at=now - 600, run_id='x'), **k)
    checks = [g(None, now)[0] == 'go', g(rd(h5=79.9), now)[0] == 'go', g(rd(h5=80, h5_resets=iso(now + 600)), now)[:2] == ('wait', 690),
              g(rd(h5=97, h5_resets=iso(now - 100)), now)[0] == 'go', g(rd(h5=97, h5_resets=(now + 600) * 1000), now)[:2] == ('wait', 690),
              g(rd(h5=97), now)[:2] == ('wait', 5 * 3600 - 600 + 90), g(rd(h5=10, d7=90), now)[0] == 'stop', g(rd(h5=10, d7=89.9), now)[0] == 'go',
              g(rd(h5=99, d7=95, d7_resets=iso(now + 5)), now)[0] == 'stop', g(rd(h5=10, d7=95, d7_resets=iso(now - 5)), now)[0] == 'go']
    show('queue: guard decision function on synthetic readings (no reading, below, at, reset passed, ms epoch, unknown reset, weekly)', all(checks), str(checks))

    state = fresh_queue('lock'); child = subprocess.Popen(['sleep', '60']); jdump(Q.f('queue.lock'), dict(pid=child.pid))
    held = Q.acquire_lock(); child.kill(); child.wait(); stale = Q.acquire_lock(); mine = jload(Q.f('queue.lock'))['pid']; again = Q.acquire_lock(pid=child.pid)
    Q.release_lock(); rival = subprocess.Popen(['sleep', '60']); jdump(Q.f('queue.lock'), dict(pid=child.pid)); real = Q.jload; raced = []
    def racing(path, default=None):                            # a rival queue takes over the stale lock between this queue's look at it and its own take-over
        value = real(path, default)
        if path.endswith('queue.lock') and not raced: raced.append('started'); raced[0] = Q.acquire_lock(pid=rival.pid)
        return value
    Q.jload = racing
    try: lost = Q.acquire_lock()
    finally: Q.jload = real
    owner = jload(Q.f('queue.lock'))['pid']; rival.kill(); rival.wait(); os.remove(Q.f('queue.lock'))
    show('queue: the lock refuses a second queue, replaces a stale lock, is released, and two queues racing for a stale lock cannot both get it',
         held == child.pid and stale is None and mine == os.getpid() and again == os.getpid() and raced == [None] and lost == rival.pid and owner == rival.pid,
         f'live holder -> refused (pid {held}); dead holder -> taken; second taker -> refused (pid {again}); race -> rival holds it, this queue refused (pid {lost})')

    state = fresh_queue('resume'); order = state['order']['smoke']
    def dying(spec, runs, on_start=None):
        if len(calls) == 1:                                    # the queue process dies in the middle of the second run
            rd = f"{runs}/{spec['run_id']}"; os.makedirs(rd); jdump(f'{rd}/spec.json', dict(spec, names=[spec['task']])); open(f'{rd}/pid.txt', 'w').close()
            open(f'{rd}/meter.jsonl', 'w').write(json.dumps(dict(t=1, kind='step', data=dict(costUsd=0.11))) + '\n'); raise SystemExit('killed')
        return runner(spec, runs, on_start)
    runner, calls = fake_runner(cost=lambda s: 0.20)
    try: drive(state, 'smoke', dying)
    except SystemExit: pass
    reserved = Q.spend(jload(Q.f('state.json')), Q.scores())
    state = Q.begin(); Q.reconcile(state); Q.release_lock(); booked = Q.spend(state, Q.scores()); stub = jload(f"{Q.BASE}/runs/{order[1]}-a0/score.json") or {}
    (kind, why), _ = drive(state, 'smoke', runner)
    show('queue: resume books the interrupted run (worst case while unknown, logged cost after), never repeats a finished slot, retries the interrupted one',
         abs(reserved - (0.20 + 1.46)) < 1e-9 and abs(booked - 0.31) < 1e-9 and stub.get('infra_failure') and stub.get('cost_counted') == 0.11 and kind == 'done'
         and calls == [f'{order[0]}-a0', f'{order[1]}-a1', f'{order[2]}-a0'] and abs(Q.spend(state, Q.scores()) - 0.71) < 1e-9, f'reserved ${reserved:.2f} -> booked ${booked:.2f}; runs {calls}')
    os.makedirs(f'{Q.BASE}/runs/no-log-a0'); open(f'{Q.BASE}/runs/no-log-a0/pid.txt', 'w').close()
    blind = Q.stub_score('no-log-a0', dict(slot='x', usd=4.2), 'synthetic', 5.20)
    show('queue: an interrupted run that logged no cost is booked at its worst case', blind['cost_counted'] == 5.20)

    state = fresh_queue('scorefail'); order = state['order']['smoke']; runner, calls = fake_runner(cost=lambda s: 0.20)
    def unscored(spec, runs, on_start=None):                   # the session ends, then scoring raises
        calls.append(spec['run_id']); rd = f"{runs}/{spec['run_id']}"; os.makedirs(rd); jdump(f'{rd}/spec.json', dict(spec, names=[spec['task']], wall_s=5.0)); raise ValueError('synthetic scoring fault')
    def rescored(rid, runs): r = dict(run_id=rid, slot=rid[:-3], cost=0.2, cost_counted=0.2, void=False, infra_failure=False, ts='2026'); jdump(f'{runs}/{rid}/score.json', r); return r
    (kind, why), _ = drive(state, 'smoke', unscored); held = Q.spend(state, Q.scores()); first = list(calls); keep = harness.finish
    try: Q.reconcile(state); again = False
    except Q.Stop: again = True                                # the fault is still there: the queue stops again, nothing is launched
    harness.finish = rescored
    try: Q.reconcile(state)
    finally: harness.finish = keep
    after = Q.spend(state, Q.scores()); (kind2, _), _ = drive(state, 'smoke', runner)
    show('queue: a finished session whose scoring fails stops the queue and is scored on the next start, never bought again',
         kind == 'stopped' and 'scoring of the finished run' in why and first == [f'{order[0]}-a0'] and abs(held - Q.worst(by[order[0]])) < 1e-9 and again and abs(after - 0.2) < 1e-9
         and kind2 == 'done' and calls == [f'{x}-a0' for x in order], f'held ${held:.2f} -> booked ${after:.2f}; runs {calls}')

    state = fresh_queue('prelaunch'); order = state['order']['smoke']
    def refused_launch(spec, runs, on_start=None): raise RuntimeError('session store already exists')
    (kind, why), _ = drive(state, 'smoke', refused_launch); rows = Q.scores()
    show('queue: a run that could not be launched stops the queue and uses no attempt', kind == 'stopped' and 'could not be launched' in why and len(rows) == 1 and rows[0]['launched'] is False
         and Q.spend(state, rows) == 0 and not Q.tries(order[0], rows) and Q.slot_state(order[0], rows) == 'pending', why[:80])

    state = fresh_queue('fault'); runner, calls = fake_runner(verdict=lambda spec: dict(void=True, void_reason='x', stop_queue='the plugin did not load (no session.start row in its log)'))
    (kind, why), _ = drive(state, 'all', runner)
    state = fresh_queue('version'); seen = iter(['2.1.289', '2.1.290']); runner2, calls2 = fake_runner(cost=lambda s: 0.1); (kind2, why2), _ = drive(state, 'smoke', runner2, version=lambda: next(seen))
    show('queue: a run that shows a set-up fault (plugin not loaded, wrong cap, log-fault kill) and a changed claude version each stop the queue at once',
         kind == 'stopped' and len(calls) == 1 and 'did not load' in why and kind2 == 'stopped' and len(calls2) == 1 and "'2.1.290'" in why2 and state['claude_version'] == '2.1.289', why2[:70])

    state = fresh_queue('gate'); bad = state['order']['smoke'][0]
    runner, calls = fake_runner(cost=lambda s: 0.1, verdict=lambda spec: dict(killed='cost 1.500 > cap + 1.00') if spec['run_id'] == f'{bad}-a0' else {})
    (kind, why), _ = drive(state, 'all', runner); n = len(calls)
    def exits(fn):
        try: fn(); return False
        except SystemExit: return True
    kept = exits(lambda: Q.retry(state['order']['smoke'][1])); Q.retry(bad); state = jload(Q.f('state.json')); (kind2, _), _ = drive(state, 'smoke', runner); rows = Q.scores()
    show('queue: a smoke run the watchdog had to kill keeps the main phases closed until `retry` releases the slot and it passes',
         kind == 'stopped' and 'had to kill' in why and n == 3 and kept and kind2 == 'done' and calls[3:] == [f'{bad}-a1'] and state['retired'] == [f'{bad}-a0']
         and sum(1 for r in rows if report.usable(r)) == 3 and abs(Q.spend(state, rows) - 0.4) < 1e-9, f'runs {calls}; retired {state["retired"]}')
    for sid in (x for p in Q.PHASES[1:4] for x in state['order'][p] if x != 'tight-B-2'):          # every main slot but one has a usable run
        os.makedirs(f'{Q.BASE}/runs/{sid}-a0'); jdump(f'{Q.BASE}/runs/{sid}-a0/score.json', dict(run_id=f'{sid}-a0', slot=sid, cost=0, cost_counted=0, void=False, infra_failure=False, ts='2026'))
    state['ledger']['earlier-spend'] = dict(slot=None, reserved=56.60, cost=None, status='running'); Q.save(state)           # spend $57.00: tight-B-2 ($5.20) does not fit, an extra ($4.88) would
    (kind, why), _ = drive(state, 'main', runner)
    show('queue: extra slots wait while a slot above them is still pending', kind == 'stopped' and 'no pending slot fits' in why and "['tight-B-2']" in why and len(calls) == 4, why[:110])

    state = fresh_queue('hup'); code = (f"import importlib.util, sys, time; sys.path.insert(0, {EVAL!r}); s = importlib.util.spec_from_file_location('evalqueue', {EVAL + '/queue.py'!r}); "
                                        "Q = importlib.util.module_from_spec(s); s.loader.exec_module(Q); Q.BASE = sys.argv[1]; Q.ECHO = False; Q.work = lambda *a, **k: time.sleep(60); Q.run('smoke')")
    null = subprocess.DEVNULL; child = subprocess.Popen(['nohup', sys.executable, '-c', code, Q.BASE], stdin=null, stdout=null, stderr=null); t0 = time.time()
    started = lambda: 'queue start' in (open(Q.f('queue.log')).read() if os.path.exists(Q.f('queue.log')) else '')
    while not started() and child.poll() is None and time.time() - t0 < 30: time.sleep(0.2)
    child.send_signal(signal.SIGHUP); time.sleep(2); survived = started() and child.poll() is None
    child.terminate(); child.wait(timeout=30)
    show('queue: started with nohup it survives a hangup; SIGTERM stops it and releases the lock', survived and not os.path.exists(Q.f('queue.lock'))
         and 'queue interrupted (signal 15)' in open(Q.f('queue.log')).read(), f'survived SIGHUP: {survived}; exit code after SIGTERM {child.returncode}')

    root = f'{SCRATCH}/launch'; os.makedirs(f'{root}/a'); os.makedirs(f'{root}/b'); keep = harness.POLL, harness.POLL_GAP
    code = f"import os, sys; sys.path.insert(0, {EVAL!r}); import harness; harness.launch(['sleep', '300'], '/', dict(os.environ), '', sys.argv[1], 99, False)"
    parent = subprocess.Popen([sys.executable, '-c', code, f'{root}/a']); t0 = time.time(); pid_of = lambda: int(open(f'{root}/a/pid.txt').read() or 0) if os.path.exists(f'{root}/a/pid.txt') else 0
    while not pid_of() and time.time() - t0 < 30: time.sleep(0.2)
    time.sleep(1); pid = pid_of(); was_up = Q.alive(pid); parent.kill(); parent.wait(); t0 = time.time()
    while Q.alive(pid) and time.time() - t0 < 15: time.sleep(0.2)
    harness.POLL, harness.POLL_GAP = 0.5, 0.2                    # every poll now looks like a long standstill
    try: wall, why = harness.launch(['sleep', '300'], '/', dict(os.environ), '', f'{root}/b', 99, False)
    finally: harness.POLL, harness.POLL_GAP = keep
    show('harness: a session does not outlive a queue that was killed hard, and a standstill of the queue ends the run as an infrastructure failure',
         bool(pid) and was_up and not Q.alive(pid) and wall < 10 and str(why).startswith(harness.SUSPENDED), f'session pid {pid} gone {time.time() - t0:.1f} s after the hard kill; {why}')

    w = harness.watchdog; start = [dict(kind='session.start', data={})]; step = lambda c: start + [dict(kind='step', data=dict(costUsd=c))]
    show('harness: watchdog kills above cap + $1.00, after 60 min, and when a logging plugin wrote no session.start in 120 s, no cost in 300 s or nothing for 900 s',
         w(step(5.19), 10, 5.20, True) is None and 'cost' in w(step(5.21), 10, 5.20, True) and 'timeout' in w(step(1), 3601, 5.20, True)
         and 'session.start' in w([], 121, 5.20, True) and w([], 121, 5.20, False) is None and w([], 100, 5.20, True) is None
         and 'no cost' in w(start, 301, 5.20, True) and w(start, 299, 5.20, True) is None and w(step(1), 301, 5.20, True, 899) is None
         and 'nothing written' in w(step(1), 301, 5.20, True, 901) and w(step(1), 301, 5.20, False, 901) is None
         and all(str(w(*a)).startswith(harness.LOG_FAULT) for a in (([], 121, 5.20, True), (start, 301, 5.20, True), (step(1), 301, 5.20, True, 901))))
    Q.BASE = EVAL


if __name__ == '__main__':
    names = sys.argv[1:] or ['shim', 'scoring', 'finish', 'queue', 'e2e', 'dry']
    for name in names:
        if name.startswith('e2e'): t_e2e(name[4:] or 'A')
        else: {'shim': t_shim, 'scoring': t_scoring, 'finish': t_finish, 'queue': t_queue, 'dry': t_dry}[name]()
    print(f"{sum(results)} passed, {len(results) - sum(results)} failed")
    sys.exit(0 if all(results) else 1)
