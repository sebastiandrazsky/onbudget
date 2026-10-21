"""A small terminal emulator for the pseudo-terminal suites: enough of what Claude Code's renderer sends to know what is on
screen. Used by tests/e2e/interactive.py and eval/interactive_smoke.py. Standard library only."""
import re, unicodedata


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
