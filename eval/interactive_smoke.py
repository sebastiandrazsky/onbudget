#!/usr/bin/env python3
"""One PAID interactive check: a real terminal session with the real model under onbudget. Costs about $0.50.

tests/e2e/interactive.py drives the same paths against a scripted model at no cost. This run is the part that needs the real
one: the command typed at the prompt, the task submitted with the protocol, the model working under the meter, its final
STATUS line, the status line, and the plugin's stop on a budget too small to finish. The plugin's own budgets bound the spend
($0.50 and $0.07); the driver also gives up after fixed timeouts.

It runs in eval/tmp/interactive-real/ (inside this repository, so the folder is already trusted) with your real Claude
config, and saves the plugin's event log, the screen text and a summary to eval/runs/interactive-real-<n>/.

usage: python3 eval/interactive_smoke.py
"""
import glob, json, os, pty, re, select, shutil, subprocess, sys, time

EVAL = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(EVAL)
CLAUDE = os.environ.get('ONBUDGET_CLAUDE_BIN', 'claude')
CWD = os.path.join(EVAL, 'tmp', 'interactive-real')
ANSI = re.compile(r'\x1b\[[0-9;?<>=]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>78]')
RESULTS = []


def check(name, ok, detail=''):
    RESULTS.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f'\n      {detail}' if detail and not ok else ''), flush=True)


class Session:
    def __init__(self, run_dir):
        self.log_path = os.path.join(run_dir, 'onbudget.jsonl')
        env = {k: v for k, v in os.environ.items() if not (k.startswith('CLAUDE') or k.startswith('ANTHROPIC_') or k.startswith('ONBUDGET'))}
        env.update(CLAUDE_CODE_ENABLE_FUNCTION_HOOKS='1', DISABLE_AUTOUPDATER='1', TERM='xterm-256color', COLUMNS='160', LINES='50', ONBUDGET_LOG=self.log_path)
        if os.environ.get('SMOKE_NO_SUGGESTIONS'): env['CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION'] = 'false'   # to see what Claude Code's own request after a turn costs
        cmd = [CLAUDE, '--plugin-dir', REPO, '--permission-mode', 'acceptEdits', '--setting-sources', 'project,local', '--strict-mcp-config',
               '--allowedTools', 'Bash(python3 -m unittest:*),Bash(ls:*)', '--disallowedTools', 'WebFetch,WebSearch', '--model', 'opus[1m]', '--effort', 'high']
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(CWD); os.execvpe(CLAUDE, cmd, env)
        self.buf = b''; self.all = b''; self.fresh = b''; self.dialogs = 0; self.declined = 0
        self.wait(lambda: self.rows('session.start'), 40); self.pump(3)

    def pump(self, secs):
        end = time.time() + secs
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.2)
            if r:
                try: chunk = os.read(self.fd, 65536)
                except OSError: return
                self.buf += chunk; self.all += chunk; self.fresh += chunk
        fresh = re.sub(r'\s+', '', ANSI.sub('', self.fresh.decode('utf-8', 'replace')))
        if 'LSPrecommendations' in fresh:
            # Claude Code offers a language-server plugin when it sees Python files. That is not this check's to accept: answer "No".
            self.fresh = b''; self.declined += 1
            os.write(self.fd, b'2'); time.sleep(1)
        elif re.search(r'Doyouwantto(create|makethisedit|overwrite|proceed).*1\.Yes', fresh):
            # Claude Code asks before it creates or edits a file in this folder; answer "Yes" as a person at the prompt would.
            self.fresh = b''; self.dialogs += 1
            os.write(self.fd, b'\r'); time.sleep(1)

    def wait(self, cond, timeout):
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.5)
            try:
                if cond(): return True
            except Exception: pass
        return False

    def turn_over(self, timeout):
        """Wait until the main thread's newest request ended its turn (or was refused), or `timeout`."""
        def over():
            last = [r for r in self.rows(None) if r['kind'] in ('step', 'stop', 'budget') and not r['data'].get('agentId')][-1]
            return last['kind'] == 'stop' or (last['kind'] == 'step' and last['data']['stopReason'] == 'end_turn')
        ok = self.wait(over, timeout); self.pump(3)
        return ok

    def shows(self, text, everything=False):
        screen = re.sub(r'\s+', '', ANSI.sub('', (self.all if everything else self.buf).decode('utf-8', 'replace')))
        return re.sub(r'\s+', '', text) in screen

    def mark(self): self.buf = b''; self.fresh = b''

    def type(self, text):
        for ch in text:
            os.write(self.fd, ch.encode()); time.sleep(0.02)
        self.pump(1); os.write(self.fd, b'\r'); self.pump(1)

    def rows(self, kind):
        try: rows = [json.loads(l) for l in open(self.log_path) if l.strip()]
        except OSError: return []
        return rows if kind is None else [r['data'] for r in rows if r['kind'] == kind]

    def close(self):
        try:
            os.write(self.fd, b'\x03'); self.pump(0.5); os.write(self.fd, b'\x03'); self.pump(2)
        except OSError: pass
        try: os.kill(self.pid, 9)
        except Exception: pass
        try: os.waitpid(self.pid, 0)
        except Exception: pass


def main():
    n = 1
    while os.path.exists(os.path.join(EVAL, 'runs', f'interactive-real-{n}')): n += 1
    run_dir = os.path.join(EVAL, 'runs', f'interactive-real-{n}'); os.makedirs(run_dir)
    shutil.rmtree(CWD, ignore_errors=True); os.makedirs(CWD)
    if subprocess.run([CLAUDE, 'plugin', 'validate', os.path.join(REPO, '.claude-plugin', 'plugin.json')], capture_output=True).returncode != 0:
        sys.exit('the plugin does not validate; nothing was run')
    s = Session(run_dir)
    try:
        check('the session starts with the plugin loaded', len(s.rows('session.start')) == 1 and not s.rows('hookfail'), str(s.rows('hookfail')))
        s.mark(); s.type('/onbudget')
        check('/onbudget with no budget says so', s.wait(lambda: s.shows('no budget is set'), 15))

        s.mark(); s.type('/onbudget $0.50 Create fizzbuzz.py with a function fizzbuzz(n), and test_fizzbuzz.py using unittest. Create the files with the Write tool, then run the tests with exactly: python3 -m unittest')
        started = s.wait(lambda: s.rows('step'), 60)
        done = s.turn_over(300)
        steps, tools, budget = s.rows('step'), s.rows('tool'), s.rows('budget')
        check('the command sets the budget and the task starts by itself', started and len(budget) == 1 and budget[0]['usd'] == 0.5 and s.shows('budget $0.50 set', True), str(budget))
        check('the task entered as the prompt, with the protocol appended', s.shows('You have a hard usage budget of $0.50 for this task', True))
        check('every request went out at medium effort although the session is at high', steps and all(x['effort'] == 'medium' and x['callerEffort'] == 'high' for x in steps), str([(x['effort'], x['callerEffort']) for x in steps]))
        check('the model was shown a meter line after each tool result', tools and all(t['injected'].startswith('[budget] spent $') for t in tools), str(tools[:2]))
        check('the turn ended by itself, within the budget, with a STATUS line', done and not s.rows('stop') and steps[-1]['spent'] <= 0.5 and s.shows('STATUS: COMPLETE', True), f"spent={steps[-1]['spent'] if steps else None} stops={s.rows('stop')}")
        check('the files exist and the tests pass', os.path.exists(os.path.join(CWD, 'fizzbuzz.py')) and subprocess.run([sys.executable, '-m', 'unittest'], cwd=CWD, capture_output=True).returncode == 0)
        check('the status line shows the spend', s.shows('onbudget: spent $', True) and s.shows('of $0.50', True))

        s.pump(6); s.mark(); s.type('/onbudget')
        check('/onbudget shows the budget, the spend and the request count', s.wait(lambda: s.shows('of $0.50 spent') and s.shows('requests:'), 25))

        s.mark(); s.type('/onbudget $0.07 Write a design document for a plugin system into design.md in ten sections. Use the Write tool for the first section and one separate Edit call for each later section.')
        stopped = s.wait(lambda: s.rows('stop'), 240)
        s.pump(3)
        stop = (s.rows('stop') or [{}])[0]
        check('a budget too small to finish is stopped by the plugin, with its notice on screen', stopped and stop.get('event') == 'reserve-stop' and s.shows('[onbudget] Stopped:', True) and s.shows('not from Claude', True), str(stop))
        second = stop.get('spent', 0)
        check('the stop came within the budget, or over it by less than one request', second <= 0.07 + stop.get('reserve', 0), f'spent {second} reserve {stop.get("reserve")}')
        check('the status line shows the stop', s.shows('onbudget: stopped at', True))

        answered = len(s.rows('step'))
        s.mark(); s.type('continue')
        check('a follow-up on the stopped budget is turned away with the reason and no request is sent',
              s.wait(lambda: s.shows('the budget has stopped this session'), 30) and len(s.rows('step')) == answered and len(s.rows('stop')) == 1)

        s.mark(); s.type('/onbudget off')
        check('/onbudget off removes the budget', s.wait(lambda: s.shows('budget removed'), 15) and len(s.rows('off')) == 1)
        after = (s.rows('off') or [{}])[0].get('spent', 0)
        print(f"      note: spend at the stop ${second:.3f}, when the budget was removed ${after:.3f} (the difference is Claude Code's own requests after the stop, which no plugin can refuse)")
        check('no hook failed', not s.rows('hookfail') and not s.rows('stopfail'), f"{s.rows('hookfail')} {s.rows('stopfail')}")
    finally:
        s.close()
        ledger = max([x['costUsd'] for x in s.rows('step')] or [0])
        screen = re.sub(r'[ \t]+', ' ', ANSI.sub('', s.all.decode('utf-8', 'replace')))
        open(os.path.join(run_dir, 'screen.txt'), 'w').write(screen)
        json.dump(dict(checks=RESULTS, permission_dialogs_answered=s.dialogs, plugin_offers_declined=s.declined, passed=sum(ok for _, ok in RESULTS), failed=sum(not ok for _, ok in RESULTS), session_cost_usd=ledger,
                       claude=subprocess.run([CLAUDE, '--version'], capture_output=True, text=True).stdout.strip(), at=time.strftime('%Y-%m-%d %H:%M:%S')),
                  open(os.path.join(run_dir, 'summary.json'), 'w'), indent=1)
        sid = (s.rows('session.start') or [{}])[0].get('sid')
        if sid:
            for path in glob.glob(os.path.expanduser(f'~/.claude/projects/*/{sid}*')): (shutil.rmtree if os.path.isdir(path) else os.remove)(path)
        print(f"\n{sum(ok for _, ok in RESULTS)} passed, {sum(not ok for _, ok in RESULTS)} failed | session cost ${ledger:.2f} | saved in {run_dir}")


if __name__ == '__main__':
    main()
