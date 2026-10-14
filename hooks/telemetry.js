import { settings, state } from './state';
// A button press, by name only. False, so it chains: act('save') || keep().
export const act = (action) => {
    track('action', { action });
    return false;
};
// SHOW_YOUR_WORK_DEBUG=1: playback timings, a line per event, in TMP/debug.log.
const debugLines = [];
export const debug = (line) => { if (state.isDebug)
    debugLines.push(`${Date.now()} ${line}`); };
export async function flushDebug($) {
    if (!debugLines.length)
        return;
    await $.fs.write(`${state.TMP}/debug.log`, `${debugLines.slice(-20000).join('\n')}\n`).catch(() => undefined);
}
// Anonymous usage stats, sent to PostHog: what kind of thing happened and how
// often, under a random id made once per install. Never a file name, path,
// URL, title, prompt or anything typed. Off with SHOW_YOUR_WORK_TELEMETRY=0 or
// DO_NOT_TRACK=1, and nothing is sent while POSTHOG_KEY is empty.
const POSTHOG_HOST = 'https://us.i.posthog.com';
// The project API key: it can only add events, never read them, so it ships.
const POSTHOG_KEY = 'phc_mLGFguVcH3Tei4txwqXFPU4xBgFDKThEZncahTv3LS3W';
// Events wait here and go out together, at most once a minute and at exit.
const FLUSH_MS = 60000;
const MAX_QUEUED = 500;
let installId = '';
let base = {};
let isFlushing = false;
// A made-up name for an install, the same every time for one id, so profiles
// read as "Swift Otter" rather than a UUID. Nothing in it comes from the person.
const ADJECTIVES = ['Swift', 'Quiet', 'Brave', 'Clever', 'Sunny', 'Lucky', 'Bold', 'Calm', 'Eager', 'Gentle', 'Happy', 'Jolly', 'Keen', 'Lively', 'Mellow', 'Nimble', 'Plucky', 'Rapid', 'Snappy', 'Tidy', 'Witty', 'Zesty', 'Cosmic', 'Fuzzy'];
const ANIMALS = ['Otter', 'Falcon', 'Panda', 'Fox', 'Koala', 'Lynx', 'Heron', 'Badger', 'Gecko', 'Owl', 'Puffin', 'Raccoon', 'Seal', 'Tiger', 'Wombat', 'Yak', 'Bison', 'Crane', 'Dolphin', 'Ferret', 'Hedgehog', 'Lemur', 'Moose', 'Quokka'];
export function nicknameOf(id) {
    let h = 0;
    for (const ch of id)
        h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const n = Math.floor(h / ADJECTIVES.length) % 1000;
    return `${ADJECTIVES[h % ADJECTIVES.length]} ${ANIMALS[Math.floor(h / 1000) % ANIMALS.length]} ${n}`;
}
// An installed copy runs from Claude Code's plugin cache. One loaded from a
// folder (--plugin-dir) is someone working on the plugin: it sends nothing.
export const isInstalledCopy = (root) => /\/plugins\/cache\//.test(root);
// SHOW_YOUR_WORK_TELEMETRY=0, DO_NOT_TRACK=1 or CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: nothing is sent.
export const isStatsBlocked = (optOut, dnt, quiet) => /^(0|false|off|no)$/i.test(optOut ?? '') || /^(1|true)$/i.test(dnt ?? '') || !!quiet;
export async function startTelemetry($, context) {
    if (!POSTHOG_KEY || !isInstalledCopy($.plugin.root))
        return;
    const optOut = await $.env.get('SHOW_YOUR_WORK_TELEMETRY');
    const dnt = await $.env.get('DO_NOT_TRACK');
    const quiet = await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC');
    if (isStatsBlocked(optOut, dnt, quiet))
        return;
    // Turned back on in the same session: the timer is already running.
    if (installId)
        return void (state.isOn = true);
    installId = String((await $.store.get('installId')) ?? '');
    const isNew = !installId;
    if (isNew) {
        installId = crypto.randomUUID();
        await $.store.set('installId', installId);
    }
    state.isOn = true;
    // Each install is one anonymous person, keyed by its random id: the profile
    // holds the setup it runs on, never anything about who uses it.
    // No location, ever: no IP is sent, and PostHog is told not to look one up.
    base = { ...context, $ip: null, $geoip_disable: true };
    const profile = { $set: { ...context, name: nicknameOf(installId), update_channel: settings.stable_updates ? 'stable' : 'latest', usage_data: 'on' }, $set_once: { first_plugin_version: String(context.plugin_version ?? "") } };
    if (isNew)
        track('installed', profile);
    track('session_started', profile);
    $.clock.every(FLUSH_MS, () => void flush($));
}
// Counts and kinds only: callers pass no names, paths or text.
export function track(event, properties = {}) {
    if (!state.isOn)
        return;
    if (state.queue.length >= MAX_QUEUED)
        state.queue.shift();
    state.queue.push({ event, properties: { ...base, ...properties }, timestamp: new Date().toISOString() });
}
export async function flush($) {
    if (!state.isOn || isFlushing || !state.queue.length)
        return;
    isFlushing = true;
    const batch = state.queue;
    state.queue = [];
    try {
        const r = await $.http.fetch(`${POSTHOG_HOST}/batch/`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ api_key: POSTHOG_KEY, batch: batch.map(e => ({ ...e, distinct_id: installId })) }),
        });
        // A refused batch is dropped, not retried: stats are never worth a backlog.
        if (!r.ok && r.status >= 500)
            state.queue = [...batch, ...state.queue].slice(-MAX_QUEUED);
    }
    catch {
        state.queue = [...batch, ...state.queue].slice(-MAX_QUEUED);
    }
    finally {
        isFlushing = false;
    }
}
