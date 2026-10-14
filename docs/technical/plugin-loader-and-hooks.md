# Engine rules

Things the Claude Code hooks loader and runtime enforce. Breaking one of the loader rules means the whole module fails to load, usually with no visible error (only in `claude --debug-file`). `claude plugin validate` does not catch them; `claude plugin test .` does, because every test loads the module.

## The loader

- **A function that takes `$` must have a name used nowhere else in the file.** Not even a local variable in another function. `function probe($, ...)` plus `const probe = await ...` elsewhere broke 0.5.1 (issue #3). Pick distinct local names (`facts`, `where`, `shown`, `loaded`).
- **`$.env.get` takes a literal string.** `$.env.get(name)` with a variable is rejected so the engine can list what a module reads. Write one call per variable.
- **`$.plugin.root` is spelled exactly like that.** `$.plugin?.root` or destructuring is rejected.
- `$` is always used as `$.noun.event(...)` at the call site; `on` is always `on("<event>", hook)`.
- **The entry module can import sibling modules at runtime** (`import { x } from './layout'`), including modules whose functions take `$`. `hooks.json` lists only the entry module. The rules above apply in every module. An imported `let` is read-only to the importer, so state assigned from more than one module lives in one shared object.
- **Past an import, `$` is followed only into a function declaration.** In any module but the entry one, a function that takes `$` is written `function name($, ...) { ... }`, never `const name = ($, ...) =>`, or the module doesn't load.
- **An atom is read only where it is declared.** `read($, x)` and `update($, x, ...)` need `x` made by `atom(...)` in a const of the same file, so each file that reads or updates `welcome` declares it.
- **A hook's filter is read from the entry module's own consts.** With `WELCOME` imported, `claude plugin validate` lists `on('ui.render', { requestId: WELCOME }, ...)` as `requestId=?`, so `register.tsx` spells the id itself.

## Runtime behaviour

- **A plugin's own `$.command.run` never reaches its own `command.run` hook.** To start the tour from code, call `startTour($)` directly, then run the command only to get a row in the chat. The `CommandOutput` render hook recognises the row by its args.
- **Command rows start with the plugin's name.** A `CommandOutput` row's `text` reads `show-your-work: <what the command returned>`, so its first line starts with `show-your-work:`, the same as the marker. Read markers from the **last** line (`markOf` uses `findLast`).
- `CommandOutput` props: `command` (no slash, e.g. `img`), `args`, `text`, `isErrored`, `onScreen` (`null` when scrolled out of view).
- **Hot reload (`/reload-plugins`) may not re-run `session.start`.** Anything a hook needs (temp folder, ffmpeg path, cell size, version gate) comes from `setUp($)`, which is memoised and called lazily from the tool call, `/img` and `/show-your-work`. Module state resets on reload.
- **Pane hooks size from `e.props.bodyColumns` and `e.props.bodyRows` (or `e.props.scroll.bodyRows`).** `e.viewport` is the whole screen. See `paneSize`.
- **`Button` can hold `Text` children only on Claude Code 2.1.295+.** Older versions refuse the render. `canColourButtons` is set from `$.session.version()` in `setUp`.
- `$.process.run` takes `{ timeoutMs }`. A login shell (`sh -lc`) can hang on a slow profile: it gets 5 s, then a plain `sh -c`.
- **`$.process.run` times out after 30 s by default** (at most 600 s), and then kills the process and everything under it. It also waits for the child's stdout and stderr to close, so a background child that keeps them open holds the run until the timeout. On a desktop `xdg-open` doesn't know (niri, sway…), `xdg-open` runs the app in the foreground until it quits, so a viewer opened that way closed after 30 s. `openArgv` (`player.tsx`) starts it with `setsid -f` and its stdio on `/dev/null`, so the run returns at once.
- An `Image` source that equals the last one drawn is not sent again. That's why sources carry a `generation` (see `showing-images.md`).
- A process that must outlive the session (the channel move) is started through `DETACH`: `perl -MPOSIX -e 'fork and exit; POSIX::setsid(); exec @ARGV'`.
