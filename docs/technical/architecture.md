# Architecture

How a picture or video gets from Claude's tool call to the terminal, and which module does each part. The topic notes go deeper on each step.

## Modules

| Module | Holds |
|---|---|
| `register.tsx` | The entry module: the `show_image` and `show_video` tools, the `/img` and `/show-your-work` commands, and every `on(...)` hook that ties the modules together |
| `state.ts` | What more than one module reads or changes: the session's facts, playback and tour progress, the settings |
| `setup.ts` | Found once per session: temp folder, home, ffmpeg and ffprobe, ssh, the terminal |
| `history.ts` | Every shown file kept in `.show-your-work/`, linked to the version before, and the marker a tool result carries |
| `media.ts` | Getting files ready to draw: PNG conversion, video frames cut a chunk at a time, the side-by-side clip of two runs |
| `layout.ts` | Sizing: from the room a player has to its box in cells and the pixels its picture needs |
| `player.tsx` | Playback (timer, frame swaps, seek, compare) and the components that draw the player |
| `onboarding.tsx`, `tour.ts` | The settings pane, the welcome and the tour |
| `updater.ts` | The daily update check and moves between Stable and Latest |
| `telemetry.ts` | Anonymous usage counts and the local timing log |

`register.tsx` is the entry module and imports the rest. `hooks.json` loads `bundle.tsx`, which `node tools/bundle.mjs` joins from all of them, so Claude Code before 2.1.299 can load it (see `plugin-loader-and-hooks.md`). The loader's rules apply in every module.

## A tool call, end to end

1. **Claude calls `show_image` or `show_video`** with a path, and optionally a title, changes, checks, a `compare` file and a `previous` version.
2. **`tool.call` hook** (`register.tsx`): finds the file (`locate`), refuses anything that isn't a picture or video, and copies it into the version history (`storeVersion`, `history.ts`), linked to the version before it.
3. **Preparing** (`prepare`, `media.ts`): a picture becomes a PNG at the width the player needs. A video gets a poster frame and its first 2 s chunk of frames; the rest are cut as it plays. A compare file is prepared the same way, and two videos get their matching moments lined up (`anchors`).
4. **The result** goes back to Claude as a line of text plus a marker holding the prepared item. Claude never receives the picture, so showing it costs no tokens.
5. **`ui.render` for the `ToolResult`** (`register.tsx`): reads the marker (`shownOf`) and draws the `Viewer` (`player.tsx`). An unchanged player hands back its last drawing, and a picture scrolled back into view is only re-sent if the terminal may have dropped it.
6. **Sizing** (`layout.ts`): the terminal's cell size in pixels comes from the tty. The player picks a box in cells for the picture's shape, and a sharper copy is made in the background if the box needs more pixels.
7. **Drawing**: the `Image` element points the terminal at the PNG by path, and the terminal draws it through the kitty graphics protocol (Ghostty, kitty, WezTerm, Warp, Konsole). Over ssh the bytes are sent instead.
8. **Playback** (`player.tsx`): a timer advances one frame at a time at up to 12 fps. Each frame is swapped in with `$.ui.blit`, one swap in flight per picture with the newest frame winning. Chunks 5 s ahead are cut in advance and 5 s behind are kept; the rest are pruned.

## Core structures

What the modules pass around, and where each lives. Knowing these is most of knowing the code.

| Structure | Where | What it is |
|---|---|---|
| `Shown` | `types/index.d.ts` | One prepared item: the PNG drawn (`path`, `width`, `height` in pixels), the user's file (`source`, `origin`), its own size (`sourceWidth`/`sourceHeight`), `frames` for a video, the QA context (`changes`, `checks`, `summary`, `change`, `pr`, `url`), the other side of a before/after (`compare`) and earlier versions (`history`). The tool result's marker points at one. |
| `Frames` | `types/index.d.ts` | A video's frame folder: `dir`, `count`, `fps`, `duration`, the skipped white `lead`, and the width it was `cut` at. Frame *n* is `frameFile(frames, n)`. |
| `state` | `state.ts` | One shared object for everything more than one module reads or changes: temp folder, tool paths, `cell` and `termSize`, `sendBytes`, `drawnBytes`, `canImage`, the `version` that forces repaints, tour progress, usage-stats queue. Module `let`s can't be shared (an imported `let` is read-only), so state goes here. |
| `settings`, `SETTINGS` | `state.ts` | The saved choices as booleans (`stable_updates`, `usage_stats`, `standard_size`), and the list the settings pane draws from: title, the two options, one line of help. Adding a setting is one entry plus a default. |
| `Room`, `Layout`, `Cell` | `layout.ts` | Sizing inputs and outputs: the room a player has (columns, rows, pane or inline, has a report), the space that gives (`maxCols`, `maxRows`, report beside or below), and the terminal's cell in screen pixels. |
| `players` | `player.tsx` | One `Player` per site (a tool result, an `/img` row, the tour): the frame on screen, its timer, which tab and view, whether it's scrolled away, the box last drawn. |
| `sharpest`, `sharpening` | `player.tsx` | Sharper copies made in the background, by source, and the width each is being made at, so one is made once and swapped into every `Shown` of that file. |
| `swaps` | `player.tsx` | Per picture, the one `$.ui.blit` in flight and the newest frame waiting, so frames never queue or land out of order. |
| `cutChunks` | `media.ts` | Which 2 s chunks of which clip are cut, so playing, seeking and cutting ahead never cut one twice. `recutFrame` forgets one whose files were cleaned away. |

Module state (these maps, `state`) resets on `/reload-plugins`; anything saved lives in `$.store` (settings, install id, update check time, history folders).

## Where to look

- A picture is the wrong size or blurry: `layout.ts`, then `showing-images.md` (including Picture size).
- A setting doesn't stick or resets after a reload: `ensureSettings` (`onboarding.tsx`), then `updates-and-onboarding.md`.
- A video stutters or stalls: `player.tsx` (`play`, `blit`), `media.ts` (`ensureChunk`), then `playing-video.md` and its timing log.
- A version is missing from History: `history.ts`, then `cache-and-version-history.md`.
- The plugin doesn't load at all: `plugin-loader-and-hooks.md`, and run `claude plugin test .`.
