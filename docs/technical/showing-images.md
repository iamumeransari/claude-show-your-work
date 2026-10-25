# Drawing pictures

## How a picture reaches the screen

Claude calls `show_image` or `show_video` with a path. The tool call prepares the file (converts it to PNG, or cuts video frames), keeps a history copy, and returns one short line for Claude plus a marker line, `show-your-work:#<id>`. The `ToolResult` render hook reads the marker and draws the player (`Viewer`) in the chat. `/img <path>` does the same in its own command row (`CommandOutput` hook). Pictures go to the screen only, never to Claude, so they cost no tokens.

The picture is an `Image` element. Video playback swaps its source with `$.ui.blit` at the frame rate.

## Sources: path or bytes

- **Normally the source is a path:** `{ file, format: 'png', generation }`. Ghostty reads the file itself, so nothing large crosses. Sending bytes for every frame (tried in b6b8b14) moved ~400 KB per frame and froze playback.
- **Over ssh the terminal is on another machine** and can't read the file. `setUp` sets `sendBytes` when `SSH_CONNECTION` or `SSH_TTY` is present, and `pngSource` then sends `{ png: <base64> }`.
- **Claude Code refuses a PNG over 2 MiB sent as bytes** (`decodes to more than 2097152 bytes`; the whole render is refused). Files over `BYTES_MAX` are shrunk first by `SHRINK_SH` (sips, then ffmpeg, then ImageMagick), once per file, into the temp folder. With no tool, the source falls back to the path.
- **Orca reads a picture file only from a temp folder or the terminal's own worktree, and only up to 2 MiB** (Orca 1.4.239, `readKittyFile`: its temp folder, `/tmp` and `/private/tmp`; a hard-linked file is refused too). Its floating terminal has no worktree, so a picture under the working folder's `.show-your-work` is refused there. A refused file draws as an empty box, and no error reaches the plugin. Ghostty and kitty read any file up to 400 MB and 10,000 px (Ghostty: `max_size` and `max_dimension` in `graphics_image.zig`; its temp-folder rule is only for `t=t`). Since a refusal can't be seen, every other terminal is treated like Orca (`readsAnyFile`):
  - A still over `BYTES_MAX` is drawn from a `SHRINK_SH` copy (`b-<key>.png`: sips, then ffmpeg, then ImageMagick, from 1600 px wide down), and any other still outside the temp folder from a plain copy there (`o-<key>.png`, `cp -c`: a clone on APFS). This is PR #17's code, checked on screen in Orca 1.4.239: a 9.4 MB 2800 px screenshot drew from a 1.4 MB copy.
  - Copies are made once and looked up by path, size and time, not path alone: a file saved again at the same path, or a temp name like `shot-3.png` back with another picture in it, gets a new copy. A failed copy isn't kept, so the next draw tries again.
  - Video frames stay in full colour. A chunk with a frame over `BYTES_MAX` (a very wide window, grainy footage) is cut again in 256 colours (`cutFrames`: one `stat` per frame, a second ffmpeg run only for that chunk); 2084 px frames of 1.57–1.65 MB in full colour are 0.58–0.59 MB in 256. Frames are in the temp folder, so playback costs no process (#16, from PR #17).
  - Inside tmux, the terminal around it comes from `client_termtype` (`state.outerTerminal`): tmux in Ghostty or kitty draws like them, with no copies.
- `recentBytes` keeps the last few base64 strings, so a redraw (any button press) doesn't read and send the picture again. Without it, buttons lag badly over ssh. It and the shrunk copies are keyed by path, size and time (`versionOf`, one `stat`), so a file saved again at the same path is read again rather than showing the old picture.
- Do **not** switch to bytes automatically when a blit is denied with "cannot read files". That happens in background sessions too, where bytes don't draw either, and it left players stuck on their alt text.

## The terminal's limits (measured in Ghostty)

- **Ghostty draws a picture at its native pixel size at most, and crops one bigger than its box.** It never scales a picture up, and a picture wider than its box is cut off rather than shrunk (see `fitCopy`). A 800 px frame in a wide box stays small. So frames and stills are made as wide as the box really is in pixels (`frameWidth`, 320 to 2400 px); stills are enlarged with `sips --resampleWidth` up to that width (`MAX_STILL` 3200).
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
- `fitCopy` (`player.tsx`): **in Large, a picture is always drawn from a copy no wider than its box needs.** (Standard keeps its earlier behaviour: the widest copy is drawn, and a copy is only made bigger, at the exact width the box needs. Its box barely changes with the window, so it never pays for re-cuts after a resize.) Ghostty crops a picture bigger than its box instead of shrinking it (seen in Large: a video made for a wide window was cut off after the window narrowed), and never enlarges one. Copies are made in the background from the original, only at fixed widths (`COPY_WIDTHS`, 480 to 3200), and kept; each draw uses the widest copy that fits (`bestCopy`, within 3%), so a picture is drawn whole and at most one step smaller than its box, and resizing back to an earlier size reuses a copy at once. A bigger copy is made only when it gains 15%. Stills stop at twice their own width (three times in Large) and `MAX_STILL` (3200); video frames at `PX_MAX`. Making one starts 300 ms after the draw that asked, since Claude Code cancels work a replaced draw started. A video's copy is made by `rescaleVideo` (`media.ts`): the clip's rate, length and lead-in are reused and only the chunk on screen is cut, about 0.4 s; the rest is cut as it plays, like any clip.

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

### Large drew pictures small (fixed in 0.7.0)

In Large, tour stops were drawn smaller than the space, with the frame width changing between stops. Cause: the doubled cell size (see the cell paragraph under Sizing). With cells taken as 32 px instead of 16, `drawBox` decided a 2400 px video filled only 73 columns, and each file's own pixel width set its box, so every stop was a different width. Found by logging the box, cell and drawn file in the user's own session (`debug()` lines) and reading the real tty size from `ps` and `CELL_SH` against their tty.

## The sizing invariant

The invariant, tested in `tests/fit.test.ts`: a picture made at `frameWidth` fills its box at any window size and shape. `fit` rounds rows with a hair of tolerance; without it, 38 rows computed as 37.999 lost a row and several columns.

The cell's pixel size comes from the tty: `CELL_SH` (perl `ioctl` TIOCGWINSZ, `0x40087468` on macOS) gives rows, columns and the window's size. **Ghostty, kitty and WezTerm report it in screen pixels, not points** (measured: a 157-column Ghostty window on a 1280-point Retina screen reports 2520 × 1280). 0.6.0 multiplied it by the screen's scale (`SCALE_SH`, `backingScaleFactor`), which made every cell twice its size: pictures and frames were made twice as wide as needed (twice the cutting and memory in Standard, hidden because the terminal scales them down), and in Large `drawBox` drew boxes half as wide as the space. Fixed in 0.7.0: the scale is applied only when the cell would be under 10 px wide (`POINT_CELL`), which can only be points. To check a terminal, read its tty size (`CELL_SH` against its tty) and compare with the screen's size in points and its scale. `cell` is null where the tty reports nothing (tmux, a relay): boxes then assume 2:1 cells, pictures are made at 1600 px at most, and nothing is sharpened. `remeasure` runs when the viewport changes size, at most once a second, and only a real change redraws. **A cancelled measure keeps the last cell size.** Claude Code cancels a process started from a draw that a newer draw replaced, which happens constantly while a window edge is dragged; until 0.7.0 that set `cell` to null, so pictures fell back to 2:1 guessed boxes (the wrong shape) until the next resize.

**After a resize, the picture is re-placed (`resized`, `player.tsx`).** Every new box gets a never-repeating `boxGeneration`, carried by the `Image` source and by every frame swap: Claude Code sends a source again only when it differs from one already sent, so a generation made from the box itself (as before 0.7.0) repeated when the window returned to an earlier size, and the picture stayed at the last size. Once the box has held for 250 ms the frame on screen is sent again, and once more 750 ms later, since a frame swap in flight during the resize can land at the old size.

Original and Updated share one frame, the bigger of their two boxes, each picture centred in it, so switching tabs never moves the layout. Each side has its own `Image` key (`viewKey`).

Sizes in the UI: none. The file's own size is kept as `sourceWidth`/`sourceHeight` and goes to Claude in the tool result only.

## A resize, end to end

Every step here broke at least once in 0.7.0's testing, so the chain is spelled out:

1. **Claude Code re-renders the player** with the new `viewport` (the `ToolResult` cache key includes columns and rows, so a resize always rebuilds the `Viewer`).
2. **The cell is measured again** (`remeasure`, at most once a second): the tty's pixel size over its columns and rows, in screen pixels. A cancelled measure keeps the last size.
3. **The layout gives the space** (`layoutOf`), and `targetBox` the box for the picture's shape.
4. **The copy that fits is chosen** (`fitCopy`): the widest kept copy no wider than the box needs; if a better one is missing, it is made in the background (300 ms after the draw) and the player redraws when it's ready. The choice is recorded per player (`chosen`).
5. **The box drawn** (`drawBox`) is cut down to that copy's pixels, so the picture is whole.
6. **`resized` gives the new box a never-repeating `boxGeneration`**, which the `Image` source and every frame swap carry, so Claude Code sends the picture again. 250 ms after the box stops changing, and again 750 ms later, the frame on screen is sent again.
7. **Playback frames** (`draw` → `blit`) first match the timer's video object to the player's chosen copy (`syncCopy`), then send the frame with the current `boxGeneration`. Claude Code places it at the `Image`'s current columns and rows.

What can't be checked headless is step 8: Ghostty painting the placement. Check that on screen.

## When pictures can't draw

The first draw is probed (`probe`): a blit 250 ms later reports whether the `Image` drew or fell back to its alt text. If it didn't, every player shows a notice (`cantDraw`) instead:

- **tmux** without `CLAUDE_CODE_FORCE_TERMINAL_IMAGES`: known at session start. Claude Code turns pictures off when `$TMUX` is set. Forced on, it draws the placeholders (plain text, which tmux passes on) but writes the picture command as a bare APC sequence, never wrapped in `\ePtmux;`, so tmux drops it and the terminal paints empty cells (#15). `tmux.ts` fills that gap: at session start it sets `allow-passthrough on` for this pane only and runs a forwarder through `tmux pipe-pane -O`. The forwarder (perl, `FORWARD_PL`) reads the pane's output, wraps each `\e_G…\e\\` it sees in `\ePtmux;…\e\\` with `q=2`, and writes it to the pane's tty once the output has been quiet for 30 ms, so it never lands inside one of Claude Code's own sequences. tmux unwraps it for the terminal outside, which then paints the placeholders. It skips the session when another `pipe-pane` is already running, and when `#{client_termtype}` names Warp, WezTerm or Konsole (that terminal's notice shows instead). Without the variable, the notice copies `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1 claude --resume <id>`. Checked headless (tmux 3.6a under a hidden terminal answering as Ghostty): the outer terminal receives `a=T,U=1,…,i=1,c=99,r=29` and 8,613 placeholders, whose colour tmux rewrites from `38;5;1` to `31` (still palette index 1, the image id). Not yet looked at on screen.
- **Warp, WezTerm and Konsole** (`NO_PLACEHOLDERS`): known at session start. They speak the kitty graphics protocol, but Claude Code's `Image` always draws with Unicode placeholders (`a=T,U=1`), which only Ghostty and kitty paint. Forced on with `CLAUDE_CODE_FORCE_TERMINAL_IMAGES`, Warp showed a grid of boxes (U+10EEEE in the image id's colour) where the picture should be (#10). 0.6.7–0.6.9 offered Turn on pictures there, which wrote that variable into the shell profile behind a `# show-your-work: pictures in` mark; `removePicturesLine` takes the line out at every session start.
- **iTerm2** 3.5 or later: Claude Code's `Image` draws there with iTerm2 inline images (`ESC ] 1337 ; File=`), not placeholders. It turns them on only on an XTVERSION reply naming iTerm2 3.5+, only from `png`/`rgba` bytes (never a `file` source), and draws a picture only while its whole box is on screen. So in iTerm2 the plugin sends bytes (`sendBytes`) and caps the player's height to the window less 16 rows (`layoutOf`). Checked headless (a hidden terminal answering as iTerm2 3.5.10): pictures sent at 37 and 30 rows, none at 37 rows before the cap. A failed draw shows a notice pointing to `/tui fullscreen`. Not yet looked at on screen, so the README doesn't list iTerm2.
- **Herdr** (`TERM_PROGRAM=herdr`), a multiplexer like tmux: a failed draw there means its kitty graphics pass-through is off, or the terminal around it can't draw. The notice copies `[terminal]\nkitty_graphics = true` for Herdr's config. Older Herdr versions used `[experimental] kitty_graphics = true`.
- **A terminal without the kitty graphics protocol.** The terminal is recognised from its environment (`terminalOf`). In Ghostty or kitty a failed draw is taken to be a background session instead (`DRAWS_PICTURES`, `causeOf`). The notice links to the README's terminal list.
- **A background session** (agent view, a fork, `claude attach`). These can't draw pictures at all. The notice's Copy command button copies `claude stop <id>; CLAUDE_CODE_DISABLE_AGENT_VIEW=1 claude --resume <id>`. Resuming alone fails while the session still runs. The command itself isn't printed in the notice.

## Scrolling

- A player scrolled out of view gets `onScreen: null`; back in view, `onScreen` again. The terminal may have dropped the picture from its store meanwhile, so it's sent again.
- **Back in view, the kept drawing stands** (layout unchanged); only the picture is re-sent. Rebuilding the whole player on every scroll back made scrolling past pictures slow.
- **It's re-sent only if the terminal may have dropped it, and then at once.** A kitty-protocol terminal keeps pictures up to its image storage limit (320 MB of decoded pixels by default) and drops the oldest past it. The plugin counts the decoded bytes it has sent (`state.drawnBytes`, `noteDrawn`); a picture with less than 160 MB sent since it was drawn (half the limit) is still there and isn't sent (`mayBeDropped`). Terminals whose limit isn't known (Warp and others) get 48 MB (`safeBytes`), so they re-send sooner rather than leave a picture blank. Re-sending every picture on every pass made Ghostty decode big PNGs over and over while scrolling. A 250 ms wait for scrolling to settle was tried first and felt slow.
- `SHOW_YOUR_WORK_DEBUG=1` logs `away`, `back` and `resend` per player.
