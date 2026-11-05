import { expect, test } from 'claude-code/testing'
import { state } from '../hooks/state'

import { docErrorOf, docPage, docPageCount, docPrintArgv, documentHtml, domIsReady, domHasError, isDocument, markdownBody, pdfInfoArgv, pdfPageArgv, prepareDocument } from '../hooks/document'
import { toolLine } from '../hooks/player'

test('a document is a pdf, a markdown file or a mermaid file, and only that', () => {
  expect(isDocument('/tmp/report.pdf')).toBe(true)
  expect(isDocument('/tmp/Notes.PDF')).toBe(true)
  expect(isDocument('/tmp/readme.md')).toBe(true)
  expect(isDocument('/tmp/README.MARKDOWN')).toBe(true)
  expect(isDocument('/tmp/flow.mmd')).toBe(true)
  expect(isDocument('/tmp/flow.MERMAID')).toBe(true)
  expect(isDocument('/tmp/page.html')).toBe(false)
  expect(isDocument('/tmp/tone.mp3')).toBe(false)
  expect(isDocument('/tmp/readme.md.js')).toBe(false)
  expect(isDocument('/tmp/shot.png')).toBe(false)
})

test('markdown becomes html: headings, emphasis, code, lists, quotes, links, tables', () => {
  const html = markdownBody('# Title\n\nSome **bold** and *italic* and `code()`.\n\n- one\n- two\n\n1. first\n\n> quoted\n\n[T](https://e.com/x)\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n')
  expect(html).toContain('<h1>Title</h1>')
  expect(html).toContain('<b>bold</b>')
  expect(html).toContain('<i>italic</i>')
  expect(html).toContain('<code>code()</code>')
  expect(html).toContain('<ul><li>one</li><li>two</li></ul>')
  expect(html).toContain('<ol><li>first</li></ol>')
  expect(html).toContain('<blockquote>')
  expect(html).toContain('<a href="https://e.com/x">T</a>')
  expect(html).toContain('<table>')
  expect(html).toContain('<td>2</td>')
})

test('markdown never passes raw html or script through', () => {
  const html = markdownBody('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[b](javascript:alert(1))')
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('<img')
  expect(html).not.toContain('<img')
  expect(html).not.toContain('javascript:')
})

test('fenced code stays code, and a mermaid fence becomes a numbered diagram holder', () => {
  const html = markdownBody('```js\nconst x = 1 < 2\n```\n\n```mermaid\ngraph LR\n  A-->B\n```\n')
  expect(html).toContain('<pre><code>const x = 1 &lt; 2</code></pre>')
  expect(html).not.toContain('graph LR')
  expect(html).toMatch(/class="mmd" data-i="0"/)
})

test('the page loads mermaid from the plugin, offline, and hands it the diagrams safely', () => {
  const page = documentHtml('```mermaid\ngraph LR\n  A-->B\n```', 'Report', '/tmp/dir/', '/plugin/assets/vendor/mermaid.min.js')
  expect(page).toContain('<base href="file:///tmp/dir/">')
  expect(page).toContain('src="file:///plugin/assets/vendor/mermaid.min.js"')
  expect(page).not.toMatch(/https?:\/\/(?!e\.com)/) // no CDN anywhere
  expect(page).toContain('data-i') // every diagram is bound before print is allowed
})

test('a bare mermaid file becomes one full-width diagram page', () => {
  const page = documentHtml('graph LR\n  A-->B', 'Flow', '/tmp/dir/', '/plugin/assets/vendor/mermaid.min.js', true)
  expect(page).toContain('data-i="0"')
  expect(page).not.toContain('<pre>')
})

test('pdf facts and page rasters come from poppler, one page at a time', () => {
  expect(pdfInfoArgv('/usr/bin/pdfinfo', '/tmp/r.pdf')).toStrictEqual(['/usr/bin/pdfinfo', '/tmp/r.pdf'])
  const argv = pdfPageArgv('/usr/bin/pdftoppm', '/tmp/r.pdf', '/tmp/d-x', 2, 1100)
  expect(argv[0]).toBe('/usr/bin/pdftoppm')
  expect(argv).toContain('-png')
  expect(argv).toContain('-singlefile')
  expect(argv.slice(argv.indexOf('-f'), argv.indexOf('-f') + 2)).toStrictEqual(['-f', '2'])
  expect(argv.slice(argv.indexOf('-l'), argv.indexOf('-l') + 2)).toStrictEqual(['-l', '2'])
  expect(argv.slice(argv.indexOf('-scale-to-x'), argv.indexOf('-scale-to-x') + 2)).toStrictEqual(['-scale-to-x', '1100'])
  expect(argv.at(-1)).toBe('/tmp/d-x/p00002')
})

test('markdown prints to pdf through chrome, sandbox on, throwaway profile, waiting for the page', () => {
  state.TMP = '/tmp/claude-show-your-work'
  const argv = docPrintArgv('/usr/bin/google-chrome', '/tmp/d-x.html', '/tmp/d-x.pdf')
  expect(argv[0]).toBe('/usr/bin/google-chrome')
  expect(argv).not.toContain('--no-sandbox')
  for (const flag of ['--headless=new', '--no-pdf-header-footer', '--print-to-pdf=/tmp/d-x.pdf']) expect(argv).toContain(flag)
  expect(argv.join(' ')).toContain('--virtual-time-budget=8000')
  expect(argv.join(' ')).toContain('--user-data-dir=/tmp/d-x.pdf.profile')
  expect(argv.at(-1)).toBe('/tmp/d-x.html')
})

test('the tool row reads like the other rows', () => {
  expect(toolLine('mcp__show-your-work__show_document', { path: '/tmp/r.pdf' }, true)).toBe('▦ Rasterizing document · r.pdf')
  expect(toolLine('mcp__show-your-work__show_document', { path: '/tmp/r.pdf' }, false)).toBe('▦ Document · r.pdf')
})

test('readiness is a document status marker, never arbitrary user text', () => {
  const ready = '<html data-syw-document="ready"><body><pre>data-i=0 data-error</pre></body></html>'
  expect(domIsReady(ready)).toBe(true)
  expect(domHasError(ready)).toBe(false)
  expect(domIsReady('<html><body>renderer never ran</body></html>')).toBe(false)
  expect(domHasError('<html data-syw-document="error"><body></body></html>')).toBe(true)
})

test('document paths cannot break out of HTML attributes', () => {
  const page = documentHtml('# Test', 'Title', '/tmp/a"<tag> #?/', '/tmp/plugin "&/mermaid.min.js')
  expect(page).not.toContain('href="file:///tmp/a"')
  expect(page).toContain('%22%3Ctag%3E%20%23%3F')
  expect(page).toContain('plugin%20%22%26/mermaid.min.js')
})

test('the page is readable on screen and unchanged in print', () => {
  const page = documentHtml('# Test', 'Title', '/tmp/dir/', '/plugin/assets/vendor/mermaid.min.js')
  // Screen (the app window): a centered column with room at the edges, and
  // headings that read as headings.
  expect(page).toContain('margin:0 auto;padding:28px 36px 40px;max-width:820px')
  expect(page).toContain('h1{font-size:1.9em')
  // Print (the card): the screen box steps aside for the page margins.
  expect(page).toContain('@media print{body{padding:0;max-width:none;margin:0}}')
})

test('pdfinfo reports pages, and the print run returns the page it printed', () => {
  expect(docPageCount('Pages:        12\nPage size:...')).toBe(12)
  expect(docPageCount('no pages line')).toBe(0)
  const argv = docPrintArgv('/usr/bin/google-chrome', '/tmp/d-x.html', '/tmp/d-x.pdf')
  expect(argv).toContain('--dump-dom')
  expect(argv.join(' ')).toContain('--user-data-dir=/tmp/d-x.pdf.profile')
})

// The machine a document prepares on, as a hand-made engine: poppler and
// chrome found, a one-pixel PNG any raster reads as, runs recorded.
const ONE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='
function docMachine(o: { pages?: number; dom?: string; md?: string; failPrint?: boolean } = {}) {
  const made = new Set<string>(['/usr/bin/pdftoppm', '/usr/bin/pdfinfo', '/usr/bin/google-chrome'])
  const runs: string[][] = []
  const fake = {
    plugin: { root: '/plugin' },
    fs: {
      stat: (path: string) => (made.has(path) || /\.(pdf|md|mmd)$/.test(path) ? Promise.resolve({ size: 100, mtimeMs: 0 }) : Promise.reject(new Error(`ENOENT: ${path}`))),
      read: (path: string, opts?: { as?: string }) => (opts?.as === 'bytes' || /\.png$/.test(path) ? Promise.resolve({ base64: ONE_PNG }) : Promise.resolve(o.md ?? '# Hello\n\nBody')),
      write: (path: string) => { made.add(path); return Promise.resolve() },
    },
    process: { run: (argv: string[]) => {
      runs.push(argv)
      if (argv[0] === '/usr/bin/pdfinfo') return Promise.resolve({ exitCode: 0, stdout: `Pages:        ${o.pages ?? 2}\n`, stderr: '' })
      if (argv.includes('--print-to-pdf=')) {
        if (o.failPrint) return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'chrome died' })
        return Promise.resolve({ exitCode: 0, stdout: o.dom ?? '<html data-syw-document="ready"><body>printed</body></html>', stderr: '' })
      }
      if (argv.includes('--dump-dom')) return Promise.resolve({ exitCode: 0, stdout: o.dom ?? '<html data-syw-document="ready"></html>', stderr: '' })
      if (argv[0] === '/usr/bin/pdftoppm') { made.add(`${argv.at(-1)}.png`); return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }) }
      if (argv[0] === 'mv') { made.add(argv.at(-1)!); return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }) }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
    } },
  }
  state.TMP = '/tmp/claude-show-your-work'
  state.isMac = false
  state.pdftoppm = '/usr/bin/pdftoppm'
  state.pdfinfo = '/usr/bin/pdfinfo'
  state.chrome = '/usr/bin/google-chrome'
  return { runs, made, fake }
}

test('a pdf becomes page one, with every page reachable', async () => {
  const m = docMachine()
  const shown = await prepareDocument(m.fake as any, '/tmp/report.pdf', 'Report')
  expect(shown.kind).toBe('document')
  expect(shown.source).toBe('/tmp/report.pdf')
  expect(shown.pages!.count).toBe(2)
  expect(shown.pages!.dir.startsWith('/tmp/claude-show-your-work/d-')).toBe(true)
  expect(shown.path.endsWith('.png')).toBe(true)
  const raster = m.runs.find(a => a[0] === '/usr/bin/pdftoppm')!
  expect(raster.slice(raster.indexOf('-f'), raster.indexOf('-f') + 2)).toStrictEqual(['-f', '1'])
})

test('a markdown file prints to a pdf first, and is kept as the openable page', async () => {
  const m = docMachine()
  const shown = await prepareDocument(m.fake as any, '/tmp/notes/readme.md', 'Readme')
  expect(shown.kind).toBe('document')
  expect(m.runs.some(a => a.some((arg: string) => arg.startsWith('--print-to-pdf=')) && a[a.length - 1]!.endsWith('.html'))).toBe(true)
  expect(shown.documentOpen!.endsWith('.html')).toBe(true)
  expect(shown.source).toBe('/tmp/notes/readme.md')
  // A printed document rasterizes its pages from its own printed PDF, never
  // from the Markdown file itself: poppler cannot read Markdown.
  expect(shown.pages!.pdf!.endsWith('.pdf')).toBe(true)
  const page2 = await docPage(m.fake as any, shown, 1)
  expect(page2).toBeTruthy()
  const raster2 = m.runs.filter(a => a[0] === '/usr/bin/pdftoppm').at(-1)!
  expect(raster2.includes(shown.pages!.pdf!)).toBe(true)
  expect(raster2.includes('/tmp/notes/readme.md')).toBe(false)
})

test('a mermaid diagram that fails to draw says so, and nothing is kept', async () => {
  const m = docMachine({ dom: '<html data-syw-document="error"><body>x</body></html>', md: '```mermaid\ngraph broken\n```' })
  await expect(prepareDocument(m.fake as any, '/tmp/bad.md', 'Bad')).rejects.toThrow(/could not be drawn/i)
  expect(m.runs.some(a => a[0] === 'mv')).toBe(false)
})

test('too many pages are refused before any rasterizing', async () => {
  const m = docMachine({ pages: 101 })
  await expect(prepareDocument(m.fake as any, '/tmp/big.pdf', 'Big')).rejects.toThrow(/more than 100 pages/i)
  expect(m.runs.some(a => a[0] === '/usr/bin/pdftoppm')).toBe(false)
})

test('a missing poppler is said before anything runs', async () => {
  const m = docMachine()
  m.made.delete('/usr/bin/pdftoppm')
  m.made.delete('/usr/bin/pdfinfo')
  await expect(prepareDocument(m.fake as any, '/tmp/x.pdf', 'X')).rejects.toThrow(/poppler/i)
  expect(m.runs.length).toBe(0)
})

test('a pdf shown again reuses its pages without new work', async () => {
  const m = docMachine()
  const first = await prepareDocument(m.fake as any, '/tmp/report.pdf', 'Report')
  const before = m.runs.length
  const again = await prepareDocument(m.fake as any, '/tmp/report.pdf', 'Report')
  expect(again.path).toBe(first.path)
  // Nothing renders again; only the page count is asked once more.
  const after = m.runs.slice(before)
  expect(after.every(a => a[0] === '/usr/bin/pdfinfo')).toBe(true)
  expect(m.runs.some(a => a[0] === '/usr/bin/pdftoppm' && a !== m.runs.find(r => r[0] === '/usr/bin/pdftoppm'))).toBe(false)
})
