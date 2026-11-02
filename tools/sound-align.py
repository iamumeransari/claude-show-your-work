#!/usr/bin/env python3
"""Checks that a video's frames and its sound file line up, with no Claude
Code involved: it makes clips that flash white and beep at the same moments
(a picture or sound stream starting late, 25 and 29.97 fps, a blank opening,
two minutes long), runs them through the same ffmpeg commands the plugin uses
(media.ts: the first chunk and later chunks; sound.ts: the sound file), and reports how far each flash's frame is from its beep, in ms.

    python3 tools/sound-align.py            every case
    python3 tools/sound-align.py 29.97fps   one case

Frame k is the source frame nearest k/fps, so up to half a frame early or one
late (plus half a source frame) is the frame rate, not drift. Mirror any change
to those commands here. Needs ffmpeg and ffprobe on PATH.
"""
import json, math, os, re, struct, subprocess, sys, tempfile, wave
D = os.path.join(tempfile.gettempdir(), 'syw-sound-align')
FF, FP = 'ffmpeg', 'ffprobe'
MAX_STREAMED, MAX_FPS, CHUNK, RATE = 3600, 12, 24, 22050
run = lambda a: subprocess.run(a, capture_output=True, text=True)

def make(name, dur, events, vfps=30, ar=48000, aoff=0.0, voff=0.0, white_head=0.0):
    """Pattern video, white for 0.2 s at each event; a 1 kHz beep at each event.
    aoff/voff: that stream starts late in the file (its pts begin there); the
    events stay at the same absolute file times."""
    out = f'{D}/{name}.mp4'
    vf = ','.join([f"drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,{e:.3f},{e+0.2:.3f})'" for e in events])
    if white_head: vf += f",drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(t,{white_head:.3f})'"
    expr = '+'.join([f'between(t,{e-aoff:.4f},{e-aoff+0.05:.4f})' for e in events])
    a = ['-f', 'lavfi', '-i', f"sine=f=1000:r={ar}:d={dur-aoff},volume='{expr}':eval=frame"]
    v = ['-f', 'lavfi', '-i', f'testsrc2=s=320x180:r={vfps}:d={dur-voff},eq=brightness=-0.3']
    args = [FF, '-v', 'error', '-y']
    args += (['-itsoffset', str(voff)] if voff else []) + v
    args += (['-itsoffset', str(aoff)] if aoff else []) + a
    args += ['-map', '0:v', '-map', '1:a', '-vf', vf, '-c:v', 'libx264', '-g', str(vfps * 2), '-pix_fmt', 'yuv420p', '-c:a', 'aac', out]
    r = run(args); assert r.returncode == 0, r.stderr
    return out

def lead_from(log, duration):
    t, low = 0, -1
    for line in log.split('\n'):
        m = re.search(r'pts_time:([\d.]+)', line)
        if m: t = float(m.group(1)); low = -1; continue
        m = re.search(r'YLOW=([\d.]+)', line)
        if m: low = float(m.group(1)); continue
        m = re.search(r'YHIGH=([\d.]+)', line)
        if m and low >= 0:
            if float(m.group(1)) - low > 24:
                lead = round(t * 100) / 100
                return lead if lead > 0 and (not duration > 0 or lead < duration - 0.5) else 0
            low = -1
    return 0

def chunk_seconds(n, fps): return str(round((n + 1) / fps, 3))
def num(x): return str(x) if x != int(x) else str(int(x))

# As media.ts: H.264 and HEVC decode on the media engine on macOS.
HW = ['-hwaccel', 'videotoolbox'] if sys.platform == 'darwin' else []

def frames_of(src, fps, lead, total):
    """Brightness of every frame, cut chunk by chunk exactly like the plugin."""
    out = []
    for c in range(math.ceil(total / CHUNK)):
        first = c * CHUNK; n = min(CHUNK, total - first)
        ss = (['-ss', num(lead)] if lead else []) if c == 0 else ['-ss', num(round(lead + first / fps, 3))]
        r = subprocess.run([FF, '-v', 'error', *HW, *ss, '-t', chunk_seconds(n, fps), '-i', src,
                            '-vf', f'fps={fps},scale=160:-2,scale=32:18,format=gray', '-frames:v', str(n), '-f', 'rawvideo', '-'], capture_output=True)
        b = r.stdout
        got = [sum(b[i*576:(i+1)*576]) / 576 for i in range(len(b) // 576)]
        assert len(got) == n, (c, len(got), n)
        out += got
    return out

def beeps_of(src, lead, duration):
    wav = f'{D}/s.wav'
    a = [FF, '-v', 'error', '-y', *(['-ss', num(lead)] if lead else []), '-t', str(duration), '-i', src,
         '-vn', '-sn', '-dn', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', str(RATE), '-c:a', 'pcm_s16le', '-f', 'wav', wav]
    r = run(a); assert r.returncode == 0, r.stderr
    w = wave.open(wav); n = w.getnframes(); s = struct.unpack(f'<{n}h', w.readframes(n))
    onsets, quiet = [], True
    for i, x in enumerate(s):
        if abs(x) > 3000 and quiet: onsets.append(i / RATE); quiet = False
        elif abs(x) < 50 and not quiet:
            # quiet for 20 ms ends a beep
            if all(abs(y) < 300 for y in s[i:i + 441]): quiet = True
    return onsets, n / RATE

def check(name, src, events):
    p = json.loads(run([FP, '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', src]).stdout)
    probed = float(p['format']['duration'])
    fps = max(1, min(MAX_FPS, math.floor(MAX_STREAMED / max(probed, 0.1))))
    log = run([FF, '-v', 'info', '-t', '8', '-i', src, '-vf', 'fps=10,scale=160:-2,signalstats,metadata=print', '-an', '-f', 'null', '-']).stderr
    lead = lead_from(log, probed) if os.environ.get('LEAD') else 0
    total = min(MAX_STREAMED, math.floor((probed - lead) * fps))
    br = frames_of(src, fps, lead, total)
    flashes = [k for k in range(len(br)) if br[k] > 200 and (k == 0 or br[k-1] <= 200)]
    beeps, wav_s = beeps_of(src, lead, total / fps)
    rows = []
    for e in events:
        if e < lead: continue
        k = next((k for k in flashes if abs(k / fps - (e - lead)) < 0.5), None)
        b = next((b for b in beeps if abs(b - (e - lead)) < 0.3), None)
        # The player shows frame floor(t*fps) at sound time t: the flash is seen
        # from k/fps. Quantisation alone puts that 0..1 frame after the beep.
        rows.append((e, k, None if b is None else round(b, 3), None if (k is None or b is None) else round((k / fps - b) * 1000)))
    errs = [r[3] for r in rows if r[3] is not None]
    # frame k is the source frame nearest k/fps: up to half a frame early, one late,
    # plus half a source frame (30 fps: 17 ms) either way.
    ok = len(errs) == len([e for e in events if e >= lead]) and all(-1000/fps/2 - 20 <= x <= 1000/fps + 20 for x in errs)
    print(f'{"OK  " if ok else "FAIL"} {name}: fps={fps} lead={lead} frames={total} sound={wav_s:.2f}s  picture-minus-sound ms: {errs}' + ('' if ok else f'  rows={rows}'))
    return ok

os.makedirs(D, exist_ok=True)
EV = [1.0, 2.5, 4.25, 7.05, 9.5, 13.33]
cases = [
    ('base-30fps-48k', dict(dur=15, events=EV)),
    ('sound-starts-0.3s-late', dict(dur=15, events=EV, aoff=0.3)),
    ('picture-starts-0.3s-late', dict(dur=15, events=EV, voff=0.3)),
    ('25fps-44k', dict(dur=15, events=EV, vfps=25, ar=44100)),
    ('29.97fps', dict(dur=15, events=EV, vfps=30000/1001)),
    ('blank-opening-1.2s', dict(dur=15, events=[2.0, 4.6, 9.1, 12.4], white_head=1.2)),
    ('picture-0.3s-late-blank-opening', dict(dur=15, events=[2.0, 4.6, 9.1, 12.4], voff=0.3, white_head=1.2)),
    ('both-late-sound-0.5-picture-0.2', dict(dur=15, events=EV, aoff=0.5, voff=0.2)),
    ('picture-0.5s-late-2-minutes', dict(dur=120, events=[5.0, 47.3, 88.8, 116.2], voff=0.5)),
    ('both-late-blank-opening', dict(dur=15, events=[2.0, 4.6, 9.1, 12.4], aoff=0.5, voff=0.2, white_head=1.2)),
    ('2-minutes', dict(dur=120, events=[5.0, 47.3, 88.8, 116.2])),
    ('29.97fps-2-minutes', dict(dur=120, events=[5.0, 47.3, 88.8, 116.2], vfps=30000/1001)),
]
# The plugin's blank-opening skip is off (lead 0). LEAD=1 finds and skips a
# blank opening anyway, to check the -ss path still lines up.
only = sys.argv[1:]
results = []
for name, kw in cases:
    if only and name not in only: continue
    results.append(check(name, make(name, **kw), kw['events']))
print(f'{sum(results)}/{len(results)} aligned')
sys.exit(0 if all(results) else 1)
