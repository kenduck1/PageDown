import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { markdownToHtml } from '../src/markdown/pipeline'
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef } from 'pdf-lib'
import { launchIsolatedApp } from './electron-launch'
// The shared DEFAULT (no-frontmatter, Letter/portrait/1in) geometry every
// harness-driving gate paginates at, plus the shared default DocumentStyle
// sendDocument now also requires -- see gate-geometry.ts for why they're one
// shared pair, and why they have to be threaded through app.evaluate()'s
// own single argument rather than referenced from inside the callback.
import { LETTER_GEOMETRY, DEFAULT_STYLE } from './gate-geometry'

// Same mechanical deviations from the brief's literal sample as every other
// Phase 0 gate spec (see gate1/gate5/gate7's own comments for the full
// reasoning, confirmed empirically in Task 3/Gate 5): `__dirname` (not
// `import.meta.url`) for corpus/results paths, since this file transpiles to
// CommonJS; and the `globalThis.__pagedownPhase0` bridge (not a dynamic
// `import()` inside `app.evaluate()`), since that callback runs in a bare V8
// context with no working dynamic import. `markdownToHtml` and `pdf-lib` ARE
// reached via plain top-level Node imports here (like gate1/gate7's own
// `markdownToHtml` import) — both run entirely in this file's own
// Node/Playwright-test process, never inside `app.evaluate()`.
//
// `pdfjs-dist` is imported via a dynamic `import()` at the top of each test
// function instead — that one IS safe here (unlike inside `app.evaluate()`),
// since this file's own process is a real, modern Node runtime with working
// dynamic import; it's kept dynamic only because `pdfjs-dist`'s Node entry
// point (`pdfjs-dist/legacy/build/pdf.mjs`) is itself a pure-ESM `.mjs` file
// that Node's synchronous `require()` cannot load directly — confirmed
// empirically (a `require('pdfjs-dist/legacy/build/pdf.mjs')` throws `ERR_
// REQUIRE_ESM`), so a static top-level `import` (which this file's CJS
// transpile would turn into exactly that `require()` call) would fail the
// same way; `await import(...)` uses Node's real ESM loader instead, which
// has no such restriction.
//
// Deviation from the brief's Step 3 sample, beyond the mechanical ones
// above: `pdf-lib` alone (the brief's literal ask — `npm install -D
// pdf-lib`) can verify page COUNT but has no text-extraction API at all (it
// is an authoring/manipulation library, not a reader) and no purpose-built
// structure-tree API — only the raw catalog/indirect-object graph a reader
// would need to walk by hand. Actually answering this task's real questions
// ("does per-page TEXT match," "is a split table/header genuinely tagged as
// content vs. artifact") needs real text extraction and struct-tree
// resolution, not just page counting — so `pdfjs-dist` (installed
// alongside `pdf-lib`, not instead of it) is used for `getTextContent()`
// and for cross-checking the marked-content operator stream, while
// `pdf-lib`'s own catalog/`PDFDict`/`PDFArray`/`PDFRef` access is used
// directly for the STRUCTURE part of the brief's suggested "pdf-lib's
// catalog/structure-tree access" (see `walkStructTree` below) — no
// second, redundant struct-tree implementation was needed once pdf-lib's
// raw object graph was reachable. `pdf-lib` still does the primary,
// brief-mandated page-count assertion in Test 1.

function normalizeText(s: string): string {
  return s.replace(/\s+/g, '')
}

// Running footer text, as it appears in EXPORTED PDF TEXT but never in the
// on-screen DOM — and why removing it here is accounting for it rather than
// weakening this gate's comparison.
//
// As of the Page Setup Completeness sub-project, `DEFAULT_PAGE_CONFIG` is
// honoured for real: it carries `showFooter: true` with a centre value of
// `Page {n} of {total}`, so every document rendered through the default
// style — which is what `DEFAULT_STYLE` (phase0/gate-geometry.ts) hands this
// gate — now paints a real page-number footer into the `@bottom-center`
// Paged.js margin box.
//
// That text is CSS GENERATED CONTENT (`content:` on
// `.pagedjs_margin-content::after`), so it is structurally invisible to the
// on-screen side of this comparison: `.textContent` of a margin box is
// always empty. This gate's own header/footer test asserts exactly that
// asymmetry, and Gate 17 asserts the same strings really do resolve and
// paint. So the PDF side legitimately contains one string the DOM side
// never can, and comparing them without accounting for it would fail on
// every corpus file for a reason that has nothing to do with export
// fidelity — the property this test actually exists to measure.
//
// Anchored to the START of the page's text, and removed at most once, on
// purpose. Margin boxes paint before the content area, so the footer always
// leads the text stream (confirmed by this file's own header/footer probe,
// whose `outsideTaggedText` reads "…HeaderPage 1 of 2" ahead of any body
// text). Anchoring means a corpus document that legitimately CONTAINS the
// words "Page 1 of 1" in its own body is unaffected, which a global
// replace would have silently corrupted.
const RUNNING_FOOTER_PATTERN = /^Page\d+of\d+/

function stripRunningFooter(normalized: string): string {
  return normalized.replace(RUNNING_FOOTER_PATTERN, '')
}

// True if every character of `needle`, in order, appears somewhere (not
// necessarily contiguously) in `haystack` — AND, alongside that boolean,
// the actual extra characters of `haystack` that were NOT consumed by that
// greedy match (every haystack character skipped while `needle`'s cursor
// wasn't waiting on it). Used below for the corpus files where the exported
// PDF's text is expected to contain real, EXTRA content beyond what the
// on-screen DOM's `.textContent` reports (ordered-list/footnote `::marker`
// counters, `<img alt="...">` fallback text for an image that failed to
// load — both real, visible, printed text that never appears in
// `.textContent` by DOM spec, not an export bug — see Test 1's own comment
// for the concrete evidence). `isSubsequence` alone proves the meaningful
// invariant even when exact equality doesn't hold (nothing on-screen is
// MISSING from the export); `extra` makes WHAT was added self-evidencing —
// written into the committed `gate4-findings.json` per file below, rather
// than living only in this task's own report narrative.
function subsequenceDelta(
  needle: string,
  haystack: string
): { isSubsequence: boolean; extra: string } {
  let i = 0
  let extra = ''
  for (let j = 0; j < haystack.length; j++) {
    if (i < needle.length && needle[i] === haystack[j]) {
      i++
    } else {
      extra += haystack[j]
    }
  }
  return { isSubsequence: i === needle.length, extra }
}

interface StructNode {
  tag: string
  pageRef: string | null
  children: StructNode[]
}

// Walks a PDF's /StructTreeRoot directly via pdf-lib's own low-level object
// graph (`PDFDict`/`PDFArray`/`PDFRef`/`context.lookup`) — pdf-lib has no
// purpose-built structure-tree reader API (see the file-level comment
// above), but its catalog/indirect-object access is sufficient to walk this
// by hand: every /StructElem dict carries an /S tag name (Chromium's
// Skia/PDF producer, confirmed by inspection here, also stamps /S on the
// root /Document node — /Type is only consulted as a fallback for the rare
// case that's absent) and a /K "kids" entry that is either a single dict, a
// single integer (a bare MCID — a leaf, nothing further to walk), or an
// array mixing any of those. A dict that carries a /Pg entry (either a
// StructElem with content directly on one page, or an MCR — marked-content
// reference — dict) records which page object it points at, so two
// sibling elements pointing at two DIFFERENT /Pg refs is the concrete,
// checkable signature of "split across a page boundary into two separate
// elements" the design doc's Gate 4 criterion asks about.
function walkStructTree(pdfDoc: PDFDocument, rootRef: unknown): StructNode[] {
  const context = pdfDoc.context
  function lookup(node: unknown): unknown {
    return node instanceof PDFRef ? context.lookup(node) : node
  }
  function walk(node: unknown): StructNode[] {
    const dict = lookup(node)
    if (dict instanceof PDFDict) {
      const s = dict.get(PDFName.of('S'))
      const type = dict.get(PDFName.of('Type'))
      // PDFName#toString() includes the leading '/' (PDF's own name-object
      // syntax) — stripped here so tag names read as plain identifiers
      // (`H1`, `Table`, ...) everywhere this function's callers use them,
      // rather than requiring every caller to remember the slash.
      const tag = (s ?? type)?.toString().replace(/^\//, '') ?? '?'
      const pg = dict.get(PDFName.of('Pg'))
      const k = dict.get(PDFName.of('K'))
      return [{ tag, pageRef: pg ? pg.toString() : null, children: k ? walk(k) : [] }]
    }
    if (dict instanceof PDFArray) {
      const out: StructNode[] = []
      for (let i = 0; i < dict.size(); i++) out.push(...walk(dict.get(i)))
      return out
    }
    // Plain numbers (bare MCIDs) and anything else are leaves — nothing
    // further to walk.
    return []
  }
  return walk(rootRef)
}

function countTags(
  nodes: StructNode[],
  counts: Record<string, number> = {}
): Record<string, number> {
  for (const n of nodes) {
    counts[n.tag] = (counts[n.tag] ?? 0) + 1
    countTags(n.children, counts)
  }
  return counts
}

function findAll(nodes: StructNode[], tag: string): StructNode[] {
  const out: StructNode[] = []
  for (const n of nodes) {
    if (n.tag === tag) out.push(n)
    out.push(...findAll(n.children, tag))
  }
  return out
}

const RESULTS_DIR = join(__dirname, 'results')

// --- Test 1's per-file categorization -------------------------------------
//
// Measured directly (not assumed) against every corpus file, comparing each
// on-screen `.pagedjs_page` element's `textContent` (after cloning and
// stripping any `<style>` descendants — see that fix's own comment below)
// against the exported PDF's `pdfjs-dist`-extracted per-page text, both
// normalized by stripping all whitespace: 9 of 14 files match EXACTLY,
// character-for-character. The other 5 do not match exactly, but in EVERY
// case the on-screen text is a subsequence of the exported PDF's text (see
// `isSubsequence` above) — i.e. the export never DROPS anything the preview
// shows, it only ever ADDS real, legitimately-printed content that
// `element.textContent` never includes by DOM spec:
//   - `nested-lists.md`, `reference-links-and-footnotes.md`,
//     `continuation-prefixes.md`: ordered-list and footnote-list item
//     numbers ("1.", "2.", ...) are painted by the browser as CSS
//     `::marker` generated content, which is real, visible, printed text
//     but is NEVER part of `element.textContent` for the list item — a
//     property of the DOM API, not of this export pipeline.
//   - `mixed.md`, `images-and-diagrams.md`: both reference a relative-path
//     image (`./assets/diagram-placeholder.png`) that this harness's
//     `pagedown-render://` scheme does NOT serve (confirmed directly:
//     `img.complete === true`, `img.naturalWidth === 0` — the request
//     404s, since the scheme handler only serves the static
//     `out/pagination-render/` bundle, not `phase0/corpus/assets/`; a real,
//     separate, previously-undocumented gap in this harness's image
//     handling, flagged in this task's report/findings-doc entry, out of
//     THIS gate's scope to fix). Chromium falls back to rendering the
//     `<img>`'s `alt` text in place of the failed image — real, printed,
//     extractable text, but (like the list-marker case) never part of
//     `element.textContent`, which only ever reflects DOM attribute/text
//     content, never a fallback rendering decision.
// This is a genuine, understood property of comparing DOM `.textContent`
// against rendered/printed text — not an export-specific bug, and not
// swept under an automatic normalization rule (a blanket "strip digits" or
// "strip alt text" rule would risk silently absorbing an unrelated real
// content-loss bug the same way Gate 1's own review history warns about
// conditional checks doing — see that gate's Meta-finding). Every corpus
// file discovered on disk must appear in exactly one of these two sets;
// `readdirSync`'s own use (rather than a hardcoded file list) here, plus
// the "categorized exactly once" check below, means a future new corpus
// fixture can't silently sail through this gate uncategorized.
const EXACT_MATCH_FILES = new Set([
  'short.md',
  'tables-spanning-pages.md',
  'headings-near-page-bottom.md',
  'entities-and-escapes.md',
  'foreign-frontmatter.md',
  'long.md',
  'very-long.md',
  // Matches exactly DESPITE the real, separate content-loss bug this task
  // found in this file specifically (see the dedicated assertion below,
  // near the end of Test 1) — both sides are symmetrically missing the
  // same content, which is what "matches" is actually checking here.
  'mermaid-diagrams.md',
  // Added by the Phase 1 Milkdown spike (Task 3), which introduced this
  // corpus fixture. Measured (not assumed) by a real run of this gate: it
  // matches exactly. It contains no lists and no images, so neither of the
  // two `::marker`/alt-text causes above applies; its raw HTML, HTML
  // comments, and pagebreak markers are all preserved (not dropped) by
  // markdownToHtml's whole-tree sanitize pipeline
  // (src/markdown/pipeline.ts) — the same, single markdownToHtml call
  // generates the HTML for both the on-screen preview and the PDF export,
  // so both sides see identical output by construction, and there is no
  // asymmetry for this check to find.
  'raw-html.md'
])
const SUBSEQUENCE_ONLY_FILES = new Set([
  'mixed.md',
  'images-and-diagrams.md',
  'nested-lists.md',
  'reference-links-and-footnotes.md',
  'continuation-prefixes.md'
])

test('Gate 4: exported PDF page count and per-page text match the on-screen Paged.js rendering across the reference corpus', async () => {
  test.setTimeout(90_000)
  const { app, close } = await launchIsolatedApp(['.'])
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

  const corpusDir = join(__dirname, 'corpus')
  const files = readdirSync(corpusDir)
    .filter((f) => f.endsWith('.md'))
    .sort()

  // Every discovered corpus file must be categorized exactly once — see the
  // comment above EXACT_MATCH_FILES for why an uncategorized file is a real
  // gap in this test rather than something to silently default past.
  for (const file of files) {
    const inExact = EXACT_MATCH_FILES.has(file)
    const inSubsequence = SUBSEQUENCE_ONLY_FILES.has(file)
    expect(
      inExact !== inSubsequence,
      `${file} must be categorized in exactly one of EXACT_MATCH_FILES/SUBSEQUENCE_ONLY_FILES (found in exact=${inExact}, subsequence=${inSubsequence})`
    ).toBe(true)
  }

  // One harness, reused across the whole corpus loop — same rationale as
  // Gate 2's own harness reuse (avoids folding WebContentsView creation/
  // first-navigation cost into whichever file happens to run first, and
  // matches how the real app would use one long-lived harness rather than
  // recreating it per document).
  await app.evaluate(async ({ BaseWindow }) => {
    const bridge = (
      globalThis as unknown as {
        __pagedownPhase0: {
          createPaginationHarness: typeof import('../src/main/pagination-window').createPaginationHarness
        }
      }
    ).__pagedownPhase0
    const win = new BaseWindow({ show: false })
    ;(globalThis as unknown as { __gate4Harness: unknown }).__gate4Harness =
      await bridge.createPaginationHarness(win)
    return true
  })

  const perFileResults: Array<{
    file: string
    onscreenPageCount: number
    pdfLibPageCount: number
    pdfjsPageCount: number
    pageCountMatch: boolean
    textCategory: 'exact' | 'subsequence'
    textMatch: boolean
    firstMismatchDetail: string | null
    textDeltaSample: string
    exportMs: number
    imgInfo: Array<{
      src: string
      alt: string
      complete: boolean
      naturalWidth: number
      naturalHeight: number
    }>
  }> = []

  // Captured only for `mermaid-diagrams.md`'s own loop iteration, while its
  // DOM is still live — the harness moves on to the next document each
  // subsequent iteration, so this is the only point this evidence is
  // reachable at all. Used by the dedicated content-loss assertions after
  // the loop below.
  let mermaidDiagramDomEvidence: Array<{
    instance: number
    rects: number
    texts: number
    paths: number
  }> = []

  for (const file of files) {
    const markdown = readFileSync(join(corpusDir, file), 'utf8')
    const { html } = markdownToHtml(markdown)

    const evalResult = await app.evaluate(
      async (_electronNS, { html, geometry, documentStyle }) => {
        const harness = (
          globalThis as unknown as {
            __gate4Harness: import('../src/main/pagination-window').PaginationHarness
          }
        ).__gate4Harness
        const sendResult = await harness.sendDocument(html, geometry, documentStyle)
        // Cloning each page and stripping <style> descendants before reading
        // textContent is load-bearing, not cosmetic — found directly by
        // running this test against mermaid-diagrams.md: `element.textContent`
        // includes the text content of any descendant `<style>` element (real
        // per the DOM spec — a `<style>` tag's content IS text, even though
        // it's never rendered as page content), and every Mermaid diagram
        // wrapper carries its own nonced `<style>` block (Task 8/Gate 3 —
        // 15/24/46 hoisted CSS rules per diagram). Reading textContent
        // directly off the live page pulled in hundreds of characters of raw
        // CSS text ("#pagedown-mermaid-0{font-family...}") that has nothing
        // to do with visible page content, making any comparison against the
        // exported PDF's real text meaningless for that file. Stripping
        // <style> first is a no-op for every other corpus file (none of them
        // contain a <style> element at all).
        // Stripping .sr-only descendants alongside <style> for the identical
        // reason: reference-links-and-footnotes.md's footnote section carries
        // a real, correctly visually-hidden "Footnotes" <h2 class="sr-only">
        // label (see src/typography/document-typography.css's own .sr-only
        // rule) -- present in the DOM and therefore in .textContent, but
        // never painted, so pdfjs's real extracted PDF text never contains
        // it. Without stripping it here, this comparison would fail not
        // because export lost content, but because .textContent counts
        // content that was NEVER meant to be visible in the first place --
        // the same class of "textContent measures the wrong thing" gap
        // <style> already demonstrated, just in the opposite direction (here
        // it's onscreen-only content missing from the PDF, not PDF-only
        // content missing onscreen).
        const pagesText = await harness.view.webContents.executeJavaScript(`
        Array.from(document.querySelectorAll('.pagedjs_page')).map(p => {
          const clone = p.cloneNode(true)
          clone.querySelectorAll('style').forEach(s => s.remove())
          clone.querySelectorAll('.sr-only').forEach(s => s.remove())
          return clone.textContent
        })
      `)
        // Durable DOM-side evidence for the two bugs this task found, turned
        // into standing test data (not just a one-time manual observation) —
        // cheap: both queries are no-ops (empty arrays) for every file that
        // doesn't happen to contain an `<img>` or the oversized diagram's
        // wrapper, so this runs unconditionally for every corpus file rather
        // than needing a per-file branch here.
        const imgInfo = await harness.view.webContents.executeJavaScript(`
        Array.from(document.querySelectorAll('img')).map(img => ({
          src: img.src,
          alt: img.alt,
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight
        }))
      `)
        const mermaidOversizedDiagramInfo = await harness.view.webContents.executeJavaScript(`
        Array.from(document.querySelectorAll('[data-mermaid-diagram-id="pagedown-mermaid-2"]')).map((wrapper, instance) => {
          const svg = wrapper.querySelector('svg')
          return {
            instance,
            rects: svg ? svg.querySelectorAll('rect').length : -1,
            texts: svg ? svg.querySelectorAll('text').length : -1,
            paths: svg ? svg.querySelectorAll('path').length : -1
          }
        })
      `)
        const bridge = (
          globalThis as unknown as {
            __pagedownPhase0: { exportToPdf: typeof import('../src/export/export-pdf').exportToPdf }
          }
        ).__pagedownPhase0
        // Real, measured export timing (not an uncommitted, ad hoc scratch
        // number) — `Date.now()` around the SAME `exportToPdf` call every
        // other check in this test already makes, so this costs nothing
        // beyond two timestamps.
        const exportStart = Date.now()
        const pdf = await bridge.exportToPdf(harness)
        const exportMs = Date.now() - exportStart
        return {
          sendResult,
          pagesText,
          imgInfo,
          mermaidOversizedDiagramInfo,
          exportMs,
          pdfBase64: pdf.toString('base64')
        }
      },
      { html, geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
    )

    const { sendResult, pagesText, imgInfo, mermaidOversizedDiagramInfo, exportMs, pdfBase64 } =
      evalResult as {
        sendResult: { pageCount: number }
        pagesText: string[]
        imgInfo: Array<{
          src: string
          alt: string
          complete: boolean
          naturalWidth: number
          naturalHeight: number
        }>
        mermaidOversizedDiagramInfo: Array<{
          instance: number
          rects: number
          texts: number
          paths: number
        }>
        exportMs: number
        pdfBase64: string
      }
    const pdfBuffer = Buffer.from(pdfBase64, 'base64')

    // Save specific PDFs as durable, openable evidence — the brief's own
    // required gate4-export.pdf (mixed.md) plus mermaid-diagrams.md, whose
    // export is the concrete artifact behind this test's dedicated
    // content-loss assertion below (a reviewer can open it directly and see
    // the missing diagram nodes for themselves, not just trust this test's
    // own textual description of them).
    if (file === 'mixed.md') {
      mkdirSync(RESULTS_DIR, { recursive: true })
      writeFileSync(join(RESULTS_DIR, 'gate4-export.pdf'), pdfBuffer)
    }
    if (file === 'mermaid-diagrams.md') {
      mkdirSync(RESULTS_DIR, { recursive: true })
      writeFileSync(join(RESULTS_DIR, 'gate4-mermaid-diagrams-export.pdf'), pdfBuffer)
      mermaidDiagramDomEvidence = mermaidOversizedDiagramInfo
    }

    // Durable regression guard for the image-loading gap this task found
    // (previously only a manual, scratch-directory observation): every
    // corpus image reference 404s against the `pagedown-render://` scheme
    // (it only serves `out/pagination-render/`, not `phase0/corpus/
    // assets/`), so `naturalWidth`/`naturalHeight` read 0 despite
    // `complete === true` — the classic "image failed to load" signature.
    // Asserted here, for the two files that actually reference an image,
    // rather than left as a comment only — if this harness's image-serving
    // is ever wired up, this assertion (not just a report's prose) is what
    // will need updating, and will fail loudly in the meantime if it isn't.
    if (file === 'mixed.md' || file === 'images-and-diagrams.md') {
      expect(imgInfo.length, `${file}: expected at least one <img> element`).toBeGreaterThan(0)
      for (const img of imgInfo) {
        expect(
          img.naturalWidth === 0 && img.naturalHeight === 0 && img.complete === true,
          `${file}: <img src="${img.src}"> is expected to have FAILED to load in this harness (naturalWidth/Height 0 despite complete=true) — this is the real, separate, previously-undocumented gap this task found (the pagedown-render:// scheme doesn't serve phase0/corpus/assets/); if this now loads for real, the image-serving gap has been closed and this assertion (and the alt-text-fallback explanation for this file's SUBSEQUENCE_ONLY_FILES membership) need updating`
        ).toBe(true)
      }
    }

    const onscreenPageCount = pagesText.length
    const pdfDoc = await PDFDocument.load(pdfBuffer)
    const pdfLibPageCount = pdfDoc.getPageCount()
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(pdfBuffer) })
    const pdfjsDoc = await loadingTask.promise
    const pdfjsPageCount = pdfjsDoc.numPages

    // Primary parity signal: page count, checked against BOTH independent
    // PDF-reading libraries, for every corpus file, unconditionally. This
    // is the one check every corpus file — with no exceptions — is held to.
    expect(pdfLibPageCount, `${file}: pdf-lib page count vs. on-screen pageCount`).toBe(
      onscreenPageCount
    )
    expect(pdfjsPageCount, `${file}: pdfjs page count vs. on-screen pageCount`).toBe(
      onscreenPageCount
    )
    expect(
      sendResult.pageCount,
      `${file}: on-screen pageCount vs. rendered .pagedjs_page count`
    ).toBe(onscreenPageCount)

    const category: 'exact' | 'subsequence' = EXACT_MATCH_FILES.has(file) ? 'exact' : 'subsequence'
    let textMatch = true
    let firstMismatchDetail: string | null = null
    // Accumulated, per-page "extra" characters the PDF's text has that the
    // on-screen text doesn't (see `subsequenceDelta`'s own comment) — for
    // `exact`-category files this is always empty by construction (exact
    // equality leaves nothing unconsumed); for `subsequence`-category files
    // this is the actual, computed evidence for WHY they're in that
    // category (list/footnote markers, image alt-text fallback), written
    // into the committed findings JSON below rather than only asserted by
    // this task's own report narrative.
    const textDeltaParts: string[] = []
    for (let i = 0; i < onscreenPageCount; i++) {
      const page = await pdfjsDoc.getPage(i + 1)
      const textContent = await page.getTextContent()
      const pdfText = stripRunningFooter(
        normalizeText(textContent.items.map((item) => ('str' in item ? item.str : '')).join(''))
      )
      const onscreenText = normalizeText(pagesText[i])

      const { isSubsequence, extra } = subsequenceDelta(onscreenText, pdfText)
      if (extra) textDeltaParts.push(extra)
      const ok = category === 'exact' ? onscreenText === pdfText : isSubsequence
      if (!ok) {
        textMatch = false
        firstMismatchDetail = `page ${i + 1} (${category} check failed): onscreen=${JSON.stringify(onscreenText.slice(0, 120))} pdf=${JSON.stringify(pdfText.slice(0, 120))}`
        break
      }
    }

    expect(textMatch, `${file}: ${firstMismatchDetail}`).toBe(true)
    // The delta itself must be empty for `exact`-category files — a
    // real, second confirmation of that category assignment (not just the
    // equality check above), and a sanity check on `subsequenceDelta`
    // itself: an exact match by definition consumes the whole haystack via
    // in-order matching against an identical needle, leaving nothing extra.
    if (category === 'exact') {
      expect(
        textDeltaParts.join(''),
        `${file}: exact-match files must have an empty text delta`
      ).toBe('')
    }

    perFileResults.push({
      file,
      onscreenPageCount,
      pdfLibPageCount,
      pdfjsPageCount,
      pageCountMatch: pdfLibPageCount === onscreenPageCount && pdfjsPageCount === onscreenPageCount,
      textCategory: category,
      textMatch,
      firstMismatchDetail,
      // Truncated for readability in the committed JSON — the point is to
      // make the KIND of extra content self-evidencing (marker digits,
      // alt text, ...), not to store an unbounded blob.
      textDeltaSample: textDeltaParts.join('').slice(0, 300),
      exportMs,
      imgInfo
    })
  }

  console.log('Gate 4 per-file parity results:', JSON.stringify(perFileResults, null, 2))

  // Dedicated, named assertion for the real content-loss bug this task
  // found (not just left implicit inside the aggregate "exact match" pass
  // above): the oversized diagram in mermaid-diagrams.md (Task 8/Gate 3's
  // own fixture, confirmed there to split into exactly 3 page-clone
  // instances) has its "Stage 1".."Stage 20" node labels COMPLETELY absent
  // from BOTH the on-screen render and the exported PDF — confirmed
  // directly (not inferred from the text check above alone) by re-reading
  // the full per-page text for this file from the SAME evaluate() call
  // already run above, and separately by direct DOM inspection during this
  // task's own investigation: every page-clone instance of
  // `[data-mermaid-diagram-id="pagedown-mermaid-2"]`'s `<svg>` reports
  // `querySelectorAll('rect').length === 0` and `querySelectorAll('text')
  // .length === 0` (only some `<path>` edge-line elements survive,
  // inconsistently, across the 3 clones) — a real, reproducible, BOTH-
  // on-screen-AND-export content-loss bug, not an export-specific
  // divergence (see this task's report for the fuller investigation,
  // including a source-grounded hypothesis: Paged.js's overflow-splitting
  // mechanism (layout.js's `removeOverflow` calls `Range.extractContents()`
  // — a native DOM API designed for splitting ordinary text-flow HTML, not
  // an SVG's internal, def/marker/id-referencing shape tree) is applied to
  // this SVG the same way it would be to a long paragraph, since Paged.js's
  // generic splitting logic has no special case for "this is a single
  // indivisible vector diagram" once `break-inside: avoid-page` has already
  // failed to prevent a split (see Gate 3's own finding that it does fail
  // to for content taller than one page)). This means Gate 3's own
  // bounding-box-only check (`getBoundingClientRect().width/height > 0`)
  // could not, and did not, catch this — a real gap in that gate's own
  // verification, found here.
  const mermaidResult = perFileResults.find((r) => r.file === 'mermaid-diagrams.md')
  expect(
    mermaidResult,
    'mermaid-diagrams.md must have been processed by the loop above'
  ).toBeTruthy()
  const mermaidFullText = await (async () => {
    const pdfPath = join(RESULTS_DIR, 'gate4-mermaid-diagrams-export.pdf')
    const buf = readFileSync(pdfPath)
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise
    let all = ''
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      all += tc.items.map((item) => ('str' in item ? item.str : '')).join('')
    }
    return all
  })()
  console.log(
    'Gate 4 mermaid-diagrams.md oversized-diagram content-loss check — "Stage" appears in exported PDF text:',
    mermaidFullText.includes('Stage')
  )
  expect(
    mermaidFullText.includes('Stage'),
    'the oversized diagram\'s "Stage N" node labels are expected to be ENTIRELY absent from the exported PDF (a real, both-sides content-loss bug found by this task — see the comment above) — if this now includes "Stage", either the bug was fixed (update this assertion) or something else changed'
  ).toBe(false)

  // The DOM-side half of the same finding, made durable rather than left as
  // a one-time manual observation: every page-clone instance of the
  // oversized diagram's `<svg>` is asserted here to have ZERO `<rect>` and
  // ZERO `<text>` elements (only `<path>` edge lines survive, inconsistently
  // — logged, not asserted on an exact count, since the exact per-clone
  // split of which paths survive was observed to vary run-to-run in a way
  // the rect/text absence did not). Captured during the loop above, at the
  // one point `mermaid-diagrams.md`'s own DOM is still live (see
  // `mermaidDiagramDomEvidence`'s own comment).
  console.log(
    'Gate 4 mermaid-diagrams.md oversized-diagram DOM evidence (rect/text/path counts per page-clone instance):',
    JSON.stringify(mermaidDiagramDomEvidence)
  )
  expect(
    mermaidDiagramDomEvidence.length,
    'expected at least one page-clone instance of the oversized diagram — an empty array would make the assertions below vacuous'
  ).toBeGreaterThan(0)
  for (const instance of mermaidDiagramDomEvidence) {
    expect(
      instance.rects,
      `mermaid-diagrams.md oversized-diagram page-clone instance ${instance.instance}: expected ZERO <rect> elements (the real, both-sides content-loss bug this task found) — if this is now > 0, the bug may have been fixed`
    ).toBe(0)
    expect(
      instance.texts,
      `mermaid-diagrams.md oversized-diagram page-clone instance ${instance.instance}: expected ZERO <text> elements (the real, both-sides content-loss bug this task found) — if this is now > 0, the bug may have been fixed`
    ).toBe(0)
  }

  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(
    join(RESULTS_DIR, 'gate4-findings.json'),
    JSON.stringify(
      {
        perFileResults,
        mermaidDiagramContentLossConfirmed: !mermaidFullText.includes('Stage'),
        mermaidDiagramDomEvidence
      },
      null,
      2
    )
  )

  await close()
})

test('Gate 4: split-block fragmentation — a table split across a page boundary becomes two separate structure elements, not one linked table', async () => {
  const { app, close } = await launchIsolatedApp(['.'])

  // A synthetic table, not one of the pinned reference-corpus fixtures —
  // `tables-spanning-pages.md` (the corpus fixture apparently built for
  // this exact purpose) was measured, for real, to paginate to exactly ONE
  // page at this harness's current default page box (no table-spanning
  // actually occurs against it today — see this task's report), and it is
  // one of Gate 1's 8 pinned `corpusFiles` (exact-run-count assertions),
  // so editing it to force a split risks silently breaking that gate's own
  // carefully-calibrated coverage. 35 rows, built directly as HTML (not
  // run through markdownToHtml — this is synthetic scaffolding for this
  // one check, not reference content), is enough to force a real 2-page
  // split at this harness's Letter/1in-margin default (confirmed directly
  // below via the measured page count, not assumed).
  //
  // Re-tuned from 60 to 35 rows by the Document Typography sub-project,
  // for a reason that was originally recorded WRONG here and corrected by
  // the final whole-branch review. The page box did NOT shrink: Paged.js's
  // `base.js` already defaulted `--pagedjs-margin-*` to 1in, so this
  // harness's content box has been 624 x 864 px throughout (the
  // `expect(sequence.width).toBe(624)` assertion in
  // phase0/gate3-mermaid.spec.ts is untouched by that branch and passes on
  // both sides of it). What changed is the TYPOGRAPHY that fills the box:
  // 14px/1.7 body text replacing the UA's 16px/`normal`, and 0.4em 0.6em
  // padding on every table cell, which together grew per-row height enough
  // that the old 60-row count now overflows to a 3-page split instead of 2.
  // Measured directly against this branch's typography: 21
  // rows -> 1 page, 22-45 rows -> 2 pages, 46+ rows -> 3 pages. 35 sits
  // comfortably mid-range (not pinned to either edge) so a small future
  // typography tweak doesn't immediately knock this back out of a 2-page
  // split. This count is geometry-sensitive: any future change to page
  // size, margins, or document typography (font size, line height, cell
  // padding) will likely require re-measuring and re-tuning it again.
  const rows = Array.from(
    { length: 35 },
    (_, i) =>
      `<tr><td>Row ${i + 1}</td><td>Category ${i % 5}</td><td>Some description text for row ${i + 1}</td><td>$${(i * 12.34).toFixed(2)}</td></tr>`
  ).join('\n')
  const html = `<h1>Synthetic Long Table</h1><table><thead><tr><th>Row</th><th>Category</th><th>Description</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>`

  const evalResult = await app.evaluate(
    async ({ BaseWindow }, { html, geometry, documentStyle }) => {
      const bridge = (
        globalThis as unknown as {
          __pagedownPhase0: {
            createPaginationHarness: typeof import('../src/main/pagination-window').createPaginationHarness
            exportToPdf: typeof import('../src/export/export-pdf').exportToPdf
          }
        }
      ).__pagedownPhase0
      const win = new BaseWindow({ show: false })
      const harness = await bridge.createPaginationHarness(win)
      const sendResult = await harness.sendDocument(html, geometry, documentStyle)
      const pdf = await bridge.exportToPdf(harness)
      return { sendResult, pdfBase64: pdf.toString('base64') }
    },
    { html, geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
  )

  const { sendResult, pdfBase64 } = evalResult as {
    sendResult: { pageCount: number }
    pdfBase64: string
  }
  console.log('Gate 4 synthetic table on-screen pageCount:', sendResult.pageCount)
  // The whole point of the 35-row count above: confirm this really did split across a page
  // boundary before drawing any conclusion from its tag structure below —
  // a table that happened to fit on one page would make every assertion
  // past this point vacuous.
  expect(
    sendResult.pageCount,
    'the synthetic table must actually split across pages for this check to mean anything'
  ).toBeGreaterThan(1)

  const pdfBuffer = Buffer.from(pdfBase64, 'base64')
  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(join(RESULTS_DIR, 'gate4-synthetic-table-export.pdf'), pdfBuffer)

  const pdfDoc = await PDFDocument.load(pdfBuffer)
  const catalog = pdfDoc.catalog
  const markInfo = catalog.get(PDFName.of('MarkInfo'))
  const structRootRef = catalog.get(PDFName.of('StructTreeRoot'))
  console.log(
    'Gate 4 catalog: MarkInfo present =',
    !!markInfo,
    ' StructTreeRoot present =',
    !!structRootRef
  )
  // The most basic possible check that `generateTaggedPDF: true` produced
  // ANY tagging at all — a real StructTreeRoot in the catalog, not just a
  // plain PDF. Everything below goes well past this binary signal, per the
  // design doc's own framing of what Gate 4 is actually supposed to check.
  expect(structRootRef, 'generateTaggedPDF: true must produce a real /StructTreeRoot').toBeTruthy()

  const tree = walkStructTree(pdfDoc, structRootRef)
  const tagCounts = countTags(tree)
  console.log('Gate 4 synthetic-table struct tree tag counts:', JSON.stringify(tagCounts))

  // Real semantic role richness, not just "NonStruct" everywhere — direct
  // evidence Chromium's tagged-PDF export maps real HTML elements to real
  // PDF structure roles (H1, Table, TR, TH, TD), not merely wrapping
  // everything as generic, undifferentiated content.
  expect(tagCounts.H1, 'the <h1> heading should be tagged as H1').toBeGreaterThan(0)
  expect(tagCounts.TD, 'table cells should be tagged as TD').toBeGreaterThan(0)

  const tableNodes = findAll(tree, 'Table')
  const trNodes = findAll(tree, 'TR')
  const thNodes = findAll(tree, 'TH')
  console.log(
    'Gate 4 fragmentation check — Table/TR/TH element counts:',
    JSON.stringify({
      tableCount: tableNodes.length,
      trCount: trNodes.length,
      thCount: thNodes.length
    })
  )

  // THE finding this test exists to check, per the design doc's own literal
  // example ("a paragraph or table split across a page boundary becomes
  // two separate sibling elements in two different page containers"):
  // measured directly here, this ONE logical <table> element, once split
  // across the page boundary Paged.js introduced, becomes TWO separate
  // top-level /Table StructElems in the tag tree — not one /Table element
  // whose /TR children merely happen to point at two different pages. A
  // screen reader consuming this PDF's structure tree would announce this
  // as two unrelated tables, not one continuous 36-row table.
  expect(
    tableNodes.length,
    "a table split across a page boundary is expected to fragment into 2 separate /Table struct elements (the design doc's predicted failure mode) — if this is now 1, the export pipeline may have improved on this"
  ).toBe(2)

  // All 36 real rows (1 header + 35 data) must still be PRESENT somewhere
  // in the tree — content is duplicated in structure (2 Tables) but not
  // lost or duplicated in substance.
  //
  // Was 62 (against the original 60-row count) as of Task 10 (Gate 6) — a
  // real, intended change from Task 10's `TableContinuationHandler`
  // (src/pagination/break-handlers.ts), which clones the original table's
  // <thead> onto this table's continuation (second-page) fragment, exactly
  // fixing the accessibility gap this test's own comment below used to
  // describe. The extra TR is that repeated header row's own <tr> — genuine
  // intentional duplication of the header specifically (not a data-row
  // duplication bug). Now 37, after the Document Typography sub-project's
  // row-count retune (60 -> 35 rows, see the comment above the fixture's
  // HTML construction) — the formula itself is unchanged: 36 original rows
  // (1 header + 35 data) + 1 repeated header row on the continuation
  // fragment = 37.
  expect(
    trNodes.length,
    'total TR count across both fragments should equal 1 header row + 35 data rows + 1 repeated header row (Task 10)'
  ).toBe(37)

  // Updated by Task 10 (Gate 6) — this now documents the FIX, not the gap.
  // Before Task 10: only ONE header row's worth of TH elements existed in
  // the entire tree (the header was NOT repeated into the second page's
  // Table fragment — no accessible column-header association for the
  // continuation rows). Task 10's `TableContinuationHandler` fixes exactly
  // this for a table that splits across 2 pages (verified here): 8 TH
  // elements (4 columns × 2 fragments), confirming the repeated header row
  // is itself correctly tagged in the structure tree, not just visually
  // present.
  //
  // Not a claim that repeats for EVERY continuation page of every split
  // table — see this task's report/findings-doc entry: for a table
  // spanning 3+ pages, TableContinuationHandler deliberately repeats the
  // header ONLY on the LAST continuation fragment (a real, bounded
  // limitation found and worked around during Task 10 — inserting a
  // populated <thead> into a MIDDLE continuation page reproducibly
  // corrupted that page's own last row's visual position, a genuine
  // Chromium table-layout interaction with Paged.js's mid-row
  // break-completion mechanism, not something safe to ship). This
  // synthetic table splits across exactly 2 pages, so its one continuation
  // fragment is also its LAST one — the case Task 10's handler always
  // fixes.
  expect(
    thNodes.length,
    'the table header row is expected to be repeated into the second (and, for this 2-page split, also LAST) page-fragment Table as of Task 10 — 8 = 4 columns x 2 fragments'
  ).toBe(8)

  // Confirm the two Table fragments really do point at two DIFFERENT
  // pages (the "two different page containers" half of the design doc's
  // framing), not just two structurally-separate-but-same-page elements.
  const firstTableLeafPages = new Set(
    findAll(tableNodes[0].children, 'NonStruct')
      .concat(tableNodes[0].children)
      .map((n) => n.pageRef)
      .filter((p): p is string => !!p)
  )
  const secondTableLeafPages = new Set(
    findAll(tableNodes[1].children, 'NonStruct')
      .concat(tableNodes[1].children)
      .map((n) => n.pageRef)
      .filter((p): p is string => !!p)
  )
  console.log(
    'Gate 4 fragmentation page refs:',
    JSON.stringify({
      firstTablePages: [...firstTableLeafPages],
      secondTablePages: [...secondTableLeafPages]
    })
  )
  expect(
    firstTableLeafPages.size,
    "the first Table fragment's content should all be on one page"
  ).toBe(1)
  expect(
    secondTableLeafPages.size,
    "the second Table fragment's content should all be on one (different) page"
  ).toBe(1)
  expect(
    [...firstTableLeafPages][0],
    'the two Table fragments must point at two DIFFERENT page objects'
  ).not.toBe([...secondTableLeafPages][0])

  await close()
})

test('Gate 4: running header/footer/page-number content is excluded from the tagged structure tree entirely (not tagged as ordinary content)', async () => {
  const { app, close } = await launchIsolatedApp(['.'])
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

  // 45 short body paragraphs — enough to force several real pages so the
  // running header/footer this probe's @page stylesheet generates actually
  // repeats more than once (measured: 2 pages). See
  // src/main/pagination-window.ts's `sendGate4HeaderFooterProbe` and
  // resources/pagination-render/index.ts's 'gate4-header-footer-probe'
  // handler for WHY this probe exists at all. (That comment's premise was
  // corrected by the final whole-branch review: the regular sendDocument()
  // path used to pass an explicitly empty `[]` stylesheet array, but since
  // the Document Typography sub-project it passes a real one containing a
  // real `@page` rule. The conclusion is unchanged, because that rule
  // declares only `size` and `margin` and contains no MARGIN-BOX rules.) So
  // no corpus document, run through the regular path, ever generates any
  // running header/footer/page-number content at all — there is nothing for
  // this criterion to inspect without `@top-center`/`@bottom-center`-style
  // rules reaching Paged.js's Polisher, which is what this probe supplies.
  const paragraphCount = 45
  const bodyHtml = Array.from(
    { length: paragraphCount },
    (_, i) =>
      `<p>Probe paragraph ${i + 1}. Filler text so the header/footer probe spans several real pages.</p>`
  ).join('\n')
  const css = `
    @page {
      size: letter;
      margin: 1in;
      @top-center { content: "PageDown Gate 4 Probe Header"; }
      @bottom-center { content: "Page " counter(page) " of " counter(pages); }
    }
  `

  const evalResult = await app.evaluate(
    async ({ BaseWindow }, { bodyHtml, css }) => {
      const bridge = (
        globalThis as unknown as {
          __pagedownPhase0: {
            createPaginationHarness: typeof import('../src/main/pagination-window').createPaginationHarness
            sendGate4HeaderFooterProbe: typeof import('../src/main/pagination-window').sendGate4HeaderFooterProbe
            exportToPdf: typeof import('../src/export/export-pdf').exportToPdf
          }
        }
      ).__pagedownPhase0
      const win = new BaseWindow({ show: false })
      const harness = await bridge.createPaginationHarness(win)
      const probeResult = await bridge.sendGate4HeaderFooterProbe(harness, bodyHtml, css)
      // The margin-box container Paged.js's page template always creates
      // (chunker.js) — populated here, and only here in this app's whole
      // history, by real @page margin-box rules. Its `.textContent` is checked
      // directly too, as a second, independent confirmation alongside the
      // PDF-side checks below: CSS `content: "..."` on a margin box is
      // GENERATED content (rendered visually, extractable from the printed
      // PDF), not a real DOM text node, so `.textContent` on the live
      // element is expected to read empty even though the header/footer is
      // genuinely visible/printed — the same `::marker`-style DOM-vs-
      // rendered distinction Test 1's own SUBSEQUENCE_ONLY_FILES rely on.
      const marginBoxTextContent = await harness.view.webContents.executeJavaScript(`
        Array.from(document.querySelectorAll('.pagedjs_margin-content')).map(el => el.textContent).filter(t => t && t.trim())
      `)
      const pdf = await bridge.exportToPdf(harness)
      return { probeResult, marginBoxTextContent, pdfBase64: pdf.toString('base64') }
    },
    { bodyHtml, css }
  )

  const { probeResult, marginBoxTextContent, pdfBase64 } = evalResult as {
    probeResult: { pageCount: number }
    marginBoxTextContent: string[]
    pdfBase64: string
  }
  console.log('Gate 4 header/footer probe on-screen pageCount:', probeResult.pageCount)
  expect(
    probeResult.pageCount,
    'probe must span multiple real pages for a repeating header/footer to mean anything'
  ).toBeGreaterThan(1)
  expect(
    marginBoxTextContent,
    '.pagedjs_margin-content .textContent should read empty even though the header/footer IS visually rendered (CSS generated content, not a DOM text node)'
  ).toEqual([])

  const pdfBuffer = Buffer.from(pdfBase64, 'base64')
  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(join(RESULTS_DIR, 'gate4-header-footer-probe-export.pdf'), pdfBuffer)

  // First independent PDF-side confirmation: the header/footer text IS
  // really present in the exported PDF's extractable text (proving the
  // absence check below isn't vacuous — it's not simply that the text
  // never made it into the PDF at all).
  const pdfDoc = await PDFDocument.load(pdfBuffer)
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(pdfBuffer) })
  const pdfjsDoc = await loadingTask.promise
  expect(pdfjsDoc.numPages, 'pdfjs page count should match the on-screen probe pageCount').toBe(
    probeResult.pageCount
  )
  const page1Text = (await (await pdfjsDoc.getPage(1)).getTextContent()).items
    .map((item) => ('str' in item ? item.str : ''))
    .join(' ')
  console.log(
    'Gate 4 probe page 1 extracted text (first 200 chars):',
    JSON.stringify(page1Text.slice(0, 200))
  )
  expect(
    page1Text,
    'the running header text must actually be present in the exported PDF'
  ).toContain('PageDown Gate 4 Probe Header')
  expect(
    page1Text,
    'the page-number footer text must actually be present in the exported PDF'
  ).toContain('Page 1 of')

  // Second independent PDF-side confirmation, via pdf-lib's own raw
  // catalog/struct-tree walk (this task's actual answer to the design
  // doc's "are running headers/footers/page numbers tagged as content
  // rather than as artifacts" question): walk the WHOLE document's struct
  // tree and count how many /P elements exist in total. There are exactly
  // 45 real body paragraphs; if the header/footer text were tagged as
  // ordinary content, it would show up as additional /P (or /Span, /Div,
  // etc.) struct elements beyond those 45 — repeated once per page (2
  // pages x 2 margin boxes = 4 extra elements, if tagged at all).
  const catalog = pdfDoc.catalog
  const structRootRef = catalog.get(PDFName.of('StructTreeRoot'))
  expect(structRootRef, 'the probe export must also produce a real /StructTreeRoot').toBeTruthy()
  const tree = walkStructTree(pdfDoc, structRootRef)
  const tagCounts = countTags(tree)
  console.log('Gate 4 header/footer probe struct tree tag counts:', JSON.stringify(tagCounts))
  expect(
    tagCounts.P,
    `struct tree /P count must equal exactly the ${paragraphCount} real body paragraphs — any more would mean header/footer text leaked into the tagged structure as ordinary content`
  ).toBe(paragraphCount)
  const allTagNames = Object.keys(tagCounts)
  console.log(
    'Gate 4 header/footer probe — all distinct struct roles present:',
    JSON.stringify(allTagNames)
  )

  // The exact /P count above proves no EXTRA struct elements exist, but by
  // itself it doesn't prove which TEXT ended up inside the ones that do
  // exist — a real assertion for that (the comment on an earlier version of
  // this test claimed this check without actually implementing it; fixed
  // here) needs the tag tree's own TEXT, not just its role names.
  // `getTextContent({ includeMarkedContent: true })` interleaves
  // `beginMarkedContent(Props)`/`endMarkedContent` markers with the regular
  // text items in real stream order — confirmed directly (dumped this
  // probe's own page 1 during this fix): the header/footer's two text runs
  // ("PageDown Gate 4 Probe Header", "Page 1 of 2") appear BEFORE any
  // `beginMarkedContent`, and every subsequent text run is nested inside a
  // `beginMarkedContentProps("NonStruct", ...)`/`endMarkedContent` pair.
  // Bucketing every text item by whether it falls inside (`insideTaggedText`
  // — i.e. reachable via the tag tree) or outside (`outsideTaggedText`) any
  // marked-content span gives a real, walked answer to "does the tag tree's
  // own text ever contain the header/footer strings," not just a role-name
  // count or a logged-but-unchecked observation.
  const markedTextContent = await (
    await pdfjsDoc.getPage(1)
  ).getTextContent({ includeMarkedContent: true })
  let markedContentDepth = 0
  let insideTaggedText = ''
  let outsideTaggedText = ''
  for (const item of markedTextContent.items) {
    if ('type' in item) {
      if (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps') {
        markedContentDepth++
      } else if (item.type === 'endMarkedContent') {
        markedContentDepth = Math.max(0, markedContentDepth - 1)
      }
    } else if ('str' in item) {
      if (markedContentDepth > 0) insideTaggedText += item.str
      else outsideTaggedText += item.str
    }
  }
  console.log(
    'Gate 4 probe page 1 marked-content text bucketing:',
    JSON.stringify({
      outsideTaggedText: outsideTaggedText.slice(0, 200),
      insideTaggedTextSample: insideTaggedText.slice(0, 200)
    })
  )
  // Non-vacuousness check: the header/footer text must actually be found
  // OUTSIDE any marked-content span — if this failed, the assertions below
  // (checking it's absent INSIDE) would pass trivially for the wrong reason
  // (the text simply not being anywhere in this walk at all).
  expect(
    outsideTaggedText,
    'the running header text is expected OUTSIDE any marked-content span — if absent here, the "not inside the tag tree" checks below would be vacuous'
  ).toContain('PageDown Gate 4 Probe Header')
  expect(
    outsideTaggedText,
    'the page-number footer text is expected OUTSIDE any marked-content span — if absent here, the "not inside the tag tree" checks below would be vacuous'
  ).toMatch(/Page \d+ of/)
  // THE assertion the comment on an earlier version of this test claimed
  // but never actually implemented: no text found INSIDE a marked-content
  // span (i.e. reachable via the struct tree) mentions the header or the
  // page-number footer pattern.
  expect(
    insideTaggedText,
    'no text inside any marked-content span (i.e. reachable via the tag tree) should mention the running header'
  ).not.toContain('PageDown Gate 4 Probe Header')
  expect(
    insideTaggedText,
    'no text inside any marked-content span (i.e. reachable via the tag tree) should match the page-number footer pattern'
  ).not.toMatch(/Page \d+ of/)

  // Third, independent confirmation at the lowest level available: the raw
  // marked-content operator stream (BDC/EMC-equivalent — pdfjs surfaces
  // these as OPS.beginMarkedContent(Props)/endMarkedContent) for page 1.
  // Measured directly: the header/footer's SHOWTEXT operators are emitted
  // BEFORE any BEGIN marked-content operator at all — i.e. not wrapped in
  // ANY marked-content sequence, not even an explicit /Artifact tag. This
  // is a real, useful, but NOT fully spec-ideal answer: per PDF/UA, ALL
  // content in a tagged PDF should be accounted for as either tagged
  // structure or explicit /Artifact — content with no marked-content
  // wrapper at all is a real conformance gap (most assistive tech will
  // still correctly skip it, similarly to how it would skip an /Artifact,
  // but it is not the fully-conformant construct). Recorded honestly here
  // as "excluded from the tag tree, but not via an explicit /Artifact
  // marker" rather than rounded up to a clean pass.
  const opList = await (await pdfjsDoc.getPage(1)).getOperatorList()
  const OPS = pdfjs.OPS
  let sawFirstMarkedContentBegin = false
  let showTextOpsBeforeFirstBegin = 0
  let sawArtifactTag = false
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i]
    if (fn === OPS.beginMarkedContentProps || fn === OPS.beginMarkedContent) {
      sawFirstMarkedContentBegin = true
      const args = opList.argsArray[i] as unknown[]
      // pdfjs represents the marked-content tag name two different ways
      // depending on which PDF op produced it: `beginMarkedContentProps`
      // (a tag WITH a properties dict, e.g. `/Artifact <</Type
      // /Pagination>> BDC`) normalizes args[0] to a plain string; bare
      // `beginMarkedContent` (a tag with NO properties dict, e.g.
      // `/Artifact BMC`) leaves args[0] as pdfjs's raw Name object instead.
      // Checking only the string form is blind to the second, equally
      // legal encoding — checked both here so this assertion can't be
      // fooled by which op Chromium happens to emit.
      const tag = args[0]
      const tagName = typeof tag === 'string' ? tag : (tag as { name?: string } | undefined)?.name
      if (tagName === 'Artifact') sawArtifactTag = true
    } else if (!sawFirstMarkedContentBegin && (fn === OPS.showText || fn === OPS.showSpacedText)) {
      showTextOpsBeforeFirstBegin++
    }
  }
  console.log(
    'Gate 4 probe page 1 operator-stream check:',
    JSON.stringify({ showTextOpsBeforeFirstBegin, sawArtifactTagAnywhereOnPage: sawArtifactTag })
  )
  expect(
    showTextOpsBeforeFirstBegin,
    'the header/footer text is expected to be drawn via real showText operators BEFORE any marked-content sequence begins (i.e. outside the tag tree entirely) — 0 here would mean this page draws no header/footer text at all, which would make this check vacuous'
  ).toBeGreaterThan(0)
  // The nuance this whole section's comment (and the findings doc's own
  // write-up) most relies on, now actually guarded rather than only logged:
  // header/footer content is excluded from the tag tree, but NOT via an
  // explicit /Artifact marked-content tag — genuinely untagged, not the
  // fully PDF/UA-conformant "everything is either tagged content or
  // explicit Artifact" construct. If a future Electron/Chromium version
  // starts using /Artifact for this (arguably an improvement), this
  // assertion is what will need updating — without it, that change could
  // happen silently with no test noticing.
  expect(
    sawArtifactTag,
    'header/footer content is expected to be drawn with NO explicit /Artifact marked-content tag anywhere on this page (excluded from the tag tree by omission, not via /Artifact) — if this is now true, Chromium may have started using /Artifact for @page margin-box content, which would be worth updating the findings doc over'
  ).toBe(false)

  await close()
})
