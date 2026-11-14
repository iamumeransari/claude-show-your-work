// What the session runs on, found at its start: the temp folder, home,
// ffmpeg, ssh and the terminal's cell.
import type { EngineInterface } from 'claude-code'

import { findGitBin, runTool, state } from './state'
import { measureCells } from './layout'

export const PICK_TMP = [
  'base="${TMPDIR:-/tmp}"; base="${base%/}"; d="$base/claude-show-your-work-$(id -u)"',
  'mkdir -m 700 -p "$d" 2>/dev/null',
  'if [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ]; then chmod 700 "$d"; printf "%s" "$d"; else mktemp -d "$base/claude-show-your-work-XXXXXX"; fi',
].join('\n')
export const isAtLeast = (version: string, least: string) => {
  const [a, b] = [version, least].map(v => v.split(/[.-]/).slice(0, 3).map(Number))
  for (let i = 0; i < 3; i++) if ((a![i] ?? 0) !== (b![i] ?? 0)) return (a![i] ?? 0) > (b![i] ?? 0)
  return true
}
// Where things are: the temp folder, home, ffmpeg and the cell's size. Run at
// session start, and by anything that needs it before then, since a reload
// mid-session can bring the module back without a session start.
export function setUp($: EngineInterface): Promise<void> {
  // Each step on its own: one that fails leaves the defaults, never a throw.
  const tryRun = (argv: string[], options?: { timeoutMs: number }) => Promise.resolve().then(() => runTool($, argv, options)).catch(() => null)
  return (state.setup ??= (async () => {
    // After a reload the session start doesn't run again: ask the session
    // where it runs, so history is read from the right folder.
    state.gitBin = await findGitBin($)
    if (!state.cwd) state.cwd = (await Promise.resolve().then(() => $.session.cwd()).catch(() => '')) || ((await tryRun(['pwd']))?.stdout ?? '').trim()
    const picked = await tryRun(['sh', '-c', PICK_TMP])
    if (picked && picked.exitCode === 0 && picked.stdout.trim().startsWith('/')) state.TMP = picked.stdout.trim()
    // A login shell finds ffmpeg where the person's profile puts it; one that
    // hangs gets five seconds, then a plain shell and the usual places.
    const where = 'echo "home=$HOME"; echo "ff=$(command -v ffmpeg)"; echo "fp=$(command -v ffprobe)"; echo "fy=$(command -v ffplay)"; echo "cl=$(command -v claude)"; echo "os=$(uname -s)"; echo "ch=$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser || { p=; for a in "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac*/*.app/Contents/MacOS/* "/Applications/Chromium.app/Contents/MacOS/Chromium" "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "$HOME"/AppData/Local/ms-playwright/chromium-*/chrome-win*/chrome.exe "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" "/c/Program Files/Google/Chrome/Application/chrome.exe" "$HOME"/AppData/Local/Google/Chrome/Application/chrome.exe "/c/Program Files/Microsoft/Edge/Application/msedge.exe" "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-*/*headless*shell "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-*/*headless*shell "$HOME"/AppData/Local/ms-playwright/chromium_headless_shell-*/chrome-*/*headless*shell.exe; do [ -f "$a" ] && [ -x "$a" ] && p=$a; done; echo "$p"; })"; echo "pp=$(command -v pdftoppm)"; echo "pi=$(command -v pdfinfo)"'
    const run = (flag: string) => tryRun(['sh', flag, where], { timeoutMs: 5000 })
    const login = await run('-lc')
    const env = (login?.stdout.includes('os=') ? login : await run('-c')) ?? { stdout: '', stderr: '', exitCode: 1 }
    const found = (key: string) => env.stdout.split('\n').find(l => l.startsWith(`${key}=`))?.slice(key.length + 1).trim() ?? ''
    // Git for Windows' sh names things /c/Users/.../ffmpeg: one cygpath call
    // turns every path into C:/Users/.../ffmpeg.exe, which Node can stat and run.
    state.isWindows = !!state.gitBin || /^(MINGW|MSYS|CYGWIN)/i.test(found('os'))
    const mixed = new Map<string, string>()
    if (state.isWindows) {
      const keys = ['home', 'ff', 'fp', 'fy', 'cl', 'ch', 'pp', 'pi']
      const toMixed = 'for a; do if [ -n "$a" ]; then [ -f "$a.exe" ] && a="$a.exe"; cygpath -m "$a"; else echo; fi; done'
      const r = await tryRun(['sh', '-c', toMixed, 'sh', state.TMP, ...keys.map(found)])
      const lines = r && r.exitCode === 0 ? r.stdout.split('\n').map(l => l.trim()) : []
      if (lines[0]) state.TMP = lines[0]
      keys.forEach((k, i) => lines[i + 1] && mixed.set(k, lines[i + 1]!))
      state.cwd = state.cwd.replace(/\\/g, '/')
    }
    // Without cygpath's answer, /c/x is still read as C:/x.
    const got = (key: string) => mixed.get(key) ?? (state.isWindows ? found(key).replace(/^\/([A-Za-z])(?=\/|$)/, (_, d: string) => `${d.toUpperCase()}:`) : found(key))
    state.home = got('home') || ((await Promise.resolve().then(() => $.env.get('HOME')).catch(() => '')) ?? '')
    state.isMac = !state.isWindows && got('os') !== 'Linux'
    state.ffmpeg = got('ff') || (state.isMac ? '/opt/homebrew/bin/ffmpeg' : '/usr/bin/ffmpeg')
    state.ffprobe = got('fp') || (state.isMac ? '/opt/homebrew/bin/ffprobe' : '/usr/bin/ffprobe')
    state.claudePath = got('cl')
    // Else the last one there of: Playwright's Chromium builds, Chromium and
    // Chrome in /Applications; on Windows Chrome, then Edge, which every
    // Windows 11 has; then Playwright's headless shells (newest
    // last). A headless shell is made for screenshots: Playwright's Chrome
    // for Testing 1234 never wrote one on macOS and hung. It opens no window,
    // so Open page uses the default browser. With none, the install notice
    // shows instead of a failed render.
    state.chrome = got('ch')
    state.pdftoppm = got('pp') || (state.isMac ? '/opt/homebrew/bin/pdftoppm' : '')
    state.pdfinfo = got('pi') || (state.isMac ? '/opt/homebrew/bin/pdfinfo' : '')
    state.hasVideoTools = false
    // Over ssh the terminal can't read this machine's files: pictures go as bytes.
    const sshConnection = await Promise.resolve().then(() => $.env.get('SSH_CONNECTION')).catch(() => undefined)
    const sshTty = await Promise.resolve().then(() => $.env.get('SSH_TTY')).catch(() => undefined)
    if (sshConnection || sshTty) state.sendBytes = true
    // Sound plays on this machine's speakers: over ssh, or from a background
    // session nobody may be watching, it would play to the wrong room.
    const kind = await Promise.resolve().then(() => $.env.get('CLAUDE_CODE_SESSION_KIND')).catch(() => undefined)
    state.ffplay = got('fy')
    state.isFarFromSpeakers = !!(sshConnection || sshTty) || kind === 'bg'
    const engine = await Promise.resolve().then(() => $.session.version()).catch(() => null)
    state.canColourButtons = !!engine && isAtLeast(engine.base ?? engine.version, '2.1.295')
    const given = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(((await Promise.resolve().then(() => $.env.get('SHOW_YOUR_WORK_CELL')).catch(() => '')) ?? '').trim())
    if (given) state.cellGiven = { width: Number(given[1]), height: Number(given[2]) }
    await Promise.resolve().then(() => measureCells($)).catch(() => undefined)
  })())
}
