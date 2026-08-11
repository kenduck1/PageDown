import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'
import { PAGE_WIDTH_PX } from '../src/typography/page-geometry'
import { MIN_FIT_SCALE } from '../src/renderer/src/lib/fit-scale'
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
//     visible, horizontal scroll extent 427px). Fit needs 0.472, below the
//     0.70 floor, so the floor binds: card 571.2px, scroll extent 182px.
//   divider 75% -- pane clientWidth 585. Fit needs 0.712 -> 0.71 applied,
//     card 579.4px, scrollWidth == clientWidth, no horizontal scroll at all.
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

    // At this pane width the exact fit falls below the floor, so the floor is
    // what is applied -- and the floor is deliberately NOT "whatever fits".
    // Pinned against the shared constant rather than a literal so the two
    // cannot drift, but computed independently of computeFitScale itself so a
    // bug in that function cannot define its own expected value.
    expect(split.cardRenderedWidth).toBeCloseTo(MIN_FIT_SCALE * PAGE_WIDTH_PX, 1)

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
    // over a pane rendering at 70% is the same defect this control was already
    // fixed for once, pointing the other way.
    const zoomSelect = win.getByLabel('Zoom level')
    await expect(zoomSelect).toBeDisabled()
    await expect(zoomSelect).toHaveValue(String(MIN_FIT_SCALE))

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

    // THE DISCRIMINATING SCROLL. `contentHeightPx` for Letter/1in is 864px, so
    // the top of DOCUMENT page 3 is 2 x 864 = 1728 document px -- which, in
    // the scaled pane's own coordinate space, is 1728 * scale. Scrolling a
    // little past that must report page 3.
    //
    // Reading the scale back out of the DOM (rather than hardcoding 0.7) is
    // what keeps this honest if the floor or the window default ever moves:
    // the arithmetic under test is the CONVERSION, not the particular scale.
    const CONTENT_HEIGHT_PX = 864
    const targetScrollTop = Math.round((CONTENT_HEIGHT_PX * 2 + 40) * scale)
    console.log(
      `Gate 35 Follow: scale ${scale}, scrolling the editor pane to scrollTop ${targetScrollTop} ` +
        `(document offset ${Math.round(targetScrollTop / scale)}px, i.e. page 3)`
    )
    await win.evaluate((top) => {
      const card = document.querySelector('[data-testid="page-card"]') as HTMLElement
      const pane = card.closest('.overflow-auto') as HTMLElement
      pane.scrollTop = top
    }, targetScrollTop)

    // Follow samples on a 500ms interval and the resulting navigation goes
    // through the real serialized harness queue, so poll rather than sampling.
    //
    // WHY PAGE 3 IS THE WHOLE POINT: without the scale conversion the same
    // scrollTop reads as floor(1249 / 864) + 1 = page 2 -- a plausible,
    // silent, off-by-one-page wrong answer rather than a crash. This assertion
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
