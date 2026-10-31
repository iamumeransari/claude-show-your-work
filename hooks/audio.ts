// Optional host sound alongside the terminal's frames. One child per player;
// the engine owns the child and ends it when its stream or module closes.
import type { EngineInterface, ProcessSpawnChunk, ProcessSpawnResult, HookStream } from 'claude-code'

import { state } from './state'
import { event } from './diagnostics'

export const hasAudioTrack = (streams: string) => streams.split('\n').some(line => line.trim() === 'audio')
export const audioArgv = (binary: string, wav: string, seconds: number) => [
  binary, '-nodisp', '-autoexit', '-loglevel', 'quiet', '-ss', Math.max(0, seconds).toFixed(2), wav,
]
export const audioExtractArgv = (binary: string, source: string, wav: string, lead: number, duration: number) => [
  binary, '-v', 'error', '-y', ...(lead ? ['-ss', String(lead)] : []), ...(duration ? ['-t', String(duration)] : []),
  '-i', source, '-vn', '-ac', '1', '-ar', '22050', wav,
]

type AudioRun = { stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>; stopped: boolean }
const sounding = new Map<string, AudioRun>()

export function stopAudio(site: string, why = 'pause') {
  const run = sounding.get(site)
  if (!run) return
  sounding.delete(site)
  run.stopped = true
  void run.stream.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
  event('audio', { site, action: 'stop', why })
}
export function stopAllAudio() {
  for (const site of sounding.keys()) stopAudio(site, 'session_end')
}
export function startAudio($: EngineInterface, site: string, wav: string | undefined, seconds: number) {
  stopAudio(site, 'replace')
  if (!wav || !state.ffplay) return
  let stream: AudioRun['stream']
  try {
    stream = $.process.spawn({ argv: audioArgv(state.ffplay, wav, seconds) })
  } catch (e) {
    event('audio', { site, action: 'unavailable', error: String(e).slice(0, 80) })
    return
  }
  const run: AudioRun = { stream, stopped: false }
  sounding.set(site, run)
  // Closing early rejects result too, independently of the iterator.
  void stream.result.catch(() => undefined)
  event('audio', { site, action: 'play', seconds })
  void (async () => {
    try {
      for await (const _chunk of stream) { if (run.stopped) break }
    } catch {
      event('audio', { site, action: 'unavailable' })
      return
    } finally {
      if (sounding.get(site) === run) sounding.delete(site)
    }
    if (run.stopped) return
    // The child ended by itself: anything but a clean exit says why the sound
    // stopped (no audio device, a wav that went missing), as one event.
    const end = await stream.result.catch(() => null)
    if (end && (end.code !== 0 || end.signal)) event('audio', { site, action: 'unavailable', code: end.code, signal: end.signal ?? undefined })
  })()
}
