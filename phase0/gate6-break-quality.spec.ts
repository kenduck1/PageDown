import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { markdownToHtml } from '../src/markdown/pipeline'
import { launchIsolatedApp } from './electron-launch'
// The shared DEFAULT (no-frontmatter, Letter/portrait/1in) geometry every
// harness-driving gate paginates at, plus the shared default DocumentStyle
// sendDocument now also requires -- see gate-geometry.ts for why they're one
// shared pair, and why they have to be threaded through app.evaluate()'s
// own single argument rather than referenced from inside the callback.
import { LETTER_GEOMETRY, DEFAULT_STYLE } from './gate-geometry'

// Same mechanical deviations from a hypothetical literal brief sample as
// every other Phase 0 gate spec (see gate1/gate2/gate5/gate7's own
// comments for the full reasoning, confirmed empirically in Task 3/Gate 5):
// `__dirname` (not `import.meta.url`) for corpus/results paths, since this
// file transpiles to CommonJS; and the `globalThis.__pagedownPhase0` bridge
// (not a dynamic `import()` inside `app.evaluate()`), since that callback
// runs in a bare V8 context with no working dynamic import. `markdownToHtml`
// IS reached via a plain top-level Node import here, like every other gate
// spec's own top-level `markdownToHtml` import — it runs entirely in this
// file's own Node/Playwright-test process, not inside `app.evaluate()`.
//
// See src/pagination/break-handlers.ts for the Handler-API investigation
// and the KeepWithNextHandler/TableContinuationHandler implementations this
// gate exercises, and docs/superpowers/plans/2026-07-25-phase0-findings.md's
// Gate 6 section for the full writeup of what these tests found.
//
// A real, load-bearing finding this whole file is built around, not
// assumed going in: THREE of the four brief-named "break-quality-relevant"
// corpus fixtures — tables-spanning-pages.md, headings-near-page-bottom.md,
// nested-lists.md — used to measure to exactly ONE page under this
// harness's original, completely unstyled rendering (Chromium UA defaults,
// no author CSS at all), meaning none of them exercised the page-break
// scenario they were written to test (matching the SAME finding Task
// 9/Gate 4 already made specifically for tables-spanning-pages.md — see
// that gate's own "Split-block fragmentation" section). Only
// mermaid-diagrams.md (5-6 pages) naturally spanned multiple pages.
//
// The Document Typography sub-project is exactly the "future
// page-box/margin/font change" this file's own pinned-count comment
// (directly above Test 1's four page-count assertions below) always said
// would eventually need this updating: tables-spanning-pages.md now
// genuinely splits (1 -> 2 pages) — see that comment for the full
// before/after and why the other three fixtures' pinned counts did NOT
// move. Note WHICH half of that sub-project actually moved it, corrected by
// the final whole-branch review after this file first credited the wrong
// one: the explicit `@page` rule it added (8.5in x 11in, 1in margins) is
// geometrically a NO-OP, because Paged.js's `base.js` already defaults
// `--pagedjs-margin-*` to 1in and this harness's content box has been
// 624 x 864 px all along. The counts moved because of the shared document
// TYPOGRAPHY: 14px/1.7 body text against the UA's 16px/`normal`, a 1.15
// heading line-height, and 0.4em 0.6em table cell padding. As of this
// branch it's TWO of the four (headings-near-page-bottom.md and
// nested-lists.md) that still measure to exactly ONE page;
// tables-spanning-pages.md has joined mermaid-diagrams.md as a fixture
// that naturally spans pages. Following Gate 4's own
// established precedent for exactly this situation (its synthetic long
// table), this file renders the four PINNED corpus fixtures for the
// record (Test 1, matching the brief's literal ask) AND builds synthetic,
// deliberately-page-spanning content for the handlers that the pinned
// fixtures can't actually exercise (Tests 3-4) — without that, this gate
// could not honestly claim to have observed anything about table/list
// break behavior at all.

const fixtures = [
  'tables-spanning-pages.md',
  'headings-near-page-bottom.md',
  'mermaid-diagrams.md',
  'nested-lists.md'
]

interface PerPageHeadingInfo {
  tag: string
  text: string
  breakAfterAvoid: boolean
}

interface FixtureObservation {
  pageCount: number
  perPageHeadings: PerPageHeadingInfo[][]
  tableCount: number
  splitTableCount: number
  orderedListCount: number
  diagramBoxes: Array<{ id: string; width: number; height: number }>
}

test('Gate 6: render every break-quality fixture and capture per-page structure for manual review', async () => {
  test.setTimeout(60_000)
  const { app, close } = await launchIsolatedApp(['.'])

  const observations: Record<string, FixtureObservation> = {}

  await app.evaluate(async ({ BaseWindow }) => {
    const bridge = (
      globalThis as unknown as {
        __pagedownPhase0: {
          createPaginationHarness: typeof import('../src/main/pagination-window').createPaginationHarness
        }
      }
    ).__pagedownPhase0
    const win = new BaseWindow({ show: false })
    ;(globalThis as unknown as { __gate6Harness: unknown }).__gate6Harness =
      await bridge.createPaginationHarness(win)
    return true
  })

  for (const file of fixtures) {
    const markdown = readFileSync(join(__dirname, 'corpus', file), 'utf8')
    const { html } = markdownToHtml(markdown)

    const result = (await app.evaluate(
      async (_electronNS, { html, geometry, documentStyle }) => {
        const harness = (
          globalThis as unknown as {
            __gate6Harness: import('../src/main/pagination-window').PaginationHarness
          }
        ).__gate6Harness
        const sendResult = await harness.sendDocument(html, geometry, documentStyle)

        const perPageHeadings = await harness.view.webContents.executeJavaScript(`
        Array.from(document.querySelectorAll('.pagedjs_page')).map((page) =>
          Array.from(page.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) => ({
            tag: h.tagName,
            text: (h.textContent || '').trim(),
            breakAfterAvoid: h.dataset.breakAfter === 'avoid'
          }))
        )
      `)
        const tableCount = await harness.view.webContents.executeJavaScript(
          `document.querySelectorAll('table').length`
        )
        const splitTableCount = await harness.view.webContents.executeJavaScript(
          `document.querySelectorAll('table[data-split-from]').length`
        )
        const orderedListCount = await harness.view.webContents.executeJavaScript(
          `document.querySelectorAll('ol').length`
        )

        return {
          pageCount: sendResult.pageCount,
          perPageHeadings,
          tableCount,
          splitTableCount,
          orderedListCount,
          diagramBoxes: sendResult.diagramBoxes
        }
      },
      { html, geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
    )) as FixtureObservation

    observations[file] = result
  }

  mkdirSync(join(__dirname, 'results'), { recursive: true })
  writeFileSync(
    join(__dirname, 'results', 'gate6-observations.json'),
    JSON.stringify(observations, null, 2)
  )

  console.log('Gate 6 observations:', JSON.stringify(observations, null, 2))

  // The load-bearing finding described in this file's top comment, made
  // into a durable, checked regression guard rather than left only as
  // prose. Originally: exactly 3 of the 4 pinned fixtures never spanned a
  // page boundary under this harness's original, completely unstyled
  // rendering. This comment always anticipated its own obsolescence: "If a
  // future page-box/margin/font change ever makes one of these actually
  // split, that's a genuinely interesting event for this gate ... this
  // assertion is what would need updating the day that happens, rather
  // than the file silently going stale."
  //
  // That day arrived with the Document Typography sub-project, which gave
  // the sandboxed render context real author CSS for the first time.
  // Measured directly (not assumed): only tables-spanning-pages.md's pinned
  // count actually moved, from 1 page to 2 (updated below, per this
  // comment's own instructions). headings-near-page-bottom.md and
  // nested-lists.md still measure to exactly 1 page — their assertions are
  // unchanged. mermaid-diagrams.md's pinned count also did NOT move
  // (still 6 pages, unchanged from Task 10's KeepWithNextHandler
  // baseline) — worth calling out
  // explicitly because that fixture has a documented relationship to Gate
  // 3's own `oversizedWrapperCount` comment (phase0/gate3-mermaid.spec.ts)
  // and to Task 10's KeepWithNextHandler; if its count HAD moved, both of
  // those would need a fresh look, but since it didn't, neither does.
  //
  // ATTRIBUTION CORRECTED by the final whole-branch review: this used to
  // credit the sub-project's explicit `@page` rule (8.5in x 11in, 1in
  // margins) for the move, on the belief that it replaced a zero-margin
  // Paged.js default. It did not — `base.js` already defaults
  // `--pagedjs-margin-*` to 1in, so the content box was 624 x 864 px both
  // before and after, and the authored `@page` rule restates exactly that.
  // The mover is the shared document TYPOGRAPHY (14px/1.7 body text against
  // the UA's 16px/`normal`, 1.15 heading line-height, 0.4em 0.6em table
  // cell padding). The pinned numbers below are unaffected by that
  // correction — they are measured values, and only their stated cause was
  // wrong.
  expect(
    observations['tables-spanning-pages.md'].pageCount,
    "tables-spanning-pages.md now DOES naturally split at this harness's Letter/1in-margin page box — was 1 page before this branch's shared document typography, is 2 pages after (the page box itself is unchanged; see this test's comment above). Table-continuation behavior (header repeat, struct-tree fragmentation counts) is still verified separately below via a synthetic table — this pinned-fixture check only confirms the split itself now occurs, not the handler's specific repair behavior"
  ).toBe(2)
  expect(
    observations['headings-near-page-bottom.md'].pageCount,
    "headings-near-page-bottom.md does not naturally reach a second page at this harness's current (post-Document-Typography) page box — keep-with-next is verified separately below via mermaid-diagrams.md, the one fixture that does span pages"
  ).toBe(1)
  expect(
    observations['nested-lists.md'].pageCount,
    "nested-lists.md does not naturally split at this harness's current (post-Document-Typography) page box — numbering continuity is verified separately below via a synthetic long nested list"
  ).toBe(1)
  expect(
    observations['mermaid-diagrams.md'].pageCount,
    "mermaid-diagrams.md is the one fixture that DOES span multiple pages (see Task 8/Gate 3 and this gate's own keep-with-next test below) — still 6 pages after the Document Typography sub-project's shared typography, unchanged from Task 10's KeepWithNextHandler baseline (was 5 before THAT; see phase0/gate3-mermaid.spec.ts's updated oversizedWrapperCount comment for why)"
  ).toBe(6)

  await close()
})

test('Gate 6: KeepWithNextHandler prevents a stranded heading in mermaid-diagrams.md, the one fixture that spans pages', async () => {
  test.setTimeout(60_000)
  const { app, close } = await launchIsolatedApp(['.'])

  const markdown = readFileSync(join(__dirname, 'corpus', 'mermaid-diagrams.md'), 'utf8')
  const { html } = markdownToHtml(markdown)

  const result = await app.evaluate(
    async ({ BaseWindow }, { html, geometry, documentStyle }) => {
      const bridge = (
        globalThis as unknown as {
          __pagedownPhase0: {
            createPaginationHarness: typeof import('../src/main/pagination-window').createPaginationHarness
          }
        }
      ).__pagedownPhase0
      const win = new BaseWindow({ show: false })
      const harness = await bridge.createPaginationHarness(win)
      await harness.sendDocument(html, geometry, documentStyle)

      // For every H1 heading and every mermaid-diagram wrapper in the
      // paginated output (in document order), record which `.pagedjs_page`
      // index it landed on. A heading is "stranded" (the exact bug
      // KeepWithNextHandler exists to fix) if the very next content element
      // after it in the paginated output starts on a LATER page than the
      // heading itself.
      return await harness.view.webContents.executeJavaScript(`
      (() => {
        const pages = Array.from(document.querySelectorAll('.pagedjs_page'))
        const items = Array.from(document.querySelectorAll('h1, .pagedown-mermaid-diagram'))
          .map((el) => {
            const pageIndex = pages.findIndex((p) => p.contains(el))
            return {
              kind: el.tagName === 'H1' ? 'heading' : 'diagram',
              text: el.tagName === 'H1' ? el.textContent.trim() : el.getAttribute('data-mermaid-diagram-id'),
              pageIndex
            }
          })
        return items
      })()
    `)
    },
    { html, geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
  )

  console.log('Gate 6 heading/diagram page placement:', JSON.stringify(result, null, 2))

  interface Item {
    kind: 'heading' | 'diagram'
    text: string
    pageIndex: number
  }
  const items = result as Item[]

  // Every H1 in this fixture is immediately followed (in document order)
  // by exactly one diagram wrapper — confirmed by the fixture's own
  // structure (phase0/corpus/mermaid-diagrams.md: three "# <Title>" H1s,
  // each followed by one ```mermaid block, nothing else). For each
  // heading, the item immediately after it in `items` (built from a single
  // querySelectorAll('h1, .pagedown-mermaid-diagram') over the whole
  // document, so document order is preserved) must be its diagram, and
  // that diagram's FIRST page-clone instance must start on the SAME page
  // as the heading — not a later one.
  const headingCount = items.filter((i) => i.kind === 'heading').length
  expect(
    headingCount,
    'mermaid-diagrams.md must have exactly 3 H1 headings for this check to mean anything'
  ).toBe(3)

  let strandedCount = 0
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind !== 'heading') continue
    const next = items[i + 1]
    expect(
      next,
      `heading "${items[i].text}" must be immediately followed by a diagram in document order`
    ).toBeTruthy()
    expect(
      next.kind,
      `heading "${items[i].text}" must be immediately followed by a diagram, not another heading`
    ).toBe('diagram')
    if (next.pageIndex !== items[i].pageIndex) {
      strandedCount++
      console.log(
        `STRANDED: heading "${items[i].text}" on page ${items[i].pageIndex}, its diagram starts on page ${next.pageIndex}`
      )
    }
  }

  // THE assertion this test exists to make: zero stranded headings. Before
  // Task 10's KeepWithNextHandler, this same check (run against the
  // unmodified render context, see this task's report) found exactly 2
  // stranded headings in this fixture — "Larger Sequence Diagram" (H1
  // ending page 0, its diagram starting page 1) and "Oversized Diagram"
  // (H1 ending page 1, its diagram starting page 2) — a real, reproducible
  // instance of the exact bug the design doc names. With the handler
  // active, both are fixed: every heading now starts the same page as its
  // diagram.
  expect(
    strandedCount,
    'no heading should be stranded on a different page than the content immediately following it'
  ).toBe(0)

  await close()
})

test('Gate 6: TableContinuationHandler repeats the header on a simple 2-page split, with no clipping or row misplacement', async () => {
  test.setTimeout(60_000)
  const { app, close } = await launchIsolatedApp(['.'])

  // Same synthetic-table shape as Task 9/Gate 4's own split-block
  // fragmentation test (phase0/gate4-export.spec.ts) — 35 rows forces a
  // real 2-page split at this harness's Letter/1in-margin default, and
  // reusing the identical shape keeps this test's result directly
  // comparable to that gate's own struct-tree TH/TR counts (8/37 — see
  // that file's own comments).
  //
  // Re-tuned from 60 to 35 rows by the Document Typography sub-project,
  // for the same reason and against the same measured boundaries as Gate
  // 4's identical fixture: the sandboxed render context's new real author
  // CSS grew per-row height (14px/1.7 body text replacing the UA's
  // 16px/`normal`, plus 0.4em 0.6em cell padding), so the old 60-row count
  // now overflows to 3 pages instead of 2 (measured: 21 rows -> 1 page,
  // 22-45 rows -> 2 pages, 46+ rows -> 3 pages). The content box itself did
  // NOT change — see this file's top comment for the corrected attribution.
  // This count is geometry- and typography-sensitive: any future change to
  // page size, margins, or document typography will likely require
  // re-measuring and re-tuning it again.
  const rows = Array.from(
    { length: 35 },
    (_, i) =>
      `<tr><td>Row ${i + 1}</td><td>Category ${i % 5}</td><td>Some description text for row ${i + 1}</td><td>$${(i * 12.34).toFixed(2)}</td></tr>`
  ).join('\n')
  const html = `<h1>Synthetic Long Table</h1><table><thead><tr><th>Row</th><th>Category</th><th>Description</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>`

  const result = await app.evaluate(
    async ({ BaseWindow }, { html, geometry, documentStyle }) => {
      const bridge = (
        globalThis as unknown as {
          __pagedownPhase0: {
            createPaginationHarness: typeof import('../src/main/pagination-window').createPaginationHarness
          }
        }
      ).__pagedownPhase0
      const win = new BaseWindow({ show: false })
      const harness = await bridge.createPaginationHarness(win)
      const sendResult = await harness.sendDocument(html, geometry, documentStyle)

      const perPage = await harness.view.webContents.executeJavaScript(`
      Array.from(document.querySelectorAll('.pagedjs_page')).map((page) => {
        const area = page.querySelector('.pagedjs_page_content') || page.querySelector('.pagedjs_area')
        const areaRect = area ? area.getBoundingClientRect() : null
        const table = page.querySelector('table')
        const rows = table ? Array.from(table.querySelectorAll('tr')) : []
        const thead = table ? table.querySelector('thead') : null
        // Rows must appear in strictly (non-decreasing) top-to-bottom
        // visual order matching their DOM order -- the direct structural
        // signature of the row-misplacement bug this task found and
        // worked around (see src/pagination/break-handlers.ts's own
        // comment on TableContinuationHandler).
        let monotonic = true
        let prevTop = -Infinity
        for (const r of rows) {
          const top = r.getBoundingClientRect().top
          if (top < prevTop - 0.5) { monotonic = false; break }
          prevTop = top
        }
        const lastRow = rows[rows.length - 1]
        const lastRowRect = lastRow ? lastRow.getBoundingClientRect() : null
        return {
          hasThead: !!thead,
          isRepeatedHeader: !!(thead && thead.classList.contains('pagedown-continuation-header')),
          rowCount: rows.length,
          monotonic,
          lastRowClipped: lastRowRect && areaRect ? lastRowRect.bottom > areaRect.bottom + 0.5 : false
        }
      })
    `)
      return { pageCount: sendResult.pageCount, perPage }
    },
    { html, geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
  )

  console.log('Gate 6 35-row table result:', JSON.stringify(result, null, 2))

  interface PageInfo {
    hasThead: boolean
    isRepeatedHeader: boolean
    rowCount: number
    monotonic: boolean
    lastRowClipped: boolean
  }
  const perPage = result.perPage as PageInfo[]

  expect(
    result.pageCount,
    'the 35-row table must actually split across pages for this check to mean anything'
  ).toBe(2)
  expect(perPage[0].hasThead, 'page 1 keeps its original header').toBe(true)
  expect(perPage[0].isRepeatedHeader, "page 1's header is the ORIGINAL, not a repeated clone").toBe(
    false
  )
  // THE assertion this test exists to make: the continuation page gets a
  // repeated header.
  expect(perPage[1].hasThead, 'page 2 (the continuation) must have a header row').toBe(true)
  expect(
    perPage[1].isRepeatedHeader,
    "page 2's header must be the handler-inserted repeated one"
  ).toBe(true)

  // No clipping, no misplacement, on EITHER page.
  for (let i = 0; i < perPage.length; i++) {
    expect(
      perPage[i].monotonic,
      `page ${i + 1}: every row must render in DOM order top-to-bottom (no misplacement)`
    ).toBe(true)
    expect(
      perPage[i].lastRowClipped,
      `page ${i + 1}: the last row must not be clipped past the page's content box`
    ).toBe(false)
  }

  // All 35 data rows + 1 original header + 1 repeated header = 37 <tr>
  // elements total, split 22/15 across the two pages (measured, matches
  // this harness's current Letter/1in-margin page-box default post-Document-
  // Typography) — confirms no row was lost or duplicated beyond the one
  // intentional header repeat.
  const totalRows = perPage.reduce((sum, p) => sum + p.rowCount, 0)
  expect(totalRows, '35 data rows + 1 original header + 1 repeated header').toBe(37)

  await close()
})

test('Gate 6: TableContinuationHandler on a 3+ page split only repeats the header on the LAST fragment, and never misplaces a row', async () => {
  test.setTimeout(60_000)
  const { app, close } = await launchIsolatedApp(['.'])

  // 150 rows forces a real multi-page split (7 pages, measured, at this
  // harness's Letter/1in-margin page box with the shared document
  // typography applied — was 5 pages before that sub-project's real author
  // CSS, which grew per-row height without changing the page box; the
  // exact count isn't pinned here, only asserted >= 4 below, since this
  // test only needs a genuine MIDDLE continuation page to exist) —
  // deliberately larger than Gate 4's 35-row/2-page fixture so this
  // test can actually exercise a MIDDLE continuation page, which a 2-page
  // split never has. This is the specific scenario Task 10's investigation
  // found breaks Chromium's table layout if a populated <thead> is
  // inserted onto it after the fact (see src/pagination/
  // break-handlers.ts's TableContinuationHandler comment) — this test is
  // the durable regression guard for the fix (repeat the header ONLY on
  // the table's last continuation fragment), not just a one-time
  // observation.
  const rows = Array.from(
    { length: 150 },
    (_, i) =>
      `<tr><td>Row ${i + 1}</td><td>Category ${i % 5}</td><td>Some description text for row ${i + 1}</td><td>$${(i * 12.34).toFixed(2)}</td></tr>`
  ).join('\n')
  const html = `<h1>Synthetic Long Table</h1><table><thead><tr><th>Row</th><th>Category</th><th>Description</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>`

  const result = await app.evaluate(
    async ({ BaseWindow }, { html, geometry, documentStyle }) => {
      const bridge = (
        globalThis as unknown as {
          __pagedownPhase0: {
            createPaginationHarness: typeof import('../src/main/pagination-window').createPaginationHarness
          }
        }
      ).__pagedownPhase0
      const win = new BaseWindow({ show: false })
      const harness = await bridge.createPaginationHarness(win)
      const sendResult = await harness.sendDocument(html, geometry, documentStyle)

      const perPage = await harness.view.webContents.executeJavaScript(`
      Array.from(document.querySelectorAll('.pagedjs_page')).map((page) => {
        const area = page.querySelector('.pagedjs_page_content') || page.querySelector('.pagedjs_area')
        const areaRect = area ? area.getBoundingClientRect() : null
        const table = page.querySelector('table')
        const rows = table ? Array.from(table.querySelectorAll('tr')) : []
        const thead = table ? table.querySelector('thead') : null
        let monotonic = true
        let prevTop = -Infinity
        for (const r of rows) {
          const top = r.getBoundingClientRect().top
          if (top < prevTop - 0.5) { monotonic = false; break }
          prevTop = top
        }
        const lastRow = rows[rows.length - 1]
        const lastRowRect = lastRow ? lastRow.getBoundingClientRect() : null
        return {
          hasThead: !!thead,
          isRepeatedHeader: !!(thead && thead.classList.contains('pagedown-continuation-header')),
          rowCount: rows.length,
          monotonic,
          lastRowClipped: lastRowRect && areaRect ? lastRowRect.bottom > areaRect.bottom + 0.5 : false
        }
      })
    `)
      return { pageCount: sendResult.pageCount, perPage }
    },
    { html, geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
  )

  console.log('Gate 6 150-row table result:', JSON.stringify(result, null, 2))

  interface PageInfo {
    hasThead: boolean
    isRepeatedHeader: boolean
    rowCount: number
    monotonic: boolean
    lastRowClipped: boolean
  }
  const perPage = result.perPage as PageInfo[]

  expect(
    result.pageCount,
    'the 150-row table must split across at least 4 pages (1 original + at least 2 middle + 1 last) for this check to mean anything'
  ).toBeGreaterThanOrEqual(4)

  // Page 1 (index 0): original header, not repeated.
  expect(perPage[0].isRepeatedHeader).toBe(false)
  expect(perPage[0].hasThead).toBe(true)

  // Every MIDDLE continuation page (index 1 .. length-2): per this task's
  // own investigation, deliberately NOT given a repeated header — this is
  // the bounded, honest limitation of the fix (see break-handlers.ts's own
  // comment): inserting one here is exactly what reproduced the row-
  // misplacement bug. Left exactly as broken/unfixed as before Task 10 for
  // these specific pages, never worse.
  for (let i = 1; i < perPage.length - 1; i++) {
    expect(
      perPage[i].isRepeatedHeader,
      `page ${i + 1} (a MIDDLE continuation) must NOT get a repeated header`
    ).toBe(false)
  }

  // The LAST page: this IS where the fix applies.
  const lastIndex = perPage.length - 1
  expect(
    perPage[lastIndex].isRepeatedHeader,
    'the LAST continuation page must get the repeated header'
  ).toBe(true)

  // THE core safety property this whole refined design exists for: no
  // page, anywhere, ever shows rows out of visual order or a clipped last
  // row -- confirmed across every page, not just the one the header was
  // inserted into.
  for (let i = 0; i < perPage.length; i++) {
    expect(
      perPage[i].monotonic,
      `page ${i + 1}: every row must render in DOM order top-to-bottom (no misplacement)`
    ).toBe(true)
    expect(
      perPage[i].lastRowClipped,
      `page ${i + 1}: the last row must not be clipped past the page's content box`
    ).toBe(false)
  }

  await close()
})

test("Gate 6: nested ordered list numbering (Paged.js's own built-in Lists handler) stays correct across a real page split, including mid-item", async () => {
  test.setTimeout(60_000)
  const { app, close } = await launchIsolatedApp(['.'])

  // Not a custom Task 10 handler -- Paged.js's own built-in `Lists` module
  // (node_modules/pagedjs/src/modules/paged-media/lists.js, always active
  // as part of the default paged-media handler set, no registration needed
  // from this app) stamps `data-item-num` on every <li> during its own
  // `afterParsed` hook and sets each split <ol>'s `start` attribute from
  // its first rendered child's `data-item-num` during `afterPageLayout`.
  // This test exists because `nested-lists.md` (the pinned corpus fixture)
  // never spans a page at all (see Test 1's own regression guard above),
  // so this synthetic long nested list is what actually exercises it —
  // structurally like nested-lists.md (a top-level ordered list, each item
  // containing its own nested ordered sub-list), but with 40 top-level
  // items so a page split (and, ideally, a split landing mid-item, mid-
  // nested-list) actually happens.
  const topItems = Array.from({ length: 40 }, (_, i) => {
    const n = i + 1
    return `<li>Top-level item ${n} with a bit of filler text to take up some vertical space.
      <ol>
        <li>Sub-item ${n}.1</li>
        <li>Sub-item ${n}.2</li>
        <li>Sub-item ${n}.3</li>
      </ol>
    </li>`
  }).join('\n')
  const html = `<h1>Long Nested List</h1><ol>${topItems}</ol>`

  const result = await app.evaluate(
    async ({ BaseWindow }, { html, geometry, documentStyle }) => {
      const bridge = (
        globalThis as unknown as {
          __pagedownPhase0: {
            createPaginationHarness: typeof import('../src/main/pagination-window').createPaginationHarness
          }
        }
      ).__pagedownPhase0
      const win = new BaseWindow({ show: false })
      const harness = await bridge.createPaginationHarness(win)
      const sendResult = await harness.sendDocument(html, geometry, documentStyle)

      // For every <ol> on every page: its `start`, its first child's
      // `data-item-num` (must equal `start` if Lists.afterPageLayout ran
      // correctly), whether it's the (single) top-level list or one of the
      // per-item nested ones, and its first rendered item's own TEXT --
      // captured so the assertions below can derive an expected number from
      // the actual source content independently of Paged.js's own
      // `data-item-num` bookkeeping (see the comment below on why comparing
      // `start` only against `data-item-num` would be partially circular:
      // both come from the same Lists handler).
      const perPageLists = await harness.view.webContents.executeJavaScript(`
      Array.from(document.querySelectorAll('.pagedjs_page')).map((page) =>
        Array.from(page.querySelectorAll('ol')).map((ol) => ({
          start: ol.start,
          firstItemNum: ol.firstElementChild ? Number(ol.firstElementChild.dataset.itemNum) : null,
          isTopLevel: ol.parentElement.tagName !== 'LI',
          firstItemText: ol.firstElementChild ? ol.firstElementChild.textContent : null
        }))
      )
    `)
      return { pageCount: sendResult.pageCount, perPageLists }
    },
    { html, geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
  )

  console.log('Gate 6 nested-list result:', JSON.stringify(result, null, 2))

  interface ListInfo {
    start: number
    firstItemNum: number | null
    isTopLevel: boolean
    firstItemText: string | null
  }
  const perPageLists = result.perPageLists as ListInfo[][]

  expect(
    result.pageCount,
    'the 40-item nested list must split across at least 2 pages for this check to mean anything'
  ).toBeGreaterThan(1)

  // Independent ground truth, NOT derived from Paged.js's own bookkeeping:
  // this synthetic fixture's source text is deliberately predictable
  // ("Top-level item N ...", "Sub-item N.M") specifically so the expected
  // position of any rendered <li> can be recovered from its own visible
  // text alone. Comparing `start`/`data-item-num` only against EACH OTHER
  // (as an earlier version of this test did) is partially circular -- both
  // values are computed by the same `Lists` handler (afterParsed stamps
  // data-item-num, afterPageLayout sets start from it), so a bug in HOW
  // data-item-num itself gets assigned in the first place would not be
  // caught by checking that the two agree with each other. Parsing the
  // expected number back out of the rendered text closes that gap: it
  // validates against what a reader/screen-reader actually SEES, not just
  // Paged.js's own internal counter.
  function expectedPositionFromText(text: string, isTopLevel: boolean): number | null {
    if (isTopLevel) {
      // The common case: a fresh (unsplit) top-level <li> whose own text
      // starts with "Top-level item N ...".
      const direct = /Top-level item (\d+)/.exec(text)
      if (direct) return Number(direct[1])
      // Real, observed case (not hypothetical): when a top-level item's
      // OWN text was long enough to have already been fully rendered on
      // the PREVIOUS page before the split occurred, the continuation
      // page's first top-level <li> contains only the remaining nested
      // "Sub-item N.M" children -- no "Top-level item N" text survives on
      // this page at all. N is still recoverable from that nested text's
      // own N (not its M) -- e.g. firstItemText "Sub-item 11.2Sub-item
      // 11.3" means this continuation IS top-level item 11.
      const fromNested = /Sub-item (\d+)\.\d+/.exec(text)
      return fromNested ? Number(fromNested[1]) : null
    }
    const m = /Sub-item \d+\.(\d+)/.exec(text)
    return m ? Number(m[1]) : null
  }

  // THE assertion this test exists to make, per the design doc's own named
  // risk ("ordered lists restart numbering on continuation"): for every
  // <ol> found anywhere in the paginated output -- top-level or nested --
  // its `start` attribute must equal both (a) its own first rendered
  // item's `data-item-num` (Paged.js's own internal bookkeeping) AND (b)
  // the position independently recovered from that item's own visible
  // text, never 1 unless it genuinely is the list's first page. A
  // restart-to-1 bug would show up here as `start === 1` for a
  // continuation list whose real position is > 1 either way.
  let anyContinuationListFound = false
  for (const pageLists of perPageLists) {
    for (const list of pageLists) {
      expect(
        list.firstItemNum,
        'every rendered <ol> must have a first child carrying a real data-item-num'
      ).not.toBeNull()
      expect(
        list.start,
        `<ol> (isTopLevel=${list.isTopLevel}) start must match its first item's data-item-num (${list.firstItemNum}), not restart at 1`
      ).toBe(list.firstItemNum)

      const expectedFromText = expectedPositionFromText(list.firstItemText ?? '', list.isTopLevel)
      expect(
        expectedFromText,
        `<ol> (isTopLevel=${list.isTopLevel}) first item's own text ("${list.firstItemText}") must match the expected "Top-level item N"/"Sub-item N.M" pattern`
      ).not.toBeNull()
      expect(
        list.start,
        `<ol> (isTopLevel=${list.isTopLevel}) start (${list.start}) must match the position independently recovered from its first item's own VISIBLE TEXT (${expectedFromText}), not just agree with Paged.js's own data-item-num bookkeeping`
      ).toBe(expectedFromText)

      if ((list.firstItemNum ?? 1) > 1) anyContinuationListFound = true
    }
  }
  // Non-vacuousness check: at least one list, somewhere, must actually BE
  // a continuation (firstItemNum > 1) for the assertion above to have
  // exercised the real numbering-continuity behavior, not just the
  // trivial always-starts-at-1 case.
  expect(
    anyContinuationListFound,
    'at least one <ol> across the split document must be a genuine continuation (first item number > 1) for this check to be non-vacuous'
  ).toBe(true)

  await close()
})
