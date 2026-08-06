import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile, stat, utimes, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'

// Real, end-to-end coverage for the autosave + crash recovery + version
// history feature (docs/superpowers/specs/2026-08-05-autosave-version-
// history-design.md): a real renderer-page window.api call, through the
// real contextBridge, into the real main-process handlers, into a real
// version-history.ts snapshot store on a real (isolated) userData
// directory. Uses launchIsolatedApp, not a bare electron.launch() -- see
// that helper's own comment for why.
async function getMainWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      try {
        await candidate.waitForLoadState('domcontentloaded', { timeout: 500 })
      } catch {
        continue
      }
      if (candidate.url().startsWith('file://')) return candidate
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out locating the main app-shell window (only found the sandboxed one)')
}

async function seedRecentFile(userDataDir: string, filePath: string): Promise<void> {
  const existing = await readRecentFiles(userDataDir)
  await writeRecentFiles(
    userDataDir,
    mergeRecentFiles(existing, filePath, new Date().toISOString())
  )
}

test('Gate 14: opening a document with a newer autosave snapshot silently loads that content and lands the document dirty', async () => {
  test.setTimeout(60_000)

  const { app, close, userDataDir } = await launchIsolatedApp(['.'])
  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate14-'))

  try {
    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    const docPath = join(fixtureDir, 'doc.md')
    await writeFile(docPath, '# On-disk content')
    await seedRecentFile(userDataDir, docPath)

    // Backdate the on-disk file's mtime before writing the snapshot below.
    // Without this, both operations land within milliseconds of each other
    // in real execution, and file-io.ts's resolveContentWithRecovery
    // requires the snapshot to be MORE than MTIME_TOLERANCE_MS (2s) newer
    // than the file's mtime before it counts as recovery-worthy (see that
    // file's own comment: this tolerance exists to absorb filesystem mtime
    // granularity and mtime-preserving restores). A snapshot written mere
    // milliseconds after the file would correctly NOT trigger recovery,
    // silently defeating this test's whole premise -- confirmed by running
    // it without this line first, which failed with recoveredFromAutosave
    // === false. Push the file's mtime unambiguously into the past instead
    // of relying on real wall-clock delay between the two awaits above.
    const fileStat = await stat(docPath)
    const backdated = new Date(fileStat.mtimeMs - 60_000)
    await utimes(docPath, backdated, backdated)

    // Write a newer autosave snapshot via the real IPC surface -- window.api
    // through the real contextBridge into the real file:autosaveSnapshot
    // handler -- not by touching version-history.ts's files directly, so
    // this exercises the real handler end to end, not just the storage
    // module in isolation.
    await win.evaluate(
      (p) =>
        (
          window as unknown as {
            api: { autosaveSnapshot: (c: string, f: string) => Promise<void> }
          }
        ).api.autosaveSnapshot('# Newer autosaved content', p),
      docPath
    )

    const result = await win.evaluate(
      (p) =>
        (
          window as unknown as {
            api: {
              openPath: (f: string) => Promise<{ content: string; recoveredFromAutosave: boolean }>
            }
          }
        ).api.openPath(p),
      docPath
    )

    expect(result.recoveredFromAutosave).toBe(true)
    expect(result.content).toBe('# Newer autosaved content')
  } finally {
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})

test('Gate 14: clearing pending autosave means a subsequent open does NOT recover the discarded content', async () => {
  test.setTimeout(60_000)

  const { app, close, userDataDir } = await launchIsolatedApp(['.'])
  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate14-clear-'))

  try {
    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    const docPath = join(fixtureDir, 'doc.md')
    await writeFile(docPath, '# Original content')
    await seedRecentFile(userDataDir, docPath)

    const beforeDiscard = new Date().toISOString()
    await win.evaluate(
      (p) =>
        (
          window as unknown as {
            api: { autosaveSnapshot: (c: string, f: string) => Promise<void> }
          }
        ).api.autosaveSnapshot('# Content about to be discarded', p),
      docPath
    )

    await win.evaluate(
      ({ p, since }) =>
        (
          window as unknown as {
            api: { clearPendingAutosave: (f: string, s: string) => Promise<void> }
          }
        ).api.clearPendingAutosave(p, since),
      { p: docPath, since: beforeDiscard }
    )

    const result = await win.evaluate(
      (p) =>
        (
          window as unknown as {
            api: {
              openPath: (f: string) => Promise<{ content: string; recoveredFromAutosave: boolean }>
            }
          }
        ).api.openPath(p),
      docPath
    )

    expect(result.recoveredFromAutosave).toBe(false)
    expect(result.content).toBe('# Original content')
  } finally {
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})

test('Gate 14: the History sidebar tab lists a real saved version and restoring it replaces the live editor content', async () => {
  test.setTimeout(60_000)

  const { app, close, userDataDir } = await launchIsolatedApp(['.'])
  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate14-ui-'))

  try {
    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    const docPath = join(fixtureDir, 'doc.md')

    // The CURRENT on-disk content is deliberately different from the
    // snapshot below -- opening the doc loads "Current content" (no
    // recovery involved), and restoring the history entry is what brings
    // "Version one" back. This is what makes the final assertion
    // unambiguous: if restore silently no-ops, the editor would still show
    // "Current content", not a false-positive match.
    await writeFile(docPath, '# Current content\n\nEdited body.\n')
    await seedRecentFile(userDataDir, docPath)

    await win.evaluate(
      (p) =>
        (
          window as unknown as {
            api: { autosaveSnapshot: (c: string, f: string) => Promise<void> }
          }
        ).api.autosaveSnapshot('# Version one\n\nOriginal body.\n', p),
      docPath
    )

    // The brief's comment for this fixture said the snapshot just written is
    // "intentionally OLDER than the file's own mtime" -- but the code above
    // writes the on-disk file FIRST and only THEN calls autosaveSnapshot,
    // which makes the snapshot's own timestamp NEWER than the file's mtime,
    // not older. That only "worked" by accident: file-io.ts's
    // MTIME_TOLERANCE_MS (2s) suppresses recovery for anything not MORE than
    // 2 seconds newer, and a snapshot written milliseconds after the file
    // practically never clears that margin. That's an accidental pass, not
    // a real guarantee -- it would silently invert (recovery firing and
    // loading "Version one" on open, defeating this test's whole premise)
    // the moment anyone tightens or removes the tolerance. Make the
    // intended ordering explicit and self-evidently correct instead of
    // relying on that margin: push the on-disk file's mtime forward so it
    // is genuinely, unambiguously newer than the snapshot, regardless of
    // how close together the two operations landed in wall-clock time.
    const fileStat = await stat(docPath)
    const newMtime = new Date(fileStat.mtimeMs + 60_000)
    await utimes(docPath, newMtime, newMtime)

    // Real UI navigation, not a raw IPC call -- window.api.openPath alone
    // would exercise only the IPC layer, never mounting EditorScreen (and
    // therefore never mounting the sidebar this test needs to click into).
    // Matches gate11-editor-save-race.spec.ts's own established pattern:
    // a seeded recent-files.json entry, then a real click on the Home
    // screen's own recent-file row. HomeScreen fetches its recentFiles list
    // ONCE on mount (see HomeScreen.tsx's own useEffect with an empty
    // dependency array) -- that fetch already ran, against the pre-seed
    // allowlist, by the time getMainWindow() returned above, so a reload is
    // required for the Home screen to see the file just seeded (same fix
    // gate11-editor-save-race.spec.ts's own comment documents for the exact
    // same reason).
    await win.reload()
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    await win.getByText('doc.md').click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')
    await expect(win.locator('.milkdown-mount')).toContainText('Current content')

    await win.getByRole('button', { name: 'History' }).click()
    const historyRow = win.getByRole('button', { name: /Restore version from/ })
    await expect(historyRow).toBeVisible()

    await historyRow.click()

    // The restore flow flushes+saves any dirty content first, then calls
    // documentStore.replaceContentForTab, which bumps revision and remounts
    // MilkdownEditor -- give it a moment to actually swap in the new DOM
    // rather than asserting immediately against the pre-restore mount.
    await expect(win.locator('.milkdown-mount')).toContainText('Version one', { timeout: 10_000 })
    await expect(win.locator('.milkdown-mount')).toContainText('Original body')
    await expect(win.locator('.milkdown-mount')).not.toContainText('Edited body')
  } finally {
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})

// Task 2's review flagged this as an Important finding, routed to this gate-
// coverage task: nothing verified that the four version-history IPC handlers
// (file:autosaveSnapshot, file:getVersionHistory, file:restoreVersionContent,
// file:clearPendingAutosave) actually honor CLAUDE.md's File I/O security
// invariant -- that ANY renderer-supplied path must be validated via
// isKnownPath() before touching disk. Two real vulnerabilities (arbitrary
// file read via openPath, arbitrary file write via save) existed in this
// exact codebase for exactly this class of bug before that check was added.
// A future refactor that drops or reorders one of these four isKnownPath
// checks would break no test without this. All four are asserted here for a
// single path deliberately never added to the recent-files allowlist.
test('Gate 14: the four version-history IPC handlers drop an unknown (non-allowlisted) path instead of touching disk', async () => {
  test.setTimeout(60_000)

  const { app, close, userDataDir } = await launchIsolatedApp(['.'])
  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate14-unknown-'))

  try {
    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    // A real, existing, harmless file on disk that is deliberately NEVER
    // seeded into recent-files.json -- so it's a well-formed path (in case
    // some future implementation detail starts stat-ing it) but is not
    // "known" by this app's own allowlist rule.
    const unknownPath = join(fixtureDir, 'not-a-recent-file.md')
    await writeFile(unknownPath, '# Never opened through this app')

    const versionHistoryRoot = join(userDataDir, 'version-history')
    const dirsBefore = await readdir(versionHistoryRoot).catch(() => [] as string[])

    const history = await win.evaluate(
      (p) =>
        (
          window as unknown as { api: { getVersionHistory: (f: string) => Promise<unknown[]> } }
        ).api.getVersionHistory(p),
      unknownPath
    )
    expect(history).toEqual([])

    const restored = await win.evaluate(
      (p) =>
        (
          window as unknown as {
            api: { restoreVersionContent: (f: string, id: string) => Promise<string | null> }
          }
        ).api.restoreVersionContent(p, '2026-01-01T00:00:00.000Z-abcd'),
      unknownPath
    )
    expect(restored).toBeNull()

    // Both of these resolve (never throw/reject) for an unknown path --
    // drop-not-throw, matching file:getPageCount's own established
    // rationale (src/main/index.ts): none of these operations is required
    // for the app to keep working, so an unknown path just means slightly
    // less protection, not a broken renderer promise.
    await expect(
      win.evaluate(
        (p) =>
          (
            window as unknown as {
              api: { autosaveSnapshot: (c: string, f: string) => Promise<void> }
            }
          ).api.autosaveSnapshot('# Should never be written', p),
        unknownPath
      )
    ).resolves.toBeUndefined()

    await expect(
      win.evaluate(
        (p) =>
          (
            window as unknown as {
              api: { clearPendingAutosave: (f: string, s: string) => Promise<void> }
            }
          ).api.clearPendingAutosave(p, new Date().toISOString()),
        unknownPath
      )
    ).resolves.toBeUndefined()

    // The real proof that nothing was written: no new directory appeared
    // under <userDataDir>/version-history/ at all. If autosaveSnapshot's
    // isKnownPath guard were ever dropped or reordered, this would create a
    // fresh hash-keyed directory for unknownPath's canonical path -- exactly
    // the arbitrary-write primitive CLAUDE.md's File I/O security invariant
    // section warns against.
    const dirsAfter = await readdir(versionHistoryRoot).catch(() => [] as string[])
    expect(dirsAfter).toEqual(dirsBefore)
  } finally {
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})
