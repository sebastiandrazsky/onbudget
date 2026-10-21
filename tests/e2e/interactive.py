#!/usr/bin/env python3
"""Interactive checks of onbudget: a real Claude Code terminal session driven through a pseudo-terminal, at zero cost.

The session runs with onbudget and tests/e2e/mock (which answers every model request from a script) and with the
API base URL pointed at a closed local port, so nothing can be sent or billed. It types the commands a person
would type and reads the plugin's event log, the mock's log and the screen.

It runs in this repository's folder (already trusted, so no trust dialog) with your real Claude config directory,
because a fresh one would stop at the first-run screens. It cleans up after itself: the test sessions' transcripts,
the budgets and calibration records they stored are deleted at the end, and the last readings of the usage windows
kept in the plugin's store (which the scripted readings overwrite) are put back as they were.

usage: python3 tests/e2e/interactive.py            (ONBUDGET_CLAUDE_BIN selects another Claude Code build)
"""
import codecs, fcntl, glob, json, os, pty, re, select, shutil, struct, subprocess, sys, tempfile, termios, time, unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
MOCK = os.path.join(HERE, 'mock')
CLAUDE = os.environ.get('ONBUDGET_CLAUDE_BIN', 'claude')
TMP = tempfile.mkdtemp(prefix='onbudget-pty-')
CONFIG = os.path.expanduser(os.environ.get('CLAUDE_CONFIG_DIR', '~/.claude'))
RESULTS, SESSIONS, CUT = [], [], []
COLS, ROWS = 80, 50  # the terminal's size: 80 columns, the usual default and the narrowest the status line is built for
# The last readings of the usage windows in the plugin's store, as they were before the scripted sessions wrote theirs.
SEEN = {}
for _p in glob.glob(os.path.join(CONFIG, 'plugins', 'store', 'onbudget*.json')):
    try: SEEN[_p] = {k: v for k, v in json.load(open(_p)).items() if k.startswith('seen:')}
    except Exception: pass
ANSI = re.compile(r'\x1b\[[0-9;?<>=]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>78]')


class Screen:
    """Enough of a terminal to know what Claude Code has drawn. Its renderer moves the cursor and skips cells that have
    not changed, so the bytes alone do not spell out the screen. `seen` keeps every row as it stood after each read."""
    CSI = re.compile(r'\x1b\[([?<>=]?)([0-9;:]*)[ -/]*([@-~])')

    def __init__(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.grid = [[' '] * cols for _ in range(rows)]
        self.x = self.y = self.top = 0
        self.bottom = rows - 1
        self.saved, self.history, self.seen, self.rest = (0, 0), [], set(), ''

    def row(self, y): return ''.join(self.grid[y]).rstrip()
    def text(self): return '\n'.join(self.history + [self.row(y) for y in range(self.rows)])

    def scroll(self, n=1, up=True):
        for _ in range(n):
            if up:
                if self.top == 0: self.history.append(self.row(0))
                del self.grid[self.top]; self.grid.insert(self.bottom, [' '] * self.cols)
            else:
                del self.grid[self.bottom]; self.grid.insert(self.top, [' '] * self.cols)

    def lf(self):
        if self.y == self.bottom: self.scroll()
        else: self.y = min(self.rows - 1, self.y + 1)

    def put(self, c):
        w = 2 if unicodedata.east_asian_width(c) in 'WF' else 0 if unicodedata.combining(c) or c in '\u200b\u200d\ufe0e\ufe0f' else 1
        if w == 0: return
        if self.x + w > self.cols: self.x = 0; self.lf()
        self.grid[self.y][self.x] = c
        if w == 2 and self.x + 1 < self.cols: self.grid[self.y][self.x + 1] = ''
        self.x += w

    def erase(self, y, a, b):
        for x in range(max(0, a), min(self.cols, b)): self.grid[y][x] = ' '

    def csi(self, private, params, final):
        if private and final not in 'JK': return  # modes and private queries change nothing on screen
        nums = [int(p) if p.isdigit() else 0 for p in params.replace(':', ';').split(';')] if params else []
        n = nums[0] if nums and nums[0] else 1
        x, y = self.x, self.y
        if final == 'A': self.y = max(0, y - n)
        elif final == 'B': self.y = min(self.rows - 1, y + n)
        elif final == 'C': self.x = min(self.cols - 1, x + n)
        elif final == 'D': self.x = max(0, min(x, self.cols - 1) - n)
        elif final == 'E': self.x, self.y = 0, min(self.rows - 1, y + n)
        elif final == 'F': self.x, self.y = 0, max(0, y - n)
        elif final == 'G': self.x = min(self.cols - 1, n - 1)
        elif final in 'Hf': self.y, self.x = min(self.rows - 1, n - 1), min(self.cols - 1, (nums[1] if len(nums) > 1 and nums[1] else 1) - 1)
        elif final == 'd': self.y = min(self.rows - 1, n - 1)
        elif final == 'J':
            mode = nums[0] if nums else 0
            if mode == 0: self.erase(y, x, self.cols); [self.erase(r, 0, self.cols) for r in range(y + 1, self.rows)]
            elif mode == 1: self.erase(y, 0, x + 1); [self.erase(r, 0, self.cols) for r in range(0, y)]
            else: [self.erase(r, 0, self.cols) for r in range(self.rows)]
        elif final == 'K':
            mode = nums[0] if nums else 0
            self.erase(y, *((x, self.cols) if mode == 0 else (0, x + 1) if mode == 1 else (0, self.cols)))
        elif final == 'X': self.erase(y, x, x + n)
        elif final == 'P': row = self.grid[y]; del row[x:x + n]; row.extend([' '] * (self.cols - len(row)))
        elif final == '@': row = self.grid[y]; row[x:x] = [' '] * n; del row[self.cols:]
        elif final == 'L' and self.top <= y <= self.bottom:
            for _ in range(n): del self.grid[self.bottom]; self.grid.insert(y, [' '] * self.cols)
        elif final == 'M' and self.top <= y <= self.bottom:
            for _ in range(n): del self.grid[y]; self.grid.insert(self.bottom, [' '] * self.cols)
        elif final == 'S': self.scroll(n)
        elif final == 'T': self.scroll(n, up=False)
        elif final == 'r': self.top, self.bottom, self.x, self.y = (nums[0] or 1) - 1 if nums else 0, (nums[1] if len(nums) > 1 and nums[1] else self.rows) - 1, 0, 0
        elif final == 's': self.saved = (x, y)
        elif final == 'u': self.x, self.y = self.saved

    def feed(self, data):
        data, self.rest, i = self.rest + data, '', 0
        while i < len(data):
            c = data[i]
            if c == '\x1b':
                nxt = data[i + 1:i + 2]
                if not nxt: self.rest = data[i:]; break
                if nxt == '[':
                    m = self.CSI.match(data, i)
                    if not m:
                        if len(data) - i < 40: self.rest = data[i:]; break
                        i += 2; continue
                    self.csi(*m.groups()); i = m.end(); continue
                if nxt in ']PX^_':  # a string: OSC, DCS and the like, up to BEL or ESC \
                    m = re.compile(r'[\x07]|\x1b\\').search(data, i + 2)
                    if not m: self.rest = data[i:]; break
                    i = m.end(); continue
                if nxt in '()*+': i += 3; continue
                if nxt == '7': self.saved = (self.x, self.y)
                elif nxt == '8': self.x, self.y = self.saved
                elif nxt == 'M':
                    if self.y == self.top: self.scroll(up=False)
                    else: self.y = max(0, self.y - 1)
                elif nxt == 'D': self.lf()
                elif nxt == 'E': self.x = 0; self.lf()
                i += 2; continue
            if c == '\r': self.x = 0
            elif c == '\n': self.lf()
            elif c == '\b': self.x = max(0, min(self.x, self.cols - 1) - 1)
            elif c == '\t': self.x = min(self.cols - 1, (self.x // 8 + 1) * 8)
            elif c >= ' ' and c != '\x7f': self.put(c)
            i += 1
        self.seen.update(self.row(y) for y in range(self.rows))


def check(name, ok, detail=''):
    RESULTS.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f'\n      {detail}' if detail and not ok else ''))


class Session:
    def __init__(self, name, script, args=(), ledger=None, env_extra=None):
        self.dir = os.path.join(TMP, name); os.makedirs(self.dir)
        self.log_path = os.path.join(self.dir, 'onbudget.jsonl'); self.mock_path = os.path.join(self.dir, 'mock.json')
        script_path = os.path.join(self.dir, 'script.json'); json.dump(script, open(script_path, 'w'))
        extra = dict(env_extra or {})
        if ledger is not None:  # the ledger and usage windows the session starts with
            extra['MOCK_LEDGER'] = os.path.join(self.dir, 'ledger.json'); json.dump(ledger, open(extra['MOCK_LEDGER'], 'w'))
        env = {k: v for k, v in os.environ.items() if not (k.startswith('CLAUDE') or k.startswith('ANTHROPIC_'))}
        env.update(ANTHROPIC_BASE_URL='http://127.0.0.1:9', CLAUDE_CODE_MAX_RETRIES='0', DISABLE_TELEMETRY='1',
                   DISABLE_AUTOUPDATER='1', TERM='xterm-256color', COLUMNS=str(COLS), LINES=str(ROWS),
                   MOCK_SCRIPT=script_path, MOCK_LOG=self.mock_path, ONBUDGET_LOG=self.log_path, **extra)
        cmd = [CLAUDE, '--plugin-dir', REPO, '--plugin-dir', MOCK, '--permission-mode', 'acceptEdits', '--setting-sources', 'project,local',
               '--strict-mcp-config', '--allowedTools', 'Bash(echo:*)', '--model', 'sonnet', '--effort', 'high', *args]
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(REPO); os.execvpe(CLAUDE, cmd, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
        self.vt, self.utf8 = Screen(COLS, ROWS), codecs.getincrementaldecoder('utf-8')('replace')
        self.buf = b''
        self.wait(lambda: self.rows('session.start'), 30)
        self.pump(2)
        for s in self.rows('session.start'): SESSIONS.append(s.get('sid'))

    def pump(self, secs):
        end = time.time() + secs
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.2)
            if r:
                try: data = os.read(self.fd, 65536)
                except OSError: return
                self.buf += data; self.vt.feed(self.utf8.decode(data))

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

    def rendered(self, text):
        """Whether the text has been drawn, as the terminal shows it: in a row as it stood at some moment (a status line,
        which changes), or in the transcript and screen now (a line that wraps). Spacing is ignored."""
        want = re.sub(r'\s+', '', text)
        return want in re.sub(r'\s+', '', self.vt.text()) or any(want in re.sub(r'\s+', '', l) for l in self.vt.seen)

    def found(self, pattern):
        """Every distinct text the terminal has shown that matches a regular expression written without spaces."""
        texts = [re.sub(r'\s+', '', self.vt.text())] + [re.sub(r'\s+', '', l) for l in self.vt.seen]
        return sorted({m for t in texts for m in re.findall(pattern, t)})

    def mark(self):
        self.buf = b''

    def clear_input(self):
        """Claude Code 2.1.299 puts a prompt that a hook turned away back into the input box: clear it (Ctrl-U) before typing on."""
        os.write(self.fd, b'\x15'); self.pump(0.5)

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
        dict(bash='echo one', cost=0.30, sleep_ms=1500), dict(bash='echo two', cost=0.30, sleep_ms=1500),          # budget 1: each status line stays
        dict(bash='echo three', cost=0.30, sleep_ms=1500),                                                        # on screen; the 4th request is refused
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
    check('interactive: the fourth request is refused and the notice is on screen', ok and len(s.mock('step')) == 3 and s.wait(lambda: s.shows('[onbudget] Stopped: $0.90 of $1.00 is used'), 10), s.screen()[-600:])
    # Claude Code cuts a status line after 63 characters: the whole line must be drawn, its tier and amount left first.
    # $0.30 a request: $0.40 left after the first is within two requests' worth, so CRITICAL already.
    lines = ['tier HIGH · $0.95 left · budget $1.00', 'tier CRITICAL · $0.40 left · budget $1.00', 'tier CRITICAL · $0.10 left · budget $1.00']
    check('interactive (4.2): the status line shows the tier and what is left, whole, as the budget runs down to CRITICAL',
          all(s.rendered(f'onbudget: {l}') for l in lines), f"seen: {s.found(r'onbudget:tier[^·]*·[^·]*·budget[$0-9.]*')} wanted: {lines}")
    check('interactive (4.2): when the budget stops, the status line says so, with the spend and how to go on',
          s.wait(lambda: s.rendered('onbudget: STOPPED · $0.90 of $1.00 · /onbudget off'), 10) and not s.rendered('onbudget: onbudget:'), s.vt.text()[-600:])

    s.mark(); s.type('continue please')
    check('interactive: a follow-up prompt on a stopped budget is turned away with the reason, and no request is made',
          s.wait(lambda: s.shows('the budget has stopped this session'), 20) and len(s.rows('stop')) == 1 and len(s.mock('step')) == 3 and len(s.mock('request')) == 3, s.screen()[-500:])
    s.clear_input()

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


def limit_session():
    """A dollar budget larger than the 5-hour window has left (6.4), and the line under Claude's STATUS line (2.7)."""
    s = Session('limit', [dict(bash='echo limit', cost=0.02, sleep_ms=1500), dict(text='Checked.\nSTATUS: COMPLETE', cost=0.02, sleep_ms=1500)],
                ledger=dict(cost=0, five_hour=95, seven_day=18))
    s.mark(); s.type('/onbudget $500 Check the limit.')
    s.wait(lambda: len(s.mock('step')) >= 2 and s.rows('step')[1:], 40); s.pump(2)
    check('interactive: the answer says the 5-hour window leaves less than the budget', s.rendered("The account's 5-hour window is at 95%, so less is left in it than the budget"), s.vt.text()[-500:])
    bound = s.found(r'onbudget:tier(?:HIGH|MEDIUM|LOW|CRITICAL)·(?:\$[0-9.]+|[0-9.]+pts?)left\(5hlimit\)·budget\$500\.00')
    check(f'interactive (6.4): the status line names the 5-hour limit that binds, with the tier and what is left before it: {bound}', bound, s.vt.text()[-600:])
    ended = s.wait(lambda: s.rendered('onbudget: Claude ended the task with STATUS: COMPLETE, at $0.04 of $500.00; the 5-hour window moved 0 points'), 15)
    check('interactive (2.7): the line under Claude\'s STATUS line has the plugin\'s name once', ended and not s.rendered('onbudget: onbudget:'), s.vt.text()[-600:])
    s.mark(); s.type('/onbudget off'); s.wait(lambda: s.shows('budget removed'), 10)
    check('interactive: no hook failed in the limit session', not s.rows('hookfail') and not s.rows('stopfail'), f"{s.rows('hookfail')} {s.rows('stopfail')}")
    s.close()


def week_session():
    """A week budget counted in the weekly window's points: the status line and the end-of-task line in points."""
    s = Session('week', [dict(bash='echo week', cost=0.10, seven_day=19, sleep_ms=1500), dict(text='Written.\nSTATUS: COMPLETE', cost=0.06, sleep_ms=1500)],
                ledger=dict(cost=0, five_hour=40, seven_day=18))
    s.mark(); s.type('/onbudget week Write the file.')
    s.wait(lambda: len(s.mock('step')) >= 2 and s.rows('step')[1:], 40); s.pump(2)
    check('interactive: /onbudget week is sized from the reading, in points', s.rendered('budget 81 points of the weekly usage window (what it had left) set'), s.vt.text()[-500:])
    inpts = s.found(r'onbudget:tierHIGH·[0-9]+ptsleft·budget81pts\(week\)')
    check('interactive: under a week budget the status line is in points', inpts and not s.found(r'onbudget:tier\w+·\$'), f"{s.found(r'onbudget:tier[^·]*·[^·]*·budget[^·]{0,20}')}")
    end = 'onbudget: Claude ended the task with STATUS: COMPLETE: the weekly window moved 1 of the 81 points budgeted, the 5-hour window moved 0 points (whole points, whole account); the task\'s own spend was $0.16.'
    check('interactive: the end-of-task line under a week budget gives points moved against points budgeted, and the spend apart, with one prefix',
          s.wait(lambda: s.rendered(end), 15) and not s.rendered('onbudget: onbudget:'), s.vt.text()[-700:])
    s.mark(); s.type('/onbudget off'); s.wait(lambda: s.shows('budget removed'), 10)
    check('interactive: no hook failed in the week session', not s.rows('hookfail') and not s.rows('stopfail'), f"{s.rows('hookfail')} {s.rows('stopfail')}")
    s.close()


def cut_session():
    """How much of a status line this build of Claude Code shows: onbudget's lines are built to fit in 60 characters."""
    probe = 'P' + ''.join(str(i % 10) for i in range(1, 100))
    s = Session('cut', [], env_extra=dict(MOCK_STATUS=probe))
    s.wait(lambda: s.found(r'mock:P[0-9]+'), 15); s.pump(1)
    rows = [l for l in s.vt.seen if 'mock: P' in l]
    shown = max((len(re.match(r'P[0-9]*', l.split('mock: ', 1)[1]).group(0)) for l in rows), default=0)
    room = shown + len('mock: ') - len('onbudget: ')  # the cut counts the mod's name: what is left after onbudget's
    CUT.append(room)
    check(f'interactive: at {COLS} columns this build shows {room} characters of a status line after "onbudget: " (onbudget needs 60)', 60 <= room, f'{rows[:2]}')
    s.close()


def cleanup():
    """Delete the test sessions' transcripts and any budget they left in the plugin's store."""
    slug = re.sub(r'[^A-Za-z0-9]', '-', REPO)
    removed = 0
    for sid in {x for x in SESSIONS if x}:
        for path in glob.glob(os.path.join(CONFIG, 'projects', slug, f'{sid}*')):
            (shutil.rmtree if os.path.isdir(path) else os.remove)(path); removed += 1
    keys = 0
    for path in glob.glob(os.path.join(CONFIG, 'plugins', 'store', 'onbudget*.json')):
        try:
            d = json.load(open(path)); before = SEEN.get(path, {})
            gone = [k for k in d if any(k.endswith(f':{sid}') or f':{sid}:' in k for sid in SESSIONS if sid)]
            for k in gone: del d[k]
            for k in [k for k in d if k.startswith('seen:')]:  # the scripted readings replaced the real ones
                if k in before: d[k] = before[k]
                else: del d[k]
            for k, v in before.items(): d[k] = v
            json.dump(d, open(path, 'w'), indent=2); keys += len(gone)
        except Exception: pass
    print(f'cleaned up {removed} test transcript file(s) and {keys} store key(s) for {len(set(SESSIONS))} session(s); window readings in the store put back')


if __name__ == '__main__':
    for plugin in (REPO, MOCK):
        if subprocess.run([CLAUDE, 'plugin', 'validate', plugin], capture_output=True).returncode != 0: sys.exit(f'plugin does not validate: {plugin}')
    print('claude:', subprocess.run([CLAUDE, '--version'], capture_output=True, text=True).stdout.strip(), '  scratch:', TMP)
    try:
        for part in (cut_session, main_session, limit_session, week_session, resume_session):
            try: part()
            except Exception as ex: check(f'{part.__name__}: ran to completion', False, repr(ex))
    finally:
        cleanup()
    print(f'\n{sum(RESULTS)} passed, {len(RESULTS) - sum(RESULTS)} failed')
    if all(RESULTS) and not os.environ.get('ONBUDGET_E2E_KEEP'): shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(0 if all(RESULTS) else 1)
