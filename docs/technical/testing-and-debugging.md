# Testing

## Checks before any change is done

```
node tools/bundle.mjs              # after any module edit; CI runs it with --check
node --test tools/bundle.test.mjs
npx -p typescript tsc -p .
npx --yes @biomejs/biome@1.9.4 lint hooks tests types tools
claude plugin validate .
claude plugin test .
```

Run validate and test on the oldest supported Claude Code too (2.1.286): `npm i --prefix <dir> @anthropic-ai/claude-code@2.1.286` and call `<dir>/node_modules/@anthropic-ai/claude-code-darwin-arm64/claude`. Loader rules differ by version, so a change that passes on the newest can fail to load on older ones.

Note `npx -p typescript tsc`: a bare `npx tsc` runs an unrelated package.

## Lint

Biome (`biome.json`), lint only: the formatter is off so diffs stay small. The recommended rules apply, minus a few that fight the code's idioms: non-null assertions after a checked lookup, `if (!x) map.set(k, (x = ...))`, several declarations on one line, reassigning a normalised parameter, and array index keys in rows that never reorder. Tests may use `any` for engine targets. A real exception gets a `biome-ignore` comment with its reason.

## CI

`.github/workflows/ci.yml` runs lint, `claude plugin validate .` and `claude plugin test .` on every push to `main`, `releases` and `latest` and on pull requests. It doesn't typecheck: the engine's types (`.claude-plugin/types/`) are written by Claude Code when it loads the plugin from a folder, are git-ignored, and need a signed-in session to appear. Run `tsc` locally.

`.github/workflows/release.yml` publishes a GitHub release when a `show-your-work--v*` tag is pushed, titled with the version and with the release commit's summary as its notes. A version not yet on `releases` (out on Latest only) is published as a pre-release; `.github/workflows/promote.yml` marks it a full, latest release when `releases` is pushed to it.

## The test harness (`claude-code/testing`)

- Every test loads the module, so a loader rule broken anywhere fails every test. That's the fastest way to catch the rules in `plugin-loader-and-hooks.md`.
- Pure functions are exported and tested directly (`tests/fit.test.ts`, `tests/stats.test.ts`). Prefer pulling logic into a small exported function over driving it through hooks.
- Render tests mount a component with `$.ui.mount(target)` and read `drawn()`. Press buttons with `mounted.press({ key })`.
- **Hooks registered with `on(...)` in a test return `{ value }` or `{ deny }`.** Returning a bare object (like `{ deny: '...' }` meant as a result) turns into a rejection.
- `mock.clock(on)` replaces `$.clock`; move it with `clock.advance(ms)`. Real timers don't advance it.
- `mock.store(on, entries)` answers `$.store`. **Atoms (`atom`, `read`, `update`) are not in the store** and can't be seeded, so the pane can't be rendered with content in a test.
- `$.session.start` can't be driven usefully: the plugin's session hook doesn't run under the harness. Test what it decides through exported functions (`earlierNo`).
- A byte source must be a real PNG; the harness checks the header.
- The harness can't run processes or read real files: anything that needs ffmpeg or sips is checked by hand.
- To check a test really guards a fix, break the fix and see the test fail.

## Proving a change leaves behaviour alone

To show a refactor or a new setting changes nothing in the default path, run the old code beside the new: copy the old module out of git (`git show <commit>:hooks/layout.ts > hooks/zzold.ts`), write a throwaway test that imports both and compares their outputs over a grid of inputs, run `claude plugin test .`, then delete both files. Picture size was checked this way (2,016 combinations, no difference).

## Diagnostics

`hooks/diagnostics.ts` keeps a structured log: one JSON object per line in `debug.log` in the temp folder, while `SHOW_YOUR_WORK_DEBUG=1` is set. It is local only and must never reach `track()` (PostHog): it holds paths and sizes. Events (`e`):

- `layout`: a player's window, space, picture, box and cell, only when one of them changed.
- `copy`: a copy `asked`, `made` (with `ms`), `failed` or `cancelled` (Claude Code cancelled the draw that started it).
- `frame`: each frame swapped in, its width and the box it went into.
- `resize`, `resend`: a box change and its never-repeating generation; the frame sent again after it.
- `measure`: a cell measurement, or one cancelled (the last size kept).
- `log`: the playback timings (`tick`, `wait`, `cut chunk`, `drop`).
- `problem`: something that shouldn't happen. Problems are also kept in memory without the debug log, a few hundred at most, for `/show-your-work diagnose`. Current checks: `frame_wider_than_box` and `picture_wider_than_box` (Large: the terminal would crop it), `resend_cancelled`, `no_cell_size`.

Add an event or a problem check wherever a bug was found by guessing, so the next one is found by reading. Never start a process or read a file to log something: the log is written from memory once a second. (A `sips` call per draw, added once for debugging, made the terminal laggy.)

## A real terminal, headless

`tools/pty-harness.py` does all of the below: `python3 tools/pty-harness.py video|image|tour|scroll`. It prints every placement Claude Code sent next to each resize, counts the plugin's events, and exits 1 if any `problem` was logged. Clicking and scrolling need `pyte` (see the script's header).

To see what Claude Code does in a terminal without opening a window, run it under a pseudo-terminal from Python (`pty.fork`):

- **Fake the terminal** with `TERM_PROGRAM=ghostty TERM=xterm-ghostty` and `SHOW_YOUR_WORK_DEBUG=1`, and load the local copy with the `--plugin-dir … --settings` line below.
- **Set the window size** with `ioctl(fd, TIOCSWINSZ, struct.pack('HHHH', rows, cols, width_pt, height_pt))` and send `SIGWINCH`. The pixel sizes are in points; the plugin multiplies by the screen's scale (2 on Retina). To match a user's screenshot, work out their columns and cell size from it first; a guess at the geometry gives different boxes.
- **Read `debug.log`** in the temp folder for what the plugin computed. Temporary `debug()` lines prefixed with something greppable are the quickest way to see a value; remove them before committing.
- **To make Claude Code send pictures, answer its queries in order:** each kitty graphics query (`ESC _G i=<id>,…,a=q…`) with `ESC _G i=<id>;OK ESC \\` *before* answering the device-attributes query (`ESC [c`) that follows it as a sentinel; also answer XTVERSION (`ESC [>0q` → `ESC P>|ghostty 1.2.3 ESC \\`) and `ESC [?u` (`ESC [?0u`). Answered after the sentinel, the probe counts as no reply (`claude --debug-file` logs `kittyGraphics=no (probe: no reply to the graphics query)`). With that, every placement Claude Code sends (`a=T,U=1,…,c=<columns>,r=<rows>`) can be logged with a timestamp next to each resize. It still can't show what Ghostty paints from those commands.
- **A resize test should drag, not jump:** many small size changes 40 ms apart, while a video plays (a clip longer than the test, so it doesn't end midway). Single jumps hid the cancelled-measure bug below.
- **A test session shares the local copy's saved plugin settings** with the user's own sessions. Don't change a setting there to test; it changes theirs.
- To reach a later tour stop without clicking, reorder `STOPS` in `tour.ts` for the run and put it back afterwards.

## Shell scripts

The `sh -c` scripts (`SHRINK_SH`, `TRIM_SH`, `HISTORY_TRIM_SH`, `MOVE_SH`) are tested by hand in a temp folder, the way the plugin runs them: `sh -c "$SCRIPT" arg0 arg1 ...` (with `-c`, the first argument is `$0`). Use a folder with spaces in its name. For Linux behaviour on a Mac, put only `sh wc tr rm` on `PATH`.

## On screen

The tests can't see whether a picture draws. Check visual changes in a normal Ghostty tab with the local copy:

```
claude --plugin-dir ~/claude-mods/claude-show-your-work --settings '{"enabledPlugins":{"show-your-work@iamumeransari":false}}'
```

- A plain `claude` loads the **installed** copy from GitHub, not the local one.
- **Background sessions (agent view, forks, `claude attach`) can't draw pictures at all.** A test there shows the background notice, whatever the code does. Use a normal tab.
- **Over ssh:** start with `SSH_CONNECTION="1 1 1 1"` in front to send pictures as bytes, as over ssh. A real check needs Remote Login and `ssh localhost`.
- `SHOW_YOUR_WORK_DEBUG=1` before `claude` turns on `debug.log` in the temp folder (`$TMPDIR/claude-show-your-work-<uid>/debug.log`). It holds the last 20,000 lines and is rewritten once a second. Ask a user for it when something only happens on their machine; it holds no file contents.
- `/reload-plugins` picks up edits; `/img <path>` shows any file without Claude; `/show-your-work tour` exercises video, compare and history.
- Several sessions can share this folder (forks, other tabs). Check `git status` and `git reflog` before committing; another session may have edited or amended.
