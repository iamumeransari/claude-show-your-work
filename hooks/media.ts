// Getting pictures and videos ready to draw: conversion, frames cut a chunk
// at a time, the side-by-side clip of two runs, and the frame cache.
import type { EngineInterface } from 'claude-code'

import type { Check, Frames, Shown } from '../types'

import { state } from './state'
import { frameWidth, PX_MAX, SIDEBAR } from './layout'
import { debug } from './diagnostics'

// Deletes the oldest frame folders until the cache is under $1 KB, keeping the
// newest two and the ones named in $2; only inside a folder this user owns.
export const TRIM_SH = [
  '[ -d "$0" ] && [ ! -L "$0" ] && [ -O "$0" ] && cd -P "$0" 2>/dev/null || exit 0',
  // Only the folders the plugin names (v-<key>, v<n>-<time>, p-<key>,
  // p2-<key>), one per line: a picture named by the user never matches.
  'all=$(ls -dtr -- v* p* 2>/dev/null | grep -E "^(v-[0-9a-f]+|v[0-9]+-[0-9]+|p2?-[0-9a-f]+)$"); n=$(printf "%s\\n" "$all" | grep -c .)',
  // Only these folders count against the cap: the stills beside them used to
  // count too, so with enough of those every trim emptied the frame cache.
  'size() { printf "%s\\n" "$all" | while IFS= read -r f; do [ -d "$f" ] && du -sk -- "$f"; done | awk \'{s += $1} END {print s + 0}\'; }',
  'printf "%s\\n" "$all" | head -n $((n > 2 ? n - 2 : 0)) | while IFS= read -r d; do',
  '  [ -n "$d" ] && [ -d "$d" ] || continue',
  '  [ "$(size)" -le "$1" ] && break',
  '  case " $2 " in *" $d "*) continue ;; esac',
  // A folder changed in the last two minutes may be being cut into right
  // now (a copy at another width of a playing video): never pulled away.
  '  [ -n "$(find "./$d" -maxdepth 0 -mmin -2 2>/dev/null)" ] && continue',
  '  [ -L "$d" ] || rm -rf "./$d"',
  'done; true',
].join('\n')
// Deletes anything in the cache older than a week, without following links.
export const CLEAN_SH = [
  '[ -d "$0" ] && [ ! -L "$0" ] && [ -O "$0" ] || exit 0',
  'find -P "$0" -mindepth 1 -maxdepth 1 -mtime +7 -exec rm -rf {} + 2>/dev/null; true',
].join('\n')
export const VIDEO = /\.(mp4|mov|m4v|webm|mkv|avi|gif)$/i
// Frames a clip is cut into at most, and the rate it plays at below that.
// A clip cut whole (no known length) keeps every frame on disk at once, so it
// stays at MAX_FRAMES. One of known length is cut as it plays and only a few
// chunks are ever on disk, so it can run to MAX_STREAMED at the full rate.
const MAX_FRAMES = 900
const MAX_STREAMED = 3600
const MAX_FPS = 12

// A typed or dragged-in path: quotes, backslash-escaped spaces and ~ allowed.
export function expand(path: string, base: string, homeDir: string): string {
  let p = path.trim().replace(/^(['"])(.*)\1$/, '$2').replace(/\\(.)/g, '$1')
  if (p === '~' || p.startsWith('~/')) p = homeDir + p.slice(1)
  if (p.startsWith('/')) return p

  return `${base.replace(/\/$/, '')}/${p}`
}

// A name with its look-alike spaces made plain: macOS writes a narrow
// no-break space before AM/PM in screenshot names, which a typed path lacks.
export const looseName = (name: string) =>
  name.normalize('NFC').replace(/[  -   　]/g, ' ')

// The file a path means: as given when it exists, else the one entry in its
// folder whose name matches once spaces are made plain.
export async function locate($: EngineInterface, raw: string): Promise<string> {
  const path = expand(raw, state.cwd, state.home)
  if (await $.fs.stat(path).then(() => true, () => false)) return path
  const cut = path.lastIndexOf('/')
  const dir = path.slice(0, cut) || '/'
  const want = looseName(path.slice(cut + 1))
  const hit = (await $.fs.list(dir).catch(() => [])).find(f => looseName(f.name) === want)

  return hit ? `${dir.replace(/\/$/, '')}/${hit.name}` : path
}

// A video's frames are raw RGB files wherever the terminal reads the
// plugin's files itself: nothing to compress, and the terminal draws them
// without decoding. A PNG cost ~0.2 s of CPU a frame for 1080p camera footage
// (zlib; only 30% smaller there), so on a busy machine cutting fell to 0.3x
// real time and playback froze; raw cut at 0.9x with a fifth of the CPU.
// PNG only where raw can't go: pictures sent as bytes (ssh: 4.7 MB a frame
// through the connection) or a terminal that reads small files only (Orca).
export const usesRaw = () => !state.sendBytes && readsAnyFile()
// Each raw folder's frame size, for the terminal (a raw file has no header).
const rawSizes = new Map<string, { width: number; height: number }>()
export function frameFile(frames: Frames, i: number) {
  if (frames.raw) rawSizes.set(frames.dir, frames.raw)
  return `${frames.dir}/f${String(i + 1).padStart(5, '0')}.${frames.raw ? 'rgb' : 'png'}`
}
// The pixel size of a raw frame file, or undefined for a PNG.
export const rawSizeOf = (file: string) => (file.endsWith('.rgb') ? rawSizes.get(file.slice(0, file.lastIndexOf('/'))) : undefined)
// What ffmpeg writes a frame as: raw RGB at an exact size, or a PNG.
const frameOut = (raw: boolean, scale: string) =>
  raw ? ['-vf', `${scale},format=rgb24`, '-c:v', 'rawvideo', '-f', 'image2', '-atomic_writing', '1'] : ['-vf', scale, '-compression_level', '1']
// A raw frame's height from its size on disk: ffmpeg picks it (-2 keeps the
// aspect, after any rotation), so it's read back rather than worked out.
async function rawSize($: EngineInterface, file: string, width: number) {
  const st = await $.fs.stat(file)
  const height = Math.round(st.size / 3 / width)
  if (!width || height * width * 3 !== st.size) throw new Error(`not a raw frame: ${file}`)
  return { width, height }
}

// How fast to sample a clip of known length so it stays under MAX_STREAMED.
export const sampleRate = (duration: number) =>
  Math.max(1, Math.min(MAX_FPS, Math.floor(MAX_STREAMED / Math.max(duration, 0.1))))

// A PNG's size from its header (bytes 16 to 24), without any tool.
export function pngDims(base64: string): { width: number; height: number } | null {
  const b = Uint8Array.from(atob(base64.slice(0, 44)), c => c.charCodeAt(0))
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null
  const at = (i: number) => (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0

  return { width: at(16), height: at(20) }
}

// Finds a pasted image's original file by name with Spotlight (macOS).
export async function findPasted($: EngineInterface, name: string): Promise<string | null> {
  if (name.startsWith('/')) return name
  if (!state.isMac) return null
  const found = await $.process.run(['mdfind', '-name', name])

  return found.stdout.split('\n').find(line => line.endsWith(`/${name}`)) ?? null
}

export async function pngSize($: EngineInterface, png: string) {
  if (!state.isMac) {
    const d = pngDims(String((await $.fs.read(png, { as: 'bytes' }) as unknown as { base64: string }).base64 ?? ''))
    if (!d || !d.width || !d.height) throw new Error(`not an image: ${png}`)
    return d
  }
  const dims = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', png])
  const width = Number(/pixelWidth:\s*(\d+)/.exec(dims.stdout)?.[1] ?? 0)
  const height = Number(/pixelHeight:\s*(\d+)/.exec(dims.stdout)?.[1] ?? 0)
  if (!width || !height) throw new Error(`not an image: ${png}`)

  return { width, height }
}

// Frames on disk are a cache: past 500 MB the oldest folders go, and a window
// that plays one again decodes it again (decode). The newest two stay.
const FRAMES_CAP_KB = 500_000
// Folders this session is playing are never trimmed.
export function trimFrames($: EngineInterface) {
  const inUse = [...watching.keys()].map(d => d.split('/').pop()!).join(' ')
  return $.process.run(['sh', '-c', TRIM_SH, state.TMP, String(FRAMES_CAP_KB), inUse]).catch(() => undefined)
}

// A screen recording's blank opening (a page loading: one flat tone, maybe a
// spinner), in the log of `ffmpeg -t 8 -i <clip> -vf fps=10,scale=160:-2,
// signalstats,metadata=print -an -f null -`: the time of the first frame whose
// 10th to 90th percentile brightness spreads wider than a flat page does, if
// that leaves something after it. Print every key: metadata takes one key=,
// and a second replaces the first. Not used while the skip is off.
export function leadFrom(log: string, duration: number): number {
  let t = 0, low = -1
  for (const line of log.split('\n')) {
    const pts = line.match(/pts_time:([\d.]+)/)
    if (pts) { t = Number(pts[1]); low = -1; continue }
    const lo = line.match(/YLOW=([\d.]+)/)
    if (lo) { low = Number(lo[1]); continue }
    const hi = line.match(/YHIGH=([\d.]+)/)
    if (hi && low >= 0) {
      if (Number(hi[1]) - low > 24) {
        const lead = Math.round(t * 100) / 100
        return lead > 0 && (!(duration > 0) || lead < duration - 0.5) ? lead : 0
      }
      low = -1
    }
  }
  return 0
}

// Times given on the clip as it was, moved to the frames that start after
// its white opening.
export function shiftTimes<T extends { at?: number }>(list: T[] | undefined, lead: number): T[] | undefined {
  if (!list || !lead) return list
  return list.map(c => (c.at === undefined ? c : { ...c, at: Math.max(0, +(c.at - lead).toFixed(2)) }))
}

// HTML is rendered as a fixed viewport, not an interactive browser. The
// original stays the Open page target; only its screenshot enters history.
export const isPage = (path: string) => /\.html?$/i.test(path)
// The page's own window: the browser engine as a small standalone viewer, the
// way an image opens in an image viewer — no tabs, no address bar, and none of
// the desktop's file-handler surprises (a hijacked text/html default). Its own
// profile: the person's running browser never takes the window over, and the
// viewer carries none of their logins.
// Each path segment percent-encoded, so a name with spaces, `#`, `%` or `?`
// names the right file.
const fileUrl = (page: string) => `file://${page.split('/').map(encodeURIComponent).join('/')}`
export const htmlOpenArgv = (chrome: string, page: string) => [
  chrome, '--no-first-run', '--no-default-browser-check', `--app=${fileUrl(page)}`, '--window-size=960,720',
  `--user-data-dir=${state.TMP}/page-viewer.profile`,
]
export const htmlArgv = (chrome: string, page: string, png: string) => [
  chrome, '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--mute-audio',
  `--user-data-dir=${png}.profile`, '--window-size=1280,800',
  '--virtual-time-budget=1000', `--screenshot=${png}`, fileUrl(page),
]
export async function renderPage($: EngineInterface, page: string, key: string): Promise<string> {
  if (!state.chrome) throw new Error('pages need Chrome or Chromium')
  const folder = await $.process.run(['mktemp', '-d', `${state.TMP}/page-XXXXXX`])
  const dir = folder.stdout.trim()
  if (folder.exitCode !== 0 || !dir.startsWith(`${state.TMP}/page-`)) throw new Error("the page couldn't be rendered: could not create its temporary folder")
  const png = `${dir}/page-${key}.png`
  try {
    const result = await $.process.run(htmlArgv(state.chrome, page, png), { timeoutMs: 20000 })
    if (result.exitCode !== 0 || !(await exists($, png))) throw new Error("the page couldn't be rendered by Chrome or Chromium")
    return png
  } finally {
    // A fresh browser profile, never the person's login, cookies or extensions.
    await $.process.run(['rm', '-rf', '--', `${png}.profile`]).catch(() => undefined)
  }
}

// A sound file on its own: MP3 or WAV, nothing else promised.
export const AUDIO = /\.(mp3|wav)$/i
export const isAudio = (path: string) => AUDIO.test(path)

// The waveform card: a wide, short picture like a player's progress strip.
// The card's own background, the part already heard and the part to come:
// gray reads clearly on the card (3.7:1) and the orange clearly against the
// gray (2.5:1, beside the bar and the time, so never colour alone).
export const WAVE_WIDTH = 1600
export const WAVE_HEIGHT = 240
export const WAVE_PLAYED = '#ff8c00'
export const WAVE_UNPLAYED = '#6e7480'
export const WAVE_CARD = '#181a1f'

// One strip of the whole clip's waveform, one colour, on the card's background.
// showwavespic draws the entire clip as one picture: no live spectrum, ever.
export const waveStripArgv = (ffmpeg: string, source: string, png: string, color: string) => [
  ffmpeg, '-v', 'error', '-y',
  '-f', 'lavfi', '-i', `color=c=${WAVE_CARD}:s=${WAVE_WIDTH}x${WAVE_HEIGHT}`,
  '-i', source,
  '-filter_complex', `[1:a]showwavespic=s=${WAVE_WIDTH}x${WAVE_HEIGHT}:colors=${color}:scale=cbrt[wave];[0:v][wave]overlay=0:0:format=auto`,
  '-frames:v', '1', png,
]

// The clip itself: the waveform stands still, and the part behind the moment
// glows while a thin white bar marks the moment itself, so the position reads
// whatever the colours around it. The original audio rides along untouched
// (stream copy): what is heard and what lights up are one file, one clock.
//
// Cheap on purpose. ffmpeg's built-in wipe moves the colour edge (a per-pixel
// blend expression took 70 s and 316 s of CPU for a 3-minute song; this takes
// about 3 s). The wipe lasts at most 60 s, so a longer clip is wiped on a
// timeline k times shorter and stretched back. Each distinct frame repeats k
// times, a step of 1600 / (seconds * 12 / k) px, under 3 px at 12 fps, and
// repeats cost x264 next to nothing. Past five minutes the clip drops below
// 12 fps so it never holds more than 3,600 frames.
export const WAVE_FPS = 12
export const waveArgv = (ffmpeg: string, bright: string, dim: string, source: string, out: string, seconds: number) => {
  const fps = Math.max(1, Math.min(WAVE_FPS, Math.floor(3600 / seconds)))
  const k = Math.max(1, Math.ceil(seconds / 60))
  const span = +(seconds / k).toFixed(3)
  return [
    ffmpeg, '-v', 'error', '-y',
    '-loop', '1', '-framerate', String(fps), '-t', String(span), '-i', dim,
    '-loop', '1', '-framerate', String(fps), '-t', String(span), '-i', bright,
    '-i', source,
    '-f', 'lavfi', '-i', `color=c=white:s=3x${WAVE_HEIGHT}`,
    '-filter_complex',
    `[0:v]format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]xfade=transition=wiperight:duration=${span}:offset=0,setpts=${k}*PTS,fps=${fps}[w];` +
      `[w][3:v]overlay=x='W*t/${seconds}':y=0:shortest=1,format=yuv420p[v]`,
    '-map', '[v]', '-map', '2:a:0', '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-crf', '20', '-g', '12',
    '-c:a', 'copy', '-f', 'matroska', out,
  ]
}

// One encode of a clip at a time, shared by every call that lands while it
// runs: two shows of one file in quick succession (or racing tool calls) cut
// it once, not twice into the same temporary name (the `asking` map in sound.ts
// is the same pattern). Cross-session races can still start two encodes; each
// writes its own side name and each move is atomic, so only a whole clip ever
// lands under the final name.
const waving = new Map<string, Promise<string>>()
let waveAttempt = 0
const waveSession = Math.random().toString(36).slice(2)

export function ensureWave($: EngineInterface, real: string, id: string): Promise<string> {
  const out = `${state.TMP}/a-${id.slice(0, 10)}.mkv`
  let job = waving.get(out)
  if (!job) {
    job = cutWave($, real, out).finally(() => { if (waving.get(out) === job) waving.delete(out) })
    waving.set(out, job)
  }
  return job
}

async function cutWave($: EngineInterface, real: string, out: string): Promise<string> {
  if (await isGone($, out)) {
    const dur = await $.process.run([state.ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', real])
    const seconds = Number(dur.stdout.trim())
    if (dur.exitCode !== 0 || !Number.isFinite(seconds) || seconds <= 0) throw new Error(`ffmpeg could not read ${real}: ${(dur.stderr || dur.stdout).trim().slice(0, 200)}`)
    await $.process.run(['mkdir', '-p', state.TMP])
    // This attempt's own names: a second run (another session, or one that
    // slipped past the map) never writes where this one writes — the session
    // prefix keeps two Claude processes from ever colliding on one name.
    const attempt = waveSession + Date.now().toString(36) + (waveAttempt += 1).toString(36)
    const bright = `${out.slice(0, -4)}.${attempt}.bright.png`
    const dim = `${out.slice(0, -4)}.${attempt}.dim.png`
    const part = `${out}.${attempt}.part`
    try {
      for (const [png, color] of [[bright, WAVE_PLAYED], [dim, WAVE_UNPLAYED]] as const) {
        const strip = await $.process.run(waveStripArgv(state.ffmpeg, real, png, color), { timeoutMs: 120000 })
        if (strip.exitCode !== 0) throw new Error(`ffmpeg could not read ${real}: ${strip.stderr.trim().slice(0, 200)}`)
      }
      const made = await $.process.run(waveArgv(state.ffmpeg, bright, dim, real, part, +seconds.toFixed(3)), { timeoutMs: 120000 })
      if (made.exitCode !== 0) throw new Error(`ffmpeg could not read ${real}: ${made.stderr.trim().slice(0, 200)}`)
      if ((await $.process.run(['mv', '-f', part, out])).exitCode !== 0) throw new Error(`ffmpeg could not read ${real}: could not finish`)
    } finally {
      await $.process.run(['rm', '-f', '--', part, bright, dim]).catch(() => undefined)
    }
  }
  return out
}

// An audio file becomes a clip of its own waveform and plays like any other:
// the frames, the play timer, the scrub bar, the skips and the sound are the
// player's own, and the person's file stays what Open and Save reach for.
export async function prepareAudio($: EngineInterface, real: string, title: string, key?: string): Promise<Shown> {
  if (!state.hasVideoTools) {
    state.hasVideoTools = (await Promise.all([exists($, state.ffmpeg), exists($, state.ffprobe)])).every(Boolean)
    if (!state.hasVideoTools) throw new Error(noFfmpeg(state.isMac))
  }
  const wave = await ensureWave($, real, key ?? (await identityOf($, real)) ?? keyOf(real))
  return { ...(await prepareVideo($, wave, title, await identityOf($, wave).catch(() => undefined))), kind: 'audio', origin: real }
}

// What to tell Claude and the person when a video can't be cut into frames.
export const NO_FFMPEG =
  "videos need ffmpeg, and it isn't installed. Pictures still work. Install it with `brew install ffmpeg` " +
  '(Claude can run that for you), then restart Claude Code. No Homebrew? Install it first from https://brew.sh.'

// On Linux ffmpeg also turns pictures other than PNG into PNG.
export const NO_FFMPEG_LINUX =
  "videos and pictures other than PNG need ffmpeg, and it isn't installed. Install it with your package manager, " +
  'for example `sudo apt install ffmpeg` or `sudo dnf install ffmpeg` (Claude can run that for you), then restart Claude Code.'
export const noFfmpeg = (mac: boolean) => (mac ? NO_FFMPEG : NO_FFMPEG_LINUX)
export const FFMPEG_PROMPT_LINUX =
  "Install ffmpeg for me with this machine's package manager (for example `sudo apt install ffmpeg`). Then show it again."

// What the person pastes back so Claude installs ffmpeg and tries again.
export const FFMPEG_PROMPT =
  'Install ffmpeg for me with `brew install ffmpeg`. If Homebrew isn\'t installed, tell me how to install it first. Then show the video again.'

// A failure as the person and Claude see it: a box in place of the picture,
// one plain message for Claude, and a prompt to paste back. Never raw tool
// output, never the plugin's internal copy of a file.
export type NoticeKind = 'missing' | 'not_image' | 'broken_video' | 'no_picture' | 'no_ffmpeg' | 'other'
export type Notice = { kind: NoticeKind; title: string; text: string; message: string; prompt: string }

// How a failure reads, from whatever the tools said; `path` is the person's own.
export function noticeOf(err: unknown, path: string, homeDir = ''): Notice {
  const raw = String((err as Error)?.message ?? err)
  const shown = homeDir && path.startsWith(`${homeDir}/`) ? `~${path.slice(homeDir.length)}` : path
  const name = path.split('/').pop() || path
  if (raw.includes(NO_FFMPEG_LINUX)) return {
    kind: 'no_ffmpeg', title: 'This needs ffmpeg', message: NO_FFMPEG_LINUX, prompt: FFMPEG_PROMPT_LINUX,
    text: "ffmpeg isn't installed, so videos and pictures other than PNG can't show here. Copy the prompt and paste it to Claude to install it, or install it yourself, for example `sudo apt install ffmpeg`.",
  }
  if (raw.includes(NO_FFMPEG)) return {
    kind: 'no_ffmpeg', title: 'Videos need ffmpeg', message: NO_FFMPEG, prompt: FFMPEG_PROMPT,
    text: "ffmpeg isn't installed, so this video can't play here. Pictures still work. Copy the prompt and paste it to Claude to install it, or run `brew install ffmpeg` yourself. No Homebrew? Get it from brew.sh first.",
  }
  if (/^not audio:/i.test(raw)) return {
    kind: 'not_image', title: "This isn't an audio file",
    text: `${name} isn't MP3 or WAV, so it can't play here. Convert it to WAV and show it again.`,
    message: `${shown} isn't an audio file (show_audio opens MP3 and WAV). Convert it, for example to WAV with ffmpeg, then show it again; use show_video for a video with sound.`,
    prompt: `Convert ${shown} to WAV (or MP3) for me, then show it to me again.`,
  }
  if (/does not contain any stream|matches no streams|no frames in|Output file is empty/i.test(raw)) return AUDIO.test(path) ? {
    kind: 'no_picture', title: "This audio can't be read",
    text: `${name} is too short or empty to draw, so there's nothing to play.`,
    message: `${shown} is too short or empty to play. Don't retry it; show a real audio file instead.`,
    prompt: `${shown} is too short to play. Find a real audio file and show it to me again.`,
  } : {
    kind: 'no_picture', title: 'This video has no picture',
    text: `${name} has sound but no picture, so there's nothing to play.`,
    message: `${shown} has no video track (sound only), so there's nothing to play. Don't retry it; show a file with a picture instead.`,
    prompt: `${shown} has no picture, only sound. Find the right video and show it to me again.`,
  }
  if (/ffmpeg could not read|Invalid data|moov atom|could not find codec|Error opening input/i.test(raw)) return AUDIO.test(path) ? {
    kind: 'broken_video', title: "This audio can't be read",
    text: `${name} couldn't be opened as audio. It may be cut off, still being written, or not really an audio file.`,
    message: `${shown} couldn't be read as audio: it's damaged, unfinished (still being recorded or cut off), or not an audio file. Re-export it, then show it again.`,
    prompt: `${shown} couldn't be read as audio. Check it, re-export it if it's broken, then show it to me again.`,
  } : {
    kind: 'broken_video', title: "This video can't be read",
    text: `${name} couldn't be opened as a video. It may be cut off, still being written, or not really a video.`,
    message: `${shown} couldn't be read as a video: it's damaged, unfinished (still recording or cut off), or not a video. Re-export or re-record it, then show it again.`,
    prompt: `${shown} couldn't be read as a video. Check it, re-export or re-record it if it's broken, then show it to me again.`,
  }
  if (/could not convert|not an image|Cannot extract image|sips/i.test(raw)) return {
    kind: 'not_image', title: "This isn't a picture",
    text: `${name} isn't a picture, so it can't be shown. Pictures can be PNG, JPEG, WebP, GIF or TIFF.`,
    message: `${shown} isn't a picture (show_image opens PNG, JPEG, WebP, GIF and TIFF). Show an image file, or use show_video for a video.`,
    prompt: `${shown} isn't a picture. Show me the right file instead.`,
  }
  if (/ENOENT|no such file|not found/i.test(raw)) return {
    kind: 'missing', title: 'File not found',
    text: `There's no file at ${shown}.`,
    message: `There's no file at ${shown}. Check the path (it may have moved or not been saved yet), then show it again.`,
    prompt: `There's no file at ${shown}. Find the right file and show it to me again.`,
  }
  if (/pages need Chrome or Chromium/i.test(raw)) return {
    kind: 'other', title: 'Pages need a browser',
    text: `${name} is an HTML page, and no Chrome or Chromium was found to render it. Copy the prompt and paste it to Claude to install one, or install it yourself.`,
    message: `${shown} is an HTML page, and no Chrome or Chromium was found to render it. Screenshot it with headless Playwright instead and show that with show_image.`,
    prompt: `Install Google Chrome or Chromium for me, then restart Claude Code. After that, show ${shown} to me again.`,
  }
  // A page Chrome couldn't render still reaches the person as a picture.
  if (/the page couldn't be rendered/i.test(raw)) return {
    kind: 'other', title: "Couldn't render the page",
    text: `${name} couldn't be rendered as a page. Claude can screenshot it another way and show that.`,
    message: `${shown} couldn't be rendered as a page. Screenshot it with headless Playwright instead and show that with show_image.`,
    prompt: `${shown} couldn't be rendered as a page. Screenshot it with headless Playwright and show it to me with show_image.`,
  }
  const detail = (raw.split('\n')[0] ?? '').replace(/\/(?:private\/)?tmp\/\S+|\S*\/\.show-your-work\/\S+/g, name).slice(0, 160)
  return {
    kind: 'other', title: "Couldn't show it",
    text: `${name} couldn't be shown: ${detail}`,
    message: `${shown} couldn't be shown: ${detail}`,
    prompt: `${shown} couldn't be shown (${detail}). Look into it and show it to me again.`,
  }
}

// The usage-stats reason for a failure, as a kind.
export const REASONS: Record<NoticeKind, string> = {
  missing: 'missing_file', no_ffmpeg: 'video_tools', not_image: 'unreadable', broken_video: 'unreadable', no_picture: 'unreadable', other: 'other',
}

// Cuts a clip into PNG frames the terminal can swap through.
// A file as it is now: its path, size and modified time. The same unchanged
// file shown again maps to the same frames folder and skips the decode; a
// re-rendered one gets a new key and decodes fresh.
export function keyOf(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  return hash.toString(16).padStart(8, '0') + text.length.toString(16)
}
export async function identityOf($: EngineInterface, raw: string): Promise<string | undefined> {
  const st = await $.fs.stat(expand(raw, state.cwd, state.home), { resolve: true }).catch(() => null)
  return st ? keyOf(`${st.realPath ?? raw}|${st.size}|${st.mtimeMs}`) : undefined
}
// What a folder's meta.json holds, unchecked: the caller says what it expects.
// (No type argument at the call: the directory review reads only fn($, ...).)
async function readMeta($: EngineInterface, dir: string): Promise<unknown> {
  const r = await $.process.run(['cat', `${dir}/meta.json`]).catch(() => null)
  if (!r || r.exitCode !== 0) return null
  try { return JSON.parse(r.stdout) as unknown } catch { return null }
}
function writeMeta($: EngineInterface, dir: string, meta: unknown) {
  return $.process.run(['sh', '-c', 'printf "%s" "$1" > "$0/meta.json"', dir, JSON.stringify(meta)]).catch(() => undefined)
}

export async function prepareVideo($: EngineInterface, real: string, title: string, key?: string, cutAt?: number): Promise<Shown> {
  if (!state.hasVideoTools) {
    state.hasVideoTools = (await Promise.all([exists($, state.ffmpeg), exists($, state.ffprobe)])).every(Boolean)
    if (!state.hasVideoTools) throw new Error(noFfmpeg(state.isMac))
  }
  const facts = await $.process.run([state.ffprobe, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name:format=duration', '-of', 'default=nw=1', real])
  const field = (name: string) => Number(new RegExp(`^${name}=([0-9.]+)`, 'm').exec(facts.stdout)?.[1] ?? Number.NaN)
  hwDecode.set(real, state.isMac && /^codec_name=(h264|hevc)$/m.test(facts.stdout))
  // Frames stay within PX_MAX in every Picture size (see sharpen).
  const cut = Math.min(PX_MAX, cutAt ?? frameWidth(field('width'), field('height'), state.termSize, state.cell))
  const own = field('width') > 0 && field('height') > 0 ? { sourceWidth: field('width'), sourceHeight: field('height') } : {}
  // A clip is cut once per width: a bigger window cuts it again, bigger.
  const raw = usesRaw()
  const folder = key && `v-${keyOf(`${key}|${cut}${state.sendBytes ? '|bytes' : ''}${raw ? '|raw' : ''}`)}`
  // The same file shown before: its folder, frames and size are already there.
  if (folder) {
    const dir = `${state.TMP}/${folder}`
    const meta = (await readMeta($, dir)) as { frames: Omit<Frames, 'dir'>; width: number; height: number } | null
    if (meta) {
      const frames = { ...meta.frames, dir }
      await $.process.run(['touch', dir]).catch(() => undefined)
      await learn($, dir)
      if (!disk(dir).has(0)) await until($, dir, 0, ensure($, frames, real, 0, false))
      return { kind: 'video', path: frameFile(frames, 0), source: real, width: meta.width, height: meta.height, ...own, title, generation: ++state.generation, frames }
    }
  }
  // Some recordings (MediaRecorder webm) carry no duration: sample those at the
  // top rate. The clip's length is then what the frames cover.
  const probed = field('duration')
  const fps = sampleRate(Number.isFinite(probed) && probed > 0 ? probed : 1)
  state.generation += 1
  const dir = folder ? `${state.TMP}/${folder}` : `${state.TMP}/v${state.generation}-${Math.floor(await $.clock.now())}`
  await $.process.run(['mkdir', '-p', dir])
  // The blank-opening skip is off: every clip plays from its start (see
  // leadFrom, and known-issues.md for how it would be turned on).
  const lead = 0
  const known = Number.isFinite(probed) && probed > 0
  // A clip of known length is decoded as it plays (see decode); one without
  // (MediaRecorder webm) is cut whole, as before.
  const total = known ? Math.max(1, Math.min(MAX_STREAMED, Math.floor((probed - lead) * fps))) : 0
  const ext = raw ? 'rgb' : 'png'
  let count: number
  if (known) {
    // The first second is decoded straight away; the clip shows as soon as
    // its first frame is there (0.7 s for 1080p camera footage).
    const d = decode($, { dir, count: total, fps, lead, ext, scale: scaleFor(cut, false) }, real, 0, false)
    await until($, dir, 0, d, 60000)
    if (!disk(dir).has(0)) throw new Error(`ffmpeg could not read ${real}: ${d.error}`)
    count = total
  } else {
    const framesIn = async () => (await $.fs.list(dir)).filter(f => f.name.endsWith(`.${ext}`)).map(f => `${dir}/${f.name}`)
    const made = await cutFrames($, isFew => [
      state.ffmpeg, '-v', 'error', ...decodeFlags(real), ...(lead ? ['-ss', String(lead)] : []), '-i', real,
      ...frameOut(raw, `fps=${fps},${scaleFor(cut, isFew)}`), '-frames:v', String(MAX_FRAMES), '-y', `${dir}/f%05d.${ext}`,
    ], framesIn)
    if (made.exitCode !== 0) throw new Error(`ffmpeg could not read ${real}: ${made.stderr.trim().slice(0, 200)}`)
    count = (await framesIn()).length
    if (!count) throw new Error(`no frames in ${real}`)
    await learn($, dir)
  }
  const size = raw ? await rawSize($, `${dir}/f00001.rgb`, cut) : await pngSize($, `${dir}/f00001.png`)
  const frames: Frames = { dir, count, fps, duration: count / fps, cut, ...(lead ? { lead } : {}), ...(raw ? { raw: size } : {}) }
  const poster = frameFile(frames, 0)
  if (folder) await writeMeta($, dir, { frames: { count, fps, duration: frames.duration, cut, ...(lead ? { lead } : {}), ...(raw ? { raw: size } : {}) }, ...size })
  void trimFrames($)
  return { kind: 'video', path: poster, source: real, ...size, ...own, title, generation: state.generation, frames }
}

// The same clip at another width, for a resized window. Its facts (rate,
// length, lead-in) are already known, so only the chunk on screen is cut
// (about 0.3 s) instead of preparing the clip again from its start, which
// took seconds and cut the wrong part first. The folder is the one
// prepareVideo would use for that width, so either finds the other's frames.
export async function rescaleVideo($: EngineInterface, m: Shown, width: number, at: number): Promise<Shown | null> {
  const f = m.frames
  const source = m.source
  if (!f || !source) return null
  const key = await identityOf($, source)
  const raw = usesRaw()
  const dir = `${state.TMP}/v-${keyOf(`${key}|${width}${state.sendBytes ? '|bytes' : ''}${raw ? '|raw' : ''}`)}`
  // The new size keeps the frames' aspect (after any rotation), even rows.
  const frames: Frames = { ...f, dir, cut: width, raw: raw && m.width > 0 ? { width, height: Math.max(2, Math.round((width * m.height) / m.width / 2) * 2) } : undefined }
  const i = Math.max(0, Math.min(at, f.count - 1))
  await $.process.run(['mkdir', '-p', dir])
  await learn($, dir)
  if (!disk(dir).has(i)) await until($, dir, i, ensure($, frames, source, i, false))
  const shown = frameFile(frames, i)
  if (await isGone($, shown)) return null
  const size = frames.raw ?? (await pngSize($, shown))
  await writeMeta($, dir, { frames: { count: f.count, fps: f.fps, duration: f.duration, cut: width, ...(f.lead ? { lead: f.lead } : {}), ...(frames.raw ? { raw: frames.raw } : {}) }, ...size })
  void trimFrames($)
  return { ...m, path: shown, ...size, generation: ++state.generation, frames }
}

// ── Frames as a clip plays ───────────────────────────────────────────────
//
// One ffmpeg per frames folder decodes the clip straight through from where
// it's needed. Cutting it two seconds at a time started a process per chunk
// and decoded each chunk again from the keyframe before it (3 s apart in
// camera footage): most of the work was thrown away.
//
// While a clip plays, its decoder reads at the clip's own pace (-readrate 1)
// with a head start, so it stays about AHEAD_SECONDS ahead instead
// of racing to the end; on a busy machine it reads as fast as it can. A clip
// shown but not playing gets AHEAD_SECONDS from where it is, then its decoder
// ends. A play that stops (no frame asked for in PLAY_IDLE_MS) ends its
// decoder; the frames it made stay. A frame asked for outside what the
// decoder covers (a seek, a scrub, a skip) starts a new one there.
//
// The clip in use keeps BEHIND_SECONDS behind the playhead, so « 3s and a
// scrub back land on frames that are there: they were decoded on the way past
// and cost only disk. Every other clip keeps only the frame it shows, and
// every clip its poster. Nothing is ever paused with SIGSTOP: a stopped
// ffmpeg could outlive Claude Code holding its memory.
// Both skips land on frames already there: « 3s behind, 3s » ahead.
export const AHEAD_SECONDS = 3
export const BEHIND_SECONDS = 3
// The skip buttons: « 3s and 3s ».
export const SKIP_SECONDS = 3
const PLAY_IDLE_MS = 1000
// ffmpeg's first frame from a new place: 0.7 to 1.5 s for 1080p camera
// footage (start-up, then the stretch from the keyframe before it). A clip
// shown decodes AHEAD_SECONDS, so on Play its decoder has that long to start
// before the frames on disk run out, and each decoder's head start is sized
// to settle about AHEAD_SECONDS ahead once its first frame is out.
const START_SECONDS = 1.5
export const aheadOf = (fps: number) => Math.max(2, Math.round(AHEAD_SECONDS * fps))
const behindOf = (fps: number) => Math.round(BEHIND_SECONDS * fps)
// Default threads: real footage is heavy (a 72 Mbit/s 1080p H.264 export took
// 4.9 s per 2 s on one thread, #14). The side-by-side merge uses one thread.
const ONE_THREAD = ['-threads', '1', '-filter_threads', '1']
export function exists($: EngineInterface, file: string) {
  return $.fs.stat(file).then(() => true, () => false)
}
// Gone only when the disk says so; no answer at all (no fs here) is not gone.
export function isGone($: EngineInterface, file: string) {
  return $.fs.stat(file).then(() => false, (e: unknown) => /ENOENT|not found|no such file/i.test(String((e as Error)?.message ?? e)))
}

// A terminal that refuses a picture file draws an empty box, and nothing comes
// back to say so. Ghostty and kitty read any file up to 400 MB (checked in
// their source), inside tmux too, and so does Rex (measured with a=t,t=f:
// any folder, 120 MB read, 300 MB refused with ENOMEM, 10,000 px at most;
// its a=q query alone refuses any real file with EINVAL, so don't probe with
// it). Others may not: Orca reads one only from a
// temp folder or the terminal's own worktree, and only up to 2 MiB (#16).
// Elsewhere a still is drawn from a temp-folder copy under 2 MB (pngSource),
// and a folder with a frame over it is decoded in 256 colours from there on.
const READS_ANY_FILE = new Set(['ghostty', 'kitty', 'rex'])
export const readsAnyFile = () => READS_ANY_FILE.has(state.terminalName) || READS_ANY_FILE.has(state.outerTerminal)
export const BYTES_MAX = 2_000_000
// Over ssh every frame crosses as bytes: 256 colours, no dithering, halve
// them. A palette per frame, so frames stream out as they're decoded (one
// for the whole clip would wait for its end). Frames on this machine go by
// path in full colour.
const PALETTE = ',split[a][b];[a]palettegen=stats_mode=single[p];[b][p]paletteuse=new=1:dither=none'
const scaleFor = (cut: number | undefined, isFew: boolean) => (cut ? `scale=${cut}:-2` : "scale='min(1600,iw)':-2") + (isFew ? PALETTE : '')
const fewColours = new Set<string>()
// H.264 and HEVC decode on the Mac's media engine: the same frames, and it
// leaves the CPU free, which matters when the machine is busy (a render
// running: 0.37x real time against 0.28x for a 60 Mbit/s 1080p clip). Not
// for other codecs: AV1 fails outright on Macs without its decoder instead of
// falling back. A decoder that fails with it runs again without it.
const hwDecode = new Map<string, boolean>()
const decodeFlags = (source: string) => (hwDecode.get(source) ? ['-hwaccel', 'videotoolbox'] : [])
const withoutHw = (argv: string[]) => argv.filter((a, k) => a !== '-hwaccel' && argv[k - 1] !== '-hwaccel')
// ffmpeg before 7.1 has no -readrate_catchup (6.1 no initial burst): there,
// a playing clip is decoded a few seconds at a time instead.
let canPace = true

// A whole clip in one go (one with no known length). Outside Ghostty and
// kitty, a frame over BYTES_MAX may not draw, so a clip with one is cut again
// in 256 colours.
async function cutFrames($: EngineInterface, cut: (isFew: boolean) => string[], files: () => Promise<string[]>) {
  let made = await $.process.run(cut(state.sendBytes))
  if (made.exitCode !== 0 && cut(state.sendBytes).includes('-hwaccel')) {
    debug(`hw decode failed, cut again without it: ${made.stderr.trim().slice(0, 80)}`)
    const plain = cut
    cut = isFew => withoutHw(plain(isFew))
    made = await $.process.run(cut(state.sendBytes))
  }
  if (made.exitCode !== 0 || state.sendBytes || readsAnyFile()) return made
  const sizes = await Promise.all((await files()).map(f => Promise.resolve().then(() => $.fs.stat(f)).then(st => st.size, () => 0)))
  if (!sizes.some(size => size > BYTES_MAX)) return made
  debug('cut again in 256 colours: a frame is over 2 MB')
  return $.process.run(cut(true))
}

// The frames each folder holds, as far as this session knows: what its
// decoders wrote, and what was there when the folder was first used. Only a
// hint: a frame found gone is decoded again (recutFrame).
const onDisk = new Map<string, Set<number>>()
function disk(dir: string) {
  let s = onDisk.get(dir)
  if (!s) onDisk.set(dir, (s = new Set()))
  return s
}
const learnt = new Map<string, Promise<void>>()
function learn($: EngineInterface, dir: string) {
  let job = learnt.get(dir)
  if (!job) {
    job = $.fs.list(dir).then(files => {
      for (const { name } of files) {
        const m = /^f(\d+)\.(png|rgb)$/.exec(name)
        if (m) disk(dir).add(Number(m[1]) - 1)
      }
    }, () => undefined)
    learnt.set(dir, job)
  }
  return job
}
const clampFrame = (f: Frames, i: number) => Math.max(0, Math.min(i, f.count - 1))
export const isFrameCut = (media: Shown, i: number) => !media.frames || disk(media.frames.dir).has(clampFrame(media.frames, i))
// Every frame from `from` to `to` is on disk: frames left from an earlier
// play can sit past a gap, so one frame ahead says nothing about those before it.
export const isRunCut = (media: Shown, from: number, to: number) => !media.frames || firstMissing(media.frames, clampFrame(media.frames, from)) > clampFrame(media.frames, to)
function firstMissing(f: Frames, i: number) {
  const s = disk(f.dir)
  let k = i
  while (k < f.count && s.has(k)) k++
  return k
}
// Whoever waits on a folder's frames looks again when one lands.
const wakers = new Map<string, Set<() => void>>()
function wake(dir: string) {
  for (const w of [...(wakers.get(dir) ?? [])]) w()
}

// What a decoder writes: the folder, the clip's timing, the file type and
// the scale filter (exact for raw frames, keep-the-aspect for the first).
type Spec = { dir: string; count: number; fps: number; lead?: number; ext: 'rgb' | 'png'; scale: string; gpuScale?: string }
const specOf = (f: Frames): Spec => ({
  dir: f.dir, count: f.count, fps: f.fps, lead: f.lead, ext: f.raw ? 'rgb' : 'png', scale: f.raw ? `scale=${f.raw.width}:${f.raw.height}` : scaleFor(f.cut, false),
  // Scaled where it was decoded, on the media engine: 23% less CPU for 1080p
  // camera footage (12 s: 2.65 s against 3.43 s). 10-bit HEVC comes down as p010.
  ...(f.raw ? { gpuScale: `scale_vt=w=${f.raw.width}:h=${f.raw.height},hwdownload,format=nv12|p010le` } : {}),
})
const fileOf = (s: Spec, i: number) => `${s.dir}/f${String(i + 1).padStart(5, '0')}.${s.ext}`

type Decoder = {
  // Frames [from, end) are its; every frame before `reached` is on disk.
  from: number
  end: number
  reached: number
  isPlay: boolean
  startedAt: number
  // When its first frame landed (0 before): ffmpeg's start alone takes
  // seconds on a busy machine, so idling and chasing count from here.
  goingAt: number
  wantedAt: number
  isOver: boolean
  // Stopped from outside (a newer decoder, another clip used).
  isCancelled: boolean
  error: string
  stop: () => void
  // A clip shown, then played while its first second was decoding: the
  // playing decoder starts where this one ends.
  thenPlay?: () => void
}
const decoders = new Map<string, Decoder>()
// The furthest frame a finished decoder made in a folder, until the next one
// starts: those frames are still ahead of the playhead, so pruning them would
// only make them decode again (seconds on a busy machine).
const finishedAt = new Map<string, number>()

// `buffered`: seconds already on disk ahead of the playhead, taken off the
// head start (see START_SECONDS).
function decode($: EngineInterface, s: Spec, source: string, from: number, isPlay: boolean, buffered = 0): Decoder {
  decoders.get(s.dir)?.stop()
  finishedAt.delete(s.dir)
  const ahead = aheadOf(s.fps)
  const end = Math.min(s.count, from + (isPlay ? (canPace ? s.count : ahead * 2) : ahead))
  const d: Decoder = { from, end, reached: from, isPlay, startedAt: Date.now(), goingAt: 0, wantedAt: Date.now(), isOver: false, isCancelled: false, error: '', stop: () => { d.isOver = d.isCancelled = true } }
  decoders.set(s.dir, d)
  debug(`decode from=${from} to=${end} play=${isPlay}`)
  const argv = (hw: boolean, isFew: boolean, pace: boolean, at: number) => [
    state.ffmpeg, '-v', 'error', '-nostdin', ...(hw ? decodeFlags(source) : []), ...(hw && s.gpuScale ? ['-hwaccel_output_format', 'videotoolbox_vld'] : []),
    // The clip's own pace with a second's start. Catching up at 4x covers
    // the stretch from the keyframe before `at`: without it the first frame
    // took 1.8 s instead of 0.7 s and the decoder ran behind from there.
    ...(isPlay && pace ? ['-readrate', '1', '-readrate_initial_burst', String(+Math.max(0, AHEAD_SECONDS + START_SECONDS - buffered).toFixed(2)), '-readrate_catchup', '4'] : []),
    '-ss', String(+((s.lead ?? 0) + at / s.fps).toFixed(3)), '-i', source,
    ...frameOut(s.ext === 'rgb', `fps=${s.fps},${hw && s.gpuScale ? s.gpuScale : s.scale}${isFew && s.ext === 'png' ? PALETTE : ''}`),
    '-frames:v', String(d.end - at), '-start_number', String(at + 1),
    '-progress', 'pipe:1', '-stats_period', '0.1', '-y', `${s.dir}/f%05d.${s.ext}`,
  ]
  // What the latest progress line says is written, checked on disk: frames
  // land in order, so the newest one there means all before it are too.
  const see = async (made: number, isFew: boolean) => {
    const st = await $.fs.stat(fileOf(s, made - 1)).catch(() => null)
    if (!st) return 'wait'
    if (!d.goingAt) {
      debug(`decode first=${d.from} ms=${Date.now() - d.startedAt}`)
      d.goingAt = d.wantedAt = Date.now()
    }
    for (let k = d.reached; k < made; k++) disk(s.dir).add(k)
    d.reached = made
    wake(s.dir)
    if (s.ext === 'png' && !isFew && !state.sendBytes && !readsAnyFile() && st.size > BYTES_MAX) return 'too_big'
    return 'ok'
  }
  void (async () => {
    let hw = decodeFlags(source).length > 0
    let isFew = state.sendBytes || fewColours.has(s.dir)
    try {
      for (let tries = 0; tries < 4 && !d.isOver && d.reached < d.end; tries++) {
        const at = d.reached
        const stream = $.process.spawn({ argv: argv(hw, isFew, canPace, at) })
        d.stop = () => {
          d.isOver = d.isCancelled = true
          void stream.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
        }
        let isTooBig = false
        let err = ''
        try {
          for await (const chunk of stream) {
            if (d.isOver) break
            if (chunk.stream === 'stderr') {
              err += chunk.text
              continue
            }
            const m = [...chunk.text.matchAll(/frame=(\d+)/g)].pop()
            if (m && at + Number(m[1]) > d.reached && (await see(at + Number(m[1]), isFew)) === 'too_big') {
              isTooBig = true
              break
            }
            // A player waiting on a frame asks nothing more meanwhile: never idle then.
            if (d.isPlay && Date.now() - d.wantedAt > PLAY_IDLE_MS && !wakers.get(s.dir)?.size) {
              debug(`decode idle dir=${s.dir.split('/').pop()} at=${d.reached}`)
              d.isOver = true
              break
            }
          }
        } catch (e) {
          err += String(e)
        }
        if (d.isOver) break
        const res = await stream.result.catch(() => null)
        if (isTooBig) {
          debug('decode again in 256 colours: a frame is over 2 MB')
          fewColours.add(s.dir)
          isFew = true
          continue
        }
        if (res?.code === 0) {
          // The last progress line can come before the last file lands.
          if (d.reached < d.end) await see(d.end, isFew)
          break
        }
        d.error = err.trim().slice(0, 200)
        if (/readrate/i.test(err) && canPace) {
          debug('no -readrate_catchup: decoding a few seconds at a time')
          canPace = false
          d.end = Math.min(d.end, d.reached + aheadOf(s.fps) * 2)
          continue
        }
        if (hw) {
          debug(`hw decode failed (code=${res?.code} signal=${res?.signal} at=${d.reached}), decode again without it: ${d.error.slice(0, 80)}`)
          hw = false
          continue
        }
        break
      }
    } finally {
      d.isOver = true
      if (decoders.get(s.dir) === d) {
        decoders.delete(s.dir)
        if (!d.isCancelled) finishedAt.set(s.dir, d.reached)
      }
      wake(s.dir)
      if (!d.isCancelled) d.thenPlay?.()
    }
  })()
  return d
}

// Starts a decoder for frame `i` when it isn't on disk or, while playing,
// when what's on disk ahead of it runs short. The one running is kept while
// it covers `i`.
// `isChase`: the playhead's clock asking, ahead of a decoder that runs slow
// (a busy machine); a decoder is then started afresh there only once it's
// had CHASE_MS since its first frame, so a slow one isn't restarted on every tick and never gets
// going. A seek or a skip starts afresh at once.
const CHASE_MS = 2000
// A decoder with no frame yet is waited for this long before a chase restarts it.
const START_LIMIT_MS = 10000
function ensure($: EngineInterface, f: Frames, source: string | undefined, i: number, isPlay: boolean, isChase = false): Decoder | undefined {
  i = clampFrame(f, i)
  const ahead = aheadOf(f.fps)
  // Where the frames on disk from `i` run out: what a decoder has to make.
  const start = firstMissing(f, i)
  const d = decoders.get(f.dir)
  if (d && !d.isOver) {
    if (isPlay) d.wantedAt = Date.now()
    // It gets there soon enough: within a second of where it has got to.
    const isNear = start >= d.from && start <= d.end && start <= d.reached + f.fps
    const isPatient = isChase && start >= d.from && (d.goingAt ? Date.now() - d.goingAt < CHASE_MS : Date.now() - d.startedAt < START_LIMIT_MS)
    if ((isNear || isPatient) && (d.isPlay || !isPlay)) return d
    if (isNear) {
      d.thenPlay = () => void ensure($, f, source, d.reached, true)
      return d
    }
  }
  if (!source) return undefined
  // Playing: started as soon as the play does (AHEAD_SECONDS on disk at
  // most), so its first frame lands before the frames on disk run out.
  if (start >= f.count || start - i > (isPlay ? ahead : 0)) return undefined
  return decode($, specOf(f), source, start, isPlay, (start - i) / f.fps)
}

// Resolves once frame `i` is on disk, or once nothing will put it there.
function until($: EngineInterface, dir: string, i: number, d: Decoder | undefined, limitMs = 20000): Promise<void> {
  return new Promise<void>(resolve => {
    let set = wakers.get(dir)
    if (!set) wakers.set(dir, (set = new Set()))
    const done = () => {
      set.delete(check)
      resolve()
    }
    const check = () => {
      if (disk(dir).has(i) || !d || d.isOver) done()
    }
    set.add(check)
    check()
    void $.clock.sleep(limitMs).then(done, done)
  })
}

// A frame that should be on disk isn't (the temp folder was cleaned, or the
// cache trimmed): forget it and decode it again from the source. False when
// the source itself is gone too.
export async function recutFrame($: EngineInterface, media: Shown, i: number): Promise<boolean> {
  const f = media.frames
  if (!f || !media.source || (await isGone($, media.source))) return false
  i = clampFrame(f, i)
  // There after all (a draw that looked while the frame was being written):
  // stopping the decoder for it would only stall playback.
  if (!(await isGone($, frameFile(f, i)))) return true
  await $.process.run(['mkdir', '-p', f.dir]).catch(() => undefined)
  disk(f.dir).delete(i)
  decoders.get(f.dir)?.stop()
  await until($, f.dir, i, ensure($, f, media.source, i, false))
  return !(await isGone($, frameFile(f, i)))
}

// Where each player is in each frames folder, and whether it's the one the
// person is using (playing, or last played, paused or scrubbed).
type Watcher = { frame: number; isPlaying: boolean }
const watching = new Map<string, Map<string, Watcher>>()
function watch(dir: string, site: string, i: number, isPlaying: boolean) {
  let at = watching.get(dir)
  if (!at) watching.set(dir, (at = new Map()))
  at.set(site, { frame: i, isPlaying })
}
// The clip in use keeps BEHIND_SECONDS behind its playhead and whatever is
// decoded ahead of it (`decoded`: the end of its decoder's range, or where a finished one got to); others keep
// only the frame they show, and every clip its poster.
export function isKept(i: number, watchers: readonly { frame: number; isPlaying: boolean }[], fps: number, decoded = 0) {
  return i === 0 || watchers.some(v => (v.isPlaying ? i >= v.frame - behindOf(fps) && i <= Math.max(v.frame + aheadOf(fps), decoded) : i === v.frame))
}

// Deletes the frames no player in the folder keeps, at most once a second.
const prunedAt = new Map<string, number>()
function prune($: EngineInterface, dir: string, fps: number) {
  const now = Date.now()
  if (now - (prunedAt.get(dir) ?? 0) < 1000) return
  prunedAt.set(dir, now)
  void (async () => {
    const watchers = [...(watching.get(dir)?.values() ?? [])]
    // Not drawn by any player yet (a clip being prepared): keep what's made.
    if (!watchers.length) return
    const d = decoders.get(dir)
    // A running decoder's whole range: its progress lags the files it has
    // written, and deleting those left holes that restarted it.
    const decoded = d && !d.isOver ? d.end : (finishedAt.get(dir) ?? 0)
    const files = await $.fs.list(dir).catch(() => [])
    const gone: string[] = []
    for (const { name } of files) {
      const m = /^f(\d+)\.(png|rgb)$/.exec(name)
      if (!m) continue
      const i = Number(m[1]) - 1
      if (isKept(i, watchers, fps, decoded)) continue
      gone.push(`${dir}/${name}`)
      disk(dir).delete(i)
    }
    if (gone.length) await $.process.run(['rm', '-f', ...gone]).catch(() => undefined)
  })()
}

// The clip in use changed: every other one keeps only the frame it shows,
// and stops decoding.
let inUse = ''
function use($: EngineInterface, site: string) {
  if (inUse === site) return
  inUse = site
  for (const [dir, at] of watching) {
    if (at.has(site)) continue
    for (const w of at.values()) w.isPlaying = false
    decoders.get(dir)?.stop()
    prunedAt.delete(dir)
    prune($, dir, fpsOf.get(dir) ?? 12)
  }
}
const fpsOf = new Map<string, number>()

// The frame a side shows, decoded if it has to be. `isUsed`: the person is
// using this clip (playing, paused on it, scrubbing), so it keeps its window.
// `isPlay`: it's playing, so its decoder runs on ahead of the playhead.
// `isChase`: the play clock asking (see ensure).
export async function frameReady($: EngineInterface, media: Shown, i: number, site?: string, isUsed = false, isPlay = false, isChase = false): Promise<void> {
  const f = media.frames
  if (!f) return
  fpsOf.set(f.dir, f.fps)
  i = clampFrame(f, i)
  if (site) {
    // A clip just shown is the one about to be watched: it takes the window.
    const isNew = !watching.get(f.dir)?.has(site)
    watch(f.dir, site, i, isUsed || isNew || inUse === site)
    if (isUsed || isNew) use($, site)
  }
  await learn($, f.dir)
  // On disk but not known (made by another session since): not decoded again.
  if (!disk(f.dir).has(i) && (await exists($, frameFile(f, i)))) disk(f.dir).add(i)
  const d = ensure($, f, media.source, i, isPlay, isChase)
  if (site) prune($, f.dir, f.fps)
  if (disk(f.dir).has(i)) return
  await until($, f.dir, i, d)
}

// Moments both runs share (a check by the same name), as [updated, original]
// seconds, kept only while both clocks move forward.
export function anchors(updated: Check[] = [], original: Check[] = []): [number, number][] {
  const at = new Map(original.filter(c => c.at !== undefined).map(c => [c.name, c.at!]))
  const pairs = updated
    .filter(c => c.at !== undefined && at.has(c.name))
    .map(c => [c.at!, at.get(c.name)!] as [number, number])
    .sort((a, b) => a[0] - b[0])
  const kept: [number, number][] = []
  for (const p of pairs) {
    const last = kept.at(-1) ?? [0, 0]
    if (p[0] > last[0] + 0.05 && p[1] > last[1] + 0.05) kept.push(p)
  }

  return kept
}

// The original clip's moment that matches a moment of the updated clip.
export function mapTime(points: [number, number][], t: number, endA: number, endB: number): number {
  const all: [number, number][] = [[0, 0], ...points, [endA, endB]]
  for (let i = 1; i < all.length; i++) {
    const [a0, b0] = all[i - 1]!
    const [a1, b1] = all[i]!
    if (t <= a1 || i === all.length - 1) {
      const k = a1 > a0 ? (b1 - b0) / (a1 - a0) : 1
      return Math.max(0, Math.min(endB, b0 + (t - a0) * k))
    }
  }

  return t
}

// Maps a frame of one clip to the frame at the same moment in another.
export function sameMoment(from: Frames | undefined, to: Frames | undefined, frame: number): number {
  if (!from || !to) return 0

  return Math.max(0, Math.min(to.count - 1, Math.round((frame / from.fps) * to.fps)))
}

// The same moment on the other clip: updated → original seconds, and back.
export const toOriginal = (shown: Shown, t: number) =>
  shown.frames && shown.compare?.frames
    ? mapTime(shown.sync ?? anchors(shown.checks, shown.compare.checks), t, shown.frames.duration, shown.compare.frames.duration)
    : t
export const toUpdated = (shown: Shown, t: number) =>
  shown.frames && shown.compare?.frames
    ? mapTime((shown.sync ?? anchors(shown.checks, shown.compare.checks)).map(([a, b]) => [b, a] as [number, number]), t, shown.compare.frames.duration, shown.frames.duration)
    : t

// The compared side's frame at the moment the shown side is at.
export const compareFrame = (shown: Shown, frame: number) => {
  const a = shown.frames, b = shown.compare?.frames
  if (!a || !b) return 0
  const t = mapTime(shown.sync ?? anchors(shown.checks, shown.compare?.checks), frame / a.fps, a.duration, b.duration)
  return Math.max(0, Math.min(b.count - 1, Math.round(t * b.fps)))
}

// Every `stride`-th frame as a 32×18 grey thumbnail, for matching the two
// runs by eye. Small and sparse on purpose: matching costs frames × frames.
async function thumbs($: EngineInterface, media: Shown, stride: number): Promise<number[][]> {
  const f = media.frames!
  const r = await $.process.run([
    'sh', '-c',
    `"$0" -v error ${f.lead ? `-ss ${f.lead} ` : ''}-i "$1" -vf "fps=${f.fps},select=not(mod(n\\,${stride})),scale=32:18,format=gray" -fps_mode passthrough -frames:v ${Math.ceil(f.count / stride)} -f rawvideo - | od -An -tu1 -v`,
    state.ffmpeg, media.source ?? '',
  ])
  const px = r.stdout.trim().split(/\s+/).map(Number)
  const out: number[][] = []
  for (let i = 0; i + 576 <= px.length; i += 576) out.push(px.slice(i, i + 576))
  return out
}

// How many frames apart to sample so neither run has more than 240.
export const strideFor = (a: number, b: number) => Math.max(1, Math.ceil(Math.max(a, b) / 240))

// A match made on sampled frames, spread back over every updated frame.
export function spreadMatch(sampled: number[], stride: number, count: number, last: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    const k = Math.min(sampled.length - 1, Math.floor(i / stride))
    return Math.min(last, (sampled[k] ?? 0) * stride + (i % stride))
  })
}

// What moved since the previous frame: the cursor, a fade, a scroll. The two
// runs move the same way even where the designs differ.
const motion = (f: number[][]) => f.map((px, i) => (i ? px.map((v, k) => v - f[i - 1]![k]!) : px.map(() => 0)))

// The cheapest way to walk both runs in order, frame by frame (dynamic time
// warping), matching how frames look and how they move: [updated, original]
// frame pairs. Holding one side still costs a little, so it only holds where
// the runs really differ. Within `band` samples of the same moment only, and
// straying from it costs `drift`: two runs of the same steps keep time, so a
// screen that looks different in one (an error the other never shows) can't
// pull one side ahead of the other.
export function align(a: number[][], b: number[][], hold = 0.01, band = Number.POSITIVE_INFINITY, drift = 0): [number, number][] {
  const n = a.length, m = b.length
  if (!n || !m) return []
  const slope = n > 1 ? (m - 1) / (n - 1) : 0
  // Typed rows: the inner loop runs n × m × pixels times.
  const ta = a.map(x => Int16Array.from(x)), tb = b.map(x => Int16Array.from(x))
  const ma = motion(a).map(x => Int16Array.from(x)), mb = motion(b).map(x => Int16Array.from(x))
  const diff = (i: number, j: number) => {
    let d = 0, e = 0
    const pa = ta[i]!, pb = tb[j]!, qa = ma[i]!, qb = mb[j]!
    for (let k = 0; k < pa.length; k++) {
      const x = pa[k]! - pb[k]!, y = qa[k]! - qb[k]!
      d += x < 0 ? -x : x
      e += y < 0 ? -y : y
    }
    return (d + 4 * e) / (pa.length * 255)
  }
  const cost = new Float64Array(n * m)
  const step = new Uint8Array(n * m) // 0 both, 1 updated only, 2 original only
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const off = Math.abs(j - i * slope)
      if (off > band && !(i === n - 1 && j === m - 1) && (i || j)) { cost[i * m + j] = Number.POSITIVE_INFINITY; step[i * m + j] = 0; continue }
      const d = diff(i, j) + drift * off
      if (!i && !j) { cost[0] = d; continue }
      const both = i && j ? cost[(i - 1) * m + j - 1]! : Number.POSITIVE_INFINITY
      const up = i ? cost[(i - 1) * m + j]! + hold : Number.POSITIVE_INFINITY
      const left = j ? cost[i * m + j - 1]! + hold : Number.POSITIVE_INFINITY
      const best = Math.min(both, up, left)
      cost[i * m + j] = best + d
      step[i * m + j] = best === both ? 0 : best === up ? 1 : 2
    }
  }
  const path: [number, number][] = []
  for (let i = n - 1, j = m - 1; ; ) {
    path.push([i, j])
    if (!i && !j) break
    const s = step[i * m + j]
    if (s === 0) { i--; j-- } else if (s === 1) i--
    else j--
  }
  return path.reverse()
}

// For each updated frame, the original frame shown beside it.
export function matchOf(path: [number, number][], count: number): number[] {
  const out = new Array<number>(count).fill(0)
  for (const [i, j] of path) if (i < count) out[i] = j
  for (let i = 1; i < count; i++) out[i] = Math.max(out[i]!, out[i - 1]!)
  return out
}

// The path cut to the few turns that matter, in seconds, to keep it small.
export function turns(match: number[], fpsA: number, fpsB: number): [number, number][] {
  const points: [number, number][] = []
  for (let i = 1; i < match.length - 1; i++) {
    const before = match[i]! - match[i - 1]!, after = match[i + 1]! - match[i]!
    if ((before === 0) !== (after === 0) || Math.abs(before - after) > 1) points.push([+(i / fpsA).toFixed(2), +(match[i]! / fpsB).toFixed(2)])
  }
  return points.length > 40 ? points.filter((_, k) => k % Math.ceil(points.length / 40) === 0) : points
}

// The largest still kept whole.
export const MAX_STILL = 3200

// Pixels between Original and Updated in the merged clip.
export const PAIR_GAP = 40
// How tall the merged clip is cut: the shorter side's height, 720 px at most.
// The terminal never draws a picture larger than it is, so 360 px kept the
// side by side view small in any window.
export const pairHeightOf = (updated: { height: number }, original: { height: number }) =>
  Math.max(2, Math.floor(Math.min(720, updated.height || 720, original.height || 720) / 2) * 2)

// Merges the original and updated recordings into one clip, side by side.
// The original's frames are matched to the updated clip's by how they look,
// so every step happens at the same moment on both sides.
export async function preparePair($: EngineInterface, original: Shown, updated: Shown) {
  const f = updated.frames!, g = original.frames!
  state.generation += 1
  const height = pairHeightOf(updated, original)
  // p2: pairs made before the time-first matching are never reused.
  const dir = `${state.TMP}/p2-${keyOf(`${f.dir}|${g.dir}|${height}`)}`
  type PairMeta = { pair: Omit<Frames, 'dir'>; pairWidth: number; pairHeight: number; sync: [number, number][] }
  const known = (await readMeta($, dir)) as PairMeta | null
  if (known) {
    const pair = { ...known.pair, dir }
    await $.process.run(['touch', dir]).catch(() => undefined)
    await pairReady($, { ...updated, compare: original, pair, sync: known.sync }, 0)
    return { pair, pairWidth: known.pairWidth, pairHeight: known.pairHeight, sync: known.sync }
  }
  // Two runs of the same steps take about as long: then the same moment on
  // both sides is the same second (moved to the checks' own moments when
  // they're given). Only runs that differ a lot are matched by how they look.
  const byTime = () => Array.from({ length: f.count }, (_, i) => Math.min(g.count - 1, Math.round(mapTime(anchors(updated.checks, original.checks), i / f.fps, f.duration, g.duration) * g.fps)))
  const isSamePace = Math.abs(f.duration - g.duration) <= 0.15 * Math.max(f.duration, g.duration)
  const stride = strideFor(f.count, g.count)
  const [ta, tb] = isSamePace ? [[], []] : await Promise.all([thumbs($, updated, stride), thumbs($, original, stride)])
  const match = ta.length && tb.length
    ? spreadMatch(matchOf(align(ta, tb, 0.01, Math.max(2, Math.round((0.6 * f.fps) / stride)), 0.02), ta.length), stride, f.count, g.count - 1)
    : byTime()
  await $.process.run(['mkdir', '-p', dir])
  // Each side scaled to the merged height, at an even width. The merged
  // frames are PNGs (two clips, rarely played: simpler than raw for little
  // cost), made from the sides' frames, raw or not.
  const width = sideWidth(original, height) + PAIR_GAP + sideWidth(updated, height)
  const pair: Frames = { dir, count: f.count, fps: f.fps, duration: f.duration }
  const sync = turns(match, f.fps, g.fps)
  await pairReady($, { ...updated, compare: original, pair, sync }, 0)
  if (!(await exists($, frameFile(pair, 0)))) return null
  const made = { pair, pairWidth: width, pairHeight: height, sync }
  await writeMeta($, dir, { ...made, pair: { count: pair.count, fps: pair.fps, duration: pair.duration } })

  return made
}
const sideWidth = (side: Shown, height: number) => Math.max(2, Math.round((side.width * height) / Math.max(1, side.height) / 2) * 2)

// Merged frames from the first one missing at `i`, up to a second of them,
// PNGs made from the two sides' frames (decoded as the clip plays). One merge at a
// time per pair; a frame both sides don't have yet waits for them.
const merging = new Map<string, Promise<void>>()
function merge($: EngineInterface, shown: Shown, i: number, isPlay: boolean): Promise<void> {
  const pair = shown.pair!, original = shown.compare!
  const running = merging.get(pair.dir)
  if (running) return running
  const f = shown.frames!, g = original.frames!
  const jOf = (k: number) => clampFrame(g, compareFrame(shown, k))
  const job = (async () => {
    const first = firstMissing(pair, i)
    // A second a merge, so the first merged frame lands soon.
    const want = Math.min(pair.count, i + aheadOf(pair.fps), firstMissing(pair, i) + Math.round(pair.fps))
    if (first >= want) return
    await Promise.all([learn($, f.dir), learn($, g.dir)])
    // On disk but not known (made by another session since): not decoded again.
    await Promise.all([[f, first], [g, jOf(first)]].map(async ([side, k]) => {
      if (!disk((side as Frames).dir).has(k as number) && (await exists($, frameFile(side as Frames, k as number)))) disk((side as Frames).dir).add(k as number)
    }))
    await Promise.all([
      until($, f.dir, first, ensure($, f, shown.source, first, isPlay)),
      until($, g.dir, jOf(first), ensure($, g, original.source, jOf(first), isPlay)),
    ])
    let n = 0
    while (first + n < want && disk(f.dir).has(first + n) && disk(g.dir).has(jOf(first + n))) n++
    if (!n) return
    const tmp = `${pair.dir}/m${first}`
    await $.process.run(['mkdir', '-p', `${tmp}/o`, `${tmp}/u`])
    const ext = (side: Frames) => (side.raw ? 'rgb' : 'png')
    const links = Array.from({ length: n }, (_, k) => {
      const name = String(k + 1).padStart(5, '0')
      return `ln -sf "${frameFile(g, jOf(first + k))}" "$0/o/f${name}.${ext(g)}"; ln -sf "${frameFile(f, first + k)}" "$0/u/f${name}.${ext(f)}"`
    }).join('\n')
    await $.process.run(['sh', '-c', links, tmp])
    // Raw frames have no header: ffmpeg is told their format and size.
    const input = (side: Frames, sub: string) => [
      ...(side.raw ? ['-f', 'image2', '-c:v', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${side.raw.width}x${side.raw.height}`] : []),
      '-framerate', String(pair.fps), '-i', `${tmp}/${sub}/f%05d.${ext(side)}`,
    ]
    const height = pairHeightOf(shown, original)
    const made = await $.process.run([
      state.ffmpeg, '-v', 'error', '-nostdin', ...ONE_THREAD, ...input(g, 'o'), ...input(f, 'u'),
      '-filter_complex', `[0:v]scale=${sideWidth(original, height)}:${height},pad=iw+${PAIR_GAP}:ih:0:0:color=${SIDEBAR.replace('#', '0x')}[a];[1:v]scale=${sideWidth(shown, height)}:${height}[b];[a][b]hstack=inputs=2`,
      '-compression_level', '1', '-frames:v', String(n), '-start_number', String(first + 1), '-y', `${pair.dir}/f%05d.png`,
    ])
    await $.process.run(['rm', '-rf', tmp])
    if (made.exitCode !== 0) return void debug(`merge failed: ${made.stderr.trim().slice(0, 120)}`)
    for (let k = first; k < first + n; k++) disk(pair.dir).add(k)
    wake(pair.dir)
  })().catch(() => undefined).finally(() => merging.delete(pair.dir))
  merging.set(pair.dir, job)
  return job
}

// The merged frame on screen, made if it has to be, and the second after it.
export async function pairReady($: EngineInterface, shown: Shown, i: number, site?: string, isPlay = false): Promise<void> {
  const pair = shown.pair, original = shown.compare
  if (!pair || !original?.frames || !shown.frames) return
  const f = shown.frames, g = original.frames
  i = clampFrame(pair, i)
  const j = clampFrame(g, compareFrame(shown, i))
  for (const [dir, fps] of [[pair.dir, pair.fps], [f.dir, f.fps], [g.dir, g.fps]] as const) fpsOf.set(dir, fps)
  if (site) {
    // The merged frames and both sides' keep a window while the pair is shown.
    watch(pair.dir, site, i, true)
    watch(f.dir, site, i, true)
    watch(g.dir, site, j, true)
    use($, site)
  }
  await Promise.all([learn($, pair.dir), learn($, f.dir), learn($, g.dir)])
  if (!disk(pair.dir).has(i) && (await exists($, frameFile(pair, i)))) disk(pair.dir).add(i)
  // Keeps both sides' decoders going while the pair plays.
  ensure($, f, shown.source, i, isPlay)
  ensure($, g, original.source, j, isPlay)
  if (site) for (const [dir, fps] of [[pair.dir, pair.fps], [f.dir, f.fps], [g.dir, g.fps]] as const) prune($, dir, fps)
  for (let tries = 0; tries < 3 && !disk(pair.dir).has(i); tries++) await merge($, shown, i, isPlay)
  void merge($, shown, i, isPlay)
}

// Resolves a path to something the terminal can draw: a PNG (other image
// formats converted with macOS `sips`), or a video's frames.
export async function prepare($: EngineInterface, raw: string, title?: string, key?: string): Promise<Shown> {
  const path = expand(raw, state.cwd, state.home)
  const stat = await $.fs.stat(path, { resolve: true })
  const real = stat.realPath ?? path
  const name = title ?? real.split('/').pop()!
  if (VIDEO.test(real)) return prepareVideo($, real, name, key ?? (await identityOf($, real)))
  if (isAudio(real)) return prepareAudio($, real, name, key ?? (await identityOf($, real)))
  let png = real
  if (isPage(real)) {
    // An HTML page becomes one fixed-window picture; its own file stays the
    // source, so the player's corner opens the page itself in the browser.
    png = await renderPage($, real, (key ?? (await identityOf($, real)) ?? keyOf(real)).slice(0, 10))
  } else if (!/\.png$/i.test(real)) {
    state.generation += 1
    png = `${state.TMP}/${real.split('/').pop()!.replace(/\.[^.]+$/, '')}-${state.generation}.png`
    await $.process.run(['mkdir', '-p', state.TMP])
    if (!state.isMac && !(await exists($, state.ffmpeg))) throw new Error(noFfmpeg(false))
    const conv = state.isMac
      ? await $.process.run(['sips', '-s', 'format', 'png', real, '--out', png])
      : await $.process.run([state.ffmpeg, '-v', 'error', '-y', '-i', real, '-frames:v', '1', png])
    if (conv.exitCode !== 0) throw new Error(`could not convert ${real}: ${conv.stderr.trim()}`)
  }
  // The terminal reads the file itself, so only a picture past what any
  // screen shows is shrunk.
  const dims = await pngSize($, png)
  if (Math.max(dims.width, dims.height) > MAX_STILL) {
    state.generation += 1
    const small = `${state.TMP}/${png.split('/').pop()!.replace(/\.png$/i, '')}-${state.generation}-small.png`
    await $.process.run(['mkdir', '-p', state.TMP])
    const shrunk = state.isMac
      ? await $.process.run(['sips', '-Z', String(MAX_STILL), png, '--out', small])
      : await $.process.run([state.ffmpeg, '-v', 'error', '-y', '-i', png, '-vf', `scale='if(gt(iw,ih),min(${MAX_STILL},iw),-2)':'if(gt(iw,ih),-2,min(${MAX_STILL},ih))'`, small]).catch(() => ({ exitCode: 1 }))
    if (state.isMac || shrunk.exitCode === 0) png = small
  }
  // A picture narrower than the window shows it is drawn that wide, as a
  // video's frames are, so a picture and a video of one shape are one size.
  // Never past twice its own width: a small icon stays small.
  const now = await pngSize($, png)
  const wide = Math.min(frameWidth(now.width, now.height, state.termSize, state.cell), now.width * 2)
  if (wide > now.width) {
    state.generation += 1
    const big = `${state.TMP}/${png.split('/').pop()!.replace(/\.png$/i, '')}-${state.generation}-w${wide}.png`
    await $.process.run(['mkdir', '-p', state.TMP])
    const grown = state.isMac
      ? await $.process.run(['sips', '--resampleWidth', String(wide), png, '--out', big]).catch(() => ({ exitCode: 1 }))
      : await $.process.run([state.ffmpeg, '-v', 'error', '-y', '-i', png, '-vf', `scale=${wide}:-2:flags=lanczos`, big]).catch(() => ({ exitCode: 1 }))
    if (grown.exitCode === 0) png = big
  }
  state.generation += 1

  return { kind: 'image', path: png, source: real, ...(await pngSize($, png)), sourceWidth: dims.width, sourceHeight: dims.height, title: name, generation: state.generation }
}
