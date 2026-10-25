// Sizing, from the room a player has to the box it draws and the pixels its
// picture needs, and the helpers that fit text to a width.
import type { EngineInterface } from 'claude-code'

import { event } from './diagnostics'
import { settings, state } from './state'

// The window's fill: a step lighter than a dark terminal, so it reads as one panel.
const PANEL = '#2c2e35'
// The QA report beside the picture, and the width the window needs for it.
export const SIDE = 40
// The sidebar's fill: darker than the window, so the report stands apart.
export const SIDEBAR = '#1d1e23'
const WIDE_ENOUGH = 110

// One path from the room a player has to the box it draws and the pixels its
// picture needs:
//   layoutOf(room)        the space: columns and rows for the picture, report beside or below
//   targetBox(w, h, ...)  the box a picture of that shape fills in it
//   pixelsFor(box, cell)  the screen pixels that box needs (PX_MIN to PX_MAX)
//   drawBox(w, h, ...)    the box drawn: the target, cut down to the picture's own pixels
// The terminal draws a picture at its own pixel size at most, so pictures and
// frames are made as wide as their box (frameWidth when prepared, sharpen
// when a player needs more), and drawBox keeps a picture that's still short
// of pixels whole instead of small in a big box.
const PX_MIN = 320
export const PX_MAX = 2400
export type Room = { columns: number; rows: number; isPane: boolean; hasReport: boolean }
export type Layout = { isWide: boolean; inner: number; maxCols: number; maxRows: number }
export function layoutOf(room: Room): Layout {
  const isWide = room.hasReport && room.columns - 8 >= WIDE_ENOUGH
  // The window's border and padding; a pane has no row border of its own.
  const inner = room.columns - (room.isPane ? 6 : 10)
  const space = inner - (isWide ? SIDE + 3 : 0)
  // Picture size (settings): Large is Standard times SIZE_STEP, every limit
  // scaled by the same fixed factor, so a picture's size stays predictable.
  const step = sizeStep()
  const maxCols = Math.max(1, Math.max(Math.min(space, 24), Math.min(space, Math.round((room.isPane ? 220 : 120) * step))))
  // Inline, a picture takes at most 55% of the screen's height (82% in Large);
  // a pane keeps 12 rows for its controls.
  const fullRows = room.isPane ? Math.max(6, room.rows - 12) : Math.max(8, Math.min(Math.round(40 * step), Math.floor(room.rows * 0.55 * step)))
  // iTerm2 draws a picture only while all of it is on screen: the player
  // (title, picture, controls) fits in the window there.
  const maxRows = state.terminalName === 'iterm2' && !room.isPane ? Math.max(6, Math.min(fullRows, room.rows - 16)) : fullRows
  return { isWide, inner, maxCols, maxRows }
}
export const targetBox = (width: number, height: number, layout: Layout, px: Cell | null) =>
  fit(width, height, layout.maxCols, layout.maxRows, px, false)
export const drawBox = (width: number, height: number, layout: Layout, px: Cell | null) =>
  fit(width, height, layout.maxCols, layout.maxRows, px, true)
// Enough for the box's width and, given the picture's shape, its height:
// boxes are whole rows, so a wide picture sized by width alone falls short.
// Large (Picture size) scales every size limit by this one factor.
export const SIZE_STEP = 1.5
export const sizeStep = () => (settings.standard_size ? 1 : SIZE_STEP)
export const pixelsFor = (box: { columns: number; rows?: number }, px: Cell | null, aspect = 0) =>
  px ? Math.max(PX_MIN, Math.min(Math.round(PX_MAX * sizeStep()), Math.ceil(Math.max(box.columns * px.width, (box.rows ?? 0) * px.height * aspect) / 2) * 2)) : 1600

// Fits a picture in a box of cells, its own shape. With the cell's size in
// pixels known and `isCapped`, never past the picture's own pixels; unknown,
// a cell is about twice as tall as wide.
export function fit(width: number, height: number, maxCols: number, maxRows: number, px?: Cell | null, isCapped = true) {
  if (px) {
    const scale = Math.min(isCapped ? 1 : Number.POSITIVE_INFINITY, (maxCols * px.width) / width, (maxRows * px.height) / height)
    // A hair over, so a box that fits exactly (38 rows, computed as 37.999…) keeps its last row.
    const rows = Math.max(1, Math.min(255, Math.floor((height * scale) / px.height + 1e-9)))
    const shown = isCapped ? Math.min(height, rows * px.height) : rows * px.height
    const columns = Math.max(1, Math.min(255, maxCols, Math.ceil((shown * width) / height / px.width)))
    return { columns, rows }
  }
  let columns = Math.max(1, Math.min(255, maxCols))
  let rows = Math.ceil((columns * height) / width / 2)
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(1, Math.ceil((rows * 2 * width) / height))
  }

  return { columns: Math.min(255, columns), rows: Math.max(1, Math.min(255, rows)) }
}

// The width a picture or clip is made at when it's prepared: what an inline
// player in this terminal needs (see layoutOf). 1600 px at most while unmeasured.
export function frameWidth(width: number, height: number, term: { columns: number; rows: number } | null, px: Cell | null) {
  if (!term || !px || !width || !height) return Math.min(1600, width)
  const layout = layoutOf({ columns: term.columns, rows: term.rows, isPane: false, hasReport: false })
  return pixelsFor(targetBox(width, height, layout, px), px, width / height)
}

// The drawn box for `room` columns already free of chrome (the pair view).
export function sizeFor(width: number, height: number, room: number, rows: number, isPane: boolean, px: Cell | null = state.cell) {
  return drawBox(width, height, layoutOf({ columns: room + (isPane ? 6 : 10), rows, isPane, hasReport: false }), px)
}

// The terminal's cell in pixels, from the size its tty reports; null where it
// reports none (tmux, a relay), and measured again when the window changes.
export type Cell = { width: number; height: number }
export const CELL_SH = `perl -e 'open(T, "</dev/tty") or exit 1; my $w = " " x 8; ioctl(T, ($^O eq "darwin" ? 0x40087468 : 0x5413), $w) or exit 1; print join(" ", unpack("S4", $w))'`
// The tty's size is in screen pixels in Ghostty, kitty and WezTerm (measured:
// a 157-column Ghostty window on a 1280-point Retina screen reports 2520 px).
// Multiplying it by the screen's scale, as 0.6.0 did, made every cell twice
// its size, so pictures were made twice as wide as needed and, in Large, drawn
// in boxes half as wide as they should be. A cell under POINT_CELL wide on a
// Retina screen can only be points (no readable font is that narrow in
// pixels), so only then is it scaled.
const POINT_CELL = 10
export function cellOf(stdout: string, scale = 1): Cell | null {
  const [rows, columns, x, y] = stdout.trim().split(/\s+/).map(Number)
  if (!(rows && columns && x && y)) return null
  const unit = scale > 1 && x / columns < POINT_CELL ? scale : 1
  return { width: (x / columns) * unit, height: (y / rows) * unit }
}
const SCALE_SH = `osascript -l JavaScript -e 'ObjC.import("AppKit"); $.NSScreen.mainScreen.backingScaleFactor'`
export async function measureCells($: EngineInterface) {
  const [r, s] = await Promise.all([
    $.process.run(['sh', '-c', CELL_SH]).catch(() => null),
    state.isMac ? $.process.run(['sh', '-c', SCALE_SH]).catch(() => null) : null,
  ])
  // A measure Claude Code cancelled (a newer draw replaced the one that asked,
  // as happens many times while a window edge is dragged) says nothing about
  // the terminal: the last size stands. Dropping it fell back to guessed 2:1
  // cells, a picture of the wrong shape until the next resize.
  if (!r) return void event('measure', { state: 'cancelled', kept: state.cell && `${state.cell.width.toFixed(2)}x${state.cell.height.toFixed(2)}` })
  const scale = Number(s?.stdout.trim()) || 1
  state.cell = r.exitCode === 0 ? cellOf(r.stdout, scale) : null
  const [rows, columns] = (r.exitCode === 0 ? r.stdout : '').trim().split(/\s+/).map(Number)
  state.termSize = rows && columns ? { columns, rows } : null
  event('measure', { state: 'measured', tty: r.stdout.trim(), scale, cell: state.cell && `${state.cell.width.toFixed(2)}x${state.cell.height.toFixed(2)}` })
}
// Players of different widths each ask: one measure a second at most, the
// last ask still measured.
let measuredAt = 0
export async function remeasure($: EngineInterface): Promise<boolean> {
  const wait = measuredAt + 1000 - (await $.clock.now())
  if (wait > 0) await $.clock.sleep(wait)
  measuredAt = await $.clock.now()
  const was = state.cell
  await measureCells($)
  return was?.width !== state.cell?.width || was?.height !== state.cell?.height
}

// The viewport is the whole screen; a docked pane is narrower and shorter, so
// it sizes to its own body.
export type PaneProps = { bodyColumns?: number; bodyRows?: number; scroll?: { bodyRows?: number } }
export const paneSize = (viewport: { columns: number; rows: number } | undefined, props: PaneProps) => {
  if (!viewport) return viewport
  const rows = props.bodyRows ?? props.scroll?.bodyRows
  return { columns: props.bodyColumns || viewport.columns, rows: rows || viewport.rows }
}

export const clock = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`

// One line, whatever the length: cut at a word, with … where it was cut.
export function oneLine(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  width = Math.max(4, Math.floor(width))
  if (flat.length <= width) return flat
  const cut = flat.slice(0, width - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > width / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`
}

// A tab name short enough that every tab fits on one line and stays clickable.
export const tabLabel = (text: string, max = 12) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

// Words wrapped to lines of at most width, so the whole text is always shown.
export function wrapWords(text: string, width: number): string[] {
  width = Math.max(1, Math.floor(width))
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let w = word; w; ) {
      const piece = w.length > width ? w.slice(0, width) : w
      w = w.slice(piece.length)
      if (!line) line = piece
      else if (line.length + 1 + piece.length <= width) line += ` ${piece}`
      else {
        lines.push(line)
        line = piece
      }
    }
  }
  return lines.length || line ? [...lines, line].filter(Boolean) : ['']
}

// Splits wrapped items into pages that each fit rows; an item never splits.
export function pagesOf<T>(items: { item: T; rows: number }[], rows: number): T[][] {
  const pages: T[][] = [[]]
  let used = 0
  for (const { item, rows: need } of items) {
    if (used + need > rows && pages.at(-1)!.length) {
      pages.push([])
      used = 0
    }
    pages.at(-1)!.push(item)
    used += need
  }
  return pages
}
