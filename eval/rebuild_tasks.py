#!/usr/bin/env python3
"""Rebuild the task fixtures that eval/lib.py reads, from public sources only (stdlib only, Python 3).

    python3 eval/rebuild_tasks.py --lab DIR [--prove] [--python EXE] [names...]

With no names, all nine tasks of eval/upstream.json are rebuilt. For each task this writes, under DIR/gate1/tasks/<name>/ (the layout that
ONBUDGET_LAB=DIR gives eval/lib.py):

  base/        `git archive <parent>` of the upstream repository, plus a fresh .git with one commit "task base"
  fix_src/     `git archive <fix>`
  hidden/      the hidden test files as of the fix commit (`git show <fix>:<path>`)
  venv/        python -m venv, then `pip install` of the exact pins in upstream.json
  task.json    the fields the lab's task.json has
  statement.md the task statement, taken from eval/TASKS.md (checked against the SHA-256 in upstream.json)
  oracle.json  f2p, p2p, flaky_excluded, fix_failures, run statistics and a proof block

Clones of the upstream repositories go to DIR/clones/, scratch copies for the test runs to DIR/tmp/. Needs git, tar and network access to
github.com and PyPI. Nothing is written outside DIR, and a task directory that this script did not create is never overwritten
(--overwrite lifts that).

p2p lists are not kept in the repository (about 71,000 ids), so they are derived here by running the tests:
  without --prove  run the fix tree twice; p2p = tests that pass in both runs, minus f2p and the excluded ones in upstream.json
  with --prove     also run base + hidden files twice and the unmodified base once, exactly as the lab's oracle step did. A task passes when
                   every f2p id in upstream.json fails (or errors, or is missing) at base and passes at the fix, and the set of tests that
                   flip that way is exactly the f2p list. The one exception is f2p_spelling_artifacts in upstream.json: ids that the lab's
                   oracle listed as f2p only because a test id that embeds the scratch directory was spelled `<WD>/..` at base and
                   `/private<WD>/..` at the fix. Such an id must pass at base (with the spelling folded by lib.canon) and at the fix. p2p = tests that pass in all four runs, minus the excluded ones. The proof block
                   in oracle.json records the result. A p2p count that differs from upstream.json is printed as a warning, not a failure.

stdout gets one line per task (PASS or FAIL with --prove, BUILT without); progress and warnings go to stderr. The exit status is 1 if any
task failed. The Python version of upstream.json is the one the lab used; another version prints a warning and the run continues.
The "task base" commit takes the parent commit's date for author and committer, so its hash is the same on every rebuild.
"""
import argparse, hashlib, json, os, re, shutil, subprocess, sys, tempfile

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
ALLOW = ['Bash(python:*)', 'Bash(python3:*)', 'Bash(pytest:*)']          # same list as eval/harness.py
MARKER = '.rebuilt_by_rebuild_tasks'


def log(*a): print(*a, file=sys.stderr, flush=True)


def sh(cmd, cwd=None, env=None, check=True):
    p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True)
    if check and p.returncode:
        raise RuntimeError(f"{' '.join(map(str, cmd[:4]))} failed (rc={p.returncode}): " + p.stderr.decode('utf-8', 'replace').strip()[-400:])
    return p


def norm_req(line):
    name, _, ver = line.strip().partition('==')
    return re.sub(r'[-_.]+', '-', name).lower() + '==' + ver


def py_version(exe):
    return sh([exe, '-c', 'import platform; print(platform.python_version())']).stdout.decode().strip()


def load_statements(path, upstream):
    """The statements are the text between `<!-- statement:begin NAME -->` and `<!-- statement:end NAME -->` lines in eval/TASKS.md."""
    text = open(path, encoding='utf-8', newline='').read()
    found = {m.group(1): m.group(2) for m in re.finditer(r'<!-- statement:begin (\S+) -->\n(.*?)<!-- statement:end \1 -->', text, re.S)}
    for name, u in upstream.items():
        if name not in found: raise SystemExit(f'eval/TASKS.md has no statement for {name}')
        if hashlib.sha256(found[name].encode('utf-8')).hexdigest() != u['statement_sha256']:
            raise SystemExit(f'the statement of {name} in eval/TASKS.md does not match statement_sha256 in eval/upstream.json')
    return found


def ensure_clone(lab, u):
    d = os.path.join(lab, 'clones', u['repo'].replace('/', '__'))
    if not os.path.isdir(os.path.join(d, '.git')):
        os.makedirs(os.path.dirname(d), exist_ok=True)
        log(f"[{u['name']}] cloning {u['url']}")
        sh(['git', 'clone', '-q', '--filter=blob:none', u['url'] + '.git', d])
    for sha in (u['parent'], u['fix']):
        if sh(['git', 'cat-file', '-e', sha + '^{commit}'], cwd=d, check=False).returncode:
            log(f"[{u['name']}] fetching {sha[:10]}")
            sh(['git', 'fetch', '-q', 'origin'], cwd=d)
            sh(['git', 'cat-file', '-e', sha + '^{commit}'], cwd=d)
    return d


def extract(clone, sha, dest):
    os.makedirs(dest)
    g = subprocess.Popen(['git', 'archive', sha], cwd=clone, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    t = subprocess.run(['tar', '-x', '-C', dest], stdin=g.stdout, capture_output=True)
    g.stdout.close(); err = g.stderr.read().decode('utf-8', 'replace'); rc = g.wait()
    if rc or t.returncode: raise RuntimeError(f'git archive {sha[:10]} failed (rc={rc}, tar rc={t.returncode}): {err.strip()[-300:]} {t.stderr.decode()[-200:]}')


def make_venv(T, u, py):
    venv = os.path.join(T, 'venv'); pins = '\n'.join(u['requirements']) + '\n'
    keep = os.path.join(venv, '.pinned-requirements')
    if os.path.exists(os.path.join(venv, 'bin', 'python')) and os.path.exists(keep) and open(keep).read() == pins:
        log(f"[{u['name']}] venv already matches the pins, kept"); return
    shutil.rmtree(venv, ignore_errors=True)
    log(f"[{u['name']}] creating venv and installing {len(u['requirements'])} pinned packages")
    sh([py, '-m', 'venv', venv])
    req = os.path.join(T, 'requirements.txt'); open(req, 'w').write(pins)
    sh([os.path.join(venv, 'bin', 'python'), '-m', 'pip', 'install', '-q', '--disable-pip-version-check', '-r', req])
    got = {norm_req(l) for l in sh([os.path.join(venv, 'bin', 'python'), '-m', 'pip', 'freeze']).stdout.decode().split() if '==' in l}
    want = {norm_req(l) for l in u['requirements']}
    if got != want: log(f"[{u['name']}] WARNING: pip freeze differs from the pins: missing {sorted(want - got)[:5]}, extra {sorted(got - want)[:5]}")
    open(keep, 'w').write(pins)


def write_task_json(lib, T, u):
    t = dict(name=u['name'], repo=u['repo'], url=u['url'], lang='python', parent=u['parent'], fix=u['fix'])
    if 'parent_date' in u: t['parent_date'] = u['parent_date']
    t.update(test_dir=u['test_dir'], pythonpath=u['pythonpath'], hidden_files=u['hidden_files'], allow=ALLOW, license=u['license'], pr=u['pr'],
             pr_title=u['pr_title'], merged=u['merged'])
    if u['pytest_args'] != [u['test_dir']]: t['pytest_args'] = u['pytest_args']          # the lab's task.json omits it when it is the default
    if u.get('notes'): t['notes'] = u['notes']
    if 'repo_key' in u: t['repo_key'] = u['repo_key']
    lib.jdump(os.path.join(T, 'task.json'), t)


def build(lib, lab, name, u, statement, py):
    T = os.path.join(lab, 'gate1', 'tasks', name)
    os.makedirs(T, exist_ok=True); open(os.path.join(T, MARKER), 'w').write('created by eval/rebuild_tasks.py\n')
    clone = ensure_clone(lab, u)
    for d in ('base', 'fix_src', 'hidden'): shutil.rmtree(os.path.join(T, d), ignore_errors=True)
    log(f'[{name}] extracting base {u["parent"][:10]} and fix {u["fix"][:10]}')
    extract(clone, u['parent'], os.path.join(T, 'base')); extract(clone, u['fix'], os.path.join(T, 'fix_src'))
    for f in u['hidden_files']:
        dst = os.path.join(T, 'hidden', f); os.makedirs(os.path.dirname(dst), exist_ok=True)
        open(dst, 'wb').write(sh(['git', 'show', f"{u['fix']}:{f}"], cwd=clone).stdout)
    date = sh(['git', 'log', '-1', '--format=%cI', u['parent']], cwd=clone).stdout.decode().strip()
    env = dict(os.environ, GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
    cfg = ['-c', 'core.excludesFile=/dev/null', '-c', 'core.autocrlf=false', '-c', 'user.name=gate1', '-c', 'user.email=gate1@local']
    b = os.path.join(T, 'base')
    sh(['git', 'init', '-q', '-b', 'main'], cwd=b); sh(['git'] + cfg + ['add', '-A'], cwd=b)
    sh(['git'] + cfg + ['commit', '-qm', 'task base'], cwd=b, env=env)
    make_venv(T, u, py)
    open(os.path.join(T, 'statement.md'), 'w', encoding='utf-8', newline='').write(statement)
    write_task_json(lib, T, u)
    return T


def copy_tree(src, dst):
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns('.git', '__pycache__'), ignore_dangling_symlinks=True)


def run_side(lib, tree, t, label, name):
    for attempt in (1, 2):                                                    # like lib.score_tree: a run killed by the 300 s watchdog is repeated once
        res, secs, rc, tail = lib.run_tests(tree, t)
        if res: break
        log(f'[{name}] {label}: no results (rc={rc}, {str(tail)[-80:]!r})' + (', trying once more' if attempt == 1 else ''))
    if not res: raise RuntimeError(f'no test results at {label} (rc={rc}): {str(tail)[-200:]}')
    log(f'[{name}] {label}: {len(res)} tests, {sum(v == "pass" for v in res.values())} pass, {secs:.0f}s')
    return {lib.canon(k): v for k, v in res.items()}, secs


def stats(r, secs, failed=False):
    d = dict(n=len(r), passed=sum(o == 'pass' for o in r.values()), secs=round(secs, 1))
    if failed: d['failed'] = sum(o == 'fail' for o in r.values())
    return d


def score(lib, lab, name, u, T, prove):
    """Run the tests and write oracle.json. Returns (ok, summary text)."""
    t = lib.task(name); canon = lib.canon
    listed = sorted(u['f2p']); L = {canon(x) for x in listed}
    art = {canon(x) for x in u.get('f2p_spelling_artifacts', [])}              # listed f2p ids that really pass at base (see the docstring)
    keep_out = {canon(x) for x in u['flaky_excluded'] + u['fix_failures']}
    tmp = tempfile.mkdtemp(prefix=name + '-', dir=os.path.join(lab, 'tmp'))
    try:
        b = os.path.join(tmp, 'b'); copy_tree(os.path.join(T, 'fix_src'), b)
        for root, _, files in os.walk(os.path.join(T, 'hidden')):          # the hidden files, laid over the fix tree
            for fn in files:
                dst = os.path.join(b, os.path.relpath(os.path.join(root, fn), os.path.join(T, 'hidden')))
                os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copy2(os.path.join(root, fn), dst)
        rb, db = run_side(lib, b, t, 'fix', name); rb2, _ = run_side(lib, b, t, 'fix again', name)
        if not prove:
            p2p = sorted(x for x, o in rb.items() if o == 'pass' and rb2.get(x) == 'pass' and x not in L and x not in keep_out)
            out = dict(f2p=listed, p2p=p2p, flaky_excluded=sorted(u['flaky_excluded']), fix_failures=sorted(u['fix_failures']),
                       fix=stats(rb, db, True), proof=dict(proved=False, n_f2p=len(listed), n_p2p=len(p2p)))
            lib.jdump(os.path.join(T, 'oracle.json'), out)
            return True, f'f2p {len(listed)} (from upstream.json), p2p {len(p2p)} (upstream.json {u["n_p2p"]}); not proved, rerun with --prove', len(p2p)
        a = os.path.join(tmp, 'a'); copy_tree(os.path.join(T, 'base'), a); lib.overlay_hidden(a, t)
        ra, da = run_side(lib, a, t, 'base + hidden', name); ra2, _ = run_side(lib, a, t, 'base + hidden again', name)
        c = os.path.join(tmp, 'c'); copy_tree(os.path.join(T, 'base'), c)
        rc_, dc = run_side(lib, c, t, 'base, original tests', name)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    stable_fix = lambda x: rb.get(x) == 'pass' and rb2.get(x) == 'pass'
    f2p_d = {x for x in rb if stable_fix(x) and ra.get(x) != 'pass' and ra2.get(x) != 'pass'}
    p2p = sorted(x for x in rb if stable_fix(x) and ra.get(x) == 'pass' and ra2.get(x) == 'pass' and x not in keep_out and x not in L)
    flaky = sorted({x for x in set(rb) | set(rb2) | set(ra) | set(ra2) if x not in f2p_d and x not in p2p and x not in L and (rb.get(x) == 'pass' or rb2.get(x) == 'pass')
                    and (ra.get(x) == 'pass' or ra2.get(x) == 'pass' or rb.get(x) != rb2.get(x))} | {canon(x) for x in u['flaky_excluded']})
    broken = sorted({x for x, o in rb.items() if o == 'fail'} | {canon(x) for x in u['fix_failures']})
    real = L - art                                                            # ids that must flip from not-passing to passing
    fail_at_base = [x for x in real if ra.get(x) != 'pass' and ra2.get(x) != 'pass']
    art_pass = [x for x in art if ra.get(x) == 'pass' and ra2.get(x) == 'pass']     # an artifact id must really pass at base, or it is not one
    pass_at_fix = [x for x in L if stable_fix(x)]
    ok = len(fail_at_base) == len(real) and len(art_pass) == len(art) and len(pass_at_fix) == len(L) and f2p_d == real
    proof = dict(f2p_fail_at_parent=len(fail_at_base) == len(real), f2p_pass_at_fix=len(pass_at_fix) == len(L), n_f2p=len(L), n_p2p=len(p2p),
                 f2p_set_equals_upstream_json=f2p_d == real, f2p_spelling_artifacts=len(art), proved=True)
    out = dict(f2p=listed, p2p=p2p, flaky_excluded=flaky, fix_failures=broken, parent_original=stats(rc_, dc),
               parent_plus_hidden=stats(ra, da, True), fix=stats(rb, db, True), proof=proof)
    lib.jdump(os.path.join(T, 'oracle.json'), out)
    msg = f'f2p {len(L)}: fail at base {len(fail_at_base)}/{len(real)}, pass at fix {len(pass_at_fix)}/{len(L)}; p2p {len(p2p)} (upstream.json {u["n_p2p"]})'
    if art: msg += f'; {len(art_pass)}/{len(art)} listed ids pass at base under another path spelling (lab artifact, see f2p_spelling_artifacts)'
    if f2p_d != real: msg += f'; flipping tests not in f2p: {len(f2p_d - real)}, f2p not flipping: {len(real - f2p_d)}'
    return ok, msg, len(p2p)


def main():
    ap = argparse.ArgumentParser(description='Rebuild the lab layout that eval/lib.py reads, from public sources.')
    ap.add_argument('--lab', required=True, help='directory to build in; use it as ONBUDGET_LAB afterwards')
    ap.add_argument('--prove', action='store_true', help='also run base + hidden files and check every f2p test flips from fail to pass')
    ap.add_argument('--python', default=sys.executable, help='interpreter for the task venvs (default: the one running this script)')
    ap.add_argument('--overwrite', action='store_true', help='allow replacing a task directory this script did not create')
    ap.add_argument('names', nargs='*', help='tasks to rebuild (default: all)')
    args = ap.parse_args()
    upstream = json.load(open(os.path.join(HERE, 'upstream.json'), encoding='utf-8'))['tasks']
    names = args.names or list(upstream)
    bad = [n for n in names if n not in upstream]
    if bad: raise SystemExit(f'unknown task(s) {bad}; known: {list(upstream)}')
    statements = load_statements(os.path.join(HERE, 'TASKS.md'), {n: upstream[n] for n in names})
    lab = os.path.abspath(os.path.expanduser(args.lab))
    for n in names:                                                           # before anything is written: never touch a directory this script did not make
        T = os.path.join(lab, 'gate1', 'tasks', n)
        if os.path.isdir(T) and os.listdir(T) and not os.path.exists(os.path.join(T, MARKER)) and not args.overwrite:
            raise SystemExit(f'{T} exists and was not created by this script; refusing to touch it (--overwrite to allow)')
    os.makedirs(os.path.join(lab, 'tmp'), exist_ok=True)
    os.environ['ONBUDGET_LAB'] = lab                                          # eval/lib.py reads this when it is imported
    tempfile.tempdir = os.path.join(lab, 'tmp')                               # keeps lib's scratch directories inside DIR
    sys.path.insert(0, HERE)
    import lib
    assert lib.TASKS == os.path.join(lab, 'gate1', 'tasks'), lib.TASKS
    have = py_version(args.python); failed = 0
    for name in names:
        u = upstream[name]
        if have != u['python']: log(f'[{name}] WARNING: the lab used Python {u["python"]}, this run uses {have}; test results may differ')
        try:
            T = build(lib, lab, name, u, statements[name], args.python)
            ok, msg, _ = score(lib, lab, name, u, T, args.prove)
            word = ('PASS' if ok else 'FAIL') if args.prove else 'BUILT'
        except Exception as e:                                                # one task failing does not stop the others
            word, msg = 'FAIL', f'{type(e).__name__}: {e}'
        failed += word == 'FAIL'
        print(f'{word} {name}: {msg}; Python {have} (lab {u["python"]})', flush=True)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
