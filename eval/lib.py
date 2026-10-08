"""onbudget eval: shared helpers (stdlib only). Task loading, test runs and scoring are ported from the within-lab harness
(gate1/lib.py, gate1r55/rharness.py, ablation/aharness.py, v0/vharness.py); nothing is imported from the lab at run time.
The task fixtures themselves (base trees, hidden tests, venvs, oracles, statements) stay in the lab and are only read."""
import difflib, json, os, re, shutil, signal, subprocess, tempfile, threading, time
import xml.etree.ElementTree as ET

EVAL = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(EVAL)
LAB = os.path.expanduser(os.environ.get('ONBUDGET_LAB', '~/Documents/within-lab'))
TASKS = f'{LAB}/gate1/tasks'
PROJ = os.path.expanduser('~/.claude/projects')          # where Claude Code keeps session transcripts
EVAL_TASKS = ('boltons', 'falcon', 'markdown-it-py', 'pluggy', 'pydantic-settings', 'werkzeug', 'werkzeug-cond')
SKIP_DIRS = {'__pycache__', '.pytest_cache', '.git', 'venv', '.venv', '.hypothesis', '.mypy_cache', '.ruff_cache', '.tox'}
CEILING_DEFAULT, CEILING_MAX = 62.00, 64.00               # list-price dollars; the hard limit for all paid evaluation is $65
DOC_SUFFIXES = ('.rst', '.md', '.txt')                    # changed files that are prose, not code (verified_code ignores them)
NOT_A_TEST_RUN = {'--version', '-V', '--help', '-h', '--collect-only', '--co', '--fixtures', '--markers'}


def ceiling(persisted=None):
    """The spend ceiling of the queue. ONBUDGET_EVAL_CEILING can lower it; a value above CEILING_MAX is refused. `persisted` is the
    lowest ceiling an earlier start of this queue ran under (state.json): a resume without the variable does not raise it again."""
    raw = os.environ.get('ONBUDGET_EVAL_CEILING')
    try: c = float(raw) if raw else CEILING_DEFAULT
    except ValueError: c = -1
    if not 0 <= c <= CEILING_MAX: raise SystemExit(f'ONBUDGET_EVAL_CEILING={raw!r} refused: the ceiling may be lowered, never set above ${CEILING_MAX:.2f}')
    return min(c, persisted) if isinstance(persisted, (int, float)) else c


def jload(path, default=None):
    try:
        with open(path) as f: return json.load(f)
    except Exception: return default


def jdump(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f: json.dump(obj, f, indent=1)
    os.replace(tmp, path)


def jsonl(path):
    rows = []
    try:
        for line in open(path, errors='replace'):
            try: rows.append(json.loads(line))
            except Exception: pass                          # a partially written last line
    except OSError: pass
    return rows


def task(name):
    t = jload(f'{TASKS}/{name}/task.json'); t['dir'] = f'{TASKS}/{name}'
    return t


def tasks_spec():
    """Per task: the documented offline test command and the changelog rule (eval/tasks.json, copied from the lab's v0/tasks.json)."""
    return jload(f'{EVAL}/tasks.json') or {}


def clean_env(extra=None, task_=None):
    """The caller's environment without Claude Code / Anthropic variables, so a run never inherits another session's settings."""
    env = {k: v for k, v in os.environ.items()
           if not (k.startswith('CLAUDE') or k.startswith('ANTHROPIC_') or k == 'CLAUDECODE') or k == 'ANTHROPIC_BASE_URL'}
    if task_:
        env['PATH'] = f"{task_['dir']}/venv/bin:" + env['PATH']; env['VIRTUAL_ENV'] = f"{task_['dir']}/venv"
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    if extra: env.update(extra)
    return env


# ---------------------------------------------------------------- tests and scoring (lab logic)
def run_tests(workdir, t, timeout=300):
    """Run the task's scoring test command in workdir; return ({test_id: outcome}, seconds, rc, tail). Own process group, with a
    wall-clock and memory watchdog (hung tests can balloon RAM)."""
    xml = tempfile.mktemp(suffix='.xml')
    cmd = [f"{t['dir']}/venv/bin/python", '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--tb=no', '--continue-on-collection-errors',
           '--timeout=3', '--timeout-method=signal', f'--junitxml={xml}'] + t.get('pytest_args', [t.get('test_dir', 'tests')])
    env = clean_env(task_=t)
    if t.get('pythonpath'): env['PYTHONPATH'] = os.pathsep.join(os.path.join(workdir, p) for p in t['pythonpath'])
    t0 = time.time(); state = {'kill': None}
    p = subprocess.Popen(cmd, cwd=workdir, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)

    def watch():
        while p.poll() is None:
            if time.time() - t0 > timeout: state['kill'] = 'TIMEOUT'
            else:
                try:
                    rss = int(subprocess.run(['ps', '-o', 'rss=', '-p', str(p.pid)], capture_output=True, text=True).stdout.strip() or 0)
                    if rss > 6 * 1024 * 1024: state['kill'] = 'MEMORY'
                except Exception: pass
            if state['kill']:
                try: os.killpg(p.pid, signal.SIGKILL)
                except Exception: pass
                return
            time.sleep(0.5)

    th = threading.Thread(target=watch, daemon=True); th.start()
    out, _ = p.communicate(); th.join(timeout=2)
    rc = -9 if state['kill'] else p.returncode
    res = {}
    try:
        for tc in ET.parse(xml).getroot().iter('testcase'):
            tid = f"{tc.get('classname')}::{tc.get('name')}"
            for pre in {workdir, os.path.realpath(workdir)}: tid = tid.replace(pre, '<WD>')
            failed = tc.find('failure') is not None or tc.find('error') is not None
            res[tid] = 'fail' if failed else 'skip' if tc.find('skipped') is not None else 'pass'
    except Exception: pass
    try: os.remove(xml)
    except OSError: pass
    return res, time.time() - t0, rc, state['kill'] or (out or '')[-300:]


def overlay_hidden(workdir, t):
    """Restore the original tests, drop test files the agent added, overlay the hidden test files."""
    td = t.get('test_dir', 'tests')
    shutil.rmtree(os.path.join(workdir, td), ignore_errors=True)
    shutil.copytree(os.path.join(t['dir'], 'base', td), os.path.join(workdir, td))
    hidden = os.path.join(t['dir'], 'hidden')
    for root, _, files in os.walk(hidden):
        for fn in files:
            dst = os.path.join(workdir, os.path.relpath(os.path.join(root, fn), hidden))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(os.path.join(root, fn), dst)


def canon(test_id):
    """The working directory and its real path are replaced by <WD> in an order that varies between runs, so a test id that embeds
    the directory comes out as `<WD>/...` or `/private<WD>/...`. Both spellings name the same test (lab v0/DEVIATIONS.md)."""
    return test_id.replace('/private<WD>', '<WD>')


def score_once(tree, t):
    """Copy the tree, overlay the hidden tests, run them and compare with the oracle's fail-to-pass and pass-to-pass sets."""
    oracle = jload(f"{t['dir']}/oracle.json"); tmp = tempfile.mkdtemp(prefix='obscore-'); wd = os.path.join(tmp, 'w')
    shutil.copytree(tree, wd, ignore=shutil.ignore_patterns('.git', '__pycache__'), ignore_dangling_symlinks=True)
    overlay_hidden(wd, t)
    res, secs, rc, _ = run_tests(wd, t)
    shutil.rmtree(tmp, ignore_errors=True)
    res = {canon(k): v for k, v in res.items()}
    f2p = [canon(x) for x in oracle['f2p']]; p2p = [canon(x) for x in oracle['p2p']]
    fp = sum(1 for x in f2p if res.get(x) == 'pass'); pp = sum(1 for x in p2p if res.get(x) == 'pass')
    return dict(f2p_pass=fp, f2p_total=len(f2p), p2p_pass=pp, p2p_total=len(p2p), passed=(fp == len(f2p) and pp == len(p2p)), test_secs=round(secs, 1), rc=rc)


def score_tree(tree, t, attempts=2):
    """If the first scoring run does not pass (for any reason, including the 300 s watchdog), run the tests once more and keep the
    better result. A tree that really fails fails both times; a load or timeout artefact does not."""
    best = None; history = []
    for i in range(attempts):
        sc = score_once(tree, t)
        history.append(f"{sc['f2p_pass']}/{sc['f2p_total']} {sc['p2p_pass']}/{sc['p2p_total']} rc={sc['rc']} {sc['test_secs']}s")
        if best is None or sc['f2p_pass'] + sc['p2p_pass'] > best['f2p_pass'] + best['p2p_pass']: best = sc
        if sc['passed']: break
        if i + 1 < attempts: time.sleep(10)
    best['attempts'] = history
    return best


def differs(repo, base, rel):
    a, b = os.path.join(repo, rel), os.path.join(base, rel)
    if not os.path.isfile(a): return False
    return (not os.path.isfile(b)) or open(a, 'rb').read() != open(b, 'rb').read()


def note_ok(name, repo, base):
    """True when the task asks for no changelog entry, or the location the upstream fix changed has changed in this tree."""
    n = (tasks_spec().get(name) or {}).get('note')
    if not n: return True
    if n['kind'] == 'file_changed': return differs(repo, base, n['path'])
    if n['kind'] == 'file_differs':                           # the ablation's rule for packaging: a removed file also counts
        a, b = os.path.join(repo, n['path']), os.path.join(base, n['path'])
        return differs(repo, base, n['path']) if os.path.exists(a) else os.path.exists(b)
    listing = lambda d: [x for x in os.listdir(d) if not x.startswith('.')] if os.path.isdir(d) else []    # .DS_Store is not a changelog entry
    have = set(listing(os.path.join(base, n['path']))); new_dir = os.path.join(repo, n['path'])
    return any(f not in have and os.path.isfile(os.path.join(new_dir, f)) for f in listing(new_dir))


def score_task(name, repo, killed):
    t = task(name); sc = score_tree(repo, t); note = note_ok(name, repo, f"{t['dir']}/base")
    hidden = sc['f2p_pass'] == sc['f2p_total']; existing = sc['p2p_pass'] == sc['p2p_total']
    tree_complete = bool(hidden and existing and note)
    return dict(hidden_ok=hidden, existing_ok=existing, note_ok=note, tree_complete=tree_complete, complete=bool(tree_complete and not killed),
                f2p=f"{sc['f2p_pass']}/{sc['f2p_total']}", p2p=f"{sc['p2p_pass']}/{sc['p2p_total']}", test_secs=sc['test_secs'], score_attempts=sc['attempts'])


def task_claims(text, names):
    """Claimed status per task: the last line of the form `<task>: COMPLETE|INCOMPLETE` in the final message."""
    out = {}
    for name in names:
        rx = re.compile(r'^[\s>*\-`_|]*(?:\d+[.)]\s*)?[`*_]*' + re.escape(name) + r'/?[`*_\s]*:[`*_\s]*(COMPLETE|INCOMPLETE)\b')
        hits = [m.group(1) for m in (rx.match(line) for line in (text or '').splitlines()) if m]
        out[name] = hits[-1] if hits else None
    return out


def final_status(text):
    """The last `STATUS: COMPLETE|INCOMPLETE` line of the final message (the whole-session line the onbudget protocol asks for)."""
    hits = re.findall(r'^[\s>*`_]*STATUS:[`*_\s]*(COMPLETE|INCOMPLETE)\b', text or '', re.M)
    return hits[-1] if hits else None


# ---------------------------------------------------------------- plugin event log
def read_log(run_dir):
    """All rows of the plugin log, across its chunks (meter.jsonl, meter.jsonl.1, ...)."""
    rows = []; k = 0
    while os.path.exists(path := f'{run_dir}/meter.jsonl' + (f'.{k}' if k else '')):
        rows += jsonl(path); k += 1
    return [r for r in rows if isinstance(r, dict)]


def data(row):
    d = row.get('data')
    return d if isinstance(d, dict) else {}


def logged_cost(rows):
    cost = None
    for r in rows:
        d = data(r); kind = r.get('kind')
        v = d.get('costUsd') if kind == 'step' else (d.get('cost') or {}).get('usd') if kind in ('measure', 'end') and isinstance(d.get('cost'), dict) else None
        if isinstance(v, (int, float)): cost = v if cost is None else max(cost, v)
    return cost


def readings(rows):
    """[(five_hour, seven_day)] in log order, from every step, measure and end row that carries quota readings."""
    seq = []
    for r in rows:
        if r.get('kind') not in ('step', 'measure', 'end'): continue
        try: m = {x['kind']: x for x in (data(r).get('rateLimits') or [])}
        except Exception: continue
        if m.get('five_hour') or m.get('seven_day'): seq.append((m.get('five_hour'), m.get('seven_day')))
    return seq


def quota(rows):
    """First and last five_hour (h5) and seven_day (d7) readings of a plugin log, their last reset times and the 5h movement."""
    seq = readings(rows); num = lambda v: isinstance(v, (int, float))
    pick = lambda i, first, key='percentUsed': next((x[i].get(key) for x in (seq if first else reversed(seq)) if x[i]), None)
    q = dict(h5_first=pick(0, True), h5_last=pick(0, False), d7_first=pick(1, True), d7_last=pick(1, False),
             h5_resets=pick(0, False, 'resetsAt'), d7_resets=pick(1, False, 'resetsAt'), quota_readings=len(seq))
    q['h5_moved'] = round(q['h5_last'] - q['h5_first'], 3) if num(q['h5_first']) and num(q['h5_last']) else None
    return q


# ---------------------------------------------------------------- transcript audit
def slug(path):
    return re.sub(r'[^A-Za-z0-9]', '-', os.path.realpath(path))


def collect_transcript(cwd, run_dir):
    """Copy the session store of this run's working directory into the run dir, once: a later rescore audits the saved copy and
    never replaces it (the CLI prunes its store). Count traces of a CLI-announced dollar budget."""
    src = f'{PROJ}/{slug(cwd)}'; dst = f'{run_dir}/transcript'; files = usd = att = 0
    if os.path.isdir(src) and not os.path.isdir(dst):
        shutil.rmtree(dst + '.part', ignore_errors=True); shutil.copytree(src, dst + '.part'); os.rename(dst + '.part', dst)
    for root, _, names in os.walk(dst):
        for fn in names:
            if not fn.endswith('.jsonl'): continue
            text = open(os.path.join(root, fn), errors='replace').read(); files += 1
            usd += text.count('USD budget:'); att += len(re.findall(r'(?<!error_max_)budget_usd', text))
    return dict(transcript_files=files, usd_budget_lines=usd, budget_usd_attachments=att)


def first_user_is_prompt(run_dir, session_id, prompt):
    """True when the first user row of the session file is exactly the prompt, False when it differs (for example a plugin
    appended text to it), None when it cannot be read."""
    try:
        for row in jsonl(f'{run_dir}/transcript/{session_id}.jsonl'):
            if row.get('type') != 'user': continue
            c = (row.get('message') or {}).get('content')
            if isinstance(c, list): c = ''.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text')
            return isinstance(c, str) and c.strip() == prompt.strip()
    except Exception: pass
    return None


# ---------------------------------------------------------------- working-tree diff and verification metrics
def tree_files(root):
    out = set()
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
        out.update(os.path.relpath(os.path.join(d, f), root) for f in files if not f.endswith('.pyc') and f != '.DS_Store')
    return out


def changed_files(repo, base):
    """[(relative path, 'added' | 'modified' | 'removed')] of the tree against its base, ignoring caches and virtualenvs."""
    a, b = tree_files(repo), tree_files(base); out = []
    for rel in sorted(a | b):
        if rel not in b: out.append((rel, 'added'))
        elif rel not in a: out.append((rel, 'removed'))
        else:
            pa, pb = os.path.join(repo, rel), os.path.join(base, rel)
            try: same = os.path.getsize(pa) == os.path.getsize(pb) and open(pa, 'rb').read() == open(pb, 'rb').read()
            except OSError: same = False
            if not same: out.append((rel, 'modified'))
    return out


def ws_diff(repos, cap=2 * 1024 * 1024):
    """Unified diff of every task directory against its base tree; binary files are named only; capped at `cap` bytes."""
    def lines(path):
        try: raw = open(path, 'rb').read()
        except OSError: return []
        return None if b'\0' in raw else raw.decode('utf-8', 'replace').splitlines(keepends=True)
    out = []; size = 0
    for name, repo in repos.items():
        base = f'{TASKS}/{name}/base'
        for rel, kind in changed_files(repo, base):
            old = lines(os.path.join(base, rel)) if kind != 'added' else []; new = lines(os.path.join(repo, rel)) if kind != 'removed' else []
            if old is None or new is None: chunk = f'Binary file {name}/{rel} {kind}\n'
            else: chunk = ''.join(l if l.endswith('\n') else l + '\n\\ No newline at end of file\n' for l in difflib.unified_diff(old, new, f'a/{name}/{rel}', f'b/{name}/{rel}'))
            if size + len(chunk) > cap: return ''.join(out) + f'\n[diff truncated at {cap} bytes]\n'
            out.append(chunk); size += len(chunk)
    return ''.join(out)


def is_test_run(argv):
    """A shim invocation that runs pytest (`pytest ...` or `python -m pytest ...`), not one that only prints version or help."""
    argv = [str(a) for a in argv or []]
    return bool(argv) and (argv[0] == 'pytest' or 'pytest' in argv[1:] or '-mpytest' in argv[1:]) and not NOT_A_TEST_RUN & set(argv[1:])


def verification(shim_log, repos):
    """Per task: tests_run (pytest invocations seen by the shim), verified_final (the last of them started at or after the newest
    modification time of any file that differs from the base tree; with no differing file, any test run counts) and verified_code
    (the same over changed code files only, and false when no code file changed: a changelog or docs edit after the last test run
    does not clear it, and an untouched task cannot earn it). Whether the test run passed is not known."""
    calls = [r for r in jsonl(shim_log) if isinstance(r, dict) and isinstance(r.get('ts'), (int, float))]; out = {}
    newest = lambda xs: max(xs) if xs else None
    for name, repo in repos.items():
        runs = [r['ts'] for r in calls if r.get('task') == name and is_test_run(r.get('argv'))]
        note = ((tasks_spec().get(name) or {}).get('note') or {}).get('path'); changed = changed_files(repo, f'{TASKS}/{name}/base')
        edits = {True: [], False: []}                       # modification times of changed code files / changelog and docs files
        for rel, kind in changed:
            code = not rel.endswith(DOC_SUFFIXES) and not (note and (rel == note or rel.startswith(note + '/')))
            try: edits[code].append(os.path.getmtime(os.path.join(repo, rel)))
            except OSError: pass                            # a removed file has no time of its own
        last_edit, code_edit, last_test = newest(edits[True] + edits[False]), newest(edits[True]), newest(runs)
        out[name] = dict(tests_run=len(runs), shim_calls=sum(1 for r in calls if r.get('task') == name), changed_files=len(changed), code_files=len(edits[True]),
                         last_edit=last_edit, last_code_edit=code_edit, last_test=last_test, verified_final=bool(runs) and (last_edit is None or last_test >= last_edit),
                         verified_code=bool(runs) and code_edit is not None and last_test >= code_edit)
    return out
