import { state } from './state';
import { frameWidth, SIDEBAR } from './layout';
import { debug } from './telemetry';
// Deletes the oldest frame folders until the cache is under $1 KB, keeping the
// newest two and the ones named in $2; only inside a folder this user owns.
export const TRIM_SH = [
    '[ -d "$0" ] && [ ! -L "$0" ] && [ -O "$0" ] && cd -P "$0" 2>/dev/null || exit 0',
    // Only the folders the plugin names (v-<key>, v<n>-<time>, p-<key>,
    // p2-<key>), one per line: a picture named by the user never matches.
    'all=$(ls -dtr -- v* p* 2>/dev/null | grep -E "^(v-[0-9a-f]+|v[0-9]+-[0-9]+|p2?-[0-9a-f]+)$"); n=$(printf "%s\\n" "$all" | grep -c .)',
    'printf "%s\\n" "$all" | head -n $((n > 2 ? n - 2 : 0)) | while IFS= read -r d; do',
    '  [ -n "$d" ] && [ -d "$d" ] || continue',
    '  [ "$(du -sk . | cut -f1)" -le "$1" ] && break',
    '  case " $2 " in *" $d "*) continue ;; esac',
    '  [ -L "$d" ] || rm -rf "./$d"',
    'done; true',
].join('\n');
// Deletes anything in the cache older than a week, without following links.
export const CLEAN_SH = [
    '[ -d "$0" ] && [ ! -L "$0" ] && [ -O "$0" ] || exit 0',
    'find -P "$0" -mindepth 1 -maxdepth 1 -mtime +7 -exec rm -rf {} + 2>/dev/null; true',
].join('\n');
export const VIDEO = /\.(mp4|mov|m4v|webm|mkv|avi|gif)$/i;
// Frames a clip is cut into at most, and the rate it plays at below that.
// A clip cut whole (no known length) keeps every frame on disk at once, so it
// stays at MAX_FRAMES. One of known length is cut as it plays and only a few
// chunks are ever on disk, so it can run to MAX_STREAMED at the full rate.
const MAX_FRAMES = 900;
const MAX_STREAMED = 3600;
const MAX_FPS = 12;
// A typed or dragged-in path: quotes, backslash-escaped spaces and ~ allowed.
export function expand(path, base, homeDir) {
    let p = path.trim().replace(/^(['"])(.*)\1$/, '$2').replace(/\\(.)/g, '$1');
    if (p === '~' || p.startsWith('~/'))
        p = homeDir + p.slice(1);
    if (p.startsWith('/'))
        return p;
    return `${base.replace(/\/$/, '')}/${p}`;
}
// A name with its look-alike spaces made plain: macOS writes a narrow
// no-break space before AM/PM in screenshot names, which a typed path lacks.
export const looseName = (name) => name.normalize('NFC').replace(/[  -   　]/g, ' ');
// The file a path means: as given when it exists, else the one entry in its
// folder whose name matches once spaces are made plain.
export async function locate($, raw) {
    const path = expand(raw, state.cwd, state.home);
    if (await $.fs.stat(path).then(() => true, () => false))
        return path;
    const cut = path.lastIndexOf('/');
    const dir = path.slice(0, cut) || '/';
    const want = looseName(path.slice(cut + 1));
    const hit = (await $.fs.list(dir).catch(() => [])).find(f => looseName(f.name) === want);
    return hit ? `${dir.replace(/\/$/, '')}/${hit.name}` : path;
}
export const frameFile = (frames, i) => `${frames.dir}/f${String(i + 1).padStart(5, '0')}.png`;
// How fast to sample a clip of known length so it stays under MAX_STREAMED.
export const sampleRate = (duration) => Math.max(1, Math.min(MAX_FPS, Math.floor(MAX_STREAMED / Math.max(duration, 0.1))));
// A PNG's size from its header (bytes 16 to 24), without any tool.
export function pngDims(base64) {
    const b = Uint8Array.from(atob(base64.slice(0, 44)), c => c.charCodeAt(0));
    if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47)
        return null;
    const at = (i) => (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0;
    return { width: at(16), height: at(20) };
}
// Finds a pasted image's original file by name with Spotlight (macOS).
export async function findPasted($, name) {
    if (name.startsWith('/'))
        return name;
    if (!state.isMac)
        return null;
    const found = await $.process.run(['mdfind', '-name', name]);
    return found.stdout.split('\n').find(line => line.endsWith(`/${name}`)) ?? null;
}
export async function pngSize($, png) {
    if (!state.isMac) {
        const d = pngDims(String((await $.fs.read(png, { as: 'bytes' })).base64 ?? ''));
        if (!d || !d.width || !d.height)
            throw new Error(`not an image: ${png}`);
        return d;
    }
    const dims = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', png]);
    const width = Number(/pixelWidth:\s*(\d+)/.exec(dims.stdout)?.[1] ?? 0);
    const height = Number(/pixelHeight:\s*(\d+)/.exec(dims.stdout)?.[1] ?? 0);
    if (!width || !height)
        throw new Error(`not an image: ${png}`);
    return { width, height };
}
// Frames on disk are a cache: past 500 MB the oldest folders go, and a window
// that plays one again decodes it again (ensureChunk). The newest two stay.
const FRAMES_CAP_KB = 500000;
// Folders this session is playing are never trimmed.
export function trimFrames($) {
    const inUse = [...watching.keys()].map(d => d.split('/').pop()).join(' ');
    return $.process.run(['sh', '-c', TRIM_SH, state.TMP, String(FRAMES_CAP_KB), inUse]).catch(() => undefined);
}
// A recording often opens on a blank page while the browser loads: white,
// off-white, grey or dark, maybe with a small spinner or logo. Any frame that
// is nearly one flat tone counts as blank; the clip starts at the first real one.
async function whiteLead($, real, duration) {
    const r = await $.process.run([state.ffmpeg, '-v', 'info', '-t', '8', '-i', real,
        '-vf', 'fps=10,scale=160:-2,signalstats,metadata=print:key=lavfi.signalstats.YLOW:key=lavfi.signalstats.YHIGH',
        '-an', '-f', 'null', '-']).catch(() => null);
    return r ? leadFrom(r.stderr, duration) : 0;
}
// The blank opening in that log: the time of the first frame whose 10th to
// 90th percentile brightness spreads wider than a flat page does, if that
// leaves something after it.
export function leadFrom(log, duration) {
    let t = 0, low = -1;
    for (const line of log.split('\n')) {
        const pts = line.match(/pts_time:([\d.]+)/);
        if (pts) {
            t = Number(pts[1]);
            low = -1;
            continue;
        }
        const lo = line.match(/YLOW=([\d.]+)/);
        if (lo) {
            low = Number(lo[1]);
            continue;
        }
        const hi = line.match(/YHIGH=([\d.]+)/);
        if (hi && low >= 0) {
            if (Number(hi[1]) - low > 24) {
                const lead = Math.round(t * 100) / 100;
                return lead > 0 && (!(duration > 0) || lead < duration - 0.5) ? lead : 0;
            }
            low = -1;
        }
    }
    return 0;
}
// Times given on the clip as it was, moved to the frames that start after
// its white opening.
export function shiftTimes(list, lead) {
    if (!list || !lead)
        return list;
    return list.map(c => (c.at === undefined ? c : { ...c, at: Math.max(0, +(c.at - lead).toFixed(2)) }));
}
// What to tell Claude and the person when a video can't be cut into frames.
export const NO_FFMPEG = "videos need ffmpeg, and it isn't installed. Pictures still work. Install it with `brew install ffmpeg` " +
    '(Claude can run that for you), then restart Claude Code. No Homebrew? Install it first from https://brew.sh.';
// On Linux ffmpeg also turns pictures other than PNG into PNG.
export const NO_FFMPEG_LINUX = "videos and pictures other than PNG need ffmpeg, and it isn't installed. Install it with your package manager, " +
    'for example `sudo apt install ffmpeg` or `sudo dnf install ffmpeg` (Claude can run that for you), then restart Claude Code.';
export const noFfmpeg = (mac) => (mac ? NO_FFMPEG : NO_FFMPEG_LINUX);
export const FFMPEG_PROMPT_LINUX = "Install ffmpeg for me with this machine's package manager (for example `sudo apt install ffmpeg`). Then show it again.";
// What the person pastes back so Claude installs ffmpeg and tries again.
export const FFMPEG_PROMPT = 'Install ffmpeg for me with `brew install ffmpeg`. If Homebrew isn\'t installed, tell me how to install it first. Then show the video again.';
// How a failure reads, from whatever the tools said; `path` is the person's own.
export function noticeOf(err, path, homeDir = '') {
    const raw = String(err?.message ?? err);
    const shown = homeDir && path.startsWith(`${homeDir}/`) ? `~${path.slice(homeDir.length)}` : path;
    const name = path.split('/').pop() || path;
    if (raw.includes(NO_FFMPEG_LINUX))
        return {
            kind: 'no_ffmpeg', title: 'This needs ffmpeg', message: NO_FFMPEG_LINUX, prompt: FFMPEG_PROMPT_LINUX,
            text: "ffmpeg isn't installed, so videos and pictures other than PNG can't show here. Copy the prompt and paste it to Claude to install it, or install it yourself, for example `sudo apt install ffmpeg`.",
        };
    if (raw.includes(NO_FFMPEG))
        return {
            kind: 'no_ffmpeg', title: 'Videos need ffmpeg', message: NO_FFMPEG, prompt: FFMPEG_PROMPT,
            text: "ffmpeg isn't installed, so this video can't play here. Pictures still work. Copy the prompt and paste it to Claude to install it, or run `brew install ffmpeg` yourself. No Homebrew? Get it from brew.sh first.",
        };
    if (/does not contain any stream|matches no streams|no frames in|Output file is empty/i.test(raw))
        return {
            kind: 'no_picture', title: 'This video has no picture',
            text: `${name} has sound but no picture, so there's nothing to play.`,
            message: `${shown} has no video track (sound only), so there's nothing to play. Don't retry it; show a file with a picture instead.`,
            prompt: `${shown} has no picture, only sound. Find the right video and show it to me again.`,
        };
    if (/ffmpeg could not read|Invalid data|moov atom|could not find codec|Error opening input/i.test(raw))
        return {
            kind: 'broken_video', title: "This video can't be read",
            text: `${name} couldn't be opened as a video. It may be cut off, still being written, or not really a video.`,
            message: `${shown} couldn't be read as a video: it's damaged, unfinished (still recording or cut off), or not a video. Re-export or re-record it, then show it again.`,
            prompt: `${shown} couldn't be read as a video. Check it, re-export or re-record it if it's broken, then show it to me again.`,
        };
    if (/could not convert|not an image|Cannot extract image|sips/i.test(raw))
        return {
            kind: 'not_image', title: "This isn't a picture",
            text: `${name} isn't a picture, so it can't be shown. Pictures can be PNG, JPEG, WebP, GIF or TIFF.`,
            message: `${shown} isn't a picture (show_image opens PNG, JPEG, WebP, GIF and TIFF). Show an image file, or use show_video for a video.`,
            prompt: `${shown} isn't a picture. Show me the right file instead.`,
        };
    if (/ENOENT|no such file|not found/i.test(raw))
        return {
            kind: 'missing', title: 'File not found',
            text: `There's no file at ${shown}.`,
            message: `There's no file at ${shown}. Check the path (it may have moved or not been saved yet), then show it again.`,
            prompt: `There's no file at ${shown}. Find the right file and show it to me again.`,
        };
    const detail = (raw.split('\n')[0] ?? '').replace(/\/(?:private\/)?tmp\/\S+|\S*\/\.show-your-work\/\S+/g, name).slice(0, 160);
    return {
        kind: 'other', title: "Couldn't show it",
        text: `${name} couldn't be shown: ${detail}`,
        message: `${shown} couldn't be shown: ${detail}`,
        prompt: `${shown} couldn't be shown (${detail}). Look into it and show it to me again.`,
    };
}
// The usage-stats reason for a failure, as a kind.
export const REASONS = {
    missing: 'missing_file', no_ffmpeg: 'video_tools', not_image: 'unreadable', broken_video: 'unreadable', no_picture: 'unreadable', other: 'other',
};
// Cuts a clip into PNG frames the terminal can swap through.
// A file as it is now: its path, size and modified time. The same unchanged
// file shown again maps to the same frames folder and skips the decode; a
// re-rendered one gets a new key and decodes fresh.
export function keyOf(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++)
        h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
    return h.toString(16).padStart(8, '0') + text.length.toString(16);
}
export async function identityOf($, raw) {
    const st = await $.fs.stat(expand(raw, state.cwd, state.home), { resolve: true }).catch(() => null);
    return st ? keyOf(`${st.realPath ?? raw}|${st.size}|${st.mtimeMs}`) : undefined;
}
async function readMeta($, dir) {
    const r = await $.process.run(['cat', `${dir}/meta.json`]).catch(() => null);
    if (!r || r.exitCode !== 0)
        return null;
    try {
        return JSON.parse(r.stdout);
    }
    catch {
        return null;
    }
}
function writeMeta($, dir, meta) {
    return $.process.run(['sh', '-c', 'printf "%s" "$1" > "$0/meta.json"', dir, JSON.stringify(meta)]).catch(() => undefined);
}
export async function prepareVideo($, real, title, key, cutAt) {
    if (!state.hasVideoTools) {
        state.hasVideoTools = (await Promise.all([exists($, state.ffmpeg), exists($, state.ffprobe)])).every(Boolean);
        if (!state.hasVideoTools)
            throw new Error(noFfmpeg(state.isMac));
    }
    const facts = await $.process.run([state.ffprobe, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'default=nw=1', real]);
    const field = (name) => Number(new RegExp(`^${name}=([0-9.]+)`, 'm').exec(facts.stdout)?.[1] ?? Number.NaN);
    const cut = cutAt ?? frameWidth(field('width'), field('height'), state.termSize, state.cell);
    const own = field('width') > 0 && field('height') > 0 ? { sourceWidth: field('width'), sourceHeight: field('height') } : {};
    // A clip is cut once per width: a bigger window cuts it again, bigger.
    const folder = key && `v-${keyOf(`${key}|${cut}${state.sendBytes ? '|bytes' : ''}`)}`;
    // The same file shown before: its folder, frames and size are already there.
    if (folder) {
        const dir = `${state.TMP}/${folder}`;
        const meta = await readMeta($, dir);
        if (meta) {
            const frames = { ...meta.frames, dir };
            await $.process.run(['touch', dir]).catch(() => undefined);
            await ensureChunk($, frames, real, 0);
            await prefill($, frames, real);
            return { kind: 'video', path: frameFile(frames, 0), source: real, width: meta.width, height: meta.height, ...own, title, generation: ++state.generation, frames };
        }
    }
    // Some recordings (MediaRecorder webm) carry no duration: sample those at the
    // top rate. The clip's length is then what the frames cover.
    const probed = field('duration');
    const fps = sampleRate(Number.isFinite(probed) && probed > 0 ? probed : 1);
    state.generation += 1;
    const dir = folder ? `${state.TMP}/${folder}` : `${state.TMP}/v${state.generation}-${Math.floor(await $.clock.now())}`;
    await $.process.run(['mkdir', '-p', dir]);
    const lead = await whiteLead($, real, probed);
    const known = Number.isFinite(probed) && probed > 0;
    // A clip of known length is decoded as it plays, a chunk at a time (see
    // ensureChunk); one without (MediaRecorder webm) is cut whole, as before.
    const total = known ? Math.max(1, Math.min(MAX_STREAMED, Math.floor((probed - lead) * fps))) : 0;
    const made = await $.process.run([
        // The palette waits for the end of its input: only the first chunk is read.
        state.ffmpeg, '-v', 'error', ...(lead ? ['-ss', String(lead)] : []), ...(known ? ['-t', chunkSeconds(Math.min(CHUNK, total), fps)] : []), '-i', real,
        '-vf', `fps=${fps},${scaleFor(cut)}`,
        '-frames:v', String(known ? Math.min(CHUNK, total) : MAX_FRAMES), '-compression_level', '1', `${dir}/f%05d.png`,
    ]);
    if (made.exitCode !== 0)
        throw new Error(`ffmpeg could not read ${real}: ${made.stderr.trim().slice(0, 200)}`);
    const pngs = (await $.fs.list(dir)).filter(f => f.name.endsWith('.png')).length;
    if (!pngs)
        throw new Error(`no frames in ${real}`);
    const count = known ? Math.max(pngs, total) : pngs;
    const frames = { dir, count, fps, duration: count / fps, cut, ...(lead ? { lead } : {}) };
    const poster = frameFile(frames, 0);
    const size = await pngSize($, poster);
    if (folder)
        await writeMeta($, dir, { frames: { count, fps, duration: frames.duration, cut, ...(lead ? { lead } : {}) }, ...size });
    void trimFrames($);
    if (known)
        await prefill($, frames, real);
    return { kind: 'video', path: poster, source: real, ...size, ...own, title, generation: state.generation, frames };
}
// Frames are decoded from the clip as it plays, 24 at a time: the chunk on
// screen and the ones a 5 s skip either way reaches stay on disk, the rest
// go. A frame asked for again further away (a long seek, a window scrolled
// back to) is decoded again. The poster, frame 1, always stays.
const CHUNK = 24;
// Chunks with time to spare (two or more ahead of the playhead) are cut at
// a lower priority. On macOS that's the utility class: measured on an M1, a
// 2 s chunk cut in 1.2 s with the machine free, the same as normal, and in
// 7 s with every core busy, giving way. nice 10 didn't give way at all on
// macOS, and the background class took 4.7 s even on a free machine. Linux
// uses nice, which does give way there. The chunk needed next always runs at
// normal priority, so playback keeps moving however busy the machine is.
const GENTLY = 'if command -v taskpolicy >/dev/null 2>&1; then exec taskpolicy -c utility "$@"; fi; if command -v nice >/dev/null 2>&1; then exec nice -n 10 "$@"; fi; exec "$@"';
const gently = (argv) => ['sh', '-c', GENTLY, 'sh', ...argv];
// And on one thread: ffmpeg's default spreads one cut over several cores and
// buffers for each. Measured on an M1 for 1 s of video at 2400 px: default
// 1.3 s of CPU and 368 MB, one thread 0.85 s and 213 MB, still faster than
// playback. The first chunk, cut before the video shows, keeps the default
// so it appears quickly.
const ONE_THREAD = ['-threads', '1', '-filter_threads', '1'];
const decoding = new Map();
export function exists($, file) {
    return $.fs.stat(file).then(() => true, () => false);
}
// Gone only when the disk says so; no answer at all (no fs here) is not gone.
export function isGone($, file) {
    return $.fs.stat(file).then(() => false, (e) => /ENOENT|not found|no such file/i.test(String(e?.message ?? e)));
}
// Chunks whose frames were cut: playback waits on any other. Only a hint:
// cutting still checks the files, so a chunk the cache cleaner took comes back.
const cutChunks = new Set();
const chunkKey = (f, i) => `${f.dir}#${Math.floor(Math.max(0, Math.min(i, f.count - 1)) / CHUNK)}`;
export const isFrameCut = (media, i) => !media.frames || cutChunks.has(chunkKey(media.frames, i));
// Over ssh every frame crosses as bytes: 256 colours, one palette per chunk,
// no dithering, halve them. Frames on this machine go by path in full colour.
const PALETTE = ',split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=none';
// How much of the clip a chunk reads, a frame's slack included.
export const chunkSeconds = (frames, fps) => String(+((frames + 1) / fps).toFixed(3));
const scaleFor = (cut) => (cut ? `scale=${cut}:-2` : "scale='min(1600,iw)':-2") + (state.sendBytes ? PALETTE : '');
function ensureChunk($, f, source, i, isUrgent = true) {
    const c = Math.floor(Math.max(0, Math.min(i, f.count - 1)) / CHUNK);
    const key = `${f.dir}#${c}`;
    const running = decoding.get(key);
    if (running)
        return running;
    const job = (async () => {
        const first = c * CHUNK;
        // The frame asked for, not the chunk's first: the poster outlives its chunk.
        if (await exists($, frameFile(f, Math.max(0, Math.min(i, f.count - 1)))))
            return;
        if (!source)
            return;
        const cutAt = Date.now();
        await $.process.run(['mkdir', '-p', f.dir]);
        const cutChunk = [
            state.ffmpeg, '-v', 'error', ...ONE_THREAD, '-ss', String(+((f.lead ?? 0) + first / f.fps).toFixed(3)), '-t', chunkSeconds(Math.min(CHUNK, f.count - first), f.fps), '-i', source,
            '-vf', `fps=${f.fps},${scaleFor(f.cut)}`, '-frames:v', String(Math.min(CHUNK, f.count - first)),
            '-threads', '1', '-start_number', String(first + 1), '-compression_level', '1', `${f.dir}/f%05d.png`,
        ];
        await $.process.run(isUrgent ? cutChunk : gently(cutChunk));
        debug(`cut chunk=${c} ms=${Date.now() - cutAt}`);
        await prune($, f.dir, c, f.fps);
    })().then(() => { cutChunks.add(key); }, () => undefined).finally(() => decoding.delete(key));
    decoding.set(key, job);
    return job;
}
// Where each player is in each frames folder, as a chunk number.
const watching = new Map();
function watch(dir, site, i) {
    let at = watching.get(dir);
    if (!at)
        watching.set(dir, (at = new Map()));
    at.set(site, Math.floor(i / CHUNK));
}
// Chunks 5 s behind the playhead stay on disk and 5 s ahead are cut in
// advance, so « 5s and 5s » land on frames that are ready, and playback has
// room to spare when cutting runs slower than the clip.
const BEHIND_SECONDS = 5;
const AHEAD_SECONDS = 5;
const chunksFor = (seconds, fps) => Math.max(1, Math.ceil((seconds * fps) / CHUNK));
export const chunksBehind = (fps) => chunksFor(BEHIND_SECONDS, fps);
export const chunksAhead = (fps) => chunksFor(AHEAD_SECONDS, fps);
// Keeps, in a frames folder, the chunks a skip back or forward reaches around
// the chunk just made and around every player on that folder, and the poster.
async function prune($, dir, c, fps) {
    const keep = [c, ...(watching.get(dir)?.values() ?? [])];
    const behind = chunksBehind(fps);
    const ahead = chunksAhead(fps) + 1;
    const files = await $.fs.list(dir).catch(() => []);
    const gone = files.map(f => f.name).filter(name => {
        const m = /^f(\d+)\.png$/.exec(name);
        if (!m)
            return false;
        const i = Number(m[1]) - 1;
        return i > 0 && !keep.some(k => i >= (k - behind) * CHUNK && i < (k + ahead + 1) * CHUNK);
    });
    if (gone.length) {
        for (const k of [...cutChunks])
            if (k.startsWith(`${dir}#`) && !keep.some(c2 => { const j = Number(k.slice(dir.length + 1)); return j >= c2 - behind && j <= c2 + ahead; }))
                cutChunks.delete(k);
        await $.process.run(['rm', '-f', ...gone.map(n => `${dir}/${n}`)]).catch(() => undefined);
    }
}
// The frame a side shows, decoded if it has to be; then the chunks a 5s »
// reaches are cut ahead, one at a time so a busy machine isn't swamped.
export async function frameReady($, media, i, site) {
    const f = media.frames;
    if (!f)
        return;
    if (site)
        watch(f.dir, site, i);
    await ensureChunk($, f, media.source, i);
    void cutAhead($, f, media.source, i);
}
// Two cuts at once, nearest first: PNG encoding runs one frame at a time
// in each ffmpeg, so a second process gets ~20-25% more done on an M1; a
// third and fourth add little and crowd a busy machine.
const CUT_WORKERS = 2;
const cuttingAhead = new Set();
async function cutAhead($, f, source, i) {
    if (cuttingAhead.has(f.dir))
        return;
    cuttingAhead.add(f.dir);
    try {
        // The chunk after this one is needed within 2 s; the rest have time.
        const todo = [];
        for (let d = 1; d <= chunksAhead(f.fps); d++) {
            const j = i + d * CHUNK;
            if (j >= f.count)
                break;
            if (!cutChunks.has(chunkKey(f, j)))
                todo.push({ j, isUrgent: d === 1 });
        }
        let next = 0;
        const worker = async () => {
            while (next < todo.length) {
                const { j, isUrgent } = todo[next++];
                await ensureChunk($, f, source, j, isUrgent);
            }
        };
        await Promise.all(Array.from({ length: CUT_WORKERS }, worker));
    }
    finally {
        cuttingAhead.delete(f.dir);
    }
}
// Before a video is shown, the first 5 s ahead are cut too, so playback
// starts with room to spare. Never more than PREFILL_MS of waiting.
const PREFILL_MS = 4000;
async function prefill($, f, source) {
    await Promise.race([cutAhead($, f, source, 0), $.clock.sleep(PREFILL_MS)]).catch(() => undefined);
}
// Moments both runs share (a check by the same name), as [updated, original]
// seconds, kept only while both clocks move forward.
export function anchors(updated = [], original = []) {
    const at = new Map(original.filter(c => c.at !== undefined).map(c => [c.name, c.at]));
    const pairs = updated
        .filter(c => c.at !== undefined && at.has(c.name))
        .map(c => [c.at, at.get(c.name)])
        .sort((a, b) => a[0] - b[0]);
    const kept = [];
    for (const p of pairs) {
        const last = kept.at(-1) ?? [0, 0];
        if (p[0] > last[0] + 0.05 && p[1] > last[1] + 0.05)
            kept.push(p);
    }
    return kept;
}
// The original clip's moment that matches a moment of the updated clip.
export function mapTime(points, t, endA, endB) {
    const all = [[0, 0], ...points, [endA, endB]];
    for (let i = 1; i < all.length; i++) {
        const [a0, b0] = all[i - 1];
        const [a1, b1] = all[i];
        if (t <= a1 || i === all.length - 1) {
            const k = a1 > a0 ? (b1 - b0) / (a1 - a0) : 1;
            return Math.max(0, Math.min(endB, b0 + (t - a0) * k));
        }
    }
    return t;
}
// Maps a frame of one clip to the frame at the same moment in another.
export function sameMoment(from, to, frame) {
    if (!from || !to)
        return 0;
    return Math.max(0, Math.min(to.count - 1, Math.round((frame / from.fps) * to.fps)));
}
// The same moment on the other clip: updated → original seconds, and back.
export const toOriginal = (shown, t) => shown.frames && shown.compare?.frames
    ? mapTime(shown.sync ?? anchors(shown.checks, shown.compare.checks), t, shown.frames.duration, shown.compare.frames.duration)
    : t;
export const toUpdated = (shown, t) => shown.frames && shown.compare?.frames
    ? mapTime((shown.sync ?? anchors(shown.checks, shown.compare.checks)).map(([a, b]) => [b, a]), t, shown.compare.frames.duration, shown.frames.duration)
    : t;
// The compared side's frame at the moment the shown side is at.
export const compareFrame = (shown, frame) => {
    const a = shown.frames, b = shown.compare?.frames;
    if (!a || !b)
        return 0;
    const t = mapTime(shown.sync ?? anchors(shown.checks, shown.compare?.checks), frame / a.fps, a.duration, b.duration);
    return Math.max(0, Math.min(b.count - 1, Math.round(t * b.fps)));
};
// Every `stride`-th frame as a 32×18 grey thumbnail, for matching the two
// runs by eye. Small and sparse on purpose: matching costs frames × frames.
async function thumbs($, media, stride) {
    const f = media.frames;
    const r = await $.process.run([
        'sh', '-c',
        `"$0" -v error ${f.lead ? `-ss ${f.lead} ` : ''}-i "$1" -vf "fps=${f.fps},select=not(mod(n\\,${stride})),scale=32:18,format=gray" -fps_mode passthrough -frames:v ${Math.ceil(f.count / stride)} -f rawvideo - | od -An -tu1 -v`,
        state.ffmpeg, media.source ?? '',
    ]);
    const px = r.stdout.trim().split(/\s+/).map(Number);
    const out = [];
    for (let i = 0; i + 576 <= px.length; i += 576)
        out.push(px.slice(i, i + 576));
    return out;
}
// How many frames apart to sample so neither run has more than 240.
export const strideFor = (a, b) => Math.max(1, Math.ceil(Math.max(a, b) / 240));
// A match made on sampled frames, spread back over every updated frame.
export function spreadMatch(sampled, stride, count, last) {
    return Array.from({ length: count }, (_, i) => {
        const k = Math.min(sampled.length - 1, Math.floor(i / stride));
        return Math.min(last, (sampled[k] ?? 0) * stride + (i % stride));
    });
}
// What moved since the previous frame: the cursor, a fade, a scroll. The two
// runs move the same way even where the designs differ.
const motion = (f) => f.map((px, i) => (i ? px.map((v, k) => v - f[i - 1][k]) : px.map(() => 0)));
// The cheapest way to walk both runs in order, frame by frame (dynamic time
// warping), matching how frames look and how they move: [updated, original]
// frame pairs. Holding one side still costs a little, so it only holds where
// the runs really differ. Within `band` samples of the same moment only, and
// straying from it costs `drift`: two runs of the same steps keep time, so a
// screen that looks different in one (an error the other never shows) can't
// pull one side ahead of the other.
export function align(a, b, hold = 0.01, band = Number.POSITIVE_INFINITY, drift = 0) {
    const n = a.length, m = b.length;
    if (!n || !m)
        return [];
    const slope = n > 1 ? (m - 1) / (n - 1) : 0;
    // Typed rows: the inner loop runs n × m × pixels times.
    const ta = a.map(x => Int16Array.from(x)), tb = b.map(x => Int16Array.from(x));
    const ma = motion(a).map(x => Int16Array.from(x)), mb = motion(b).map(x => Int16Array.from(x));
    const diff = (i, j) => {
        let d = 0, e = 0;
        const pa = ta[i], pb = tb[j], qa = ma[i], qb = mb[j];
        for (let k = 0; k < pa.length; k++) {
            const x = pa[k] - pb[k], y = qa[k] - qb[k];
            d += x < 0 ? -x : x;
            e += y < 0 ? -y : y;
        }
        return (d + 4 * e) / (pa.length * 255);
    };
    const cost = new Float64Array(n * m);
    const step = new Uint8Array(n * m); // 0 both, 1 updated only, 2 original only
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < m; j++) {
            const off = Math.abs(j - i * slope);
            if (off > band && !(i === n - 1 && j === m - 1) && (i || j)) {
                cost[i * m + j] = Number.POSITIVE_INFINITY;
                step[i * m + j] = 0;
                continue;
            }
            const d = diff(i, j) + drift * off;
            if (!i && !j) {
                cost[0] = d;
                continue;
            }
            const both = i && j ? cost[(i - 1) * m + j - 1] : Number.POSITIVE_INFINITY;
            const up = i ? cost[(i - 1) * m + j] + hold : Number.POSITIVE_INFINITY;
            const on = j ? cost[i * m + j - 1] + hold : Number.POSITIVE_INFINITY;
            const best = Math.min(both, up, on);
            cost[i * m + j] = best + d;
            step[i * m + j] = best === both ? 0 : best === up ? 1 : 2;
        }
    }
    const path = [];
    for (let i = n - 1, j = m - 1;;) {
        path.push([i, j]);
        if (!i && !j)
            break;
        const s = step[i * m + j];
        if (s === 0) {
            i--;
            j--;
        }
        else if (s === 1)
            i--;
        else
            j--;
    }
    return path.reverse();
}
// For each updated frame, the original frame shown beside it.
export function matchOf(path, count) {
    const out = new Array(count).fill(0);
    for (const [i, j] of path)
        if (i < count)
            out[i] = j;
    for (let i = 1; i < count; i++)
        out[i] = Math.max(out[i], out[i - 1]);
    return out;
}
// The path cut to the few turns that matter, in seconds, to keep it small.
export function turns(match, fpsA, fpsB) {
    const points = [];
    for (let i = 1; i < match.length - 1; i++) {
        const before = match[i] - match[i - 1], after = match[i + 1] - match[i];
        if ((before === 0) !== (after === 0) || Math.abs(before - after) > 1)
            points.push([+(i / fpsA).toFixed(2), +(match[i] / fpsB).toFixed(2)]);
    }
    return points.length > 40 ? points.filter((_, k) => k % Math.ceil(points.length / 40) === 0) : points;
}
// The largest still kept whole.
export const MAX_STILL = 3200;
// Pixels between Original and Updated in the merged clip.
export const PAIR_GAP = 40;
// How tall the merged clip is cut: the shorter side's height, 720 px at most.
// The terminal never draws a picture larger than it is, so 360 px kept the
// side by side view small in any window.
export const pairHeightOf = (updated, original) => Math.max(2, Math.floor(Math.min(720, updated.height || 720, original.height || 720) / 2) * 2);
// Merges the original and updated recordings into one clip, side by side.
// The original's frames are matched to the updated clip's by how they look,
// so every step happens at the same moment on both sides.
export async function preparePair($, original, updated) {
    const f = updated.frames, g = original.frames;
    state.generation += 1;
    // p2: pairs made before the time-first matching are never reused.
    const dir = `${state.TMP}/p2-${keyOf(`${f.dir}|${g.dir}|${pairHeightOf(updated, original)}`)}`;
    const known = await readMeta($, dir);
    if (known) {
        const pair = { ...known.pair, dir };
        await $.process.run(['touch', dir]).catch(() => undefined);
        await pairChunk($, pair, updated, original, i => compareFrame({ ...updated, compare: original, sync: known.sync }, i), 0);
        return { pair, pairWidth: known.pairWidth, pairHeight: known.pairHeight, sync: known.sync };
    }
    // Two runs of the same steps take about as long: then the same moment on
    // both sides is the same second (moved to the checks' own moments when
    // they're given). Only runs that differ a lot are matched by how they look.
    const byTime = () => Array.from({ length: f.count }, (_, i) => Math.min(g.count - 1, Math.round(mapTime(anchors(updated.checks, original.checks), i / f.fps, f.duration, g.duration) * g.fps)));
    const isSamePace = Math.abs(f.duration - g.duration) <= 0.15 * Math.max(f.duration, g.duration);
    const stride = strideFor(f.count, g.count);
    const [ta, tb] = isSamePace ? [[], []] : await Promise.all([thumbs($, updated, stride), thumbs($, original, stride)]);
    const match = ta.length && tb.length
        ? spreadMatch(matchOf(align(ta, tb, 0.01, Math.max(2, Math.round((0.6 * f.fps) / stride)), 0.02), ta.length), stride, f.count, g.count - 1)
        : byTime();
    await $.process.run(['mkdir', '-p', dir]);
    const pair = { dir, count: f.count, fps: f.fps, duration: f.duration };
    await pairChunk($, pair, updated, original, i => match[i] ?? 0, 0);
    if (!(await exists($, frameFile(pair, 0))))
        return null;
    const size = await pngSize($, frameFile(pair, 0));
    const made = { pair, pairWidth: size.width, pairHeight: size.height, sync: turns(match, f.fps, g.fps) };
    await writeMeta($, dir, { ...made, pair: { count: pair.count, fps: pair.fps, duration: pair.duration } });
    return made;
}
// One chunk of the merged clip, Original left and Updated right, made from
// the two sides' frames for that stretch (decoded first if they have to be).
function pairChunk($, pair, updated, original, jOf, i) {
    const c = Math.floor(Math.max(0, Math.min(i, pair.count - 1)) / CHUNK);
    const key = `${pair.dir}#${c}`;
    const running = decoding.get(key);
    if (running)
        return running;
    const f = updated.frames, g = original.frames;
    const job = (async () => {
        const first = c * CHUNK, n = Math.min(CHUNK, pair.count - first);
        if (await exists($, frameFile(pair, Math.max(0, Math.min(i, pair.count - 1)))))
            return;
        const js = Array.from({ length: n }, (_, k) => Math.max(0, Math.min(g.count - 1, jOf(first + k))));
        await ensureChunk($, f, updated.source, first);
        for (const jc of new Set(js.map(j => Math.floor(j / CHUNK))))
            await ensureChunk($, g, original.source, jc * CHUNK);
        const tmp = `${pair.dir}/c${c}`;
        await $.process.run(['mkdir', '-p', `${tmp}/o`, `${tmp}/u`]);
        const links = js.map((j, k) => `ln -sf "${frameFile(g, j)}" "$0/o/f${String(k + 1).padStart(5, '0')}.png"; ln -sf "${frameFile(f, first + k)}" "$0/u/f${String(k + 1).padStart(5, '0')}.png"`).join('\n');
        await $.process.run(['sh', '-c', links, tmp]);
        // Needed on screen now: normal priority.
        await $.process.run([
            state.ffmpeg, '-v', 'error', ...ONE_THREAD, '-framerate', String(f.fps), '-i', `${tmp}/o/f%05d.png`, '-framerate', String(f.fps), '-i', `${tmp}/u/f%05d.png`,
            '-filter_complex', `[0:v]scale=-2:${pairHeightOf(updated, original)},pad=iw+${PAIR_GAP}:ih:0:0:color=${SIDEBAR.replace('#', '0x')}[a];[1:v]scale=-2:${pairHeightOf(updated, original)}[b];[a][b]hstack=inputs=2`,
            '-frames:v', String(n), '-threads', '1', '-start_number', String(first + 1), '-compression_level', '1', `${pair.dir}/f%05d.png`,
        ]);
        await $.process.run(['rm', '-rf', tmp]);
        await prune($, pair.dir, c, pair.fps);
    })().catch(() => undefined).finally(() => decoding.delete(key));
    decoding.set(key, job);
    return job;
}
// The merged frame on screen, made if it has to be, the next chunk ahead.
export async function pairReady($, shown, i, site) {
    const pair = shown.pair;
    if (!pair || !shown.compare)
        return;
    if (site)
        watch(pair.dir, site, i);
    const jOf = (k) => compareFrame(shown, k);
    await pairChunk($, pair, shown, shown.compare, jOf, i);
    if (i % CHUNK >= CHUNK / 2 && i + CHUNK < pair.count)
        void pairChunk($, pair, shown, shown.compare, jOf, i + CHUNK);
}
// Resolves a path to something the terminal can draw: a PNG (other image
// formats converted with macOS `sips`), or a video's frames.
export async function prepare($, raw, title, key) {
    const path = expand(raw, state.cwd, state.home);
    const stat = await $.fs.stat(path, { resolve: true });
    const real = stat.realPath ?? path;
    const name = title ?? real.split('/').pop();
    if (VIDEO.test(real))
        return prepareVideo($, real, name, key ?? (await identityOf($, real)));
    let png = real;
    if (!/\.png$/i.test(real)) {
        state.generation += 1;
        png = `${state.TMP}/${real.split('/').pop().replace(/\.[^.]+$/, '')}-${state.generation}.png`;
        await $.process.run(['mkdir', '-p', state.TMP]);
        if (!state.isMac && !(await exists($, state.ffmpeg)))
            throw new Error(noFfmpeg(false));
        const conv = state.isMac
            ? await $.process.run(['sips', '-s', 'format', 'png', real, '--out', png])
            : await $.process.run([state.ffmpeg, '-v', 'error', '-y', '-i', real, '-frames:v', '1', png]);
        if (conv.exitCode !== 0)
            throw new Error(`could not convert ${real}: ${conv.stderr.trim()}`);
    }
    // The terminal reads the file itself, so only a picture past what any
    // screen shows is shrunk.
    const dims = await pngSize($, png);
    if (Math.max(dims.width, dims.height) > MAX_STILL) {
        state.generation += 1;
        const small = `${state.TMP}/${png.split('/').pop().replace(/\.png$/i, '')}-${state.generation}-small.png`;
        await $.process.run(['mkdir', '-p', state.TMP]);
        const shrunk = state.isMac
            ? await $.process.run(['sips', '-Z', String(MAX_STILL), png, '--out', small])
            : await $.process.run([state.ffmpeg, '-v', 'error', '-y', '-i', png, '-vf', `scale='if(gt(iw,ih),min(${MAX_STILL},iw),-2)':'if(gt(iw,ih),-2,min(${MAX_STILL},ih))'`, small]).catch(() => ({ exitCode: 1 }));
        if (state.isMac || shrunk.exitCode === 0)
            png = small;
    }
    // A picture narrower than the window shows it is drawn that wide, as a
    // video's frames are, so a picture and a video of one shape are one size.
    // Never past twice its own width: a small icon stays small.
    const now = await pngSize($, png);
    const wide = Math.min(frameWidth(now.width, now.height, state.termSize, state.cell), now.width * 2);
    if (wide > now.width) {
        state.generation += 1;
        const big = `${state.TMP}/${png.split('/').pop().replace(/\.png$/i, '')}-${state.generation}-w${wide}.png`;
        await $.process.run(['mkdir', '-p', state.TMP]);
        const grown = state.isMac
            ? await $.process.run(['sips', '--resampleWidth', String(wide), png, '--out', big]).catch(() => ({ exitCode: 1 }))
            : await $.process.run([state.ffmpeg, '-v', 'error', '-y', '-i', png, '-vf', `scale=${wide}:-2:flags=lanczos`, big]).catch(() => ({ exitCode: 1 }));
        if (grown.exitCode === 0)
            png = big;
    }
    state.generation += 1;
    return { kind: 'image', path: png, source: real, ...(await pngSize($, png)), sourceWidth: dims.width, sourceHeight: dims.height, title: name, generation: state.generation };
}
