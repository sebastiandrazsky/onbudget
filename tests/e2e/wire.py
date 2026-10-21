#!/usr/bin/env python3
"""What really reaches the API, at zero cost: onbudget in a real `claude -p` process against a fake Anthropic API on
localhost (tests/e2e/fakeapi.py), with a fake key and a config directory of its own. Unlike run.py, nothing answers in
place of the engine: Claude Code builds and sends every request, and the fake API logs each body whole.

Checked: Claude Code's own token countdown is left out of the requests while a budget is open and only then; the
system-prompt copy stays; no request rewrites an earlier one (the prompt cache's prefix holds), within a process and
across resumes, with the budget set before, during and after; a countdown the user configured is kept; the effort cap
reaches the wire. With EFFORTLESS_DIR naming a checkout of HeyCubit/effortless, the same with effortless loaded beside
onbudget, in both orders.

usage: python3 tests/e2e/wire.py [check ...]
       ONBUDGET_CLAUDE_BIN=/path/to/claude python3 tests/e2e/wire.py
       python3 tests/e2e/wire.py probe            print what one budgeted run sent, for reading by hand
"""
import json, os, re, shutil, signal, subprocess, sys, tempfile, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eventlog  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
CLAUDE = os.environ.get('ONBUDGET_CLAUDE_BIN', 'claude')
EFFORTLESS = os.environ.get('EFFORTLESS_DIR')
TMP = tempfile.mkdtemp(prefix='onbudget-wire-')
RESULTS = []
COUNTDOWN = re.compile(r'<total_tokens>\s*([0-9]+|Infinite) tokens left\s*</total_tokens>')


def check(name, ok, detail=''):
    RESULTS.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f'\n      {detail}' if detail and not ok else ''))


class Run:
    """One `claude -p` process against its own fake API: the request bodies it sent, its result, onbudget's log."""

    def __init__(self, name, prompt, env=None, args=(), plugins=(REPO,), home=None, cwd=None, judge=None):
        self.dir = os.path.join(TMP, name); os.makedirs(self.dir, exist_ok=True)
        self.cwd = cwd or os.path.join(self.dir, 'cwd'); os.makedirs(self.cwd, exist_ok=True)
        self.home = home or os.path.join(self.dir, 'home')
        self.api_log = os.path.join(self.dir, 'api.jsonl'); self.log_path = os.path.join(self.dir, 'onbudget.jsonl')
        port_file = os.path.join(self.dir, 'port')
        fenv = dict(os.environ, **({'FAKE_JUDGE': judge} if judge else {}))
        server = subprocess.Popen([sys.executable, '-I', os.path.join(HERE, 'fakeapi.py'), self.api_log, port_file], env=fenv)
        try:
            for _ in range(100):
                if os.path.exists(port_file) and open(port_file).read().strip(): break
                time.sleep(0.05)
            port = open(port_file).read().strip()
            e = {k: v for k, v in os.environ.items() if not (k.startswith(('CLAUDE', 'ANTHROPIC_', 'ONBUDGET', 'MOCK_')))}
            e.update(ANTHROPIC_BASE_URL=f'http://127.0.0.1:{port}', ANTHROPIC_API_KEY='sk-ant-fake-wire', CLAUDE_CONFIG_DIR=self.home,
                     CLAUDE_CODE_MAX_RETRIES='0', DISABLE_TELEMETRY='1', DISABLE_AUTOUPDATER='1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',
                     ONBUDGET_LOG='1')
            e.update(env or {})
            cmd = [CLAUDE, '-p', '--output-format', 'json', '--model', 'claude-opus-5-5', '--effort', 'high', '--permission-mode', 'acceptEdits',
                   '--setting-sources', 'project,local', '--strict-mcp-config', '--allowedTools', 'Bash(echo:*)', '--disable-slash-commands']
            for p in plugins: cmd += ['--plugin-dir', p]
            cmd += list(args)
            eventlog.clear(REPO)   # the plugin's log is one fixed file in its folder: this process's alone, kept beside its files
            try: p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, cwd=self.cwd, env=e, timeout=240)
            finally: eventlog.keep(REPO, self.log_path)
            self.stdout, self.stderr, self.rc = p.stdout, p.stderr, p.returncode
        finally:
            server.send_signal(signal.SIGTERM); server.wait()
        try: self.out = json.loads(self.stdout)
        except Exception: self.out = {}
        self.result = self.out.get('result') or ''
        self.session_id = self.out.get('session_id')
        all_rows = [json.loads(l) for l in open(self.api_log)] if os.path.exists(self.api_log) else []
        # The conversation's own requests: the main thread's, recognised by the session's prompt in the first user turn.
        self.bodies = [r['body'] for r in all_rows if r['path'].startswith('/v1/messages') and 'count_tokens' not in r['path']]
        self.main = [b for b in self.bodies if 'You choose which Claude model' not in json.dumps(b.get('system'))]

    def rows(self, kind):
        if not os.path.exists(self.log_path): return []
        return [json.loads(l)['data'] for l in open(self.log_path) if l.strip() and json.loads(l)['kind'] == kind]

    def countdowns(self, body):
        """Copies of the countdown in the request's messages, and in its system prompt."""
        return len(COUNTDOWN.findall(json.dumps(body.get('messages')))), len(COUNTDOWN.findall(json.dumps(body.get('system'))))


def effort_of(body):
    """The effort a request body carries, wherever this build puts it."""
    for path in (('output_config', 'effort'), ('thinking', 'effort'), ('effort',)):
        v = body
        for k in path: v = v.get(k) if isinstance(v, dict) else None
        if v is not None: return v
    return None


def bare(x):
    """A request's content without its cache_control markers, which Claude Code moves to the newest block each time, and
    with a message's text in one form (Claude Code sends the same system message as a string or as a list of blocks)."""
    if isinstance(x, dict):
        if isinstance(x.get('content'), str): x = dict(x, content=[dict(type='text', text=x['content'])])   # Claude Code sends either form
        return {k: bare(v) for k, v in x.items() if k != 'cache_control'}
    if isinstance(x, list): return [bare(v) for v in x]
    return x


def prefix_breaks(bodies):
    """Pairs of consecutive requests where the later does not start with the earlier's messages: a cache prefix broken."""
    out = []
    for i in range(1, len(bodies)):
        a, b = bare(bodies[i - 1].get('messages') or []), bare(bodies[i].get('messages') or [])
        if json.dumps(b[:len(a)]) != json.dumps(a): out.append(i)
    return out


def brief(r):
    return f"rc={r.rc} result={r.result[:200]!r} stderr={r.stderr[-300:]!r} requests={len(r.bodies)} hookfail={r.rows('hookfail')}"


def probe():
    r = Run('probe', 'Say hi.', env=dict(ONBUDGET='$5'))
    print(brief(r))
    for b in r.bodies:
        print('model', b.get('model'), 'messages', len(b.get('messages') or []), 'countdowns (messages, system)', r.countdowns(b), 'effort', effort_of(b),
              'keys', sorted(k for k in b if k not in ('messages', 'system', 'tools')))
    for m in (r.main[-1].get('messages') if r.main else []):
        print(' ', m.get('role'), json.dumps(m.get('content'))[:160])


def copies(r):
    """Countdown copies in each main request's messages."""
    return [r.countdowns(b)[0] for b in r.main]


def t_countdown():
    """The countdown is left out of the requests while a budget is open, and only then; nothing already sent changes."""
    plain = Run('plain', 'Say hi.', plugins=())
    idle = Run('idle', 'Say hi.')
    budgeted = Run('budgeted', 'Say hi.', env=dict(ONBUDGET='$5'))
    native = copies(plain)
    has = sum(native) > 0
    check('a plain run against the fake API completes', plain.rc == 0 and plain.result.endswith('STATUS: COMPLETE') and len(plain.main) == 2, brief(plain))
    if not has: print('INFO  this build attaches no token countdown to requests: the countdown checks below hold trivially')
    else: check('this build attaches its own countdown to requests, and puts one copy in the system prompt', all(plain.countdowns(b)[1] == 1 for b in plain.main), str([plain.countdowns(b) for b in plain.main]))
    check('no budget: onbudget leaves the countdown as it is', copies(idle) == native and not idle.rows('hookfail'), f'{copies(idle)} vs {native} {brief(idle)}')
    check('a budget: no copy in any request\'s messages', budgeted.main and copies(budgeted) == [0] * len(budgeted.main) and budgeted.result.endswith('STATUS: COMPLETE'), f'{copies(budgeted)} {brief(budgeted)}')
    check('a budget: the system prompt\'s copy stays as it is without onbudget', all(budgeted.countdowns(b)[1] == plain.countdowns(plain.main[0])[1] for b in budgeted.main), str([budgeted.countdowns(b) for b in budgeted.main]))
    check('a budget: the meter line still reaches the model, now alone', any('[budget] spent $' in json.dumps(b.get('messages')) for b in budgeted.main[1:]), '')
    check('each request starts with the one before it (the cache prefix holds), with and without onbudget',
          not prefix_breaks(plain.main) and not prefix_breaks(idle.main) and not prefix_breaks(budgeted.main), f'{prefix_breaks(plain.main)} {prefix_breaks(idle.main)} {prefix_breaks(budgeted.main)}')
    check('the effort cap reaches the wire: medium with a budget, the caller\'s high without',
          {effort_of(b) for b in budgeted.main} == {'medium'} and {effort_of(b) for b in idle.main} == {'high'}, f'{[effort_of(b) for b in budgeted.main]} {[effort_of(b) for b in idle.main]}')
    kept = Run('chosen', 'Say hi.', env=dict(ONBUDGET='$5', CLAUDE_CODE_TOTAL_TOKENS_REMINDER='fixed'))
    if has: check('a countdown the person configured (CLAUDE_CODE_TOTAL_TOKENS_REMINDER) is kept under a budget', sum(copies(kept)) > 0, f'{copies(kept)} {brief(kept)}')


def t_resume():
    """Across resumes, with the budget set during the session and removed again: no request rewrites an earlier one."""
    home = os.path.join(TMP, 'home-resume'); cwd = os.path.join(TMP, 'cwd-resume'); os.makedirs(cwd, exist_ok=True)
    a = Run('resume-a', 'Say hi.', home=home, cwd=cwd)
    time.sleep(11)   # a resume is told from a new session by its first launch, more than ten seconds before
    b = Run('resume-b', '/onbudget $5 Say hi again.', home=home, cwd=cwd, args=['--resume', a.session_id or 'missing'])
    c = Run('resume-c', 'One more thing.', home=home, cwd=cwd, args=['--resume', a.session_id or 'missing'])
    d = Run('resume-d', '/onbudget off', home=home, cwd=cwd, args=['--resume', a.session_id or 'missing'])
    e = Run('resume-e', 'And the last.', home=home, cwd=cwd, args=['--resume', a.session_id or 'missing'])
    runs = [x for x in (a, b, c, e) if x.main]
    seq = [body for x in runs for body in x.main]
    check('resume: four processes on one session ran (no budget, a budget set, the budget kept, the budget removed)',
          len(runs) == 4 and all(x.rc == 0 for x in (a, b, c, e)) and len(b.rows('budget')) == 1 and len(d.rows('off')) == 1, f'{[brief(x) for x in (a, b, c, d, e)]}')
    check('resume: every request starts with the one before it, across all four processes', not prefix_breaks(seq), f'breaks at {prefix_breaks(seq)} of {len(seq)}')
    na, nb, nc, ne = (copies(x) for x in (a, b, c, e))
    if not sum(na): print('INFO  this build attaches no token countdown: nothing to keep or leave out across resumes'); return
    # A resumed process's first request carries the old countdowns as they were sent; a new one in it cannot be told
    # from them, so it is kept (one copy). After that request none is added while the budget is open.
    check('resume: countdowns sent before stay; under the budget none is added after a process\'s first request; once removed they come back',
          na and na[-1] > 0 and nb[0] >= na[-1] and nb[-1] == nb[0] and nc[0] >= nb[-1] and nc[-1] == nc[0] and ne[-1] > ne[0], f'a={na} b={nb} c={nc} e={ne}')


def t_effortless():
    """onbudget beside effortless (EFFORTLESS_DIR), both orders: the cap holds or the override is reported, never silent."""
    if not EFFORTLESS:
        print('SKIP  effortless: set EFFORTLESS_DIR to a checkout of HeyCubit/effortless'); return
    head = subprocess.run(['git', '-C', EFFORTLESS, 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()
    print(f'      effortless at {head}')
    judge = '{"model":"opus","effort":"xhigh","sure":0.9,"why":"test"}'
    for order, plugins in (('onbudget first', (REPO, EFFORTLESS)), ('effortless first', (EFFORTLESS, REPO))):
        r = Run(f'effortless-{order.split()[0]}', 'Say hi.', env=dict(ONBUDGET='$5'), plugins=plugins, judge=judge)
        sent = [effort_of(b) for b in r.main]
        over = [x for x in r.rows('step') if x.get('effortOverBy')]
        budget = r.rows('budget')
        if set(sent) == {'medium'}:
            check(f'effortless, {order}: the cap holds on the wire and nothing is reported', budget and not over, f'sent={sent} over={over} {brief(r)}')
        else:
            check(f'effortless, {order}: effortless set {sorted(set(sent))} on the wire; onbudget logged it for every such request and named effortless',
                  budget and len(over) == sum(1 for x in sent if x != 'medium') and all(x['effortOverBy'] == 'effortless' and x['effortSent'] in sent for x in over),
                  f'sent={sent} over={[(x["effortSent"], x["effortOverBy"]) for x in over]} {brief(r)}')
        check(f'effortless, {order}: the budget\'s countdown rule and stop still apply', copies(r) == [0] * len(r.main) and r.rc == 0 and not r.rows('hookfail'), f'{copies(r)} {brief(r)}')


def t_capmod_off():
    """The evaluation's cap plugin in log-only mode (eval/capmod, CAP_RULE=off) changes nothing the model receives."""
    capmod = os.path.join(REPO, 'eval', 'capmod')
    plain = Run('capoff-plain', 'Say hi.', plugins=())
    logged = Run('capoff-logged', 'Say hi.', plugins=(capmod,), env=dict(CAP_USD='2.47', CAP_RULE='off', CAP_LOG=os.path.join(TMP, 'capoff.jsonl')))
    def same(r):
        """A run's requests with its own directories, session id and countdown figures put to one form."""
        text = json.dumps([dict(model=b.get('model'), system=bare(b.get('system')), messages=bare(b.get('messages')), tools=b.get('tools'),
                                output_config=b.get('output_config'), thinking=b.get('thinking'), max_tokens=b.get('max_tokens')) for b in r.main])
        for path, tag in ((r.cwd, '<cwd>'), (os.path.realpath(r.cwd), '<cwd>'), (r.home, '<home>'), (os.path.realpath(r.home), '<home>'), (r.session_id or '-', '<sid>')):
            text = text.replace(path, tag)
        text = text.replace(os.path.basename(r.dir), '<run>')   # the run's name, also inside the project folder's slug
        return re.sub(r'\d+ tokens left', 'N tokens left', text)
    rows = [json.loads(l) for l in open(os.path.join(TMP, 'capoff.jsonl'))] if os.path.exists(os.path.join(TMP, 'capoff.jsonl')) else []
    check('capmod off: it loaded and logged every request', len([x for x in rows if x['kind'] == 'step']) == len(logged.main) > 0 and logged.rc == 0, brief(logged))
    a, b = same(plain), same(logged)
    j = next((k for k in range(min(len(a), len(b))) if a[k] != b[k]), None)
    check('capmod off: the requests are those of plain Claude Code (model, system prompt, messages, tools, effort)', a == b,
          'equal' if a == b else f'first difference at {j}: {a[max(0, (j or 0) - 120):(j or 0) + 120]!r} vs {b[max(0, (j or 0) - 120):(j or 0) + 120]!r}')


CHECKS = dict(countdown=t_countdown, resume=t_resume, capmod=t_capmod_off, effortless=t_effortless)

if __name__ == '__main__':
    v = subprocess.run([CLAUDE, '--version'], capture_output=True, text=True).stdout.strip()
    print(f'claude: {v}   scratch: {TMP}')
    if sys.argv[1:] == ['probe']: probe(); sys.exit(0)
    for name in sys.argv[1:] or CHECKS:
        try: CHECKS[name]()
        except Exception as ex: check(f'{name}: ran to completion', False, repr(ex))
    print(f'\n{sum(RESULTS)} passed, {len(RESULTS) - sum(RESULTS)} failed')
    if all(RESULTS) and not os.environ.get('ONBUDGET_E2E_KEEP'): shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(0 if all(RESULTS) else 1)
