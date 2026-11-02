import { expect, mock, test } from 'claude-code/testing'

// The plugin under test is the bundle, with its own state: these tests set
// nothing in it directly. They answer its processes the way a Mac with ffmpeg
// would, and press its buttons. The harness runs no real processes, and its
// clock doesn't move Date.now, so the give-ups that time real seconds (no
// position, a stalled one, the orphan check) are checked in a real session
// instead: see Sound in docs/technical/testing-and-debugging.md.
const clip = (id: string) => ({
  kind: 'video', path: `/tmp/${id}/f00001.png`, source: `/tmp/${id}.mov`, width: 960, height: 540, title: 'Sound', generation: 1,
  frames: { dir: `/tmp/${id}`, count: 36, fps: 12, duration: 3 },
})
// A 3 s mono 22.05 kHz sound file.
const WAV_BYTES = 44 + 44100 * 3
const WHERE = 'home=/tmp\nff=/bin/ffmpeg\nfp=/bin/ffprobe\nfy=/bin/ffplay\ncl=\nos=Darwin\n'

type Spawned = { argv: string[]; ended: boolean }

// The setup shell finds ffplay; ffprobe finds a sound stream (or not); ffmpeg
// and mv succeed; osascript reports the output device's delay, when given. Anything else is refused, as the harness would.
function machine(on: any, hasSound = true, latency?: string) {
  on('store.get', () => ({ value: undefined }))
  on('fs.stat', (_$: any, e: any) => ({ value: { kind: 'file', size: String(e.path).endsWith('.wav') ? WAV_BYTES : 1, mtimeMs: 0, isLink: false } }))
  on('process.run', (_$: any, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'sh' && String(argv[2]).includes('command -v ffplay')) return { value: { exitCode: 0, stdout: WHERE, stderr: '' } }
    if (argv.includes('-select_streams')) return { value: { exitCode: 0, stdout: hasSound ? 'video\naudio\n' : 'video\n', stderr: '' } }
    if (argv[0] === '/bin/ffmpeg' || argv[0] === 'mv') return { value: { exitCode: 0, stdout: '', stderr: '' } }
    // The output device's delay (macOS, through AVAudioEngine).
    if (argv[0] === 'osascript' && latency !== undefined) return { value: { exitCode: 0, stdout: `${latency}\n`, stderr: '' } }
    return { deny: 'no processes here' }
  })
}

// ffplay as the plugin sees it: after `startMs` (printing "nan" meanwhile, as
// the real one does) it reports positions from its
// -ss, advancing at `rate` times real time, every 35 ms, until it's stopped.
function ffplay(on: any, clock: any, spawned: Spawned[], startMs = 500, rate = 1) {
  on('process.spawn', async function* (_$: any, e: any) {
    const run = { argv: [...e.argv], ended: false }
    spawned.push(run)
    const from = Number(e.argv[e.argv.indexOf('-ss') + 1])
    try {
      // While it opens the device it prints a status line with no position.
      for (let ms = 0; ms < startMs; ms += 35) {
        yield { stream: 'stderr', text: 'nan    :  0.000 fd=   0 aq=    0KB vq=    0KB sq=    0B\r' }
        await clock.sleep(35)
      }
      for (let ms = 0; ms < 10000; ms += 35) {
        yield { stream: 'stderr', text: `  ${(from + (ms / 1000) * rate).toFixed(2)} M-A:  0.000 fd=   0 aq=   10KB vq=    0KB sq=    0B\r` }
        await clock.sleep(35)
      }
      return { code: 0, signal: null }
    } finally {
      run.ended = true
    }
  })
}

function frames(on: any) {
  const swapped: number[] = []
  on('ui.blit', (_$: any, e: any) => {
    const m = /f(\d+)\.png$/.exec(String(e.source?.file ?? ''))
    if (m) swapped.push(Number(m[1]))
    return { value: {} }
  })
  return swapped
}

async function mountOf($: any, id: string) {
  const mounted = await $.ui.mount({
    plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: id,
    props: { tool_use_id: id, tool: 'mcp__show-your-work__show_video', output: `Shown.\nshow-your-work:${JSON.stringify(clip(id))}`, isErrored: false },
    viewport: { columns: 140, rows: 50 },
  } as any)
  await mounted.drawn()
  return mounted
}
const must = (ok: boolean, what: string) => { if (!ok) throw new Error(what) }
const textOf = async (mounted: any) => JSON.stringify(await mounted.drawn())

test('a clip without sound has no Unmute, and plays as before', async ($, on) => {
  const clock = mock.clock(on)
  machine(on, false)
  const spawned: Spawned[] = []
  ffplay(on, clock, spawned)
  const swapped = frames(on)
  const mounted = await mountOf($, 'silent')
  await clock.advance(400)
  expect((await textOf(mounted)).includes('Unmute')).toBe(false)
  await mounted.press({ key: 'play' })
  await clock.advance(1000)
  expect(spawned.length).toBe(0)
  expect(swapped.at(-1)!).toBeGreaterThanOrEqual(10)
})

test('a clip with sound plays muted until Unmute; then the picture follows the sound, and Pause or Mute ends it', async ($, on) => {
  const clock = mock.clock(on)
  machine(on)
  const spawned: Spawned[] = []
  // The sound runs at 0.9x real time: the picture must follow it, not the wall clock.
  ffplay(on, clock, spawned, 500, 0.9)
  const swapped = frames(on)
  const mounted = await mountOf($, 'loud')
  await clock.advance(400)
  must((await textOf(mounted)).includes('Unmute'), "check 1: (await textOf(mounted)).includes('Unmute')")

  // Muted: Play spawns nothing.
  await mounted.press({ key: 'play' })
  await clock.advance(500)
  expect(spawned.length).toBe(0)
  await mounted.press({ key: 'play' })
  await mounted.press({ key: 'back' })

  // Unmuted: the sound is cut, ffplay starts, and the picture holds on its
  // frame while ffplay opens its device.
  await mounted.press({ key: 'sound' })
  must((await textOf(mounted)).includes('Mute'), "check 2: (await textOf(mounted)).includes('Mute')")
  swapped.length = 0
  await mounted.press({ key: 'play' })
  await clock.advance(300)
  expect(spawned.length).toBe(1)
  must(spawned[0]!.argv.at(-1)!.endsWith('.wav'), "check 3: spawned[0]!.argv.at(-1)!.endsWith('.wav')")
  expect(spawned[0]!.argv.slice(1, 3)).toStrictEqual(['-nodisp', '-autoexit'])
  expect(swapped.filter(f => f > 1).length).toBe(0)

  // Then it shows the frame for the moment being heard.
  await clock.advance(1700)
  const heardFrom = 300 + 500 - 84 // ffplay started on a tick, then took 500 ms
  const heard = (0.9 * (2000 - heardFrom)) / 1000
  const shown = swapped.at(-1)! - 1
  expect(Math.abs(shown - heard * 12)).toBeLessThanOrEqual(2)
  must(swapped.every((f, i) => i === 0 || f >= swapped[i - 1]!), 'check 4: swapped.every((f, i) => i === 0 || f >= swapped[i - 1]!)')

  // Pause ends ffplay at once.
  await mounted.press({ key: 'play' })
  await clock.advance(50)
  must(spawned[0]!.ended, 'check 5: spawned[0]!.ended')

  // Resume starts it again from the frame on screen.
  await mounted.press({ key: 'play' })
  await clock.advance(200)
  expect(spawned.length).toBe(2)
  const from = Number(spawned[1]!.argv[spawned[1]!.argv.indexOf('-ss') + 1])
  expect(Math.abs(from - shown / 12)).toBeLessThanOrEqual(0.2)

  // Mute mid-play ends it; the picture plays on by itself.
  await mounted.press({ key: 'sound' })
  await clock.advance(50)
  must(spawned.every(s => s.ended), 'check 6: spawned.every(s => s.ended)')
  const before = swapped.at(-1)!
  await clock.advance(500)
  expect(swapped.at(-1)!).toBeGreaterThan(before)
  expect(spawned.length).toBe(2)
  await mounted.press({ key: 'play' })
})

test('on a slow output device (Bluetooth headphones) the picture waits for the sound to come out', async ($, on) => {
  const clock = mock.clock(on)
  machine(on, true, '0.5')
  const spawned: Spawned[] = []
  ffplay(on, clock, spawned, 500, 1)
  const swapped = frames(on)
  const mounted = await mountOf($, 'slow')
  await clock.advance(400)
  await mounted.press({ key: 'sound' })
  swapped.length = 0
  await mounted.press({ key: 'play' })
  await clock.advance(2300)
  expect(spawned.length).toBe(1)
  // ffplay has played ~1.58 s by now; the person hears 0.5 s less of it.
  const played = (2300 - (300 + 500 - 84)) / 1000
  const shown = swapped.at(-1)! - 1
  expect(Math.abs(shown - (played - 0.5) * 12)).toBeLessThanOrEqual(2)
  await mounted.press({ key: 'play' })
})
