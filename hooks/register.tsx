// The entry module: the tools and commands, and the hooks that tie the
// modules together.
import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'

import type { Check, KeyChange, Overlay, Shown, Summary } from '../types'

import { state } from './state'
import { clock, paneSize } from './layout'
import type { PaneProps } from './layout'
import { debug, diagnosis, flushDebug } from './diagnostics'
import { flush, track } from './telemetry'
import { setUp } from './setup'
import { forwardPictures, stopForwarding } from './tmux'
import { CLEAN_SH, exists, expand, findPasted, identityOf, keyOf, locate, NO_FFMPEG, noticeOf, prepare, preparePair, REASONS, shiftTimes, trimFrames, VIDEO } from './media'
import type { Notice } from './media'
import { handleOf, MARK, noteOf, preparedOf, remember, shownById, shownOf, storeOf, storeVersion, textOf, timesThatMean, versionsOf } from './history'
import { hadVersionBefore06, PLUGIN } from './updater'
import { atStep, cantDraw, causeOf, draw, freshCalls, mayBeDropped, noteDrawn, NO_PLACEHOLDERS, NoticeBox, player, removePicturesLine, sideOf, stop, terminalOf, toolLine, versions, Viewer } from './player'
import type { Ui } from './player'
import { ensureSettings, goToStop, loadSettings, Opening, openSettings, openUpdate, openWelcome, Settings, startBackground, startTour, Tour, TOUR_TEXT, UPDATE, UpdatePane, WELCOME_TEXT } from './onboarding'

const PANE = 'show-your-work'
// The tools, and their names from before the rename, so old windows still draw.
const TOOLS = ['show_image', 'show_video'].map(t => `mcp__show-your-work__${t}`)
// Screenshots and recordings made only to be shown go to the temp folder, so
// they don't pile up in the project; the history keeps its own copy.
const SCRATCH_NOTE = 'Save screenshots and recordings you make to show here in a temporary folder, such as $TMPDIR or /tmp, not in the project. Save them in the project only when the user asks to keep them, or when the project already has a folder for them, such as one for test screenshots.'
// What can be shown at all: anything else is refused before it is copied.
const MEDIA = /\.(png|jpe?g|webp|gif|tiff?|heic|heif|bmp|avif|mp4|mov|m4v|webm|mkv|avi)$/i
// The settings pane. A hook's filter is read from a const in this file, so its
// id is spelled here as well as in onboarding.tsx.
const WELCOME = 'show-your-work-welcome'
const current = atom({ plugin: 'show-your-work', key: 'current' } as const, null)
// The settings pane's and the tour's redraws. Declared in each file that
// reads or updates it: the engine only reads an atom declared in the same file.
const welcome = atom({ plugin: 'show-your-work', key: 'welcome' } as const, 0)
let pastedNames: string[] = []
// Each failed show's notice, by tool call, for the box drawn in its place.
const notices = new Map<string, Notice>()
// Each window's last drawing, handed back while nothing it shows changed.
const drawn = new Map<string, { key: string; tree: unknown; view: Shown }>()

const CHECKS = {
  type: 'array',
  description: 'Checks actually run, each measured, never eyeballed: { name (one full sentence saying what was verified, with real values), ok, at? (seconds into the video when it resolved), step? (the plan step, or "Extras"), expected? and actual? (required when ok is false: concrete values) }',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string' }, ok: { type: 'boolean' }, at: { type: 'number' }, url: { type: 'string' },
      step: { type: 'string' }, expected: { type: 'string' }, actual: { type: 'string' }, detail: { type: 'string' },
    },
    required: ['name', 'ok'],
  },
}

const TOOL_INPUT = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute path' },
    title: { type: 'string', description: 'Short caption' },
    pr: { type: 'string', description: 'PR URL or number' },
    url: { type: 'string', description: 'The page shown; adds Open page' },
    changes: {
      type: 'array',
      description: 'What changed: { title, detail?, at? (seconds), url? }, in clip order',
      items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' }, at: { type: 'number' }, url: { type: 'string' } }, required: ['title'] },
    },
    summary: {
      type: 'array',
      description: 'QA in up to 3 lines: { label, ok, passed?, total? }',
      items: { type: 'object', properties: { label: { type: 'string' }, ok: { type: 'boolean' }, passed: { type: 'number' }, total: { type: 'number' } }, required: ['label', 'ok'] },
    },
    checks: CHECKS,
    compare: { type: 'string', description: 'Path to the before version' },
    compare_checks: { ...CHECKS, description: 'The same checks on the before side' },
    changes_title: { type: 'string', description: 'Heading for the changes list when not "What changed", e.g. "Video structure"' },
    previous: { type: 'string', description: '#id of the version this revises' },
    versions: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, note: { type: 'string' } }, required: ['path'] }, description: 'Earlier unshown versions of this work, oldest first: { path, note }' },
    label: { type: 'string', description: 'Name for this side if the user asks (default "Updated")' },
    compare_label: { type: 'string', description: 'Name for the before side if the user asks (default "Original")' },
  },
  required: ['path'],
}

// A picture needs no timed checks, play button or custom list heading.
const IMAGE_INPUT = {
  ...TOOL_INPUT,
  properties: Object.fromEntries(Object.entries(TOOL_INPUT.properties).filter(([k]) => !['checks', 'compare_checks', 'changes_title'].includes(k))),
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    state.cwd = started.cwd
    state.setup = null
    await setUp($)
    state.sessionId = await $.session.id().catch(() => '')
    state.sentHint = ''
    state.hasVideoTools = false
    await loadSettings($)
    void (async () => {
      const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }
      state.pluginVersion = manifest.version ?? '0.0.0'
      const program = (await $.env.get('TERM_PROGRAM')) ?? ''
      const term = (await $.env.get('TERM')) ?? ''
      const terminal = terminalOf({ program, term, kitty: !!(await $.env.get('KITTY_WINDOW_ID')), konsole: !!(await $.env.get('KONSOLE_VERSION')), lcTerminal: (await $.env.get('LC_TERMINAL')) ?? '' })
      state.terminalName = terminal
      // iTerm2 draws pictures from bytes only, never from a file it's named.
      if (terminal === 'iterm2') state.sendBytes = true
      state.inTmux = !!(await $.env.get('TMUX')) || /^tmux/i.test(term)
      state.isDebug = /^(1|true|on|yes)$/i.test((await $.env.get('SHOW_YOUR_WORK_DEBUG')) ?? '')
      if (state.isDebug) $.clock.every(1000, () => void flushDebug($))
      // Terminals that can't paint Claude Code's placeholders never show a
      // picture, and tmux only with pictures forced on: known before the
      // first one.
      void removePicturesLine($)
      const isForwarded = state.inTmux && (await forwardPictures($))
      // The desktop app's Code tab draws no pictures (#18).
      const isDesktop = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop'
      if (isDesktop || (state.inTmux && !isForwarded) || NO_PLACEHOLDERS[state.terminalName]) {
        state.canImage = false
        state.probed = true
        state.drawCause = isDesktop ? 'desktop' : NO_PLACEHOLDERS[state.terminalName] ? 'terminal' : causeOf(state.inTmux, state.terminalName)
      }
      state.statsContext = {
        plugin_version: state.pluginVersion,
        claude_code_version: (await $.session.version().catch(() => ({ base: '' }))).base ?? '',
        terminal,
        has_ffmpeg: await exists($, state.ffmpeg),
        os: state.isMac ? 'macos' : 'linux',
      }
      // Every install sees the welcome and tour once, an update included:
      // installs from before 0.6.2 never had one. 0.6.0 stored 'welcomed' both
      // when it showed the welcome and when it skipped it for an update; an
      // older version's folder still beside this one marks the update.
      state.isWelcomed = !!(await $.store.get('toured'))
      if (!state.isWelcomed && await $.store.get('welcomed')) {
        const versions = await $.fs.list($.plugin.root.replace(/\/+$/, '').replace(/\/[^/]+$/, '')).catch(() => [])
        if (!hadVersionBefore06(versions.map(f => f.name))) {
          state.isWelcomed = true
          await $.store.set('toured', true)
        }
      }
      // An update keeps what it already ran: its updates and usage counts start
      // now, and only a fresh install waits for the welcome.
      const isUpdate = (await Promise.all(['welcomed', 'installId', 'updateCheckedAt'].map(key => $.store.get(key)))).some(value => value !== undefined && value !== null)
      if (!state.isWelcomed && isUpdate) await startBackground($)
      if (state.isWelcomed) await startBackground($)
      else await openWelcome($)
    })().catch(() => undefined)
    // Frames and converted pictures a week old go; a window that scrolls back
    // into view cuts its frames again from the source.
    void $.process.run(['sh', '-c', CLEAN_SH, state.TMP]).then(() => trimFrames($))
    await $.command.register({
      name: 'show-your-work',
      description: 'Settings for show-your-work; /show-your-work tour for the tour, /show-your-work update to check for updates, /show-your-work diagnose for recent problems',
      argumentHint: '[settings|tour|update|diagnose]',
    })
    await $.command.register({
      name: 'img',
      description: 'Show an image or video in the chat: /img <path>',
      argumentHint: '<path>',
    })
    await $.tool.register({
      name: 'show_image',
      description:
        `Shows an image file to the user, inline in their terminal. Accepts PNG, JPEG, WebP, GIF and TIFF.\n\nUse it without being asked whenever you have made or changed something visual, before you say the work is done: screenshot a page or component with headless Playwright, or show a design concept, chart, slide or generated image. Do this instead of asking the user to open a file or a localhost URL. Don't use it when nothing visual changed.\n\nWhen the image shows work you changed, also pass \`changes\` (what you changed, a few words each) and \`compare\` (an image of the same view from before the change), so the user can switch between Original, Updated and Compare. Pass \`summary\` only for checks you actually ran. When you show a new version of something you showed earlier, pass \`previous\` with its #id so both stay in the same history.\n\nThe image goes to the user's screen, not to you. Read the file yourself only if you need to check it.\n\n${SCRATCH_NOTE}`,
      inputSchema: IMAGE_INPUT,
      isDeferred: false,
    })
    await $.tool.register({
      name: 'show_video',
      description:
        `Plays a video file to the user, inline in their terminal, in a player that starts on its own. Accepts MP4, MOV, WebM and GIF.\n\nUse it without being asked to show recordings: after building or fixing an interactive feature, record a headless Playwright run that clicks through it and play that, rather than asking the user to try it themselves. Also use it for animations and for ad or film cuts you have made.\n\nWhen the video shows work you changed, pass \`changes\`, each with \`at\` (the second it appears), and \`checks\` for what you tested, also with \`at\`. For a fix, record the same steps on the old version and pass that file as \`compare\` with its own \`compare_checks\`; the two play side by side, in sync. Pass \`summary\` only for checks you actually ran, and \`previous\` with an earlier #id when this is a new version of something you showed.\n\nKeep clips short: they are played as frames, at most 900 at up to 12 per second. You do not see the video.\n\n${SCRATCH_NOTE}`,
      inputSchema: TOOL_INPUT,
      isDeferred: false,
    })

    return started
  })

  // While pictures draw, Claude is told up front that it can show its work,
  // so it does so without being asked. Once a draw has failed, the next turn
  // knows instead: what was "shown" was a notice, not the picture.
  // Sent as the prompt's context, once per session and again after a
  // compaction or a change: prompt.compose is skipped on Team and Enterprise
  // logins, where Claude Code's own guard runs ahead of every mod (#13).
  on('session.compact', ($, e, next) => {
    if (!e.agentId) state.sentHint = ''

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await flush($).catch(() => undefined)
    await stopForwarding($)

    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    // Sending a message puts the settings away.
    if (e.origin?.kind !== 'plugin') void $.ui.panes().then(panes => { if (panes.some(p => p.id === WELCOME)) return $.ui.close({ id: WELCOME }) }).catch(() => undefined)
    pastedNames = (e.attachments ?? []).filter(a => a.type === 'image' && a.filename).map(a => a.filename!)
    const hint = hintNow()
    if (e.command || hint === state.sentHint) return next(e)
    state.sentHint = hint

    return next({ ...e, context: [...(e.context ?? []), hint] })
  })

  on('command.run', { command: 'img' }, async ($, invoked) => {
    await setUp($)
    let arg = invoked.args.trim()
    if (/^\[Image #\d+\]$/.test(arg) || (!arg && pastedNames.length > 0)) {
      const name = pastedNames.at(-1)
      const found = name ? await findPasted($, name) : null
      if (!found) {
        return {
          text: 'Pasted images reach Claude, not mods, so /img cannot read one. Drag the file into the prompt (that types its path) or type the path: /img ~/path/to/file.png',
        }
      }
      arg = found
    }
    if (!arg) return { text: 'Usage: /img <path>' }
    try {
      const shown = await prepare($, arg)
      // Drawn in the chat, in this command's own row, by the CommandOutput hook.
      const id = keyOf(`${arg}|${await $.clock.now()}`).slice(0, 10)
      shownById.set(id, shown)
      // Saved beside the history too, so the row still draws after a reload
      // wipes the module's memory.
      await $.process.run(['sh', '-c', 'printf "%s" "$1" > "$0"', `${await storeOf($)}/${id}.shown`, JSON.stringify(shown)]).catch(() => undefined)

      track('img_command', { kind: shown.frames ? 'video' : 'image' })
      return { text: `Showing ${shown.title}.\n${MARK}#${id}` }
    } catch (err) {
      const n = noticeOf(err, expand(arg, state.cwd, state.home), state.home)
      track('show_failed', { from: 'img_command', reason: REASONS[n.kind] })
      return { text: n.message }
    }
  })

  on('tool.call', { tool: /^mcp__show-your-work__show_(image|video)$/ }, async ($, e) => {
    freshCalls.add(e.tool_use_id)
    const input = { ...e } as unknown as {
      path?: string; title?: string; change?: string; pr?: string; changes?: KeyChange[]; summary?: Summary[]; url?: string; checks?: Check[]
      compare?: string; compare_checks?: Check[]; label?: string; compare_label?: string; overlay?: Overlay; versions?: unknown; previous?: string; changes_title?: string
    }
    if (!input.path) return { deny: 'A path is needed.' }
    await setUp($)
    // The history's copy of a file that then can't be shown goes again.
    let copied = ''
    try {
      input.path = await locate($, input.path)
      if (input.compare) input.compare = await locate($, input.compare)
      const note = noteOf(input.changes, input.change, input.title)
      const parent = handleOf(input.previous)
      // Only pictures and videos are copied into the history: never a key or
      // a config file a model was talked into naming.
      if (!MEDIA.test(input.path)) throw new Error(`not an image: ${input.path}`)
      const kept = await storeVersion($, input.path, note, input.title, parent)
        .catch(() => ({ real: input.path!, copy: input.path!, id: '', chain: [] as { path: string; note?: string; id: string }[], missing: undefined as string | undefined }))
      if (kept.copy !== kept.real) copied = kept.copy
      // Every earlier version: the ones handed in, then the ones shown before.
      const given = await Promise.all(versionsOf(input.versions).map(async v => ({ ...v, path: await locate($, v.path) })))
      const earlier = [...given, ...kept.chain.filter(k => !given.some(g => g.path === k.path))]
      const compare = input.compare ?? earlier.at(-1)?.path
      const shown: Shown = {
        ...(await prepare($, kept.copy, input.title ?? input.path.split('/').pop(), await identityOf($, input.path))),
        origin: kept.real,
        change: input.change,
        pr: input.pr,
        url: input.url,
        checks: input.checks,
        changes: timesThatMean(input.changes, VIDEO.test(input.path)),
        summary: input.summary,
        label: input.label,
        overlay: input.overlay,
        note,
        ...(input.changes_title ? { changesTitle: String(input.changes_title).slice(0, 28) } : {}),
      }
      const lead = shown.frames?.lead ?? 0
      shown.checks = shiftTimes(shown.checks, lead)
      shown.changes = shiftTimes(shown.changes, lead)
      if (compare) {
        const label = input.compare_label
        shown.compare = {
          ...(input.compare ? await prepare($, compare, label ?? 'Original') : await preparedOf($, compare)),
          label,
          checks: input.compare_checks,
        }
        shown.compare.checks = shiftTimes(shown.compare.checks, shown.compare.frames?.lead ?? 0)
        // Pictures step back through every earlier version; a clip has only
        // Original and Updated.
        if (!shown.frames && earlier.length > 1) {
          shown.history = input.compare && !earlier.some(v => v.path === compare) ? [{ path: compare }, ...earlier] : earlier
          shown.historyAt = shown.history.findIndex(v => v.path === compare)
          remember(compare, shown.compare)
        }
        if (shown.frames && shown.compare.frames) Object.assign(shown, (await preparePair($, shown.compare, shown)) ?? {})
      }
      if (!shown.frames && kept.copy !== kept.real)
        remember(kept.copy, { kind: shown.kind, path: shown.path, source: shown.source, width: shown.width, height: shown.height, title: 'Original', generation: shown.generation })
      const what = shown.frames ? `video, ${clock(shown.frames.duration)}` : `${shown.sourceWidth ?? shown.width}×${shown.sourceHeight ?? shown.height}`
      const checks = [...(shown.checks ?? []), ...(shown.compare?.checks ?? [])]
      track(shown.frames ? 'video_shown' : 'image_shown', {
        format: (input.path.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'none').toLowerCase().slice(0, 5),
        ...(shown.frames ? { duration: Math.round(shown.frames.duration * 10) / 10, frames: shown.frames.count } : {}),
        has_compare: !!shown.compare,
        is_side_by_side: !!shown.pair,
        is_revision: !!input.previous,
        versions: shown.history?.length ?? 0,
        changes: shown.changes?.length ?? 0,
        has_custom_changes_title: !!input.changes_title,
        summary_lines: shown.summary?.length ?? 0,
        summary_ok: shown.summary ? shown.summary.every(l => l.ok) : undefined,
        checks: checks.length,
        checks_failed: checks.filter(c => !c.ok).length,
        has_url: !!input.url,
        has_pr: !!input.pr,
      })

      const handle = kept.id ? ` #${kept.id}${kept.chain.length ? `, version ${kept.chain.length + 1} after #${kept.chain.at(-1)!.id}` : ''}.` : ''
      const hint = (kept.missing ? ` #${kept.missing} wasn't found, so this has no history.` : '') + handle
      const opening = state.canImage
        ? `Shown: ${shown.title} (${what}).`
        : `Not shown: ${cantDraw(state.drawCause, shown.title, shown.frames ? 'video' : 'picture', state.sessionId).claude} Don't say it was shown.`
      // Claude gets one short line; the drawing data stays out of its context.
      let mark = JSON.stringify(shown)
      if (kept.id) {
        const saved = await $.process.run(['sh', '-c', 'printf "%s" "$1" > "$0"', `${await storeOf($)}/${kept.id}.shown`, mark]).catch(() => null)
        if (saved && saved.exitCode === 0) {
          shownById.set(kept.id, shown)
          mark = `#${kept.id}`
        }
      }
      return { result: `${opening}${hint}\n${MARK}${mark}` }
    } catch (err) {
      if (copied) void $.process.run(['rm', '-f', '--', copied, copied.replace(/\.[^./]+$/, '.json')]).catch(() => undefined)
      const n = noticeOf(err, expand(input.path ?? '', state.cwd, state.home), state.home)
      notices.set(e.tool_use_id, n)
      track('show_failed', { from: String((e as { tool?: string }).tool ?? '').endsWith('video') ? 'show_video' : 'show_image', reason: REASONS[n.kind] })
      return { deny: `show-your-work: ${n.message}` }
    }
  }).catch(() => ({ deny: 'show-your-work: it could not be shown.' }))

  // The call's own row: one short line, not the whole input.
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    const props = e.props as { tool: string; input: unknown; isRunning: boolean }
    if (!TOOLS.includes(props.tool)) return next(e)
    const { Text } = $.ui.resolve(e) as Ui

    return <Text>{toolLine(props.tool, props.input, props.isRunning)}</Text>
  })

  // Inline in the transcript: the player is the tool's result row.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const props = e.props as { tool: string; output: unknown; isErrored: boolean; onScreen?: unknown }
    if (!TOOLS.includes(props.tool)) return next(e)
    if (props.isErrored) {
      const n = notices.get((props as { tool_use_id?: string }).tool_use_id ?? '') ??
        (textOf(props.output).includes(NO_FFMPEG) ? noticeOf(new Error(NO_FFMPEG), '') : undefined)
      if (!n) return next(e)
      return NoticeBox($.ui.resolve(e) as Ui, $, (e.viewport?.columns ?? 100) - 8, { ...n, copy: n.prompt, label: 'Copy prompt', action: `copy_${n.kind}_prompt` })
    }
    // Scrolled out of view: stop playing, and don't start there.
    const one = player(e.requestId)
    if (props.onScreen === null) {
      if (one.timer) stop($, e.requestId)
      one.hasAutoplayed = true
      if (!one.wasAway) debug(`away ${e.requestId}`)
      one.wasAway = true
    } else if (one.wasAway && props.onScreen) {
      // Back in view. The layout hasn't changed, so the kept drawing stands;
      // only the picture is sent again, as the terminal may have dropped it.
      one.wasAway = false
      one.resend = true
      debug(`back ${e.requestId}`)
    }
    const key = `${state.version}|${versions.get(e.requestId) ?? 0}|${e.viewport?.columns ?? 0}|${e.viewport?.rows ?? 0}`
    const kept = drawn.get(e.requestId)
    let tree = kept?.key === key ? (kept.tree as Awaited<ReturnType<typeof Viewer>>) : null
    let view = kept?.view
    if (!tree || !view) {
      // After /reload-plugins nothing else has set up the folders yet: without
      // this the result looks for its picture in the wrong place and collapses.
      await setUp($)
      await ensureSettings($)
      const shown = await shownOf($, props.output)
      if (!shown) return next(e)
      view = atStep(shown, e.requestId)
      tree = await Viewer($, e, view, e.requestId, false, e.viewport)
      drawn.set(e.requestId, { key, tree, view })
      if (kept?.view === undefined) noteDrawn(e.requestId, view.width, view.height)
    }
    // Back in view: send the picture again at once, but only if the terminal
    // may have dropped it; otherwise it still has it and nothing is decoded.
    if (one.resend) {
      one.resend = false
      if (mayBeDropped(e.requestId)) {
        debug(`resend ${e.requestId}`)
        draw($, e.requestId, sideOf(view, e.requestId), view)
      }
    }

    return tree
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    const shown = await read($, current)
    if (!shown) return <Text dimColor>Nothing to show yet. Run /img path/to/file</Text>

    return Viewer($, e, atStep(shown, PANE), PANE, true, paneSize(e.viewport, e.props as PaneProps))
  })

  on('command.run', { command: 'show-your-work' }, async ($, invoked) => {
    await setUp($)
    if (/^tour$/i.test(invoked.args.trim())) {
      startTour($)
      return { text: TOUR_TEXT }
    }
    // What went wrong lately, for a bug report: problems noticed (always kept)
    // and where the full local log is. Nothing here is sent anywhere.
    if (/^diagnose$/i.test(invoked.args.trim())) return { text: diagnosis(await $.clock.now()) }
    if (/^update$/i.test(invoked.args.trim())) {
      void openUpdate($).catch(() => undefined)
      return { text: 'Checking for show-your-work updates.' }
    }
    // /show-your-work settings (or setting) opens them, never closes them.
    const isSettings = /^settings?$/i.test(invoked.args.trim())
    // Run again while they're open, the settings close.
    if (!isSettings && (await $.ui.panes()).some(pane => pane.id === WELCOME)) {
      await $.ui.close({ id: WELCOME })
      return { text: 'Closed the show-your-work settings.' }
    }
    await openSettings($)
    return { text: 'Opened the show-your-work settings.' }
  })

  on('ui.render', { component: 'Pane', requestId: UPDATE }, async ($, e) => {
    await setUp($)
    await read($, welcome)
    return UpdatePane($.ui.resolve(e) as Ui, $)
  })

  on('ui.render', { component: 'Pane', requestId: WELCOME }, async ($, e) => {
    await setUp($)
    await read($, welcome)
    await loadSettings($)
    return Settings($.ui.resolve(e) as Ui, $)
  })


  // The welcome's row: /show-your-work as the plugin ran it on install.
  const welcomeRows = new Set<string>()
  const tourRows = new Set<string>()
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    const row = e.props as { command?: string; args?: string; text?: string; isErrored?: boolean; onScreen?: unknown }
    // /img: the player, in the chat under the command.
    if (row.command === 'img' && !row.isErrored && (row.text ?? '').includes(MARK)) {
      await setUp($)
      await ensureSettings($)
      const shown = await shownOf($, row.text ?? '')
      if (!shown) {
        // A row from before a restart: the picture is no longer at hand.
        const { Text } = $.ui.resolve(e) as Ui
        return <Text dimColor>{(row.text ?? '').split('\n')[0]}</Text>
      }
      const one = player(e.requestId)
      if (row.onScreen === null && one.timer) stop($, e.requestId)
      return Viewer($, e, atStep(shown, e.requestId), e.requestId, false, e.viewport)
    }
    if (row.command !== PLUGIN) return next(e)
    if (/^tour$/i.test(row.args?.trim() ?? '') || (row.text ?? '').includes(TOUR_TEXT)) {
      // A tour row not drawn before is the newest: it becomes the live one.
      if (!tourRows.has(e.requestId)) {
        tourRows.add(e.requestId)
        const was = state.tourSite
        state.tourSite = e.requestId
        const isFresh = state.isTourPending || !was
        state.isTourPending = false
        // Drawing can't change state: the stop (re)starts just after.
        void $.clock.sleep(0).then(() => { if (was && was !== state.tourSite) stop($, was); goToStop($, isFresh ? 0 : state.tourStop) }, () => undefined)
      }
      if (e.requestId !== state.tourSite) {
        const { Text } = $.ui.resolve(e) as Ui
        return <Text dimColor>This tour moved to a newer one below.</Text>
      }
      // A plugin reload resets the module's state. setUp reads the Claude Code
      // version again, which decides whether buttons can have coloured text.
      await setUp($)
      await read($, welcome)
      return Tour($, e, e.viewport)
    }
    if (!welcomeRows.has(e.requestId)) {
      if (!(row.text ?? '').includes(WELCOME_TEXT)) return next(e)
      welcomeRows.add(e.requestId)
    }
    await setUp($)
    return Opening($, e, e.requestId, e.viewport)
  })
}

// What Claude is told about showing its work, for the state pictures are in now.
function hintNow() {
  if (state.canImage) return "This terminal shows pictures and videos inline. After visual work, screenshot or record it and show it with show_image or show_video before you say you're done, instead of telling the user to open a file or localhost. For a UI fix, show before and after."
  const why = cantDraw(state.drawCause, 'it', 'picture', state.sessionId).claude.replace(/, so the person saw a notice instead of it\./, '.')
  return `show-your-work: pictures and videos can't draw in this session (${why}) Anything shown with show_image or show_video was not seen: the person saw a notice instead. Don't say they saw it.`
}
