import { state } from './state';
import { track } from './telemetry';
// Keeps the plugin current without the user turning on marketplace
// auto-update: once a day it asks GitHub for the version on the install's
// channel and, when it is newer, updates through Claude Code's own plugin
// commands, quietly. The new version runs from the next session.
//
// Two channels, one branch each: Stable releases follow `releases`, Latest
// follows `latest`. `main` is where work happens and nothing updates from
// it; an install still on it moves to its channel's branch. Moving means
// re-adding the marketplace at that branch and installing the plugin again
// (its store is kept), in a process of its own (see moveTo). Off with
// SHOW_YOUR_WORK_AUTO_UPDATE=0 or CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, and
// never for an install pinned to a release tag.
const REPO = 'iamumeransari/claude-show-your-work';
const MARKETPLACE = 'iamumeransari';
export const PLUGIN = 'show-your-work';
const SOURCE = `https://github.com/${REPO}.git`;
export const BRANCHES = { stable: 'releases', latest: 'latest' };
const manifestOn = (branch) => `https://raw.githubusercontent.com/${REPO}/${branch}/.claude-plugin/plugin.json`;
const DAY_MS = 24 * 60 * 60 * 1000;
// A version folder from before 0.6.0 in the plugin cache: this install was
// used before 0.6.0's welcome, so it was updated past it without seeing it.
export const hadVersionBefore06 = (names) => names.some(name => /^\d+\.\d+\.\d+$/.test(name) && isNewer('0.6.0', name));
// 1.10.0 is newer than 1.9.3; anything after a dash is ignored.
export function isNewer(latest, current) {
    const parts = (v) => (v.split('-')[0] ?? '').split('.').map(n => Number(n) || 0);
    const a = parts(latest), b = parts(current);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0))
            return (a[i] ?? 0) > (b[i] ?? 0);
    }
    return false;
}
// Where Claude Code's CLI usually is, when it isn't on the session's PATH.
const CLAUDE_BINARIES = ['claude', '.local/bin/claude', '.claude/local/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
let claudeBinary = '';
// Runs Claude Code's CLI with the session's own environment (its PATH and
// CLAUDE_CONFIG_DIR), so it changes this install and no other.
async function claude($, args) {
    const known = CLAUDE_BINARIES.map(b => (b.startsWith('.') ? `${state.home}/${b}` : b));
    const candidates = [...new Set([claudeBinary, ...known].filter(Boolean))];
    for (const bin of candidates) {
        const r = await $.process.run([bin, ...args], { timeoutMs: 120000 }).catch(() => undefined);
        if (r) {
            claudeBinary = bin;
            return r;
        }
    }
    return undefined;
}
function jsonOf(text, fallback) {
    try {
        return text ? JSON.parse(text) : fallback;
    }
    catch {
        return fallback;
    }
}
export async function checkForUpdate($, current, branch = BRANCHES.stable) {
    const off = await $.env.get('SHOW_YOUR_WORK_AUTO_UPDATE');
    if (/^(0|false|off|no)$/i.test(off ?? ''))
        return;
    if (await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))
        return;
    const now = await $.clock.now();
    if (now - Number((await $.store.get('updateCheckedAt')) ?? 0) < DAY_MS)
        return;
    await $.store.set('updateCheckedAt', now);
    // No such branch yet: stay where it is.
    const r = await $.http.fetch(manifestOn(branch));
    if (!r.ok)
        return;
    const latest = String(jsonOf(r.text, {}).version ?? '');
    if (!latest)
        return;
    // A marketplace read from a folder is someone working on the plugin: leave it.
    const markets = jsonOf((await claude($, ['plugin', 'marketplace', 'list', '--json']))?.stdout, []);
    const market = markets.find(m => m.name === MARKETPLACE);
    if (!market || market.source === 'directory')
        return;
    // Added with #v0.5.14 or another ref: the user chose that version.
    const ref = market.ref ?? 'main';
    if (ref !== 'main' && !Object.values(BRANCHES).includes(ref))
        return;
    if (ref !== branch)
        return moveTo($, branch, market);
    if (!isNewer(latest, current))
        return;
    const plugins = jsonOf((await claude($, ['plugin', 'list', '--json']))?.stdout, []);
    const installed = plugins.find(p => p.id === `${PLUGIN}@${MARKETPLACE}`);
    if (!installed)
        return;
    // Already fetched by an earlier check; it runs from the next session.
    if (installed.version && !isNewer(latest, installed.version))
        return;
    await claude($, ['plugin', 'marketplace', 'update', MARKETPLACE]);
    const done = await claude($, ['plugin', 'update', `${PLUGIN}@${MARKETPLACE}`, '--scope', installed.scope ?? 'user']);
    if (done?.exitCode !== 0) {
        track('update_failed', { from: current, to: latest });
        return;
    }
    track('update_installed', { from: current, to: latest });
}
// Puts the install on another channel's branch: the marketplace again at that
// branch, then the plugin from it. The steps run in a process of their own,
// outside the session, so quitting Claude Code halfway can't leave the plugin
// uninstalled; when the branch can't be added or its plugin won't install,
// the old source and the plugin go back, a second time if the first fails.
export const MOVE_SH = [
    'exec </dev/null >/dev/null 2>&1',
    'c=$1 url=$2 branch=$3 old=$4 scope=$5 market=$6 id=$7',
    '"$c" plugin marketplace remove "$market" || exit 0',
    '"$c" plugin marketplace add "$url#$branch" && "$c" plugin install "$id" --scope "$scope" && exit 0',
    '"$c" plugin marketplace remove "$market"',
    'for try in 1 2; do "$c" plugin marketplace add "$old"; "$c" plugin install "$id" --scope "$scope" && exit 0; done',
    'exit 1',
].join('\n');
// Starts a script in a session of its own, so it outlives this one.
const DETACH = ['perl', '-MPOSIX', '-e', 'fork and exit; POSIX::setsid(); exec @ARGV'];
async function moveTo($, branch, market) {
    const plugins = jsonOf((await claude($, ['plugin', 'list', '--json']))?.stdout, []);
    const installed = plugins.find(p => p.id === `${PLUGIN}@${MARKETPLACE}`);
    if (!installed || !claudeBinary)
        return;
    const url = market.url ?? SOURCE;
    const old = market.ref ? `${url}#${market.ref}` : url;
    track('channel_move', { from: market.ref ?? 'main', to: branch });
    await $.process.run([...DETACH, 'sh', '-c', MOVE_SH, 'move', claudeBinary, url, branch, old, installed.scope ?? 'user', MARKETPLACE, `${PLUGIN}@${MARKETPLACE}`]).catch(() => undefined);
}
