// First run and settings: the settings pane, the welcome and the tour.
import { atom, update } from 'claude-code';
import { SETTINGS, settings, state } from './state';
import { act, flush, startTelemetry, track } from './telemetry';
import { prepare } from './media';
import { preparedOf } from './history';
import { BRANCHES, checkForUpdate, PLUGIN } from './updater';
import { STOPS } from './tour';
import { atStep, freshCalls, play, players, redraw, stop, Viewer } from './player';
// ── Settings and welcome ─────────────────────────────────────────────────
export const WELCOME = 'show-your-work-welcome';
// The settings pane's and the tour's redraws. Declared in each file that
// reads or updates it: the engine only reads an atom declared in the same file.
const welcome = atom({ plugin: 'show-your-work', key: 'welcome' }, 0);
// A no to usage data given before these settings (0.5.12's question, 0.5.16's command) stays a no.
// Updates are on for everyone: fixes have to reach every install.
export const earlierNo = (consent, statsOff, updatesOff) => {
    const asked = consent && typeof consent === 'object' ? consent : {};
    return { isStatsOff: statsOff === true || asked.stats === false, isUpdatesOff: updatesOff === true || asked.updates === false };
};
export async function loadSettings($) {
    const saved = ((await $.store.get('settings')) ?? {});
    if (typeof saved.usage_stats !== 'boolean' && earlierNo(await $.store.get('consent'), await $.store.get('statsOff'), null).isStatsOff)
        settings.usage_stats = false;
    for (const { field } of SETTINGS)
        if (typeof saved[field] === 'boolean')
            settings[field] = saved[field];
}
async function switchSetting($, field, value) {
    // The saved choices, not this module's copy: a reload resets the copy.
    await loadSettings($);
    settings[field] = value;
    act(`setting_${field}_${value ? 'first' : 'second'}`);
    await $.store.set('settings', { ...settings });
    // The profile keeps the install's current choice of update channel.
    if (field === 'stable_updates')
        track('settings_changed', { $set: { update_channel: value ? 'stable' : 'latest' } });
    // Turning usage data off sends one last signal saying so, then nothing more.
    if (field === 'usage_stats' && !value && state.isOn) {
        track('usage_data_turned_off', { $set: { usage_data: 'off' } });
        await flush($).catch(() => undefined);
    }
    // Off means off: nothing queued is kept for later.
    if (field === 'usage_stats' && !value) {
        state.isOn = false;
        state.queue = [];
    }
    if (field === 'usage_stats' && value && state.isWelcomed)
        await startTelemetry($, state.statsContext);
    // A new channel is followed now.
    if (field === 'stable_updates' && state.isWelcomed) {
        await $.store.set('updateCheckedAt', 0);
        void checkForUpdate($, state.pluginVersion, value ? BRANCHES.stable : BRANCHES.latest).catch(() => undefined);
    }
    await update($, welcome, n => n + 1);
}
// Updates and usage counts wait for the welcome on a first run, so a switch
// turned off there is off before anything is sent.
export async function startBackground($) {
    if (hasStarted)
        return;
    hasStarted = true;
    if (settings.usage_stats)
        await startTelemetry($, state.statsContext);
    await checkForUpdate($, state.pluginVersion, settings.stable_updates ? BRANCHES.stable : BRANCHES.latest);
}
// The first run (see 'toured'): the plugin runs /show-your-work once, and its output row
// in the chat draws the welcome. That run answers with WELCOME_TEXT, which is
// how its row is told from the person's own /show-your-work.
export const WELCOME_TEXT = 'show-your-work is installed and ready.';
export async function openWelcome($) {
    await prepareSplash($).catch(() => undefined);
    await finishWelcome($);
    await openTour($);
}
// /show-your-work: the switches, in a pane.
export async function openSettings($) {
    await $.ui.open({ id: WELCOME, title: 'Settings', focus: true, closeOnEscape: true, holdToasts: true, rows: 10, columns: 70 });
    await update($, welcome, n => n + 1);
}
let hasStarted = false;
async function finishWelcome($) {
    if (state.isWelcomed)
        return;
    state.isWelcomed = true;
    await $.store.set('toured', true);
    await startBackground($);
}
// A five-second recording of a form being tested, played in the real
// player with its changes and checks; the picture of one without ffmpeg.
// The welcome's opening: show-your-work rising over a night sky, played once
// as a picture with no controls, then held on its last frame. A still
// without ffmpeg.
let splash = null;
let hasPlayedSplash = false;
async function prepareSplash($) {
    const opened = await prepare($, `${$.plugin.root}/assets/splash.mp4`, 'show-your-work')
        .catch(() => prepare($, `${$.plugin.root}/assets/splash.jpg`, 'show-your-work'))
        .catch(() => null);
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
    };
    await update($, welcome, n => n + 1);
    redraw($);
}
// /show-your-work's pane: the switches, and the way back into the tour.
export function Settings(ui, $) {
    const { Box, Text, Button } = ui;
    return (<Box flexDirection="column" paddingX={2} paddingBottom={1}>
      <Box flexDirection="row" columnGap={2} marginBottom={1}>
        <Button key="close" label="✕ Close" onPress={() => void $.ui.close({ id: WELCOME })}/>
        <Button key="tour" label="Take a tour" onPress={() => { act('tour_from_settings'); void $.ui.close({ id: WELCOME }).then(() => openTour($)); }}/>
      </Box>
      <Box marginBottom={1}><Text bold>Show Your Work Settings</Text></Box>
      {SettingRows(ui, $)}
    </Box>);
}
// Quiet: plain words, the choice marked ● and the other ○, in columns that
// line up, so choosing moves nothing.
function SettingRows(ui, $) {
    const { Box, Text, Button } = ui;
    const first = Math.max(...SETTINGS.map(s => s.options[0].length)) + 4;
    return (<Box flexDirection="column">
      {SETTINGS.map(s => (<Box key={`row-${s.field}`} flexDirection="row">
          <Box width={24} flexShrink={0}><Text dimColor>{s.title}</Text></Box>
          {s.options.map((label, k) => {
                const isChosen = settings[s.field] === (k === 0);
                return (<Box key={`slot-${s.field}-${k}`} width={k === 0 ? first : undefined} flexShrink={0}>
                {/* The default in green, the other in orange; the one not chosen
                        dim. Before Claude Code 2.1.295 a Button holds only its label. */}
                {state.canColourButtons ? (<Button key={`${s.field}-${k}`} plain label={`${isChosen ? '●' : '○'} ${label}`} onPress={() => void switchSetting($, s.field, k === 0)}>
                    <Text color={k === 0 ? 'success' : 'claude'} dimColor={!isChosen}>{`${isChosen ? '●' : '○'} ${label}`}</Text>
                  </Button>) : (<Button key={`${s.field}-${k}`} plain {...(isChosen ? {} : { dimColor: true })} label={`${isChosen ? '●' : '○'} ${label}`} onPress={() => void switchSetting($, s.field, k === 0)}/>)}
              </Box>);
            })}
        </Box>))}
      <Box marginTop={1}><Text dimColor>Usage data is anonymous and helps fix bugs and improve the product experience. No sensitive data is ever shared.</Text></Box>
    </Box>);
}
// The welcome row: the opening in the real player, with its side list, then
// what to ask and one quiet line about updates and usage counts.
export async function Opening($, e, site, viewport) {
    const { Box, Text } = $.ui.resolve(e);
    let view = null;
    // Where pictures can't draw, the heading alone: a warning has no place here.
    if (splash && state.canImage) {
        // Plays by itself once, as a video Claude shows does.
        if (!hasPlayedSplash) {
            hasPlayedSplash = true;
            freshCalls.add(site);
        }
        view = await Viewer($, e, atStep(splash, site), site, false, viewport);
    }
    return (<Box flexDirection="column" rowGap={1}>
      {view ?? <Text bold color="claude">✦ show-your-work is installed and ready</Text>}
      <Box flexDirection="column">
        <Text>Claude now shows you pictures and videos right here in the chat. Try asking Claude to create something and show it to you in the chat, as an image or a recording.</Text>
        <Text dimColor>It keeps itself updated and sends anonymous usage counts. Change this with /show-your-work, and see every feature with /show-your-work tour.</Text>
      </Box>
    </Box>);
}
// ── Tour ─────────────────────────────────────────────────────────────────
// A walk through the player on the launch film's demos: the opening, a recording with
// its report, the same recording against the broken version, a screenshot's
// history, then the commands and switches. Opens by itself on a fresh
// install; /show-your-work tour, or the button in the settings, opens it again.
const TOUR = 'show-your-work-tour';
// The tour is a message in the chat, drawn by the output row of
// /show-your-work tour (TOUR_TEXT marks it): it lays out at the chat's full
// width at any window size. tourSite is the live row; an older one shrinks to
// a line.
export const TOUR_TEXT = 'show-your-work tour.';
// The one line above the control a stop points at, in the tour's row only.
const tourMedia = {};
// The demo's media, read once, all from the launch film: the new-trip form
// tested with its changes and checks, the Tern hero before and after its
// trip card, and the hero's history from four directions to every width.
async function prepareTour($) {
    const dir = `${$.plugin.root}/assets/tour`;
    if (tourMedia.recording === undefined) {
        tourMedia.recording = await (async () => {
            const clip = await prepare($, `${dir}/trip-form.mp4`, 'New trip form');
            const lead = clip.frames?.lead ?? 0;
            const at = (s) => Math.max(0, s - lead);
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
            };
        })().catch(() => prepare($, `${dir}/hero.jpg`, 'Tern homepage').catch(() => null));
    }
    if (tourMedia.compare === undefined) {
        tourMedia.compare = await (async () => ({
            ...(await prepare($, `${dir}/hero.jpg`, 'Tern homepage')),
            changes: [{ title: 'Trip card beside the headline' }, { title: 'Friends and trip count under the button' }],
            compare: await prepare($, `${dir}/direction-b.jpg`, 'Original'),
        }))().catch(() => null);
    }
    if (tourMedia.history === undefined) {
        tourMedia.history = await (async () => {
            const hero = `${dir}/hero.jpg`;
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
            };
        })().catch(() => null);
    }
    await update($, welcome, n => n + 1);
}
// Runs /show-your-work tour, whose output row draws the tour.
async function openTour($) {
    // A plugin's own run never reaches its own command.run hook: the tour starts
    // here, and its row is drawn by the args it carries.
    startTour($);
    await $.command.run({ command: PLUGIN, args: 'tour' }).catch(() => undefined);
}
// What /show-your-work tour does before its row draws: the first stop, and
// the demo's media read in the background.
export function startTour($) {
    act('tour_open');
    state.isTourPending = true;
    state.isTourDone = false;
    state.tourStop = 0;
    void (async () => {
        if (!splash)
            await prepareSplash($).catch(() => undefined);
        await prepareTour($);
    })().catch(() => undefined);
}
// Each stop starts its player fresh; a video starts playing by itself.
export function goToStop($, to) {
    stop($, state.tourSite);
    players.delete(state.tourSite);
    state.tourStop = Math.max(0, Math.min(STOPS.length - 1, to));
    state.isStopDone = false;
    const media = mediaOf(STOPS[state.tourStop]);
    if (media?.frames && STOPS[state.tourStop].goal !== 'play')
        void $.clock.sleep(400).then(() => { if (mediaOf(STOPS[state.tourStop]) === media)
            play($, state.tourSite, media, media); }, () => undefined);
    void update($, welcome, n => n + 1);
}
const mediaOf = (s) => (s.media === 'splash' ? splash : s.media ? tourMedia[s.media] : null) ?? null;
async function finishTour($, isSkip) {
    act(isSkip ? `tour_skip_${state.tourStop}` : 'tour_done');
    stop($, state.tourSite);
    state.isTourDone = true;
    await update($, welcome, n => n + 1);
}
export async function Tour($, e, viewport) {
    const ui = $.ui.resolve(e);
    const { Box, Text, Button } = ui;
    const at = state.tourStop;
    const s = STOPS[at];
    const isLast = at === STOPS.length - 1;
    const media = mediaOf(s);
    if (state.isTourDone)
        return <Text dimColor>✓ Tour finished. /show-your-work tour shows it again.</Text>;
    const room = { columns: viewport?.columns ?? 100, rows: Math.max(24, viewport?.rows ?? 40) };
    let view = null;
    if (media)
        view = await Viewer($, e, atStep(media, state.tourSite), state.tourSite, false, room);
    else if (s.media)
        view = <Text dimColor>Loading the demo…</Text>;
    return (<Box flexDirection="column" rowGap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          {STOPS.map((_, i) => <Text key={`dot-${i}`} color={i === at ? 'claude' : undefined} dimColor={i !== at}>{i === at ? '● ' : '○ '}</Text>)}
          <Text dimColor>{`${at + 1} of ${STOPS.length}`}</Text>
        </Text>
      </Box>
      <Box flexDirection="column">
        <Text bold>{s.title}{state.isStopDone ? <Text color="success">  ✓</Text> : null}</Text>
        {/* Every stop's instruction, here under its title; kept, dim, once done. */}
        {s.spot ? <Text color="claude" bold dimColor={state.isStopDone}>{s.tag}</Text> : <Text>{s.tag}</Text>}
      </Box>
      {view}
      {/* Boxed like the player: a title bar, then the choices. */}
      {isLast && (<Box key="settings-box" flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} width={Math.min((viewport?.columns ?? 100) - 2, 100)}>
          <Text bold>Settings</Text>
          <Box marginTop={1}>{SettingRows(ui, $)}</Box>
        </Box>)}
      <Box flexDirection="row" columnGap={2}>
        {at > 0 && <Button key="prev" label="‹ Back" onPress={() => { act(`tour_back_${at}`); goToStop($, at - 1); }}/>}
        {isLast
            ? <Button key="done" variant="primary" label="Done" onPress={() => void finishTour($, false)}/>
            : <Button key="next" variant="primary" label="Next ›" onPress={() => { act(`tour_next_${at}`); goToStop($, at + 1); }}/>}
        {!isLast && <Button key="skip" plain dimColor label="Skip tour" onPress={() => void finishTour($, true)}/>}
      </Box>
    </Box>);
}
