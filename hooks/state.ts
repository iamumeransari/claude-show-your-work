// What more than one module reads or changes: the session's facts, the
// player's and tour's progress, and the settings.
import type { EngineInterface } from 'claude-code'

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
  // A Chromium that can render an HTML page headless ('' when there is none).
  chrome: '',
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
  // Windows through Git for Windows' sh (MSYS2): paths are kept in the mixed
  // form C:/Users/... that Node, the sh tools and Windows programs all read.
  isWindows: false,
  // Git for Windows' usr/bin (C:/Program Files/Git/usr/bin): Claude Code spawns
  // programs with the Windows PATH, which has no sh, mkdir or rm.
  gitBin: '',
  // Found once, then trusted for the session; while missing it is looked for
  // again on each video, so installing it mid-session works.
  hasVideoTools: false,
  // The terminal's cell in pixels (see Cell in layout.ts).
  cell: null as Cell | null,
  // The terminal's size in cells, from the same measure.
  termSize: null as { columns: number; rows: number } | null,
  // SHOW_YOUR_WORK_CELL=8x17: the cell in pixels where the terminal reports
  // none (Windows has no tty to ask), so the box matches the picture.
  cellGiven: null as Cell | null,
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
  // Sound (sound.ts): ffplay's path ('' when missing), whether the session
  // runs where its speakers aren't the person's (ssh, a background session),
  // and whether sound is on: on at every session start; Mute holds for the
  // rest of the session. Tour videos are quiet until Play.
  ffplay: '',
  isFarFromSpeakers: false,
  isSoundOn: true,
  // Poppler's tools, found like ffmpeg: a PDF's pages and every document's
  // page count come from them.
  pdftoppm: '',
  pdfinfo: '',
  // The hint Claude was last given with a prompt (hintNow): sent again only
  // when it changes, or after a compaction.
  sentHint: '',
  // SHOW_YOUR_WORK_DEBUG=1 (see debug in telemetry.ts).
  isDebug: false,
  terminalName: '',
  // CLAUDE_CODE_FORCE_TERMINAL_IMAGES was set when Claude Code started.
  isForced: false,
  // Inside tmux, the terminal around it (`ghostty`, `kitty`, `rex`, or '').
  outerTerminal: '',
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

// Windows: the Unix tools this plugin runs live in Git for Windows' usr/bin,
// which is not on the Windows PATH. run() names them in full there.
// A path as a file URL, percent-encoded a segment at a time so nothing in the
// name can close an attribute. A Windows drive path C:/x needs file:///C:/x.
export const fileUrl = (raw: string) => {
  // Claude Code may hand over C:\x\y (the plugin's own folder does): a drive
  // path's backslashes become slashes first.
  const path = /^[A-Za-z]:\\/.test(raw) ? raw.replace(/\\/g, '/') : raw
  const drive = /^[A-Za-z]:(?=\/)/.exec(path)?.[0] ?? ''
  return `file://${drive ? '/' + drive : ''}${path.slice(drive.length).split('/').map(encodeURIComponent).join('/')}`
}

export const UNIX_TOOLS = new Set(['sh', 'mkdir', 'rm', 'mv', 'cp', 'touch', 'cat', 'mktemp', 'cygpath', 'uname', 'id', 'pwd'])

export function winArgv(argv: string[], gitBin: string): string[] {
  if (!gitBin || argv.length === 0 || !UNIX_TOOLS.has(argv[0]!)) {
    return argv
  }
  const result = [`${gitBin}/${argv[0]}.exe`, ...argv.slice(1)]
  if (argv[0] === 'sh' && (argv[1] === '-c' || argv[1] === '-lc') && typeof argv[2] === 'string') {
    result[2] = 'PATH="/usr/bin:$PATH"; ' + argv[2]
  }
  return result
}

export async function findGitBin($: EngineInterface): Promise<string> {
  const os = await Promise.resolve().then(() => $.env.get('OS')).catch(() => undefined)
  if (os !== 'Windows_NT') {
    return ''
  }

  const candidates: string[] = []

  const gitBashPath = await Promise.resolve().then(() => $.env.get('CLAUDE_CODE_GIT_BASH_PATH')).catch(() => undefined)
  if (gitBashPath) {
    const normalized = gitBashPath.replace(/\\/g, '/')
    const stripped = normalized.replace(/\/(usr\/)?bin\/(ba)?sh\.exe$/i, '')
    candidates.push(stripped + '/usr/bin')
  }

  const whereResult = await Promise.resolve().then(() => $.process.run(['where', 'git'])).catch(() => ({ stdout: '' }))
  const stdout = whereResult.stdout || ''
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const normalized = trimmed.replace(/\\/g, '/')
    if (/\/(cmd|bin|mingw64\/bin)\/git\.exe$/i.test(normalized)) {
      const stripped = normalized.replace(/\/(cmd|bin|mingw64\/bin)\/git\.exe$/i, '')
      candidates.push(stripped + '/usr/bin')
    }
  }

  candidates.push('C:/Program Files/Git/usr/bin')

  for (const c of candidates) {
    const exists = await Promise.resolve().then(() => $.fs.stat(`${c}/sh.exe`)).then(() => true, () => false)
    if (exists) {
      return c
    }
  }

  return ''
}

export function runTool($: EngineInterface, argv: string[], options?: { timeoutMs: number }) {
  return $.process.run(winArgv(argv, state.gitBin), options)
}
