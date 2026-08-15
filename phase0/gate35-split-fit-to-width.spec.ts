import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'
import { PAGE_WIDTH_PX } from '../src/typography/page-geometry'
import { MIN_FIT_SCALE, FIT_GUTTER_PX } from '../src/renderer/src/lib/fit-scale'
import { launchIsolatedApp } from './electron-launch'

// Gate 35 -- Split-mode fit-to-width scaling.
//
// Numbered 35 after checking `git ls-tree main phase0/` (34 was the highest),
// per the convention CLAUDE.md records after Find&Replace and Page Navigation
// collided on 17 during parallel work.
//
// WHY A GATE. The whole feature is a measurement: read the editor pane's real
// width, and scale a fixed-width page card to fit it. jsdom has no layout
// engine and its ResizeObserver is a no-op stub (test-setup.ts), so a unit
// test can assert that a component received `style={{ zoom: 0.7 }}` and can
// NEVER assert that anything is 571 real pixels wide or that a scroll bar went
// away. EditorScreen.test.tsx's own "Split-mode fit-to-width" block covers the
// wiring by driving a controllable ResizeObserver with a stubbed clientWidth;
// everything below is the half that only real Chromium layout can answer.
//
// THE THREE THINGS ASSERTED, each structurally impossible under jsdom:
//
//   1. At the app's own default window the page card genuinely renders
//      SMALLER, in real pixels, and the pane's real horizontal scroll extent
//      shrinks with it. Asserted in TWO PARTS (the Gate 28/29 pattern) so it
//      cannot go vacuous: the unscaled 816px page genuinely would NOT have fit
//      the measured pane, AND the rendered card does come out smaller. Widen
//      the window far enough and the FIRST half fails loudly rather than the
//      second half passing for free.
//   2. At the widest divider setting the page genuinely FITS -- `scrollWidth
//      <= clientWidth`, i.e. the horizontal scrollbar is actually gone, not
//      merely shorter. Same two-part treatment: the unscaled page would still
//      have overflowed that same pane, so "fits" is a real achievement rather
//      than a wide-pane freebie.
//   3. Follow scroll reports the RIGHT PAGE from a scaled pane. The editor
//      pane's `scrollTop` is now measured in the scaled wrapper's coordinate
//      space while `contentHeightPx` is a document-space length, so the
//      estimate has to divide one by the scale before comparing them. Getting
//      this wrong does not throw -- it silently reports page 2 for a pane
//      scrolled to page 3, in exactly the mode this feature exists for.
//
// A Format-mode control is measured in the SAME app instance in test 1, so the
// gate proves the change is Split-only rather than trusting that it is.
//
// MEASURED VALUES at the default 1000x840 window (canvas 784px beside the
// 216px sidebar rail), Letter/1in, recorded so a later reader can see how much
// slack each bound has:
//
//   divider 50% (default) -- pane clientWidth 389, unscaled card 816 (47.7%
//     visible, horizontal scroll extent 427px). 389 - 24 gutter = 365;
//     365/816 = 0.447 -> 0.44 applied, card 359px, and it FITS. This row used
//     to read "below the 0.70 floor, so the floor binds" -- the floor was
//     lowered to 0.4 and the gutter raised to 24 on user feedback, which moved
//     the app's own default configuration from clamped-and-scrolling to
//     genuinely fitting.
//   divider 75% -- pane clientWidth 585. 561/816 = 0.687 -> 0.68 applied,
//     card 555px, scrollWidth == clientWidth, no horizontal scroll at all.
//   Format mode, same run -- card 816px, untouched.
//
// FLAKE OBSERVED, and it is the already-documented environmental one rather
// than anything about this gate. Test 3 twice died on a bare `Test timeout`
// plus `Worker teardown timeout` having reached NO assertion -- once as the
// tenth sequential launch of a six-file sweep, once as the third launch within
// this file -- and then passed 5.8s standalone and 3/3 twice in a row as a
// whole file (7.6s and 7.7s) at comparable load. That is exactly the
// sequential-launch-count axis CLAUDE.md's Testing section records (gate13 at
// 5 launches/file and gate14 at 4 were its own most frequent failers). A real
// regression here surfaces as a NAMED assertion failure, and test 3 has
// already been seen to produce one on demand: mutating away the scale division
// in useSplitFollowScroll failed it with `getByRole('button', { name: 'Page 3
// of 7' })` not found, which is what proves this test has teeth rather than
// merely passing.

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

interface PreviewFitProbe {
  /** The sandboxed context's own content box -- what a page has to fit into. */
  bodyClientWidth: number
  /** Real laid-out width of the first `.pagedjs_page`, i.e. post-`zoom`. */
  pageRenderedWidth: number
  /** Horizontal overflow of the whole preview document; 0 means it fits. */
  overflowPx: number
  pageCount: number
  /**
   * `flow.total` off the sandbox's OWN published result, or 0 if it has not
   * published a successful one yet. This is a completion signal, not a
   * measurement: the render context assigns `window.__pagedownResult` only
   * after `previewer.preview()` has resolved. See the settle poll below.
   */
  publishedPageCount: number
}

// Reads the REAL laid-out geometry of the real sandboxed split-preview
// context. Same mechanism as gate18's probePageScroll and gate15's
// probeSplitPreviewView -- app.evaluate() + mainWindow.contentView.children +
// executeJavaScript -- because the paginated DOM lives only inside a
// WebContentsView with no preload and no contextBridge, and gate15 separately
// proved contextBridge deep-freezes window.api so renderer-side spying is
// impossible anyway.
//
// Filtering to a genuinely on-screen rectangle is what isolates the split
// preview's view from the Phase 0 spike harness's own pagedown-render:// view,
// which is parked permanently off-screen at {x:-9999,y:-9999}.
async function probePreviewFit(app: ElectronApplication): Promise<PreviewFitProbe | null> {
  return app.evaluate(async ({ BrowserWindow, WebContentsView }) => {
    const mainWindow = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().startsWith('file://')
    )
    if (!mainWindow) return null

    const splitView = mainWindow.contentView.children.find(
      (child): child is InstanceType<typeof WebContentsView> => {
        if (!(child instanceof WebContentsView)) return false
        if (child.webContents.isDestroyed()) return false
        if (!child.webContents.getURL().startsWith('pagedown-render://')) return false
        const bounds = child.getBounds()
        return bounds.x >= 0 && bounds.y >= 0 && bounds.width > 0 && bounds.height > 0
      }
    )
    if (!splitView) return null

    return (await splitView.webContents.executeJavaScript(
      `(() => {
         const pages = Array.from(document.querySelectorAll('.pagedjs_page'))
         const doc = document.documentElement
         return {
           bodyClientWidth: document.body.clientWidth,
           pageRenderedWidth: pages.length ? pages[0].getBoundingClientRect().width : 0,
           overflowPx: Math.max(0, doc.scrollWidth - doc.clientWidth),
           pageCount: pages.length,
           publishedPageCount:
             window.__pagedownResult && window.__pagedownResult.type === 'result'
               ? window.__pagedownResult.pageCount
               : 0
         }
       })()`
    )) as PreviewFitProbe
  })
}

interface OpenedFixture {
  app: ElectronApplication
  close: () => Promise<void>
  win: Page
  fixtureDir: string
  restoreRecents: () => Promise<void>
}

// The same seed-into-recents-then-click-through-Home approach every other
// fixture-driving gate here uses (gate17/20/27/28/29), so the fixture path is
// a genuinely KNOWN path through the real isKnownPath allowlist.
async function openFixtureDocument(body: string): Promise<OpenedFixture> {
  const {
    app,
    close,
    userDataDir: expectedUserDataDir
  } = await launchIsolatedApp(['out/main/index.js'])
  const win = await getMainWindow(app)
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

  const userDataDir = await app.evaluate(({ app }) => app.getPath('userData'))
  expect(await realpath(userDataDir)).toBe(await realpath(expectedUserDataDir))

  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate35-'))
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const fixtureFilename = `gate35-fixture-${nonce}.md`
  await writeFile(join(fixtureDir, fixtureFilename), body, 'utf8')

  const originalRecents = await readRecentFiles(userDataDir)
  const restoreRecents = async (): Promise<void> => {
    await writeRecentFiles(userDataDir, originalRecents)
  }
  await writeRecentFiles(
    userDataDir,
    mergeRecentFiles(originalRecents, join(fixtureDir, fixtureFilename), new Date().toISOString())
  )

  await win.reload()
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
  await win
    .getByRole('button', { name: new RegExp(fixtureFilename.replace(/[.]/g, '\\.')) })
    .click()
  await win.waitForSelector('.milkdown-mount .ProseMirror')

  return { app, close, win, fixtureDir, restoreRecents }
}

interface PaneMeasurement {
  paneClientWidth: number
  paneScrollWidth: number
  cardRenderedWidth: number
  appliedZoom: string
}

// Reads the real, laid-out geometry of the editor pane and the page card
// inside it. `closest('.overflow-auto')` rather than a new data-testid: that
// class is on the pane in EditorScreen's own source for both the Split and
// single-pane branches, and this gate deliberately measures the shipped markup
// rather than asking production code to grow a hook for it.
//
// `getBoundingClientRect().width` on the card is the number that matters and
// is genuinely independent of the `zoom` value being read alongside it: CSS
// `zoom` participates in layout, so the rect comes back already scaled (a
// probe against this same app measured an 816px card as 734.4px at zoom 0.9).
// Reading both means a mutation that sets the style without it taking effect
// -- or vice versa -- is visible rather than self-confirming.
async function measurePane(win: Page): Promise<PaneMeasurement> {
  return win.evaluate(() => {
    const card = document.querySelector('[data-testid="page-card"]') as HTMLElement | null
    if (!card) throw new Error('no page card')
    const pane = card.closest('.overflow-auto') as HTMLElement | null
    if (!pane) throw new Error('no scrolling pane ancestor')
    const wrapper = card.parentElement as HTMLElement
    return {
      paneClientWidth: pane.clientWidth,
      paneScrollWidth: pane.scrollWidth,
      cardRenderedWidth: card.getBoundingClientRect().width,
      appliedZoom: wrapper.style.zoom
    }
  })
}

const SHORT_FIXTURE = `# Gate 35 Fit To Width

A short document is enough for the width measurements: fit-to-width is a
horizontal property and does not depend on how many pages the document has.
`

// Long enough to guarantee several real pages, so Follow has genuine page
// boundaries to estimate between. Mirrors gate18's own multi-page fixture
// shape for the same reason.
function buildMultiPageFixture(): string {
  const blocks: string[] = ['# Gate 35 Follow Fixture', '']
  for (let i = 1; i <= 40; i += 1) {
    blocks.push(`## Section ${i}`)
    blocks.push('')
    blocks.push(
      `Body paragraph for section ${i}. This fixture exists to produce a genuinely ` +
        'multi-page document through the real Paged.js pipeline, so Follow has real ' +
        'page boundaries to estimate between rather than a single-page document ' +
        'where every offset resolves to page one.'
    )
    blocks.push('')
  }
  return blocks.join('\n')
}

test('Gate 35: Split mode scales the page card down to fit its pane, and Format is untouched', async () => {
  test.setTimeout(90_000)

  const { close, win, fixtureDir, restoreRecents } = await openFixtureDocument(SHORT_FIXTURE)

  try {
    // --- Format-mode control, taken FIRST and in this same app instance -----
    // The app opens in Format, so this is the untouched baseline the Split
    // measurement below is a change FROM. Measuring it here rather than
    // reasoning about it is what makes "Split-only" an observation.
    const formatBefore = await measurePane(win)
    expect(
      formatBefore.cardRenderedWidth,
      'Format mode must keep rendering the page card at its true, unscaled width'
    ).toBeCloseTo(PAGE_WIDTH_PX, 1)
    expect(
      formatBefore.appliedZoom,
      'Format mode keeps the user-chosen zoom, which starts at 1'
    ).toBe('1')

    // --- Split mode --------------------------------------------------------
    // `exact: true` rules out the unrelated "Split cell" table toolbar button,
    // per gate15/gate28/gate29.
    await win.getByRole('button', { name: 'Split', exact: true }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')

    // The ResizeObserver observation and React's commit are not synchronous
    // with the click, so poll rather than sampling once.
    await expect
      .poll(async () => (await measurePane(win)).appliedZoom, {
        message: 'expected the Split editor pane to apply a real fit-to-width scale',
        timeout: 10_000
      })
      .not.toBe('1')

    const split = await measurePane(win)
    console.log('Gate 35 Split(format) at default window:', JSON.stringify(split))

    // (1a) THE CLAMP-IS-BINDING HALF. Without this, every assertion below
    // would be satisfied trivially by a window wide enough that no scaling was
    // ever needed -- green while testing nothing. Widening the default window
    // past ~1050px is exactly the change that must make this fail loudly
    // rather than let the rest pass for free (the same coupling window-bounds.ts
    // already records for Gates 28/29).
    expect(
      PAGE_WIDTH_PX,
      'the unscaled page must genuinely not fit this pane, or nothing below means anything'
    ).toBeGreaterThan(split.paneClientWidth)

    // (1b) It really is smaller, in real laid-out pixels.
    expect(split.cardRenderedWidth).toBeLessThan(PAGE_WIDTH_PX)

    // At this pane width the page now GENUINELY FITS rather than landing on
    // the floor. That inverts what this assertion used to say, and the change
    // is deliberate: the floor was lowered from 0.7 to 0.4 on direct user
    // feedback ("it should shrink down a bit more before it starts doing
    // scrolling"), which moved the app's own DEFAULT divider position from
    // below the floor to above it. See MIN_FIT_SCALE's own comment for why
    // the old floor's reasoning was sound about the sub-floor regime and
    // wrong about where to put the boundary.
    //
    // Asserted as the PROPERTY (it fits, with its reserved margin intact)
    // rather than as a pinned scale, so a future gutter or floor change has to
    // preserve the outcome instead of merely preserving the arithmetic. The
    // floor is still pinned where it genuinely binds -- see the narrow-pane
    // case in fit-scale.test.ts.
    expect(split.cardRenderedWidth).toBeLessThanOrEqual(split.paneClientWidth - FIT_GUTTER_PX)

    // (1c) The user-visible consequence: materially less horizontal scrolling.
    // Stated as a comparison against the unscaled extent rather than as an
    // absolute, so it keeps meaning something if the window default moves.
    const unscaledScrollExtent = PAGE_WIDTH_PX - split.paneClientWidth
    const scaledScrollExtent = split.paneScrollWidth - split.paneClientWidth
    console.log(
      `Gate 35 horizontal scroll extent: ${unscaledScrollExtent}px unscaled -> ${scaledScrollExtent}px scaled`
    )
    expect(scaledScrollExtent).toBeLessThan(unscaledScrollExtent)

    // (1d) The status bar reports the scale the pane is ACTUALLY rendered at,
    // not the user's own (inapplicable, disabled) zoom. A readout saying 100%
    // over a pane rendering at 44% is the same defect this control was already
    // fixed for once, pointing the other way.
    //
    // Derived from the card's own measured width rather than pinned to
    // MIN_FIT_SCALE, which is what this used to do. That was only ever correct
    // while the default divider happened to fall BELOW the floor; once the
    // floor moved to 0.4 the applied scale became 0.44 and the assertion
    // pinned a number the pane no longer renders at. Reading it back from the
    // measurement keeps this checking the PROPERTY it names -- readout matches
    // reality -- rather than a constant that only coincided with it.
    const appliedScale = split.cardRenderedWidth / PAGE_WIDTH_PX
    const zoomSelect = win.getByLabel('Zoom level')
    await expect(zoomSelect).toBeDisabled()
    await expect(Number(await zoomSelect.inputValue())).toBeCloseTo(appliedScale, 2)

    // --- Back to Format: still untouched, in the same run ------------------
    await win.getByRole('button', { name: 'Format', exact: true }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')
    await expect
      .poll(async () => (await measurePane(win)).cardRenderedWidth, { timeout: 10_000 })
      .toBeCloseTo(PAGE_WIDTH_PX, 1)
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})

test('Gate 35: at the widest divider setting the page genuinely fits, with no horizontal scroll', async () => {
  test.setTimeout(90_000)

  const { close, win, fixtureDir, restoreRecents } = await openFixtureDocument(SHORT_FIXTURE)

  try {
    await win.getByRole('button', { name: 'Split', exact: true }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')
    await expect
      .poll(async () => (await measurePane(win)).appliedZoom, { timeout: 10_000 })
      .not.toBe('1')

    // A REAL mouse drag on the real divider, not a store poke -- the divider
    // is the one control a user has for this, and the fit scale has to survive
    // being recomputed on every frame of the drag.
    const divider = win.getByTestId('split-divider')
    const dividerBox = await divider.boundingBox()
    expect(dividerBox).not.toBeNull()
    const row = await win.evaluate(() => {
      const el = document.querySelector('[data-testid="split-divider"]')?.parentElement
      if (!el) throw new Error('no split row')
      const r = el.getBoundingClientRect()
      return { left: r.left, width: r.width }
    })
    await win.mouse.move(dividerBox!.x + dividerBox!.width / 2, dividerBox!.y + 40)
    await win.mouse.down()
    // Past MAX_SPLIT_RATIO, so this lands exactly on the clamp rather than
    // depending on pixel-accurate mouse placement.
    await win.mouse.move(row.left + row.width * 0.9, dividerBox!.y + 40, { steps: 12 })
    await win.mouse.up()

    await expect
      .poll(async () => (await measurePane(win)).paneClientWidth, {
        message: 'expected the drag to widen the editor pane',
        timeout: 10_000
      })
      .toBeGreaterThan(500)

    // Settle: the ResizeObserver, React's commit and layout all have to land.
    await expect
      .poll(
        async () => {
          const m = await measurePane(win)
          return m.paneScrollWidth <= m.paneClientWidth
        },
        {
          message: 'expected the page to end up fitting the widened pane',
          timeout: 10_000
        }
      )
      .toBe(true)

    const wide = await measurePane(win)
    console.log('Gate 35 Split(format) at divider 75%:', JSON.stringify(wide))

    // TWO PARTS AGAIN. "It fits" is only interesting if the unscaled page
    // would NOT have fit this same pane -- otherwise a sufficiently wide
    // window makes this test assert nothing.
    expect(
      PAGE_WIDTH_PX,
      'the unscaled page must still overflow even the widest pane, or "it fits" is free'
    ).toBeGreaterThan(wide.paneClientWidth)

    // THE HEADLINE: the page really fits, and the horizontal scrollbar is
    // genuinely gone rather than merely shorter. `scrollWidth <= clientWidth`
    // is the browser's own answer to "is there anything to scroll to", which
    // a width comparison alone would not establish.
    expect(wide.cardRenderedWidth).toBeLessThanOrEqual(wide.paneClientWidth)
    expect(wide.paneScrollWidth).toBeLessThanOrEqual(wide.paneClientWidth)

    // And it got there by scaling, not by reflowing the document to a
    // narrower column -- which would be the wrong fix, and the one
    // EditorScreen's fixed-width page card exists to rule out (a reflowed
    // card is what breaks Gate 10's 0.000px parity).
    expect(Number(wide.appliedZoom)).toBeGreaterThan(0)
    expect(Number(wide.appliedZoom)).toBeLessThan(1)
    expect(wide.cardRenderedWidth).toBeCloseTo(Number(wide.appliedZoom) * PAGE_WIDTH_PX, 0)
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})

test('Gate 35: the sandboxed PREVIEW pane is fitted too, and genuinely fits when widened', async () => {
  test.setTimeout(120_000)

  // A MULTI-PAGE fixture, not the short one, purely so the page-count
  // invariance assertion at the end of this test has something to say. See
  // there for why that assertion is the important one.
  const { app, close, win, fixtureDir, restoreRecents } =
    await openFixtureDocument(buildMultiPageFixture())

  try {
    await win.getByRole('button', { name: 'Split', exact: true }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')

    // The preview is a real cross-process render: the harness has to spin up,
    // the debounced sendDocument has to land, and Paged.js has to FINISH.
    //
    // WAIT FOR COMPLETION, NOT MERELY FOR A PAGE TO EXIST -- the difference is
    // the whole reason this test used to fail, and it is the same trap CLAUDE.md
    // already records against Gate 19's own marker probe. Paged.js appends pages
    // PROGRESSIVELY, and the fit scale is deliberately suspended for the
    // duration of layout so that the diagram/image boxes this render publishes
    // are measured in unscaled document space (see `previewFitSuspended` in
    // resources/pagination-render/index.ts). So `pageCount > 0` goes true within
    // roughly the first 25ms of a ~175ms render, and everything read at that
    // moment is a half-laid-out document at scale 1.
    //
    // MEASURED, by instrumenting the render context rather than inferring: a
    // probe firing on `pageCount > 0` sampled `{bodyClientWidth: 373,
    // pageRenderedWidth: 816, pageCount: 5, zoom: "1"}` while that context's own
    // log held nothing but a `start` entry, and the SAME render settled 173ms
    // later at `{389, 359.04, 7, "0.44"}`. It also explains a page count that
    // appeared to move between runs against an unchanged fixture (5, 6 and 7
    // were all seen): three samples of one progressive append, never a
    // pagination change.
    //
    // Requiring the published count to AGREE with the DOM's own is what makes
    // this robust rather than merely later: on a long-lived harness a PREVIOUS
    // render's result stays published while a new one clears and refills the
    // DOM, so `publishedPageCount > 0` alone could be satisfied by a stale one.
    //
    // Deliberately NOT a poll on the scale itself. Waiting until the page looks
    // scaled and then asserting that it is scaled would be vacuous; this waits
    // on a signal every assertion below already assumed and none of them tests.
    await expect
      .poll(
        async () => {
          const p = await probePreviewFit(app)
          return p !== null && p.publishedPageCount > 0 && p.publishedPageCount === p.pageCount
        },
        {
          message: 'expected the sandboxed split preview to finish a real, complete render',
          timeout: 30_000
        }
      )
      .toBe(true)

    const atDefault = (await probePreviewFit(app))!
    console.log('Gate 35 preview at default divider:', JSON.stringify(atDefault))

    // (a) THE NON-VACUOUS HALF, exactly as tests 1 and 2 do it for the editor
    // pane. If the preview pane is ever wide enough that an unscaled page fits
    // it outright, this fails LOUDLY rather than letting the assertions below
    // pass for free. Widening the app's default window past ~1050px is the
    // change that would trip it -- the same coupling window-bounds.ts already
    // records for Gates 28/29.
    expect(
      PAGE_WIDTH_PX,
      'the unscaled page must genuinely not fit the preview pane, or nothing below means anything'
    ).toBeGreaterThan(atDefault.bodyClientWidth)

    // (b) It really is scaled, in real laid-out pixels inside the sandbox --
    // this is the whole defect: fit-to-width shipped for the editor pane only,
    // leaving the preview beside it showing ~24% of a page at the divider
    // position that feature calls its success case.
    expect(atDefault.pageRenderedWidth).toBeLessThan(PAGE_WIDTH_PX)
    // Same inversion as the editor pane above: at the default divider the
    // preview now fits rather than landing on the floor. Asserted as the
    // property, with the same reasoning -- see MIN_FIT_SCALE.
    expect(atDefault.pageRenderedWidth).toBeLessThanOrEqual(
      atDefault.bodyClientWidth - FIT_GUTTER_PX
    )

    // --- Widen the PREVIEW, by dragging the divider the other way ----------
    // The mirror image of test 2: there the editor pane was given ~75% of the
    // row, here the preview is. A real mouse drag on the real divider, past
    // MIN_SPLIT_RATIO so it lands on the clamp rather than on pixel-accurate
    // mouse placement.
    const divider = win.getByTestId('split-divider')
    const dividerBox = await divider.boundingBox()
    expect(dividerBox).not.toBeNull()
    const row = await win.evaluate(() => {
      const el = document.querySelector('[data-testid="split-divider"]')?.parentElement
      if (!el) throw new Error('no split row')
      const r = el.getBoundingClientRect()
      return { left: r.left, width: r.width }
    })
    await win.mouse.move(dividerBox!.x + dividerBox!.width / 2, dividerBox!.y + 40)
    await win.mouse.down()
    await win.mouse.move(row.left + row.width * 0.1, dividerBox!.y + 40, { steps: 12 })
    await win.mouse.up()

    // The bounds report, the native setBounds, the sandbox's own `resize`
    // handler and the relayout all have to land, so poll rather than sample.
    await expect
      .poll(async () => (await probePreviewFit(app))?.bodyClientWidth ?? 0, {
        message: 'expected the drag to widen the preview pane',
        timeout: 15_000
      })
      .toBeGreaterThan(500)

    await expect
      .poll(async () => (await probePreviewFit(app))?.overflowPx ?? -1, {
        message: 'expected the widened preview to stop overflowing horizontally',
        timeout: 15_000
      })
      .toBe(0)

    const wide = (await probePreviewFit(app))!
    console.log('Gate 35 preview at widest divider:', JSON.stringify(wide))

    // TWO PARTS AGAIN: "it fits" is only interesting if the unscaled page
    // would NOT have fitted this same, widened pane.
    expect(
      PAGE_WIDTH_PX,
      'the unscaled page must still overflow even the widest preview pane, or "it fits" is free'
    ).toBeGreaterThan(wide.bodyClientWidth)
    expect(wide.pageRenderedWidth).toBeLessThanOrEqual(wide.bodyClientWidth)

    // And it got there by SCALING, not by re-paginating at a narrower page --
    // which would be the wrong fix, and would make page counts move as the
    // user dragged the divider.
    expect(wide.pageRenderedWidth).toBeLessThan(PAGE_WIDTH_PX)
    expect(wide.pageRenderedWidth).toBeGreaterThan(MIN_FIT_SCALE * PAGE_WIDTH_PX)

    // THE ASSERTION THAT MATTERS MOST IN THIS FILE, and the reason this test
    // uses a multi-page fixture: THE SCALE MUST NOT REACH PAGINATION.
    //
    // Everything else here is a presentation question -- get it wrong and the
    // preview looks bad. This one is a correctness question: the split
    // preview reports a page count that page navigation clamps against, while
    // the status bar, PDF export and thumbnails all paginate through their
    // OWN, unscaled harnesses. If the fit scale reached the `@page` box or
    // the content box, those two families would silently disagree, and the
    // disagreement would move as the user dragged the divider.
    //
    // Two genuinely different scales were applied to the SAME document in
    // this run (the floor at the default divider, and a real fit after the
    // drag -- both asserted above, so this cannot go vacuous by both being
    // 1). The page count has to be identical across them. The mechanism that
    // makes it so is in resources/pagination-render/index.ts: the scale is
    // reset before `previewer.preview()` and re-applied only after the result
    // -- including `pageCount` -- has been measured. This is the direct
    // analogue of Gate 19's "enabling running content does not change the
    // page count", and it is asserted rather than trusted for the same reason.
    expect(
      wide.pageCount,
      'the fit-to-width scale must never reach pagination -- the same document must produce the same page count at every scale'
    ).toBe(atDefault.pageCount)
    expect(
      atDefault.pageCount,
      'a single-page count would make the check above weak'
    ).toBeGreaterThan(1)
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})

test('Gate 35: Follow scroll reports the right page from a SCALED editor pane', async () => {
  test.setTimeout(120_000)

  const { close, win, fixtureDir, restoreRecents } =
    await openFixtureDocument(buildMultiPageFixture())

  try {
    await win.getByRole('button', { name: 'Split', exact: true }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')

    // Wait for the real page count to resolve -- Follow does nothing until it
    // has one, and the status-bar readout below is meaningless without it.
    await expect
      .poll(async () => (await measurePane(win)).appliedZoom, { timeout: 10_000 })
      .not.toBe('1')
    const scale = Number((await measurePane(win)).appliedZoom)
    expect(scale).toBeGreaterThan(0)
    expect(scale).toBeLessThan(1)

    const totalPages = await win.evaluate(async () => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const button = Array.from(document.querySelectorAll('button')).find((b) =>
          /^Page \d+ of \d+$/.test(b.getAttribute('aria-label') ?? b.textContent ?? '')
        )
        const label = button?.getAttribute('aria-label') ?? button?.textContent ?? ''
        const match = /^Page \d+ of (\d+)$/.exec(label)
        if (match) return Number(match[1])
        await new Promise((r) => setTimeout(r, 250))
      }
      return 0
    })
    expect(totalPages, 'expected a real multi-page count in the status bar').toBeGreaterThanOrEqual(
      4
    )

    // THE DISCRIMINATING SCROLL. The Format canvas now draws a real seam at
    // every page boundary, so it advances by a whole SHEET plus the gutter
    // between two sheets, not by a bare content box: 1056 + 24 = 1080 document
    // px per page for Letter/1in. The top of DOCUMENT page 3 is therefore
    // 2 x 1080 = 2160, and scrolling comfortably into page 3 must report 3.
    //
    // THIS CONSTANT MOVED FROM 864 (contentHeightPx) TO 1080 (page pitch) WHEN
    // SEAMS LANDED, and it is deliberately a hand-derived literal rather than
    // an import of computeEditorPagePitchPx -- Gate 16's rule: an expectation
    // computed by the code under test moves with that code's bugs, and this
    // gate would then pass green against wrong output.
    //
    // Reading the SCALE back out of the DOM (rather than hardcoding it) is a
    // different case and stays as it was: the arithmetic under test here is
    // the CONVERSION, not the particular scale, so the gate must not care
    // whether the floor or the window default moves.
    const PAGE_PITCH_PX = 1080
    const targetDocumentOffset = PAGE_PITCH_PX * 2 + 200
    const targetScrollTop = Math.round(targetDocumentOffset * scale)
    console.log(
      `Gate 35 Follow: scale ${scale}, scrolling the editor pane to scrollTop ${targetScrollTop} ` +
        `(document offset ${targetDocumentOffset}px, i.e. page 3 at a ${PAGE_PITCH_PX}px pitch)`
    )
    const achievedScrollTop = await win.evaluate((top) => {
      const card = document.querySelector('[data-testid="page-card"]') as HTMLElement
      const pane = card.closest('.overflow-auto') as HTMLElement
      pane.scrollTop = top
      return pane.scrollTop
    }, targetScrollTop)
    // A pane that cannot scroll that far clamps SILENTLY, and the page
    // assertion below would then be measuring a different offset than the one
    // this test reasoned about. Fail on the real cause instead.
    expect(
      achievedScrollTop,
      'the editor pane must genuinely scroll to the requested offset, not clamp short of it'
    ).toBeCloseTo(targetScrollTop, 0)

    // Follow samples on a 500ms interval and the resulting navigation goes
    // through the real serialized harness queue, so poll rather than sampling.
    //
    // WHY PAGE 3 IS THE WHOLE POINT: without the scale conversion the same
    // scrollTop reads as floor(targetScrollTop / 1080) + 1, which is page 2 at
    // the 0.7 floor and page 1 at 0.4 -- a plausible, silent,
    // off-by-one-or-two-page wrong answer rather than a crash. This assertion
    // is the only place in the suite that can tell those two apart.
    await expect(win.getByRole('button', { name: `Page 3 of ${totalPages}` })).toBeVisible({
      timeout: 20_000
    })
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})
