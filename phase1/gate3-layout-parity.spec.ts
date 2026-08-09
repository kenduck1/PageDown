import { test, expect, chromium } from '@playwright/test'
import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { markdownToHtml } from '../src/markdown/pipeline'
import { launchIsolatedApp } from '../phase0/electron-launch'
// The shared DEFAULT (no-frontmatter, Letter/portrait/1in) geometry every
// harness-driving gate paginates at, plus the shared default DocumentStyle
// sendDocument now also requires -- see phase0/gate-geometry.ts for why
// they're one shared pair, and why they have to be threaded through
// app.evaluate()'s own single argument rather than referenced from inside
// the callback. Imported across the phase1 -> phase0 boundary exactly like
// launchIsolatedApp directly above it.
import { LETTER_GEOMETRY, DEFAULT_STYLE } from '../phase0/gate-geometry'

// Same mechanical deviations from a hypothetical literal brief sample as
// every other Phase 0/1 gate spec (see phase0/gate1/gate5/gate7's own
// comments for the full reasoning, confirmed empirically in Phase 0 Task
// 3/Gate 5): `__dirname` (not `import.meta.url`), since this file
// transpiles to CommonJS; the `globalThis.__pagedownPhase0` bridge (not a
// dynamic `import()` inside `app.evaluate()`), since that callback runs in
// a bare V8 context with no working dynamic import; `markdownToHtml` IS
// reached via a plain top-level Node import here, like every other gate
// spec's own top-level import of it -- it runs entirely in this file's own
// Node/Playwright-test process, never inside `app.evaluate()`.
//
// --- What this gate actually found before a single comparison ran --------
//
// HISTORICAL, AND NO LONGER TRUE OF THE APP — but still true of, and still
// the reason for, this gate's own fixture. Everything in this section
// describes the pagination render context AS IT WAS during Phase 1. The
// Document Typography sub-project (docs/superpowers/specs/2026-08-06-
// document-typography-design.md) has since given both surfaces one real
// shared typographic system (src/typography/document-typography.css, fed to
// `previewer.preview()` as a real, non-empty stylesheet), and
// phase0/gate10-editor-layout-parity.spec.ts measures the REAL app's parity
// at 0px against it. This gate is a Phase 1 spike record, deliberately
// still measuring the untouched Phase 1 fixture; it is EXPECTED TO KEEP
// FAILING and its assertions are correct as written — see the findings doc
// before changing anything here.
//
// The brief's Step 1 asked to "read resources/pagination-render/index.html
// and index.ts first to find the exact CSS values the pagination context
// uses (font stack, font size, line height, content width)". At the time,
// reading both files start to finish found NO such CSS at all: index.html's
// <style> was nonexistent (only a CSP <meta> tag), and index.ts never set a
// font-family/font-size/line-height rule anywhere, nor injected any
// stylesheet into Paged.js -- `previewer.preview(container, [], root)`
// (the regular render path every corpus document went through) always
// passed an EMPTY stylesheet array. index.ts's own extensive Gate 4
// commentary (Task 9, on the same file) independently confirmed the same
// underlying fact from a different angle. (Both of those files now say the
// opposite; that is the change described above, not a contradiction.)
//
// Rather than guess from that absence, this task actually launched the
// real Electron app (the same `_electron.launch` + `__pagedownPhase0`
// bridge pattern this file uses below) and read back real
// `getComputedStyle()` values from a real render of phase0/corpus/mixed.md
// through the then-unmodified harness. Confirmed empirically, not assumed:
//   - body/every content element: font-family "Times", font-size "16px",
//     line-height "normal" -- Chromium's plain UA defaults. Nothing in
//     the app set any of these anywhere in the pagination render path.
//   - .pagedjs_area (the actual laid-out content box): 624px wide. This
//     IS a real, concrete, replicable number -- and it is what Paged.js's
//     own base.js `:root` custom-property defaults produce
//     (`--pagedjs-width: 8.5in`, `--pagedjs-margin-{top,right,bottom,
//     left}: 1in`, giving 8.5in - 1in - 1in = 6.5in = 624px @ 96dpi),
//     rather than an app-authored design decision, since the app had never
//     passed Paged.js an @page rule of its own. Worth stating precisely,
//     because the branch that later added one briefly got this backwards:
//     base.js ALSO injects `@page { size: letter; margin: 0 }`, but that is
//     the BROWSER PRINT page rule (it stops Chromium adding its own margins
//     around the generated sheets) and does not feed the custom properties
//     above -- `baseStyles` is raw CSS that never goes through atpage.js.
//     The content box was 624 x 864 both before and after that change; the
//     app's own explicit @page rule restates the same geometry, and what
//     actually moved page counts was the typography.
//
// So, AS OF PHASE 1: there was no designed typographic system to replicate,
// only one concrete width value, itself inherited from a library default
// rather than chosen. phase1/fixtures/milkdown-compare.html replicates
// exactly that -- 624px width, zero font CSS of its own -- and its own
// top-of-file comment documents the same finding. This is itself a real
// Phase 1 finding, of the same shape as Task 4/Gate 1's
// frontmatter-destruction result and its broken vitest command: a brief
// assumption ("there is CSS to extract here") that didn't hold once
// actually checked, surfaced here instead of silently working around it by
// inventing a plausible-looking font stack that neither surface used then.
//
// --- Electron vs. plain chromium.launch() (brief Step 2's choice) --------
//
// This file uses BOTH, deliberately, for the two different things being
// compared -- not an either/or:
//
// - The PAGINATION side uses the real `_electron.launch({ args: ['.'] })`
//   + `__pagedownPhase0` bridge, exactly like phase0/gate6-break-
//   quality.spec.ts and phase0/gate9's probe. This is the side where
//   fidelity to the ALREADY-VALIDATED Phase 0 harness matters -- its
//   sandboxed `pagedown-render://` scheme, CSP nonce plumbing, and (per
//   the finding above) complete absence of author CSS are all real,
//   load-bearing facts about what "the pagination context" actually is
//   today. Reimplementing Paged.js's invocation by hand outside Electron
//   would risk silently drifting from what that harness really does --
//   exactly the kind of un-fair comparison this gate exists to avoid.
// - The MILKDOWN side uses plain `chromium.launch()` loading
//   phase1/fixtures/milkdown-compare.html as a local `file://` page. This
//   side has no sandboxed-scheme/CSP/IPC surface to be faithful to at all
//   (Milkdown isn't wired into the real Electron app yet -- that's the
//   whole point of this spike) -- it's a brand new throwaway harness this
//   task builds from scratch, so there's nothing "the real thing" to lose
//   fidelity to by using plain Chromium instead of Electron's bundled one.
//   Per the brief's own reasoning, both are the same underlying Chromium
//   engine (confirmed: this repo's Electron is pinned to Chromium 142 --
//   see build-pagination-render.ts's `target: 'chrome142'` comment -- and
//   @playwright/test's bundled chromium is a recent, close version), so
//   this loses no real fidelity while being materially simpler: no main-
//   process wiring, no bridge, just `page.goto('file://...')`.
//
// milkdown-compare.js (the bundle milkdown-compare.html loads) is built
// here, via esbuild, at test-run time -- gitignored (fixtures/.gitignore),
// never committed, exactly like out/pagination-render/index.js is a build
// artifact of resources/pagination-render/index.ts rather than something
// committed directly.
//
// --- Tolerance (brief Step 2's ask) ---------------------------------------
//
// 1px, per the brief's own starting suggestion. Both surfaces are real
// Chromium layout (Electron's bundled Chromium 142 for the pagination
// side, @playwright/test's bundled Chromium for the Milkdown side) laying
// out byte-identical HTML text under identical UA-default typography and
// an identical 624px content box, so genuine sub-pixel rendering
// differences (different Chromium point-release, different subpixel text
// shaping) are the only class of difference this tolerance is meant to
// absorb -- not real structural/CSS differences. See this file's own
// findings, recorded in the printed comparison table and in
// docs/superpowers/plans/2026-07-28-phase1-findings.md (Gate 3 section),
// for whether that held.

const fixturesDir = join(__dirname, 'fixtures')
const milkdownCompareHtml = join(fixturesDir, 'milkdown-compare.html')
const milkdownCompareEntry = join(fixturesDir, 'milkdown-compare.ts')
const milkdownCompareBundle = join(fixturesDir, 'milkdown-compare.js')

const TOLERANCE_PX = 1

interface BlockMeasurement {
  tag: string
  text: string
  relativeTop: number
}

// Strips a leading YAML frontmatter block before feeding content to
// Milkdown. Deliberate, documented deviation from feeding Milkdown the
// exact same raw corpus file bytes: Task 4/Gate 1 ALREADY found (and
// pinned as a committed finding) that bare commonmark+gfm Milkdown
// completely destroys YAML frontmatter -- re-triggering that same,
// already-characterized failure here would contaminate THIS gate's
// layout-parity measurement with a different gate's already-known result,
// rather than actually testing block layout. The PAGINATION side does not
// need this stripping: markdownToHtml (src/markdown/pipeline.ts) already
// consumes and drops the frontmatter block itself before rehype-stringify
// -- confirmed by running it against phase0/corpus/mixed.md directly, its
// HTML output contains no frontmatter trace at all -- so both surfaces end
// up rendering the identical BODY content either way; this just avoids
// asking Milkdown to parse bytes it's already known to mishandle for an
// unrelated reason.
function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
}

test('Gate 3: editor/paginator layout parity for mixed.md top-level blocks', async () => {
  test.setTimeout(60_000)

  const rawMarkdown = readFileSync(join(__dirname, '..', 'phase0', 'corpus', 'mixed.md'), 'utf8')
  const bodyMarkdown = stripFrontmatter(rawMarkdown)

  // --- Build the Milkdown comparison bundle -------------------------------
  mkdirSync(fixturesDir, { recursive: true })
  await build({
    entryPoints: [milkdownCompareEntry],
    outfile: milkdownCompareBundle,
    bundle: true,
    format: 'iife', // not `type="module"` -- see this file's header comment on why
    platform: 'browser',
    target: 'chrome142', // matches this repo's pinned Electron/Chromium version
    sourcemap: false,
    minify: false,
    logLevel: 'warning'
  })

  // --- Pagination side: real Electron app, real harness -------------------
  const { app, close } = await launchIsolatedApp(['.'])

  await app.evaluate(async ({ BaseWindow }) => {
    const bridge = (
      globalThis as unknown as {
        __pagedownPhase0: {
          createPaginationHarness: typeof import('../src/main/pagination-window').createPaginationHarness
        }
      }
    ).__pagedownPhase0
    const win = new BaseWindow({ show: false })
    ;(globalThis as unknown as { __gate3Harness: unknown }).__gate3Harness =
      await bridge.createPaginationHarness(win)
    return true
  })

  const { html } = markdownToHtml(rawMarkdown)

  const paginationResult = (await app.evaluate(
    async (_electronNS, { html, geometry, documentStyle }) => {
      const harness = (
        globalThis as unknown as {
          __gate3Harness: import('../src/main/pagination-window').PaginationHarness
        }
      ).__gate3Harness
      const sendResult = await harness.sendDocument(html, geometry, documentStyle)

      // `.pagedjs_area` is the real, on-screen laid-out content box (see this
      // file's header comment for why its 624px width is what it is) --
      // measuring every top-level block's rect.top relative to ITS top
      // (rather than an absolute screen coordinate) is what makes this
      // comparable to the Milkdown side at all: the two pages have no reason
      // to share an absolute on-screen origin (different window chrome,
      // different body margins -- see below), only a shared content-flow
      // start point makes sense to diff.
      const raw = (await harness.view.webContents.executeJavaScript(`
      (function () {
        var area = document.querySelector('.pagedjs_area')
        if (!area) return JSON.stringify({ error: 'no .pagedjs_area found' })
        var areaTop = area.getBoundingClientRect().top
        var blocks = Array.prototype.slice.call(area.querySelectorAll(':scope > .pagedjs_page_content > div > *'))
        var out = blocks.map(function (el) {
          var r = el.getBoundingClientRect()
          return { tag: el.tagName, text: String(el.textContent || '').trim().slice(0, 50), relativeTop: r.top - areaTop }
        })
        return JSON.stringify(out)
      })()
    `)) as string

      return { sendResult, blocks: JSON.parse(raw) as BlockMeasurement[] }
    },
    { html, geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
  )) as { sendResult: { pageCount: number }; blocks: BlockMeasurement[] }

  await close()

  expect(
    paginationResult.sendResult.pageCount,
    'mixed.md is expected to fit on a single page at the harness default Letter/1in-margin geometry -- a multi-page result would mean blocks landed on different pages, invalidating a single flat top-level comparison'
  ).toBe(1)
  expect(paginationResult.blocks.length, 'expected the 8 known top-level blocks in mixed.md').toBe(
    8
  )

  // --- Milkdown side: plain chromium, throwaway local HTML fixture -------
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.addInitScript((markdown) => {
    ;(window as unknown as { __gate3Markdown: string }).__gate3Markdown = markdown
  }, bodyMarkdown)
  await page.goto(`file://${milkdownCompareHtml}`)
  await page.waitForFunction(
    () =>
      (window as unknown as { __gate3Ready?: boolean; __gate3Error?: string }).__gate3Ready ===
        true || Boolean((window as unknown as { __gate3Error?: string }).__gate3Error)
  )
  const mountError = await page.evaluate(
    () => (window as unknown as { __gate3Error?: string }).__gate3Error
  )
  expect(mountError, 'Milkdown editor failed to mount in the comparison page').toBeUndefined()

  // Two animation-frame ticks after Editor.create() resolves, for the same
  // reason this repo's other gates settle before measuring: ProseMirror's
  // own initial paint is not guaranteed complete the instant `.create()`'s
  // promise resolves, and this gate cares about real, final layout.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )

  const milkdownRaw = await page.evaluate(() => {
    // Not a direct child of #content-root: Milkdown wraps its own
    // contenteditable .ProseMirror element inside an intermediate
    // `<div class="milkdown">` wrapper it creates itself -- confirmed by
    // dumping the real mounted DOM (`<div id="content-root"><div
    // class="milkdown"><div class="ProseMirror editor" ...>`), not assumed
    // from the DOM shape Editor.make()/rootCtx's own types imply. This
    // wrapper is itself one concrete instance of the "Milkdown node-view
    // chrome" this gate's brief anticipated as a possible source of
    // mismatch -- a bare, unstyled <div> has no default margin/padding/
    // border, so per CSS box-model rules it should not shift any measured
    // block position, but this gate measures rather than assumes that. See
    // this file's header, and docs/superpowers/plans/
    // 2026-07-28-phase1-findings.md (Gate 3 section), for the measured
    // answer.
    const editorRoot = document.querySelector('#content-root .ProseMirror')
    if (!editorRoot) return JSON.stringify({ error: 'no .ProseMirror element found' })
    const rootTop = editorRoot.getBoundingClientRect().top
    const rootWidth = editorRoot.getBoundingClientRect().width
    const blocks = Array.from(editorRoot.children).map((el) => {
      const r = el.getBoundingClientRect()
      return {
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 50),
        relativeTop: r.top - rootTop
      }
    })
    return JSON.stringify({ rootWidth, blocks })
  })
  const milkdownParsed = JSON.parse(milkdownRaw) as {
    rootWidth: number
    blocks: BlockMeasurement[]
  }

  await browser.close()

  // Structural sanity check before any position comparison is meaningful:
  // the Milkdown-mounted content box must actually BE 624px wide (the same
  // content box width the pagination side measured) for a "same width,
  // does text wrap/flow the same way" comparison to mean anything at all.
  expect(
    milkdownParsed.rootWidth,
    '.ProseMirror content box must render at the same 624px width as .pagedjs_area for this to be a fair comparison'
  ).toBe(624)

  // --- The actual per-block comparison, recorded in full ------------------
  const rows = paginationResult.blocks.map((pagBlock, i) => {
    const mdBlock = milkdownParsed.blocks[i]
    const tagsMatch = mdBlock ? pagBlock.tag === mdBlock.tag : false
    const delta = mdBlock ? Math.abs(pagBlock.relativeTop - mdBlock.relativeTop) : null
    const withinTolerance = delta !== null && delta <= TOLERANCE_PX
    return {
      index: i,
      paginationTag: pagBlock.tag,
      paginationText: pagBlock.text,
      paginationTop: Number(pagBlock.relativeTop.toFixed(3)),
      milkdownTag: mdBlock?.tag ?? '(missing)',
      milkdownText: mdBlock?.text ?? '(missing)',
      milkdownTop: mdBlock ? Number(mdBlock.relativeTop.toFixed(3)) : null,
      deltaPx: delta !== null ? Number(delta.toFixed(3)) : null,
      tagsMatch,
      withinTolerance
    }
  })

  // This table IS the recorded finding this gate exists to produce; see
  // docs/superpowers/plans/2026-07-28-phase1-findings.md (Gate 3 section)
  // for the committed copy of a real run's output.
  console.log('\nGate 3 per-block layout comparison (tolerance: ' + TOLERANCE_PX + 'px):')
  console.table(rows)

  const mismatches = rows.filter((r) => !r.tagsMatch || !r.withinTolerance)
  if (mismatches.length > 0) {
    console.log(
      `\n${mismatches.length}/${rows.length} block(s) mismatched -- see ` +
        `docs/superpowers/plans/2026-07-28-phase1-findings.md (Gate 3 section) ` +
        `for the per-block hypothesis of why.`
    )
  }

  expect(
    milkdownParsed.blocks.length,
    "Milkdown should mount the same 8 top-level blocks mixed.md's body produces via markdownToHtml"
  ).toBe(paginationResult.blocks.length)

  for (const row of rows) {
    expect(
      row.tagsMatch,
      `block ${row.index}: expected matching tag names (pagination=${row.paginationTag}, milkdown=${row.milkdownTag})`
    ).toBe(true)
  }

  // This is the gate's real question -- left as a genuine assertion, not
  // downgraded to a soft log, so a real regression (or a real finding of
  // non-parity) fails the test rather than passing silently. If this
  // fails, that IS the valuable finding this gate exists to produce -- see
  // docs/superpowers/plans/2026-07-28-phase1-findings.md (Gate 3 section)
  // for the interpretation, not a tolerance widened after the fact to make
  // it pass.
  for (const row of rows) {
    expect(
      row.deltaPx,
      `block ${row.index} (${row.paginationTag} "${row.paginationText}"): pagination top=${row.paginationTop}px, milkdown top=${row.milkdownTop}px`
    ).toBeLessThanOrEqual(TOLERANCE_PX)
  }
})
