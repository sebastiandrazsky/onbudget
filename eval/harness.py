"""onbudget eval harness: one headless Claude Code run (the seven-task session, or one task), then scoring from the working tree.

  python3 eval/harness.py rescore <run_id>      score a finished run's saved artifacts again (earlier values kept in score_history)

Arms differ only in the prompt's budget paragraph and in the plugin that is loaded; model, effort, tools, prompt body, scoring and
the external watchdog are the same. Launch flags mirror the lab's vharness.claude_cmd (no --max-budget-usd), with --effort medium.
Arm D, added in the second round, is the one exception: plain Claude Code under its own --max-budget-usd."""
import glob, os, re, shutil, signal, subprocess, sys, time
import lib
from lib import EVAL, ROOT, TASKS, EVAL_TASKS, jload, jdump

RUNS = f'{EVAL}/runs'
SHIM = f'{EVAL}/shim'
WORK = os.path.expanduser(os.environ.get('ONBUDGET_EVAL_WORK', f'{os.path.dirname(ROOT)}/.onbudget-eval-work'))   # sessions run here, outside any git repository
CLAUDE = os.environ.get('ONBUDGET_CLAUDE_BIN', 'claude')
MODEL, EFFORT = 'opus[1m]', 'medium'
KILL_OVER = 1.00                   # external kill when logged cost > cap + this
MAX_SECS = 3600                    # external kill after 60 minutes
LOG_GRACE, COST_GRACE, LOG_STALE = 120, 300, 900   # external kill when a logging plugin has written no session.start row / no cost / nothing new for this many seconds
LOG_FAULT = 'plugin log: '         # kill reasons that start so mean the plugin's log, and with it its cap, cannot be trusted
SUSPENDED = 'suspended: '          # kill reason when the queue itself stood still (machine sleep, Ctrl-Z): an infrastructure failure
POLL, POLL_GAP = 5, 120
ALLOW = ['Bash(python:*)', 'Bash(python3:*)', 'Bash(pytest:*)']
PLUGINS = {'capmod': f'{EVAL}/capmod', 'onbudget': ROOT, 'mockmodel': f'{EVAL}/mockmodel'}
LOGGING_PLUGINS = ('capmod', 'onbudget')
ARMS = {'A': dict(label='plain', plugins=('capmod',), budget_text=False),
        'A0': dict(label='plain, simple cap', plugins=('capmod',), budget_text=False, env=dict(CAP_RULE='simple')),   # added after the first results: see README
        'B': dict(label='prompt-only', plugins=('capmod',), budget_text=True),
        'C': dict(label='onbudget', plugins=('onbudget',), budget_text=False),
        # Second round: plain Claude Code capped by its own --max-budget-usd. capmod only logs (CAP_RULE=off), for the watchdog's
        # cost rule and the per-request accounting; it refuses nothing and changes nothing the model sees.
        'D': dict(label='plain, --max-budget-usd', plugins=('capmod',), budget_text=False, env=dict(CAP_RULE='off'), max_budget=True)}
LEVELS = {'TIGHT': dict(usd=4.20, raw='$4.20'), 'HARD': dict(usd=2.47, raw='$2.47'),      # frozen in the lab's v0/reference.json
          'PCT': dict(usd=3.88, raw='4% 5h')}                                              # 4 x the lab's $0.97 per 5h point; harness cap only
STRIP_ENV = ('ONBUDGET', 'CAP_', 'MOCK_', 'WITHIN_')                                       # never inherited from the operator's shell
FINAL_LINE = 'End your final message with one line per task, in the form `<task>: COMPLETE` or `<task>: INCOMPLETE`.'
HEADER = ('This workspace contains seven independent tasks. Each task is in its own subdirectory, named after the task, and all seven are requested: '
          + ', '.join(f'`{t}/`' for t in EVAL_TASKS) + '. The session starts in the workspace root.\n'
          'Each task statement below describes its own subdirectory: where a statement says the current directory is the repository root, '
          "that root is the task's subdirectory. `python` and `pytest` use a task's installed environment only when they are run from inside "
          "that task's subdirectory, so run each task's offline test command from inside its subdirectory.")
_TIER_RE = re.compile(r'tier[\s:=]+(\w+)', re.I)
DEADMAN = '''import os, signal, sys, time
pid, parent, limit = map(int, sys.argv[1:]); t0 = time.time()
def up(p):
    try: os.kill(p, 0); return True
    except PermissionError: return True
    except OSError: return False
while up(pid):
    if not up(parent) or time.time() - t0 > limit:
        try: os.killpg(pid, signal.SIGKILL)
        except OSError: pass
        break
    time.sleep(2)
'''                                # detached helper: the session never outlives a queue that died without running its `finally`


class PluginInvalid(RuntimeError):
    pass


# ---------------------------------------------------------------- prompt, command, environment
def budget_paragraph(raw):
    m = re.fullmatch(r'(\d+(?:\.\d+)?)%\s*5h', raw)
    what = f'{m.group(1)}% of my 5-hour Claude usage limit' if m else f'{raw} (API-equivalent cost)'
    return (f'I have a usage budget of {what} for this entire session. Stay within it: prioritise finishing and verifying as many of '
            'the tasks as you can, and stop before you exceed it.')


def session_prompt(arm, raw):
    spec = lib.tasks_spec(); parts = [HEADER]
    for i, name in enumerate(EVAL_TASKS, 1):
        statement = open(f'{TASKS}/{name}/statement.md').read().strip()
        parts.append(f"## Task {i} of {len(EVAL_TASKS)}: {name} (subdirectory `{name}/`)\nOffline test command, run from inside `{name}/`: `{spec[name]['test_cmd']}`\n\n{statement}")
    if ARMS[arm]['budget_text']: parts.append(budget_paragraph(raw))
    return '\n\n'.join(parts + [FINAL_LINE])


def single_prompt(arm, raw, task):
    statement = open(f'{TASKS}/{task}/statement.md').read().strip()
    return statement + ('\n\n' + budget_paragraph(raw) if ARMS[arm]['budget_text'] else '')


def claude_cmd(plugin_dirs, max_budget=None):
    cmd = [CLAUDE, '-p', '--output-format', 'json']
    for d in plugin_dirs: cmd += ['--plugin-dir', d]
    cmd += ['--permission-mode', 'acceptEdits', '--setting-sources', 'project,local', '--strict-mcp-config', '--disable-slash-commands',
            '--allowedTools', ','.join(ALLOW), '--disallowedTools', 'WebFetch,WebSearch', '--model', MODEL, '--effort', EFFORT]
    assert not {'--max-budget-usd', '--no-session-persistence', '--continue', '--resume'} & set(cmd)
    return cmd + (['--max-budget-usd', f'{max_budget:.2f}'] if max_budget is not None else [])


def run_env(run_dir, spec, ws, extra=None):
    """(full environment, the variables the harness sets). The second is what env.json records."""
    ours = dict(CLAUDE_CODE_ENABLE_FUNCTION_HOOKS='1', DISABLE_AUTOUPDATER='1', WITHIN_WS=os.path.realpath(ws), WITHIN_TASKS=TASKS, ONBUDGET_SHIM_LOG=f'{run_dir}/shim.log')
    if spec['arm'] == 'C': ours.update(ONBUDGET=spec['raw'], ONBUDGET_LOG='1')   # the log: see link_log
    else: ours.update(CAP_USD=f"{spec['usd']:.2f}", CAP_LOG=f'{run_dir}/meter.jsonl', **(ARMS[spec['arm']].get('env') or {}))
    ours.update(extra or {})
    env = {k: v for k, v in lib.clean_env().items() if not k.startswith(STRIP_ENV)}
    env.update(ours); env['PATH'] = f'{SHIM}:' + env['PATH']
    return env, ours


def claude_version():
    try: return subprocess.run([CLAUDE, '--version'], env=lib.clean_env(), capture_output=True, text=True, timeout=60).stdout.strip()
    except Exception as e: return f'unknown ({type(e).__name__})'


def validate_plugin(path):
    """Zero-cost gate before every launch: a plugin that does not load enforces nothing, so refuse to start a run with one. The
    plugin manifest is named explicitly (for a directory that also holds a marketplace.json the CLI would check only that), and
    the hooks module must hook turn.step, the event on which every plugin here caps or answers model requests."""
    manifest = f'{path}/.claude-plugin/plugin.json'
    try:
        r = subprocess.run([CLAUDE, 'plugin', 'validate', manifest if os.path.exists(manifest) else path], env=lib.clean_env(), capture_output=True, text=True, timeout=120)
        out = r.stdout + r.stderr; ok = r.returncode == 0 and 'Validation passed' in out and 'turn.step' in out
    except Exception as e: out, ok = repr(e), False
    if not ok: raise PluginInvalid(f'the plugin at {path} does not validate; no run started: {out[-600:]}')
    return out


def context_files(start):
    """Memory and settings files Claude Code would pick up from the directories above the workspace, and any enclosing git repository."""
    found = []; d = os.path.realpath(start); home = os.path.expanduser('~')
    while True:
        names = ('CLAUDE.md', 'CLAUDE.local.md', '.git') + (('.claude/CLAUDE.md', '.claude/settings.json', '.claude/settings.local.json') if d != home else ())
        found += [os.path.join(d, x) for x in names if os.path.exists(os.path.join(d, x))]
        if d == os.path.dirname(d) or d == home: return found
        d = os.path.dirname(d)


# ---------------------------------------------------------------- onbudget's event log
# Since the release commit of 0.1.0, onbudget writes its event log only to one fixed file in its own folder,
# log/events.jsonl (then log/events.1.jsonl, ...), when ONBUDGET_LOG=1; each process that logs starts it again. Runs are
# one at a time, so a run of arm C clears that log, links meter.jsonl (and its chunks) in the run directory to it for the
# watchdog and lib.read_log, and replaces the links with copies when the session ends. Earlier runs wrote meter.jsonl
# themselves (ONBUDGET_LOG named it); their directories are unchanged.
LOG_LINKS = 200


def link_log(run_dir, plugin_dir):
    for f in glob.glob(f'{plugin_dir}/log/events*.jsonl'): os.remove(f)
    for k in range(LOG_LINKS):
        os.symlink(f'{plugin_dir}/log/events' + (f'.{k}' if k else '') + '.jsonl', f'{run_dir}/meter.jsonl' + (f'.{k}' if k else ''))


def keep_log(run_dir, plugin_dir):
    for k in range(LOG_LINKS):
        link = f'{run_dir}/meter.jsonl' + (f'.{k}' if k else '')
        if not os.path.islink(link): continue
        target = os.readlink(link); os.remove(link)
        if os.path.exists(target): shutil.copy2(target, link)
    for f in glob.glob(f'{plugin_dir}/log/events*.jsonl'): os.remove(f)


# ---------------------------------------------------------------- launch with the external watchdog
def log_age(run_dir):
    """Seconds since the plugin last wrote to its log (0 while there is no log: the session.start rule covers that)."""
    times = []
    for name in os.listdir(run_dir):
        try: times += [os.path.getmtime(f'{run_dir}/{name}')] if name.startswith('meter.jsonl') else []
        except OSError: pass
    return time.time() - max(times) if times else 0


def watchdog(rows, elapsed, kill_at, expect_log, age=0):
    """Reason to kill the run now, or None. The cost rule only works while the plugin logs, hence the three LOG_FAULT rules."""
    if elapsed > MAX_SECS: return f'timeout {MAX_SECS // 60} min'
    cost = lib.logged_cost(rows)
    if cost is not None and cost > kill_at: return f'cost {cost:.3f} > cap + {KILL_OVER:.2f}'
    if not expect_log: return None
    if elapsed > LOG_GRACE and not any(r.get('kind') == 'session.start' for r in rows): return f'{LOG_FAULT}no session.start row after {LOG_GRACE} s'
    if elapsed > COST_GRACE and cost is None: return f'{LOG_FAULT}no cost logged after {COST_GRACE} s'
    if age > LOG_STALE: return f'{LOG_FAULT}nothing written for {LOG_STALE} s'
    return None


def launch(cmd, cwd, env, prompt, run_dir, kill_at, expect_log, on_start=None):
    """Run claude under the watchdog. Returns (wall seconds, kill reason or None). Nothing the session started outlives it."""
    t0 = time.time(); killed = guard = None; null = subprocess.DEVNULL
    check = lambda: watchdog(lib.read_log(run_dir), time.time() - t0, kill_at, expect_log, log_age(run_dir))
    with open(f'{run_dir}/out.json', 'w') as so, open(f'{run_dir}/err.txt', 'w') as se:
        p = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=so, stderr=se, text=True, start_new_session=True)
        try:
            open(f'{run_dir}/pid.txt', 'w').write(str(p.pid))              # marks that a session was really started
            guard = subprocess.Popen([sys.executable, '-c', DEADMAN, str(p.pid), str(os.getpid()), str(MAX_SECS + POLL_GAP)], stdin=null, stdout=null, stderr=null, start_new_session=True)
            if on_start: on_start(p.pid)
            try: p.stdin.write(prompt); p.stdin.close()
            except Exception: pass
            last = time.time()
            while p.poll() is None:
                time.sleep(POLL)
                gap, last = time.time() - last, time.time()
                reason = f'{SUSPENDED}{gap:.0f} s between two watchdog polls' if gap > POLL_GAP else check()
                if reason and reason.startswith(LOG_FAULT): time.sleep(1); reason = check()   # a chunk file is rewritten whole: never act on a single read
                if reason and p.poll() is None: killed = reason; break       # a run that has already ended was not killed
        finally:
            again = None
            while True:                                                      # a second signal must not skip the kill
                try:
                    try: os.killpg(p.pid, signal.SIGKILL)
                    except OSError: pass
                    p.wait(); break
                except BaseException as e: again = e
            if guard: guard.kill(); guard.wait()
            if again: raise again
    return time.time() - t0, killed


# ---------------------------------------------------------------- one run
def run(spec, runs=RUNS, extra_plugins=(), extra_env=None, prompt_override=None, plugins=None, on_start=None):
    """spec: run_id, phase, slot, attempt, mode ('session' | 'single'), arm, level, usd (cap / nominal budget in dollars),
    raw (the budget as the user states it: '$4.20' or '4% 5h'), task (single mode). `plugins` overrides the arm's plugin list."""
    rid, arm, mode = spec['run_id'], spec['arm'], spec['mode']
    names = list(EVAL_TASKS) if mode == 'session' else [spec['task']]
    plugin_names = list(ARMS[arm]['plugins'] if plugins is None else plugins) + list(extra_plugins)
    for name in plugin_names: validate_plugin(PLUGINS[name])                # before anything is created: a refusal leaves no trace
    rd = f'{runs}/{rid}'; work = f'{WORK}/{rid}/ws'; cwd = work if mode == 'session' else f'{work}/{names[0]}'
    if os.path.exists(rd) or os.path.exists(f'{WORK}/{rid}'): raise RuntimeError(f'run directory already exists: {rid}')
    if os.path.exists(f'{lib.PROJ}/{lib.slug(cwd)}'): raise RuntimeError(f'session store already exists for {cwd}; refusing to reuse context')
    context = context_files(WORK)
    if any(x.endswith('/.git') for x in context): raise RuntimeError(f'the work directory {WORK} is inside a git repository; set ONBUDGET_EVAL_WORK')
    os.makedirs(rd); os.makedirs(work)
    for name in names: shutil.copytree(f'{TASKS}/{name}/base', f'{work}/{name}')
    prompt = prompt_override if prompt_override is not None else session_prompt(arm, spec['raw']) if mode == 'session' else single_prompt(arm, spec['raw'], names[0])
    cmd = claude_cmd([PLUGINS[n] for n in plugin_names], spec['usd'] if ARMS[arm].get('max_budget') else None); env, ours = run_env(rd, spec, work, extra_env)
    open(f'{rd}/prompt.txt', 'w').write(prompt); open(f'{rd}/cmd.txt', 'w').write(' '.join(cmd)); open(f'{rd}/shim.log', 'a').close()
    jdump(f'{rd}/env.json', dict(ours, PATH_prefix=SHIM, claude_version=claude_version(), claude_bin=CLAUDE, cwd=cwd, context_files=context))
    meta = dict(spec, names=names, plugins=plugin_names, cwd=cwd, started=time.strftime('%Y-%m-%dT%H:%M:%S'))
    jdump(f'{rd}/spec.json', meta)
    if 'onbudget' in plugin_names: link_log(rd, PLUGINS['onbudget'])
    try:
        wall, killed = launch(cmd, cwd, env, prompt, rd, spec['usd'] + KILL_OVER, any(n in LOGGING_PLUGINS for n in plugin_names), on_start)
    finally:
        if 'onbudget' in plugin_names: keep_log(rd, PLUGINS['onbudget'])
        keep_workspace(rid, runs)
    jdump(f'{rd}/spec.json', dict(meta, wall_s=round(wall, 1), killed=killed))
    return finish(rid, runs)


def keep_workspace(rid, runs=RUNS):
    """Move the session's working tree from the work directory into the run directory (modification times are kept)."""
    if os.path.isdir(f'{WORK}/{rid}/ws') and not os.path.exists(f'{runs}/{rid}/ws'): shutil.move(f'{WORK}/{rid}/ws', f'{runs}/{rid}/ws')
    shutil.rmtree(f'{WORK}/{rid}', ignore_errors=True)


def budget_problem(spec, start, budget_row):
    """Why what the plugin logged about its budget or cap disagrees with what the harness set, or None."""
    if spec['arm'] != 'C':
        cap = start.get('cap')
        return f"capmod logged cap {cap}, the harness set {spec['usd']}" if isinstance(cap, (int, float)) and abs(cap - spec['usd']) > 1e-6 else None
    if budget_row is None: return 'no "budget" row: the onbudget budget never started'
    if budget_row.get('raw') is not None and str(budget_row['raw']).strip() != spec['raw']: return f"onbudget logged budget {budget_row['raw']!r}, the harness set {spec['raw']!r}"
    usd = budget_row.get('usd')
    if spec['raw'].startswith('$') and isinstance(usd, (int, float)) and abs(usd - spec['usd']) > 1e-6: return f"onbudget logged ${usd}, the harness set ${spec['usd']}"
    return None


def finish(rid, runs=RUNS):
    """Compute score.json from the run directory alone (spec.json, out.json, plugin log, shim log, transcript, working tree)."""
    rd = f'{runs}/{rid}'; spec = jload(f'{rd}/spec.json'); arm, names, killed = spec['arm'], spec['names'], spec.get('killed')
    repos = {n: f'{rd}/ws/{n}' for n in names}; budget = spec['usd']; prompt = open(f'{rd}/prompt.txt').read()
    out = jload(f'{rd}/out.json', {}) or {}
    if isinstance(out, list): out = next((x for x in reversed(out) if isinstance(x, dict) and x.get('type') == 'result'), {})
    rows = lib.read_log(rd); kinds = lambda k: [lib.data(r) for r in rows if r.get('kind') == k]
    stops, stopfail, hookfail, steps, tools = kinds('stop'), kinds('stopfail'), kinds('hookfail'), kinds('step'), kinds('tool')
    start = (kinds('session.start') or [{}])[0]; budget_row = (kinds('budget') or [None])[0]
    converted = dict(budget_row or {})                       # a percentage budget may get its dollar value later, in a "calibrated" row
    for d in kinds('calibrated'): converted.update({k: d[k] for k in ('usd', 'rate') if d.get(k) is not None})
    cost_cli, cost_logged = out.get('total_cost_usd'), lib.logged_cost(rows)
    cost = cost_cli if cost_cli is not None else cost_logged
    known = [c for c in (cost_cli, cost_logged) if isinstance(c, (int, float))]
    tr = lib.collect_transcript(spec['cwd'], rd)
    subtype = out.get('subtype'); text = out.get('result') or ''
    open(f'{rd}/final_message.txt', 'w', errors='replace').write(text)
    efforts = lambda rs, key='effort': sorted({str(d[key]) for d in rs if d.get(key) is not None})
    effort_main = efforts([d for d in steps if not d.get('agentId')])
    injected = [d['injected'] for d in tools if d.get('injected')]; tiers = []
    for m in (_TIER_RE.search(str(x)) for x in injected):
        if m and (not tiers or tiers[-1] != m.group(1)): tiers.append(m.group(1))
    api_err = out.get('terminal_reason') == 'api_error' or (subtype == 'success' and out.get('is_error'))
    capped = subtype == 'error_max_budget_usd'                # arm D: Claude Code's own --max-budget-usd ended the session
    stopped = bool(stops or stopfail or capped); log_fault = str(killed or '').startswith(LOG_FAULT)
    infra = str(killed or '').startswith(SUSPENDED) or ((not killed) and bool(api_err or not (subtype == 'success' or stopped) or (not cost and not stopped)))
    ended = 'killed' if killed else 'stopped' if stopped else 'self' if subtype == 'success' else 'error'
    void = []
    if not start: void.append('the plugin did not load (no session.start row in its log)')
    if log_fault: void.append(f'external kill, {killed}')
    if hookfail: void.append(f"fail-open hook failure logged ({hookfail[0].get('where')})")
    if stopfail: void.append('the stop check itself failed (failed closed)')
    if (tr['usd_budget_lines'] or tr['budget_usd_attachments']) and not ARMS[arm].get('max_budget'): void.append('transcript contains USD budget: / budget_usd')
    if not tr['transcript_files']: void.append('no usable transcript')
    if steps and effort_main != [EFFORT]: void.append(f'recorded main-thread effort {effort_main} differs from {EFFORT}')
    problem = budget_problem(spec, start, budget_row) if start else None
    if problem: void.append(problem)
    expect_log = any(p in LOGGING_PLUGINS for p in spec['plugins'])      # set-up faults a retry would repeat: the queue stops on them
    fault = '; '.join(x for x in void if expect_log and (x == problem or x.startswith(('the plugin did not load', 'external kill')))) or None
    per = {n: lib.score_task(n, repos[n], killed) for n in names}
    scored = {n: 'COMPLETE' if per[n]['complete'] else 'INCOMPLETE' for n in names}
    lines = lib.task_claims(text, names); status = lib.final_status(text)
    whole = status if spec['mode'] == 'single' or status == 'COMPLETE' else None     # STATUS: COMPLETE claims every task that has no line of its own
    claimed = {n: lines[n] or whole for n in names}
    enforced = budget                                        # what cost is compared with; for a percentage budget, the plugin's own conversion
    if arm == 'C' and not spec['raw'].startswith('$'): enforced = converted.get('usd') if isinstance(converted.get('usd'), (int, float)) else None
    ver = lib.verification(f'{rd}/shim.log', repos)
    for n in names: per[n].update(ver[n])
    open(f'{rd}/ws.diff', 'w').write(lib.ws_diff(repos))
    usage = out.get('modelUsage') or {}; total = lambda key: sum((u.get(key) or 0) for u in usage.values()) if usage else None
    step_costs = [d['stepCost'] for d in steps if isinstance(d.get('stepCost'), (int, float))]
    spent = [d['spent'] for d in steps if isinstance(d.get('spent'), (int, float))]
    prev = jload(f'{rd}/score.json')
    res = dict(run_id=rid, phase=spec.get('phase'), slot=spec.get('slot'), attempt=spec.get('attempt', 0), mode=spec['mode'], arm=arm, level=spec.get('level'),
               task=spec.get('task'), budget_raw=spec['raw'], budget=budget, plugins=spec['plugins'],
               cost=cost, cost_cli=cost_cli, cost_logged=cost_logged, cost_counted=(max(known + [budget + KILL_OVER] * log_fault) if known else budget + KILL_OVER),
               budget_enforced=enforced, cost_minus_budget=(None if None in (cost, enforced) else round(cost - enforced, 6)),
               within_budget=(None if None in (cost, enforced) else bool(cost <= enforced)),
               ended=ended, stop_event=((stops[0].get('event') if stops else 'stopfail' if stopfail else 'max-budget-usd') if stopped else None), stop_events=len(stops), killed=killed,
               tasks_complete=sum(per[n]['complete'] for n in names), tasks_total=len(names), complete_list=[n for n in names if per[n]['complete']],
               complete=all(per[n]['complete'] for n in names), claimed=claimed, scored=scored, claim_lines=sum(1 for n in names if lines[n]), status_line=status,
               tasks_unclaimed=sum(1 for n in names if claimed[n] is None),
               false_claims=sum(1 for n in names if claimed[n] == 'COMPLETE' and scored[n] != 'COMPLETE'),
               tasks_tested=sum(1 for n in names if ver[n]['tests_run'] > 0), tasks_verified_final=sum(1 for n in names if ver[n]['verified_final']),
               claimed_without_verified_final=sum(1 for n in names if claimed[n] == 'COMPLETE' and not ver[n]['verified_final']),
               tasks_edited=sum(1 for n in names if ver[n]['code_files']), tasks_verified_code=sum(1 for n in names if ver[n]['verified_code']),
               pytest_runs=sum(ver[n]['tests_run'] for n in names), per_task=per,
               turns=out.get('num_turns'), thinking_tokens=total('thinkingTokens'), output_tokens=total('outputTokens'), steps=len(steps),
               spawns=len({d['agentId'] for d in steps if d.get('agentId')}), max_step_cost=(round(max(step_costs), 6) if step_costs else None),
               meter_lines=len(injected), meter_tiers_shown='>'.join(tiers), meter_last_line=(injected[-1] if injected else None),
               budget_usd_logged=converted.get('usd'), budget_rate_logged=converted.get('rate'), budget_spec_logged=converted.get('spec'),
               effort_cap_logged=(budget_row or {}).get('effortCap'), spent_logged=(spent[-1] if spent else None), engine_version=((start.get('version') or {}).get('version') if isinstance(start.get('version'), dict) else start.get('version')),
               effort_expected=EFFORT, effort_main=';'.join(effort_main), effort_all=';'.join(efforts(steps)), caller_effort=';'.join(efforts(steps, 'callerEffort')),
               void=bool(void) and not infra, void_reason=('' if infra else '; '.join(void)), void_checks=void, infra_failure=infra, stop_queue=fault,
               subtype=subtype, is_error=out.get('is_error'), terminal_reason=out.get('terminal_reason'),
               errors=(out.get('errors') or [None])[0] or (text[:160] if api_err else None),
               hookfail_events=len(hookfail), stopfail_events=len(stopfail), permission_denials=len(out.get('permission_denials') or []),
               prompt_is_first_user_row=lib.first_user_is_prompt(rd, out.get('session_id'), prompt), final_chars=len(text),
               model=';'.join(sorted({str(d['model']) for d in steps if d.get('model')})) or ';'.join(usage.keys()),
               session_id=out.get('session_id'), wall_s=spec.get('wall_s'), ts=spec.get('started'),
               claude_version=(jload(f'{rd}/env.json') or {}).get('claude_version'), **lib.quota(rows), **tr)
    if prev: res['score_history'] = (prev.get('score_history') or []) + [dict(rescored_at=time.strftime('%Y-%m-%dT%H:%M:%S'), previous={
        k: prev.get(k) for k in ('per_task', 'scored', 'tasks_complete', 'complete_list', 'complete', 'false_claims', 'tasks_verified_final', 'void', 'void_reason')})]
    jdump(f'{rd}/score.json', res)
    return res


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'rescore':
        r = finish(sys.argv[2]); print({k: r[k] for k in ('run_id', 'scored', 'tasks_complete', 'false_claims', 'tasks_verified_final', 'void_reason')})
    else: print(__doc__)
