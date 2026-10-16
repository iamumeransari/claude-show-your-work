// Updates: a daily check of the install's channel, and the move between
// channels. The updater will be turned off after the plugin moves to the
// Claude Code plugin directory, which keeps it up to date instead.
import type { EngineInterface } from 'claude-code'

import { state } from './state'
import { track } from './telemetry'

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
const REPO = 'iamumeransari/claude-show-your-work'
const MARKETPLACE = 'iamumeransari'
export const PLUGIN = 'show-your-work'
const SOURCE = `https://github.com/${REPO}.git`
export const BRANCHES = { stable: 'releases', latest: 'latest' } as const
type Branch = (typeof BRANCHES)[keyof typeof BRANCHES]
const DAY_MS = 24 * 60 * 60 * 1000

// A version folder from before 0.6.0 in the plugin cache: this install was
// used before 0.6.0's welcome, so it was updated past it without seeing it.
export const hadVersionBefore06 = (names: string[]) => names.some(name => /^\d+\.\d+\.\d+$/.test(name) && isNewer('0.6.0', name))

// 1.10.0 is newer than 1.9.3; anything after a dash is ignored.
export function isNewer(latest: string, current: string): boolean {
  const parts = (v: string) => (v.split('-')[0] ?? '').split('.').map(n => Number(n) || 0)
  const a = parts(latest), b = parts(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }

  return false
}

// Where Claude Code's CLI usually is, when the login shell didn't find it
// (state.claudePath, found at session start) and it isn't on the session's PATH.
const CLAUDE_BINARIES = ['claude', '.local/bin/claude', '.claude/local/claude', '.npm-global/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude']
let claudeBinary = ''

// Runs Claude Code's CLI with the session's own environment (its PATH and
// CLAUDE_CONFIG_DIR), so it changes this install and no other.
async function claude($: EngineInterface, args: string[]) {
  const known = CLAUDE_BINARIES.map(b => (b.startsWith('.') ? `${state.home}/${b}` : b))
  const candidates = [...new Set([claudeBinary, state.claudePath, ...known].filter(Boolean))]
  for (const bin of candidates) {
    const r = await $.process.run([bin, ...args], { timeoutMs: 120_000 }).catch(() => undefined)
    if (r) {
      claudeBinary = bin
      return r
    }
  }
  return undefined
}

function jsonOf<T>(text: string | undefined, fallback: T): T {
  try { return text ? (JSON.parse(text) as T) : fallback } catch { return fallback }
}

// The automatic check at session start: at most once a day, never when
// SHOW_YOUR_WORK_AUTO_UPDATE=0 or CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set. It installs any newer version without asking. Claude Code only loads
// the new version in a new session, so once one is installed a status line
// under the prompt says so until Claude Code restarts.
export async function checkForUpdate($: EngineInterface, current: string, branch: Branch = BRANCHES.stable) {
  const off = await $.env.get('SHOW_YOUR_WORK_AUTO_UPDATE')
  if (/^(0|false|off|no)$/i.test(off ?? '')) return
  if (await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) return
  const now = await $.clock.now()
  if (now - Number((await $.store.get('updateCheckedAt')) ?? 0) < DAY_MS) return
  const found = await findUpdate($, current, branch)
  // Every check says how it ended, so a stuck install shows why. Only a check
  // that got through counts for the day; one that couldn't run tries again
  // at the next session.
  track('update_check', { result: found.kind, channel: branch, ...('latest' in found ? { latest: found.latest } : {}) })
  if (found.kind !== 'offline' && found.kind !== 'no_cli') await $.store.set('updateCheckedAt', now)
  const isReady = found.kind === 'pending' || ((found.kind === 'update' || found.kind === 'move') && (await installUpdate($, found, current)))
  if (isReady && 'latest' in found) $.ui.status(`show-your-work ${found.latest} is ready. Restart Claude Code to use it.`)
}

// The result of checking for an update:
//   update   a newer version is on the channel's branch
//   move     the install follows a different branch than the chosen channel
//   current  already on the newest version
//   pending  the newest version is installed but runs from the next session
//   folder   loaded from a local folder (development), so it never updates
//   pinned   installed from a fixed tag such as #v0.5.14, so it never updates
//   offline  GitHub couldn't be reached
//   no_cli   Claude Code's CLI couldn't be found or didn't answer
export type Found =
  | { kind: 'update'; latest: string; scope: string }
  | { kind: 'move'; latest: string; branch: Branch; market: { url?: string; ref?: string } }
  | { kind: 'current'; latest: string }
  | { kind: 'pending'; latest: string }
  | { kind: 'folder' }
  | { kind: 'pinned'; ref: string }
  | { kind: 'offline' }
  | { kind: 'no_cli' }
export async function findUpdate($: EngineInterface, current: string, branch: Branch): Promise<Found> {
  // No such branch yet, or no network: nothing to say about it.
  // Each channel's address written out in full, so the directory review can read it.
  const r = await (branch === BRANCHES.latest
    ? $.http.fetch('https://raw.githubusercontent.com/iamumeransari/claude-show-your-work/latest/.claude-plugin/plugin.json')
    : $.http.fetch('https://raw.githubusercontent.com/iamumeransari/claude-show-your-work/releases/.claude-plugin/plugin.json')
  ).catch(() => null)
  if (!r?.ok) return { kind: 'offline' }
  const latest = String(jsonOf<{ version?: string }>(r.text, {}).version ?? '')
  if (!latest) return { kind: 'offline' }

  // A marketplace read from a folder is someone working on the plugin: leave it.
  const listed = await claude($, ['plugin', 'marketplace', 'list', '--json'])
  if (!listed || listed.exitCode !== 0) return { kind: 'no_cli' }
  const markets = jsonOf<{ name: string; source: string; url?: string; ref?: string }[]>(listed.stdout, [])
  const market = markets.find(m => m.name === MARKETPLACE)
  if (!market || market.source === 'directory') return { kind: 'folder' }
  // Added with #v0.5.14 or another ref: the user chose that version.
  const ref = market.ref ?? 'main'
  if (ref !== 'main' && !Object.values(BRANCHES).includes(ref as Branch)) return { kind: 'pinned', ref }
  if (ref !== branch) return { kind: 'move', latest, branch, market }
  if (!isNewer(latest, current)) return { kind: 'current', latest }
  const plugins = jsonOf<{ id: string; scope?: string; version?: string }[]>((await claude($, ['plugin', 'list', '--json']))?.stdout, [])
  const installed = plugins.find(p => p.id === `${PLUGIN}@${MARKETPLACE}`)
  if (!installed) return { kind: 'folder' }
  // Already fetched by an earlier check; it runs from the next session.
  if (installed.version && !isNewer(latest, installed.version)) return { kind: 'pending', latest }
  return { kind: 'update', latest, scope: installed.scope ?? 'user' }
}

// Installs an update findUpdate found, through Claude Code's plugin commands.
// A channel move runs detached and finishes in the background. Returns true
// when the install (or starting the move) succeeded.
export async function installUpdate($: EngineInterface, found: Extract<Found, { kind: 'update' | 'move' }>, current: string) {
  if (found.kind === 'move') return moveTo($, found.branch, found.market)
  await claude($, ['plugin', 'marketplace', 'update', MARKETPLACE])
  const done = await claude($, ['plugin', 'update', `${PLUGIN}@${MARKETPLACE}`, '--scope', found.scope])
  if (done?.exitCode !== 0) {
    track('update_failed', { from: current, to: found.latest })
    return false
  }
  track('update_installed', { from: current, to: found.latest })
  return true
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
].join('\n')
// Starts a script in a session of its own, so it outlives this one.
const DETACH = ['perl', '-MPOSIX', '-e', 'fork and exit; POSIX::setsid(); exec @ARGV']
async function moveTo($: EngineInterface, branch: Branch, market: { url?: string; ref?: string }) {
  const plugins = jsonOf<{ id: string; scope?: string }[]>((await claude($, ['plugin', 'list', '--json']))?.stdout, [])
  const installed = plugins.find(p => p.id === `${PLUGIN}@${MARKETPLACE}`)
  if (!installed || !claudeBinary) return false
  const url = market.url ?? SOURCE
  const old = market.ref ? `${url}#${market.ref}` : url
  track('channel_move', { from: market.ref ?? 'main', to: branch })
  const r = await $.process.run([...DETACH, 'sh', '-c', MOVE_SH, 'move', claudeBinary, url, branch, old, installed.scope ?? 'user', MARKETPLACE, `${PLUGIN}@${MARKETPLACE}`]).catch(() => undefined)
  return r?.exitCode === 0
}
