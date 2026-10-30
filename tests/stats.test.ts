import { expect, test } from 'claude-code/testing'
import { state } from '../hooks/state'

import { isStatsBlocked, nicknameOf } from '../hooks/telemetry'
import { noticeOf, NO_FFMPEG, noFfmpeg } from '../hooks/media'
import { hadVersionBefore06, isNewer } from '../hooks/updater'
import { cantDraw, causeOf, terminalOf } from '../hooks/player'
import { earlierNo } from '../hooks/onboarding'
import { outerOf } from '../hooks/tmux'

test('a newer version is spotted, an older or equal one is not', () => {
  expect(isNewer('0.5.0', '0.4.0')).toBe(true)
  expect(isNewer('1.10.0', '1.9.3')).toBe(true)
  expect(isNewer('0.4.0', '0.4.0')).toBe(false)
  expect(isNewer('0.4.0', '0.5.0')).toBe(false)
  expect(isNewer('1.0.0-beta', '0.9.0')).toBe(true)
})



test('the missing-ffmpeg message says how to install it, Homebrew included', () => {
  expect(NO_FFMPEG.includes('brew install ffmpeg')).toBe(true)
  expect(NO_FFMPEG.includes('https://brew.sh')).toBe(true)
  expect(/ENOENT/.test(NO_FFMPEG)).toBe(false)
})

const P = '/Users/u/Desktop/hero.png'
const kindOf = (raw: string, path = P) => noticeOf(new Error(raw), path, '/Users/u').kind

test('each failure gets its own plain notice', () => {
  expect(kindOf('show-your-work: $.fs.stat(/Users/u/Desktop/hero.png) failed: ENOENT')).toBe('missing')
  expect(kindOf("could not convert /x/.show-your-work/c50a67.txt: Error: Cannot extract image from file.")).toBe('not_image')
  expect(kindOf('ffmpeg could not read /x/9e1d4a.mp4: moov atom not found')).toBe('broken_video')
  expect(kindOf('ffmpeg could not read /x/a.mp4: [out#0/image2] Output file does not contain any stream')).toBe('no_picture')
  expect(kindOf(NO_FFMPEG)).toBe('no_ffmpeg')
  expect(kindOf('$.process.run(/opt/homebrew/bin/ffprobe) failed: ENOENT')).toBe('missing')
  expect(kindOf('something odd')).toBe('other')
})

test('notices use the person\'s own path, never raw tool output or internal copies', () => {
  for (const raw of ['show-your-work: $.fs.stat(/private/tmp/x) failed: ENOENT', 'could not convert /a/.show-your-work/c50a67.txt: sips', 'ffmpeg could not read /tmp/claude-show-your-work/v1/a.mp4: moov atom not found']) {
    const n = noticeOf(new Error(raw), P, '/Users/u')
    for (const text of [n.message, n.text, n.prompt]) {
      expect(/ENOENT|sips|moov|\.show-your-work|show-your-work:/.test(text)).toBe(false)
    }
    expect(n.message.includes('~/Desktop/hero.png')).toBe(true)
  }
})

test('a picture that cannot draw says why, and tells Claude it was not seen', () => {
  expect(causeOf(true, 'ghostty')).toBe('tmux')
  expect(causeOf(false, 'ghostty')).toBe('background')
  expect(causeOf(false, 'apple_terminal')).toBe('terminal')
  // Herdr, like tmux, gets its own setting to copy.
  expect(causeOf(false, 'herdr')).toBe('herdr')
  expect(cantDraw('herdr', 'a.png', 'picture', 'id1').command).toBe('[terminal]\nkitty_graphics = true')
  // Only Ghostty and kitty paint Claude Code's placeholders; Warp, WezTerm and Konsole can't.
  expect(causeOf(false, 'kitty')).toBe('background')
  for (const t of ['wezterm', 'warp', 'konsole']) expect(causeOf(false, t)).toBe('terminal')
  expect(cantDraw('terminal', 'a.png', 'picture', 'id1').text.includes('Ghostty and kitty')).toBe(true)
  expect(cantDraw('background', 'a.png', 'picture', 'id1').text.includes('Ghostty')).toBe(false)
  // The desktop app draws the card but not the picture: Open shows the file.
  expect(cantDraw('desktop', 'a.png', 'picture', 'id1').label).toBe('Open')
  expect(cantDraw('desktop', 'a.png', 'picture', 'id1').claude.includes('saw a notice instead of a.png')).toBe(true)
  // In tmux pictures need Claude Code restarted with them forced on; the
  // plugin passes them through after that.
  expect(cantDraw('tmux', 'a.png', 'picture', 'id1').command).toBe('CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1 claude --resume id1')
  expect(cantDraw('tmux', 'a.png', 'picture', 'id1').text.includes('New tmux panes')).toBe(true)
  expect(cantDraw('terminal', 'a.png', 'picture', 'id1').title).toBe("Your terminal isn't supported by show-your-work")
  expect(cantDraw('terminal', 'a.png', 'picture', 'id1').link?.href).toBe('https://github.com/iamumeransari/claude-show-your-work#terminals')
  expect(cantDraw('terminal', 'a.png', 'picture', 'id1').claude.includes('#terminals')).toBe(true)
  expect(cantDraw('background', 'a.png', 'video', 'id1').command.includes('--resume id1')).toBe(true)
  for (const cause of ['tmux', 'herdr', 'terminal', 'background'] as const) expect(cantDraw(cause, 'a.png', 'picture', '').claude.includes('saw a notice')).toBe(true)
})

test('Linux gets its own ffmpeg notice, with a package manager instead of Homebrew', () => {
  const n = noticeOf(new Error(noFfmpeg(false)), '/home/u/a.jpg', '/home/u')
  expect(n.kind).toBe('no_ffmpeg')
  expect(n.text.includes('apt install ffmpeg')).toBe(true)
  expect(/brew/.test(n.text + n.prompt + n.message)).toBe(false)
  expect(noticeOf(new Error(noFfmpeg(true)), '/Users/u/a.mp4', '/Users/u').text.includes('brew install ffmpeg')).toBe(true)
})

test('each install gets a made-up name, the same every time', () => {
  const id = '8f14e45f-ceea-467f-a9d3-6c1b7c8d2e11'
  expect(nicknameOf(id)).toBe(nicknameOf(id))
  expect(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{1,3}$/.test(nicknameOf(id))).toBe(true)
  expect(nicknameOf(id)).not.toBe(nicknameOf('0b7e0d1a-1234-4c4c-9a9a-aaaaaaaaaaaa'))
})


test('a no given before 0.6.0 is kept, and only a no', () => {
  expect(earlierNo(undefined, true, undefined)).toEqual({ isStatsOff: true, isUpdatesOff: false })
  expect(earlierNo({ stats: false, updates: true }, undefined, undefined)).toEqual({ isStatsOff: true, isUpdatesOff: false })
  expect(earlierNo({ stats: true, updates: false }, false, undefined)).toEqual({ isStatsOff: false, isUpdatesOff: true })
  expect(earlierNo(null, undefined, undefined)).toEqual({ isStatsOff: false, isUpdatesOff: false })
})

test('usage data stays off under any of its opt-outs, Claude Code\'s own included', () => {
  expect(isStatsBlocked(undefined, undefined, undefined)).toBe(false)
  expect(isStatsBlocked('0', undefined, undefined)).toBe(true)
  expect(isStatsBlocked(undefined, '1', undefined)).toBe(true)
  expect(isStatsBlocked(undefined, undefined, '1')).toBe(true)
  expect(isStatsBlocked(undefined, undefined, 'true')).toBe(true)
})

test('an install used before 0.6.0 is told from one that started on 0.6', () => {
  expect(hadVersionBefore06(['0.4.0', '0.5.16', '0.6.1'])).toBe(true)
  expect(hadVersionBefore06(['0.5.16', '0.6.2'])).toBe(true)
  expect(hadVersionBefore06(['0.6.0', '0.6.1', '0.6.2'])).toBe(false)
  expect(hadVersionBefore06(['.DS_Store', 'assets', 'hooks'])).toBe(false)
  expect(hadVersionBefore06([])).toBe(false)
})

test('the terminal is recognised from what it sets in the environment', () => {
  const env = (o: Partial<{ program: string; term: string; kitty: boolean; konsole: boolean; lcTerminal: string }>) => ({ program: '', term: '', kitty: false, konsole: false, ...o })
  expect(terminalOf(env({ program: 'ghostty', term: 'xterm-ghostty' }))).toBe('ghostty')
  expect(terminalOf(env({ term: 'xterm-kitty' }))).toBe('kitty')
  expect(terminalOf(env({ kitty: true, term: 'xterm-256color' }))).toBe('kitty')
  expect(terminalOf(env({ program: 'WezTerm' }))).toBe('wezterm')
  expect(terminalOf(env({ program: 'WarpTerminal' }))).toBe('warp')
  expect(terminalOf(env({ konsole: true }))).toBe('konsole')
  expect(terminalOf(env({ program: 'Apple_Terminal' }))).toBe('apple_terminal')
  expect(terminalOf(env({}))).toBe('other')
  expect(terminalOf(env({ program: 'iTerm.app' }))).toBe('iterm2')
  // Over ssh only LC_TERMINAL is left.
  expect(terminalOf(env({ lcTerminal: 'iTerm2' }))).toBe('iterm2')
  expect(causeOf(false, 'iterm2')).toBe('iterm')
})

test('Warp says it is Warp that cannot draw, and points to Ghostty and kitty', () => {
  state.terminalName = 'warp'
  const n = cantDraw('terminal', 'a.png', 'picture', 'abc123')
  expect(n.title).toBe("Warp can't show Claude Code's pictures yet")
  expect(n.command).toBe('claude --resume abc123')
  expect(n.claude.includes('Ghostty or kitty')).toBe(true)
  state.terminalName = ''
})

test('the terminal around tmux is read from the version it told tmux', () => {
  expect(outerOf('ghostty 1.2.3')).toBe('')
  expect(outerOf('kitty(0.35.2)')).toBe('')
  expect(outerOf('WezTerm 20240203-110809-5046fc22')).toBe('wezterm')
  expect(outerOf('Konsole 24.08')).toBe('konsole')
  expect(outerOf('')).toBe('')
})
