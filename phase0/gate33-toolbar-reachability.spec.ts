import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'
import { launchIsolatedApp } from './electron-launch'

// Gate 33 -- the formatting toolbar's controls are genuinely REACHABLE at the
// app's own shipped default window size (1000x840, src/main/window-bounds.ts).
//
// WHY A GATE, when EditorToolbar has 50 unit tests: every one of those renders
// under jsdom, which has no layout engine at all -- every width is 0, nothing
// overflows, nothing overlaps, and `document.elementFromPoint` is meaningless.
// So a jsdom test can prove a Bold button EXISTS and that clicking it calls
// toggleBold, and is structurally incapable of noticing that in the real app
// that button sat underneath an opaque `position: sticky` group at every
// scroll position. That is not hypothetical -- it is what shipped, measured in
// this exact app before the fix:
//
//   Format mode, 1000x840: toolbar 1000 | scroll region visible 407 |
//     scroll content 843 | sticky leading group 420.5
//   Split mode, same window: scroll region visible 189 (the right-hand
//     cluster grows to 769.4 with the split-pane and Follow toggles)
//
//   -> ELEVEN controls unreachable by any means, at every scroll position:
//      Bold, Italic, Bulleted list, Numbered list, Checklist, Insert link,
//      Insert image, Insert table, Insert page break, Add comment, Find.
//
// CLAUDE.md had already recorded the same defect from the other end without
// recognising it as one: Gate 27 could not click its own "Add comment"
// toolbar button, diagnosed it as a test-harness problem, and worked around it
// with a keyboard shortcut.
//
// After the fix (toolbar wraps its right-hand cluster to a second line rather
// than squeezing the formatting region -- see EditorToolbar.tsx):
//
//   Format and Split, 1000x840: scroll region visible 972 | content 972 |
//     maxScroll 0 -> all 16 controls hit-testable, zero scrolling needed
//   Format at the app's 760px MINIMUM width: visible 732 | content 843 |
//     maxScroll 111 -> 13 visible outright, all 16 reachable
//
// NUMBERED 33 after checking `git ls-tree main phase0/` (32 was the highest,
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

// Every control the audit found unreachable. Deliberately the whole list
// rather than a representative sample: the failure was not "one button is
// awkward", it was "the entire formatting half of the toolbar is covered", and
// a sample would let a partial regression through.
const CORE_CONTROLS = [
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
  'Find'
] as const

const FIXTURE = `# Gate 33 Fixture

A paragraph, so the editor has real content to lay out.
`

interface ToolbarGeometry {
  toolbarWidth: number
  toolbarHeight: number
  regionVisible: number
  regionContent: number
  clusterWidth: number
  unreachable: string[]
}

// Real Chromium hit-testing at each control's own centre point: the ONLY
// question that matters is "if the user aims at this button, does the click
// land on it", and an opaque sticky group covering it fails that while every
// DOM-presence and visibility check still passes. Scans every scroll position
// (the region may legitimately need scrolling at narrow widths) and counts a
// control as reachable if it is hit-testable at ANY of them.
async function readToolbarGeometry(win: Page, labels: readonly string[]): Promise<ToolbarGeometry> {
  return win.evaluate(`(async () => {
    const labels = ${JSON.stringify(labels)}
    const toolbar = document.querySelector('[role="toolbar"][aria-label="Formatting toolbar"]')
    const region = toolbar.firstElementChild
    const scroller = region.querySelector('.scrollbar-hide')
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
    return {
      toolbarWidth: toolbar.getBoundingClientRect().width,
      toolbarHeight: toolbar.getBoundingClientRect().height,
      regionVisible: scroller.clientWidth,
      regionContent: scroller.scrollWidth,
      clusterWidth: cluster.getBoundingClientRect().width,
      unreachable: labels.filter((_, i) => !reachable.has(i))
    }
  })()`)
}

test('Gate 33: every core formatting control is reachable at the default window size', async () => {
  test.setTimeout(90_000)

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

    // NOT VACUOUS, and this is the half that keeps it that way -- the Gate
    // 28/29 pattern. Reachability alone would pass trivially on any window
    // wide enough that the toolbar never had to do anything: this asserts the
    // formatting region's own natural content width plus the right-hand
    // cluster genuinely DOES NOT FIT on one line at this window size, i.e.
    // the wrap was actually required to produce the result above. If the
    // default window ever grows past that point, this half fails loudly rather
    // than the first half passing silently while testing nothing.
    expect(format.regionContent + format.clusterWidth).toBeGreaterThan(format.toolbarWidth)
    // ...and it really did wrap: two rows of ~30px controls, not one.
    expect(format.toolbarHeight).toBeGreaterThan(60)

    // A REAL Playwright click, not just a hit-test: Playwright's own
    // actionability check refuses to click an element another element would
    // receive the event for, which is precisely how this defect first
    // surfaced (Gate 27, on "Add comment", reported the Font size <select>
    // intercepting at the same coordinates on every retry). Bold with no
    // selection only sets stored marks, so it changes no document text.
    const toolbar = win.getByRole('toolbar', { name: 'Formatting toolbar' })
    await toolbar.getByRole('button', { name: 'Bold' }).click({ timeout: 5000 })

    // SPLIT MODE is the harder case and the reason it is tested separately:
    // the right-hand cluster gains the split-pane and Follow toggles, growing
    // from 551px to 769px, which is what took the visible formatting region
    // down to 189px before the fix.
    await win.getByRole('button', { name: 'Split', exact: true }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')

    const split = await readToolbarGeometry(win, CORE_CONTROLS)
    expect(split.unreachable).toEqual([])
    expect(split.clusterWidth).toBeGreaterThan(format.clusterWidth)
    expect(split.regionContent + split.clusterWidth).toBeGreaterThan(split.toolbarWidth)

    await writeRecentFiles(userDataDir, originalRecents)
  } finally {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})
