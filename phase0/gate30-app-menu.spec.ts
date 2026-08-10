import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'
import { launchIsolatedApp } from './electron-launch'

// Gate 30 -- the application menu and the window title, in the real built app.
//
// WHAT THIS GATE CAN AND CANNOT DO. A native OS menu cannot be driven by
// Playwright at all -- the same hard limit this suite already documents for
// dialog.showMessageBox (Print, the mtime-conflict prompt) and for the native
// spelling context menu (Gate 21). There is no way to move a mouse into the
// macOS menu bar, and a menu accelerator is consumed by the OS before any
// page-level input pipeline Playwright can reach. So this gate deliberately
// does NOT try to click a menu item or press an accelerator.
//
// What it CAN do -- and what makes it worth having rather than a jsdom-only
// story -- is assert the real consequences:
//
//   1. A real Menu is genuinely installed (Menu.getApplicationMenu() is
//      non-null with the expected top-level structure). Nothing in a unit
//      test can prove installation; app-menu-template.test.ts only proves the
//      template SHAPE, and a forgotten setApplicationMenu call would leave
//      every one of those assertions passing against a menu nobody has.
//   2. Enablement genuinely follows the focused window's live state, which
//      requires the whole renderer -> IPC -> main round trip to work.
//   3. Open Recent is genuinely built from the real recent-files allowlist.
//   4. A menu item's own click handler genuinely reaches the renderer and
//      changes the app -- invoked from main via `menuItem.click()` rather
//      than by clicking the OS menu. That is not the same as testing the OS
//      menu, and is not claimed to be: it exercises everything downstream of
//      the click (dispatch -> focused window -> preload validation ->
//      handler), which is all of this feature's own code.
//   5. The real OS window title tracks the document and its dirty state.
//
// ONE launch for the whole gate, deliberately: this suite's own Testing notes
// record that repeated sequential launchIsolatedApp calls in one worker are
// the single strongest correlate of the documented hang/flake.
//
// KNOWN, MEASURED FLAKE, and it is THE ONE THIS SUITE ALREADY DOCUMENTS --
// but that conclusion was reached the hard way, and the intermediate wrong
// answer is worth recording because it is the one a future reader will reach
// too. Across 27 runs of this file on this machine (load average ~4-5
// throughout), 7 hung: a bare `Test timeout of 90000ms exceeded` plus a
// worker-teardown timeout, reaching no assertion at all, i.e. ~26%.
//
// The hang was LOCALIZED, not guessed at: temporary instrumentation writing
// unbuffered step markers straight to a file (so nothing could be lost to
// reporter buffering when the worker is force-killed) showed every failing
// run writing "launching" and then nothing for the full 90s -- so it is
// inside `launchIsolatedApp` (electron.launch, or its app.whenReady()
// evaluate), BEFORE any of this gate's own logic, and therefore before any
// of this feature's code runs in that process.
//
// The first three controls, all run back to back against the SAME build in
// the same conditions, all came back CLEAN -- which pointed, wrongly, at
// something specific to this file:
//   - a stripped-down spec doing only launchIsolatedApp + close: 10/10, ~370ms
//   - gate11 (unmodified): 9/9, ~900ms
//   - gate24 (unmodified): 6/6, ~900ms
// A fourth experiment ruled out the obvious cross-run explanation too: the
// bare probe was interleaved so it ALSO ran immediately after a gate30 run
// (including after a hung one) and stayed 6/6. No orphaned Electron
// processes and no leaked userData directories were present after the
// failures either, and this app takes no single-instance lock.
//
// THE CONTROL THAT ACTUALLY SETTLED IT was run last: gate20 (completely
// unmodified, and much closer to this file in shape -- it seeds recents,
// reloads, opens a document, drives real keys) hung 2 of 6 times in the same
// session, ~33%, with the identical signature. gate17 then hung on 1 of 3
// runs the same way (its test 1 only; tests 2 and 3 passed in that same run).
// So this is gate-agnostic and environmental, exactly as this suite's own
// Testing notes describe -- three clean controls were not enough evidence to
// conclude otherwise, and the lesson worth keeping is that a handful of
// passing control runs cannot establish a ~30% flake's absence.
//
// Practical guidance: re-run in isolation before treating a failure here as
// a regression. A REAL regression in this gate surfaces as a named assertion
// failure, not as a 90s timeout that reaches no assertion.

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

interface MenuSnapshot {
  topLevel: string[]
  file: Array<{ label: string; enabled: boolean }>
  view: Array<{ label: string; enabled: boolean; checked: boolean }>
  openRecent: string[]
}

// Reads the REAL installed menu out of the running main process. Returns
// plain data (Playwright serializes the evaluate result), never MenuItem
// objects.
async function readMenu(app: ElectronApplication): Promise<MenuSnapshot | null> {
  return app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    if (!menu) return null
    const submenuOf = (label: string): Electron.MenuItem[] =>
      menu.items.find((item) => item.label === label)?.submenu?.items ?? []
    const fileItems = submenuOf('File')
    const openRecentItems =
      fileItems.find((item) => item.label === 'Open Recent')?.submenu?.items ?? []
    return {
      topLevel: menu.items.map((item) => item.label),
      file: fileItems.map((item) => ({ label: item.label, enabled: item.enabled })),
      view: submenuOf('View').map((item) => ({
        label: item.label,
        enabled: item.enabled,
        checked: item.checked
      })),
      openRecent: openRecentItems.map((item) => item.label)
    }
  })
}

async function windowTitle(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? '')
}

test('Gate 30: a real application menu is installed, tracks window state, and drives the app', async () => {
  test.setTimeout(90_000)

  const {
    app,
    close,
    userDataDir: expectedUserDataDir
  } = await launchIsolatedApp(['out/main/index.js'])

  try {
    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    const userDataDir = await app.evaluate(({ app }) => app.getPath('userData'))
    expect(await realpath(userDataDir)).toBe(await realpath(expectedUserDataDir))

    // ---- 1. A menu genuinely exists, with the expected top-level shape ----
    const initial = await readMenu(app)
    expect(initial).not.toBeNull()
    const expectedTopLevel =
      process.platform === 'darwin'
        ? ['PageDown', 'File', 'Edit', 'View', 'Window', 'Help']
        : ['File', 'Edit', 'View', 'Window', 'Help']
    expect(initial!.topLevel).toEqual(expectedTopLevel)

    // ---- 2. Enablement follows the focused window's real state ----
    // On Home there is no document, so every document-scoped File item is
    // disabled. This is the renderer -> window:setState IPC -> menu rebuild
    // round trip, end to end: nothing in main knows what screen is showing
    // except what the renderer told it.
    const initialFile = new Map(initial!.file.map((item) => [item.label, item.enabled]))
    expect(initialFile.get('Save')).toBe(false)
    expect(initialFile.get('Save As…')).toBe(false)
    expect(initialFile.get('Export as PDF…')).toBe(false)
    expect(initialFile.get('Print…')).toBe(false)
    // The ways INTO a document stay available -- gating them on already
    // having one would be circular.
    expect(initialFile.get('New')).toBe(true)
    expect(initialFile.get('Open…')).toBe(true)

    // With no document, the title is the bare product name -- NOT
    // "• Untitled — PageDown", even though documentStore always keeps one
    // blank tab alive.
    await expect
      .poll(() => windowTitle(app), { message: 'expected the Home-screen title', timeout: 10_000 })
      .toBe('PageDown')

    // ---- 3. Open a real document, through the real UI ----
    const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate30-'))
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const fixtureFilename = `gate30-fixture-${nonce}.md`
    const fixturePath = join(fixtureDir, fixtureFilename)
    await writeFile(fixturePath, `# Gate 30 Fixture ${nonce}\n\nBody text.\n`, 'utf8')

    const originalRecents = await readRecentFiles(userDataDir)
    try {
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

      // Open Recent is built from the real recent-files allowlist, and this
      // asserts it AFTER opening the document rather than straight after
      // seeding the file -- which is not merely convenient ordering. Seeding
      // recent-files.json from outside the app is invisible to it: the menu
      // is rebuilt when the APP writes that file (the addRecentFile call
      // sites in src/main/index.ts) or on a focus change, not by watching the
      // file. Measured, not assumed -- an earlier version of this gate
      // asserted right after seeding and read back ["No Recent Documents"].
      // Opening the document goes through the real file:openPath handler,
      // which is exactly the addRecentFile -> refreshApplicationMenu path
      // this assertion should be covering anyway.
      await expect
        .poll(async () => (await readMenu(app))?.openRecent ?? [], {
          message: 'expected the opened document to appear under File > Open Recent',
          timeout: 10_000
        })
        .toContain(fixtureFilename)

      // Now that a document is on screen, the same items are enabled. Polled
      // because the enabling travels renderer effect -> IPC -> menu rebuild.
      await expect
        .poll(
          async () => {
            const menu = await readMenu(app)
            return menu?.file.find((item) => item.label === 'Save')?.enabled ?? null
          },
          { message: 'expected File > Save to enable once a document is open', timeout: 10_000 }
        )
        .toBe(true)

      // The View menu's radio checkmark reports the window's real view mode.
      const viewMenu = (await readMenu(app))!.view
      expect(viewMenu.find((item) => item.label === 'Format')?.checked).toBe(true)
      expect(viewMenu.find((item) => item.label === 'Source')?.checked).toBe(false)
      expect(viewMenu.find((item) => item.label === 'Toggle Sidebar')?.enabled).toBe(true)

      // ---- 4. The title tracks the document, then its dirty state ----
      await expect
        .poll(() => windowTitle(app), {
          message: 'expected the open document in the window title',
          timeout: 10_000
        })
        .toBe(`${fixtureFilename} — PageDown`)

      // A real DOM mutation under ProseMirror's contenteditable root, the
      // same technique Gate 11 uses -- picked up by ProseMirror's own
      // MutationObserver as a genuine transaction.
      await win.evaluate(() => {
        const proseMirror = document.querySelector('.milkdown-mount .ProseMirror')
        const h1 = proseMirror?.querySelector('h1')
        if (!h1?.firstChild) throw new Error('expected a text node inside the mounted h1')
        h1.firstChild.textContent = `${h1.firstChild.textContent} EDITED`
      })

      // The bullet marker appears once the edit reaches the store (through
      // Milkdown's own ~200ms listener debounce), which is why this polls.
      await expect
        .poll(() => windowTitle(app), {
          message: 'expected the unsaved-changes marker in the window title',
          timeout: 10_000
        })
        .toBe(`• ${fixtureFilename} — PageDown`)

      if (process.platform === 'darwin') {
        // The macOS-only half: the real dot inside the window's close button,
        // which the title's bullet complements rather than replaces.
        expect(
          await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.isDocumentEdited()
          )
        ).toBe(true)
      }

      // ---- 5. A menu item's click handler genuinely drives the app ----
      // Invoked from the main process (menuItem.click()), NOT by clicking the
      // OS menu -- see this file's header for exactly what that does and does
      // not prove. Everything downstream of the click is this feature's own
      // code: dispatchMenuCommand -> focused window -> preload validation ->
      // EditorScreen's handler -> handleSetViewMode.
      const clicked = await app.evaluate(({ Menu }) => {
        const view = Menu.getApplicationMenu()?.items.find((item) => item.label === 'View')
        const source = view?.submenu?.items.find((item) => item.label === 'Source')
        if (!source) return false
        source.click()
        return true
      })
      expect(clicked).toBe(true)

      // The renderer really switched surfaces: Source mode replaces the
      // Milkdown canvas with a plain textarea.
      await expect(win.locator('textarea.pagedown-source-editor')).toBeVisible({ timeout: 10_000 })

      // ...and the menu's own radio checkmark followed it back, proving the
      // round trip closed rather than the renderer moving while the menu went
      // stale.
      await expect
        .poll(
          async () => {
            const menu = await readMenu(app)
            return menu?.view.find((item) => item.label === 'Source')?.checked ?? null
          },
          { message: 'expected View > Source to become the checked radio item', timeout: 10_000 }
        )
        .toBe(true)
    } finally {
      await writeRecentFiles(userDataDir, originalRecents)
      await rm(fixtureDir, { recursive: true, force: true })
    }
  } finally {
    await close()
  }
})
