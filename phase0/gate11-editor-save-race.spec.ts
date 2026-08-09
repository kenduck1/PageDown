import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'
import { launchIsolatedApp } from './electron-launch'

// This is the permanent version of the finding Task 8 fixed and verified
// with two throwaway, deleted-after-use Playwright scripts (see
// .superpowers/sdd/2026-08-04-editor-canvas/task-8-report.md's "Manual
// verification against the real built app" sections): @milkdown/plugin-
// listener's markdownUpdated fires through an internal lodash-es
// debounce(200) (confirmed by reading its source -- see CLAUDE.md's
// "Milkdown/ProseMirror" Quirk note), so a Save click within that window of
// the user's last keystroke could previously save the PRE-edit content.
// The fix (MilkdownEditor.tsx's MilkdownEditorHandle.flush(), called by
// EditorScreen's handleSave) reads the editor's live document directly,
// bypassing the debounce -- this gate reproduces the exact race end-to-end
// against the real built app (real UI navigation, real DOM edit, real Save
// click, real disk read-back), reusing the approach the throwaway scripts
// already proved rather than designing from scratch, per this project's own
// established convention of promoting exactly this kind of ad-hoc
// verification into a permanent gate once it's proven valuable (Home
// Screen's Gate 9 is the direct precedent).
const EDIT_TO_SAVE_DELAY_MS = 30

// Same pattern as phase0/gate9-thumbnail-concurrency.spec.ts's own
// `getMainWindow` (also reused verbatim by phase0/gate10-editor-layout-
// parity.spec.ts) -- this app launches a SECOND window at startup (the
// Phase 0 spike's `createPaginationHarness(mainWindow)` wiring in
// src/main/index.ts), whose page loads under the sandboxed
// `pagedown-render://` custom scheme and has zero contextBridge/`window.api`
// access. Matched by a POSITIVE `file://` check (not a negative exclusion)
// for the same reason documented in gate9: every window starts on
// `about:blank` before its real navigation completes.
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

test('Gate 11: Save picks up a real edit made well within the 200ms onChange debounce window', async () => {
  test.setTimeout(60_000)

  const {
    app,
    close,
    userDataDir: expectedUserDataDir
  } = await launchIsolatedApp(['out/main/index.js'])

  try {
    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    // Direct, non-vacuous proof that launchIsolatedApp's --user-data-dir
    // switch actually took effect for the app instance THIS test launched --
    // same check, same reasoning (including the macOS /var vs /private/var
    // symlink wrinkle that requires realpath() on both sides before
    // comparing) as phase0/gate5-sandbox.spec.ts's identical proof. userDataDir
    // below is read from the real running main process via app.evaluate(),
    // and is also the value the rest of this test uses to seed/restore the
    // real recent-files.json allowlist -- not a separate, unused value only
    // computed for this assertion.
    const userDataDir = await app.evaluate(({ app }) => app.getPath('userData'))
    expect(await realpath(userDataDir)).toBe(await realpath(expectedUserDataDir))

    // A real fixture file on disk, in a real OS temp directory -- NOT userData
    // (userData is reserved for the app's own state, e.g. recent-files.json
    // and thumbnails), matching src/main/recent-files.test.ts's own
    // mkdtemp(tmpdir(), ...) convention for "a real temp directory, cleaned up
    // after the test."
    const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate11-'))
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const fixtureFilename = `gate11-fixture-${nonce}.md`
    const fixturePath = join(fixtureDir, fixtureFilename)
    const ORIGINAL = `# Gate 11 Fixture ${nonce}\n\nOriginal line.\n`
    await writeFile(fixturePath, ORIGINAL, 'utf8')

    // Back up the real, developer's recent-files.json so this gate never
    // leaves a lasting side effect on the dev environment -- restored in the
    // `finally` block below, matching task-8-report.md's manual-verification
    // scripts' own stated approach ("merged in, then restored the developer's
    // original file exactly afterward").
    const originalRecents = await readRecentFiles(userDataDir)

    try {
      // Seed the fixture into the real allowlist (`isKnownPath`, checked by
      // the real `file:openPath`/`dialog:confirmDiscard`-adjacent `file:save`
      // IPC handlers in src/main/index.ts) -- this is what lets the editor's
      // eventual Save write straight to `fixturePath` via `saveFile(filePath,
      // content)` instead of popping a real, unautomatable native Save-As
      // dialog.
      const seeded = mergeRecentFiles(originalRecents, fixturePath, new Date().toISOString())
      await writeRecentFiles(userDataDir, seeded)

      // HomeScreen's `recentFiles` state is fetched once on mount
      // (`useEffect(() => { window.api.getRecentFiles().then(setRecentFiles) },
      // [])`) -- it already ran, with the PRE-seed allowlist, by the time
      // getMainWindow() returned above. Reload so it re-fetches with our
      // fixture included.
      await win.reload()
      await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

      await win
        .getByRole('button', { name: new RegExp(fixtureFilename.replace(/[.]/g, '\\.')) })
        .click()

      await win.waitForSelector('.milkdown-mount .ProseMirror')

      // A real DOM mutation under the ProseMirror-managed contenteditable
      // root -- the same technique MilkdownEditor.test.tsx's own "real edit"
      // tests use, which ProseMirror's internal MutationObserver picks up and
      // turns into a real transaction, the same as any keystroke would in a
      // real browser.
      await win.evaluate(() => {
        const proseMirror = document.querySelector('.milkdown-mount .ProseMirror')
        const h1 = proseMirror?.querySelector('h1')
        if (!h1?.firstChild) throw new Error('expected a text node inside the mounted h1')
        h1.firstChild.textContent = `${h1.firstChild.textContent} EDITED`
        const range = document.createRange()
        range.selectNodeContents(h1)
        range.collapse(false)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      })

      // Give ProseMirror's own MutationObserver one tick to register the edit
      // into its state (so MilkdownEditorHandle.flush() has a real edit to
      // pick up), but click Save well before plugin-listener's 200ms
      // debounce -- the exact race this gate exists to prove is closed.
      await win.waitForTimeout(EDIT_TO_SAVE_DELAY_MS)

      await win.getByRole('button', { name: 'Save' }).click()

      // Read the actual file back off disk, polling briefly for the real
      // IPC/fs round trip to land rather than asserting immediately.
      await expect
        .poll(async () => readFile(fixturePath, 'utf8'), {
          message: 'expected the saved file to contain the EDITED marker',
          timeout: 5_000
        })
        .toContain('EDITED')

      const savedContent = await readFile(fixturePath, 'utf8')
      expect(savedContent).not.toBe(ORIGINAL)
      expect(savedContent).toContain('EDITED')
    } finally {
      await writeRecentFiles(userDataDir, originalRecents)
      await rm(fixtureDir, { recursive: true, force: true })
    }
  } finally {
    await close()
  }
})
