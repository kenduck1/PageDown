import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'
import { launchIsolatedApp } from './electron-launch'

// Gate 29 -- the slash-command palette (.superpowers/sdd/2026-08-09-slash-menu),
// against the REAL built app. Numbered 29 after checking `git ls-tree main
// phase0/` and `ls phase0/` immediately before creation: 28 (bubble menu) was
// the highest, so 29 was free (CLAUDE.md records Find&Replace/Page
// Navigation colliding on 17 during parallel work -- this was checked, not
// assumed).
//
// WHY THIS GATE MATTERS: the feature ships 1160 passing unit tests, but Task
// 5's own report is explicit that NONE of them drive a genuine keyboard "/"
// keystroke through Chromium's real input pipeline -- `insertedSingleSlash`
// (slash-plugin.ts) requires the transaction that opens a session to be
// EXACTLY a single-character ReplaceStep inserting "/", and a synthesized
// jsdom DOM-mutation cannot reliably reproduce that shape (confirmed by that
// report's own probe: the edit lands, but no session opens). Only a real
// browser's own native contenteditable input path proves this feature's
// central trigger condition actually fires.
//
// A REAL, PREVIOUSLY UNKNOWN BROWSER-INTERACTION FINDING, surfaced by
// building this gate (see this file's own "known limitation" note near the
// bottom for the full writeup, and the Task 6 report for the investigation):
// typing "/" immediately after a SPACE typed at the absolute end of an
// existing line does NOT open a session in real Chromium, even though the
// design doc's own "Open only when ... after whitespace" rule says it
// should. Root cause: Chromium's contenteditable normalizes a genuinely
// trailing space to a non-breaking space (`&nbsp;`), and typing the very
// next character (here, "/") triggers Chromium to convert that nbsp BACK to
// a plain space as part of the SAME DOM mutation that inserts the new
// character -- so the resulting ProseMirror transaction is not a bare
// single-character insert, and `insertedSingleSlash` correctly (per its own
// literal contract) refuses to treat it as one. This is a real, disclosed
// interaction between a Chromium editing quirk and this feature's
// deliberately narrow transaction-shape check, not a bug in this gate's own
// mechanics -- confirmed by isolating it against the mid-line case (typing
// "/" right after an EXISTING space in the middle of a line, not one just
// typed at a line's end, opens correctly every time) and the empty-paragraph
// case (typing "/" as the first character of a block opens correctly every
// time). Both of THOSE are what this gate exercises below; the trailing-
// space-at-line-end case is a real, narrower gap this gate does not exercise
// (see the note near the bottom) and does not fix -- fixing it would need a
// deliberate design decision about how `insertedSingleSlash` should treat a
// multi-character-but-net-single-visible-character DOM mutation, not a
// one-line patch, and is out of this task's scope.
//
// The four things asserted here, each structurally impossible under jsdom:
//
//   1. A real "/" typed in the real canvas pops a palette with a non-zero
//      boundingBox() -- Gate 17's own lesson, that a DOM-present but
//      zero-area element passes every unit test and is invisible to a user.
//   2. Real ArrowDown x2 + Enter inserts the RIGHT block (not just "a"
//      block), the "/query" text is gone from the live DOM, and the SAVED
//      FILE ON DISK carries the expected markdown. This is the only
//      end-to-end proof that the plugin's handleKeyDown genuinely outranks
//      Milkdown's own keymap and that Enter chose an item rather than
//      splitting the paragraph -- see fix round 1's own C1 writeup in
//      task-5-report.md for the dead-key regression this guards against.
//   3. Split-mode non-occlusion: the palette's right edge never reaches the
//      real native preview WebContentsView's own left edge, read via
//      app.evaluate() + mainWindow.contentView.children (the Gate 15/18/28
//      technique) -- and the clamp is proven BINDING (the unclamped,
//      anchor-centred position would have overlapped), so this cannot pass
//      vacuously the way a selection that never needed clamping would.
//   4. A "/" that must NOT trigger a session at all (mid-word, "and/or")
//      opens nothing -- the negative half of the same trigger condition
//      requirement 1/2 exercise positively.
//
// Uses launchIsolatedApp (phase0/electron-launch.ts), never a bare
// electron.launch(), and wraps close() in try/finally at every call site.
//
// MEASURED VALUES, recorded for the same reason gate28's own header does:
//
//   Format mode, default 900x670 window --
//     palette after "/list" query: {x:224, y:310.7, w:260, h:180.5}, 3
//     options (Bullet list, Numbered list, Task list -- matching
//     slash-filter.ts's own substring-bucket order, none of the three is a
//     PREFIX match for "list" so all three land in the same bucket in their
//     original SLASH_ITEMS declaration order).
//
//   Split mode, splitRatio 50, WIDE_TARGET fixture (same sentence gate28's
//   own Split test uses) --
//     native preview view: {x:561, y:123, w:339, h:483}
//     anchor (collapsed caret, right before "width."): x=549.9
//     palette: {x:287, y:278, w:260, h:320} -> right edge 547, clearance
//     14px from preview.x (matches gate28's own FLOATING_EDGE_PAD(8) +
//     divider(6) reasoning exactly -- the palette reuses the SAME
//     computeFloatingPosition/intersectRect machinery as the bubble menu).
//     Unclamped (anchor-centred) right edge would have been 549.9 + 130 =
//     679.9 -- 119px INSIDE the native view's column, so the clamp is
//     genuinely binding, not incidentally satisfied.
//
//   A REAL, LOAD-BEARING TESTING-ENVIRONMENT FINDING, not assumed: getting a
//   robust, reproducible anchor position for the Split-mode test required
//   explicitly resetting the editor pane's own `scrollLeft` to 0 via
//   `win.evaluate()` immediately before typing "/", rather than relying on
//   whatever scroll position Chromium's native "scroll caret into view"
//   behavior happened to leave after the preceding click/arrow-key
//   navigation. Measured directly: the SAME final caret document offset (78,
//   right before "width.") produced anchor.x readings ranging from 351 to
//   481 across different navigation paths (triple-click+percentage-click,
//   Home+ArrowRight, End+ArrowLeft) -- Chromium's own scroll-into-view
//   heuristic rests the caret at a DIFFERENT point within the pane's visible
//   width depending on the PATH taken to reach it, not just the final
//   position, which is not something a caller can rely on being stable
//   run-to-run. Forcing scrollLeft to a known value (0) before measuring
//   removes that dependency entirely and is what gives this gate's own
//   Split-mode test its ~119px margin instead of an occasionally-negative
//   one. This finding is specific to this gate's own measurement technique,
//   not a product bug -- the app itself never needs a caret to be at a
//   PARTICULAR scroll position, only wherever the browser naturally puts it.
//
// TWO DISTINCT LAUNCH-HANG FLAKES were hit repeatedly while building this
// gate (CLAUDE.md's own documented "first _electron launch after a build can
// spuriously time out" note, and gate28's own header's identical writeup):
// under this development environment's load (load average 3-4.5 throughout,
// never idle), roughly half of all launches hung for the full 90-120s test
// timeout with EITHER zero console output at all (a pure launch-time hang,
// confirmed by inspecting the resulting error-context.md, which shows no
// test-body progress) or, less often, a hang partway through a test body
// after several real interactions had already logged successfully. Every
// hang was followed by a clean warm re-run on the very next attempt with NO
// code changes -- consistent with CLAUDE.md's own characterization ("it
// either launches or hangs," no gradual-slowdown story) rather than a
// regression in this gate's own logic. Re-run before diagnosing.

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
// gate17/gate20/gate27/gate28's own openFixtureDocument -- opening through
// the real Home screen (rather than any test-only entry point) is what makes
// the fixture path a genuinely KNOWN path, so the later Save writes straight
// to disk with no native dialog for Playwright to be unable to dismiss.
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

  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate29-'))
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const fixtureFilename = `gate29-fixture-${nonce}.md`
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

// The real, on-screen split-preview WebContentsView's own bounds -- the
// gate15/gate18/gate28 probe, unchanged. Filters to a genuinely ON-SCREEN
// rectangle because this same mainWindow also hosts a SECOND, unrelated
// pagedown-render:// view from app startup (the Phase 0 spike harness),
// parked permanently at {x:-9999, y:-9999}. Deliberately does NOT use the
// discouraged __pagedownPhase0 bridge.
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

const FORMAT_FIXTURE = `# Gate 29 Fixture

Some existing paragraph text here.
`

test('Gate 29: a real / pops a real palette; ArrowDown x2 + Enter inserts the right block on disk; and/or never triggers', async () => {
  test.setTimeout(90_000)

  const fixture = await openFixtureDocument(FORMAT_FIXTURE)
  const { close, win, fixtureDir, fixturePath, restoreRecents } = fixture

  try {
    const para = win
      .locator('.milkdown-mount .ProseMirror p')
      .filter({ hasText: 'Some existing paragraph' })
    await expect(para).toHaveText('Some existing paragraph text here.')

    const listbox = win.getByRole('listbox', { name: 'Slash commands' })

    // Nothing is open yet -- asserted up front, matching gate28's own
    // pre-selection check, so a palette that were simply always mounted
    // could not pass this gate by accident.
    await expect(listbox).toHaveCount(0)

    // --- (4) Negative case first: "/" mid-word must NOT open a session. ---
    // A fresh, genuinely empty paragraph (Enter at the end of the existing
    // one), then real keystrokes spelling "and/or" one character at a time
    // through Chromium's own input pipeline -- the same real gesture the
    // positive cases below use, just with no whitespace ever preceding the
    // "/". findSlashTrigger's own backward scan stops at the "d" in "and",
    // so the whitespace-free run "and/" never starts with "/" and no
    // trigger is found.
    await para.click()
    await win.keyboard.press('End')
    await win.keyboard.press('Enter')
    await win.waitForTimeout(100)

    await win.keyboard.type('and', { delay: 30 })
    await win.waitForTimeout(150)
    await expect(listbox).toHaveCount(0)

    await win.keyboard.type('/', { delay: 30 })
    await win.waitForTimeout(300)
    // The headline negative assertion: still nothing, even though a "/" was
    // genuinely just typed by a real keydown.
    await expect(listbox).toHaveCount(0)

    await win.keyboard.type('or', { delay: 30 })
    await win.waitForTimeout(150)
    await expect(listbox).toHaveCount(0)

    const andOrPara = win.locator('.milkdown-mount .ProseMirror p').filter({ hasText: 'and/or' })
    await expect(andOrPara).toHaveText('and/or')

    // --- (1)/(2) Positive case: a fresh empty paragraph, a real query that
    // narrows the catalogue to exactly 3 items (all three "list" items --
    // none of which is a PREFIX match for "list", so slash-filter.ts's
    // substring bucket carries all three in their original SLASH_ITEMS
    // declaration order: Bullet list, Numbered list, Task list), ArrowDown
    // x2 to reach the third (Task list), and Enter.
    await win.keyboard.press('Enter')
    await win.waitForTimeout(100)

    await win.keyboard.type('/list', { delay: 30 })
    await win.waitForTimeout(300)

    // (1) It is really there, and it really has area -- Gate 17's own
    // lesson: toBeVisible() alone would already pass for a present-but-
    // zero-area element, so the box is measured explicitly.
    await expect(listbox).toBeVisible()
    const paletteBox = await listbox.boundingBox()
    expect(paletteBox).not.toBeNull()
    expect(paletteBox!.width).toBeGreaterThan(0)
    expect(paletteBox!.height).toBeGreaterThan(0)

    const options = listbox.getByRole('option')
    await expect(options).toHaveCount(3)
    const optionTexts = await options.allTextContents()
    expect(optionTexts[0]).toContain('Bullet list')
    expect(optionTexts[1]).toContain('Numbered list')
    expect(optionTexts[2]).toContain('Task list')

    // (2) Real ArrowDown x2 through Chromium's own input pipeline, landing
    // on the third (0-indexed 2) option -- Task list, distinguishable from
    // every other item by its own checkbox marker once inserted.
    await win.keyboard.press('ArrowDown')
    await win.keyboard.press('ArrowDown')
    const activeOption = listbox.locator('[aria-selected="true"]')
    await expect(activeOption).toHaveText(/Task list/)

    // Real Enter -- this is the one thing jsdom cannot prove (fix round 1's
    // own C1: Enter/Tab were previously dead keys, swallowed by the plugin
    // with nothing behind them). If handleKeyDown did not genuinely outrank
    // Milkdown's own keymap here, this Enter would instead split the
    // paragraph, leaving the "/list" text intact in a NEW empty sibling
    // paragraph rather than being consumed by a choice.
    await win.keyboard.press('Enter')
    await win.waitForTimeout(300)

    // The palette is gone, and the "/query" text is gone from the live DOM.
    await expect(listbox).toHaveCount(0)
    const editorText = await win.locator('.milkdown-mount .ProseMirror').textContent()
    expect(editorText).not.toContain('/list')

    // A real task-list item landed, not merely "some block" -- checked via
    // the real checkbox markup GFM task lists render as.
    const taskItem = win.locator('.milkdown-mount .ProseMirror li[data-item-type="task"]')
    await expect(taskItem).toHaveCount(1)

    // The disk round trip -- the only end-to-end proof this reaches a real
    // saved file, not just the live ProseMirror document.
    await win.getByRole('button', { name: 'Save' }).click()
    await expect
      .poll(async () => (await readFile(fixturePath, 'utf8')).includes('- [ ]'), {
        message: 'expected the saved file to contain the real task-list marker',
        timeout: 10_000
      })
      .toBe(true)

    const saved = await readFile(fixturePath, 'utf8')
    expect(saved).not.toContain('/list')
    // The negative-case paragraph survived untouched, proving the earlier
    // "and/or" typing never silently consumed or altered by any accidental
    // trigger either.
    expect(saved).toContain('and/or')
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})

// One long line, matching gate28's own WIDE_TARGET verbatim (same
// window/splitRatio geometry this file's own header records measured values
// against) -- sized to run most of the way across the 624px content column,
// so a whitespace-preceded position near its far end sits well past the
// pane's own visible width once Split mode's real preview view is attached.
const WIDE_TARGET =
  'This deliberately long target line runs right across the whole content column width.'

const SPLIT_FIXTURE = `# Gate 29 Split Fixture

Leading paragraph, present so the wide target line below is not the first block on the page.

${WIDE_TARGET}
`

test('Gate 29: in Split mode the palette is clamped clear of the real preview WebContentsView, and the clamp is binding', async () => {
  test.setTimeout(90_000)

  const fixture = await openFixtureDocument(SPLIT_FIXTURE)
  const { app, close, win, fixtureDir, restoreRecents } = fixture

  try {
    // No on-screen split view exists yet -- only the permanently off-screen
    // Phase 0 spike one, which the probe's own bounds filter excludes.
    expect(await probeSplitPreviewBounds(app)).toBeNull()

    // `exact: true` rules out the unrelated "Split cell" table toolbar
    // button, per gate15/gate28.
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

    // Triple-click select the whole line first -- the same technique
    // gate28's own Split-mode bubble test already validated for reliable
    // real-browser selection behavior in this exact geometry.
    await target.click({ clickCount: 3 })

    // Click at a point within the paragraph's own (post-selection) bounding
    // box near its right portion, landing close to (but not necessarily
    // exactly at) the position right before "width." -- the ONE
    // whitespace-preceded position near the far end of this sentence, so a
    // "/" typed there is guaranteed to open a session (unlike a position
    // typed at the absolute end of the line, which this file's own header
    // documents as a real, narrower Chromium contenteditable interaction
    // this gate deliberately does not exercise).
    const postSelectBox = await target.boundingBox()
    expect(postSelectBox).not.toBeNull()
    await target.click({
      position: { x: postSelectBox!.width * 0.85, y: postSelectBox!.height / 2 }
    })

    // Correct to the EXACT offset right before "width." (index 78 -- "This
    // deliberately long target line runs right across the whole content
    // column " is 78 characters) via a measured, dynamic delta rather than
    // a fixed key-press count, since the click's own landing offset can
    // vary by a character or two run to run.
    const TARGET_OFFSET = 78
    async function readCaretOffset(): Promise<number | null> {
      return win.evaluate(() => {
        const sel = window.getSelection()
        if (!sel || sel.rangeCount === 0) return null
        return sel.getRangeAt(0).startOffset
      })
    }
    const initialOffset = await readCaretOffset()
    expect(initialOffset).not.toBeNull()
    const delta = TARGET_OFFSET - initialOffset!
    // Bounded, not open-ended -- a click landing wildly far from the
    // expected word would indicate the fixture/geometry assumption itself
    // broke, and should fail loudly rather than loop for a long time.
    expect(Math.abs(delta)).toBeLessThan(15)
    for (let i = 0; i < Math.abs(delta); i++) {
      await win.keyboard.press(delta > 0 ? 'ArrowRight' : 'ArrowLeft')
    }
    await expect.poll(readCaretOffset).toBe(TARGET_OFFSET)

    // Reset the editor pane's own horizontal scroll to a known value (0)
    // right before typing -- see this file's own header for why this is
    // load-bearing: the SAME final caret offset produces a different
    // anchor.x depending on the scroll-into-view history of however it was
    // reached, and an unforced scroll position measured anywhere from 351
    // to 481 across different navigation paths in this exact geometry.
    await win.evaluate(() => {
      const mount = document.querySelector('.milkdown-mount')
      let el: HTMLElement | null = mount as HTMLElement | null
      while (el) {
        if (el.scrollWidth > el.clientWidth) el.scrollLeft = 0
        el = el.parentElement
      }
    })

    // The real "/" keystroke.
    await win.keyboard.type('/', { delay: 30 })

    const listbox = win.getByRole('listbox', { name: 'Slash commands' })
    await expect(listbox).toBeVisible()
    const paletteBox = await listbox.boundingBox()
    expect(paletteBox).not.toBeNull()
    expect(paletteBox!.width).toBeGreaterThan(0)
    expect(paletteBox!.height).toBeGreaterThan(0)

    // The anchor -- the collapsed caret's own on-screen position, read
    // independently from the real DOM Selection (the same technique
    // gate28's readSelectionBox uses), so agreement with the palette's
    // placement is evidence about getSelectionRect rather than a
    // restatement of it.
    const anchorRect = await win.evaluate(() => {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0) return null
      const rect = selection.getRangeAt(0).getBoundingClientRect()
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    })
    expect(anchorRect).not.toBeNull()

    // The clamp GENUINELY ENGAGED. Without this, the headline assertion
    // below could be satisfied by an anchor that happened to sit far enough
    // left that no clamping was ever needed -- a green test proving
    // nothing. computeFloatingPosition centres the palette horizontally on
    // the anchor, so this computes exactly where it WOULD have landed
    // unclamped and asserts that position really did reach into the native
    // view's own column.
    const unclampedRight = anchorRect!.x + paletteBox!.width / 2
    expect(unclampedRight).toBeGreaterThan(preview!.x)

    // THE HEADLINE. The palette's right edge never reaches the native
    // view's left edge, so no part of it can be composited over -- the one
    // assertion the whole "clamp into intersect(canvas, editor pane)"
    // design exists to guarantee, and it is not expressible in the DOM at
    // all (the native view has no DOM presence for any layout engine, or
    // any floating-ui-style collision detector, to reason about).
    expect(paletteBox!.x + paletteBox!.width).toBeLessThanOrEqual(preview!.x)

    // Still a real, usable palette after the clamp -- not squashed to
    // nothing to satisfy the bound above.
    expect(paletteBox!.width).toBeGreaterThan(150)
    expect(paletteBox!.height).toBeGreaterThan(20)
    await expect(listbox.getByRole('option').first()).toBeVisible()

    // And it stayed inside the left pane's own page card on the other
    // side too -- the same safe rect stated as a box rather than one edge.
    const pane = await win.getByTestId('page-card').boundingBox()
    expect(pane).not.toBeNull()
    expect(paletteBox!.x).toBeGreaterThanOrEqual(pane!.x)
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})
