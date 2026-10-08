#!/usr/bin/env python3
"""Interactive checks of onbudget: a real Claude Code terminal session driven through a pseudo-terminal, at zero cost.

The session runs with onbudget and tests/e2e/mock (which answers every model request from a script) and with the
API base URL pointed at a closed local port, so nothing can be sent or billed. It types the commands a person
would type and reads the plugin's event log, the mock's log and the screen.

It runs in this repository's folder (already trusted, so no trust dialog) with your real Claude config directory,
because a fresh one would stop at the first-run screens. It cleans up after itself: the test sessions' transcripts
and the budgets they stored are deleted at the end.

usage: python3 tests/e2e/interactive.py            (ONBUDGET_CLAUDE_BIN selects another Claude Code build)
"""
import glob, json, os, pty, re, select, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
MOCK = os.path.join(HERE, 'mock')
CLAUDE = os.environ.get('ONBUDGET_CLAUDE_BIN', 'claude')
TMP = tempfile.mkdtemp(prefix='onbudget-pty-')
CONFIG = os.path.expanduser(os.environ.get('CLAUDE_CONFIG_DIR', '~/.claude'))
RESULTS, SESSIONS = [], []
ANSI = re.compile(r'\x1b\[[0-9;?<>=]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>78]')


def check(name, ok, detail=''):
    RESULTS.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f'\n      {detail}' if detail and not ok else ''))


class Session:
    def __init__(self, name, script, args=()):
        self.dir = os.path.join(TMP, name); os.makedirs(self.dir)
        self.log_path = os.path.join(self.dir, 'onbudget.jsonl'); self.mock_path = os.path.join(self.dir, 'mock.json')
        script_path = os.path.join(self.dir, 'script.json'); json.dump(script, open(script_path, 'w'))
        env = {k: v for k, v in os.environ.items() if not (k.startswith('CLAUDE') or k.startswith('ANTHROPIC_'))}
        env.update(CLAUDE_CODE_ENABLE_FUNCTION_HOOKS='1', ANTHROPIC_BASE_URL='http://127.0.0.1:9', CLAUDE_CODE_MAX_RETRIES='0', DISABLE_TELEMETRY='1',
                   DISABLE_AUTOUPDATER='1', TERM='xterm-256color', COLUMNS='160', LINES='50',
                   MOCK_SCRIPT=script_path, MOCK_LOG=self.mock_path, ONBUDGET_LOG=self.log_path)
        cmd = [CLAUDE, '--plugin-dir', REPO, '--plugin-dir', MOCK, '--permission-mode', 'acceptEdits', '--setting-sources', 'project,local',
               '--strict-mcp-config', '--allowedTools', 'Bash(echo:*)', '--model', 'sonnet', '--effort', 'high', *args]
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(REPO); os.execvpe(CLAUDE, cmd, env)
        self.buf = b''
        self.wait(lambda: self.rows('session.start'), 30)
        self.pump(2)
        for s in self.rows('session.start'): SESSIONS.append(s.get('sid'))

    def pump(self, secs):
        end = time.time() + secs
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.2)
            if r:
                try: self.buf += os.read(self.fd, 65536)
                except OSError: return

    def wait(self, cond, timeout=25):
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.3)
            try:
                if cond(): return True
            except Exception: pass
        return False

    def screen(self):
        return re.sub(r'\s+', ' ', ANSI.sub('', self.buf.decode('utf-8', 'replace')))

    def shows(self, text):
        """Whether the text is on screen. The terminal UI places words with cursor moves, so spacing is ignored."""
        return re.sub(r'\s+', '', text) in re.sub(r'\s+', '', self.screen())

    def mark(self):
        self.buf = b''

    def type(self, text, enter=True):
        for ch in text:
            os.write(self.fd, ch.encode()); time.sleep(0.02)
        self.pump(0.8)
        if enter: os.write(self.fd, b'\r')
        self.pump(0.5)

    def key(self, raw):
        os.write(self.fd, raw); self.pump(0.5)

    def rows(self, kind):
        rows, i = [], 0
        while True:
            path = self.log_path if i == 0 else f'{self.log_path}.{i}'
            if not os.path.exists(path): break
            rows += [json.loads(l) for l in open(path) if l.strip()]; i += 1
        return [r['data'] for r in rows if r['kind'] == kind]

    def mock(self, kind):
        try: return [r for r in json.load(open(self.mock_path)) if r['kind'] == kind]
        except Exception: return []

    def close(self):
        try:
            os.write(self.fd, b'\x03'); self.pump(0.5); os.write(self.fd, b'\x03'); self.pump(1.5)
        except OSError: pass
        try: os.kill(self.pid, 9)
        except Exception: pass
        try: os.waitpid(self.pid, 0)
        except Exception: pass


def main_session():
    script = [
        dict(bash='echo one', cost=0.30), dict(bash='echo two', cost=0.30), dict(bash='echo three', cost=0.30),  # budget 1: the 4th request is refused
        dict(text='free again'),                                                                                  # after /onbudget off
        dict(bash='echo a', cost=0.20), dict(bash='echo slow', cost=0.20, sleep_ms=6000),                         # budget 2: the slow one is interrupted
        dict(text='resumed after the interrupt', cost=0.10),
        dict(bash='echo c', cost=0.10), dict(text='after compaction', cost=0.10),
        dict(text='after clear'),
    ]
    s = Session('main', script)
    check('interactive: the session starts with the plugin loaded and no hook failure', len(s.rows('session.start')) == 1 and not s.rows('hookfail'), f"{s.rows('hookfail')} screen={s.screen()[-300:]!r}")

    s.mark(); s.type('/onbudget')
    check('interactive: /onbudget with no budget says so', s.wait(lambda: s.shows('no budget is set'), 10), s.screen()[-400:])

    s.mark(); s.type('/onbudget $1 Do the three things.')
    ok = s.wait(lambda: s.rows('stop'), 40)
    prompts = s.mock('prompt')
    check('interactive: /onbudget $1 <task> sets the budget and says so', len(s.rows('budget')) == 1 and s.shows('budget $1.00 set'), s.screen()[-500:])
    check('interactive: the task is submitted with the protocol, as the person\'s own prompt',
          prompts and prompts[-1]['text'].startswith('Do the three things.\n\nYou have a hard usage budget of $1.00') and prompts[-1]['origin'].get('asUser') is True, f"{prompts} hookfail={s.rows('hookfail')}")
    check('interactive: three requests are sent at the capped effort, each tool result gets a meter line',
          [x['effort'] for x in s.mock('step')] == ['medium'] * 3 and [t['injected'].split('|')[0].strip() for t in s.rows('tool')] == ['[budget] spent $0.30 of $1.00', '[budget] spent $0.60 of $1.00', '[budget] spent $0.90 of $1.00'],
          f"{s.mock('step')} {s.rows('tool')}")
    check('interactive: the fourth request is refused and the notice is on screen', ok and len(s.mock('step')) == 3 and s.shows('[onbudget] Stopped: $0.90 of $1.00 is used'), s.screen()[-600:])
    check('interactive: the status line shows the spent budget', s.shows('onbudget: budget spent ($0.90 of $1.00)') and not s.shows('onbudget: onbudget:'), s.screen()[-600:])

    s.mark(); s.type('continue please')
    check('interactive: a follow-up prompt on a spent budget is refused too, with the notice', s.wait(lambda: len(s.rows('stop')) == 2, 20) and len(s.mock('step')) == 3 and s.shows('[onbudget] Stopped'), s.screen()[-500:])

    s.mark(); s.type('/onbudget')
    check('interactive: /onbudget shows the stopped budget', s.wait(lambda: s.shows('STOPPED') and s.shows('$0.90 of $1.00 spent'), 10), s.screen()[-500:])

    s.mark(); s.type('/onbudget off')
    check('interactive: /onbudget off removes it', s.wait(lambda: s.shows('budget removed ($0.90 of $1.00 was spent'), 10) and len(s.rows('off')) == 1, s.screen()[-500:])

    s.mark(); s.type('hello again')
    check('interactive: with the budget off, requests flow at the caller\'s effort again', s.wait(lambda: len(s.mock('step')) == 4, 20) and s.mock('step')[3]['effort'] == 'high' and s.shows('free again'), f"{s.mock('step')[3:]} {s.screen()[-300:]!r}")

    # A second budget; interrupt a request in flight with Esc; the budget and its accounting carry on.
    s.mark(); s.type('/onbudget $5 Second task.')
    in_flight = s.wait(lambda: len(s.mock('request')) == 6, 30)  # the slow request has started
    s.pump(1.0); s.key(b'\x1b'); s.pump(2.0)
    check('interactive: Esc interrupts a request in flight under a budget', in_flight and len(s.mock('step')) == 5, f"requests={len(s.mock('request'))} steps={len(s.mock('step'))} screen={s.screen()[-300:]!r}")
    s.mark(); s.type('go on after the interrupt')
    ok = s.wait(lambda: len(s.mock('step')) >= 6 and len(s.rows('step')) >= 5, 30)
    step_rows = s.rows('step')
    last = step_rows[-1] if step_rows else {}
    prompts = s.mock('prompt')
    check('interactive: after the interrupt the next request is sent, nothing is left counted as in flight, and the spend is right',
          ok and last.get('inFlight') == 0 and abs(last.get('spent', 0) - 0.30) < 1e-9 and not s.rows('stop')[2:], f'{last} stops={s.rows("stop")}')
    check('interactive: the follow-up prompt carried the meter reading', prompts and prompts[-1]['context'] and prompts[-1]['context'][0].startswith('[budget] spent $0.20 of $5.00'), str(prompts[-1:]))

    s.mark(); s.type('/compact')
    compacted = s.wait(lambda: s.rows('compact'), 40)
    s.pump(2)
    s.mark(); s.type('do one more thing')
    ok = s.wait(lambda: len(s.mock('step')) >= 8, 40)
    prompts = s.mock('prompt')
    check('interactive: after /compact the protocol is sent again with the next prompt, beside the meter reading',
          compacted and ok and prompts[-1]['context'] and '[budget] spent $0.30 of $5.00' in prompts[-1]['context'][0] and 'Reminder, in case the earlier instruction was summarised away:\nYou have a hard usage budget of $5.00' in prompts[-1]['context'][0],
          f"compact={s.rows('compact')} mock={s.mock('compact')} prompt={prompts[-1:]} hookfail={s.rows('hookfail')}")
    check('interactive: the reminder is sent once', not any(t.get('reminded') for t in s.rows('tool')), str(s.rows('tool')[-2:]))

    s.wait(lambda: s.shows('after compaction'), 15)
    s.mark(); s.type('/clear'); s.pump(3)
    s.mark(); s.type('/onbudget')
    check('interactive: /clear ends the budget', s.wait(lambda: s.shows('no budget is set'), 10), s.screen()[-400:])
    s.mark(); s.type('one last prompt')
    check('interactive: after /clear requests are untouched', s.wait(lambda: s.shows('after clear'), 20) and s.mock('step')[-1]['effort'] == 'high', f"{s.mock('step')[-1:]} {s.screen()[-300:]!r}")
    check('interactive: no hook failed in the whole session', not s.rows('hookfail') and not s.rows('stopfail'), f"{s.rows('hookfail')} {s.rows('stopfail')}")
    s.close()


def resume_session():
    a = Session('resume-a', [dict(bash='echo 1', cost=0.4), dict(text='paused here', cost=0.1)])
    a.type('/onbudget $2 Start the long task.')
    a.wait(lambda: a.shows('paused here'), 30)
    sid = (a.rows('session.start') or [{}])[0].get('sid')
    a.close()
    b = Session('resume-b', [dict(text='picked up', cost=0.1)], args=['--resume', sid or 'missing'])
    start = b.rows('session.start')
    check('interactive resume: the budget is restored and the status line shows it', start and start[0].get('restored') is True and b.wait(lambda: b.shows('of $2.00'), 10), f'{start} {b.screen()[-400:]!r}')
    b.mark(); b.type('/onbudget')
    check('interactive resume: /onbudget shows the spend carried over', b.wait(lambda: b.shows('$0.50 of $2.00 spent'), 10), b.screen()[-400:])
    b.mark(); b.type('/onbudget off'); b.wait(lambda: b.shows('budget removed'), 10)
    b.close()


def cleanup():
    """Delete the test sessions' transcripts and any budget they left in the plugin's store."""
    slug = re.sub(r'[^A-Za-z0-9]', '-', REPO)
    removed = 0
    for sid in {x for x in SESSIONS if x}:
        for path in glob.glob(os.path.join(CONFIG, 'projects', slug, f'{sid}*')):
            (shutil.rmtree if os.path.isdir(path) else os.remove)(path); removed += 1
        for path in glob.glob(os.path.join(CONFIG, 'plugins', 'store', 'onbudget*.json')):
            try:
                d = json.load(open(path)); keys = [k for k in d if k.endswith(f':{sid}')]
                for k in keys: del d[k]
                if keys: json.dump(d, open(path, 'w'), indent=2)
            except Exception: pass
    print(f'cleaned up {removed} test transcript file(s) for {len(set(SESSIONS))} session(s)')


if __name__ == '__main__':
    for plugin in (REPO, MOCK):
        if subprocess.run([CLAUDE, 'plugin', 'validate', plugin], capture_output=True).returncode != 0: sys.exit(f'plugin does not validate: {plugin}')
    print('claude:', subprocess.run([CLAUDE, '--version'], capture_output=True, text=True).stdout.strip(), '  scratch:', TMP)
    try:
        for part in (main_session, resume_session):
            try: part()
            except Exception as ex: check(f'{part.__name__}: ran to completion', False, repr(ex))
    finally:
        cleanup()
    print(f'\n{sum(RESULTS)} passed, {len(RESULTS) - sum(RESULTS)} failed')
    if all(RESULTS) and not os.environ.get('ONBUDGET_E2E_KEEP'): shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(0 if all(RESULTS) else 1)
