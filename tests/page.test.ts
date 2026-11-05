import { expect, test } from 'claude-code/testing'
import { state } from '../hooks/state'

import { htmlArgv, htmlOpenArgv, isPage, noticeOf, renderPage } from '../hooks/media'

test('a page is an html file, and only that', () => {
  expect(isPage('/tmp/report.html')).toBe(true)
  expect(isPage('/tmp/Design.HTM')).toBe(true)
  expect(isPage('/tmp/page.xhtml')).toBe(false)
  expect(isPage('/tmp/index.html.js')).toBe(false)
  expect(isPage('/tmp/shot.png')).toBe(false)
})

test('Open page uses a small app window, not the system HTML handler', () => {
  const argv = htmlOpenArgv('/usr/bin/google-chrome', '/tmp/a b.html')
  expect(argv).toStrictEqual(['/usr/bin/google-chrome', '--no-first-run', '--no-default-browser-check', '--app=file:///tmp/a%20b.html', '--window-size=960,720', `--user-data-dir=${state.TMP}/page-viewer.profile`])
  expect(argv).not.toContain('xdg-open')
})

test('the render command asks Chrome for a fixed-window picture of the page', () => {
  const argv = htmlArgv('/usr/bin/google-chrome', '/tmp/a b/report.html', '/tmp/out.png')
  expect(argv[0]).toBe('/usr/bin/google-chrome')
  // No sandbox flag: the page is a local file, and the flag weakens Chrome.
  expect(argv).not.toContain('--no-sandbox')
  for (const flag of ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1280,800', '--screenshot=/tmp/out.png']) expect(argv).toContain(flag)
  // A legal filename with a space, # or % is still one file URL: none of those
  // may be read as a path separator, fragment or percent escape.
  expect(argv.at(-1)).toBe('file:///tmp/a%20b/report.html')
  const tricky = htmlArgv('/usr/bin/google-chrome', '/tmp/50% off #1?.html', '/tmp/out.png').at(-1)
  expect(tricky).toBe('file:///tmp/50%25%20off%20%231%3F.html')
})

test('a page renders to a PNG, and a Chrome that fails says so', async () => {
  state.chrome = '/usr/bin/google-chrome'
  const runs: string[][] = []
  const ok = { fs: { stat: async () => ({ size: 123 }) }, process: { run: async (argv: string[]) => {
    runs.push(argv)
    if (argv[0] === 'mktemp') return { exitCode: 0, stdout: '/tmp/claude-show-your-work/page-ab12', stderr: '' }
    if (argv[0] === 'rm') return { exitCode: 0, stdout: '', stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  } } } as unknown as Parameters<typeof renderPage>[0]
  const out = await renderPage(ok, '/tmp/x/report.html', 'ab12cd')
  expect(out).toMatch(/\/page-ab12\/page-ab12cd\.png$/)
  expect(runs.at(-2)?.[0]).toBe('/usr/bin/google-chrome')

  const failing = { fs: { stat: async () => { throw new Error('gone') } }, process: { run: async (argv: string[]) => {
    if (argv[0] === 'mktemp') return { exitCode: 0, stdout: '/tmp/claude-show-your-work/page-ab12', stderr: '' }
    if (argv[0] === 'rm') return { exitCode: 0, stdout: '', stderr: '' }
    return { exitCode: 1, stdout: '', stderr: 'crashed' }
  } } } as unknown as Parameters<typeof renderPage>[0]
  await expect(renderPage(failing, '/tmp/x/report.html', 'ab12cd')).rejects.toThrow(/couldn't be rendered/i)
})

test('with no Chrome there is a plain prompt to install one', async () => {
  state.chrome = ''
  const failing = { process: { run: async () => ({ exitCode: 1, stdout: '', stderr: '' }) } } as unknown as Parameters<typeof renderPage>[0]
  await expect(renderPage(failing, '/tmp/x/report.html', 'ab12cd')).rejects.toThrow('pages need Chrome or Chromium')
  const n = noticeOf(new Error('pages need Chrome or Chromium'), '/tmp/x/report.html', '/home/u')
  expect(n.prompt.toLowerCase()).toContain('chrome')
})

test('a page that cannot be rendered falls back to a screenshot shown with show_image', () => {
  for (const raw of ['pages need Chrome or Chromium', "the page couldn't be rendered by Chrome or Chromium"]) {
    const n = noticeOf(new Error(raw), '/tmp/x/report.html', '/home/u')
    expect(n.message).toContain('Playwright')
    expect(n.message).toContain('show_image')
  }
})
