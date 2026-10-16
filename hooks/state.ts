// What more than one module reads or changes: the session's facts, the
// player's and tour's progress, and the settings.
import type { Cell } from './layout'
import type { DrawCause } from './player'
import type { Event, Props } from './telemetry'

// An imported `let` is read-only to the module that imports it, so anything
// set in one module and read in another is a field of this object.
export const state = {
  // Frames and converted pictures. A private folder per user, chosen at session
  // start: a fixed name in the shared /tmp could be made first, or pointed
  // elsewhere, by another user on the same machine.
  TMP: '/tmp/claude-show-your-work',
  cwd: '',
  home: '',
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
  // Claude Code's CLI, as the login shell finds it ('' when it doesn't).
  claudePath: '',
  // setUp's one run, shared by everything that waits on it.
  setup: null as Promise<void> | null,
  // Whether a Button can hold coloured Text (Claude Code 2.1.295 and later).
  canColourButtons: false,
  generation: 0,
  // Every change that should repaint bumps this; a window's drawing is kept and
  // handed back while nothing changed (scrolling only moves which rows show).
  version: 0,
  // macOS unless the session says Linux: every Linux path below is a branch
  // beside the macOS one, which stays as it was.
  isMac: true,
  // Found once, then trusted for the session; while missing it is looked for
  // again on each video, so installing it mid-session works.
  hasVideoTools: false,
  // The terminal's cell in pixels (see Cell in layout.ts).
  cell: null as Cell | null,
  // The terminal's size in cells, from the same measure.
  termSize: null as { columns: number; rows: number } | null,
  // The terminal reads the file itself: a path crosses, not the picture. Sending
  // bytes (b6b8b14) moved ~400 KB a frame and froze playback.
  // Over ssh the terminal is on another machine and can't read the file, so the
  // bytes have to cross after all.
  sendBytes: false,
  // decoded bytes of every picture sent to the terminal so far (width x height x 4)
  drawnBytes: 0,
  // Whether the terminal draws pictures. Some sessions cannot (a background
  // session's relay): the first blit says so, and from then on every player
  // shows a warning with the way back instead. (Coloured half-block cells were
  // tried as a fallback: unreadable.)
  canImage: true,
  probed: false,
  sessionId: '',
  drawCause: 'background' as DrawCause,
  inTmux: false,
  // SHOW_YOUR_WORK_DEBUG=1 (see debug in telemetry.ts).
  isDebug: false,
  terminalName: '',
  // CLAUDE_CODE_FORCE_TERMINAL_IMAGES was set when Claude Code started.
  isForced: false,
  // The person pressed Turn on pictures: the line is in their shell profile,
  // and pictures show once Claude Code restarts.
  isTurnedOn: false,
  // Turned off again from the settings: the line is gone, from the next start.
  isTurnedOff: false,
  // Usage stats: whether they're on, and the events waiting to go out.
  isOn: false,
  queue: [] as Event[],
  pluginVersion: '0.0.0',
  statsContext: {} as Props,
  isWelcomed: false,
  // The tour: its live row, and where it is.
  tourSite: '',
  isTourPending: false,
  isTourDone: false,
  tourStop: 0,
  isStopDone: false,
}

// The switches, kept in the plugin's store (a /config row would reload the
// plugin on every change). The environment variables still turn updates and
// usage counts off whatever these say.
export const SETTINGS = [
  { field: 'stable_updates', title: 'Updates', options: ['Stable releases', 'Latest'], text: 'Automatically install plugin updates from GitHub' },
  { field: 'usage_stats', title: 'Usage data', options: ['Share anonymously', "Don't share"], text: 'Helps fix bugs and improve the product experience. No sensitive data is ever shared' },
  { field: 'standard_size', title: 'Picture size', options: ['Standard', 'Large'], text: 'Large shows pictures and videos one and a half times bigger' },
] as const
export type Field = (typeof SETTINGS)[number]['field']
// Each switch is true on its first option, the default.
export const settings: Record<Field, boolean> = { stable_updates: true, usage_stats: true, standard_size: true }
