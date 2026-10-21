#!/usr/bin/env python3
"""End-to-end checks of onbudget inside a real Claude Code process, at zero cost.

Each check starts `claude -p` with two plugins: onbudget (this repository) and tests/e2e/mock, which answers every
model request from a script and reports a scripted cost ledger and usage windows. No request is sent: the API base URL
is also pointed at a closed local port, so a request that slipped past the mock would fail rather than be billed.
Nothing turns the mods API on: since Claude Code 2.1.287 it is on by default, so these runs also show that.

usage: python3 tests/e2e/run.py [check ...]        (no arguments: every check)
       ONBUDGET_CLAUDE_BIN=/path/to/claude python3 tests/e2e/run.py     (another Claude Code build)
"""
import json, os, shutil, subprocess, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eventlog  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
MOCK = os.path.join(HERE, 'mock')
CLAUDE = os.environ.get('ONBUDGET_CLAUDE_BIN', 'claude')
TMP = tempfile.mkdtemp(prefix='onbudget-e2e-')
RESULTS = []


def clean_env(extra):
    env = {k: v for k, v in os.environ.items() if not (k.startswith('CLAUDE') or k.startswith('ANTHROPIC_'))}
    env.update(ANTHROPIC_BASE_URL='http://127.0.0.1:9', CLAUDE_CODE_MAX_RETRIES='0', DISABLE_TELEMETRY='1', DISABLE_AUTOUPDATER='1')
    env.update(extra)
    return env


class Run:
    """One `claude -p` process: its JSON result, the plugin's event log and what the mock saw."""

    def __init__(self, name, prompt, script, env=None, args=(), plugins=(REPO, MOCK), ledger=None, slash=False, cwd=None, home=None, agents=None):
        self.dir = os.path.join(TMP, name); os.makedirs(self.dir, exist_ok=True)
        self.cwd = cwd or os.path.join(self.dir, 'cwd'); os.makedirs(self.cwd, exist_ok=True)
        # A Claude config directory of its own: transcripts and the plugin's store stay out of the real one.
        self.home = home or os.path.join(self.dir, 'home')
        script_path = os.path.join(self.dir, 'script.json'); json.dump(script, open(script_path, 'w'))
        self.log_path = os.path.join(self.dir, 'onbudget.jsonl'); self.mock_path = os.path.join(self.dir, 'mock.json')
        e = dict(MOCK_SCRIPT=script_path, MOCK_LOG=self.mock_path, ONBUDGET_LOG='1', CLAUDE_CONFIG_DIR=self.home)
        if ledger: e['MOCK_LEDGER'] = ledger
        if agents is not None:
            agents_path = os.path.join(self.dir, 'agents.json'); json.dump(agents, open(agents_path, 'w')); e['MOCK_AGENT_SCRIPT'] = agents_path
        e.update(env or {})
        cmd = [CLAUDE, '-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--setting-sources', 'project,local',
               '--strict-mcp-config', '--allowedTools', 'Bash(echo:*)', '--model', 'sonnet', '--effort', 'high']
        for p in plugins: cmd += ['--plugin-dir', p]
        if not slash: cmd.append('--disable-slash-commands')
        cmd += list(args)
        eventlog.clear(REPO)   # the plugin's log is one fixed file in its folder: this process's alone, kept beside its files
        try: p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, cwd=self.cwd, env=clean_env(e), timeout=240)
        finally: eventlog.keep(REPO, self.log_path)
        self.stdout, self.stderr, self.rc = p.stdout, p.stderr, p.returncode
        try: self.out = json.loads(p.stdout)
        except Exception: self.out = {}
        self.result = self.out.get('result') or ''
        self.session_id = self.out.get('session_id')
        self.real_cost = self.out.get('total_cost_usd') or 0

    def rows(self, kind=None):
        rows, i = [], 0
        while True:
            path = self.log_path if i == 0 else f'{self.log_path}.{i}'
            if not os.path.exists(path): break
            rows += [json.loads(l) for l in open(path) if l.strip()]; i += 1
        return [r['data'] for r in rows if r['kind'] == kind] if kind else rows

    def meters(self):
        """The meter lines as the session's transcript recorded them beside tool results: what the model was sent."""
        found = []
        for root, _, files in os.walk(os.path.join(self.home, 'projects')):
            for f in files:
                if not (self.session_id and f == f'{self.session_id}.jsonl'): continue
                for line in open(os.path.join(root, f), errors='replace'):
                    try: a = json.loads(line).get('attachment') or {}
                    except Exception: continue
                    if a.get('type') == 'hook_additional_context': found += [c for c in a.get('content') or [] if c.startswith('[budget]')]
        return found

    def mock(self, kind):
        try: return [r for r in json.load(open(self.mock_path)) if r['kind'] == kind]
        except Exception: return []


def check(name, ok, detail=''):
    RESULTS.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f'\n      {detail}' if detail and not ok else ''))


def brief(r):
    return f"rc={r.rc} result={r.result[:300]!r} stderr={r.stderr[-300:]!r} hookfail={r.rows('hookfail')} stopfail={r.rows('stopfail')}"


BASH3 = [dict(bash='echo one', cost=0.30), dict(bash='echo two', cost=0.30), dict(bash='echo three', cost=0.30), dict(text='all done', cost=0.30)]


def t_untouched():
    """No budget: the plugin is loaded and changes nothing."""
    r = Run('untouched', 'Say hi.', [dict(bash='echo one', cost=0.3), dict(text='hi')])
    steps, tools, prompts = r.mock('step'), r.mock('tool'), r.mock('prompt')
    check('no budget: the run completes and costs nothing real', r.result == 'hi' and r.real_cost == 0, brief(r))
    check('no budget: effort is what the caller set', [s['effort'] for s in steps] == ['high', 'high'], str(steps))
    check('no budget: no context is added to tool results or prompts', r.meters() == [] and not r.rows('tool') and prompts and prompts[0]['text'] == 'Say hi.' and not prompts[0]['context'], f'{r.meters()} {prompts}')
    check('no budget: no stop, no hook failure', not r.rows('stop') and not r.rows('hookfail') and not r.rows('stopfail'), brief(r))
    check('the plugin loaded (session.start logged, command registered without error)', len(r.rows('session.start')) == 1, brief(r))


def t_dollar_stop():
    """ONBUDGET=$1: protocol appended, effort capped, meter after each tool result, the fourth request refused."""
    r = Run('dollar', 'Do the three things.', BASH3, env=dict(ONBUDGET='$1'))
    steps, tools, prompts = r.mock('step'), r.mock('tool'), r.mock('prompt')
    check('$ budget: the prompt entered with the protocol appended', prompts and prompts[0]['text'].startswith('Do the three things.\n\nYou have a hard usage budget of $1.00 for this task.'), str(prompts)[:400])
    check('$ budget: effort lowered to medium on every request', [s['effort'] for s in steps] == ['medium'] * 3, str(steps))
    want = ['[budget] spent $0.30 of $1.00 | left before the stop $0.40 (40%) | tier CRITICAL', '[budget] spent $0.60 of $1.00 | left before the stop $0.10 (10%) | tier CRITICAL',
            '[budget] spent $0.90 of $1.00 | left before the stop $0.00 (0%) | tier CRITICAL']
    check('$ budget: a meter line follows each tool result', [t['injected'] for t in r.rows('tool')] == want and len(tools) == 3, str(r.rows('tool')))
    check('$ budget: the transcript shows the model was sent those lines', r.meters() == want, str(r.meters()))
    check('$ budget: the fourth request is not sent', len(steps) == 3 and [s['event'] for s in r.rows('stop')] == ['reserve-stop'], f'{len(steps)} {r.rows("stop")}')
    check('$ budget: the run ends with the plugin\'s notice as its result', r.result.startswith('[onbudget] Stopped: $0.90 of $1.00 is used') and 'not from Claude' in r.result, brief(r))
    check('$ budget: per-request costs are logged and nothing real was spent', [round(s['stepCost'], 2) for s in r.rows('step')] == [0.3, 0.3, 0.3] and r.real_cost == 0, f'{r.rows("step")} real={r.real_cost}')
    check('$ budget: no hook failure', not r.rows('hookfail') and not r.rows('stopfail'), brief(r))


def t_finishes_within():
    """A budget that is enough: the run ends by itself and nothing is refused."""
    r = Run('within', 'Do the three things.', BASH3, env=dict(ONBUDGET='$2'))
    check('enough budget: the model finishes by itself', r.result == 'all done' and not r.rows('stop') and len(r.mock('step')) == 4, brief(r))
    end = r.rows('end')
    check('enough budget: the session end is logged with the task spend', end and abs(end[0]['spent'] - 1.2) < 1e-9, str(end)[:300])


def t_bad_env():
    """An unusable ONBUDGET: the prompt is dropped, no request is made."""
    r = Run('badenv', 'Do it.', BASH3, env=dict(ONBUDGET='lots'))
    check('unusable ONBUDGET: no request is made', len(r.mock('step')) == 0, brief(r))
    check('unusable ONBUDGET: the reason is reported', '"lots" is not a budget' in (r.result + r.stderr + r.stdout), brief(r) + r.stdout[:300])


def t_typed():
    """The command as prompt text (slash commands disabled)."""
    r = Run('typed', '/onbudget $0.60 Do the three things.', BASH3)
    prompts = r.mock('prompt')
    check('typed command: budget set, task sent with the protocol', prompts and prompts[0]['text'].startswith('Do the three things.\n\nYou have a hard usage budget of $0.60'), str(prompts)[:300])
    check('typed command: the stop applies', len(r.mock('step')) == 1 and r.result.startswith('[onbudget] Stopped: $0.30 of $0.60'), brief(r))
    s = Run('typed-status', '/onbudget', BASH3)
    check('typed command: /onbudget alone answers with the status and sends nothing', len(s.mock('step')) == 0 and 'no budget is set' in (s.result + s.stdout + s.stderr), brief(s) + s.stdout[:300])


def t_slash():
    """The registered slash command in a headless run (slash commands enabled). The task is submitted once the command
    has returned, and `claude -p` can exit before it is sent: a known issue in 0.1.0 (README, Headless runs). What must
    hold either way: the task never reaches the model without its budget, and the spend stays within it."""
    r = Run('slash', '/onbudget $0.60 Do the three things.', BASH3, slash=True)
    b = r.rows('budget'); prompts = r.mock('prompt'); steps = r.mock('step')
    check('slash command (headless): the command runs and sets the budget', len(b) == 1 and b[0]['usd'] == 0.6, brief(r) + r.stdout[:300])
    if not prompts: print('NOTE  slash command (headless): claude -p exited before the task was sent, the known issue in 0.1.0; nothing ran')
    check('slash command (headless): the task never reaches the model without its budget', (prompts or not steps) and all(p['text'].startswith('Do the three things.\n\nYou have a hard usage budget of $0.60') for p in prompts), f'{prompts} {brief(r)}')
    spent = round(sum(float(s['cost']) for s in BASH3[:len(steps)]), 9)
    check('slash command (headless): the spend stays within the budget, and the stop applies if the task was sent', spent <= 0.6 and r.real_cost == 0 and (not prompts or (len(steps) == 1 and r.result.startswith('[onbudget] Stopped: $0.30 of $0.60'))), f'spent={spent} {brief(r)}')


def t_percent_observed():
    """A percentage budget with no calibration: enforced on the scripted window reading."""
    script = [dict(bash='echo 1', cost=1, five_hour=31), dict(bash='echo 2', cost=1, five_hour=32), dict(bash='echo 3', cost=1, five_hour=34), dict(text='done', cost=1, five_hour=35)]
    r = Run('pct-observed', 'Task.', script, env=dict(ONBUDGET='3% 5h'))
    check('% budget, uncalibrated: baseline is the first reading under the budget; the meter reads in points',
          r.meters() == ['[budget] the 5-hour usage window has moved 0 of 3 points | left before the stop 3 points (100%) | tier HIGH',
                         '[budget] the 5-hour usage window has moved 1 of 3 points | left before the stop 2 points (67%) | tier CRITICAL',
                         '[budget] the 5-hour usage window has moved 3 of 3 points | left before the stop 0 points (0%) | tier CRITICAL'], str(r.meters()))
    check('% budget, uncalibrated: stops when the window has moved 3 points', [s['event'] for s in r.rows('stop')] == ['window-stop'] and 'has moved 3 points since the budget started' in r.result, brief(r))
    small = Run('pct-small', 'Task.', script, env=dict(ONBUDGET='2% 5h'))
    check('% budget, uncalibrated: under 3 points is refused and nothing is sent', len(small.mock('step')) == 0 and 'cannot enforce 2% 5h yet' in (small.result + small.stdout + small.stderr), brief(small) + small.stdout[:300])


def t_calibration_persists():
    """Calibration learned in one process is used by the next (the plugin's store persists)."""
    home = os.path.join(TMP, 'home-cal')
    script = [dict(bash='echo 1', cost=1, five_hour=10), dict(bash='echo 2', cost=2, five_hour=12), dict(bash='echo 3', cost=2, five_hour=14), dict(text='done', cost=2, five_hour=16)]
    a = Run('cal-learn', 'Task.', script, env=dict(ONBUDGET='$50'), home=home)
    b = Run('cal-use', 'Task.', [dict(text='ok', cost=0.1, five_hour=17)], env=dict(ONBUDGET='2% 5h'), home=home)
    rows = b.rows('budget')
    check('calibration: a second process converts a percentage budget with the rate the first one learned',
          len(rows) == 1 and rows[0]['rate'] and rows[0]['rate']['source'] == 'learned' and rows[0]['rate']['points'] == 6
          and abs(rows[0]['rate']['usdPerPoint'] - 6 / (6 + 0.82)) < 1e-9 and abs(rows[0]['usd'] - round(2 * 6 / 6.82, 4)) < 1e-9,
          f"budget rows={rows} result={b.result[:200]!r} stdout={b.stdout[:200]!r} {brief(a)}")
    store = [f for root, _, files in os.walk(os.path.join(home, 'plugins')) for f in files]
    check('calibration: the store is one file of the plugin\'s own under the Claude config directory', len(store) == 1 and store[0].startswith('onbudget'), str(store))
    if rows and rows[0].get('rate'): print(f"      note: learned rate {rows[0]['rate']} -> budget ${rows[0]['usd']}")
    c = Run('cal-rest', 'Task.', [dict(bash='echo 1', cost=0.1, five_hour=20), dict(text='ok', cost=0.1, five_hour=20)], env=dict(ONBUDGET='5h'), home=home)
    sized = c.rows('sized'); rate = (rows[0].get('rate') or {}).get('usdPerPoint') if rows else None
    check('5h with a learned rate, set before the session has a reading: sized in dollars from the first one (79 points below 99%)',
          len(sized) == 1 and rate and abs(sized[0]['usd'] - round(79 * rate, 4)) < 1e-9 and c.meters() and c.meters()[0].startswith(f"[budget] spent $0.10 of ${sized[0]['usd']:.2f} (what the 5-hour usage window had left)"),
          f'sized={sized} meters={c.meters()} {brief(c)}')


def t_resume():
    """A budget is restored when the session is resumed in a new process, with the ledger kept or started over."""
    for mode in ('ledger kept', 'ledger starts over'):
        tag = mode.split()[1]
        home = os.path.join(TMP, f'home-resume-{tag}'); ledger = os.path.join(TMP, f'ledger-{tag}.json')
        cwd = os.path.join(TMP, f'cwd-resume-{tag}')
        a = Run(f'resume-a-{tag}', 'Start.', [dict(bash='echo 1', cost=0.4), dict(text='paused', cost=0.1)], env=dict(ONBUDGET='$2'), ledger=ledger, cwd=cwd, home=home)
        if mode == 'ledger starts over': os.remove(ledger)
        b = Run(f'resume-b-{tag}', 'Go on.', [dict(bash='echo 2', cost=0.3), dict(text='finished', cost=0.1)], ledger=ledger, cwd=cwd, home=home,
                args=['--resume', a.session_id or 'missing'])
        start = b.rows('session.start'); tools = b.rows('tool'); prompts = b.mock('prompt')
        check(f'resume ({mode}): the first run set the budget and ended by itself', a.result == 'paused' and a.session_id, brief(a))
        check(f'resume ({mode}): the budget is restored in the new process', start and start[0]['restored'] is True, f'{start} sid_a={a.session_id} sid_b={b.session_id} {brief(b)}')
        check(f'resume ({mode}): spend goes on from $0.50, counted once', [t['injected'] for t in tools] == ['[budget] spent $0.80 of $2.00 | left before the stop $0.80 (40%) | tier CRITICAL'], str(tools))
        check(f'resume ({mode}): the follow-up prompt carries the reading', prompts and prompts[0]['context'] and prompts[0]['context'][0].startswith('[budget] spent $0.50 of $2.00'), str(prompts)[:300])


def t_wall():
    """A window of the account is a wall under a dollar budget: no rate learned, so in points, stopping before 100%."""
    script = [dict(bash=f'echo {p}', cost=0.1, five_hour=p) for p in (94, 95, 96, 97)] + [dict(text='done', cost=0.1, five_hour=98)]
    r = Run('wall', 'Task.', script, env=dict(ONBUDGET='$10'))
    m = r.meters()
    check('wall: the meter names the account\'s 5-hour limit once it is the closer one', len(m) == 4 and "set by the account's 5-hour limit | tier CRITICAL" in m[1], str(m))
    check('wall: the plugin stops with its own notice at 97%, before the account\'s limit', len(r.mock('step')) == 4 and r.result.startswith("[onbudget] Stopped: the account's 5-hour usage limit is close: the window is at 97%"), brief(r))


def t_exhausted():
    """A budget set against a window with nothing left is refused in one line, also in a new session with no reading yet."""
    home = os.path.join(TMP, 'home-exhausted')
    a = Run('exhausted-a', 'Task.', [dict(bash='echo 1', cost=0.1, five_hour=99), dict(text='done', cost=0.1, five_hour=99)], env=dict(ONBUDGET='$5'), home=home)
    check('exhausted: a window that reaches 99% during a task stops it after that answer', len(a.mock('step')) == 1 and 'the window is at 99%' in a.result, brief(a))
    b = Run('exhausted-b', 'Task.', BASH3, env=dict(ONBUDGET='$3'), home=home)
    out = b.result + b.stdout + b.stderr
    check('exhausted: a new session refuses a budget in one line from the last reading seen, and sends nothing',
          len(b.mock('step')) == 0 and 'the 5-hour usage window is at 99% (resets 2030-01-01 00:00 UTC), so nothing is left to run a budget on before it resets. Nothing was sent.' in out, brief(b) + b.stdout[:300])


def t_rest():
    """ONBUDGET=5h with no rate learned: sized from the first reading, in the window's own points."""
    r = Run('rest', 'Task.', [dict(bash='echo 1', cost=0.1, five_hour=40), dict(bash='echo 2', cost=0.1, five_hour=41), dict(text='done', cost=0.1, five_hour=41)], env=dict(ONBUDGET='5h'))
    sized, prompts = r.rows('sized'), r.mock('prompt')
    check('5h without a rate: the task is sent with the protocol before any reading', prompts and 'hard usage budget of what the 5-hour usage window has left' in prompts[0]['text'], str(prompts)[:300])
    check('5h without a rate: sized at the first answer, 59 points below 99%', len(sized) == 1 and sized[0]['allowance'] == 59 and sized[0]['usd'] is None, str(sized))
    check('5h without a rate: the meter counts the window from there', r.meters()[:2] == ['[budget] the 5-hour usage window has moved 0 of 59 points | left before the stop 57 points of the 5-hour window (100%) | tier HIGH',
                                                                                    '[budget] the 5-hour usage window has moved 1 of 59 points | left before the stop 56 points of the 5-hour window (98%) | tier HIGH'], str(r.meters()))
    check('5h without a rate: the task finishes by itself', r.result == 'done', brief(r))


def t_subagents():
    """Two subagents side by side under onbudget: requests in flight at once, each charged its own cost, the total exact."""
    # Claude Code runs subagents in the background: the main thread answers at once and hears from them later.
    # Their results arrive as one or two notifications, each a turn of its own: those answers cost nothing here.
    main = [dict(agents=['first', 'second'], cost=0.2), dict(text='started', cost=0.1), dict(text='all done', cost=0), dict(text='all done', cost=0)]
    # Completions are scripted seconds apart: two requests that end at the same instant cannot be told apart in the ledger.
    agents = [[dict(bash='echo a', cost=0.25, sleep_ms=1000), dict(text='a done', cost=0.05, sleep_ms=500)], [dict(bash='echo b', cost=0.25, sleep_ms=4000), dict(text='b done', cost=0.05, sleep_ms=500)]]
    r = Run('subagents', 'Task.', main, env=dict(ONBUDGET='$3'), agents=agents)
    steps = r.rows('step'); costs = sorted(round(s['stepCost'], 6) for s in steps if s['stepCost'] > 0)
    check('subagents: two ran, and the plugin had requests in flight at once', len({s['agentId'] for s in steps if s['agentId']}) == 2 and max(s['beside'] for s in steps) >= 1,
          f"agents={[s['agentId'] for s in steps]} beside={[s['beside'] for s in steps]} {brief(r)}")
    check('subagents: each request is charged its own cost, and the charges sum to the ledger', costs == [0.05, 0.05, 0.1, 0.2, 0.25, 0.25] and abs(steps[-1]['spent'] - 0.9) < 1e-9, f'{costs} {[s["spent"] for s in steps]}')
    check('subagents: the meter follows the subagents\' tool results too', any(t['agentId'] for t in r.rows('tool')) and r.result == 'all done', brief(r))
    # The stop with requests in flight: the second subagent's next request is refused because the first one's is still running.
    agents = [[dict(bash='echo a', cost=0.25, sleep_ms=1000), dict(bash='echo a2', cost=0.1, sleep_ms=6000), dict(text='a done', cost=0.05)],
              [dict(bash='echo b', cost=0.25, sleep_ms=3500), dict(text='b done', cost=0.05)]]
    s = Run('subagents-stop', 'Task.', main, env=dict(ONBUDGET='$1'), agents=agents)
    stops = s.rows('stop')
    check('subagents: a request is refused for the reserve of one still in flight, where alone it would have fitted',
          stops and stops[0]['event'] == 'reserve-stop' and stops[0]['agentId'] and stops[0]['inFlight'] == 1 and stops[0]['spent'] + stops[0]['reserve'] < 1 <= stops[0]['spent'] + 2 * stops[0]['reserve'],
          f'stops={stops} {brief(s)}')
    check('subagents: the run ends with the plugin\'s notice, within the budget', s.result.startswith('[onbudget] Stopped:') and s.rows('step')[-1]['spent'] <= 1, brief(s))


def t_version():
    """The version /onbudget states is the manifests' version."""
    import re
    code = re.search(r"export const VERSION = '([^']+)'", open(os.path.join(REPO, 'hooks', 'core.ts')).read()).group(1)
    plugin = json.load(open(os.path.join(REPO, '.claude-plugin', 'plugin.json')))['version']
    market = json.load(open(os.path.join(REPO, '.claude-plugin', 'marketplace.json')))
    check('the version in hooks/core.ts is the one in both manifests', code == plugin == market['metadata']['version'] == market['plugins'][0]['version'], f'{code} {plugin} {market}')


CHECKS = dict(version=t_version, untouched=t_untouched, dollar=t_dollar_stop, within=t_finishes_within, badenv=t_bad_env, typed=t_typed, slash=t_slash,
              percent=t_percent_observed, calibration=t_calibration_persists, resume=t_resume, wall=t_wall, exhausted=t_exhausted, rest=t_rest,
              subagents=t_subagents)

if __name__ == '__main__':
    v = subprocess.run([CLAUDE, '--version'], capture_output=True, text=True).stdout.strip()
    for plugin in (REPO, MOCK):
        p = subprocess.run([CLAUDE, 'plugin', 'validate', plugin], capture_output=True, text=True)
        if p.returncode != 0: sys.exit(f'plugin does not validate, nothing was run: {plugin}\n{p.stdout}{p.stderr}')
    print(f'claude: {v}   scratch: {TMP}')
    for name in sys.argv[1:] or CHECKS:
        try: CHECKS[name]()
        except Exception as ex: check(f'{name}: ran to completion', False, repr(ex))
    print(f'\n{sum(RESULTS)} passed, {len(RESULTS) - sum(RESULTS)} failed')
    if all(RESULTS) and not os.environ.get('ONBUDGET_E2E_KEEP'): shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(0 if all(RESULTS) else 1)
