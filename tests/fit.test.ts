import { expect, test } from 'claude-code/testing'

import { wrapWords, pagesOf, fit, cellOf, frameWidth, paneSize, layoutOf, targetBox, drawBox, pixelsFor, sizeFor, tabLabel } from '../hooks/layout'
import { isInstalledCopy } from '../hooks/telemetry'
import { isAtLeast } from '../hooks/setup'
import { STOPS } from '../hooks/tour'
import { settings, state } from '../hooks/state'
import { anchors, mapTime, align, matchOf, expand, frameFile, pairHeightOf, sameMoment, sampleRate, chunksBehind, chunksAhead, strideFor, spreadMatch, leadFrom, shiftTimes, keyOf, looseName, pngDims } from '../hooks/media'
import { parseShown, timesThatMean, versionsOf, noteOf, handleOf } from '../hooks/history'
import { liveChange, inClipOrder, barChunks, changeAt, qaTotals, checkDiff, resultWords, resumeCommand, isScratch, toolLine, urlAt, playWord, openFailure, causeOf, profileOf, profileLine, orcaReads, terminalOf, pngSource } from '../hooks/player'

test('a wide image fills the width at half-height rows', () => {
  expect(fit(1920, 1080, 100, 40)).toEqual({ columns: 100, rows: 29 })
})

test('a tall image is limited by rows and narrowed to keep its shape', () => {
  expect(fit(1000, 2000, 100, 30)).toEqual({ columns: 30, rows: 30 })
})

test('sizes stay inside the 1..255 cell limits', () => {
  const box = fit(10000, 10, 400, 40)
  expect(box.columns).toBe(255)
  expect(box.rows).toBe(1)
})

test('the result text round-trips to the shown image', () => {

  const shown = { path: '/tmp/a.png', width: 10, height: 5, title: 'a', generation: 1 }
  const text = `Shown to the user: a (10×5).\nshow-your-work:${JSON.stringify(shown)}`
  expect(parseShown(text)).toEqual(shown)
  expect(parseShown([{ type: 'text', text }])).toEqual(shown)
  expect(parseShown('nothing here')).toBe(null)
})

test('typed and dragged-in paths resolve', () => {
  expect(expand('~/Movies/Screen\\ Recordings/a.png', '/w', '/Users/u')).toBe('/Users/u/Movies/Screen Recordings/a.png')
  expect(expand("'/tmp/a b.png'", '/w', '/Users/u')).toBe('/tmp/a b.png')
  expect(expand('img/a.png', '/w/', '/Users/u')).toBe('/w/img/a.png')
})

test('long clips are sampled slower so they stay under 3600 frames', () => {
  expect(sampleRate(10)).toBe(12)
  // Five minutes still plays at the full rate.
  expect(sampleRate(300)).toBe(12)
  expect(sampleRate(600)).toBe(6)
  expect(sampleRate(20000)).toBe(1)
  expect(frameFile({ dir: '/t', count: 3, fps: 12, duration: 1 }, 0)).toBe('/t/f00001.png')
})

test('5 s of frames stay behind the playhead and 5 s are cut ahead', () => {
  // A chunk is 24 frames: 5 s is 60 frames at 12 fps.
  expect(chunksBehind(12)).toBe(3)
  expect(chunksBehind(1)).toBe(1)
  expect(chunksAhead(12)).toBe(3)
})

test('the picture sizes to the terminal within its limits', () => {
  const wide = sizeFor(1920, 1080, 192, 60, false)
  expect(wide.columns).toBeLessThanOrEqual(120)
  expect(wide.rows).toBeLessThanOrEqual(33)
  const narrow = sizeFor(1920, 1080, 40, 40, false)
  expect(narrow.columns).toBe(40)
  const tiny = sizeFor(1920, 1080, 12, 40, false)
  expect(tiny.columns).toBeGreaterThan(0)
  expect(sizeFor(1920, 1080, 294, 30, true).rows).toBeLessThanOrEqual(18)
})

test('compare keeps the same moment across clips', () => {
  const a = { dir: '/a', count: 200, fps: 12, duration: 16.7 }
  const b = { dir: '/b', count: 60, fps: 6, duration: 10 }
  expect(sameMoment(a, b, 60)).toBe(30)
  expect(sameMoment(a, b, 199)).toBe(59)
})

test('the play control says where the clip is', () => {
  expect(playWord(false, 0, 100)).toBe('▶ Play')
  expect(playWord(false, 40, 100)).toBe('▶ Resume')
  expect(playWord(true, 40, 100)).toBe('❚❚ Pause')
  expect(playWord(false, 99, 100)).toBe('↺ Replay')
})

test('the report says which checks were fixed or broke', () => {
  const before = [{ name: 'a', ok: false }, { name: 'b', ok: true }, { name: 'c', ok: true }]
  const now = [{ name: 'a', ok: true }, { name: 'b', ok: false }, { name: 'c', ok: true }]
  const { fixed, broken } = checkDiff(now, before)
  expect(fixed.map(c => c.name)).toEqual(['a'])
  expect(broken.map(c => c.name)).toEqual(['b'])
})

test('side by side names the latest change up to the moment shown', () => {
  const shown = {
    path: '/a', width: 1, height: 1, title: 't', generation: 1,
    checks: [{ name: 'nav', ok: true, at: 6 }, { name: 'hero', ok: true, at: 8 }, { name: 'footer', ok: true, at: 11 }],
    compare: { path: '/b', width: 1, height: 1, title: 'b', generation: 2, checks: [{ name: 'nav', ok: true }, { name: 'hero', ok: false }, { name: 'footer', ok: false }] },
  }
  expect(changeAt(shown, 5)).toBe(null)
  expect(changeAt(shown, 9)?.check.name).toBe('hero')
  expect(changeAt(shown, 12)?.check.name).toBe('footer')
  expect(changeAt(shown, 12)?.was).toBe(false)
})

test('temp files are scratch, finished work is not', () => {
  expect(isScratch('/tmp/claude-show-your-work/a.png')).toBe(true)
  expect(isScratch('/private/tmp/claude-501/x/qa.webm')).toBe(true)
  expect(isScratch('/var/folders/rq/x/T/shot.png')).toBe(true)
  expect(isScratch('/Users/u/Movies/launch.mp4')).toBe(false)
})

test('the call row is one short line', () => {
  const line = toolLine('mcp__show-your-work__show_video', { path: '/tmp/x/qa.webm', title: 'Agent QA', compare: '/tmp/b.webm', compare_label: 'Live', checks: [1, 2, 3] }, false)
  expect(line).toBe('▶ Video · Agent QA · vs Live · 3 checks')
  expect(toolLine('mcp__show-your-work__show_image', { path: '/a/b/shot.png' }, true)).toBe('▣ Loading image · shot.png')
})

test('open page follows the latest check with a url', () => {
  const shown = { path: '/a', width: 1, height: 1, title: 't', generation: 1, url: 'http://localhost:3000/',
    checks: [{ name: 'a', ok: true, at: 2, url: 'http://localhost:3000/#slide-07' }, { name: 'b', ok: true, at: 6, url: 'http://localhost:3000/#slide-10' }] }
  expect(urlAt(shown, 1)).toBe('http://localhost:3000/')
  expect(urlAt(shown, 3)).toBe('http://localhost:3000/#slide-07')
  expect(urlAt(shown, 9)).toBe('http://localhost:3000/#slide-10')
})

test('the resume command names this session', () => {
  expect(resumeCommand('abc-123')).toBe('claude stop abc-123; CLAUDE_CODE_DISABLE_AGENT_VIEW=1 claude --resume abc-123')
  expect(resumeCommand('')).toBe('CLAUDE_CODE_DISABLE_AGENT_VIEW=1 claude --resume')
})

test('check results read as words', () => {
  expect(resultWords([{ name: 'a', ok: true }, { name: 'b', ok: false }, { name: 'c', ok: false }])).toBe('2 checks fail')
  expect(resultWords([{ name: 'a', ok: false }])).toBe('1 check fails')
  expect(resultWords([{ name: 'a', ok: true }, { name: 'b', ok: true }])).toBe('all 2 checks pass')
  expect(resultWords([])).toBe('')
})


test('the bar is a few wide buttons that still cover every cell', () => {
  const chunks = barChunks(70, 20)
  expect(chunks.length).toBeLessThanOrEqual(20)
  expect(chunks.map(c => c.label).join('').length).toBe(70)
  expect(chunks.map(c => c.label).join('')[20]).toBe('●')
  expect(chunks[0]!.isAhead).toBe(false)
  expect(chunks.at(-1)!.isAhead).toBe(true)
})

test('both runs line up on the steps they share', () => {
  const updated = [{ name: 'nav', ok: true, at: 6.2 }, { name: 'hero', ok: true, at: 7.9 }, { name: 'end', ok: true, at: 14.6 }]
  const original = [{ name: 'nav', ok: true, at: 5.9 }, { name: 'hero', ok: false, at: 7.5 }, { name: 'end', ok: true, at: 14.3 }]
  const pts = anchors(updated, original)
  expect(pts.length).toBe(3)
  expect(Math.abs(mapTime(pts, 7.9, 18.9, 18.5) - 7.5) < 0.01).toBe(true)
})

test('runs line up by how their frames look, even where one waits longer', () => {
  // the original holds its 3rd frame three times as long (a slower load)
  const frame = (v: number) => Array(8).fill(v)
  const updated = [0, 40, 80, 120, 160, 200].map(frame)
  const original = [0, 40, 80, 80, 80, 120, 160, 200].map(frame)
  const match = matchOf(align(updated, original), updated.length)
  expect(match).toEqual([0, 1, 4, 5, 6, 7])
})

test('a screen only one run shows can not pull the other out of time', () => {
  // the same steps at the same pace; the fixed run then shows a message the
  // broken one never does, for its last third
  const frame = (v: number) => Array(8).fill(v)
  const fixed = Array.from({ length: 30 }, (_, i) => frame(i < 20 ? i * 5 : 250))
  const broken = Array.from({ length: 30 }, (_, i) => frame(i < 20 ? i * 5 : 95))
  const match = matchOf(align(fixed, broken, 0.01, 3, 0.02), fixed.length)
  match.forEach((j, i) => expect(Math.abs(j - i)).toBeLessThanOrEqual(3))
  expect(match.at(-1)).toBe(29)
})

test('the QA line totals the summary', () => {
  expect(qaTotals([{ label: 'a', ok: true, passed: 4, total: 4 }, { label: 'b', ok: false, passed: 1, total: 3 }])).toEqual({ passed: 5, total: 7 })
  expect(qaTotals([], [{ name: 'x', ok: true }, { name: 'y', ok: false }])).toEqual({ passed: 1, total: 2 })
  // Plain summary lines (label and tick, no numbers) count one each, so the QA card shows.
  expect(qaTotals([{ label: 'a', ok: true }, { label: 'b', ok: true }, { label: 'c', ok: false }])).toEqual({ passed: 2, total: 3 })
  expect(qaTotals([{ label: 'a', ok: true }], [{ name: 'x', ok: true }, { name: 'y', ok: false }])).toEqual({ passed: 1, total: 2 })
  expect(qaTotals()).toEqual({ passed: 0, total: 0 })
})

test('sidebar text wraps whole words and never loses any', () => {
  const lines = wrapWords('Stats moved inside the cards on every slide', 12)
  expect(lines.every(l => l.length <= 12)).toBe(true)
  expect(lines.join(' ')).toBe('Stats moved inside the cards on every slide')
  expect(wrapWords('short', 12)).toEqual(['short'])
})

test('changes page by rows and an item never splits', () => {
  const pages = pagesOf([{ item: 'a', rows: 2 }, { item: 'b', rows: 2 }, { item: 'c', rows: 1 }], 3)
  expect(pages).toEqual([['a'], ['b', 'c']])
})


test('changes list in clip order, untimed ones last', () => {
  const out = inClipOrder([{ title: 'focus', at: 14 }, { title: 'note' }, { title: 'hover', at: 9 }, { title: 'cards', at: 7 }])
  expect(out.map(c => c.title)).toEqual(['cards', 'hover', 'focus', 'note'])
})

test('wrapping never hangs on a tiny width', () => {
  expect(wrapWords('Stats moved inside', 0).length).toBeGreaterThan(0)
  expect(wrapWords('Stats moved inside', -7).join('')).toBe('Statsmovedinside')
})

test('a change lights when a seek lands just before it', () => {
  const changes = [{ title: 'a', at: 0.5 }, { title: 'b', at: 1.04 }]
  expect(liveChange(changes, 12 / 12, 12)).toBe(1)
  expect(liveChange(changes, 0.2, 12)).toBe(-1)
})

test('checks without a time never claim 0:00', () => {
  const shown = { path: '/a', width: 1, height: 1, title: 'a', generation: 1, checks: [{ name: 'x', ok: true }], compare: { path: '/b', width: 1, height: 1, title: 'b', generation: 2, checks: [{ name: 'x', ok: false }] } }
  expect(changeAt(shown, 5)).toBe(null)
})

test('times only stay when they point somewhere', () => {
  const same = [{ title: 'a', at: 3 }, { title: 'b', at: 3 }]
  expect(timesThatMean(same, true)!.every(c => c.at === undefined)).toBe(true)
  expect(timesThatMean([{ title: 'a', at: 1 }, { title: 'b', at: 4 }], true)!.map(c => c.at)).toEqual([1, 4])
  expect(timesThatMean([{ title: 'a', at: 1 }, { title: 'b', at: 4 }], false)!.every(c => c.at === undefined)).toBe(true)
  expect(timesThatMean([{ title: 'a', at: 2 }], true)![0]?.at).toBe(2)
  expect(timesThatMean(undefined, true)).toBeUndefined()
})

test('earlier versions arrive as paths, notes, or JSON text', () => {
  expect(versionsOf(['/a', { path: '/b', note: 'cloud photo' }])).toEqual([{ path: '/a' }, { path: '/b', note: 'cloud photo' }])
  expect(versionsOf('["/a"]')).toEqual([{ path: '/a' }])
  expect(versionsOf('/a')).toEqual([{ path: '/a' }])
  expect(versionsOf(undefined)).toEqual([])
  expect(noteOf([{ title: 'Centred play' }, { title: 'Cleaner card' }], undefined, 'Hero')).toBe('Centred play and 1 more')
  expect(noteOf(undefined, undefined, 'Hero')).toBe('Hero')
})

test('long clips are matched on sampled frames, then spread back', () => {
  expect(strideFor(100, 120)).toBe(1)
  expect(strideFor(482, 480)).toBe(3)
  expect(spreadMatch([0, 1, 1], 2, 6, 10)).toEqual([0, 1, 2, 3, 2, 3])
  expect(spreadMatch([0, 5], 3, 6, 12)).toEqual([0, 1, 2, 12, 12, 12])
})

test('matching two long clips stays quick', () => {
  const clip = (seed: number) => Array.from({ length: 240 }, (_, i) => Array.from({ length: 576 }, (_, k) => (i * 7 + k * seed) % 256))
  const started = Date.now()
  const path = align(clip(3), clip(5))
  const took = Date.now() - started
  expect(path.length).toBeGreaterThan(239)
  expect(took).toBeLessThan(4000)
})

test('a blank opening of any flat tone is found, and the times move with it', () => {
  const frame = (t: number, lo: number, hi: number) => `frame:0 pts:0 pts_time:${t}\nlavfi.signalstats.YLOW=${lo}\nlavfi.signalstats.YHIGH=${hi}\n`
  // off-white, then a light grey with a spinner, then the page
  const log = frame(0, 240, 246) + frame(0.1, 228, 236) + frame(0.2, 228, 239) + frame(0.3, 40, 230)
  expect(leadFrom(log, 12)).toBe(0.3)
  expect(leadFrom(frame(0, 30, 200), 12)).toBe(0)
  expect(leadFrom(frame(0, 250, 252) + frame(0.1, 251, 252), 12)).toBe(0)
  expect(leadFrom('', 12)).toBe(0)
  expect(shiftTimes([{ title: 'a', at: 2 }, { title: 'b' }, { title: 'c', at: 0.3 }], 0.64)).toEqual([{ title: 'a', at: 1.36 }, { title: 'b' }, { title: 'c', at: 0 }])
})

test('a file version keys one frames folder', () => {
  expect(keyOf('/a.mp4|10|1')).toBe(keyOf('/a.mp4|10|1'))
  expect(keyOf('/a.mp4|10|1')).not.toBe(keyOf('/a.mp4|10|2'))
  expect(keyOf('/a.mp4|10|1')).toMatch(/^[0-9a-f]+$/)
})

test('long tab names are shortened so every tab fits', () => {
  expect(tabLabel('Original')).toBe('Original')
  expect(tabLabel('Before (blurred photo background)')).toBe('Before (blu…')
})

test('a handle is read from #id or id', () => {
  expect(handleOf('#7F3A')).toBe('7f3a')
  expect(handleOf(' 7f3a ')).toBe('7f3a')
  expect(handleOf('')).toBeUndefined()
  expect(handleOf(undefined)).toBeUndefined()
})

test('a typed screenshot name matches the narrow-space one macOS writes', () => {
  expect(looseName('Screenshot 2026-10-04 at 11.37.02 AM.png')).toBe(looseName('Screenshot 2026-10-04 at 11.37.02 AM.png'))
  expect(looseName('a b.png')).toBe('a b.png')
  expect(looseName('café.png')).toBe(looseName('café.png'))
})

test('a PNG header gives its size without any tool (Linux)', () => {
  // 1x1 PNG
  const onePx = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  expect(pngDims(onePx)).toEqual({ width: 1, height: 1 })
  expect(pngDims(btoa('not a png at all, just some text here'))).toBe(null)
})

test('with the cell size known, a small picture gets a box its own pixels fill', () => {
  // 1600 px on Retina cells of 25 x 54 px: Ghostty never draws it larger.
  const box = fit(1600, 615, 105, 22, { width: 25, height: 54 })
  expect(box.rows).toBe(11)
  expect(box.columns).toBe(62)
})

test('with the cell size known, a big picture is never wider than its box', () => {
  const px = { width: 15.4, height: 33 }
  const box = fit(1800, 1125, 105, 22, px)
  // Drawn at the box's height, the picture's width still fits the columns.
  expect((box.rows * px.height * 1800) / 1125).toBeLessThanOrEqual(box.columns * px.width)
  expect(box.rows).toBeLessThanOrEqual(22)
})

test('the cell size comes from the tty size, and is unknown without pixels', () => {
  expect(cellOf('40 150 2400 1280\n')).toEqual({ width: 16, height: 32 })
  expect(cellOf('40 150 2400 1280\n', 2)).toEqual({ width: 32, height: 64 })
  expect(cellOf('40 150 0 0')).toBe(null)
  expect(cellOf('')).toBe(null)
})

test('video frames are cut as wide as the window shows them, up to 2400 px', () => {
  // A full Retina window: 157 by 39 cells of 32.1 by 68.5 screen pixels.
  const term = { columns: 157, rows: 39 }, px = { width: 32.1, height: 68.5 }
  expect(frameWidth(1600, 800, term, px)).toBe(2400)
  const tall = frameWidth(1600, 1000, term, px)
  expect(tall).toBeGreaterThan(1600)
  expect(tall).toBeLessThan(2400)
  // Half a window: narrower than 1600, so the frames are smaller too.
  expect(frameWidth(1600, 800, { columns: 78, rows: 39 }, px)).toBeLessThan(1600 * 1.5)
  // Nothing measured: 1600 at most, as before.
  expect(frameWidth(3000, 1500, null, null)).toBe(1600)
  expect(frameWidth(1280, 720, null, null)).toBe(1280)
})

test('versions compare by number, not by text', () => {
  expect(isAtLeast('2.1.296', '2.1.295')).toBe(true)
  expect(isAtLeast('2.1.295', '2.1.295')).toBe(true)
  expect(isAtLeast('2.1.294', '2.1.295')).toBe(false)
  expect(isAtLeast('2.1.1000', '2.1.295')).toBe(true)
  expect(isAtLeast('2.2.0', '2.1.295')).toBe(true)
  expect(isAtLeast('2.1.296-dev', '2.1.295')).toBe(true)
})

test('only an installed copy sends usage data, never one loaded from a folder', () => {
  expect(isInstalledCopy('/Users/a/.claude/plugins/cache/iamumeransari/show-your-work/0.6.0')).toBe(true)
  expect(isInstalledCopy('/Users/a/claude-mods/claude-show-your-work')).toBe(false)
  expect(isInstalledCopy('/Users/a/Client Sites/show-your-work')).toBe(false)
})

test('a docked pane sizes to its own width, not the whole screen', () => {
  expect(paneSize({ columns: 267, rows: 60 }, { bodyColumns: 45 })).toEqual({ columns: 45, rows: 60 })
  // A pane docked under the chat is short: the picture fits its height too.
  expect(paneSize({ columns: 160, rows: 60 }, { bodyColumns: 150, scroll: { bodyRows: 12 } })).toEqual({ columns: 150, rows: 12 })
  expect(paneSize({ columns: 160, rows: 60 }, { bodyColumns: 150, bodyRows: 14 })).toEqual({ columns: 150, rows: 14 })
  expect(paneSize({ columns: 120, rows: 40 }, {})).toEqual({ columns: 120, rows: 40 })
  expect(paneSize(undefined, { bodyColumns: 45 })).toBe(undefined)
  // The narrower width gives a smaller picture.
  expect(sizeFor(480, 240, 45 - 6, 60, true).columns).toBeLessThanOrEqual(39)
})

test('side by side is cut tall enough to fill the window, never taller than its sides', () => {
  expect(pairHeightOf({ height: 1000 }, { height: 1000 })).toBe(720)
  expect(pairHeightOf({ height: 1080 }, { height: 541 })).toBe(540)
  expect(pairHeightOf({ height: 0 }, { height: 0 })).toBe(720)
})

// Retina cell: 9×18 points, 2 pixels a point.
const RETINA = { width: 18, height: 36 }

test('the layout puts the report beside the picture only when there is one and room for it', () => {
  expect(layoutOf({ columns: 160, rows: 50, isPane: false, hasReport: true }).isWide).toBe(true)
  expect(layoutOf({ columns: 160, rows: 50, isPane: false, hasReport: false }).isWide).toBe(false)
  expect(layoutOf({ columns: 100, rows: 50, isPane: false, hasReport: true }).isWide).toBe(false)
  // Beside the report, the picture has less room.
  expect(layoutOf({ columns: 160, rows: 50, isPane: false, hasReport: true }).maxCols).toBeLessThan(layoutOf({ columns: 160, rows: 50, isPane: false, hasReport: false }).maxCols)
  // A short pane keeps its controls: the picture gets what's left.
  expect(layoutOf({ columns: 150, rows: 20, isPane: true, hasReport: false }).maxRows).toBe(8)
})

test('a picture made at the prepared width fills its box, at any window size and shape', () => {
  for (const [columns, rows] of [[80, 30], [120, 40], [160, 50], [240, 70], [300, 90]] as const) {
    for (const [w, h] of [[2400, 1500], [1600, 1000], [1920, 1080], [900, 1600], [3000, 600], [400, 300]] as const) {
      const made = frameWidth(w, h, { columns, rows }, RETINA)
      const madeHeight = Math.round((made * h) / w)
      const layout = layoutOf({ columns, rows, isPane: false, hasReport: false })
      const target = targetBox(made, madeHeight, layout, RETINA)
      const drawn = drawBox(made, madeHeight, layout, RETINA)
      // Small in a big box was the bug: the drawn box is the whole target, or within a cell of it.
      if (made < 2400) {
        expect(drawn.columns).toBeGreaterThanOrEqual(target.columns - 1)
        expect(drawn.rows).toBeGreaterThanOrEqual(target.rows - 1)
      }
      expect(drawn.columns).toBeLessThanOrEqual(layout.maxCols)
      expect(drawn.rows).toBeLessThanOrEqual(layout.maxRows)
    }
  }
})

test('a picture short of pixels is drawn whole at its own size, never cropped or stretched', () => {
  const layout = layoutOf({ columns: 200, rows: 60, isPane: false, hasReport: false })
  const target = targetBox(800, 500, layout, RETINA)
  const drawn = drawBox(800, 500, layout, RETINA)
  expect(drawn.columns).toBeLessThan(target.columns)
  // Its own shape: 800×500 is 8:5, in 2:1 cells.
  expect(Math.abs((drawn.columns * RETINA.width) / (drawn.rows * RETINA.height) - 1.6)).toBeLessThan(0.15)
  // And the pixels that would fill the target are asked for, within limits.
  expect(pixelsFor(target, RETINA)).toBeGreaterThan(800)
  expect(pixelsFor({ columns: 500 }, RETINA)).toBe(2400)
  expect(pixelsFor({ columns: 5 }, RETINA)).toBe(320)
  expect(pixelsFor(target, null)).toBe(1600)
})

test('every tour stop but the last asks for one thing to do', () => {
  for (const s of STOPS.slice(0, -1)) {
    expect(s.tag.length).toBeGreaterThan(0)
    expect(!!s.goal).toBe(true)
  }
  expect(STOPS.at(-1)!.goal).toBeUndefined()
})

test('a file that will not open says why, in words', () => {
  const at = '/home/a/clip.mp4'
  expect(openFailure({ exitCode: 127, stderr: '' }, 'videos', at)).toBe("Couldn't open it: xdg-open is missing. Install xdg-utils and try again.")
  expect(openFailure({ exitCode: 2, stderr: '' }, 'videos', at)).toBe(`Couldn't open it: nothing is at ${at} any more.`)
  expect(openFailure({ exitCode: 3, stderr: 'xdg-open: no method available for opening' }, 'videos', at)).toBe("Couldn't open it: no app on this computer is set to open videos.")
  expect(openFailure({ exitCode: 4, stderr: 'gio: Failed to launch: permission denied\n' }, 'videos', at)).toBe("Couldn't open it: gio: Failed to launch: permission denied")
  expect(openFailure({ exitCode: 4, stderr: '' }, 'pictures', at)).toBe("Couldn't open it: the app for pictures failed to start.")
  // macOS open: exit 1, with its reason in the text.
  expect(openFailure({ exitCode: 1, stderr: 'No application knows how to open URL file:///a.xyz' }, 'pictures', at)).toBe("Couldn't open it: no app on this computer is set to open pictures.")
  expect(openFailure({ exitCode: 1, stderr: 'The file /a.png does not exist.' }, 'pictures', at)).toBe(`Couldn't open it: nothing is at ${at} any more.`)
})

test('Warp, WezTerm and Konsole get a way to turn pictures on; others keep their notice', () => {
  expect(causeOf(false, 'warp')).toBe('off')
  expect(causeOf(false, 'wezterm')).toBe('off')
  expect(causeOf(false, 'konsole')).toBe('off')
  // Already turned on and still not drawing: the terminal itself can't.
  expect(causeOf(false, 'warp', true)).toBe('terminal')
  expect(causeOf(false, 'ghostty')).toBe('background')
  expect(causeOf(false, 'apple_terminal')).toBe('terminal')
  expect(causeOf(true, 'warp')).toBe('tmux')
})

test('the line goes in the profile the shell reads, only inside that terminal', () => {
  expect(profileOf('/bin/zsh', '/Users/a', true)).toBe('/Users/a/.zshrc')
  expect(profileOf('/bin/bash', '/Users/a', true)).toBe('/Users/a/.bash_profile')
  expect(profileOf('/bin/bash', '/home/a', false)).toBe('/home/a/.bashrc')
  expect(profileOf('/usr/bin/fish', '/home/a', false)).toBe('/home/a/.config/fish/config.fish')
  expect(profileOf('/bin/tcsh', '/home/a', false)).toBe(null)
  expect(profileLine('warp', '/bin/zsh')).toBe('if [ "$TERM_PROGRAM" = "WarpTerminal" ]; then export CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1; fi # show-your-work: pictures in Warp')
  expect(profileLine('konsole', '/usr/bin/fish')).toBe('if test -n "$KONSOLE_VERSION"; set -gx CLAUDE_CODE_FORCE_TERMINAL_IMAGES 1; end # show-your-work: pictures in Konsole')
})

test('Picture size: Large is Standard times one fixed step', () => {
  const room = { columns: 250, rows: 70, isPane: false, hasReport: false }
  expect(layoutOf(room).maxCols).toBe(120)
  expect(layoutOf(room).maxRows).toBe(38)
  settings.standard_size = false
  try {
    expect(layoutOf(room).maxCols).toBe(180)
    expect(layoutOf(room).maxRows).toBe(57)
    // Same window, same picture, same box, every time.
    expect(targetBox(1600, 1000, layoutOf(room), { width: 8, height: 16 })).toEqual(targetBox(1600, 1000, layoutOf(room), { width: 8, height: 16 }))
  } finally {
    settings.standard_size = true
  }
})

test('Orca draws a file only from the temp folder and only up to 2 MB', () => {
  expect(terminalOf({ program: 'Orca', term: 'xterm-256color', kitty: false, konsole: false })).toBe('orca')
  const tmp = '/var/folders/x/T/claude-show-your-work-501'
  expect(orcaReads(`${tmp}/a-3-w1800.png`, 1_500_000, tmp)).toBe(true)
  expect(orcaReads(`${tmp}/store/0a8d43.png`, 2_000_000, tmp)).toBe(true)
  expect(orcaReads(`${tmp}/a-3.png`, 4_700_000, tmp)).toBe(false)
  expect(orcaReads('/Users/a/project/.show-your-work/0a8d43.png', 300_000, tmp)).toBe(false)
  expect(orcaReads(`${tmp}-other/a.png`, 300_000, tmp)).toBe(false)
})

test('in Orca, a picture saved again at the same path gets a new copy', async () => {
  const saved = { terminalName: state.terminalName, sendBytes: state.sendBytes, TMP: state.TMP }
  Object.assign(state, { terminalName: 'orca', sendBytes: false, TMP: '/t' })
  try {
    let st = { size: 300_000, mtimeMs: 1 }
    const runs: string[][] = []
    const $: any = {
      fs: { stat: async () => st },
      // A shrink prints the copy it made: its 5th argument.
      process: {
        run: async (argv: string[]) => {
          runs.push(argv)
          return { exitCode: 0, stdout: argv[4] ?? '' }
        },
      },
    }
    const first: any = await pngSource($, '/p/shot.png')
    expect(first.file.startsWith('/t/o-')).toBe(true)
    st = { size: 9_000_000, mtimeMs: 2 }
    const second: any = await pngSource($, '/p/shot.png')
    expect(second.file.startsWith('/t/b-')).toBe(true)
    expect(runs.length).toBe(2)
    expect((await pngSource($, '/p/shot.png') as any).file).toBe(second.file)
    expect(runs.length).toBe(2)
  } finally {
    Object.assign(state, saved)
  }
})
