// Anonymous usage stats and the button presses they count. The local debug
// log is diagnostics.ts, kept apart so nothing in it is ever sent.
import type { EngineInterface } from 'claude-code'

import { settings, state } from './state'

// A button press, by name only. False, so it chains: act('save') || keep().
export const act = (action: string): false => {
  track('action', { action })
  return false
}

// Anonymous usage stats, sent to PostHog: what kind of thing happened and how
// often, under a random id made once per install. Never a file name, path,
// URL, title, prompt or anything typed. Off with SHOW_YOUR_WORK_TELEMETRY=0 or
// DO_NOT_TRACK=1, and nothing is sent while POSTHOG_PROJECT is empty.
// PostHog's public project id for this plugin: it can only add events, never
// read them, so it ships. The address is written out at the call, so the
// directory review can read where the events go.
const POSTHOG_PROJECT = 'phc_mLGFguVcH3Tei4txwqXFPU4xBgFDKThEZncahTv3LS3W'
// Events wait here and go out together, at most once a minute and at exit.
const FLUSH_MS = 60_000
const MAX_QUEUED = 500

export type Props = Record<string, string | number | boolean | null | undefined | Record<string, string | number | boolean | undefined>>
export type Event = { event: string; properties: Props; timestamp: string }
let installId = ''
let base: Props = {}
let isFlushing = false

// A made-up name for an install, the same every time for one id, so profiles
// read as "Swift Otter" rather than a UUID. Nothing in it comes from the person.
const ADJECTIVES = ['Swift', 'Quiet', 'Brave', 'Clever', 'Sunny', 'Lucky', 'Bold', 'Calm', 'Eager', 'Gentle', 'Happy', 'Jolly', 'Keen', 'Lively', 'Mellow', 'Nimble', 'Plucky', 'Rapid', 'Snappy', 'Tidy', 'Witty', 'Zesty', 'Cosmic', 'Fuzzy']
const ANIMALS = ['Otter', 'Falcon', 'Panda', 'Fox', 'Koala', 'Lynx', 'Heron', 'Badger', 'Gecko', 'Owl', 'Puffin', 'Raccoon', 'Seal', 'Tiger', 'Wombat', 'Yak', 'Bison', 'Crane', 'Dolphin', 'Ferret', 'Hedgehog', 'Lemur', 'Moose', 'Quokka']
export function nicknameOf(id: string): string {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  const n = Math.floor(hash / ADJECTIVES.length) % 1000

  return `${ADJECTIVES[hash % ADJECTIVES.length]} ${ANIMALS[Math.floor(hash / 1000) % ANIMALS.length]} ${n}`
}

// An installed copy runs from Claude Code's plugin cache. One loaded from a
// folder (--plugin-dir) is someone working on the plugin: it sends nothing.
export const isInstalledCopy = (root: string) => /\/plugins\/cache\//.test(root)

// SHOW_YOUR_WORK_TELEMETRY=0, DO_NOT_TRACK=1 or CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: nothing is sent.
export const isStatsBlocked = (optOut?: string, dnt?: string, quiet?: string) =>
  /^(0|false|off|no)$/i.test(optOut ?? '') || /^(1|true)$/i.test(dnt ?? '') || !!quiet

export async function startTelemetry($: EngineInterface, context: Props) {
  if (!POSTHOG_PROJECT || !isInstalledCopy($.plugin.root)) return
  const optOut = await $.env.get('SHOW_YOUR_WORK_TELEMETRY')
  const dnt = await $.env.get('DO_NOT_TRACK')
  const quiet = await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
  if (isStatsBlocked(optOut, dnt, quiet)) return
  // Turned back on in the same session: the timer is already running.
  if (installId) return void (state.isOn = true)
  installId = String((await $.store.get('installId')) ?? '')
  const isNew = !installId
  if (isNew) {
    installId = crypto.randomUUID()
    await $.store.set('installId', installId)
  }
  state.isOn = true
  // Each install is one anonymous person, keyed by its random id: the profile
  // holds the setup it runs on, never anything about who uses it.
  // No location, ever: no IP is sent, and PostHog is told not to look one up.
  base = { ...context, $ip: null, $geoip_disable: true }
  const profile = { $set: { ...context, name: nicknameOf(installId), update_channel: settings.stable_updates ? 'stable' : 'latest', usage_data: 'on' }, $set_once: { first_plugin_version: String(context.plugin_version ?? "") } }
  if (isNew) track('installed', profile)
  track('session_started', profile)
  $.clock.every(FLUSH_MS, () => void flush($))
}

// Counts and kinds only: callers pass no names, paths or text.
export function track(event: string, properties: Props = {}) {
  if (!state.isOn) return
  if (state.queue.length >= MAX_QUEUED) state.queue.shift()
  state.queue.push({ event, properties: { ...base, ...properties }, timestamp: new Date().toISOString() })
}

export async function flush($: EngineInterface) {
  if (!state.isOn || isFlushing || !state.queue.length) return
  isFlushing = true
  const batch = state.queue
  state.queue = []
  try {
    const r = await $.http.fetch('https://us.i.posthog.com/batch/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: POSTHOG_PROJECT, batch: batch.map(e => ({ ...e, distinct_id: installId })) }),
    })
    // A refused batch is dropped, not retried: stats are never worth a backlog.
    if (!r.ok && r.status >= 500) state.queue = [...batch, ...state.queue].slice(-MAX_QUEUED)
  } catch {
    state.queue = [...batch, ...state.queue].slice(-MAX_QUEUED)
  } finally {
    isFlushing = false
  }
}
