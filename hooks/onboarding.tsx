// First run and settings: the settings pane, the welcome and the tour.
import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Shown } from '../types'

import { SETTINGS, settings, state } from './state'
import type { Field } from './state'
import { act, flush, startTelemetry, track } from './telemetry'
import { prepare } from './media'
import { preparedOf } from './history'
import { BRANCHES, checkForUpdate, findUpdate, installUpdate, PLUGIN } from './updater'
import type { Found } from './updater'
import { STOPS } from './tour'
import type { Stop } from './tour'
import { arePicturesOn, atStep, freshCalls, play, players, redraw, stop, SWITCHABLE, turnOffPictures, turnOnPictures, Viewer } from './player'
import type { Ui } from './player'

// ── Settings and welcome ─────────────────────────────────────────────────

export const WELCOME = 'show-your-work-welcome'
// The settings pane's and the tour's redraws. Declared in each file that
// reads or updates it: the engine only reads an atom declared in the same file.
const welcome = atom({ plugin: 'show-your-work', key: 'welcome' } as const, 0)

// A no to usage data given before these settings (0.5.12's question, 0.5.16's command) stays a no.
// Updates are on for everyone: fixes have to reach every install.
export const earlierNo = (consent: unknown, statsOff: unknown, updatesOff: unknown) => {
  const asked = consent && typeof consent === 'object' ? consent as { stats?: unknown; updates?: unknown } : {}
  return { isStatsOff: statsOff === true || asked.stats === false, isUpdatesOff: updatesOff === true || asked.updates === false }
}

// Reads the saved settings once per plugin load. A reload starts with the
// defaults in memory, and without this pictures would be laid out as Standard
// until the next session start.
let hasLoadedSettings = false
export async function ensureSettings($: EngineInterface) {
  if (hasLoadedSettings) return
  hasLoadedSettings = true
  // Unreadable (no store): the defaults stand.
  await loadSettings($).catch(() => undefined)
}

export async function loadSettings($: EngineInterface) {
  const saved = ((await $.store.get('settings')) ?? {}) as Partial<Record<Field, unknown>>
  if (typeof saved.usage_stats !== 'boolean' && earlierNo(await $.store.get('consent'), await $.store.get('statsOff'), null).isStatsOff) settings.usage_stats = false
  for (const { field } of SETTINGS) if (typeof saved[field] === 'boolean') settings[field] = saved[field] as boolean
}

async function switchSetting($: EngineInterface, field: Field, value: boolean) {
  // The saved choices, not this module's copy: a reload resets the copy.
  await loadSettings($)
  settings[field] = value
  act(`setting_${field}_${value ? 'first' : 'second'}`)
  await $.store.set('settings', { ...settings })
  // The profile keeps the install's current choice of update channel.
  if (field === 'stable_updates') track('settings_changed', { $set: { update_channel: value ? 'stable' : 'latest' } })
  if (field === 'standard_size') {
    track('settings_changed', { $set: { picture_size: value ? 'standard' : 'large' } })
    // Players already on screen redraw at the new size.
    redraw($)
  }
  // Turning usage data off sends one last signal saying so, then nothing more.
  if (field === 'usage_stats' && !value && state.isOn) {
    track('usage_data_turned_off', { $set: { usage_data: 'off' } })
    await flush($).catch(() => undefined)
  }
  // Off means off: nothing queued is kept for later.
  if (field === 'usage_stats' && !value) {
    state.isOn = false
    state.queue = []
  }
  if (field === 'usage_stats' && value && state.isWelcomed) await startTelemetry($, state.statsContext)
  // A new channel is followed now.
  if (field === 'stable_updates' && state.isWelcomed) {
    await $.store.set('updateCheckedAt', 0)
    void checkForUpdate($, state.pluginVersion, value ? BRANCHES.stable : BRANCHES.latest).catch(() => undefined)
  }
  await update($, welcome, n => n + 1)
}

// Updates and usage counts wait for the welcome on a first run, so a switch
// turned off there is off before anything is sent.
export async function startBackground($: EngineInterface) {
  if (hasStarted) return
  hasStarted = true
  if (settings.usage_stats) await startTelemetry($, state.statsContext)
  await checkForUpdate($, state.pluginVersion, settings.stable_updates ? BRANCHES.stable : BRANCHES.latest)
}

// The first run (see 'toured'): the plugin runs /show-your-work once, and its output row
// in the chat draws the welcome. That run answers with WELCOME_TEXT, which is
// how its row is told from the person's own /show-your-work.
export const WELCOME_TEXT = 'show-your-work is installed and ready.'
export async function openWelcome($: EngineInterface) {
  await prepareSplash($).catch(() => undefined)
  await finishWelcome($)
  await openTour($)
}

// /show-your-work update opens this pane. It checks GitHub for the newest
// version on the person's channel (Stable or Latest) right away, skipping the
// once-a-day limit, then offers Install. Nothing installs until they press it.
export const UPDATE = 'show-your-work-update'
type UpdateCheck =
  | { phase: 'checking' }
  | { phase: 'found'; found: Found }
  | { phase: 'installing'; latest: string }
  | { phase: 'installed'; latest: string }
  | { phase: 'failed' }
let updateCheck: UpdateCheck = { phase: 'checking' }
export async function openUpdate($: EngineInterface) {
  updateCheck = { phase: 'checking' }
  await $.ui.open({ id: UPDATE, title: 'Updates', focus: true, closeOnEscape: true, holdToasts: true, rows: 9, columns: 70 })
  await update($, welcome, n => n + 1)
  await loadSettings($)
  const branch = settings.stable_updates ? BRANCHES.stable : BRANCHES.latest
  const found = await findUpdate($, state.pluginVersion, branch).catch((): Found => ({ kind: 'offline' }))
  updateCheck = { phase: 'found', found }
  await update($, welcome, n => n + 1)
}

async function installFound($: EngineInterface, found: Extract<Found, { kind: 'update' | 'move' }>) {
  act('update_install')
  updateCheck = { phase: 'installing', latest: found.latest }
  await update($, welcome, n => n + 1)
  const isDone = await installUpdate($, found, state.pluginVersion).catch(() => false)
  updateCheck = isDone ? { phase: 'installed', latest: found.latest } : { phase: 'failed' }
  await update($, welcome, n => n + 1)
}

export function UpdatePane(ui: Ui, $: EngineInterface) {
  const { Box, Text, Button } = ui
  const channel = settings.stable_updates ? 'Stable releases' : 'Latest releases'
  const close = <Button key="update-close" label="Close" onPress={() => void $.ui.close({ id: UPDATE })} />
  const c = updateCheck
  const found = c.phase === 'found' ? c.found : null
  // Each outcome of the check sets a bold headline, a dim second line, and
  // the buttons. Install shows only when there is a newer version.
  let head = 'Checking for updates…'
  let line = `On ${state.pluginVersion} · ${channel}`
  let actions: Ui[] = []
  if (found?.kind === 'update' || found?.kind === 'move') {
    head = `Version ${found.latest} is available`
    actions = [<Button key="update-install" variant="primary" label="Install" onPress={() => void installFound($, found)} />, close]
  } else if (found?.kind === 'current') {
    head = "You're on the latest version"
    actions = [close]
  } else if (found?.kind === 'pending') {
    head = `Version ${found.latest} is installed`
    line = 'Restart Claude Code to start using it.'
    actions = [close]
  } else if (found?.kind === 'folder') {
    head = 'This copy runs from a folder, so it doesn\'t update'
    actions = [close]
  } else if (found?.kind === 'pinned') {
    head = `This install is pinned to ${found.ref}, so it doesn't update`
    actions = [close]
  } else if (found?.kind === 'no_cli') {
    head = "Couldn't find Claude Code's command"
    line = 'Update by hand with: claude plugin update show-your-work@iamumeransari'
    actions = [close]
  } else if (found?.kind === 'offline') {
    head = "Couldn't check for updates"
    line = 'Check your connection and run /show-your-work update again.'
    actions = [close]
  } else if (c.phase === 'installing') {
    head = `Installing ${c.latest}…`
  } else if (c.phase === 'installed') {
    head = `Version ${c.latest} is installed`
    line = 'Restart Claude Code to start using it.'
    actions = [close]
  } else if (c.phase === 'failed') {
    head = "Couldn't install the update"
    line = `Try again, or run: claude plugin update ${PLUGIN}@iamumeransari`
    actions = [close]
  }
  return (
    <Box flexDirection="column" paddingX={2} paddingBottom={1}>
      <Text bold>{head}</Text>
      <Text dimColor>{line}</Text>
      {actions.length > 0 && <Box flexDirection="row" columnGap={2} marginTop={1}>{actions}</Box>}
    </Box>
  )
}

// /show-your-work: the switches, in a pane.
export async function openSettings($: EngineInterface) {
  await $.ui.open({ id: WELCOME, title: 'Settings', focus: true, closeOnEscape: true, holdToasts: true, rows: 10, columns: 70 })
  await update($, welcome, n => n + 1)
}

let hasStarted = false
async function finishWelcome($: EngineInterface) {
  if (state.isWelcomed) return
  state.isWelcomed = true
  await $.store.set('toured', true)
  await startBackground($)
}

// A five-second recording of a form being tested, played in the real
// player with its changes and checks; the picture of one without ffmpeg.
// The welcome's opening: show-your-work rising over a night sky, played once
// as a picture with no controls, then held on its last frame. A still
// without ffmpeg.
let splash: Shown | null = null
let hasPlayedSplash = false
async function prepareSplash($: EngineInterface) {
  const opened = await prepare($, `${$.plugin.root}/assets/splash.mp4`, 'show-your-work')
    .catch(() => prepare($, `${$.plugin.root}/assets/splash.jpg`, 'show-your-work'))
    .catch(() => null)
  // The player's side list: what the plugin does, and real checks of this
  // setup, ticking as the opening plays.
  splash = opened && {
    ...opened,
    changesTitle: 'What it does',
    changes: [
      { title: 'Installed', at: 1.8 },
      { title: 'Everything Claude can show you', at: 5.0 },
      { title: 'Claude shows what it builds', at: 15.7 },
    ],
    checks: [
      { name: 'This terminal draws pictures', ok: state.canImage, at: 2.2 },
      { name: 'ffmpeg plays videos', ok: !!opened.frames, at: 5.5 },
      { name: 'Plugin installed', ok: true, at: 16.0 },
    ],
  }
  await update($, welcome, n => n + 1)
  redraw($)
}

// /show-your-work's pane: the switches, and the way back into the tour.
export function Settings(ui: Ui, $: EngineInterface) {
  const { Box, Text, Button } = ui
  return (
    <Box flexDirection="column" paddingX={2} paddingBottom={1}>
      <Box flexDirection="row" columnGap={2} marginBottom={1}>
        <Button key="close" label="✕ Close" onPress={() => void $.ui.close({ id: WELCOME })} />
        <Button key="tour" label="Take a tour" onPress={() => { act('tour_from_settings'); void $.ui.close({ id: WELCOME }).then(() => openTour($)) }} />
      </Box>
      <Box marginBottom={1}><Text bold>Show Your Work Settings</Text></Box>
      {SettingRows(ui, $)}
    </Box>
  )
}

// Quiet: plain words, the choice marked ● and the other ○, in columns that
// line up, so choosing moves nothing.
function SettingRows(ui: Ui, $: EngineInterface) {
  const { Box, Text, Button } = ui
  const first = Math.max(...SETTINGS.map(s => s.options[0].length)) + 4
  return (
    <Box flexDirection="column">
      {SETTINGS.map(s => (
        <Box key={`row-${s.field}`} flexDirection="row">
          <Box width={24} flexShrink={0}><Text dimColor>{s.title}</Text></Box>
          {s.options.map((label, k) => {
            const isChosen = settings[s.field] === (k === 0)
            return (
              <Box key={`slot-${s.field}-${k}`} width={k === 0 ? first : undefined} flexShrink={0}>
                {/* The default in green, the other in orange; the one not chosen
                    dim. Before Claude Code 2.1.295 a Button holds only its label. */}
                {state.canColourButtons ? (
                  <Button key={`${s.field}-${k}`} plain label={`${isChosen ? '●' : '○'} ${label}`} onPress={() => void switchSetting($, s.field, k === 0)}>
                    <Text color={k === 0 ? 'success' : 'claude'} dimColor={!isChosen}>{`${isChosen ? '●' : '○'} ${label}`}</Text>
                  </Button>
                ) : (
                  <Button key={`${s.field}-${k}`} plain {...(isChosen ? {} : { dimColor: true })} label={`${isChosen ? '●' : '○'} ${label}`} onPress={() => void switchSetting($, s.field, k === 0)} />
                )}
              </Box>
            )
          })}
        </Box>
      ))}
      {/* Only in a terminal where Claude Code leaves pictures off by default. */}
      {SWITCHABLE[state.terminalName] && (
        <Box key="row-pictures" flexDirection="row">
          <Box width={24} flexShrink={0}><Text dimColor>{`Pictures in ${SWITCHABLE[state.terminalName]!.label}`}</Text></Box>
          {(['On', 'Off'] as const).map((label, k) => {
            const isChosen = arePicturesOn() === (k === 0)
            const text = `${isChosen ? '●' : '○'} ${label}`
            const press = () => void (k === 0 ? turnOnPictures($) : turnOffPictures($))
            return (
              <Box key={`slot-pictures-${k}`} width={k === 0 ? first : undefined} flexShrink={0}>
                {state.canColourButtons ? (
                  <Button key={`pictures-${k}`} plain label={text} onPress={press}>
                    <Text color={k === 0 ? 'success' : 'claude'} dimColor={!isChosen}>{text}</Text>
                  </Button>
                ) : (
                  <Button key={`pictures-${k}`} plain {...(isChosen ? {} : { dimColor: true })} label={text} onPress={press} />
                )}
              </Box>
            )
          })}
        </Box>
      )}
      <Box marginTop={1}><Text dimColor>Usage data is anonymous and helps fix bugs and improve the product experience. No sensitive data is ever shared.</Text></Box>
    </Box>
  )
}

// The welcome row: the opening in the real player, with its side list, then
// what to ask and one quiet line about updates and usage counts.
export async function Opening($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], site: string, viewport?: { columns: number; rows: number }) {
  const { Box, Text } = $.ui.resolve(e) as Ui
  let view = null
  // Where pictures can't draw, the heading alone: a warning has no place here.
  if (splash && state.canImage) {
    // Plays by itself once, as a video Claude shows does.
    if (!hasPlayedSplash) {
      hasPlayedSplash = true
      freshCalls.add(site)
    }
    view = await Viewer($, e, atStep(splash, site), site, false, viewport)
  }
  return (
    <Box flexDirection="column" rowGap={1}>
      {view ?? <Text bold color="claude">✦ show-your-work is installed and ready</Text>}
      <Box flexDirection="column">
        <Text>Claude now shows you pictures and videos right here in the chat. Try asking Claude to create something and show it to you in the chat, as an image or a recording.</Text>
        <Text dimColor>It keeps itself updated and sends anonymous usage counts. Change this with /show-your-work, and see every feature with /show-your-work tour.</Text>
      </Box>
    </Box>
  )
}

// ── Tour ─────────────────────────────────────────────────────────────────

// A walk through the player on the launch film's demos: the opening, a recording with
// its report, the same recording against the broken version, a screenshot's
// history, then the commands and switches. Opens by itself on a fresh
// install; /show-your-work tour, or the button in the settings, opens it again.
const TOUR = 'show-your-work-tour'
// The tour is a message in the chat, drawn by the output row of
// /show-your-work tour (TOUR_TEXT marks it): it lays out at the chat's full
// width at any window size. tourSite is the live row; an older one shrinks to
// a line.
export const TOUR_TEXT = 'show-your-work tour.'

// The one line above the control a stop points at, in the tour's row only.
const tourMedia: { recording?: Shown | null; compare?: Shown | null; history?: Shown | null } = {}

// The demo's media, read once, all from the launch film: the new-trip form
// tested with its changes and checks, the Tern hero before and after its
// trip card, and the hero's history from four directions to every width.
// Loads the demo media for steps 2, 3 and 4 in parallel. Each one redraws
// the tour when it finishes, so a step never waits for the others' media.
async function prepareTour($: EngineInterface) {
  const dir = `${$.plugin.root}/assets/tour`
  const ready = () => update($, welcome, n => n + 1)
  const recording = async () => {
    if (tourMedia.recording !== undefined) return
    tourMedia.recording = await (async () => {
      const clip = await prepare($, `${dir}/trip-form.mp4`, 'New trip form')
      const lead = clip.frames?.lead ?? 0
      const at = (s: number) => Math.max(0, s - lead)
      return {
        ...clip,
        // Where each step lands in the recording (its QA run, 1.3 s behind the log).
        changes: [
          { title: 'Dates pick a range, nights in the summary', at: at(5.25) },
          { title: 'Invalid emails rejected with a message', at: at(6.85) },
          { title: 'Invites become chips', at: at(9.1) },
          { title: 'Create trip opens the trip', at: at(10.5) },
        ],
        checks: [
          { name: 'Dates pick a range', ok: true, at: at(5.25) },
          { name: 'Bad emails get a message', ok: true, at: at(6.85) },
          { name: 'Invites become chips', ok: true, at: at(9.1) },
          { name: 'Create trip opens the trip', ok: true, at: at(10.7) },
          { name: 'Labels for screen readers', ok: true, at: at(11.2) },
        ],
        summary: [
          { label: 'Trip form works end to end', ok: true, passed: 4, total: 4 },
          { label: 'Labels for screen readers', ok: true, passed: 1, total: 1 },
        ],
      } as Shown
    })().catch(() => prepare($, `${dir}/hero.jpg`, 'Tern homepage').catch(() => null))
    await ready()
  }
  const compare = async () => {
    if (tourMedia.compare !== undefined) return
    tourMedia.compare = await (async () => ({
      ...(await prepare($, `${dir}/hero.jpg`, 'Tern homepage')),
      changes: [{ title: 'Trip card beside the headline' }, { title: 'Friends and trip count under the button' }],
      compare: await prepare($, `${dir}/direction-b.jpg`, 'Original'),
    }) as Shown)().catch(() => null)
    await ready()
  }
  const history = async () => {
    if (tourMedia.history !== undefined) return
    tourMedia.history = await (async () => {
      const hero = `${dir}/hero.jpg`
      return {
        ...(await prepare($, `${dir}/breakpoints.jpg`, 'Tern homepage')),
        changes: [{ title: 'Desktop, tablet and phone' }],
        note: 'Desktop, tablet and phone',
        compare: await preparedOf($, hero),
        history: [
          { path: `${dir}/concepts.jpg`, note: 'Four directions' },
          { path: `${dir}/direction-b.jpg`, note: 'Direction B, full size' },
          { path: hero, note: 'Trip card beside the headline' },
        ],
        historyAt: 2,
      } as Shown
    })().catch(() => null)
    await ready()
  }
  await Promise.all([recording(), compare(), history()])
}

// Runs /show-your-work tour, whose output row draws the tour.
async function openTour($: EngineInterface) {
  // A plugin's own run never reaches its own command.run hook: the tour starts
  // here, and its row is drawn by the args it carries.
  startTour($)
  await $.command.run({ command: PLUGIN, args: 'tour' }).catch(() => undefined)
}

// What /show-your-work tour does before its row draws: the first stop, and
// the demo's media read in the background.
export function startTour($: EngineInterface) {
  act('tour_open')
  state.isTourPending = true
  state.isTourDone = false
  state.tourStop = 0
  loadDemo($)
}

// Starts loading every step's media: step 1's video and the others at the same
// time. Runs once per plugin load. A reload clears the loaded media but keeps
// the tour's row in the chat, so Tour calls this too when it finds media missing.
let isDemoLoading = false
function loadDemo($: EngineInterface) {
  if (isDemoLoading) return
  isDemoLoading = true
  if (!splash) void prepareSplash($).catch(() => undefined)
  void prepareTour($).catch(() => undefined)
}

// Each stop starts its player fresh; a video starts playing by itself.
export function goToStop($: EngineInterface, to: number) {
  stop($, state.tourSite)
  players.delete(state.tourSite)
  state.tourStop = Math.max(0, Math.min(STOPS.length - 1, to))
  state.isStopDone = false
  const media = mediaOf(STOPS[state.tourStop]!)
  if (media?.frames && STOPS[state.tourStop]!.goal !== 'play') void $.clock.sleep(400).then(() => { if (mediaOf(STOPS[state.tourStop]!) === media) play($, state.tourSite, media, media) }, () => undefined)
  void update($, welcome, n => n + 1)
}

const mediaOf = (s: Stop) => (s.media === 'splash' ? splash : s.media ? tourMedia[s.media] : null) ?? null

async function finishTour($: EngineInterface, isSkip: boolean) {
  act(isSkip ? `tour_skip_${state.tourStop}` : 'tour_done')
  stop($, state.tourSite)
  state.isTourDone = true
  await update($, welcome, n => n + 1)
}

// Draws the tour in the chat: the current step's player (or "Loading the
// demo…", or the settings on the last step), with the step bar under it. The
// bar takes the player's width so their edges line up.
export async function Tour($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], viewport?: { columns: number; rows: number }) {
  const ui = $.ui.resolve(e) as Ui
  const { Box, Text } = ui
  const s = STOPS[state.tourStop]!
  const media = mediaOf(s)
  if (state.isTourDone) return <Text dimColor>✓ Tour finished. /show-your-work tour shows it again.</Text>
  const room = { columns: viewport?.columns ?? 100, rows: Math.max(24, viewport?.rows ?? 40) }
  if (!media && s.media) loadDemo($)
  // Nothing to look at yet: no bar, so Next can't be pressed before the demo shows.
  if (!media && s.media) return <Text dimColor>Loading the demo…</Text>
  const view = media ? await Viewer($, e, atStep(media, state.tourSite), state.tourSite, false, room) : null
  const width = (view as { props?: { width?: number } } | null)?.props?.width ?? Math.min(room.columns - 2, 100)
  return (
    <Box flexDirection="column" rowGap={1}>
      {view ?? (s.media && <Text dimColor>Loading the demo…</Text>)}
      {state.tourStop === STOPS.length - 1 && (
        <Box key="settings-box" flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} width={width}>
          <Text bold>Settings</Text>
          <Box marginTop={1}>{SettingRows(ui, $)}</Box>
        </Box>
      )}
      {TourBar(ui, $, width)}
    </Box>
  )
}

// The step bar: progress dots and "N of 5" on the first line, then the
// instruction in capitals with Back, Next and Skip tour on the right. The bar
// is lavender, and turns green with a ✓ once the person has done the step.
function TourBar(ui: Ui, $: EngineInterface, columns: number) {
  const { Box, Text, Button } = ui
  const at = state.tourStop
  const s = STOPS[at]!
  const isLast = at === STOPS.length - 1
  const isDone = state.isStopDone
  // Button text is dark to read on the lavender. Claude Code before 2.1.295
  // can't colour a button's text, so there the buttons use the default colour.
  // Back and Next are bracketed; Skip tour is plain text, as the least wanted.
  // Next turns black with light text once the step is done. Light text, because
  // the terminal inverts a button under the pointer, and dark-on-black inverted
  // would match the bar and disappear.
  // The last step has nothing to do, so it starts green.
  const fill = isDone || !s.goal ? 'success' : 'suggestion'
  const onBar = (key: string, label: string, onPress: () => void, look: { isMain?: boolean; isButton?: boolean } = {}) => {
    const text = look.isButton ? `[ ${label} ]` : label
    if (!state.canColourButtons) return <Button key={key} plain label={text} onPress={onPress} bold={look.isMain} />
    return (
      <Button key={key} plain label={text} onPress={onPress}>
        {look.isMain ? <Text bold color="text" backgroundColor="inverseText">{`  ${label}  `}</Text> : <Text color="inverseText">{text}</Text>}
      </Button>
    )
  }
  return (
    <Box key="tour-bar" flexDirection="column" width={columns} paddingX={2} paddingY={1} backgroundColor={fill}>
      {/* Where you are; then what to do, with the way on beside it. */}
      <Text color="inverseText">{`${STOPS.map((_, i) => (i === at ? '●' : '○')).join(' ')}   ${at + 1} of ${STOPS.length}`}</Text>
      <Box flexDirection="row" alignItems="flex-end" columnGap={4}>
        <Box flexGrow={1} flexShrink={1}><Text bold color="inverseText">{(isDone ? `✓  ${s.tag}` : s.tag).toUpperCase()}</Text></Box>
        <Box flexDirection="row" columnGap={3} flexShrink={0}>
          {/* No Back on the last step: it's a wrap-up, and Done is the only choice. */}
          {at > 0 && !isLast && onBar('prev', '‹ Back', () => { act(`tour_back_${at}`); goToStop($, at - 1) }, { isButton: true })}
          {/* Next fills in once the step is done; until then it's a plain button. */}
          {isLast
            ? onBar('done', 'Done ›', () => void finishTour($, false), { isMain: true, isButton: true })
            : onBar('next', 'Next ›', () => { act(`tour_next_${at}`); goToStop($, at + 1) }, { isMain: !s.goal || isDone, isButton: true })}
          {!isLast && onBar('skip', 'Skip tour', () => void finishTour($, true))}
        </Box>
      </Box>
    </Box>
  )
}
