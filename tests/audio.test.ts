import { expect, test } from 'claude-code/testing'
import { state } from '../hooks/state'

import { audioArgv, audioExtractArgv, hasAudioTrack } from '../hooks/audio'
import { extractAudio } from '../hooks/media'

test('an audio stream is spotted in ffprobe stream lines, emptiness is not', () => {
  expect(hasAudioTrack('audio\n')).toBe(true)
  expect(hasAudioTrack('audio\naudio\n')).toBe(true)
  expect(hasAudioTrack('\n')).toBe(false)
  expect(hasAudioTrack('')).toBe(false)
})

test('the play command starts where the frames are, ends with the track and shows nothing', () => {
  expect(audioArgv('/usr/bin/ffplay', '/tmp/v-x/audio.wav', 0)).toStrictEqual([
    '/usr/bin/ffplay', '-nodisp', '-autoexit', '-loglevel', 'quiet', '-ss', '0.00', '/tmp/v-x/audio.wav',
  ])
  expect(audioArgv('ffplay', '/tmp/a.wav', 10 / 12)).toContain('-ss')
  expect(audioArgv('ffplay', '/tmp/a.wav', 10 / 12).at(-2)).toBe('0.83')
})

test('the extraction command skips the lead, stops with the frames and downsamples', () => {
  expect(audioExtractArgv('/usr/bin/ffmpeg', '/tmp/clip.mp4', '/tmp/v-x/audio.wav', 0.5, 74)).toStrictEqual([
    '/usr/bin/ffmpeg', '-v', 'error', '-y', '-ss', '0.5', '-t', '74', '-i', '/tmp/clip.mp4', '-vn', '-ac', '1', '-ar', '22050', '/tmp/v-x/audio.wav',
  ])
  const whole = audioExtractArgv('ffmpeg', '/c.mp4', '/w.wav', 0, 0)
  expect(whole.includes('-ss')).toBe(false)
  expect(whole.includes('-t')).toBe(false)
})

test('a clip with no audio stream extracts nothing, without touching ffmpeg', async () => {
  const ran: string[][] = []
  const $ = {
    process: {
      run: async (argv: string[]) => {
        ran.push(argv)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  } as unknown as Parameters<typeof extractAudio>[0]
  state.hasVideoTools = true
  const wav = await extractAudio($, '/tmp/clip.mp4', '/tmp/v-x', 0, 4)
  expect(wav).toBeUndefined()
  expect(ran.some(argv => (argv[0] ?? '').includes('ffmpeg'))).toBe(false)
})

test('audio probe and extraction failures keep the video silent', async () => {
  state.hasVideoTools = true
  for (const failure of ['probe', 'extract', 'throw']) {
    const $ = { process: { run: async (argv: string[]) => {
      if (failure === 'throw') throw new Error('could not start')
      const isProbe = argv.includes('-select_streams')
      return { exitCode: (isProbe ? failure === 'probe' : failure === 'extract') ? 1 : 0, stdout: isProbe ? 'audio\n' : '', stderr: '' }
    } } } as unknown as Parameters<typeof extractAudio>[0]
    expect(await extractAudio($, '/tmp/clip.mp4', '/tmp/v-x', 0, 4)).toBeUndefined()
  }
})
