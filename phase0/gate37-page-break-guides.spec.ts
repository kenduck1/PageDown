import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile, rm, realpath, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'
import { markdownToHtml } from '../src/markdown/pipeline'
import { BLOCK_INDEX_ATTRIBUTE } from '../src/pagination/page-breaks'
import { computePageSeamMetrics } from '../src/typography/page-seam'
import { launchIsolatedApp } from './electron-launch'
import { LETTER_GEOMETRY, DEFAULT_STYLE } from './gate-geometry'

// Editor page-break guides -- the master design doc's own "review's
// highest-value finding" (design:50-58) and, per the 2026-08-09 gap audit's
// B1, the largest thing it called for that had never been built.
//
// NUMBERED 37, NOT 36: a parallel sub-project (unsaved-document draft
// recovery) claimed 36 the same day. This is the third time that has
// happened -- check `git ls-tree main phase0/` AND `git status` for
// untracked spec files before picking a number during parallel work.
//
// Four things here are impossible to check anywhere but the real app:
//
// 1. That the `data-pd-block` stamps SURVIVE Paged.js's own pagination. The
//    whole approach rests on Chunker cloning and relocating real DOM nodes
//    (`layout.js`'s cloneNode) rather than re-serializing -- a claim about a
//    third-party library's real runtime behaviour, and one that no amount of
//    unit testing against a hand-built fixture can establish.
// 2. That a guide lands at the RIGHT boundary. Asserted by measuring both
//    surfaces in one run and comparing them to each other, never against a
//    hardcoded block number: for every page transition, the block sitting
//    immediately above the guide in the editor must be the same block that
//    ends that page in the real paginated output.
// 3. That the guides genuinely PAINT (a non-zero box), the same thing
//    Gate 17 asserts for find highlights -- a decoration present in the DOM
//    but collapsed to zero area passes every unit test and is invisible.
// 4. **That a guide displaces the document by EXACTLY the seam it draws, at
//    EXACTLY the boundaries it draws one, and by nothing anywhere above the
//    first.** This is the Gate 10 question, and it needs its own gate: Gate
//    10's REPORT_TEMPLATE fixture is SINGLE-PAGE (that gate asserts
//    `pageCount === 1` directly), so it has no page breaks, draws no guides,
//    and therefore cannot answer whether they disturb its 0.000px parity --
//    it is unaffected VACUOUSLY. Test 2 below is the real answer.
//
//    THIS ASSERTION USED TO READ "the guides displace NOTHING", 0.000px
//    across 121 blocks, and that was correct when a guide was a zero-height
//    absolutely-positioned hairline. A guide is now a page SEAM: it occupies
//    the real vertical space a page boundary occupies on paper (the ending
//    page's remaining bottom margin, a gutter between the sheets, the
//    starting page's top margin), so "moves nothing" is false BY DESIGN. The
//    replacement is strictly stronger rather than weaker -- "something moved"
//    would have been weaker, and is not what this asserts. It pins the
//    displacement as an exact STEP FUNCTION: zero for every block above the
//    first seam, then exactly one seam height more per seam crossed, with the
//    seam height computed from computePageSeamMetrics rather than measured
//    from the DOM or hardcoded, so it cannot be fitted to whatever the app
//    happens to do.

// Short, uniform paragraphs, so every break falls cleanly BETWEEN blocks
// rather than inside one -- which is what makes test 1's "the block above the
// guide is the block that ends the page" comparison meaningful. 120 of them
// comfortably exceeds one Letter page at this app's 14px/1.7 body text.
const CLEAN_FIXTURE = [
  '# Gate 37 Clean Breaks',
  ...Array.from(
    { length: 120 },
    (_unused, index) => `Paragraph number ${index + 1} of the clean-break fixture.`
  )
].join('\n\n')

async function getMainWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      try {
        await candidate.waitForLoadState('domcontentloaded', { timeout: 500 })
      } catch {
        continue
      }
      if (candidate.url().startsWith('file://')) {
        return candidate
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out locating the main app-shell window (only found the sandboxed one)')
}

interface OpenedFixture {
  app: ElectronApplication
  close: () => Promise<void>
  win: Page
  fixtureDir: string
  restoreRecents: () => Promise<void>
}

// Same setup as gate17's own openFixtureDocument, including the reload that
// makes HomeScreen re-fetch the freshly-seeded recents list.
async function openFixtureDocument(body: string, label: string): Promise<OpenedFixture> {
  const {
    app,
    close,
    userDataDir: expectedUserDataDir
  } = await launchIsolatedApp(['out/main/index.js'])
  const win = await getMainWindow(app)
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

  const userDataDir = await app.evaluate(({ app }) => app.getPath('userData'))
  expect(await realpath(userDataDir)).toBe(await realpath(expectedUserDataDir))

  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate37-'))
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const fixtureFilename = `gate37-${label}-${nonce}.md`
  const fixturePath = join(fixtureDir, fixtureFilename)
  await writeFile(fixturePath, body, 'utf8')

  const originalRecents = await readRecentFiles(userDataDir)
  const restoreRecents = async (): Promise<void> => {
    await writeRecentFiles(userDataDir, originalRecents)
  }
  await writeRecentFiles(
    userDataDir,
    mergeRecentFiles(originalRecents, fixturePath, new Date().toISOString())
  )

  await win.reload()
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
  await win
    .getByRole('button', { name: new RegExp(fixtureFilename.replace(/[.]/g, '\\.')) })
    .click()
  await win.waitForSelector('.milkdown-mount .ProseMirror')

  return { app, close, win, fixtureDir, restoreRecents }
}

interface EditorGuide {
  label: string
  approximate: boolean
  precedingText: string
  boxHeight: number
  boxWidth: number
}

// Reads every guide in the live editor along with the text of the block it
// sits directly after -- the editor's own answer to "which block ends this
// page". Guides are widget decorations, so they are real children of
// `.ProseMirror` interleaved with the document's own blocks.
async function readEditorGuides(win: Page): Promise<EditorGuide[]> {
  return win.evaluate(() => {
    const root = document.querySelector('.milkdown-mount .ProseMirror')
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>('.pagedown-page-guide')).map((guide) => {
      const previous = guide.previousElementSibling
      const box = guide.getBoundingClientRect()
      return {
        label: (guide.textContent ?? '').trim(),
        approximate: guide.classList.contains('is-approximate'),
        precedingText: (previous?.textContent ?? '').trim(),
        boxHeight: box.height,
        boxWidth: box.width
      }
    })
  })
}

interface BlockLayout {
  /** Every real document block's top, relative to the editing root, guides excluded. */
  tops: number[]
  /**
   * For each seam, how many real blocks precede it -- so a seam recorded as
   * `m` displaces every block whose index is >= m, and nothing above it.
   *
   * Captured in the SAME pass as `tops` rather than derived from the guide
   * labels afterwards, because the two have to describe the same instant: a
   * seam and the blocks it pushes down are read from one DOM walk.
   */
  seamAfterBlockCounts: number[]
  /** Each seam's own laid-out height, for the direct pin against page geometry. */
  seamHeights: number[]
}

// Every top-level block's top relative to the editing root, plus where the
// seams sit among them. The guides are EXCLUDED from `tops`, so that array
// measures only real document content -- which is what the displacement claim
// is about.
async function readBlockLayout(win: Page): Promise<BlockLayout> {
  return win.evaluate(() => {
    const root = document.querySelector('.milkdown-mount .ProseMirror')
    if (!root) return { tops: [], seamAfterBlockCounts: [], seamHeights: [] }
    const rootTop = root.getBoundingClientRect().top
    const tops: number[] = []
    const seamAfterBlockCounts: number[] = []
    const seamHeights: number[] = []
    for (const child of Array.from(root.children)) {
      if (child.classList.contains('pagedown-page-guide')) {
        seamAfterBlockCounts.push(tops.length)
        seamHeights.push(child.getBoundingClientRect().height)
        continue
      }
      tops.push(child.getBoundingClientRect().top - rootTop)
    }
    return { tops, seamAfterBlockCounts, seamHeights }
  })
}

async function waitForGuides(win: Page, atLeast: number): Promise<void> {
  await win.waitForFunction(
    (minimum) =>
      document.querySelectorAll('.milkdown-mount .ProseMirror .pagedown-page-guide').length >=
      minimum,
    atLeast,
    { timeout: 30_000 }
  )
}

// Paginates the SAME source through the real, headless pagination harness and
// reports, per page, the text of the last stamped block on it -- the
// paginator's own answer to "which block ends this page". Deliberately
// independent of anything the editor did: this is the reference the editor is
// checked against.
async function readPaginatedPageEndings(
  app: ElectronApplication,
  source: string
): Promise<{ pageCount: number; lastBlockTextPerPage: string[] }> {
  await app.evaluate(async ({ BaseWindow }) => {
    const bridge = (
      globalThis as unknown as {
        __pagedownPhase0: {
          createPaginationHarness: typeof import('../src/main/pagination-window').createPaginationHarness
        }
      }
    ).__pagedownPhase0
    const win = new BaseWindow({ show: false })
    ;(globalThis as unknown as { __gate37Harness: unknown }).__gate37Harness =
      await bridge.createPaginationHarness(win)
    return true
  })

  const { html } = markdownToHtml(source)

  return (await app.evaluate(
    async (_electronNS, { html, geometry, documentStyle, attribute }) => {
      const harness = (
        globalThis as unknown as {
          __gate37Harness: import('../src/main/pagination-window').PaginationHarness
        }
      ).__gate37Harness
      const result = await harness.sendDocument(html, geometry, documentStyle)

      const raw = (await harness.view.webContents.executeJavaScript(`
        (function () {
          var pages = Array.prototype.slice.call(document.querySelectorAll('.pagedjs_page'))
          return JSON.stringify(pages.map(function (page) {
            var stamped = page.querySelectorAll('[${attribute}]')
            if (stamped.length === 0) return ''
            return String(stamped[stamped.length - 1].textContent || '').trim()
          }))
        })()
      `)) as string

      return {
        pageCount: result.pageCount,
        lastBlockTextPerPage: JSON.parse(raw) as string[]
      }
    },
    {
      html,
      geometry: LETTER_GEOMETRY,
      documentStyle: DEFAULT_STYLE,
      attribute: BLOCK_INDEX_ATTRIBUTE
    }
  )) as { pageCount: number; lastBlockTextPerPage: string[] }
}

test('Gate 37: every guide lands on the block that really ends that page', async () => {
  test.setTimeout(120_000)

  const fixture = await openFixtureDocument(CLEAN_FIXTURE, 'clean')
  const { app, close, win, fixtureDir, restoreRecents } = fixture

  try {
    const paginated = await readPaginatedPageEndings(app, CLEAN_FIXTURE)
    expect(
      paginated.pageCount,
      'the fixture must be genuinely multi-page, or this gate proves nothing'
    ).toBeGreaterThan(1)

    // Every page must have a stamped block on it -- if the stamps did not
    // survive Chunker's cloning this is where it shows, before any editor-
    // side comparison could mask it as an ordinary mismatch.
    expect(
      paginated.lastBlockTextPerPage.filter((text) => text.length > 0),
      'data-pd-block stamps must survive pagination onto every page'
    ).toHaveLength(paginated.pageCount)

    await waitForGuides(win, paginated.pageCount - 1)
    const guides = await readEditorGuides(win)

    console.log(`\nGate 37 clean-break fixture: ${paginated.pageCount} pages`)
    console.table(
      guides.map((guide, index) => ({
        guide: index,
        label: guide.label,
        editorBlockAbove: guide.precedingText.slice(0, 44),
        paginatorPageEnd: (paginated.lastBlockTextPerPage[index] ?? '').slice(0, 44),
        approximate: guide.approximate
      }))
    )

    expect(guides).toHaveLength(paginated.pageCount - 1)

    guides.forEach((guide, index) => {
      // THE correctness assertion. Compared surface-to-surface rather than
      // against a literal, so it cannot be satisfied by hardcoding.
      expect(
        guide.precedingText,
        `guide ${index} sits after the wrong block: the editor puts it after ` +
          `"${guide.precedingText.slice(0, 60)}" but page ${index + 1} really ends with ` +
          `"${(paginated.lastBlockTextPerPage[index] ?? '').slice(0, 60)}"`
      ).toBe(paginated.lastBlockTextPerPage[index])

      // Uniform short paragraphs cannot be split by Paged.js, so every one of
      // these must be an exact break. Asserted so a regression that marked
      // everything approximate (which would make the label check above
      // trivially satisfiable) fails loudly.
      expect(guide.approximate, `guide ${index} should be an exact break`).toBe(false)
      expect(guide.label).toBe(`Page ${index + 1} ends here`)

      // The paint assertion (Gate 17's own precedent): a decoration collapsed
      // to zero area is invisible to a user and passes every unit test. Height
      // is legitimately 0 by design -- see test 2 -- so WIDTH is what proves
      // it occupies real screen space.
      expect(guide.boxWidth, `guide ${index} must occupy real pixels`).toBeGreaterThan(100)
    })
  } finally {
    await rm(fixtureDir, { recursive: true, force: true })
    await restoreRecents()
    await close()
  }
})

test('Gate 37: a seam displaces the document by exactly its own height, and only below itself', async () => {
  test.setTimeout(120_000)

  // This is the answer to "does this break Gate 10's 0.000px parity?" that
  // Gate 10 itself structurally cannot give: its fixture is single-page, so
  // no seam is ever drawn there and its non-disturbance is vacuous.
  //
  // A seam is IN FLOW and has real height -- it is the vertical space a page
  // boundary genuinely occupies on paper. So the claim is not "nothing moved";
  // it is that the movement is exactly, and only, the space the boundaries
  // themselves take:
  //
  //   * every block above the first seam is at exactly its original position
  //   * every block below k seams is exactly k seam-heights lower
  //   * the seam height is what the document's own page geometry says it is
  //
  // The last of those three is what stops the other two being circular. It is
  // computed here from computePageSeamMetrics against the same LETTER_GEOMETRY
  // the rest of this suite paginates at -- never measured out of the DOM and
  // never hardcoded, so a bug in the app's own seam sizing cannot define its
  // own expected value.
  //
  // The trap this specifically rules out is margin doubling. An in-flow box
  // dropped between two collapsing siblings normally separates them, turning
  // one collapsed margin into two stacked ones -- which would show up here as
  // a displacement LARGER than the seam by exactly one block margin, at every
  // boundary. base.css keeps the collapse intact instead (see its own note);
  // this is what proves it.
  const fixture = await openFixtureDocument(CLEAN_FIXTURE, 'layout')
  const { close, win, fixtureDir, restoreRecents } = fixture

  try {
    // The "before" read is only meaningful if it genuinely precedes the
    // seams, so that is asserted rather than assumed -- they need a full
    // 500ms debounce plus a real pagination round trip, but a slow-enough
    // machine could in principle invert the order, and this failing loudly is
    // far better than the comparison silently becoming before-vs-before.
    expect(
      await win.locator('.milkdown-mount .ProseMirror .pagedown-page-guide').count(),
      'the baseline must be measured before any seam exists'
    ).toBe(0)
    const before = await readBlockLayout(win)
    expect(before.tops.length).toBeGreaterThan(100)
    expect(before.seamAfterBlockCounts).toHaveLength(0)

    await waitForGuides(win, 1)
    const after = await readBlockLayout(win)

    expect(after.tops).toHaveLength(before.tops.length)
    expect(
      after.seamAfterBlockCounts.length,
      'a multi-page fixture must produce at least one seam, or this test proves nothing'
    ).toBeGreaterThan(0)

    // (a) THE SEAM IS THE SIZE THE DOCUMENT'S OWN GEOMETRY SAYS IT IS.
    // Letter with 1in margins: 96px of the ending page's paper + a 24px
    // gutter + 96px of the starting page's paper.
    const expectedSeamHeight = computePageSeamMetrics(LETTER_GEOMETRY).heightPx
    for (const [index, height] of after.seamHeights.entries()) {
      expect(height, `seam ${index} is not one page boundary tall`).toBeCloseTo(
        expectedSeamHeight,
        2
      )
    }

    // (b) THE DISPLACEMENT IS AN EXACT STEP FUNCTION.
    const seamsAbove = (blockIndex: number): number =>
      after.seamAfterBlockCounts.filter((count) => count <= blockIndex).length
    const rows = after.tops.map((top, index) => ({
      block: index,
      seamsAbove: seamsAbove(index),
      expected: seamsAbove(index) * expectedSeamHeight,
      actual: top - before.tops[index]
    }))
    const worstRow = rows.reduce((worst, row) =>
      Math.abs(row.actual - row.expected) > Math.abs(worst.actual - worst.expected) ? row : worst
    )

    console.log(
      `\nGate 37 seam displacement across ${before.tops.length} blocks, ` +
        `${after.seamAfterBlockCounts.length} seams of ${expectedSeamHeight}px ` +
        `(after blocks ${after.seamAfterBlockCounts.join(', ')}):`
    )
    console.table([
      ...rows.filter((row) => row.block < 2 || after.seamAfterBlockCounts.includes(row.block)),
      { ...worstRow, block: `${worstRow.block} (worst)` as unknown as number }
    ])

    // Written per block rather than as one max-delta, so a failure names the
    // block AND says whether the document moved too far or not far enough.
    for (const row of rows) {
      expect(
        row.actual,
        `block ${row.block} sits below ${row.seamsAbove} seam(s), so it must have moved ` +
          `exactly ${row.expected.toFixed(3)}px when they appeared -- it moved ` +
          `${row.actual.toFixed(3)}px`
      ).toBeCloseTo(row.expected, 3)
    }

    // (c) THE ANTI-VACUITY HALF, in the same shape Gates 28/29 use. Every
    // assertion above is satisfied trivially if `expected` is 0 everywhere,
    // which is exactly what a regression to a zero-height seam would produce
    // -- and that regression is a real, visible product defect (the canvas
    // stops looking like pages) that would otherwise leave this test green.
    expect(
      expectedSeamHeight,
      'a zero-height seam would satisfy every assertion above for free'
    ).toBeGreaterThan(100)
    expect(
      rows.some((row) => row.seamsAbove > 0),
      'some block must sit below a seam, or the step function is never exercised'
    ).toBe(true)
    expect(
      rows.filter((row) => row.seamsAbove === 0).length,
      'some block must sit ABOVE the first seam, or "moves nothing above it" is never exercised'
    ).toBeGreaterThan(0)
  } finally {
    await rm(fixtureDir, { recursive: true, force: true })
    await restoreRecents()
    await close()
  }
})

test('Gate 37: a break inside a block is drawn as approximate and says so', async () => {
  test.setTimeout(120_000)

  // The corpus's own code-block fixture: 7 pages dominated by ONE fenced
  // block that Paged.js splits across several of them. Used rather than a
  // synthetic document precisely because its page count is independently
  // pinned by Gate 6, so this exercises the disclosed limitation against
  // content the rest of the suite already measures.
  const source = await readFile(join(__dirname, 'corpus/code-blocks-spanning-pages.md'), 'utf8')
  const fixture = await openFixtureDocument(source, 'split')
  const { app, close, win, fixtureDir, restoreRecents } = fixture

  try {
    const paginated = await readPaginatedPageEndings(app, source)
    expect(paginated.pageCount).toBeGreaterThan(2)

    await waitForGuides(win, 1)
    const guides = await readEditorGuides(win)

    console.log(`\nGate 37 split-block fixture: ${paginated.pageCount} pages`)
    console.table(guides.map((guide) => ({ label: guide.label, approximate: guide.approximate })))

    // Several page transitions fall inside the one long code block, so they
    // COLLAPSE onto a single boundary rather than stacking identical lines --
    // which is why there are fewer guides than page transitions here, unlike
    // the clean fixture above.
    expect(guides.length).toBeGreaterThan(0)
    expect(guides.length).toBeLessThan(paginated.pageCount - 1)

    const approximate = guides.filter((guide) => guide.approximate)
    expect(
      approximate.length,
      'a fixture whose page breaks fall inside one long code block must produce at least ' +
        'one approximate guide -- otherwise the feature is claiming exactness it does not have'
    ).toBeGreaterThan(0)

    // The honesty contract: an approximate guide never uses the exact
    // wording, and a merged one names the whole range it covers.
    for (const guide of approximate) {
      expect(guide.label).not.toMatch(/ends here$/)
      expect(guide.label).toMatch(/ends? inside this block$/)
    }
    expect(
      approximate.some((guide) => /^Pages \d+–\d+ end inside this block$/.test(guide.label)),
      'consecutive pages breaking inside one block must merge into a range-labelled guide'
    ).toBe(true)
  } finally {
    await rm(fixtureDir, { recursive: true, force: true })
    await restoreRecents()
    await close()
  }
})
