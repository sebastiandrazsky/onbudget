#!/usr/bin/env python3
"""One PAID interactive check: a real terminal session with the real model under onbudget. Costs about $0.50.

tests/e2e/interactive.py drives the same paths against a scripted model at no cost. This run is the part that needs the real
one: the command typed at the prompt, the task submitted with the protocol, the model working under the meter, its final
STATUS line, the status line, and the plugin's stop on a budget too small to finish. The plugin's own budgets bound the spend
($0.50 and $0.07); the driver also gives up after fixed timeouts.

It runs in eval/tmp/interactive-real/ (inside this repository, so the folder is already trusted) with your real Claude
config, and saves the plugin's event log, the screen text and a summary to eval/runs/interactive-real-<n>/.

Permission prompts: it answers No (Esc) to every Claude Code permission dialog except one. It answers Yes only to a
"Create file" or "Edit file" dialog whose target path, read from that dialog's own box, is inside its own working folder
(compared with realpath and commonpath; on macOS /tmp is /private/tmp). Every Bash prompt is answered No, and so is any
path that is wrapped, cut ("…"), relative with "..", written from the home folder ("~/…"), or outside the folder, and any dialog it does not recognise,
including one taller than the screen, whose heading has scrolled off. It
never types while a dialog is open, and it closes the session with signals. Each dialog, its target and the answer are
in the summary. A model that writes outside the folder or runs other commands is refused, and the run may then fail its
checks: that is the intended cost of never approving them. `tests/e2e/dialogs.py` tests the matcher at no cost.

usage: python3 eval/interactive_smoke.py
"""
import codecs, fcntl, glob, json, os, pty, re, select, shutil, signal, struct, subprocess, sys, termios, time

EVAL = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(EVAL)
CLAUDE = os.environ.get('ONBUDGET_CLAUDE_BIN', 'claude')
CWD = os.path.join(EVAL, 'tmp', 'interactive-real')
ANSI = re.compile(r'\x1b\[[0-9;?<>=]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>78]')
RESULTS = []
COLS, ROWS = 80, 50
sys.path.insert(0, os.path.join(REPO, 'tests', 'e2e'))
from screen import Screen  # noqa: E402

# ---------------------------------------------------------------- permission dialogs: deny by default
# A dialog as Claude Code 2.1.304 to 2.1.306 draw it, at the bottom of the screen:
#   ──────────── (a full-width rule: the box's top edge)
#    Create file | Edit file | Bash command | ...   (the kind)
#    <path>                                          (file dialogs: the target, relative to the working folder or absolute)
#   ╌╌╌╌╌╌╌╌╌╌╌╌ (a dashed rule: what follows is the content)
#    ...
#    Do you want to create <name>? | Do you want to make this edit to <name>? | Do you want to proceed?
#    ❯ 1. Yes
#      2. ...
#    Esc to cancel · Tab to amend
RULE = re.compile(r'^\s*─{20,}\s*$')
DASHED = re.compile(r'^\s*╌{10,}\s*$')
FOOTER = re.compile(r'^\s*Esc to cancel\b')
QUESTION = re.compile(r'^\s*Do you want to (.+)\?\s*$')
FIRST = re.compile(r'^\s*❯?\s*1\.\s+Yes\s*$')
FILE_KINDS = {'Create file': 'create ', 'Edit file': 'make this edit to '}


def find_dialog(rows):
    """The permission dialog on screen, read from its own box, or None: the box runs from the last full-width rule above
    the last "Esc to cancel" line to that line. Nothing outside the box is read (the banner shows the working path)."""
    ends = [i for i, l in enumerate(rows) if FOOTER.match(l)]
    if not ends: return None
    end = ends[-1]
    tops = [i for i in range(end) if RULE.match(rows[i])]
    # A dialog taller than the screen has its edge and heading scrolled off: it is still a dialog, of no known kind.
    box = [l.rstrip() for l in rows[tops[-1] + 1:end]] if tops else ['(heading off screen)'] + [l.rstrip() for l in rows[:end]]
    if not box: return None
    # A box with no question (an offer of Claude Code's own) is still a dialog: it gets No, never typed input.
    questions = [i for i, l in enumerate(box) if QUESTION.match(l)]
    q = questions[-1] if questions else None
    return dict(kind=box[0].strip(), box=box, question=QUESTION.match(box[q]).group(1).strip() if q is not None else '',
                first=box[q + 1].strip() if q is not None and q + 1 < len(box) else '', sig='\n'.join(box))


def decide(dialog, cwd):
    """'yes' or 'no' for a dialog, and why. Yes only for a create or edit of a file inside `cwd`, as the dialog states it."""
    kind = dialog['kind']
    if kind not in FILE_KINDS: return 'no', f'{kind or "unrecognised"}: only file creates and edits are approved'
    box = dialog['box']
    if len(box) < 3 or not DASHED.match(box[2]): return 'no', 'the path is wrapped or missing'
    path = box[1].strip()
    if not path or '…' in path or '..' in path or any(c.isspace() for c in path): return 'no', f'the path {path!r} is cut, relative with "..", or unclear'
    # Claude Code writes a path under the home folder as ~/...; not absolute, it would otherwise be read as inside the folder.
    if path.startswith('~') or any(c in path for c in '$`'): return 'no', f'the path {path!r} names the home folder or a variable'
    target = os.path.realpath(path if os.path.isabs(path) else os.path.join(cwd, path))
    root = os.path.realpath(cwd)
    if target == root or os.path.commonpath([root, target]) != root: return 'no', f'{target} is outside {root}'
    if dialog['question'] != FILE_KINDS[kind] + os.path.basename(target): return 'no', f'the question ({dialog["question"]!r}) does not name {os.path.basename(target)}'
    if not FIRST.match(dialog['first']): return 'no', f'the first option is not "1. Yes" ({dialog["first"]!r})'
    return 'yes', f'{kind.lower()} inside the working folder'


def target_of(dialog):
    """What a dialog is about, for the record: a file dialog's path, else the first line between its dashed rules (a command)."""
    box = dialog['box']
    if dialog['kind'] in FILE_KINDS: return box[1].strip() if len(box) > 1 else ''
    if dialog['kind'] == '(heading off screen)': return ''
    dashes = [i for i, l in enumerate(box) if DASHED.match(l)]
    inner = box[dashes[0] + 1:dashes[1]] if len(dashes) > 1 else box[1:]
    return ' '.join(l.strip().lstrip('│').strip() for l in inner if l.strip())[:200]


def input_open(rows):
    """Whether Claude Code's prompt box is on screen and no dialog is: a "❯" line between two full-width rules."""
    if find_dialog(rows): return False
    for i in range(len(rows) - 2):
        if RULE.match(rows[i]) and re.match(r'^\s*❯(?!\s*\d\.)', rows[i + 1]) and any(RULE.match(r) for r in rows[i + 2:i + 6]): return True
    return False


def check(name, ok, detail=''):
    RESULTS.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f'\n      {detail}' if detail and not ok else ''), flush=True)


class Session:
    def __init__(self, run_dir):
        self.log_path = os.path.join(run_dir, 'onbudget.jsonl')
        env = {k: v for k, v in os.environ.items() if not (k.startswith('CLAUDE') or k.startswith('ANTHROPIC_') or k.startswith('ONBUDGET'))}
        env.update(DISABLE_AUTOUPDATER='1', TERM='xterm-256color', COLUMNS='160', LINES='50', ONBUDGET_LOG=self.log_path)
        if os.environ.get('SMOKE_NO_SUGGESTIONS'): env['CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION'] = 'false'   # to see what Claude Code's own request after a turn costs
        cmd = [CLAUDE, '--plugin-dir', REPO, '--permission-mode', 'acceptEdits', '--setting-sources', 'project,local', '--strict-mcp-config',
               '--allowedTools', 'Bash(python3 -m unittest:*),Bash(ls:*)', '--disallowedTools', 'WebFetch,WebSearch', '--model', 'opus[1m]', '--effort', 'high']
        env.update(COLUMNS=str(COLS), LINES=str(ROWS))
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(CWD); os.execvpe(CLAUDE, cmd, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
        self.vt, self.utf8 = Screen(COLS, ROWS), codecs.getincrementaldecoder('utf-8')('replace')
        self.buf = b''; self.all = b''; self.dialogs = []; self.pending = None; self.answered = None
        self.wait(lambda: self.rows('session.start'), 40); self.pump(3)

    def pump(self, secs):
        end = time.time() + secs
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.2)
            if r:
                try: chunk = os.read(self.fd, 65536)
                except OSError: return
                self.buf += chunk; self.all += chunk; self.vt.feed(self.utf8.decode(chunk))
            self.answer()

    def screen_rows(self):
        return [self.vt.row(y) for y in range(ROWS)]

    def answer(self):
        """Answers a permission dialog once it has been drawn the same twice in a row: Yes only to a create or edit inside
        CWD, No (Esc) to everything else. A dialog still there 5 seconds after its answer is answered again."""
        d = find_dialog(self.screen_rows())
        if not d: self.pending = None; return
        if self.answered and self.answered[0] == d['sig'] and time.time() - self.answered[1] < 5: return
        if self.pending != d['sig']: self.pending = d['sig']; return
        verdict, why = decide(d, CWD)
        target = target_of(d)
        self.dialogs.append(dict(t=time.strftime('%H:%M:%S'), kind=d['kind'], target=target[:200], question=d['question'][:200], answer=verdict, why=why))
        print(f"      dialog: {d['kind']!r} {target[:80]!r} -> {verdict} ({why})", flush=True)
        os.write(self.fd, b'1' if verdict == 'yes' else b'\x1b')
        self.answered, self.pending = (d['sig'], time.time()), None

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

    def mark(self): self.buf = b''

    def keys(self, raw):
        """Sends keys to the prompt, never into a dialog: waits for the prompt box, and refuses after 60 seconds."""
        if not self.wait(lambda: input_open(self.screen_rows()), 60):
            raise RuntimeError('the prompt did not come back (a dialog or a turn is still open); nothing was typed')
        os.write(self.fd, raw)

    def type(self, text):
        self.keys(b'\x15')   # Claude Code 2.1.299 puts a turned-away prompt back into the input box: clear it (Ctrl-U)
        self.pump(0.3)
        for ch in text:
            if find_dialog(self.screen_rows()): raise RuntimeError('a dialog opened while typing; stopped')
            os.write(self.fd, ch.encode()); time.sleep(0.02)
        self.pump(1)
        self.keys(b'\r'); self.pump(1)

    def rows(self, kind):
        try: rows = [json.loads(l) for l in open(self.log_path) if l.strip()]
        except OSError: return []
        return rows if kind is None else [r['data'] for r in rows if r['kind'] == kind]

    def close(self):
        """Ends the session with signals, never keystrokes: a key could land in an open dialog."""
        for sig, grace in ((signal.SIGTERM, 5), (signal.SIGKILL, 5)):
            try: os.kill(self.pid, sig)
            except ProcessLookupError: return
            end = time.time() + grace
            while time.time() < end:
                try:
                    if os.waitpid(self.pid, os.WNOHANG) != (0, 0): return
                except ChildProcessError: return
                time.sleep(0.2)


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
        check('when Claude ends the task the plugin says so, with the spend, and that the budget is still open',
              s.wait(lambda: s.shows('Claude ended the task with STATUS: COMPLETE', True) and s.shows('The budget is still open', True), 10))

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

        # Added 2026-10-20: a budget of what the 5-hour window has left, sized from the session's own reading.
        s.mark(); s.type('/onbudget 5h Reply with the single word ready, and use no tools.')
        sized = s.wait(lambda: len(s.rows('budget')) == 3, 30); s.turn_over(120)
        b5 = (s.rows('budget') or [{}])[-1]
        check('/onbudget 5h is sized from the live 5-hour reading (dollars with a learned rate, points without), and the windows are read as walls',
              sized and b5.get('raw') == '5h' and not b5.get('pending') and (isinstance(b5.get('usd'), (int, float)) or isinstance(b5.get('allowance'), (int, float)))
              and 'five_hour' in (b5.get('walls') or {}) and s.shows('what the 5-hour usage window had left', True), str(b5)[:400])
        s.mark(); s.type('/onbudget off')
        s.wait(lambda: len(s.rows('off')) == 2, 15)
        print(f"      note: spend at the stop ${second:.3f}, when the budget was removed ${after:.3f} (the difference is Claude Code's own requests after the stop, which no plugin can refuse)")
        check('no hook failed', not s.rows('hookfail') and not s.rows('stopfail'), f"{s.rows('hookfail')} {s.rows('stopfail')}")
    finally:
        s.close()
        ledger = max([x['costUsd'] for x in s.rows('step')] or [0])
        screen = re.sub(r'[ \t]+', ' ', ANSI.sub('', s.all.decode('utf-8', 'replace')))
        open(os.path.join(run_dir, 'screen.txt'), 'w').write(screen)
        json.dump(dict(checks=RESULTS, permission_dialogs=s.dialogs, approved=sum(d['answer'] == 'yes' for d in s.dialogs), refused=sum(d['answer'] == 'no' for d in s.dialogs), passed=sum(ok for _, ok in RESULTS), failed=sum(not ok for _, ok in RESULTS), session_cost_usd=ledger,
                       claude=subprocess.run([CLAUDE, '--version'], capture_output=True, text=True).stdout.strip(), at=time.strftime('%Y-%m-%d %H:%M:%S')),
                  open(os.path.join(run_dir, 'summary.json'), 'w'), indent=1)
        sid = (s.rows('session.start') or [{}])[0].get('sid')
        if sid:
            for path in glob.glob(os.path.expanduser(f'~/.claude/projects/*/{sid}*')): (shutil.rmtree if os.path.isdir(path) else os.remove)(path)
        print(f"\n{sum(ok for _, ok in RESULTS)} passed, {sum(not ok for _, ok in RESULTS)} failed | session cost ${ledger:.2f} | saved in {run_dir}")


if __name__ == '__main__':
    main()
