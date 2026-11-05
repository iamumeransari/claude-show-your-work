import { expect, test } from 'claude-code/testing'
import { state } from '../hooks/state'

import { ensureWave, isAudio, noticeOf, waveArgv, waveStripArgv } from '../hooks/media'
import { toolLine } from '../hooks/player'

test('audio is an mp3 or wav file, and only that', () => {
  expect(isAudio('/tmp/tone.mp3')).toBe(true)
  expect(isAudio('/tmp/Speech.WAV')).toBe(true)
  expect(isAudio('/tmp/voice.flac')).toBe(false)
  expect(isAudio('/tmp/track.ogg')).toBe(false)
  expect(isAudio('/tmp/song.mp3.js')).toBe(false)
  expect(isAudio('/tmp/shot.png')).toBe(false)
})

test('a waveform strip is the whole clip, one colour, on the card', () => {
  const argv = waveStripArgv('/usr/bin/ffmpeg', '/tmp/tone.mp3', '/tmp/bright.png', '#ff8c00')
  expect(argv[0]).toBe('/usr/bin/ffmpeg')
  expect(argv.join(' ')).toContain('showwavespic=s=1600x240')
  expect(argv.join(' ')).toContain('colors=#ff8c00')
  // The whole clip: no -ss, no -t on the audio.
  expect(argv).not.toContain('-ss')
  expect(argv.join(' ')).toContain('-frames:v')
  expect(argv.at(-1)).toBe('/tmp/bright.png')
})

test('the clip command keeps the waveform still and moves only the colour and the bar', () => {
  const argv = waveArgv('/usr/bin/ffmpeg', '/tmp/bright.png', '/tmp/dim.png', '/tmp/tone.mp3', '/tmp/wave.part', 12.04)
  const graph = argv.join(' ')
  // The position picks what shows: the played part glows, the rest stays dim.
  expect(graph).toContain('blend=all_expr=')
  expect(graph).toContain('lte(X,W*T/12.04')
  // A thin bar marks the moment itself, either side of it, in true white:
  // blending in the input's own space paints the chroma planes too, and the
  // bar comes out magenta. Both sides go to planar RGB first.
  expect(graph).toContain('lt(abs(X-W*T/12.04')
  expect(graph).toContain('format=gbrp')
  expect(graph).toContain('),255,if(')
  // The original audio rides along untouched, and the whole clip is covered.
  expect(graph).toContain('-c:a')
  expect(graph).toContain('copy')
  expect(graph).toContain('-map')
  expect(graph).toContain('2:a:0')
  expect(graph).toContain('-t 12.04')
  expect(graph).toContain('-f matroska')
})

test('a waveform clip is cut once and reused for the same file', async () => {
  state.TMP = '/tmp/claude-show-your-work'
  const runs: string[][] = []
  const files = new Set<string>(['/usr/bin/ffmpeg', '/usr/bin/ffprobe'])
  const ok = {
    fs: { stat: async (f: string) => (files.has(f) ? { size: 100 } : Promise.reject(new Error(`ENOENT: ${f}`))) },
    process: { run: async (argv: string[]) => {
      runs.push(argv)
      if (argv[0] === 'ffprobe' || argv[0] === '/usr/bin/ffprobe') return { exitCode: 0, stdout: '12.04\n', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    } },
  } as unknown as Parameters<typeof ensureWave>[0]
  state.ffmpeg = '/usr/bin/ffmpeg'
  state.ffprobe = '/usr/bin/ffprobe'
  state.hasVideoTools = true
  const out = await ensureWave(ok, '/tmp/tone.mp3', 'ab12cd34')
  expect(out).toBe('/tmp/claude-show-your-work/a-ab12cd34.mkv')
  // Two strips, one clip, then the move; the temporary encode never plays, and
  // each attempt writes its own side name, so two at once never tear one file.
  const outputs = runs.map(a => String(a.at(-1)))
  expect(outputs.some(p => /a-ab12cd34\.[0-9a-z]+\.bright\.png$/.test(p))).toBe(true)
  expect(outputs.some(p => /a-ab12cd34\.[0-9a-z]+\.dim\.png$/.test(p))).toBe(true)
  expect(runs.some(a => a.some(x => /^\/tmp\/claude-show-your-work\/a-ab12cd34\.mkv\.[0-9a-z]+\.part$/.test(String(x))))).toBe(true)
  expect(runs.some(a => a[0] === 'mv')).toBe(true)

  // The same file again cuts nothing: the clip is already there.
  files.add('/tmp/claude-show-your-work/a-ab12cd34.mkv')
  const again = await ensureWave(ok, '/tmp/tone.mp3', 'ab12cd34')
  expect(again).toBe(out)
  expect(runs.length).toBe(7)
})

test('two cuts of one file racing in this session share the one encode', async () => {
  state.TMP = '/tmp/claude-show-your-work'
  const runs: string[][] = []
  const files = new Set<string>(['/usr/bin/ffmpeg', '/usr/bin/ffprobe'])
  const ok = {
    fs: { stat: async (f: string) => (files.has(f) ? { size: 100 } : Promise.reject(new Error(`ENOENT: ${f}`))) },
    process: { run: async (argv: string[]) => {
      runs.push(argv)
      if (argv[0] === '/usr/bin/ffprobe') return { exitCode: 0, stdout: '12.04\n', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    } },
  } as unknown as Parameters<typeof ensureWave>[0]
  state.hasVideoTools = true
  const both = await Promise.all([ensureWave(ok, '/tmp/tone.mp3', 'cc34ab12'), ensureWave(ok, '/tmp/tone.mp3', 'cc34ab12')])
  expect(both[0]).toBe('/tmp/claude-show-your-work/a-cc34ab12.mkv')
  expect(both[1]).toBe(both[0])
  // One probe, one pair of strips, one encode, one move: not two of each.
  expect(runs.filter(a => a[0] === '/usr/bin/ffprobe')).toHaveLength(1)
  expect(runs.filter(a => a[0] === 'mv')).toHaveLength(1)
})

test('a file ffmpeg cannot read fails plainly and leaves nothing behind', async () => {
  state.TMP = '/tmp/claude-show-your-work'
  const runs: string[][] = []
  const bad = {
    fs: { stat: async (f: string) => (f === '/usr/bin/ffmpeg' || f === '/usr/bin/ffprobe' ? { size: 100 } : Promise.reject(new Error(`ENOENT: ${f}`))) },
    process: { run: async (argv: string[]) => {
      runs.push(argv)
      if (argv[0] === '/usr/bin/ffprobe') return { exitCode: 1, stdout: 'N/A\n', stderr: 'Invalid data' }
      return { exitCode: 0, stdout: '', stderr: '' }
    } },
  } as unknown as Parameters<typeof ensureWave>[0]
  state.hasVideoTools = true
  await expect(ensureWave(bad, '/tmp/broken.mp3', 'ff11aa22')).rejects.toThrow(/could not read/i)
  // Nothing was moved into place, so a broken file is never reused.
  expect(runs.some(a => a[0] === 'mv')).toBe(false)
})

test('unreadable audio is said in audio words, not video words', () => {
  const n = noticeOf(new Error('ffmpeg could not read /tmp/tone.mp3: Invalid data found when processing input'), '/tmp/tone.mp3', '/home/u')
  expect(n.title).toBe("This audio can't be read")
  expect(n.message.toLowerCase()).toContain('audio')
})

test('a non-audio file reaching show_audio is told what the tool opens', () => {
  const n = noticeOf(new Error('not audio: /tmp/song.flac'), '/tmp/song.flac', '/home/u')
  expect(n.title).toBe("This isn't an audio file")
  expect(n.message).toContain('MP3 and WAV')
  expect(n.message).toContain('ffmpeg')
})

test('audio too short for a frame is said in audio words', () => {
  const n = noticeOf(new Error('matches no streams'), '/tmp/blip.mp3', '/home/u')
  expect(n.title).toBe("This audio can't be read")
  expect(n.message.toLowerCase()).toContain('audio')
})

test('the tool row reads like the other rows', () => {
  expect(toolLine('mcp__show-your-work__show_audio', { path: '/tmp/tone.mp3' }, true)).toBe('♪ Cutting audio · tone.mp3')
  expect(toolLine('mcp__show-your-work__show_audio', { path: '/tmp/tone.mp3' }, false)).toBe('♪ Audio · tone.mp3')
})
