# Drawing pictures

## How a picture reaches the screen

Claude calls `show_image` or `show_video` with a path. The tool call prepares the file (converts it to PNG, or cuts video frames), keeps a history copy, and returns one short line for Claude plus a marker line, `show-your-work:#<id>`. The `ToolResult` render hook reads the marker and draws the player (`Viewer`) in the chat. `/img <path>` does the same in its own command row (`CommandOutput` hook). Pictures go to the screen only, never to Claude, so they cost no tokens.

The picture is an `Image` element. Video playback swaps its source with `$.ui.blit` at the frame rate.

## Sources: path or bytes

- **Normally the source is a path:** `{ file, format: 'png', generation }`. Ghostty reads the file itself, so nothing large crosses. Sending bytes for every frame (tried in b6b8b14) moved ~400 KB per frame and froze playback.
- **Over ssh the terminal is on another machine** and can't read the file. `setUp` sets `sendBytes` when `SSH_CONNECTION` or `SSH_TTY` is present, and `pngSource` then sends `{ png: <base64> }`.
- **Claude Code refuses a PNG over 2 MiB sent as bytes** (`decodes to more than 2097152 bytes`; the whole render is refused). Files over `BYTES_MAX` are shrunk first by `SHRINK_SH` (sips, then ffmpeg, then ImageMagick), once per file, into the temp folder. With no tool, the source falls back to the path.
- **Orca reads a picture file only from a temp folder or the terminal's own worktree, and only up to 2 MiB** (Orca 1.4.239, `readKittyFile`: its temp folder, `/tmp` and `/private/tmp`; a hard-linked file is refused too). Its floating terminal has no worktree, so a picture under the working folder's `.show-your-work` is refused there. A refused file draws as an empty box, and no error reaches the plugin. In Orca (`TERM_PROGRAM=Orca`), `pngSource` draws a file over `BYTES_MAX` from a `SHRINK_SH` copy (`b-<key>.png`), and any other file outside the temp folder from a plain copy there (`o-<key>.png`). Copies are made once and looked up by path, size and time, not path alone: a file saved again at the same path, or a temp name like `shot-3.png` back with another picture in it, gets a new copy. A video's frames are in the temp folder and usually under 2 MB, so playback costs one `stat` per frame and no process.
- `recentBytes` keeps the last few base64 strings, so a redraw (any button press) doesn't read and send the picture again. Without it, buttons lag badly over ssh.
- Do **not** switch to bytes automatically when a blit is denied with "cannot read files". That happens in background sessions too, where bytes don't draw either, and it left players stuck on their alt text.

## The terminal's limits (measured in Ghostty)

- **Ghostty draws a picture at its native pixel size at most.** It scales a picture down to fit its box but never up. A 800 px frame in a wide box stays small. So frames and stills are made as wide as the box really is in pixels (`frameWidth`, 320 to 2400 px); stills are enlarged with `sips --resampleWidth` up to that width (`MAX_STILL` 3200).
- **Ghostty keeps a picture at the size it was last sent.** When the box changes size but the source doesn't, the picture is cropped, not rescaled. File sources carry `generation: box.columns * 1000 + box.rows`, so a new box means a new source. Byte sources have no generation field; a crop can flash for a frame until the next redraw.
- Nothing may wrap, overlay or fill behind the `Image`. Each of those stopped it drawing in Ghostty.

## How Claude Code's `Image` draws (read from 2.1.301)

So nobody has to dig through the binary again:

- **It uses kitty Unicode placeholders.** The `Image` is a fixed box of exactly `columns` × `rows` cells (`overflow: hidden`), filled with placeholder characters; the picture itself is sent once and the terminal paints it into those cells. The terminal fits the picture into that box keeping its shape, and never past its own pixels.
- **It sends the picture again only when the source's identity or the box (`${columns}x${rows}`) changes.** Same source and box: nothing is sent. That's why file sources carry a `generation`.
- **File sources need the terminal to read local files.** At first use Claude Code writes a 4-byte `tty-graphics-protocol-*.rgba` file to the temp folder and asks the terminal to load it (`a=q,t=f`). If the terminal says no, every `{ file }` source draws its alt text (the message says "this terminal cannot read files on this machine"); byte sources still draw. Over ssh the answer is no, which is why `sendBytes` exists.
- **Image ids:** 24-bit ids with truecolour, 8-bit with 256 colours, none (alt text) below that. With 8-bit ids, too many pictures on screen at once run out of ids and show their alt text.
- If the terminal never answers its startup queries (XTVERSION `ESC [>0q`, device attributes `ESC [c`, the graphics query `a=q,t=d`), no picture is sent at all.

## Player layout

Every view (one picture, Original/Updated, side by side) is built from the same zones, in this order:

1. **Title bar** (`TitleBar`): the title (the only thing that gives way when space runs out), the side shown, the score, a PR link, then the tabs on the right, on one line. The player is never narrower than its tabs (`tabsWidth`).
2. **Stage**: the picture, the scrub bar and the buttons under it.
3. **Report**: what changed (or the versions, in History), then QA. Beside the stage when the chat is wide enough, under it otherwise.

A tour's instruction for each stop sits in the tour's header, under the stop's title, never inside the player.

No sizes in the UI: no resolution, and a video's length only on its scrub bar.

`tests/render.test.ts` enforces this: the tabs are drawn once, in the title bar, in every layout; each tour stop shows its instruction once, under its title. A change that moves either fails those tests.

## Sizing

All sizing goes through `hooks/layout.ts`:

- `layoutOf(room)`: the space a player has. `room` is its columns and rows, pane or inline, and whether it has a report. Gives `maxCols`, `maxRows`, whether the report sits beside (`isWide`) and the inner width. In Standard, inline, a picture takes at most 120 columns and 55% of the rows (8 to 40); Large scales these (see Picture size); in a pane up to 220 columns and the pane's rows minus 12. The report sits beside when there is one and the chat is at least `WIDE_ENOUGH` (110) columns, in a `SIDE` (40) column.
- `targetBox(w, h, layout, cell)`: the box a picture of that shape fills.
- `pixelsFor(box, cell, aspect)`: the screen pixels that box needs, for its width and its height, between `PX_MIN` (320) and `PX_MAX` (2400).
- `drawBox(w, h, layout, cell)`: the box actually drawn: the target, cut down to the picture's own pixels, so a picture that's short of pixels is drawn whole at its size instead of small in a big box.
- `frameWidth`: the width a picture or clip is made at when prepared, the pixels an inline player without a report needs in this terminal.
- `sharpen`: when a player needs at least 15% more pixels than its picture has (a bigger window, a pane), a sharper copy is made in the background from the original file and swapped into the same object, so a playing video carries on. Stills stop at twice their own width and `MAX_STILL` (3200); videos at `PX_MAX`.

## Picture size: Standard and Large

The setting (`standard_size`, Standard by default) scales every size limit by one fixed factor, `sizeStep()`: 1 for Standard, `SIZE_STEP` (1.5) for Large. Nothing else knows Large exists.

| | Standard | Large |
|---|---|---|
| Max width, inline (`maxCols`) | 120 columns | 180 |
| Max width, pane | 220 | 330 |
| Max height, inline (`maxRows`) | 40 rows, 55% of the screen | 60 rows, 82% |
| Box pixels (`pixelsFor` cap) | 2400 | 3600 |
| Stills enlarged up to | 2× their width | 3× |
| Video frames | 2400 px | 2400 px, the same |

- **Videos keep Standard's 2400 px frames.** Bigger frames cost cutting time and memory on every frame (about 2.25× the pixels at 3600) and risked bringing back stutter. A Large player shows them in its bigger box anyway.
- **Standard is unchanged by the setting's code.** Checked by running the new `layout.ts` against the one before it (from git) on 2,016 combinations of window, pane, report, cell size and picture shape: no difference in any box or pixel width. Repeat that check whenever sizing changes (see `testing-and-debugging.md`).
- Changing the setting calls `redraw`, so pictures on screen re-lay out at once.

### Why not a full-window size (tried and dropped in 0.7.0)

A "Full window" option that stretched the frame and picture to the whole window was built and dropped. Keep these in mind before trying anything like it again:

- **The terminal never enlarges a picture,** so filling a window means making a copy at the window's pixel width. Every window size needs its own copy; rounding to fixed widths (640 to 3200) still left up to eight files per picture and visible swaps.
- **Shrinking a window cut the picture off.** The big copy made for the wide window stayed in use, and the terminal crops rather than shrinks an oversized picture in a smaller box. Fixing that meant a copy per size on the way down too.
- **Off macOS the cell size is often unknown,** so "fill the window" had to guess a cell size (20 × 40 px was used), which was either blurry or wasteful.
- **Cost:** a 3200 × 2000 picture is ~25 MB decoded, so far fewer fit in the terminal's 320 MB store and scrolling back re-sends more.

A fixed multiplier keeps a picture's size a function of only the picture, the window, the cell and the setting: the same inputs always give the same box, and resizing behaves exactly as Standard. The Full window work is on the local branch `picture-size` (never pushed).

### Open: Large in the tour

In Large, tour stops were seen drawn smaller than their frame, in the frame's top-left corner, with frame widths changing between stops. The layout gives the right box (checked headless at the same window size), so the picture file drawn has fewer pixels than its box, and the terminal doesn't enlarge it. Not yet resolved; update this note with the cause.

## The sizing invariant

The invariant, tested in `tests/fit.test.ts`: a picture made at `frameWidth` fills its box at any window size and shape. `fit` rounds rows with a hair of tolerance; without it, 38 rows computed as 37.999 lost a row and several columns.

The cell's pixel size comes from the tty: `CELL_SH` (perl `ioctl` TIOCGWINSZ, `0x40087468` on macOS) gives rows, columns and the window's size in points; `SCALE_SH` (`NSScreen.mainScreen.backingScaleFactor` via osascript JXA) turns points into pixels. `cell` is null where the tty reports nothing (tmux, a relay): boxes then assume 2:1 cells, pictures are made at 1600 px at most, and nothing is sharpened. `remeasure` runs when the viewport changes size, at most once a second, and only a real change redraws.

Original and Updated share one frame, the bigger of their two boxes, each picture centred in it, so switching tabs never moves the layout. Each side has its own `Image` key (`viewKey`).

Sizes in the UI: none. The file's own size is kept as `sourceWidth`/`sourceHeight` and goes to Claude in the tool result only.

## When pictures can't draw

The first draw is probed (`probe`): a blit 250 ms later reports whether the `Image` drew or fell back to its alt text. If it didn't, every player shows a notice (`cantDraw`) instead:

- **tmux** with `allow-passthrough off`: known at session start, before any draw.
- **Herdr** (`TERM_PROGRAM=herdr`), a multiplexer like tmux: a failed draw there means its kitty graphics pass-through is off, or the terminal around it can't draw. The notice copies `[terminal]\nkitty_graphics = true` for Herdr's config. Older Herdr versions used `[experimental] kitty_graphics = true`.
- **A terminal without the kitty graphics protocol.** The terminal is recognised from its environment (`terminalOf`: Ghostty, kitty, WezTerm, Warp, Konsole). In one of those, a failed draw is taken to be a background session instead (`KITTY_TERMINALS`, `causeOf`). The notice names the protocol and those terminals as equals and links to the README's terminal list; it never favours one terminal or tells someone already in a supported one to switch.
- **A background session** (agent view, a fork, `claude attach`). These can't draw pictures at all. The notice's Copy command button copies `claude stop <id>; CLAUDE_CODE_DISABLE_AGENT_VIEW=1 claude --resume <id>`. Resuming alone fails while the session still runs. The command itself isn't printed in the notice.

## Scrolling

- A player scrolled out of view gets `onScreen: null`; back in view, `onScreen` again. The terminal may have dropped the picture from its store meanwhile, so it's sent again.
- **Back in view, the kept drawing stands** (layout unchanged); only the picture is re-sent. Rebuilding the whole player on every scroll back made scrolling past pictures slow.
- **It's re-sent only if the terminal may have dropped it, and then at once.** A kitty-protocol terminal keeps pictures up to its image storage limit (320 MB of decoded pixels by default) and drops the oldest past it. The plugin counts the decoded bytes it has sent (`state.drawnBytes`, `noteDrawn`); a picture with less than 160 MB sent since it was drawn (half the limit) is still there and isn't sent (`mayBeDropped`). Terminals whose limit isn't known (Warp and others) get 48 MB (`safeBytes`), so they re-send sooner rather than leave a picture blank. Re-sending every picture on every pass made Ghostty decode big PNGs over and over while scrolling. A 250 ms wait for scrolling to settle was tried first and felt slow.
- `SHOW_YOUR_WORK_DEBUG=1` logs `away`, `back` and `resend` per player.
