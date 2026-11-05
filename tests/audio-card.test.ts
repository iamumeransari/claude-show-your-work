import { expect, test } from 'claude-code/testing'

// The plugin under test is the bundle, with its own state: nothing is set in it
// directly. The machine answers as one with ffmpeg and ffplay would, and the
// card's buttons are read from what it drew. See sound-play.test.ts.
const track = (id: string, seconds = 12) => ({
  kind: 'audio', path: `/tmp/${id}/f00001.png`, source: `/tmp/${id}.mkv`, origin: `/tmp/${id}.mp3`,
  width: 1600, height: 240, title: 'Tone', generation: 1,
  frames: { dir: `/tmp/${id}`, count: seconds * 12, fps: 12, duration: seconds },
})
const WHERE = (ffplay: string) => `home=/tmp\nff=/bin/ffmpeg\nfp=/bin/ffprobe\nfy=${ffplay}\ncl=\nos=Linux\nch=\n`

function machine(on: any, ffplay: string, onRun?: (argv: string[]) => void) {
  on('store.get', () => ({ value: undefined }))
  on('fs.stat', (_$: any, e: any) => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }))
  on('process.run', (_$: any, e: any) => {
    const argv: string[] = e.argv
    onRun?.(argv)
    if (argv[0] === 'sh' && String(argv[2]).includes('command -v')) return { value: { exitCode: 0, stdout: WHERE(ffplay), stderr: '' } }
    if (argv.includes('-select_streams')) return { value: { exitCode: 0, stdout: 'audio\n', stderr: '' } }
    if (argv[0] === '/bin/ffmpeg' || argv[0] === 'mv') return { value: { exitCode: 0, stdout: '', stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
}

async function mountOf($: any, id: string, shown = track(id)) {
  const mounted = await $.ui.mount({
    plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: id,
    props: { tool_use_id: id, tool: 'mcp__show-your-work__show_audio', output: `Shown.\nshow-your-work:${JSON.stringify(shown)}`, isErrored: false },
    viewport: { columns: 140, rows: 50 },
  } as any)
  await mounted.drawn()
  return mounted
}

test('an audio card draws the waveform and waits for Play', async ($, on) => {
  machine(on, '/bin/ffplay')
  const tree = JSON.stringify(await (await mountOf($, 'a1')).drawn())
  expect(tree.includes('"Image"')).toBe(true)
  // It waits for Play, like a video; sound comes with the press.
  expect(tree.includes('▶ Play')).toBe(true)
  expect(tree.includes('Pause')).toBe(false)
  expect(tree.includes('"seek-')).toBe(true)
  expect(tree.includes('3s »')).toBe(true)
  // The clip has a sound stream, so Mute is there.
  // The sound-stream probe completes after the initial draw.
  expect(tree.includes('Tone')).toBe(true)
  // And nothing says sound is impossible.
  expect(tree.includes('no sound in this session')).toBe(false)
})

test('a session that cannot hear it says so beside the controls', async ($, on) => {
  machine(on, '')
  const tree = JSON.stringify(await (await mountOf($, 'a2')).drawn())
  expect(tree.includes('no sound in this session')).toBe(true)
  expect(tree.includes('♪ Mute')).toBe(false)
})

test('side-by-side audio copies the original path, not the waveform clip', async ($, on) => {
  const copied: string[] = []
  machine(on, '/bin/ffplay')
  on('ui.copy', (_$: any, e: any) => { copied.push(e.text); return { value: { isCopied: true } } })
  on('ui.toast', () => ({ value: undefined }))
  const left = { ...track('b1'), title: 'Before', label: 'Original' }
  const both = {
    ...track('b2'), label: 'Updated',
    compare: left,
    pair: { dir: '/tmp/b2pair', count: 12 * 12, fps: 12, duration: 12 },
    pairWidth: 3200, pairHeight: 240,
  }
  const m = await mountOf($, 'b2', both)
  await m.press({ key: 'side-both' })
  await m.redraw()
  const tree = JSON.stringify(await m.drawn())
  expect(tree.includes('view-pair')).toBe(true)
  await m.press({ key: 'copy' })
  expect(copied).toStrictEqual(['/tmp/b2.mp3'])
})
