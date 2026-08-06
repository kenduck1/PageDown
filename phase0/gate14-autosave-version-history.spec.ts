import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile, stat, utimes, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'
import { canonicalizeDocumentPath } from '../src/main/file-io'
import { hashDocumentPath } from '../src/main/version-history'

// Real, end-to-end coverage for the autosave + crash recovery + version
// history feature (docs/superpowers/specs/2026-08-05-autosave-version-
// history-design.md): a real renderer-page window.api call, through the
// real contextBridge, into the real main-process handlers, into a real
// version-history.ts snapshot store on a real (isolated) userData
// directory. Uses launchIsolatedApp, not a bare electron.launch() -- see
// that helper's own comment for why.
//
// Known environmental flakiness, independently reproduced and measured
// THREE times now (building this file; a second reviewing session's
// independent verification; a fix-round-1 hardening pass) -- see
// CLAUDE.md's Testing section for the full writeup. Concretely: under real
// host load on this development machine, `_electron` app.close() (and even
// locating the main window) can hang or take tens of seconds. The decisive
// control: `gate13-pdf-export-ipc.spec.ts`'s "does not degrade" test --
// completely unmodified by this plan -- fails at the identical ~20s
// signature this file's own real-UI test hits, while
// `gate11-editor-save-race.spec.ts` (also unmodified, also exercises
// `save()`) passes far more reliably. That contrast is what pins this down
// as a load-sensitive characteristic of this host/suite, not (or at least
// not solely) a defect in this feature's own code -- a future reader
// hitting a flaky run here should check `uptime` and re-run in isolation
// before assuming a product regression, though CLAUDE.md's Testing section
// also records that this control does NOT fully rule out this feature's
// own main-process code (queues, autosave interval) perturbing teardown,
// since gate11/gate13/gate14 all launch the SAME built app.
//
// `getMainWindow` and `safeClose` below harden against the SYMPTOM (a
// hung/slow teardown escalating into a leaked, unkillable Electron process
// tree), not the underlying host-load flakiness itself, which they cannot
// and do not fix -- measured, not assumed: two separate `--repeat-each=3`
// runs (12 launches each) against this hardened version measured 7/12 and
// 8/12 passing under sustained host load (average ~4.6-6.6), both with
// EVERY failure a clean, bounded "Test timeout of 60000ms exceeded" or
// getMainWindow's own thrown timeout -- not a single indefinite hang, and
// (in the second run) zero instances of Playwright's own additional
// "Worker teardown timeout" escalation that un-hardened runs hit
// repeatedly. Residual flakiness under load is expected and accepted; a
// leaked, un-torn-down Electron process on every flaky run is not, and is
// what this hardening actually targets.
const GET_MAIN_WINDOW_TIMEOUT_MS = 60_000

async function getMainWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + GET_MAIN_WINDOW_TIMEOUT_MS
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      // Check the URL FIRST, before waiting for load state -- cheap, and
      // rules out the sandboxed pagedown-render:// window (this app also
      // launches one at startup; see e.g. gate9/gate11's own identical
      // comments) without spending any of the per-candidate budget waiting
      // on THAT window's load state. Every window (including the eventual
      // real main one) starts on about:blank before its real navigation
      // completes, so this stays a POSITIVE file:// match, not a negative
      // exclusion -- CLAUDE.md documents why a negative-only filter would
      // misidentify a not-yet-navigated window as the main one.
      if (!candidate.url().startsWith('file://')) continue
      try {
        await candidate.waitForLoadState('domcontentloaded', { timeout: 2000 })
      } catch {
        continue
      }
      return candidate
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

const CLOSE_TIMEOUT_MS = 15_000

// gate14 has directly reproduced (see this file's header comment and
// CLAUDE.md's Testing section) that app.close() can hang indefinitely on
// this host under load -- escalating what would otherwise be a fast test
// into a 60s test timeout PLUS a separate 60s worker-teardown timeout,
// while leaking a live 6+-process Electron tree the whole time (CLAUDE.md's
// own documented concern about un-torn-down gate processes). Bounding
// close() HERE, in this file only -- not in phase0/electron-launch.ts,
// which every other gate shares, and changing its behavior for all of them
// is out of scope for this file -- so a hung graceful shutdown can't block
// the test runner (or leak a process) indefinitely: race close() against a
// fixed timeout, and on expiry, force-kill the process tree directly and
// clean up the temp userData directory ourselves, since
// launchIsolatedApp's own close() may never reach its own rm() call if
// it's stuck awaiting app.close().
async function safeClose(
  app: ElectronApplication,
  close: () => Promise<void>,
  userDataDir: string
): Promise<void> {
  // Attach handlers to the close() promise immediately, regardless of which
  // side of the race below wins, so a resolution/rejection that arrives
  // AFTER the timeout branch was already taken never surfaces as an
  // unhandled rejection.
  const closeOutcome = close().then(
    () => 'closed' as const,
    () => 'closed' as const
  )
  const outcome = await Promise.race([
    closeOutcome,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), CLOSE_TIMEOUT_MS))
  ])
  if (outcome === 'timeout') {
    try {
      // SIGKILL, not the default SIGTERM: a hung app.close() means the
      // main process's graceful-shutdown path is itself the thing that
      // isn't completing, so a signal it could catch/defer is exactly the
      // wrong tool here -- SIGKILL can't be caught, deferred, or ignored,
      // guaranteeing the OS actually reclaims this process rather than
      // trusting a possibly-wedged event loop to notice a softer signal.
      app.process().kill('SIGKILL')
    } catch {
      // Best-effort -- if the process is already gone or unkillable for
      // some other reason, there's nothing more to do here beyond the
      // userData cleanup below.
    }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

test('Gate 14: opening a document with a newer autosave snapshot silently loads that content', async () => {
  test.setTimeout(60_000)

  // `close`/`app`/`userDataDir`/`fixtureDir` are declared outside the try so
  // `finally` can reach them, but the ACQUISITION of all of them now
  // happens INSIDE the try (fix-round-1 finding: they previously sat
  // outside try/finally entirely, so a failure in the second acquisition --
  // e.g. mkdtemp throwing after a successful launch -- would skip cleanup
  // and leak a live multi-process Electron instance). They stay `undefined`
  // if launchIsolatedApp itself throws, which is correct: nothing was
  // returned to this test in that case, so there is nothing here to tear
  // down (any partial state is inside launchIsolatedApp's own scope, not
  // this test's).
  let app: ElectronApplication | undefined
  let close: (() => Promise<void>) | undefined
  let userDataDir: string | undefined
  let fixtureDir: string | undefined

  try {
    const launched = await launchIsolatedApp(['.'])
    app = launched.app
    close = launched.close
    userDataDir = launched.userDataDir

    fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate14-'))

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

    // This test deliberately calls window.api.openPath directly at the IPC
    // boundary, not through real UI navigation, so it never touches
    // documentStore at all. "A recovered document lands dirty" is a
    // documentStore/loadDocument concern, already covered directly by
    // documentStore.test.ts's "openFile lands the document dirty when the
    // result is recoveredFromAutosave" -- this test's own job is proving
    // the main-process handler chain (autosaveSnapshot -> openPath's
    // recovery check) produces the right recoveredFromAutosave flag and
    // content in the first place, which is a separate concern from what
    // documentStore then does with that flag.
    expect(result.recoveredFromAutosave).toBe(true)
    expect(result.content).toBe('# Newer autosaved content')
  } finally {
    if (app && close && userDataDir) await safeClose(app, close, userDataDir)
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
  }
})

test('Gate 14: clearing pending autosave means a subsequent open does NOT recover the discarded content', async () => {
  test.setTimeout(60_000)

  let app: ElectronApplication | undefined
  let close: (() => Promise<void>) | undefined
  let userDataDir: string | undefined
  let fixtureDir: string | undefined

  try {
    const launched = await launchIsolatedApp(['.'])
    app = launched.app
    close = launched.close
    userDataDir = launched.userDataDir

    fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate14-clear-'))

    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    const docPath = join(fixtureDir, 'doc.md')
    await writeFile(docPath, '# Original content')
    await seedRecentFile(userDataDir, docPath)

    // Same fix, same reason, as the previous test's mtime backdate: without
    // this, the snapshot written a moment later never clears
    // MTIME_TOLERANCE_MS (2s) above the file's own mtime, so recovery would
    // correctly NOT fire even if clearPendingAutosave were a complete
    // no-op -- making expect(recoveredFromAutosave).toBe(false) below
    // vacuous (it would pass whether or not the clear actually did
    // anything). Backdating makes "recovery WOULD fire if the clear didn't
    // work" genuinely true first, so the clear -- not the mtime tolerance
    // -- is what's actually being exercised.
    const fileStat = await stat(docPath)
    const backdated = new Date(fileStat.mtimeMs - 60_000)
    await utimes(docPath, backdated, backdated)

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

    // Positive proof of the delete itself, not just an inference from
    // openPath's behavior below: read the real snapshots directory
    // directly off disk (bypassing IPC entirely), using the exact same
    // canonicalization + hashing version-history.ts itself uses, and
    // confirm the snapshot file written above is actually gone.
    const canonicalPath = await canonicalizeDocumentPath(docPath)
    const snapshotsDir = join(
      userDataDir,
      'version-history',
      hashDocumentPath(canonicalPath),
      'snapshots'
    )
    const remainingSnapshots = await readdir(snapshotsDir).catch(() => [] as string[])
    expect(remainingSnapshots).toEqual([])

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
    if (app && close && userDataDir) await safeClose(app, close, userDataDir)
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
  }
})

test('Gate 14: the History sidebar tab lists a real saved version and restoring it replaces the live editor content', async () => {
  // Bumped from 60s to 120s (fix-round-1): this is the one test in this
  // file that does real UI navigation (a Home-screen reload + click,
  // mounting EditorScreen, a real History-sidebar restore round trip) on
  // top of getMainWindow's own now-60s search budget -- see this file's
  // header comment and CLAUDE.md's Testing section for the measured host-
  // load flakiness this is hardening against, not fixing away.
  test.setTimeout(120_000)

  let app: ElectronApplication | undefined
  let close: (() => Promise<void>) | undefined
  let userDataDir: string | undefined
  let fixtureDir: string | undefined

  try {
    const launched = await launchIsolatedApp(['.'])
    app = launched.app
    close = launched.close
    userDataDir = launched.userDataDir

    fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate14-ui-'))

    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    // Nonce-unique filename + a role-scoped locator on click, matching
    // gate11-editor-save-race.spec.ts's own established pattern -- a bare
    // getByText('doc.md') is a case-insensitive substring match that
    // happened to work with a single seeded recent-file entry, but is
    // looser than necessary and risks future strict-mode ambiguity.
    //
    // Deliberately does NOT contain "history": a real, reproduced bug in an
    // earlier version of this fix used `gate14-history-${nonce}.md`, and
    // EditorTabBar.tsx gives every open tab's close button an
    // `aria-label="Close ${filename}"` with NO truncation -- so
    // "Close gate14-history-....md" itself contains the substring
    // "history", which then case-insensitively matched the sidebar's own
    // "History" tab-pill button below (a bare string `name` option is a
    // case-insensitive SUBSTRING match, not exact), producing a real
    // `strict mode violation: ... resolved to 2 elements` failure under
    // `--repeat-each`. Fixed two ways for defense in depth: this filename
    // no longer contains "history" at all, AND the "History" button locator
    // below now passes `exact: true` so no future fixture name (here or in
    // a test added later) can reopen the same collision.
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const fixtureFilename = `gate14-restore-${nonce}.md`
    const docPath = join(fixtureDir, fixtureFilename)

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

    await win
      .getByRole('button', { name: new RegExp(fixtureFilename.replace(/[.]/g, '\\.')) })
      .click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')
    await expect(win.locator('.milkdown-mount')).toContainText('Current content')

    // exact: true -- see this test's own comment above on the real
    // strict-mode collision this guards against (a tab's own close-button
    // aria-label can legitimately contain "history" as a substring).
    await win.getByRole('button', { name: 'History', exact: true }).click()
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
    if (app && close && userDataDir) await safeClose(app, close, userDataDir)
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
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
// checks would break no test without this.
//
// Fix-round-1 note: the first version of this test only ever exercised a
// path that was NEVER known, so getVersionHistory/restoreVersionContent
// would have returned []/null even with their isKnownPath guards completely
// removed (no index.json exists for a never-touched path either way) --
// genuinely covering only autosaveSnapshot/clearPendingAutosave (via the
// readdir diff), not all four, and with no positive control proving the
// readdir diff / userDataDir wiring actually works. Restructured below:
// first a KNOWN-path autosave proves a real directory gets created (and
// that versionHistoryRoot really is this test's own isolated userData, not
// the real developer one -- if isolation were silently broken, this
// assertion would fail loudly instead of every later assertion passing
// vacuously). The path is then REMOVED from the allowlist (isKnownPath
// re-reads recent-files.json from disk on every call) and
// getVersionHistory/restoreVersionContent are asserted to hide the REAL
// history that now exists on disk for it -- a genuine negative test, not
// an "empty because nothing was ever there" one. autosaveSnapshot/
// clearPendingAutosave are then re-checked against a SEPARATE, never-known
// path (not the same path reused after un-seeding) so a hypothetically
// broken guard writing into an ALREADY-EXISTING directory couldn't hide
// behind an unchanged directory count.
test('Gate 14: the four version-history IPC handlers drop an unknown (non-allowlisted) path instead of touching disk', async () => {
  test.setTimeout(60_000)

  let app: ElectronApplication | undefined
  let close: (() => Promise<void>) | undefined
  let userDataDir: string | undefined
  let fixtureDir: string | undefined

  try {
    const launched = await launchIsolatedApp(['.'])
    app = launched.app
    close = launched.close
    userDataDir = launched.userDataDir

    fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate14-unknown-'))

    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    const versionHistoryRoot = join(userDataDir, 'version-history')

    // --- Positive control ---------------------------------------------
    const knownPath = join(fixtureDir, 'known.md')
    await writeFile(knownPath, '# Known document')
    await seedRecentFile(userDataDir, knownPath)

    const dirsBeforeKnown = await readdir(versionHistoryRoot).catch(() => [] as string[])
    await win.evaluate(
      (p) =>
        (
          window as unknown as {
            api: { autosaveSnapshot: (c: string, f: string) => Promise<void> }
          }
        ).api.autosaveSnapshot('# Known document, snapshot one', p),
      knownPath
    )
    const dirsAfterKnown = await readdir(versionHistoryRoot).catch(() => [] as string[])
    // A real directory appeared -- proves both directory-creation AND that
    // versionHistoryRoot is genuinely this test's isolated userData.
    expect(dirsAfterKnown.length).toBe(dirsBeforeKnown.length + 1)

    const knownHistory = await win.evaluate(
      (p) =>
        (
          window as unknown as {
            api: { getVersionHistory: (f: string) => Promise<{ id: string }[]> }
          }
        ).api.getVersionHistory(p),
      knownPath
    )
    expect(knownHistory.length).toBeGreaterThan(0)
    const realSnapshotId = knownHistory[knownHistory.length - 1].id

    // --- Un-seed the SAME path and prove real data becomes unreachable --
    const recentsWithoutKnown = (await readRecentFiles(userDataDir)).filter(
      (entry) => entry.filePath !== knownPath
    )
    await writeRecentFiles(userDataDir, recentsWithoutKnown)

    const historyAfterUnseed = await win.evaluate(
      (p) =>
        (
          window as unknown as { api: { getVersionHistory: (f: string) => Promise<unknown[]> } }
        ).api.getVersionHistory(p),
      knownPath
    )
    expect(historyAfterUnseed).toEqual([])

    const restoredAfterUnseed = await win.evaluate(
      ({ p, id }) =>
        (
          window as unknown as {
            api: {
              restoreVersionContent: (f: string, snapshotId: string) => Promise<string | null>
            }
          }
        ).api.restoreVersionContent(p, id),
      { p: knownPath, id: realSnapshotId }
    )
    expect(restoredAfterUnseed).toBeNull()

    // --- A SEPARATE, never-known path proves autosaveSnapshot/
    // clearPendingAutosave don't touch disk for an unknown path either ---
    const neverKnownPath = join(fixtureDir, 'never-known.md')
    await writeFile(neverKnownPath, '# Never opened through this app')

    const dirsBeforeUnknown = await readdir(versionHistoryRoot).catch(() => [] as string[])

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
        neverKnownPath
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
        neverKnownPath
      )
    ).resolves.toBeUndefined()

    // The real proof that nothing was written: no ADDITIONAL directory
    // appeared under <userDataDir>/version-history/ beyond the one the
    // positive control above already created for knownPath. If
    // autosaveSnapshot's isKnownPath guard were ever dropped or reordered,
    // this would create a fresh hash-keyed directory for neverKnownPath's
    // canonical path -- exactly the arbitrary-write primitive CLAUDE.md's
    // File I/O security invariant section warns against.
    const dirsAfterUnknown = await readdir(versionHistoryRoot).catch(() => [] as string[])
    expect(dirsAfterUnknown).toEqual(dirsBeforeUnknown)
  } finally {
    if (app && close && userDataDir) await safeClose(app, close, userDataDir)
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
  }
})
