import { expect, test } from 'claude-code/testing'

// The card a document draws on, with its pages. The machine answers as one
// with poppler would: every page raster is a file, page two appears when
// poppler is asked for it. See sound-play.test.ts for the pattern.
const doc = (id: string, pages = 2) => ({
  kind: 'document', path: `/tmp/${id}/f00001.png`, source: `/tmp/${id}.pdf`, origin: `/tmp/${id}.pdf`,
  width: 1100, height: 1400, title: 'Report', generation: 1,
  pages: { dir: `/tmp/${id}`, count: pages, pdf: `/tmp/${id}.pdf` },
})

function pageMachine(on: any, onRun?: (argv: string[]) => void) {
  const made = new Set<string>(['/usr/bin/pdftoppm', '/usr/bin/pdfinfo', '/usr/bin/google-chrome'])
  const runs: string[][] = []
  docPages(on, doc(''))
  on('store.get', () => ({ value: undefined }))
  on('fs.stat', (_$: any, e: any) => (made.has(String(e.path)) || /f00001\.png$/.test(String(e.path)) ? { value: { kind: 'file', size: 100, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.read', (_$: any, e: any) => (/\.md$/.test(String(e.path)) ? { value: '# Refreshed' } : { value: { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAAC0lEQVRQnGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=' } }))
  on('fs.write', (_$: any, e: any) => { made.add(String(e.path)); return { value: undefined } })
  on('process.run', (_$: any, e: any) => {
    const argv: string[] = e.argv
    runs.push(argv)
    onRun?.(argv)
    if (argv[0] === 'sh' && String(argv[2]).includes('command -v')) return { value: { exitCode: 0, stdout: 'home=/tmp\nff=/bin/ffmpeg\nfp=/bin/ffprobe\nfy=/bin/ffplay\ncl=\nos=Linux\nch=/usr/bin/google-chrome\npp=/usr/bin/pdftoppm\npi=/usr/bin/pdfinfo\n', stderr: '' } }
    if (argv[0] === '/usr/bin/pdfinfo') return { value: { exitCode: 0, stdout: 'Pages:        1\n', stderr: '' } }
    if (argv.includes('--print-to-pdf=')) return { value: { exitCode: 0, stdout: '<html data-syw-document="ready"></html>', stderr: '' } }
    if (argv[0] === '/usr/bin/pdftoppm') { made.add(`${argv.at(-1)}.png`); return { value: { exitCode: 0, stdout: '', stderr: '' } } }
    if (argv[0] === 'mv') { made.add(String(argv[argv.length - 1])); return { value: { exitCode: 0, stdout: '', stderr: '' } } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  return { runs, made }
}
function docPages(on: any, d: ReturnType<typeof doc>) { on('fs.list', () => ({ value: [] })) }

async function mountDoc($: any, id: string, pages = 2) {
  const mounted = await $.ui.mount({
    plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: id,
    props: { tool_use_id: id, tool: 'mcp__show-your-work__show_document', output: `Shown.\nshow-your-work:${JSON.stringify(doc(id, pages))}`, isErrored: false },
    viewport: { columns: 140, rows: 50 },
  } as any)
  await mounted.drawn()
  return mounted
}

test('a document card shows page one of many, with page buttons and no player', async ($: any, on: any) => {
  pageMachine(on)
  const tree = JSON.stringify(await (await mountDoc($, 'p1')).drawn())
  expect(tree.includes('"Image"')).toBe(true)
  expect(tree.includes('Page 1 of 2')).toBe(true)
  // Pages, not playback: no play control, no skips, no sound.
  expect(tree.includes('Play')).toBe(false)
  expect(tree.includes('3s')).toBe(false)
  expect(tree.includes('Mute')).toBe(false)
  // Both ways are offered.
  expect(tree.includes('‹ Prev')).toBe(true)
  expect(tree.includes('Next ›')).toBe(true)
})

test('Next draws page two, and Prev comes back', async ($: any, on: any) => {
  const m = pageMachine(on)
  const mounted = await mountDoc($, 'p2')
  await mounted.press({ key: 'next' })
  await mounted.redraw()
  let tree = JSON.stringify(await mounted.drawn())
  expect(tree.includes('Page 2 of 2')).toBe(true)
  // Page two was rasterized on demand.
  expect(m.runs.some(a => a[0] === '/usr/bin/pdftoppm' && a.join(' ').includes('p00002'))).toBe(true)
  await mounted.press({ key: 'prev' })
  await mounted.redraw()
  tree = JSON.stringify(await mounted.drawn())
  expect(tree.includes('Page 1 of 2')).toBe(true)
})

test('a one-page document offers no page buttons', async ($: any, on: any) => {
  pageMachine(on)
  const tree = JSON.stringify(await (await mountDoc($, 'p3', 1)).drawn())
  expect(tree.includes('Page 1 of 1')).toBe(true)
  expect(tree.includes('Next')).toBe(false)
  expect(tree.includes('Prev')).toBe(false)
})

test('a printed document opens its rendered page in its own window, not the editor', async ($: any, on: any) => {
  const opened: string[][] = []
  pageMachine(on, argv => { opened.push(argv) })
  on('ui.toast', () => ({ value: undefined }))
  const target = await $.ui.mount({
    plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: 'p4',
    props: { tool_use_id: 'p4', tool: 'mcp__show-your-work__show_document', output: `Shown.\nshow-your-work:${JSON.stringify({ ...doc('p4', 1), source: '/tmp/p4/readme.md', origin: '/tmp/p4/readme.md', documentOpen: '/tmp/cache/p4-old.html' })}`, isErrored: false },
    viewport: { columns: 140, rows: 50 },
  } as any)
  await target.drawn()
  await target.press({ key: 'page' })
  // The preview was rebuilt first: the window opens the refreshed page, never
  // the stale HTML the old card was saved with.
  const argv = opened.find(a => a.includes('/usr/bin/google-chrome'))
  expect(argv).toBeTruthy()
  expect(argv!.join(' ')).toMatch(/--app=file:\/\/\/tmp\/claude-show-your-work\/d-v\d+-[^'"]+\.html/)
  expect(argv!.join(' ')).not.toContain('p4-old.html')
  // The raw Markdown never reaches the desktop's file handlers.
  expect(opened.some(a => a.some((x: string) => x === 'xdg-open'))).toBe(false)
})
