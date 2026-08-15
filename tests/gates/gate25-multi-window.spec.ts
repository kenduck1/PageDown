import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../../src/main/recent-files'

// Gate 25 -- Multi-window support, against the REAL built app.
//
// WHY THIS GATE EXISTS. "Open in New Window" and the event.sender-derived
// IPC generalization it required (src/main/index.ts) have no unit-test
// coverage at all -- index.ts itself has never had a direct unit test in
// this codebase (it's app bootstrap/IPC-registration wiring around
// already-unit-tested functions elsewhere, verified via real gates
// instead, matching this suite's own established pattern). A genuinely
// SECOND BrowserWindow, its own independent renderer/Zustand state, and
// the harness-teardown-only-on-last-window-close fix can only be proven
// against the real, multi-process running app.

const GET_MAIN_WINDOW_TIMEOUT_MS = 60_000

// Every `file://` window currently open, domcontentloaded-settled -- unlike
// every other gate's own getMainWindow (which returns just the FIRST one),
// this gate genuinely needs to tell multiple real app-shell windows apart.
async function getFileWindows(application: ElectronApplication): Promise<Page[]> {
  const deadline = Date.now() + GET_MAIN_WINDOW_TIMEOUT_MS
  const settled: Page[] = []
  for (const candidate of application.windows()) {
    if (!candidate.url().startsWith('file://')) continue
    try {
      await candidate.waitForLoadState('domcontentloaded', { timeout: 2000 })
      settled.push(candidate)
    } catch {
      continue
    }
  }
  if (settled.length > 0) return settled
  // Nothing settled yet on the first pass -- poll until at least one does,
  // same deadline/backoff every other gate's getMainWindow uses.
  while (Date.now() < deadline) {
    for (const candidate of application.windows()) {
      if (!candidate.url().startsWith('file://')) continue
      try {
        await candidate.waitForLoadState('domcontentloaded', { timeout: 2000 })
        return [candidate]
      } catch {
        continue
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out locating any real app-shell window')
}

// Every on-screen split-preview WebContentsView currently attached to each
// real app-shell window, keyed by that window's own URL.
//
// WHY THIS EXISTS. Split mode's preview is a native WebContentsView attached
// to a window's contentView, and until the multi-window correctness pass every
// split-preview IPC handler ignored `event.sender` and used the captured
// `mainWindow`. Measured consequence: clicking Split in window 2 attached an
// OPAQUE view to WINDOW 1's contentView, at window 2's pane coordinates, where
// it painted on top of window 1's Home screen -- window 2's own pane stayed
// empty. That is strictly worse than the "Split only works in the first
// window" limitation it was documented as: it corrupted the window that did
// nothing wrong. Nothing covered it, which is exactly why it survived.
//
// Mechanism is Gate 15's `probeSplitPreviewView`, generalized to report
// PER WINDOW rather than for the first `file://` window only -- app.evaluate()
// against Electron's own public main-process API, because a WebContentsView is
// not a top-level window (app.windows() cannot see it) and `window.api` is
// deep-frozen by contextBridge (so no renderer-side spy is possible). See Gate
// 15's header for the full derivation.
//
// The `bounds.x >= 0 && bounds.y >= 0` filter isolates a REAL split preview
// from the permanently off-screen Phase-0-spike pagedown-render:// view that
// src/main/index.ts attaches to the first window at startup ({x:-9999,
// y:-9999}) -- same disambiguation Gate 15 and Gate 18 already rely on.
async function probeSplitPreviewsByWindow(
  application: ElectronApplication
): Promise<Array<{ url: string; previewCount: number }>> {
  return application.evaluate(async ({ BrowserWindow, WebContentsView }) => {
    return BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed() && win.webContents.getURL().startsWith('file://'))
      .map((win) => ({
        url: win.webContents.getURL(),
        previewCount: win.contentView.children.filter((child) => {
          if (!(child instanceof WebContentsView)) return false
          if (child.webContents.isDestroyed()) return false
          if (!child.webContents.getURL().startsWith('pagedown-render://')) return false
          const bounds = child.getBounds()
          return bounds.x >= 0 && bounds.y >= 0 && bounds.width > 0 && bounds.height > 0
        }).length
      }))
  })
}

let app: ElectronApplication | undefined
let close: (() => Promise<void>) | undefined
let userDataDir: string
let fixtureDir: string

test.setTimeout(120_000)

test('Gate 25: Open in New Window creates a genuinely independent second window, and closing it does not break the first', async () => {
  const launched = await launchIsolatedApp(['out/main/index.js'])
  app = launched.app
  close = launched.close
  userDataDir = launched.userDataDir

  try {
    const [win1] = await getFileWindows(app)
    await win1.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate25-'))
    const marker = `Gate25 ${Date.now()}`
    const filename = `gate25-${Date.now()}.md`
    const path = join(fixtureDir, filename)
    await writeFile(path, `# ${marker}\n\nOriginal body text.\n`, 'utf8')

    const originalRecents = await readRecentFiles(userDataDir)
    await writeRecentFiles(
      userDataDir,
      mergeRecentFiles(originalRecents, path, new Date().toISOString())
    )
    await win1.reload()
    await win1.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    // Real user action: click "Open in New Window" on the recent-file row.
    // Bare "Open in new window" is a deliberately generic label (see
    // HomeScreen.tsx's own comment on that button) -- unambiguous here
    // since this fixture only ever seeds one recent file.
    await win1.getByRole('button', { name: 'Open in new window' }).click()

    // A genuinely SECOND real BrowserWindow appears.
    let win2: Page | undefined
    await expect
      .poll(
        async () => {
          const windows = await getFileWindows(app!)
          win2 = windows.find((w) => w !== win1)
          return windows.length
        },
        { message: 'expected a real second app-shell window to open', timeout: 20_000 }
      )
      .toBeGreaterThan(1)
    expect(win2).toBeDefined()

    await win2!.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
    await win2!.waitForSelector('.milkdown-mount .ProseMirror')

    // The NEW window shows the requested document...
    const win2Text = await win2!.locator('.milkdown-mount .ProseMirror').innerText()
    expect(win2Text).toContain(marker)

    // ...while the ORIGINAL window is untouched -- still on Home, no
    // navigation, no state change at all.
    expect(await win1.getByText('PageDown').isVisible()).toBe(true)

    // Independent state: typing in the SECOND window's editor must not
    // appear anywhere in the first window (which isn't even showing an
    // editor at all right now).
    await win2!.locator('.milkdown-mount .ProseMirror').click()
    await win2!.keyboard.type(' Independent edit in window 2.')
    await expect
      .poll(async () => win2!.locator('.milkdown-mount .ProseMirror').innerText(), {
        message: 'expected the second window to show its own typed edit'
      })
      .toContain('Independent edit in window 2.')
    expect(await win1.locator('body').innerText()).not.toContain('Independent edit in window 2.')

    // ---------------------------------------------------------------------
    // Split mode in the SECOND window attaches its preview to the SECOND
    // window -- and leaves the first window's contentView alone.
    //
    // Before the per-window harness fix, this measured (via this same probe):
    //   window 2: 0 on-screen previews  <- its own pane stayed empty
    //   window 1: 1 on-screen preview   <- window 2's pane rectangle, opaque,
    //                                      painted over window 1's Home screen
    // Both halves are asserted, in the same run, for the same reason Gate 16
    // measures a Letter control alongside its A4 subject: "window 2 got one"
    // alone would still pass if BOTH windows got one.
    // ---------------------------------------------------------------------
    const previewsBeforeSplit = await probeSplitPreviewsByWindow(app)
    expect(previewsBeforeSplit.every((entry) => entry.previewCount === 0)).toBe(true)

    // The document window opened via "Open in New Window" is the one whose
    // URL carries the ?openPath= query param createWindow rides the target
    // document along on -- a stable identity, unlike positional ordering.
    const isWindow2 = (url: string): boolean => url.includes('openPath=')

    await win2!.getByRole('button', { name: 'Split', exact: true }).click()

    let previews: Array<{ url: string; previewCount: number }> = []
    await expect
      .poll(
        async () => {
          previews = await probeSplitPreviewsByWindow(app!)
          return previews.find((entry) => isWindow2(entry.url))?.previewCount ?? 0
        },
        {
          message: "expected window 2's own Split preview to attach to window 2",
          timeout: 20_000
        }
      )
      .toBe(1)

    // ...and window 1, which is sitting on Home and never asked for anything,
    // gained NO composited child view at all.
    expect(previews.filter((entry) => !isWindow2(entry.url)).map((e) => e.previewCount)).toEqual([
      0
    ])

    // Leaving Split mode in window 2 tears down window 2's own harness --
    // per-window teardown, exercised here because the shared-harness version
    // of `split-preview:destroy` blanked whichever window happened to hold the
    // one global harness, regardless of which window sent the message.
    await win2!.getByRole('button', { name: 'Format', exact: true }).click()
    await expect
      .poll(
        async () => {
          previews = await probeSplitPreviewsByWindow(app!)
          return previews.reduce((total, entry) => total + entry.previewCount, 0)
        },
        { message: 'expected window 2 to tear down its own split preview', timeout: 10_000 }
      )
      .toBe(0)

    // Save window 2 before closing it. This is REQUIRED, not tidiness: the
    // window-close guard added for the unsaved-work fix cancels the close of a
    // window holding a dirty document and asks its renderer to confirm, which
    // opens a genuine native dialog.showMessageBox -- a modal no automated
    // test can dismiss (the same limitation Print and the mtime-conflict
    // feature already document as their reason for having no gate). The typed
    // edit above has already proven what this gate is about (two windows with
    // genuinely independent state); saving it is how this gate reaches the
    // close it actually wants to test, and it exercises Save in a second
    // window into the bargain.
    await win2!.getByRole('button', { name: 'Save' }).click()
    await expect
      .poll(
        async () =>
          win2!.evaluate(
            () => document.querySelector('[role="img"][aria-label="Unsaved changes"]') === null
          ),
        { message: 'expected window 2 to become clean after Save' }
      )
      .toBe(true)

    // Closing the SECOND window must not break the FIRST window's own
    // pagination-harness-backed features (Multi-window support's own
    // harness-teardown-only-on-last-window-close fix) -- proven by asking
    // the first window for a real thumbnail/page-count round trip
    // immediately after.
    await win2!.close()
    await expect
      .poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), {
        message: 'expected the second window to actually close'
      })
      .toBeLessThan(3) // headless harness BaseWindows don't count via BrowserWindow.getAllWindows()

    const pageCountResult = await win1.evaluate(async (src) => {
      const api = (window as unknown as { api: { getPageCount: (c: string) => Promise<unknown> } })
        .api
      return api.getPageCount(src)
    }, `# ${marker}\n\nStill alive after window 2 closed.\n`)
    expect(pageCountResult).toEqual({ pageCount: 1 })
  } finally {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
    if (app && close) await close()
  }
})
