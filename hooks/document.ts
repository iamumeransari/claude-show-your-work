// Documents shown as pages: a PDF rasterized a page at a time, and Markdown
// or a Mermaid file printed to a PDF first, through the same pages. The
// page's HTML is built here from escaped text only; the only script it runs
// is the plugin's own pinned copy of Mermaid, offline.
import type { EngineInterface } from 'claude-code'

import type { Shown } from '../types'

import { state } from './state'

export const DOCUMENT = /\.(pdf|md|markdown|mmd|mermaid)$/i
export const isDocument = (path: string) => DOCUMENT.test(path)
export const isPrinted = (path: string) => /\.(md|markdown|mmd|mermaid)$/i.test(path)

// A page's width in pixels: portrait paper fits any card, and the terminal
// never enlarges a picture, so one size serves every window.
export const PAGE_WIDTH = 1100
export const DOC_TIMEOUT_MS = 30000
export const POPPLER_TIMEOUT_MS = 60000
export const MD_MAX_BYTES = 1_048_576
export const DOC_MAX_PAGES = 100

// ── Markdown to HTML, escaped first ───────────────────────────────────────

// A path into a file URL, percent-encoded a segment at a time: nothing in the
// name can close the attribute or inject markup.
const encodeDir = (path: string) => path.split('/').map(encodeURIComponent).join('/')

const escapeText = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const inline = (raw: string) => {
  let t = escapeText(raw)
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  t = t.replace(/\*([^*]+)\*/g, '<i>$1</i>')
  // A link's target is a page or a file only: anything with a scheme another
  // than http(s), and any scheme a browser might act on, is refused.
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, href: string) =>
    /^https?:\/\//i.test(href) ? `<a href="${href}">${label}</a>` : label)
  return t
}

export function markdownBody(text: string): string {
  return parseMarkdown(text).body
}

function parseMarkdown(text: string): { body: string; diagrams: string[] } {
  const diagrams: string[] = []
  const body = text.replace(/\r\n/g, '\n')

  const out: string[] = []
  let codeLines: string[] | null = null
  let codeKind = ''
  let inQuote = false
  let list: 'ul' | 'ol' | null = null
  let listItems: string[] = []
  const closeList = () => { if (list) { out.push(`<${list}>${listItems.join('')}</${list}>`); list = null; listItems = [] } }
  const cells = (row: string) => row.replace(/^\||\|$/g, '').split('|').map(c => c.trim())
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i]!.trim()
    if (s.startsWith('```')) {
      closeList()
      if (inQuote) { out.push('</blockquote>'); inQuote = false }
      if (codeLines !== null) {
        if (codeKind === 'mermaid') { diagrams.push(codeLines.join('\n')); out.push(`<div class="mmd" data-i="${diagrams.length - 1}"></div>`) }
        else out.push(`<pre><code>${codeLines.map(escapeText).join('\n')}</code></pre>`)
        codeLines = null
      } else { codeLines = []; codeKind = s.slice(3).trim().toLowerCase() }
      continue
    }
    if (codeLines !== null) { codeLines.push(lines[i]!); continue }
    const head = /^(#{1,6})\s+(.*)$/.exec(s)
    if (head) { closeList(); if (inQuote) { out.push('</blockquote>'); inQuote = false } out.push(`<h${head[1]!.length}>${inline(head[2]!)}</h${head[1]!.length}>`); continue }
    // A table: a header row, a --- row, at least one body row.
    const isRow = (l: string) => /^\|.*\|$/.test(l)
    if (isRow(s) && /^\|[\s:|-]+\|$/.test(lines[i + 1]?.trim() ?? '') && lines[i + 2] !== undefined && isRow(lines[i + 2]!.trim())) {
      closeList()
      const head = cells(s)
      const rows: string[][] = []
      let k = i + 2
      while (k < lines.length && isRow(lines[k]!.trim())) { rows.push(cells(lines[k]!.trim())); k++ }
      out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`)
      for (const r of rows) out.push(`<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`)
      out.push('</tbody></table>')
      i = k - 1
      continue
    }
    const li = /^[-*]\s+(.*)$/.exec(s)
    if (li) {
      if (inQuote) { out.push('</blockquote>'); inQuote = false }
      if (list !== 'ul') { closeList(); list = 'ul' }
      listItems.push(`<li>${inline(li[1]!)}</li>`)
      continue
    }
    const oi = /^\d+\.\s+(.*)$/.exec(s)
    if (oi) {
      if (inQuote) { out.push('</blockquote>'); inQuote = false }
      if (list !== 'ol') { closeList(); list = 'ol' }
      listItems.push(`<li>${inline(oi[1]!)}</li>`)
      continue
    }
    if (s.startsWith('>')) {
      closeList()
      if (!inQuote) { out.push('<blockquote>'); inQuote = true }
      out.push(`${inline(s.replace(/^>\s?/, ''))}<br>`)
      continue
    }
    if (inQuote) { out.push('</blockquote>'); inQuote = false }
    if (s === '---') { closeList(); out.push('<hr>'); continue }
    if (!s) { closeList(); continue }
    closeList()
    out.push(`<p>${inline(s)}</p>`)
  }
  closeList()
  if (inQuote) out.push('</blockquote>')
  if (codeLines !== null) out.push(`<pre><code>${codeLines.map(escapeText).join('\n')}</code></pre>`)
  return { body: out.join('\n'), diagrams }
}

// ── The printed page ──────────────────────────────────────────────────────

const scriptJson = (xs: string[]) =>
  JSON.stringify(xs).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

export function documentHtml(text: string, title: string, base: string, mermaidPath: string, bare = false): string {
  const parsed = bare ? { body: '<div class="mmd wide" data-i="0"></div>', diagrams: [text] } : parseMarkdown(text)
  const body = parsed.body
  const graphs = scriptJson(parsed.diagrams)
  const doc = `<!doctype html><meta charset="utf-8"><title>${escapeText(title)}</title>
<base href="file://${encodeDir(base)}">
<style>@page{margin:18mm 16mm}
:root{--ink:#1a1d23;--dim:#5b6472;--line:#e3e6ea;--wash:#f5f6f8}
html{-webkit-text-size-adjust:100%}
body{font:15px/1.6 -apple-system,'Segoe UI',Helvetica,sans-serif;margin:0 auto;padding:28px 36px 40px;max-width:820px;box-sizing:border-box;color:var(--ink);${bare ? 'text-align:center' : ''}}
@media print{body{padding:0;max-width:none;margin:0}}
h1,h2,h3,h4{line-height:1.25;margin:1.6em 0 .55em;letter-spacing:-.01em}
h1{font-size:1.9em;margin-top:.2em}h2{font-size:1.35em;border-bottom:1px solid var(--line);padding-bottom:.25em}h3{font-size:1.12em}h4{font-size:1em}
p{margin:.7em 0}
ul,ol{margin:.7em 0;padding-left:1.5em}li{margin:.25em 0}
pre{background:var(--wash);border:1px solid var(--line);padding:12px 14px;border-radius:8px;font:12.5px/1.55 ui-monospace,'Cascadia Mono',monospace;white-space:pre-wrap;overflow-x:auto}
code{font:0.92em ui-monospace,'Cascadia Mono',monospace;background:var(--wash);border:1px solid var(--line);border-radius:4px;padding:.08em .35em}
pre code{border:0;background:none;padding:0;font-size:1em}
blockquote{border-left:3px solid #b9bfc9;margin:1em 0;padding:.35em 1em;color:var(--dim)}
table{border-collapse:collapse;margin:1em 0;font-size:.95em}th,td{border:1px solid var(--line);padding:6px 12px;text-align:left}th{background:var(--wash)}tr:nth-child(even) td{background:#fafbfc}
a{color:#0b57d0;text-decoration:none}a:hover{text-decoration:underline}
hr{border:0;border-top:1px solid var(--line);margin:1.8em 0}
.mmd{margin:1.2em 0}.mmd.wide{margin:0}.mmd svg{max-width:100%}</style>
${body}
<script src="file://${encodeDir(mermaidPath)}"></script>
<script>mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'neutral'});
const G=${graphs};const all=[...document.querySelectorAll('.mmd')];
(async()=>{for(const el of all){try{el.innerHTML=(await mermaid.render('m'+el.dataset.i,G[+el.dataset.i])).svg}catch(e){el.innerHTML='<pre class="mmd-error"></pre>';el.dataset.error=String(e)}el.removeAttribute('data-i')}
const ok=!document.querySelector('.mmd-error');document.documentElement.setAttribute('data-syw-document',ok?'ready':'error');document.title='R'+all.length+(ok?'':'E')})()</script>`
  return doc
}

// ── The commands that make the pages ──────────────────────────────────────

export const pdfInfoArgv = (pdfinfo: string, pdf: string) => [pdfinfo, pdf]
export const pdfPageArgv = (pdftoppm: string, pdf: string, dir: string, page: number, width = PAGE_WIDTH) => [
  pdftoppm, '-png', '-scale-to-x', String(width), '-scale-to-y', '-1',
  '-f', String(page), '-l', String(page), '-singlefile', pdf,
  `${dir}/p${String(page).padStart(5, '0')}`,
]
// The print run prints the page and returns its rendered DOM in the same
// load, through a profile of the plugin's own: the person's profile is never
// touched, and the readiness verdict is about the very page that printed.
export const docPrintArgv = (chrome: string, html: string, pdf: string) => [
  chrome, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${pdf}.profile`, '--virtual-time-budget=8000',
  `--print-to-pdf=${pdf}`, '--no-pdf-header-footer', '--dump-dom', html,
]

// How a document's preparation failed, in words the person and Claude get.
export const docErrorOf = (why: string, name: string) => {
  if (why === 'poppler') return { kind: 'other' as const, message: `documents need poppler's pdftoppm and pdfinfo, which aren't installed. Install them (for example \`sudo apt install poppler-utils\` or \`brew install poppler\`), restart Claude Code, then show ${name} again.` }
  if (why === 'chrome') return { kind: 'other' as const, message: `markdown documents need Chrome or Chromium, and none was found. Install one, restart Claude Code, then show ${name} again.` }
  if (why === 'pages') return { kind: 'other' as const, message: `${name} has more than ${DOC_MAX_PAGES} pages, more than the player shows. Show a shorter extract of it instead.` }
  if (why === 'mermaid') return { kind: 'other' as const, message: `${name} has a Mermaid diagram that could not be drawn, so the document was not shown. Fix the diagram's syntax and show it again.` }
  return { kind: 'other' as const, message: `${name} couldn't be read as a document: ${why}` }
}

// Reads the page count out of pdfinfo's output.
export function docPageCount(facts: string): number {
  const m = /^Pages:\s+(\d+)/m.exec(facts)
  return m ? Number(m[1]) : 0
}

// The page as text after printing. The page's own script marks the document
// element 'ready' once every diagram holder has been drawn (or 'error' when
// one failed); no marker means the script never ran. Reading loose text here
// would let a person's own words fake a verdict.
export const domIsReady = (dom: string) => dom.includes('data-syw-document="ready"')
export const domHasError = (dom: string) => dom.includes('data-syw-document="error"')

// ── Preparing a document ──────────────────────────────────────────────────

import { exists, identityOf, isGone, keyOf, pngSize } from './media'

// The rendered page's look. Bump this when documentHtml's output changes:
// the cache folder's name carries it, so every file re-renders once with the
// new look while the old folders wait for the week-old cleanup.
const DOC_STYLE = 'v3'

function mermaidAsset($: EngineInterface) { return `${$.plugin.root}/assets/vendor/mermaid.min.js` }

// One document, prepared once per file: page one is rasterized now, the rest
// when they are asked for (see pageAt). The printed PDF of a Markdown file is
// built beside its pages and moved into place whole.
let docAttempt = 0
const docSession = Math.random().toString(36).slice(2)

export async function prepareDocument($: EngineInterface, real: string, title: string, originOf?: string): Promise<Shown> {
  const name = real.split('/').pop() || real
  if (!(await exists($, state.pdftoppm)) || !(await exists($, state.pdfinfo))) throw new Error(docErrorOf('poppler', name).message)
  const printed = isPrinted(real)
  if (printed && !state.chrome) throw new Error(docErrorOf('chrome', name).message)

  const id = ((await identityOf($, originOf ?? real).catch(() => undefined) ?? keyOf(originOf ?? real)).slice(0, 10))
  const dir = `${state.TMP}/d-${DOC_STYLE}-${id}`
  const html = `${dir}.html`
  const pdf = printed ? `${dir}.pdf` : real
  const first = `${dir}/f00001.png`
  // This attempt's own names: two preparations of one file never write where
  // the other writes (the attempt map in sound.ts is the same pattern).
  const attempt = docSession + Date.now().toString(36) + (docAttempt += 1).toString(36)

  const facts = await $.process.run(pdfInfoArgv(state.pdfinfo, printed ? `${pdf}` : real))
  // A printed document has no PDF yet on its first show; the count comes after
  // the print. A PDF file's count is known up front.
  let count = 0
  if (facts.exitCode === 0) count = docPageCount(facts.stdout)
  if (!printed && (facts.exitCode !== 0 || count < 1)) throw new Error(docErrorOf('PDF is unreadable, empty or password protected', name).message)
  if (count > DOC_MAX_PAGES) throw new Error(docErrorOf('pages', name).message)

  if (await isGone($, first)) {
    if (printed) {
      const text = String(await $.fs.read(real).catch(() => {
        throw new Error(docErrorOf('could not be read', name).message)
      }))
      if (text.length > MD_MAX_BYTES) throw new Error(docErrorOf(`is larger than the ${MD_MAX_BYTES >> 10} KiB the player prints`, name).message)
      const base = real.slice(0, real.lastIndexOf('/'))
      const partHtml = `${dir}.${attempt}.html`
      const partPdf = `${dir}.${attempt}.part.pdf`
      await $.fs.write(partHtml, documentHtml(text, title, base, mermaidAsset($), /\.(mmd|mermaid)$/i.test(real)))
      const print = await $.process.run(docPrintArgv(state.chrome, partHtml, partPdf), { timeoutMs: DOC_TIMEOUT_MS })
      await $.process.run(['rm', '-rf', '--', `${partPdf}.profile`]).catch(() => undefined)
      if (print.exitCode !== 0) throw new Error(docErrorOf(`the browser could not print it (${print.stderr.trim().slice(0, 120)})`, name).message)
      if (domHasError(print.stdout) || !domIsReady(print.stdout)) throw new Error(docErrorOf('mermaid', name).message)
      if ((await $.process.run(['mv', '-f', partPdf, pdf])).exitCode !== 0) throw new Error(docErrorOf('could not be finished', name).message)
      if ((await $.process.run(['mv', '-f', partHtml, html])).exitCode !== 0) throw new Error(docErrorOf('could not be finished', name).message)
      const printedFacts = await $.process.run(pdfInfoArgv(state.pdfinfo, pdf))
      const printedCount = docPageCount(printedFacts.stdout)
      if (printedFacts.exitCode !== 0 || printedCount < 1) throw new Error(docErrorOf('was printed with no pages', name).message)
      if (printedCount > DOC_MAX_PAGES) throw new Error(docErrorOf('pages', name).message)
      count = printedCount
    }
    await $.process.run(['mkdir', '-p', dir])
    const moved1 = await rasterPage($, pdf, dir, 1)
    if (moved1 !== first) throw new Error(docErrorOf('poppler could not rasterize page 1', name).message)
  }
  const size = await pngSize($, first)
  return {
    kind: 'document', path: first, source: real, width: size.width, height: size.height,
    title, generation: ++state.generation, pages: { dir, count, pdf },
    ...(printed ? { documentOpen: html } : {}),
  }
}

// The rendered page a document opens, refreshed using the current generator
// even when the card itself was saved before the plugin was reloaded.
export async function documentView($: EngineInterface, media: Shown): Promise<string | null> {
  const source = media.origin ?? media.source
  if (!source) return null
  const fresh = await prepareDocument($, source, media.title)
  return fresh.documentOpen ?? null
}

// The raster of one page, made when it is first asked for. A printed document
// rasterizes from its own printed PDF, not from the Markdown or Mermaid file:
// poppler cannot read those. Pages sit beside each other in the document's
// own folder, so the week-old cleanup takes the whole document together.
export async function docPage($: EngineInterface, media: Shown, page: number): Promise<string | null> {
  const pages = media.pages
  const pdf = pages?.pdf ?? media.source
  if (!pages || !pdf) return null
  const at = Math.max(0, Math.min(page, pages.count - 1))
  const file = `${pages.dir}/f${String(at + 1).padStart(5, '0')}.png`
  if (!(await exists($, file))) return await rasterPage($, pdf, pages.dir, at + 1) === file ? file : null
  return file
}

// Renders one page to a side name and moves it into place whole: a render
// that dies midway never leaves a half-written page behind as a cached page.
async function rasterPage($: EngineInterface, pdf: string, dir: string, page: number): Promise<string | null> {
  await $.process.run(['mkdir', '-p', dir]).catch(() => undefined)
  const final = `${dir}/f${String(page).padStart(5, '0')}.png`
  const part = `${dir}/p${String(page).padStart(5, '0')}`
  const made = await $.process.run(pdfPageArgv(state.pdftoppm, pdf, dir, page), { timeoutMs: POPPLER_TIMEOUT_MS })
  if (made.exitCode !== 0) return null
  if ((await $.process.run(['mv', '-f', `${part}.png`, final])).exitCode !== 0) return null
  return (await isGone($, final)) ? null : final
}
