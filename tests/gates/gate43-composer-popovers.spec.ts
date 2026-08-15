import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile, rm, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../../src/main/recent-files'
import { launchIsolatedApp } from './electron-launch'

// Gate 43 -- the Insert-link and Add-comment COMPOSER POPOVERS, against the
// REAL built app.
//
// Both were full-width LAYOUT ROWS at the top of the editor until this change,
// for a real reason: a WebContentsView (Split mode's live preview) composites
// above ALL DOM unconditionally, so a floating panel is silently painted over.
// SelectionBubble later solved that properly -- clamping into
// `intersect(canvasRect, editorPaneRect)`, a rect the editor pane and the
// native view are disjoint halves of -- and lib/floating-position.ts was
// written generic on purpose. The composers now reuse it via FloatingCard. So
// this gate has to establish the two things that move together: the popovers
// really are AT THE SELECTION, and they really are still CLEAR OF the native
// view.
//
// NUMBERED 43, not 42: `git ls-tree main tests/gates/` showed 41 as the highest
// COMMITTED gate, with an uncommitted gate42 present in the working tree from
// concurrent work. CLAUDE.md records Find & Replace and Page Navigation
// colliding on 17 during exactly this situation, so the untracked file is
// treated as claimed rather than as a free number.
//
// WHY A GATE AT ALL, given 15 new unit tests: none of them can see a pixel.
// `view.coordsAtPos()` does NOT throw under jsdom -- it silently returns
// ALL-ZERO rects (this repo's test-setup.ts polyfills Range.getClientRects
// with zeros), so a jsdom test asserting "the popover sits by the selection"
// passes against {0,0,0,0} and proves nothing. lib/floating-position.test.ts
// proves the clamp ARITHMETIC; only this proves the real rects fed into it are
// the right rects, and only this exercises a real Chromium focus change.
//
// The four things asserted, each structurally impossible under jsdom:
//
//   1. Clicking the bubble's Link button opens a real, PAINTED popover
//      (non-zero box at opacity 1 -- SelectionBubble/FloatingCard mount at
//      opacity 0 and only reach 1 once the callback ref has measured, so this
//      is a real assertion that the measurement path runs, and one jsdom can
//      never satisfy).
//   2. It is anchored to the SELECTED TEXT'S OWN independently-measured client
//      rect, not parked at the top of the window -- literally the user-visible
//      complaint that prompted the change.
//   3. THE FOCUS PROPERTY, end to end: the field takes real DOM focus, the
//      user types a URL through Chromium's real input pipeline, and the link
//      lands on the ORIGINALLY SELECTED range and reaches DISK. A composer
//      that dropped the selection when focus left the editor would leave the
//      file unmarked -- there is no other real-app proof of this, and it is
//      the single most likely way the popover move could have broken the
//      feature (SelectionBubble is safe only because it preventDefaults its
//      own mousedown; a composer cannot, because it must be typed into).
//   4. THE OCCLUSION INVARIANT, in Split mode with the real WebContentsView
//      attached -- asserted in TWO PARTS, per this suite's own anti-vacuity
//      rule (Gate 28/29): that the unclamped, anchor-centred position genuinely
//      WOULD have reached into the native view's column, AND that the real one
//      does not. Widen the window far enough and the FIRST half fails loudly
//      rather than the second half passing silently.
//
// Uses launchIsolatedApp (never a bare electron.launch()) and wraps close() in
// try/finally at every call site -- that helper owns the timeout bound, the
// SIGKILL fallback and the temp-directory cleanup.
//
// MEASURED VALUES, at the default 1000x840 window, zoom 1.0 -- recorded so a
// later reader knows how much slack each bound really has:
//
//   Format mode (test 1) --
//     popover  {x: 342.0625, y: 343.6328125, w: 300, h: 105.25}
//     selection{x: 312,      y: 456.8828125, w: 360.125, h: 19}
//     gap below the popover = EXACTLY 8.00px, i.e. FLOATING_ANCHOR_GAP.
//     popover centre 492.0625 vs selection centre 492.0625 -- exact to the
//     last measured decimal, across two INDEPENDENT measurements (Playwright's
//     boundingBox() of the popover, and the page's own DOM Selection rect
//     captured before focus moved).
//
//   Split mode (test 2), splitRatio 50 --
//     popover {x: 277, y: 231.796875, w: 320, h: 82} -> right edge 597.00
//     native preview view {x: 611, y: 123, w: 389, h: 653}
//     clearance 14.00px, which is exactly FLOATING_EDGE_PAD (8) + the split
//     divider (6) -- the popover is flush against the safe rect's right edge,
//     so the clamp is not merely satisfied, it is BINDING.
//     Unclamped it would have reached 667.84 -- 56.84px INSIDE that column.
//
// MUTATION-VERIFIED rather than assumed to discriminate: replacing
// FloatingCard's `rects.safe ?? viewportRect()` with a bare `viewportRect()`
// (typecheck-clean, so `pnpm build` genuinely rebuilt -- CLAUDE.md records a
// gate mutation silently testing a STALE out/ because the mutation left an
// unused variable and the build aborted) fails test 2 by name at line 445:
// "Expected: <= 611, Received: 667.84375". Restored, it passes again.
//
// FLAKE NOTE, inherited rather than newly observed: a bare `Test timeout` plus
// `Worker teardown timeout` that reaches NO assertion is this suite's
// documented launch-under-host-load flake. Localized here by instrumentation
// rather than assumed: a `console.error` immediately before and after
// `launchIsolatedApp` printed only the FIRST on every such run, i.e. the hang
// is inside the helper, before a line of this gate's own logic executes.
// Established as environmental by the back-to-back control this suite's own
// methodology demands: over three alternating rounds, gate43 passed 6/6 tests
// in 1.1-1.6s each while the UNMODIFIED gate28 hung 2 of 3 rounds with the
// identical signature. A real regression here surfaces as a NAMED assertion
// failure. Re-run on a quiet host before diagnosing.

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

interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface OpenedFixture {
  app: ElectronApplication
  close: () => Promise<void>
  win: Page
  fixtureDir: string
  fixturePath: string
  restoreRecents: () => Promise<void>
}

// Same seed-into-recents-then-click-through-the-Home-screen approach as
// gate17/gate20/gate27/gate28's own openFixtureDocument. Opening through the
// real Home screen (rather than any test-only entry point) is what makes the
// fixture path a genuinely KNOWN path, so the later Save writes straight to
// disk with no native dialog for Playwright to be unable to dismiss.
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

  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate43-'))
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const fixtureFilename = `gate43-fixture-${nonce}.md`
  const fixturePath = join(fixtureDir, fixtureFilename)
  await writeFile(fixturePath, body, 'utf8')

  const originalRecents = await readRecentFiles(userDataDir)
  const restoreRecents = async (): Promise<void> => {
    await writeRecentFiles(userDataDir, originalRecents)
  }

  const seeded = mergeRecentFiles(originalRecents, fixturePath, new Date().toISOString())
  await writeRecentFiles(userDataDir, seeded)

  await win.reload()
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
  await win
    .getByRole('button', { name: new RegExp(fixtureFilename.replace(/[.]/g, '\\.')) })
    .click()
  await win.waitForSelector('.milkdown-mount .ProseMirror')

  return { app, close, win, fixtureDir, fixturePath, restoreRecents }
}

// The REAL on-screen box of the REAL DOM selection, measured by real Chromium
// layout -- an INDEPENDENT measurement of the same thing readSelectionRect()
// derives from coordsAtPos, so agreement between the two is evidence rather
// than tautology. Lifted verbatim from gate28.
async function readSelectionBox(win: Page): Promise<Box | null> {
  return win.evaluate(() => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  })
}

// gate15/gate18/gate28's probe, narrowed to the one fact this gate needs. It
// goes through app.evaluate() because contextBridge DEEP-FREEZES window.api
// and because a WebContentsView is not a top-level window app.windows() can
// enumerate; it filters to an on-screen rectangle because this same window
// also hosts the permanently off-screen Phase 0 spike view.
async function probeSplitPreviewBounds(app: ElectronApplication): Promise<Box | null> {
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
        const b = child.getBounds()
        return b.x >= 0 && b.y >= 0 && b.width > 0 && b.height > 0
      }
    )
    if (!splitView) return null
    const bounds = splitView.getBounds()
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
  })
}

// Leading paragraphs for the same measured reason gate28 states: the popover's
// PREFERRED placement is above its anchor, and computeFloatingPosition only
// keeps that placement when it clears `safe.top + FLOATING_EDGE_PAD`. A target
// on the first line would legitimately flip below, and this gate would then be
// pinning the fallback rather than the intended behaviour. The link popover is
// taller than the bubble (a label, a field and a button row), so it needs MORE
// room above than gate28's fixture does -- hence three leading paragraphs
// rather than two.
const TARGET_SENTENCE = 'Link this whole target sentence with a real triple click.'

const FORMAT_FIXTURE = `# Gate 43 Fixture

Leading paragraph one, present so the target below sits far enough down the page that the popover's preferred above-the-anchor placement has real room inside the safe rect.

Leading paragraph two, same purpose as the one above it.

Leading paragraph three, because the link popover is a good deal taller than the selection bubble and therefore needs more clearance above the anchor.

${TARGET_SENTENCE}
`

const LINK_URL = 'https://example.com/gate43'

test('Gate 43: the link composer opens AT the selection, and its URL reaches disk', async () => {
  test.setTimeout(90_000)

  const fixture = await openFixtureDocument(FORMAT_FIXTURE)
  const { close, win, fixtureDir, fixturePath, restoreRecents } = fixture

  try {
    const target = win.locator('.milkdown-mount .ProseMirror p').filter({ hasText: 'triple click' })
    await expect(target).toHaveText(TARGET_SENTENCE)

    // Nothing open yet. Asserted BEFORE the interaction so a composer that
    // were simply always mounted could not pass this gate by accident.
    const popover = win.getByRole('group', { name: 'Insert link' })
    await expect(popover).toHaveCount(0)

    // A real triple-click -- the gesture gate27/gate28 both settled on, because
    // a synthesised click+Home+Shift+End measurably did not produce the
    // non-empty single-block selection it looks like it should.
    await target.click({ clickCount: 3 })
    const bubble = win.getByRole('toolbar', { name: 'Text formatting' })
    await expect(bubble).toBeVisible()

    // MEASURED NOW, BEFORE THE COMPOSER OPENS -- and that ordering is a real
    // finding this gate made rather than a stylistic preference. gate28 reads
    // the selection box AFTER acting, because a bubble click never moves DOM
    // focus (it preventDefaults its own mousedown). A composer MUST move focus
    // into its field, and the first draft of this gate, copying gate28's
    // ordering, failed here in 881ms with `expect(selectionBox).not.toBeNull()`:
    // once an <input> holds focus, `window.getSelection()` reports the INPUT's
    // own collapsed selection, so the contenteditable's range is not merely
    // painted differently -- it is not reachable through the DOM Selection API
    // at all. That is exactly why the disk round trip at the end of this test
    // is the load-bearing assertion: ProseMirror's `state.selection` is
    // document state and survives regardless, which is the entire premise the
    // popover rests on, and nothing about the DOM Selection can show it.
    const selectionBox = await readSelectionBox(win)
    expect(selectionBox).not.toBeNull()
    expect(selectionBox!.width).toBeGreaterThan(0)

    // Opened from the BUBBLE, not the toolbar, deliberately: that is the exact
    // path the user's complaint describes ("we already show a bubble... why
    // does Link show the input at the top instead"), and it sidesteps the
    // toolbar-reachability problem gate27 had to work around entirely.
    await bubble.getByRole('button', { name: 'Insert link' }).click()

    // (1) Really there, really painted. `toBeVisible` alone is NOT this
    // assertion -- Playwright's visibility check ignores opacity, and
    // FloatingCard mounts at opacity 0 until its callback ref has measured, so
    // reaching 1 is proof that path actually ran in a real browser.
    await expect(popover).toBeVisible()
    await expect(popover).toHaveCSS('opacity', '1')
    const popoverBox = await popover.boundingBox()
    expect(popoverBox).not.toBeNull()
    expect(popoverBox!.width).toBeGreaterThan(150)
    expect(popoverBox!.height).toBeGreaterThan(40)

    // It is a real floating overlay, not the layout row it used to be. Pinned
    // structurally as well as geometrically, because the two failure modes are
    // different: a row that happened to sit near the selection would satisfy
    // the geometry below by luck.
    await expect(popover).toHaveCSS('position', 'fixed')

    // (2) ANCHORED TO THE SELECTION -- against the rect captured above, from
    // the real DOM Selection while it still existed. That measurement is
    // INDEPENDENT of the one the popover was placed by (readSelectionRect, via
    // ProseMirror's coordsAtPos), so agreement between them is evidence rather
    // than a restatement.
    //
    // Recorded because it is the counter-intuitive half: the DOM Selection is
    // gone by now (see the note above), so the popover is sitting exactly on a
    // range the browser no longer reports as selected. It can, because
    // FloatingCard re-measures through ProseMirror's own document positions
    // rather than through `window.getSelection()`.
    expect(await readSelectionBox(win)).toBeNull()

    // The blunt version of the user's actual complaint: the field is no longer
    // parked in a strip at the top of the window. The toolbar occupies roughly
    // the first 45px and the old row sat immediately under it, so anything
    // still up there fails here.
    expect(popoverBox!.y).toBeGreaterThan(120)

    // Immediately ABOVE the anchor by the real FLOATING_ANCHOR_GAP. A range
    // rather than an exact 8px, to absorb sub-pixel line-box rounding between
    // two independent measurements -- but tight enough that "somewhere above"
    // and "immediately above" are genuinely different outcomes.
    const gap = selectionBox!.y - (popoverBox!.y + popoverBox!.height)
    expect(gap).toBeGreaterThanOrEqual(2)
    expect(gap).toBeLessThanOrEqual(16)

    // Horizontally centred on the anchor.
    const popoverCenterX = popoverBox!.x + popoverBox!.width / 2
    const selectionCenterX = selectionBox!.x + selectionBox!.width / 2
    expect(Math.abs(popoverCenterX - selectionCenterX)).toBeLessThanOrEqual(3)

    // (3) THE FOCUS PROPERTY. The field genuinely holds DOM focus -- read from
    // the real document.activeElement, so this is not an inference from
    // `autoFocus` being present in the source.
    const field = popover.getByRole('textbox', { name: 'Link URL' })
    await expect(field).toBeFocused()

    // Real keystrokes through Chromium's own input pipeline, with focus firmly
    // outside the editor for the whole run, then a real Enter.
    await field.type(LINK_URL)
    await win.keyboard.press('Enter')

    // The link landed on the ORIGINALLY SELECTED text, in the live document.
    await expect(target.locator('a')).toHaveText(TARGET_SENTENCE)
    await expect(popover).toHaveCount(0)

    // ...and reached DISK. This hop is the only real proof that ProseMirror's
    // selection survived DOM focus moving into the field: a dropped or
    // collapsed selection would leave the file unlinked while everything above
    // still passed.
    await win.getByRole('button', { name: 'Save' }).click()
    await expect
      .poll(
        async () =>
          (await readFile(fixturePath, 'utf8')).includes(`[${TARGET_SENTENCE}](${LINK_URL})`),
        {
          message: 'expected the popover’s URL to reach the real saved file, on the selected text',
          timeout: 10_000
        }
      )
      .toBe(true)
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})

// One long line, sized to run most of the way across the 624px content column,
// so its LAST WORD sits near the right edge of Split mode's left pane at every
// scale -- gate28's own retuned fixture shape, and for the reason recorded
// there: a whole-line selection's midpoint moves left once the page is fitted
// to the pane, which quietly un-exercises the clamp.
const WIDE_TARGET =
  'This deliberately long target line runs right across the whole content column width.'

const SPLIT_FIXTURE = `# Gate 43 Split Fixture

Leading paragraph, present so the wide target line below is not the first block on the page.

${WIDE_TARGET}
`

test('Gate 43: in Split mode the comment composer is clamped clear of the real preview view', async () => {
  test.setTimeout(90_000)

  const fixture = await openFixtureDocument(SPLIT_FIXTURE)
  const { app, close, win, fixtureDir, restoreRecents } = fixture

  try {
    // Only the permanently off-screen Phase 0 spike view exists yet, which the
    // probe's own bounds filter excludes.
    expect(await probeSplitPreviewBounds(app)).toBeNull()

    // `exact: true` additionally rules out the unrelated "Split cell" table
    // toolbar button, per gate15.
    await win.getByRole('button', { name: 'Split', exact: true }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')

    let splitBounds: Box | null = null
    await expect
      .poll(
        async () => {
          splitBounds = await probeSplitPreviewBounds(app)
          return splitBounds !== null
        },
        {
          message: 'expected the real split-preview WebContentsView to be attached and on screen',
          timeout: 20_000
        }
      )
      .toBe(true)
    const preview = splitBounds as Box | null
    expect(preview).not.toBeNull()
    expect(preview!.width).toBeGreaterThan(50)

    const target = win
      .locator('.milkdown-mount .ProseMirror p')
      .filter({ hasText: 'whole content column width' })
    await expect(target).toHaveText(WIDE_TARGET)

    // Select the LAST WORD, via real keystrokes -- gate29 established
    // ArrowRight/Shift+ArrowLeft as the deterministic technique in exactly
    // this geometry, and a coordinate-addressed click into a line extending
    // past the pane's visible width is precisely the actionability problem
    // gate27 documents.
    await target.click({ clickCount: 3 })
    await win.keyboard.press('ArrowRight')
    for (let i = 0; i < 'width.'.length; i += 1) {
      await win.keyboard.press('Shift+ArrowLeft')
    }
    await expect
      .poll(async () => win.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toBe('width.')

    // Captured BEFORE the composer takes focus -- see test 1's note: once an
    // <input> holds focus, `window.getSelection()` reports that input's own
    // collapsed selection and the contenteditable range is unreachable through
    // the DOM Selection API entirely.
    const selectionBox = await readSelectionBox(win)
    expect(selectionBox).not.toBeNull()

    const bubble = win.getByRole('toolbar', { name: 'Text formatting' })
    await expect(bubble).toBeVisible()
    await bubble.getByRole('button', { name: 'Add comment' }).click()

    // The comment popover is the WIDER of the two (320px against the link's
    // 300px), so it is the harder case for the clamp -- which is why this half
    // of the gate uses it rather than repeating the link.
    const popover = win.getByRole('group', { name: 'Add comment' })
    await expect(popover).toBeVisible()
    await expect(popover).toHaveCSS('opacity', '1')
    const popoverBox = await popover.boundingBox()
    expect(popoverBox).not.toBeNull()

    // THE CLAMP GENUINELY ENGAGED -- the anti-vacuity half. Without it, the
    // headline below could be satisfied by a selection that happened to sit
    // far enough left that no clamping was ever needed: a green test proving
    // nothing. The unclamped placement is anchor-centred, so this computes
    // exactly where the popover WOULD have been and asserts that position
    // really did reach into the native view's column.
    const selectionCenterX = selectionBox!.x + selectionBox!.width / 2
    const unclampedRight = selectionCenterX + popoverBox!.width / 2
    expect(unclampedRight).toBeGreaterThan(preview!.x)

    // (4) THE HEADLINE. The popover's right edge never reaches the native
    // view's left edge, so no part of it can be composited over -- the whole
    // reason the composers were allowed to stop being layout rows. Not
    // expressible in the DOM at all: the native view has no DOM presence for
    // any layout engine, or any floating-ui-style collision detector, to
    // reason about.
    expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(preview!.x)

    // Still a real, usable, typeable panel after the clamp -- not squashed to
    // nothing to satisfy the bound above. The field being focused is the same
    // property test 1 proves end to end; here it also shows the clamp did not
    // cost the popover its interactivity.
    expect(popoverBox!.width).toBeGreaterThan(150)
    await expect(popover.getByRole('textbox', { name: 'Comment text' })).toBeFocused()
    await expect(popover.getByRole('button', { name: 'Cancel' })).toBeVisible()
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})
