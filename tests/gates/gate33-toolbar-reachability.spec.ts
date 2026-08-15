import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../../src/main/recent-files'
import { MIN_STICKY_REVEAL_PX } from '../../src/renderer/src/lib/toolbar-layout'
import { launchIsolatedApp } from './electron-launch'

// Gate 33 -- the formatting toolbar's controls are genuinely REACHABLE at the
// app's own shipped default window size (1000x840, src/main/window-bounds.ts),
// AND the toolbar is a SINGLE ROW there.
//
// WHY A GATE, when EditorToolbar has 50 unit tests: every one of those renders
// under jsdom, which has no layout engine at all -- every width is 0, nothing
// overflows, nothing overlaps, `document.elementFromPoint` is meaningless, and
// every element reports the same zero-height box. So a jsdom test can prove a
// Bold button EXISTS and that clicking it calls toggleBold, and is
// structurally incapable of noticing either that the button sat underneath an
// opaque `position: sticky` group at every scroll position, or that the
// toolbar had quietly become two rows tall.
//
// BOTH of those shipped, in that order, and this gate now guards both:
//
//   1. Unreachable controls (the original defect, measured before any fix):
//        Format mode, 1000x840: toolbar 1000 | scroll region visible 407 |
//          scroll content 843 | sticky leading group 420.5
//        Split mode, same window: scroll region visible 189 (the right-hand
//          cluster grew to 769.4 with the split-pane and Follow toggles)
//        -> ELEVEN controls unreachable by any means, at every scroll
//           position. CLAUDE.md had already recorded the same defect from the
//           other end without recognising it as one: Gate 27 could not click
//           its own "Add comment" toolbar button, diagnosed it as a test-
//           harness problem, and worked around it with a keyboard shortcut.
//
//   2. A two-row toolbar (the FIX for 1, measured after it):
//        toolbar height 81px at 1000px, in both modes, collapsing to one row
//        only above ~1436px. `flex-wrap` bought reachability with 36px of
//        permanent vertical chrome in an app whose entire subject is the page.
//
// The current layout satisfies both, by making the content genuinely fit
// rather than trading one constraint for the other -- six controls moved to
// the application menu / Page Setup, and two were narrowed. Measured after:
//
//   Format AND Split, 1000x840: toolbar height 45 | region visible 691 |
//     content 691 | maxScroll 0 | sticky 212.5 | cluster 266.9 (identical in
//     both modes) -> all 15 controls hit-testable with zero scrolling
//   Format AND Split at the app's 760px MINIMUM: toolbar height 45 | visible
//     451 | content 635 | maxScroll 184 -> all 15 still reachable
//
// NUMBERED 33 after checking `git ls-tree main tests/gates/` (32 was the highest,
// gate32-html-export). CLAUDE.md records 17/18 being claimed twice during
// parallel work; this was authored alongside another branch, so a collision is
// possible -- renumber rather than merge two files onto one number.
//
// Uses launchIsolatedApp (never a bare electron.launch()) and awaits close()
// in a finally, per this suite's own rules.

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

// Every control the audit found unreachable, plus the ones that share the row
// with them. Deliberately the whole list rather than a representative sample:
// the failure was not "one button is awkward", it was "the entire formatting
// half of the toolbar is covered", and a sample would let a partial regression
// through.
//
// Font family and Font size are deliberately NOT here any more: they moved
// into Page Setup's Typography section, and EditorToolbar.test.tsx asserts
// directly that they are absent from this toolbar. Same for Print, Export as
// HTML and Keyboard shortcuts (application menu) and the two Split-only pills
// (View menu).
const CORE_CONTROLS = [
  'Undo',
  'Redo',
  'Paragraph style',
  'Bold',
  'Italic',
  'Bulleted list',
  'Numbered list',
  'Checklist',
  'Insert link',
  'Insert image',
  'Insert table',
  'Insert page break',
  'Add comment',
  'Find',
  'Page setup',
  'Export as PDF'
] as const

const FIXTURE = `# Gate 33 Fixture

A paragraph, so the editor has real content to lay out.
`

interface ToolbarGeometry {
  toolbarWidth: number
  toolbarHeight: number
  regionVisible: number
  regionContent: number
  maxScroll: number
  stickyWidth: number
  stickyPositioned: boolean
  clusterWidth: number
  offsetTopSpread: number
  unreachable: string[]
}

// Real Chromium hit-testing at each control's own centre point: the ONLY
// question that matters is "if the user aims at this button, does the click
// land on it", and an opaque sticky group covering it fails that while every
// DOM-presence and visibility check still passes. Scans every scroll position
// (the region legitimately needs scrolling at the narrow widths) and counts a
// control as reachable if it is hit-testable at ANY of them.
//
// `offsetTopSpread` is the single-row measurement: the difference between the
// highest and lowest control top edge. On one row every control shares a
// baseline band (measured spread: 1px, from the 32px accent Export button
// centring inside a row of 30px controls); a wrapped toolbar puts the
// right-hand cluster a full row lower, which is ~36px.
async function readToolbarGeometry(win: Page, labels: readonly string[]): Promise<ToolbarGeometry> {
  return win.evaluate(`(async () => {
    const labels = ${JSON.stringify(labels)}
    const toolbar = document.querySelector('[role="toolbar"][aria-label="Formatting toolbar"]')
    const region = toolbar.firstElementChild
    const scroller = region.querySelector('.scrollbar-hide')
    const sticky = scroller.firstElementChild
    const cluster = toolbar.lastElementChild
    const controls = labels.map((label) =>
      toolbar.querySelector('[aria-label="' + label + '"]')
    )
    const reachable = new Set()
    const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth)
    const positions = []
    for (let p = 0; p <= max; p += 20) positions.push(p)
    positions.push(max)
    const original = scroller.scrollLeft
    for (const p of positions) {
      scroller.scrollLeft = p
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      controls.forEach((control, i) => {
        if (!control) return
        const rect = control.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        if (hit && (hit === control || control.contains(hit))) reachable.add(i)
      })
    }
    scroller.scrollLeft = original
    const tops = controls
      .filter((control) => control)
      .map((control) => control.getBoundingClientRect().top)
    return {
      toolbarWidth: toolbar.getBoundingClientRect().width,
      toolbarHeight: toolbar.getBoundingClientRect().height,
      regionVisible: scroller.clientWidth,
      regionContent: scroller.scrollWidth,
      maxScroll: max,
      stickyWidth: sticky.getBoundingClientRect().width,
      stickyPositioned: getComputedStyle(sticky).position === 'sticky',
      clusterWidth: cluster.getBoundingClientRect().width,
      offsetTopSpread: Math.max(...tops) - Math.min(...tops),
      unreachable: labels.filter((_, i) => !reachable.has(i))
    }
  })()`)
}

// The structural guard this whole class of bug rests on
// (lib/toolbar-layout.ts): an OPAQUE group pinned at the scroll region's left
// edge must never be wider than the strip it is pinned inside, or it covers
// that strip at every scroll position. Asserted against the real rendered
// numbers rather than only unit-tested against the pure function, because the
// bug was never in the arithmetic -- it was in the widths actually reaching it.
function expectPinIsSafe(geometry: ToolbarGeometry, where: string): void {
  if (!geometry.stickyPositioned) return
  expect(
    geometry.stickyWidth + MIN_STICKY_REVEAL_PX,
    `${where}: pinned leading group (${geometry.stickyWidth}px) must leave a usable strip inside its ${geometry.regionVisible}px scroll region`
  ).toBeLessThanOrEqual(geometry.regionVisible)
}

async function setWindowWidth(app: ElectronApplication, width: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, targetWidth) => {
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => !candidate.isDestroyed() && candidate.webContents.getURL().startsWith('file:')
    )
    const bounds = win!.getBounds()
    win!.setBounds({ ...bounds, width: targetWidth })
  }, width)
  // The toolbar remeasures through a ResizeObserver (stickyWidth /
  // containerWidth drive both the pin guard and the fade gradient), so give
  // the resize a real frame to land before reading anything back.
  await new Promise((resolve) => setTimeout(resolve, 800))
}

test('Gate 33: the toolbar is one row at the default window size, with nothing unreachable', async () => {
  test.setTimeout(120_000)

  const {
    app,
    close,
    userDataDir: expectedUserDataDir
  } = await launchIsolatedApp(['out/main/index.js'])
  let fixtureDir: string | null = null

  try {
    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    const userDataDir = await app.evaluate(({ app }) => app.getPath('userData'))
    expect(await realpath(userDataDir)).toBe(await realpath(expectedUserDataDir))

    // The window really is at the shipped default -- the whole gate is a claim
    // ABOUT that size, so a machine that opened it at some other size would
    // make every measurement below meaningless.
    const windowSize = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.isDestroyed() && candidate.webContents.getURL().startsWith('file:')
      )
      const bounds = win!.getBounds()
      return { width: bounds.width, height: bounds.height }
    })
    expect(windowSize.width).toBe(1000)

    fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate33-'))
    const fixtureFilename = `gate33-fixture-${Date.now()}.md`
    const fixturePath = join(fixtureDir, fixtureFilename)
    await writeFile(fixturePath, FIXTURE, 'utf8')
    const originalRecents = await readRecentFiles(userDataDir)
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

    const format = await readToolbarGeometry(win, CORE_CONTROLS)
    expect(format.unreachable).toEqual([])
    expectPinIsSafe(format, 'Format at 1000px')

    // SINGLE ROW -- the regression this half exists to stop coming back
    // silently. Two assertions rather than one because they fail differently:
    // the height catches a wrap that adds a row of chrome (45 -> 81), and the
    // offsetTop spread catches ANY control leaving the row's baseline band
    // even if some future padding change kept the total height similar.
    expect(format.toolbarHeight).toBeLessThan(60)
    expect(format.offsetTopSpread).toBeLessThan(8)

    // ...and at this width it does not merely fit, it fits with nothing
    // hidden: the region's whole content is visible, so no scrolling is
    // required to reach anything.
    expect(format.maxScroll).toBe(0)
    expect(format.regionContent).toBeLessThanOrEqual(format.regionVisible)

    // A REAL Playwright click, not just a hit-test: Playwright's own
    // actionability check refuses to click an element another element would
    // receive the event for, which is precisely how this defect first
    // surfaced (Gate 27, on "Add comment", reported the Font size <select>
    // intercepting at the same coordinates on every retry). Bold with no
    // selection only sets stored marks, so it changes no document text.
    const toolbar = win.getByRole('toolbar', { name: 'Formatting toolbar' })
    await toolbar.getByRole('button', { name: 'Bold' }).click({ timeout: 5000 })

    // SPLIT MODE used to be the harder case: the right-hand cluster gained the
    // split-pane and Follow toggles and grew from 551.3 to 769.4, which is
    // what took the visible formatting region down to 189px. Both pills now
    // live in the View menu, so the cluster is mode-INDEPENDENT -- asserted
    // exactly, because "identical" is the structural property that makes the
    // toolbar stop reflowing on a mode switch, and a >= would not catch a
    // regression that re-added something Split-only.
    await win.getByRole('button', { name: 'Split', exact: true }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')

    const split = await readToolbarGeometry(win, CORE_CONTROLS)
    expect(split.unreachable).toEqual([])
    expectPinIsSafe(split, 'Split at 1000px')
    expect(split.clusterWidth).toBe(format.clusterWidth)
    expect(split.toolbarHeight).toBeLessThan(60)
    expect(split.offsetTopSpread).toBeLessThan(8)
    expect(split.maxScroll).toBe(0)

    // NOT VACUOUS -- this is the half that keeps the gate honest, and it
    // replaces the old "the content did not fit, so the wrap was required"
    // check, which cannot survive a layout that deliberately fits.
    //
    // The 1000px assertions above would pass trivially on any window wide
    // enough that the toolbar never had to do anything. So squeeze the real
    // window to the app's own 760px MINIMUM (window-bounds.ts), where the
    // formatting region genuinely CANNOT show all its content, and assert
    // both halves there: that it really is overflowing (the check is live),
    // and that every control is nonetheless reachable (the pin guard and the
    // scroll path both work). That is strictly more than the old gate did --
    // it only described the narrow case in a comment.
    await win.getByRole('button', { name: 'Format', exact: true }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')
    await setWindowWidth(app, 760)

    const narrow = await readToolbarGeometry(win, CORE_CONTROLS)
    expect(narrow.toolbarWidth).toBe(760)
    // Still ONE row even here -- asserted FIRST because it is the most
    // diagnostic failure of the three. Mutation-verified: putting `flex-wrap`
    // and `basis-[content]` back on the toolbar leaves 1000px unchanged (the
    // slimmed content now fits on one line either way, so the height check
    // there cannot discriminate) but genuinely wraps at 760px, and this gate
    // fails on a named assertion. The minimum width must not buy reachability
    // back by wrapping -- that is exactly the trade this whole pass undid.
    expect(narrow.toolbarHeight).toBeLessThan(60)
    expect(narrow.offsetTopSpread).toBeLessThan(8)
    // The region genuinely IS overflowing here, so the reachability assertion
    // below is live rather than trivially satisfied.
    expect(narrow.regionContent).toBeGreaterThan(narrow.regionVisible)
    expect(narrow.maxScroll).toBeGreaterThan(0)
    expect(narrow.unreachable).toEqual([])
    expectPinIsSafe(narrow, 'Format at 760px')

    const narrowSplit = await (async () => {
      await win.getByRole('button', { name: 'Split', exact: true }).click()
      await win.waitForSelector('.milkdown-mount .ProseMirror')
      return readToolbarGeometry(win, CORE_CONTROLS)
    })()
    expect(narrowSplit.unreachable).toEqual([])
    expectPinIsSafe(narrowSplit, 'Split at 760px')
    expect(narrowSplit.toolbarHeight).toBeLessThan(60)

    await setWindowWidth(app, 1000)
    await writeRecentFiles(userDataDir, originalRecents)
  } finally {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})
