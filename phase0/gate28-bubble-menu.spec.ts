import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile, rm, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'
import { launchIsolatedApp } from './electron-launch'

// Gate 28 -- the bubble / floating selection menu (docs/superpowers/specs/
// 2026-08-09-bubble-menu-design.md), against the REAL built app.
//
// WHY THIS GATE IS UNUSUALLY LOAD-BEARING, and not merely "one more end-to-end
// pass over a feature that already has unit tests": the feature ships 62
// passing unit tests, and NONE OF THEM CAN SEE A PIXEL. Its own design doc
// records the measured reason, which is strictly worse than the `posAtCoords`
// precedent drop-image.ts already documents: `view.coordsAtPos()` does NOT
// throw under jsdom -- it silently returns ALL-ZERO rects, because bare jsdom
// implements neither Range.getClientRects nor Range.getBoundingClientRect and
// this repo's own test-setup.ts polyfills both with zeros (added for an
// unrelated ProseMirror scrollToSelection reason). So a jsdom test asserting
// "the bubble sits above the selection" passes against {0,0,0,0} and proves
// exactly nothing. lib/floating-position.test.ts proves the clamp RULE is
// correct arithmetic; only this gate proves the real rects fed INTO that rule
// are the right rects.
//
// The five things asserted here, each structurally impossible under jsdom:
//
//   1. A real Chromium text selection genuinely POPS the bubble, with a
//      non-zero boundingBox() -- Gate 17's own lesson, that a DOM-present but
//      zero-area element passes every unit test and is invisible to a user.
//   2. It is anchored to the SELECTED TEXT'S OWN client rect (above it, and
//      horizontally centred on it) rather than parked at 0,0 -- the exact
//      failure mode the jsdom hazard above would hide.
//   3. Clicking its Bold button really bolds, and the SAVED FILE ON DISK
//      carries the emphasis markers. That last hop is also the only real proof
//      the bubble did not steal DOM focus or drop the selection on mousedown
//      (SelectionBubble's own preventDefault); a lost selection would leave
//      the document unchanged and the file unmarked.
//   4. THE OCCLUSION INVARIANT -- the headline. In Split mode, with the real
//      WebContentsView attached, a selection near the right edge of the left
//      pane produces a bubble whose right edge never reaches the native view's
//      left edge. This is the single assertion the whole design rests on: a
//      WebContentsView composites above ALL DOM unconditionally, so a bubble
//      that strays into that column is invisible with no error anywhere.
//   5. It hides on selection collapse and on Escape.
//
// Numbered 28 after re-checking `git ls-tree main phase0/` immediately before
// creation (27 was the highest; CLAUDE.md records Find&Replace and Page
// Navigation colliding on 17 during parallel work, so this is checked rather
// than assumed).
//
// Uses launchIsolatedApp (phase0/electron-launch.ts), never a bare
// electron.launch(), and wraps close() in try/finally at every call site --
// that helper now owns the timeout bound, the SIGKILL fallback and the
// temp-directory cleanup, so a call site only needs the try/finally.
//
// MEASURED VALUES, recorded here because these are the numbers the assertions
// below were tuned against and because a later reader deserves to know how
// much slack each bound really has (this gate's own equivalent of the
// findings-doc entry every other gate carries):
//
//   Format mode, default 900x670 window, zoom 1.0 --
//     bubble {x: 317.47, y: 301.29, w: 285.91, h: 36}
//     selection {x: 276, y: 345.29, w: 368.86, h: 19}
//     gap below the bubble = EXACTLY 8.00px, i.e. FLOATING_ANCHOR_GAP.
//     bubble centre 460.43 vs selection centre 460.43 -- exact to the last
//     measured decimal, across two INDEPENDENT measurements (Playwright's
//     boundingBox() of the bubble, and the page's own DOM Selection rect).
//
//   Split mode, splitRatio 50 --
//     bubble {x: 261.09, y: 239.70, w: 285.91, h: 36} -> right edge 547.00
//     native preview view {x: 561, y: 123, w: 339, h: 483}
//     clearance 14.00px, which is exactly FLOATING_EDGE_PAD (8) + the split
//     divider (6) -- the bubble is flush against the safe rect's right edge,
//     so the clamp is not merely satisfied, it is BINDING.
//     Had it not clamped, the anchor-centred right edge would have been
//     636.36 -- 75px INSIDE the native view's column.
//
// TWO DISTINCT FLAKE MODES were separated by instrumenting this file with
// per-step timestamps over ~40 repeat runs (load average 3-5 throughout).
// Recorded because they look identical in a CI log and are not:
//
//   (a) A LAUNCH HANG -- roughly 1 run in 5. The last thing logged is entry
//       into openFixtureDocument; `launchIsolatedApp` never returns, and the
//       test dies on its own 90s timeout having reached NO assertion, with an
//       error-context carrying no page snapshot. This is CLAUDE.md's
//       already-documented launch-under-host-load flake, localized here to
//       inside the helper, before a single line of this gate's own logic
//       runs. A successful launch takes ~300ms and the whole test body ~600ms,
//       so there is no gradual-slowdown story -- it either launches or hangs.
//       ENVIRONMENTAL, established by control rather than assumed: run back to
//       back in the same conditions, UNMODIFIED gate27 failed 2 of 4 runs and
//       UNMODIFIED gate11 1 of 4, with the identical signature (bare 90s "Test
//       timeout", no assertion reached, then "Worker teardown timeout"). This
//       gate's own rate over the same window was comparable. Earlier in the
//       same session, on a quieter machine, those same two controls had gone
//       4/4 and 3/3 while this gate flaked -- which is exactly why one calm
//       control run is not evidence of anything and the comparison has to be
//       made back to back. Re-run before diagnosing; do not chase it here.
//
//   (b) ONE Escape miss in ~25 runs that reached the assertion -- the bubble
//       stayed up for the full 5s window after a real Escape press. NOT
//       reproduced again in ~25 further attempts, so this is reported as an
//       observation with a hypothesis rather than a diagnosed bug, and NOTHING
//       IN THE IMPLEMENTATION WAS CHANGED for it. Most plausible mechanism:
//       SelectionBubble registers its Escape listener from a PASSIVE effect
//       gated on `visible`, so for the one frame between the bubble entering
//       the DOM (which is when Playwright's toBeVisible resolves) and React
//       flushing that effect, an Escape press has nothing listening for it.
//       User-facing impact would be a single dropped Escape immediately after
//       a selection, recoverable by pressing it again. The gate now presses
//       Escape against a SETTLED bubble (see the opacity assertion at that
//       step) which removes the race from the test without weakening what the
//       test claims.

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
// gate17/gate20/gate27's own openFixtureDocument. Opening through the real
// Home screen (rather than any test-only entry point) is what makes the
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

  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate28-'))
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const fixtureFilename = `gate28-fixture-${nonce}.md`
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
// layout. This is the rect the whole feature is supposed to be anchored to,
// and reading it from the page (rather than recomputing it from ProseMirror
// positions) is deliberate: it is an INDEPENDENT measurement of the same
// thing readSelectionRect() derives from coordsAtPos, so agreement between the
// two is evidence rather than tautology.
async function readSelectionBox(win: Page): Promise<Box | null> {
  return win.evaluate(() => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  })
}

// The real, on-screen split-preview WebContentsView's own bounds, read through
// Electron's public main-process API -- gate15/gate18's probe, narrowed to the
// one fact this gate needs.
//
// Two things about this shape are load-bearing and were established by those
// gates rather than by this one. It goes through app.evaluate() because
// contextBridge.exposeInMainWorld DEEP-FREEZES window.api (every method
// reports writable:false, configurable:false), making renderer-side
// interception of the bridge categorically impossible in a gate -- and because
// a WebContentsView is not a top-level window, so app.windows() cannot
// enumerate it either. And it filters to a genuinely ON-SCREEN rectangle
// because this same mainWindow already hosts a SECOND, unrelated
// pagedown-render:// view from app startup (src/main/index.ts's Phase 0 spike
// harness), parked permanently at {x:-9999, y:-9999}.
//
// It deliberately does NOT use the discouraged __pagedownPhase0 bridge.
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

// Leading paragraphs exist for one measurable reason: the bubble's PREFERRED
// placement is above the anchor, and computeFloatingPosition only keeps that
// placement when it still clears `safe.top + FLOATING_EDGE_PAD`. A target on
// the document's first line would legitimately flip below and this gate would
// then be pinning the fallback rather than the intended behaviour.
//
// The target sentence's own length is chosen, not arbitrary: long enough that
// its centre sits well clear of the safe rect's LEFT clamp (a short,
// left-aligned target would be clamped and the centring assertion below would
// be measuring the clamp instead), short enough to stay on ONE line inside the
// 624px content column so its union-of-both-ends anchor is exactly the line
// box a reader sees.
const TARGET_SENTENCE = 'Select this whole target sentence with a real triple click.'

const FORMAT_FIXTURE = `# Gate 28 Fixture

Leading paragraph one, present so the target below sits far enough down the page that the bubble's preferred above-the-anchor placement has real room inside the safe rect.

Leading paragraph two, same purpose as the one above it.

${TARGET_SENTENCE}
`

test('Gate 28: a real selection pops a real, painted bubble anchored to the selected text, whose Bold reaches disk', async () => {
  test.setTimeout(90_000)

  const fixture = await openFixtureDocument(FORMAT_FIXTURE)
  const { close, win, fixtureDir, fixturePath, restoreRecents } = fixture

  try {
    const target = win
      .locator('.milkdown-mount .ProseMirror p')
      .filter({ hasText: 'real triple click' })
    await expect(target).toHaveText(TARGET_SENTENCE)

    // Nothing is selected yet, so nothing may be floating. Asserted before the
    // selection rather than only after the dismissals at the end, so a bubble
    // that were simply always mounted could not pass this gate by accident.
    const bubble = win.getByRole('toolbar', { name: 'Text formatting' })
    await expect(bubble).toHaveCount(0)

    // A real triple-click -- the same real browser gesture gate27 settled on
    // for the same reason: it is a selection mechanism Chromium and
    // ProseMirror already agree on the meaning of, where a synthesised
    // click+Home+Shift+End sequence measurably did not produce the non-empty
    // single-block selection it looks like it should.
    await target.click({ clickCount: 3 })

    // (1) It is really there, and it really has area. `toBeVisible` alone is
    // NOT this assertion: Playwright's visibility check would already pass on
    // an element with a non-empty bounding box, but the failure Gate 17
    // documents -- present in the DOM, collapsed to zero area, invisible to a
    // user -- is exactly what a unit test cannot distinguish, so the box is
    // measured explicitly.
    await expect(bubble).toBeVisible()
    // Genuinely PAINTED, not merely laid out -- and this is a real assertion
    // rather than a settle. SelectionBubble mounts at `opacity: 0` and only
    // reaches 1 once its CALLBACK REF has measured its own size, so a real
    // browser reaching opacity 1 is proof that measurement path actually runs.
    // Under jsdom it never does (nothing is ever measured), which is exactly
    // why that component's own comment records the unmeasured state as
    // permanent there -- so this is a fact only a real-Chromium gate can
    // establish. Note toBeVisible() alone does NOT cover it: Playwright's
    // visibility check ignores opacity.
    await expect(bubble).toHaveCSS('opacity', '1')
    const bubbleBox = await bubble.boundingBox()
    expect(bubbleBox).not.toBeNull()
    expect(bubbleBox!.width).toBeGreaterThan(0)
    expect(bubbleBox!.height).toBeGreaterThan(0)
    // Nine real buttons plus two dividers -- a bubble that had rendered but
    // collapsed its contents would still be non-zero, so this pins a
    // plausible real toolbar rather than merely a non-empty box.
    expect(bubbleBox!.width).toBeGreaterThan(150)
    expect(bubbleBox!.height).toBeGreaterThan(20)
    await expect(bubble.getByRole('button')).toHaveCount(9)

    // (2) It is anchored to the SELECTION, not parked at the origin. The
    // selection box here is measured independently, from the real DOM
    // Selection, so agreement with the bubble's placement is evidence about
    // readSelectionRect/coordsAtPos rather than a restatement of it.
    const selectionBox = await readSelectionBox(win)
    expect(selectionBox).not.toBeNull()
    expect(selectionBox!.width).toBeGreaterThan(0)

    // The blunt "not parked at 0,0" check, stated separately from the precise
    // ones below because it is the failure the jsdom hazard would produce: an
    // all-zero anchor clamps to safe.left/safe.top and lands in the top-left
    // corner of the content area, which every relative assertion below would
    // still be satisfied by if the SELECTION were also at the origin.
    expect(bubbleBox!.x).toBeGreaterThan(100)
    expect(bubbleBox!.y).toBeGreaterThan(50)

    // Above the anchor, by the real FLOATING_ANCHOR_GAP. A range rather than
    // an exact 8px, to absorb sub-pixel line-box rounding between the two
    // independent measurements -- but tight enough that "somewhere above" and
    // "immediately above" are genuinely different outcomes here.
    const gap = selectionBox!.y - (bubbleBox!.y + bubbleBox!.height)
    expect(gap).toBeGreaterThanOrEqual(2)
    expect(gap).toBeLessThanOrEqual(16)

    // Horizontally centred on the anchor, and therefore overlapping it.
    const bubbleCenterX = bubbleBox!.x + bubbleBox!.width / 2
    const selectionCenterX = selectionBox!.x + selectionBox!.width / 2
    expect(Math.abs(bubbleCenterX - selectionCenterX)).toBeLessThanOrEqual(3)
    expect(bubbleBox!.x).toBeLessThan(selectionBox!.x + selectionBox!.width)
    expect(bubbleBox!.x + bubbleBox!.width).toBeGreaterThan(selectionBox!.x)

    // (3) A real click on the bubble's own Bold button -- scoped INSIDE the
    // bubble, since the persistent EditorToolbar carries a Bold button of its
    // own with the same accessible name, and an unscoped locator would
    // silently prove the wrong surface works.
    await bubble.getByRole('button', { name: 'Bold' }).click()
    await expect(target.locator('strong')).toHaveText(TARGET_SENTENCE)

    // Still up, still anchored, and now reporting itself as pressed -- which
    // is only reachable if the selection genuinely survived the click
    // (markActive reads the live selection, and a collapsed or lost one would
    // report the caret's stored marks instead).
    await expect(bubble.getByRole('button', { name: 'Bold' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    // The disk round trip. A bubble that stole DOM focus or dropped the
    // selection on mousedown would leave the document untouched and this file
    // unmarked -- there is no other automated proof of that property.
    await win.getByRole('button', { name: 'Save' }).click()
    await expect
      .poll(async () => (await readFile(fixturePath, 'utf8')).includes(`**${TARGET_SENTENCE}**`), {
        message: 'expected the bubble’s Bold to reach the real saved file',
        timeout: 10_000
      })
      .toBe(true)

    // (5a) Collapsing the selection hides it. ArrowRight is a real key press
    // through Chromium's own input pipeline, so this exercises the real
    // ProseMirror transaction -> plugin update -> React path.
    await win.keyboard.press('ArrowRight')
    await expect(bubble).toHaveCount(0)

    // (5b) ... and Escape dismisses it for a live, still-selected range. Done
    // in this order deliberately: the dismissal is stored as the dismissed
    // RANGE, so pressing Escape first would keep the bubble suppressed for
    // this same selection and the collapse check above would pass vacuously.
    await target.click({ clickCount: 3 })
    await expect(bubble).toBeVisible()
    // Wait for the bubble to be SETTLED (measured, hence painted) before the
    // key press, rather than acting on the first frame it exists in the DOM.
    // This is not padding, and the reason is a real observation recorded in
    // the header's flake note: the Escape handler is registered from a passive
    // effect, so a press landing before React has flushed that effect is
    // silently dropped -- observed ONCE in ~25 reaching runs, with the bubble
    // then staying up for the full 5s assertion window. Asserting that Escape
    // dismisses a bubble the user can actually see is the same claim, minus a
    // frame-boundary race that belongs to React's scheduling rather than to
    // this feature.
    await expect(bubble).toHaveCSS('opacity', '1')
    await win.keyboard.press('Escape')
    await expect(bubble).toHaveCount(0)
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})

// One long line, sized to run most of the way across the 624px content column.
// That matters: in Split mode the left pane is ~339px wide while the page card
// is a FIXED 816px, so the card overflows to the right and the far end of this
// line sits at a viewport x well past the pane's own right edge -- which is
// precisely the geometry that puts an unclamped, anchor-centred bubble
// underneath the native preview view. A short line would leave the clamp
// unexercised and the headline assertion below would pass without meaning
// anything, so the test asserts the clamp genuinely engaged as well.
const WIDE_TARGET =
  'This deliberately long target line runs right across the whole content column width.'

const SPLIT_FIXTURE = `# Gate 28 Split Fixture

Leading paragraph, present so the wide target line below is not the first block on the page.

${WIDE_TARGET}
`

test('Gate 28: in Split mode the bubble is clamped clear of the real preview WebContentsView', async () => {
  test.setTimeout(90_000)

  const fixture = await openFixtureDocument(SPLIT_FIXTURE)
  const { app, close, win, fixtureDir, restoreRecents } = fixture

  try {
    // No on-screen split view exists yet -- only the permanently off-screen
    // Phase 0 spike one, which the probe's own bounds filter excludes.
    expect(await probeSplitPreviewBounds(app)).toBeNull()

    // `exact: true` additionally rules out the unrelated "Split cell" table
    // toolbar button, per gate15.
    await win.getByRole('button', { name: 'Split', exact: true }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')

    // The real native view has to be genuinely attached and on screen before
    // any of this means anything -- the whole point is a geometric proof
    // ABOUT that view, so a test that ran before it existed would be proving
    // nothing while looking green.
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

    // FIXTURE RETUNE, not a weakened assertion -- both assertions below are
    // byte-identical to what they always were, and the same precedent CLAUDE.md
    // already records for Gate 4/Gate 6's synthetic-table fixture (60 -> 35
    // rows, "to again produce the 2-page split it was written to exercise").
    //
    // This test used to triple-click the whole line and let the SELECTION'S
    // MIDPOINT land under the native preview's column. That worked only
    // because the page card overflowed the pane at a fixed 816px, so a
    // full-line selection's midpoint sat far to the right. Split mode now
    // fits the page to the pane (src/renderer/src/lib/fit-scale.ts), which
    // moves that midpoint left -- measured 553.34 against a preview at x=611 --
    // and the "clamp is binding" half above correctly FAILED LOUDLY rather
    // than the headline passing silently. That is this gate's own two-part
    // design working, and the right response is to restore the scenario the
    // gate describes, not to relax what it claims.
    //
    // Selecting the LAST WORD instead is a strictly better fixture for the
    // sentence this test's own header already uses -- "a selection near the
    // right edge of the left pane" -- and, unlike a whole-line selection, it
    // stays near that edge at EVERY scale, including a page that fits the pane
    // exactly. So this retune also removes the hidden dependency on the card
    // overflowing that made the original fragile in the first place.
    //
    // Driven by real keystrokes through Chromium's own input pipeline rather
    // than by a positioned dblclick: gate29 already establishes
    // ArrowRight/ArrowLeft caret movement as the deterministic technique in
    // this exact geometry, and a coordinate-addressed click into a line that
    // extends past the pane's visible width is precisely the actionability
    // problem gate27 documents.
    await target.click({ clickCount: 3 })
    await win.keyboard.press('ArrowRight') // collapse to the line's end
    const LAST_WORD_CHARS = 'width.'.length
    for (let i = 0; i < LAST_WORD_CHARS; i += 1) {
      await win.keyboard.press('Shift+ArrowLeft')
    }
    await expect
      .poll(async () => win.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toBe('width.')

    const bubble = win.getByRole('toolbar', { name: 'Text formatting' })
    await expect(bubble).toBeVisible()
    const bubbleBox = await bubble.boundingBox()
    expect(bubbleBox).not.toBeNull()
    expect(bubbleBox!.width).toBeGreaterThan(0)
    expect(bubbleBox!.height).toBeGreaterThan(0)

    const selectionBox = await readSelectionBox(win)
    expect(selectionBox).not.toBeNull()

    // The clamp GENUINELY ENGAGED. Without this, the headline assertion below
    // could be satisfied by a selection that happened to sit far enough left
    // that no clamping was ever needed -- a green test proving nothing. The
    // unclamped placement is anchor-centred, so this computes exactly where
    // the bubble WOULD have been and asserts that position really did reach
    // into the native view's column.
    const selectionCenterX = selectionBox!.x + selectionBox!.width / 2
    const unclampedRight = selectionCenterX + bubbleBox!.width / 2
    expect(unclampedRight).toBeGreaterThan(preview!.x)

    // (4) THE HEADLINE. The bubble's right edge never reaches the native
    // view's left edge, so no part of it can be composited over. This one
    // assertion is what the entire "clamp into intersect(canvas, pane)"
    // design exists to guarantee, and it is not expressible in the DOM at all
    // -- the native view has no DOM presence for any layout engine, or any
    // floating-ui-style collision detector, to reason about.
    expect(bubbleBox!.x + bubbleBox!.width).toBeLessThanOrEqual(preview!.x)

    // Still a real, painted, usable toolbar after the clamp -- not squashed
    // to nothing to satisfy the bound above.
    expect(bubbleBox!.width).toBeGreaterThan(150)
    expect(bubbleBox!.height).toBeGreaterThan(20)
    await expect(bubble.getByRole('button', { name: 'Bold' })).toBeVisible()

    // And it stayed inside the left pane on the other three sides too, which
    // is the same safe rect stated as a box rather than as one edge.
    const pane = await win.getByTestId('page-card').boundingBox()
    expect(pane).not.toBeNull()
    expect(bubbleBox!.x).toBeGreaterThanOrEqual(pane!.x)
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})
