// A video's sound, beside its frames. On by default, with Mute for the session,
// only once the person presses Play.
//
// The sound is the clock: ffplay reports where it is about every 35 ms, and
// the player shows the frame for that moment (play in player.tsx), so picture
// and sound can't drift apart. When the frames ahead aren't cut yet, the
// sound stops and the picture holds; both start again together.
//
// The sound never outlives the picture: every pause stops it (halt), the
// reading loop below ends it once the play timer has been quiet for a second,
// the engine kills it when the module unloads, and the file it plays ends
// where the clip does.
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'

import type { Frames } from '../types'

import { state } from './state'
import { event, problem } from './diagnostics'
import { identityOf, isGone, keyOf } from './media'

// Mono 16-bit at 22.05 kHz: 44,100 bytes a second, ~2.6 MB a minute.
const SOUND_RATE = 22050
const SOUND_BYTES_PER_SECOND = SOUND_RATE * 2
const WAV_HEADER = 44
// ffplay takes ~0.5 s to open the audio device and report its first position.
const SOUND_START_MS = 2500
// A position older than this means ffplay stalled: stop it rather than guess.
// A busy machine delays its status lines by half a second and more, and
// stopping for that was heard as the sound cutting out.
const SOUND_STALE_MS = 1500
// The play timer quiet this long means the picture stopped: so does the sound.
const SOUND_ORPHAN_MS = 1000
// Starts per play (the first and three after the frames fell behind) before
// the sound is given up and the clip plays on silent.
export const SOUND_RESTARTS = 4
// How long a play's first moment waits for the sound file to be cut.
export const SOUND_WAIT_MS = 3000
// How long the picture may hold for the sound before playing on without it.
export const SOUND_HOLD_MAX_MS = 6000
// Too close to the end to be worth the start-up delay: finish silently.
const SOUND_TAIL_S = 0.5

// How long the output device takes to play what ffplay hands it: ~0.16 s for
// AirPods, a few ms for built-in speakers. ffplay's position allows for its
// own buffer but not this, so without it the picture runs ahead on Bluetooth.
// Read on macOS from AVAudioEngine (output side only: no microphone prompt),
// again at each start, since the device can change mid-session.
let outputLatency = 0
let latencyAskedAt = 0
const LATENCY_JS = "ObjC.import('AVFoundation');$.AVAudioEngine.alloc.init.outputNode.presentationLatency"
export function measureLatency($: EngineInterface) {
  if (!state.isMac || Date.now() - latencyAskedAt < 5000) return
  latencyAskedAt = Date.now()
  void $.process.run(['osascript', '-l', 'JavaScript', '-e', LATENCY_JS], { timeoutMs: 8000 }).then(r => {
    const s = Number(r.stdout.trim())
    if (r.exitCode !== 0 || !Number.isFinite(s) || s < 0 || s > 1) return
    if (Math.abs(s - outputLatency) > 0.001) event('sound', { action: 'latency', ms: Math.round(s * 1000) })
    outputLatency = s
  }).catch(() => undefined)
}
// The moment being heard, from ffplay's position and when it was read.
export const heardAt = (clock: number, sinceMs: number, latency: number) => clock + sinceMs / 1000 - latency

// Whether this session can play sound to the person at all.
export const soundUsable = () => !!state.ffplay && !state.isFarFromSpeakers && state.canImage

export const soundArgv = (ffplay: string, wav: string, from: number) => [
  ffplay, '-nodisp', '-autoexit', '-vn', '-sn', '-hide_banner', '-loglevel', 'info', '-stats', '-ss', Math.max(0, from).toFixed(3), wav,
]
// From where the frames start and as long as they run; aresample pads a late
// first sample with silence, so sound time 0 is frame 0 exactly.
export const soundExtractArgv = (ffmpeg: string, source: string, wav: string, lead: number, duration: number) => [
  ffmpeg, '-v', 'error', '-y', ...(lead ? ['-ss', String(lead)] : []), '-t', String(duration), '-i', source,
  '-vn', '-sn', '-dn', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', String(SOUND_RATE), '-c:a', 'pcm_s16le', '-f', 'wav', wav,
]
// ffplay's status line: "  3.96 M-A:  0.000 fd=…" (the clock, then the drift
// of each stream against it). "nan" before the first sample plays.
export function soundClockOf(text: string): number | null {
  let found: number | null = null
  for (const m of text.matchAll(/(\d+\.\d+)\s+(?:M-A|A-V|M-V):/g)) found = Number(m[1])
  return found
}
export const wavSeconds = (bytes: number) => Math.max(0, (bytes - WAV_HEADER) / SOUND_BYTES_PER_SECOND)

// ── The clip's sound file ────────────────────────────────────────────────

// 'none': no sound stream. 'has': one, not cut yet. 'cutting', then 'ready'.
type Track = { status: 'none' } | { status: 'has' } | { status: 'cutting' } | { status: 'ready'; wav: string; seconds: number }
const tracks = new Map<string, Track>()
const asking = new Map<string, Promise<Track | undefined>>()
const trackKeyOf = (source: string, f: Frames) => `${source}|${f.lead ?? 0}|${f.duration}`

// What is known now, without waiting: the play timer and a render can't wait.
export function soundTrack(source: string | undefined, f: Frames | undefined): Track | undefined {
  return source && f ? tracks.get(trackKeyOf(source, f)) : undefined
}

// Whether the clip has a sound stream (one ffprobe, once per clip). A
// cancelled look is forgotten, so a later one asks again.
export function probeSound($: EngineInterface, source: string | undefined, f: Frames | undefined): Promise<Track | undefined> {
  if (!source || !f || !soundUsable()) return Promise.resolve(undefined)
  const key = trackKeyOf(source, f)
  const known = tracks.get(key)
  if (known) return Promise.resolve(known)
  let job = asking.get(key)
  if (!job) {
    job = (async () => {
      try {
        const probed = await $.process.run([state.ffprobe, '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', source], { timeoutMs: 15000 })
        if (probed.exitCode !== 0) return undefined
        const found: Track = probed.stdout.split('\n').some(l => l.trim() === 'audio') ? { status: 'has' } : { status: 'none' }
        if (!tracks.has(key)) tracks.set(key, found)
        return tracks.get(key)
      } catch {
        return undefined
      } finally {
        asking.delete(key)
      }
    })()
    asking.set(key, job)
  }
  return job
}

// Cuts the clip's sound to a file, once. Started from a button or the play
// timer, never a render (a newer render cancels what a render started).
export async function prepareSound($: EngineInterface, source: string | undefined, f: Frames | undefined): Promise<Track | undefined> {
  if (!source || !f) return undefined
  const key = trackKeyOf(source, f)
  let known = tracks.get(key) ?? (await probeSound($, source, f))
  if (!known || known.status === 'none' || known.status === 'cutting') return known
  if (known.status === 'ready') {
    if (!(await isGone($, known.wav))) return known
    known = { status: 'has' }
  }
  tracks.set(key, { status: 'cutting' })
  try {
    const made = await cutSound($, source, f)
    tracks.set(key, made)
    return made
  } catch {
    // Cancelled or timed out: back to uncut, so a later play tries again.
    tracks.set(key, { status: 'has' })
    return undefined
  }
}

async function cutSound($: EngineInterface, source: string, f: Frames): Promise<Track> {
  // Named by the file's identity (path, size, time), so an edited file is cut again.
  const id = (await identityOf($, source).catch(() => undefined)) ?? source
  const name = `${state.TMP}/sound-${keyOf(`${id}|${f.lead ?? 0}|${f.duration}`)}`
  // Cut to a side name, then moved: a cut that dies midway never leaves a
  // short file that plays as if it were whole.
  const cut = await $.process.run(soundExtractArgv(state.ffmpeg, source, `${name}.part`, f.lead ?? 0, f.duration), { timeoutMs: 120000 })
  if (cut.exitCode !== 0) {
    // Not tried again this session: the clip plays silent, as before.
    problem('sound_cut_failed', { error: cut.stderr.trim().slice(0, 120) })
    return { status: 'none' }
  }
  const moved = await $.process.run(['mv', '-f', `${name}.part`, `${name}.wav`])
  if (moved.exitCode !== 0) return { status: 'none' }
  const st = await $.fs.stat(`${name}.wav`).catch(() => null)
  const seconds = st ? wavSeconds(st.size) : 0
  event('sound', { action: 'cut', seconds: +seconds.toFixed(2) })
  return seconds > 0 ? { status: 'ready', wav: `${name}.wav`, seconds } : { status: 'none' }
}

// ── Playing it ───────────────────────────────────────────────────────────

type SoundRun = {
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  startedAt: number
  // The last position ffplay reported, and when.
  clock: number | null
  clockAt: number
  isOver: boolean
}
const runs = new Map<string, SoundRun>()

// Where the sound is now, for the play timer: 'off' (nothing playing),
// 'starting' (ffplay opening the device: hold the picture), or 'on' with
// the moment being heard. A start that never reports, or a clock that stops,
// is stopped here and reads as 'off'.
export function soundNow(site: string, now = Date.now()): { kind: 'off' } | { kind: 'starting' } | { kind: 'on'; seconds: number } {
  const run = runs.get(site)
  if (!run || run.isOver) return { kind: 'off' }
  if (run.clock === null) {
    if (now - run.startedAt <= SOUND_START_MS) return { kind: 'starting' }
    problem('sound_no_clock', { site })
    haltSound(site, 'no_clock')
    return { kind: 'off' }
  }
  if (now - run.clockAt > SOUND_STALE_MS) {
    problem('sound_stalled', { site, at: run.clock })
    haltSound(site, 'stalled')
    return { kind: 'off' }
  }
  return { kind: 'on', seconds: heardAt(run.clock, now - run.clockAt, outputLatency) }
}

// Whether a sound worth starting is left from this moment.
export const soundLeft = (track: Track | undefined, from: number) => track?.status === 'ready' && from < track.seconds - SOUND_TAIL_S

export function haltSound(site: string, why: string) {
  const run = runs.get(site)
  if (!run) return
  runs.delete(site)
  run.isOver = true
  void run.stream.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
  event('sound', { site, action: 'stop', why })
}
export function haltAllSound(why: string) {
  for (const site of [...runs.keys()]) haltSound(site, why)
}

// Starts the sound at `from` seconds. `lastTick` says when the picture last
// moved on: once it has been quiet for a second, the sound ends too.
export function startSound($: EngineInterface, site: string, wav: string, from: number, lastTick: () => number): boolean {
  haltSound(site, 'replace')
  measureLatency($)
  let stream: SoundRun['stream']
  try {
    stream = $.process.spawn({ argv: soundArgv(state.ffplay, wav, from) })
  } catch (e) {
    problem('sound_unavailable', { error: String(e).slice(0, 80) })
    return false
  }
  const run: SoundRun = { stream, startedAt: Date.now(), clock: null, clockAt: 0, isOver: false }
  runs.set(site, run)
  void stream.result.catch(() => undefined)
  event('sound', { site, action: 'play', from: +from.toFixed(2) })
  void (async () => {
    try {
      for await (const chunk of stream) {
        if (run.isOver) break
        if (Date.now() - lastTick() > SOUND_ORPHAN_MS) {
          problem('sound_orphaned', { site })
          break
        }
        if (chunk.stream !== 'stderr') continue
        const at = soundClockOf(chunk.text)
        if (at !== null) {
          run.clock = at
          run.clockAt = Date.now()
        }
      }
    } catch {
      if (!run.isOver) problem('sound_unavailable', { site })
    } finally {
      if (runs.get(site) === run) {
        runs.delete(site)
        run.isOver = true
        void stream.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
      }
    }
  })()
  return true
}
