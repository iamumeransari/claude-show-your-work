#!/usr/bin/env python3
"""Runs Claude Code with this plugin in a hidden terminal that answers like
Ghostty, plays a scenario (show a picture or video, click, drag the window
edge, scroll) and reports what happened, with no window on screen.

It records every picture placement Claude Code sends (columns x rows) next to
each resize, then reads the plugin's diagnostics log (debug.log, see
hooks/diagnostics.ts) and fails if the plugin noticed any problem.

    python3 tools/pty-harness.py image  [file]   show a picture, drag the window narrow and back
    python3 tools/pty-harness.py video  [file]   play a video while dragging the window edge
    python3 tools/pty-harness.py tour            the tour's first video, half width to full and back
    python3 tools/pty-harness.py scroll          five pictures and a playing video, then scroll up

Clicking and scrolling read the screen, which needs pyte:
    python3 -m venv /tmp/syw-venv && /tmp/syw-venv/bin/pip install pyte
    /tmp/syw-venv/bin/python tools/pty-harness.py video

What it can't show: how Ghostty paints those placements. Check that on screen.
The session shares this machine's saved plugin settings (Picture size and
the rest); the harness doesn't change them.
"""
import fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, tempfile, termios, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.path.join(os.environ.get('TMPDIR', '/tmp').rstrip('/'), f'claude-show-your-work-{os.getuid()}')
LOG = os.path.join(TMP, 'debug.log')
# A Retina-like window: 157 columns of 16 px, 37 rows of 34.6 px (screen pixels).
FULL = (157, 37)
CELL = (16.05, 34.6)

try:
    import pyte
except ImportError:
    pyte = None


class Terminal:
    def __init__(self, columns, rows):
        self.start = time.time()
        self.notes = []
        self.carry = b''
        self.screen = pyte.Screen(columns, rows) if pyte else None
        self.stream = pyte.ByteStream(self.screen) if pyte else None
        env = dict(os.environ, TERM_PROGRAM='ghostty', TERM='xterm-ghostty', COLORTERM='truecolor', SHOW_YOUR_WORK_DEBUG='1')
        args = ['claude', '--plugin-dir', ROOT, '--settings', '{"enabledPlugins":{"show-your-work@iamumeransari":false}}']
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(ROOT)
            os.execvpe('claude', args, env)
        self.size(columns, rows)

    def note(self, text):
        self.notes.append((round(time.time() - self.start, 3), text))

    # Claude Code asks the terminal what it can do. Each kitty graphics query
    # is answered before the device-attributes query that follows it, or the
    # probe counts as unanswered and no picture is ever sent.
    def answer(self, data):
        for query in re.findall(rb'\x1b_G([^;\x1b]*)', data):
            fields = dict(p.split(b'=', 1) for p in query.split(b',') if b'=' in p)
            if fields.get(b'a') == b'q' and b'i' in fields:
                os.write(self.fd, b'\x1b_Gi=' + fields[b'i'] + b';OK\x1b\\')
            elif b'c' in fields and b'r' in fields:
                self.note(f"place {fields[b'c'].decode()}x{fields[b'r'].decode()}")
        if b'\x1b[>0q' in data:
            os.write(self.fd, b'\x1bP>|ghostty 1.2.3\x1b\\')
        if b'\x1b[?u' in data:
            os.write(self.fd, b'\x1b[?0u')
        if b'\x1b[c' in data:
            os.write(self.fd, b'\x1b[?62;22;52c')

    # The screen, without the picture commands pyte doesn't understand.
    def feed(self, data):
        if not self.stream:
            return
        data, text = self.carry + data, b''
        while True:
            at = data.find(b'\x1b_')
            if at < 0:
                text, data = text + data, b''
                break
            end = data.find(b'\x1b\\', at + 2)
            if end < 0:
                text, data = text + data[:at], data[at:]
                break
            text, data = text + data[:at], data[end + 2:]
        self.carry = data
        try:
            self.stream.feed(text)
        except Exception:
            pass

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([self.fd], [], [], 0.05)
            if ready:
                try:
                    data = os.read(self.fd, 1 << 20)
                except OSError:
                    return
                self.answer(data)
                self.feed(data)

    def size(self, columns, rows):
        if self.screen:
            self.screen.resize(rows, columns)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, int(columns * CELL[0]), int(rows * CELL[1])))
        os.kill(self.pid, signal.SIGWINCH)
        self.note(f'resize {columns}x{rows}')

    def drag(self, start, end, rows=FULL[1], step=3, pause=0.04):
        sign = 1 if end > start else -1
        for columns in list(range(start, end, sign * step)) + [end]:
            self.size(columns, rows)
            self.pump(pause)

    def type(self, text):
        os.write(self.fd, text.encode())
        self.pump(0.8)
        os.write(self.fd, b'\r')

    def click(self, word):
        if not self.screen:
            return self.note(f'skipped click on {word}: install pyte')
        # From the bottom: pyte can't lay out placeholder cells, so a stale copy
        # of a button row can linger higher up, and clicking it does nothing.
        for y, line in reversed(list(enumerate(self.screen.display))):
            x = line.find(word)
            if x >= 0:
                for kind in (b'M', b'm'):
                    os.write(self.fd, b'\x1b[<0;%d;%d' % (x + 2, y + 1) + kind)
                return self.note(f'click {word}')
        self.note(f'no {word} on screen')

    def wheel(self, up, times):
        for _ in range(times):
            os.write(self.fd, b'\x1b[<%d;60;15M' % (64 if up else 65))
            self.pump(0.05)

    def close(self):
        os.kill(self.pid, signal.SIGTERM)


def sample_video():
    path = os.path.join(tempfile.gettempdir(), 'syw-harness-clip.mp4')
    if not os.path.exists(path):
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x800:rate=24:duration=60', '-pix_fmt', 'yuv420p', path], check=True)
    return path


def run(scenario, file):
    os.makedirs(TMP, exist_ok=True)
    if os.path.exists(LOG):
        os.remove(LOG)
    term = Terminal(*FULL)
    term.pump(14)
    if scenario == 'image':
        term.type(f'/img {file or os.path.join(ROOT, "assets/tour/hero.jpg")}')
        term.pump(6)
        term.drag(157, 70)
        term.pump(2)
        term.drag(70, 157)
        term.pump(4)
    elif scenario == 'video':
        term.type(f'/img {file or sample_video()}')
        term.pump(6)
        term.click('Play')
        term.pump(2)
        for _ in range(3):
            term.drag(157, 70)
            term.pump(0.3)
            term.drag(70, 157)
            term.pump(0.3)
        term.pump(4)
    elif scenario == 'tour':
        term.size(78, FULL[1])
        term.pump(2)
        term.type('/show-your-work tour')
        term.pump(8)
        term.click('Play')
        term.pump(2)
        for columns, wait in [(157, 8), (78, 6), (157, 6), (78, 6)]:
            term.size(columns, FULL[1])
            term.pump(wait)
    elif scenario == 'scroll':
        for name in ['tour/hero.jpg', 'tour/concepts.jpg', 'tour/breakpoints.jpg', 'tour/direction-b.jpg']:
            term.type(f'/img {os.path.join(ROOT, "assets", name)}')
            term.pump(5)
        term.type(f'/img {sample_video()}')
        term.pump(6)
        term.click('Play')
        term.pump(2)
        before = term.screen and '\n'.join(term.screen.display)
        term.wheel(True, 25)
        term.pump(0.5)
        scrolled = term.screen and '\n'.join(term.screen.display)
        term.pump(6)
        later = term.screen and '\n'.join(term.screen.display)
        if term.screen:
            term.note(f'scrolled: {scrolled != before}; jumped back by itself: {later == before}')
    else:
        sys.exit(__doc__)
    term.pump(2)
    term.close()
    return term


def report(term):
    print('What Claude Code placed, by resize:')
    last = None
    for at, text in term.notes:
        if text.startswith('place'):
            if text != last:
                print(f'  {at:7.2f}s  {text}')
            last = text
        else:
            print(f'  {at:7.2f}s  {text}')
    events = []
    if os.path.exists(LOG):
        for line in open(LOG):
            try:
                events.append(json.loads(line))
            except ValueError:
                pass
    kinds = {}
    for e in events:
        kinds[e.get('e')] = kinds.get(e.get('e'), 0) + 1
    print('Plugin events:', ', '.join(f'{k} {n}' for k, n in sorted(kinds.items())) or 'none (is SHOW_YOUR_WORK_DEBUG honoured?)')
    found = [e for e in events if e.get('e') == 'problem']
    for e in found:
        print('  problem:', json.dumps({k: v for k, v in e.items() if k not in ('t', 'e')}))
    print(f'{len(found)} problem(s).')
    return 1 if found else 0


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    sys.exit(report(run(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)))
