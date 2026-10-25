// The local diagnostics log: what the plugin did and every problem it noticed,
// as one JSON object per line in TMP/debug.log, for debugging on a real
// machine without screenshots. Local only: it holds paths and sizes, so it
// is never sent anywhere, and nothing here may call track() (PostHog).
//
//   SHOW_YOUR_WORK_DEBUG=1   every event is kept and flushed once a second
//   always                   problems are kept in memory (a few hundred at
//                            most) for /show-your-work diagnose
//
// Events: layout, copy, frame, resize, resend, measure, log (the playback
// timings), and problem, each with `t` (ms) and `e` (its kind).
import type { EngineInterface } from 'claude-code'

import { state } from './state'

const LOG_LINES = 20000
const PROBLEMS_KEPT = 300
const eventLines: string[] = []
export type Problem = { t: number; what: string; [field: string]: unknown }
export const problems: Problem[] = []

// One event, kept only while the debug log is on.
export function event(kind: string, fields: Record<string, unknown> = {}) {
  if (!state.isDebug) return
  eventLines.push(JSON.stringify({ t: Date.now(), e: kind, ...fields }))
  if (eventLines.length > LOG_LINES * 1.5) eventLines.splice(0, eventLines.length - LOG_LINES)
}
// A line of text (the playback timings): an event of kind `log`.
export const debug = (line: string) => event('log', { msg: line })
// Something that shouldn't happen, named in snake_case: always kept for
// /show-your-work diagnose, and in the log when it's on.
export function problem(what: string, fields: Record<string, unknown> = {}) {
  problems.push({ t: Date.now(), what, ...fields })
  if (problems.length > PROBLEMS_KEPT) problems.splice(0, problems.length - PROBLEMS_KEPT)
  event('problem', { what, ...fields })
}

export async function flushDebug($: EngineInterface) {
  if (!eventLines.length) return
  await $.fs.write(`${state.TMP}/debug.log`, `${eventLines.slice(-LOG_LINES).join('\n')}\n`).catch(() => undefined)
}

// The answer to /show-your-work diagnose: problems in the last ten minutes,
// grouped, newest first, and where the full log is or how to turn it on.
export function diagnosis(now: number, kept: Problem[] = problems, isLogging = state.isDebug, logPath = `${state.TMP}/debug.log`): string {
  const recent = kept.filter(p => now - p.t <= 10 * 60_000)
  const counts = new Map<string, number>()
  for (const p of recent) counts.set(p.what, (counts.get(p.what) ?? 0) + 1)
  const lines = recent.length
    ? [`${recent.length} problem${recent.length === 1 ? '' : 's'} in the last 10 minutes:`, ...[...counts].sort((a, b) => b[1] - a[1]).map(([what, n]) => `  ${what} × ${n}`)]
    : ['No problems noticed in the last 10 minutes.']
  lines.push(isLogging ? `Full log: ${logPath}` : 'For a full log, start Claude Code with SHOW_YOUR_WORK_DEBUG=1 and try again.')
  return lines.join('\n')
}

// A picture wider than the box it's placed in is cut off by the terminal
// (Ghostty crops rather than shrinks). Tolerates what fitCopy allows on
// purpose: 3%, measured before the box is rounded down to whole columns.
export const isWiderThanBox = (pixels: number, columns: number, cellWidth: number) => pixels > (columns + 1) * cellWidth * 1.03
