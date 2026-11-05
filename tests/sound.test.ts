import { expect, test } from 'claude-code/testing'
import { state } from '../hooks/state'

import { heardAt, soundArgv, soundClockOf, soundExtractArgv, soundLeft, soundNow, soundUsable, wavSeconds } from '../hooks/sound'

test("ffplay's position is read from its status line, the latest one in a piece", () => {
  expect(soundClockOf('nan    :  0.000 fd=   0 aq=    0KB vq=    0KB sq=    0B')).toBe(null)
  expect(soundClockOf('   3.96 M-A:  0.000 fd=   0 aq=   69KB vq=    0KB sq=    0B')).toBe(3.96)
  // Several updates in one piece, split by carriage returns: the last counts.
  expect(soundClockOf('   1.00 M-A:  0.000 fd=0\r   1.03 M-A:  0.000 fd=0\r')).toBe(1.03)
  // Older ffplay builds print A-V beside a video stream.
  expect(soundClockOf('  12.50 A-V:  0.010 fd=0')).toBe(12.5)
  expect(soundClockOf('Input #0, wav, from x.wav:')).toBe(null)
})

test('the sound file is mono 16-bit 22.05 kHz, so its length comes from its size', () => {
  expect(wavSeconds(44 + 44100 * 3)).toBe(3)
  expect(wavSeconds(10)).toBe(0)
})

test('the sound is cut from where the frames start, as long as they run, padded to line up', () => {
  const argv = soundExtractArgv('ffmpeg', '/a b.mov', '/t/s.part', 1.25, 10)
  expect(argv.slice(argv.indexOf('-ss'), argv.indexOf('-ss') + 2)).toStrictEqual(['-ss', '1.25'])
  expect(argv.slice(argv.indexOf('-t'), argv.indexOf('-t') + 2)).toStrictEqual(['-t', '10'])
  expect(argv.includes('aresample=async=1:first_pts=0')).toBe(true)
  expect(argv.at(-1)).toBe('/t/s.part')
  // No lead-in: no seek at all.
  expect(soundExtractArgv('ffmpeg', '/a.mov', '/t/s.part', 0, 10).includes('-ss')).toBe(false)
})

test('ffplay plays with no window and reports where it is, from the playhead', () => {
  const argv = soundArgv('/bin/ffplay', '/t/s.wav', 4)
  expect(argv[0]).toBe('/bin/ffplay')
  for (const flag of ['-nodisp', '-autoexit', '-stats']) expect(argv.includes(flag)).toBe(true)
  expect(argv.slice(argv.indexOf('-ss'), argv.indexOf('-ss') + 2)).toStrictEqual(['-ss', '4.000'])
  expect(soundArgv('ffplay', 'x', -1).includes('0.000')).toBe(true)
})

test('sound never starts near the end, past the sound, or without a file', () => {
  const ready = { status: 'ready' as const, wav: '/t/s.wav', seconds: 10 }
  expect(soundLeft(ready, 0)).toBe(true)
  expect(soundLeft(ready, 9.6)).toBe(false)
  expect(soundLeft(ready, 12)).toBe(false)
  expect(soundLeft({ status: 'has' }, 0)).toBe(false)
  expect(soundLeft(undefined, 0)).toBe(false)
})

test('standalone audio starts even when the whole clip is shorter than the video tail guard', () => {
  const ready = { status: 'ready' as const, wav: '/t/blip.wav', seconds: 0.3 }
  expect(soundLeft(ready, 0, 0)).toBe(true)
  // The video default keeps guarding its half-second tail.
  expect(soundLeft(ready, 0)).toBe(false)
  expect(soundLeft(ready, 0.3, 0)).toBe(false)
})

test('a player with no sound running reads as off', () => {
  expect(soundNow('nowhere')).toStrictEqual({ kind: 'off' })
})

test('sound only where it reaches the person: ffplay found, not over ssh or from a background session', () => {
  const was = { ffplay: state.ffplay, far: state.isFarFromSpeakers, canImage: state.canImage }
  try {
    state.ffplay = '/opt/homebrew/bin/ffplay'
    state.isFarFromSpeakers = false
    state.canImage = true
    expect(soundUsable()).toBe(true)
    state.isFarFromSpeakers = true
    expect(soundUsable()).toBe(false)
    state.isFarFromSpeakers = false
    state.ffplay = ''
    expect(soundUsable()).toBe(false)
    state.ffplay = '/opt/homebrew/bin/ffplay'
    state.canImage = false
    expect(soundUsable()).toBe(false)
  } finally {
    Object.assign(state, { ffplay: was.ffplay, isFarFromSpeakers: was.far, canImage: was.canImage })
  }
})

test('every session starts with sound on', () => {
  expect(state.isSoundOn).toBe(true)
})

test("the moment heard is ffplay's position, moved on by the time since, less the output device's delay", () => {
  expect(Math.abs(heardAt(3, 100, 0) - 3.1)).toBeLessThan(1e-9)
  expect(Math.abs(heardAt(3, 100, 0.16) - 2.94)).toBeLessThan(1e-9)
})
