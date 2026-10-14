import { state } from './state';
// The window's fill: a step lighter than a dark terminal, so it reads as one panel.
const PANEL = '#2c2e35';
// The QA report beside the picture, and the width the window needs for it.
export const SIDE = 40;
// The sidebar's fill: darker than the window, so the report stands apart.
export const SIDEBAR = '#1d1e23';
const WIDE_ENOUGH = 110;
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
const PX_MIN = 320;
export const PX_MAX = 2400;
export function layoutOf(room) {
    const isWide = room.hasReport && room.columns - 8 >= WIDE_ENOUGH;
    // The window's border and padding; a pane has no row border of its own.
    const inner = room.columns - (room.isPane ? 6 : 10);
    const space = inner - (isWide ? SIDE + 3 : 0);
    const maxCols = Math.max(1, Math.max(Math.min(space, 24), Math.min(space, room.isPane ? 220 : 120)));
    // Inline, a picture takes at most 55% of the screen's height; a pane keeps 12 rows for its controls.
    const maxRows = room.isPane ? Math.max(6, room.rows - 12) : Math.max(8, Math.min(40, Math.floor(room.rows * 0.55)));
    return { isWide, inner, maxCols, maxRows };
}
export const targetBox = (width, height, layout, px) => fit(width, height, layout.maxCols, layout.maxRows, px, false);
export const drawBox = (width, height, layout, px) => fit(width, height, layout.maxCols, layout.maxRows, px, true);
// Enough for the box's width and, given the picture's shape, its height:
// boxes are whole rows, so a wide picture sized by width alone falls short.
export const pixelsFor = (box, px, aspect = 0) => px ? Math.max(PX_MIN, Math.min(PX_MAX, Math.ceil(Math.max(box.columns * px.width, (box.rows ?? 0) * px.height * aspect) / 2) * 2)) : 1600;
// Fits a picture in a box of cells, its own shape. With the cell's size in
// pixels known and `isCapped`, never past the picture's own pixels; unknown,
// a cell is about twice as tall as wide.
export function fit(width, height, maxCols, maxRows, px, isCapped = true) {
    if (px) {
        const scale = Math.min(isCapped ? 1 : Number.POSITIVE_INFINITY, (maxCols * px.width) / width, (maxRows * px.height) / height);
        // A hair over, so a box that fits exactly (38 rows, computed as 37.999…) keeps its last row.
        const rows = Math.max(1, Math.min(255, Math.floor((height * scale) / px.height + 1e-9)));
        const shown = isCapped ? Math.min(height, rows * px.height) : rows * px.height;
        const columns = Math.max(1, Math.min(255, maxCols, Math.ceil((shown * width) / height / px.width)));
        return { columns, rows };
    }
    let columns = Math.max(1, Math.min(255, maxCols));
    let rows = Math.ceil((columns * height) / width / 2);
    if (rows > maxRows) {
        rows = maxRows;
        columns = Math.max(1, Math.ceil((rows * 2 * width) / height));
    }
    return { columns: Math.min(255, columns), rows: Math.max(1, Math.min(255, rows)) };
}
// The width a picture or clip is made at when it's prepared: what an inline
// player in this terminal needs (see layoutOf). 1600 px at most while unmeasured.
export function frameWidth(width, height, term, px) {
    if (!term || !px || !width || !height)
        return Math.min(1600, width);
    const layout = layoutOf({ columns: term.columns, rows: term.rows, isPane: false, hasReport: false });
    return pixelsFor(targetBox(width, height, layout, px), px, width / height);
}
// The drawn box for `room` columns already free of chrome (the pair view).
export function sizeFor(width, height, room, rows, isPane, px = state.cell) {
    return drawBox(width, height, layoutOf({ columns: room + (isPane ? 6 : 10), rows, isPane, hasReport: false }), px);
}
export const CELL_SH = `perl -e 'open(T, "</dev/tty") or exit 1; my $w = " " x 8; ioctl(T, ($^O eq "darwin" ? 0x40087468 : 0x5413), $w) or exit 1; print join(" ", unpack("S4", $w))'`;
// The tty's size is in points; pictures draw in screen pixels, `scale` to a
// point (2 on Retina).
export function cellOf(stdout, scale = 1) {
    const [rows, columns, x, y] = stdout.trim().split(/\s+/).map(Number);
    return rows && columns && x && y ? { width: (x / columns) * scale, height: (y / rows) * scale } : null;
}
const SCALE_SH = `osascript -l JavaScript -e 'ObjC.import("AppKit"); $.NSScreen.mainScreen.backingScaleFactor'`;
export async function measureCells($) {
    const [r, s] = await Promise.all([
        $.process.run(['sh', '-c', CELL_SH]).catch(() => null),
        state.isMac ? $.process.run(['sh', '-c', SCALE_SH]).catch(() => null) : null,
    ]);
    const scale = Number(s?.stdout.trim()) || 1;
    state.cell = r?.exitCode === 0 ? cellOf(r.stdout, scale) : null;
    const [rows, columns] = (r?.exitCode === 0 ? r.stdout : '').trim().split(/\s+/).map(Number);
    state.termSize = rows && columns ? { columns, rows } : null;
}
// Players of different widths each ask: one measure a second at most, the
// last ask still measured.
let measuredAt = 0;
export async function remeasure($) {
    const wait = measuredAt + 1000 - (await $.clock.now());
    if (wait > 0)
        await $.clock.sleep(wait);
    measuredAt = await $.clock.now();
    const was = state.cell;
    await measureCells($);
    return was?.width !== state.cell?.width || was?.height !== state.cell?.height;
}
export const paneSize = (viewport, props) => {
    if (!viewport)
        return viewport;
    const rows = props.bodyRows ?? props.scroll?.bodyRows;
    return { columns: props.bodyColumns || viewport.columns, rows: rows || viewport.rows };
};
export const clock = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
// One line, whatever the length: cut at a word, with … where it was cut.
export function oneLine(text, width) {
    const flat = text.replace(/\s+/g, ' ').trim();
    width = Math.max(4, Math.floor(width));
    if (flat.length <= width)
        return flat;
    const cut = flat.slice(0, width - 1);
    const space = cut.lastIndexOf(' ');
    return `${(space > width / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
}
// A tab name short enough that every tab fits on one line and stays clickable.
export const tabLabel = (text, max = 12) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
// Words wrapped to lines of at most width, so the whole text is always shown.
export function wrapWords(text, width) {
    width = Math.max(1, Math.floor(width));
    const lines = [];
    let line = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
        for (let w = word; w;) {
            const piece = w.length > width ? w.slice(0, width) : w;
            w = w.slice(piece.length);
            if (!line)
                line = piece;
            else if (line.length + 1 + piece.length <= width)
                line += ` ${piece}`;
            else {
                lines.push(line);
                line = piece;
            }
        }
    }
    return lines.length || line ? [...lines, line].filter(Boolean) : [''];
}
// Splits wrapped items into pages that each fit rows; an item never splits.
export function pagesOf(items, rows) {
    const pages = [[]];
    let used = 0;
    for (const { item, rows: need } of items) {
        if (used + need > rows && pages.at(-1).length) {
            pages.push([]);
            used = 0;
        }
        pages.at(-1).push(item);
        used += need;
    }
    return pages;
}
