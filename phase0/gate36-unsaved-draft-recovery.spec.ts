import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'

// Crash protection for NEVER-SAVED (untitled) documents.
//
// The autosave/version-history system is keyed entirely on a document's
// canonical file path, so a document that has never been saved was completely
// unprotected: `documentStore.save()`'s post-save snapshot never fires,
// `useAutosave`'s tick had nothing to key on, and every version-history entry
// point starts from `canonicalizeDocumentPath(filePath)`. Write for an hour in
// a new document, get force-quit, lose everything.
//
// WHY THIS NEEDS A GATE AT ALL, given the unit coverage. Three things are
// structurally unprovable anywhere else:
//
//   1. PERSISTENCE ACROSS A REAL PROCESS DEATH. Every unit test in this
//      feature runs inside one process against one in-memory store. The
//      product claim is specifically "your work survives the app dying", and
//      the only honest way to test that is to kill the app and start another
//      one on the same profile. Test 1 SIGKILLs the real Electron process --
//      no `close`, no `before-quit`, no graceful shutdown, nothing flushed on
//      the way out -- which is what an actual crash or a Force Quit does.
//   2. THE REAL 45-SECOND TICK. The renderer half is a `setInterval` inside
//      `useAutosave`, driven by the user's own autosave-interval preference.
//      Unit tests advance a fake clock; only a real run proves the real timer,
//      the real preference plumbing, the real contextBridge and the real
//      main-process handler line up end to end. Test 1 sets the interval to
//      its 5s floor through the real Settings UI and then waits for a
//      genuine, unmocked tick.
//   3. REAL PROSEMIRROR TYPING. The draft's content comes out of a live
//      Milkdown canvas via its 200ms `markdownUpdated` debounce. jsdom cannot
//      drive contenteditable (CLAUDE.md documents this at length), so only a
//      gate can prove the bytes that reach disk are the bytes that were typed.
//
// Follows gate14's template: `launchIsolatedApp`, try/finally at every call
// site, and its `getMainWindow` helper. Per CLAUDE.md's Testing section, a
// bare `Test timeout` that reaches no assertion is the documented
// environmental flake; a NAMED assertion failure here is a real regression.

const GET_MAIN_WINDOW_TIMEOUT_MS = 60_000

// The app's own minimum, enforced by preferences.ts's sanitizePreferences.
// Used so the gate waits seconds rather than the default 45.
const MIN_AUTOSAVE_SECONDS = 5

async function getMainWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + GET_MAIN_WINDOW_TIMEOUT_MS
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      // Positive file:// match, not a negative exclusion of the sandboxed
      // pagedown-render:// window -- see gate14's identical comment for why a
      // negative filter misidentifies a not-yet-navigated window.
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

/** Every draft file currently in the isolated profile's drafts directory. */
async function readDrafts(userDataDir: string): Promise<Array<{ name: string; content: string }>> {
  const dir = join(userDataDir, 'unsaved')
  const names = await readdir(dir).catch(() => [] as string[])
  return Promise.all(
    names
      .filter((name) => /^[0-9a-f]{32}\.md$/.test(name))
      .map(async (name) => ({ name, content: await readFile(join(dir, name), 'utf8') }))
  )
}

/** Sets the autosave interval to its 5s floor through the real Settings UI. */
async function setAutosaveIntervalToFloor(win: Page): Promise<void> {
  await win.getByRole('button', { name: 'Settings' }).click()
  const field = win.getByLabel('Autosave interval (seconds)')
  await field.waitFor({ state: 'visible' })
  await field.fill(String(MIN_AUTOSAVE_SECONDS))
  // The field is locally buffered and only commits on a valid parse, so
  // confirm the committed value round-tripped into main before moving on --
  // otherwise the whole test could silently fall back to the 45s default and
  // time out for a reason that reads like a product failure.
  await expect
    .poll(
      async () =>
        win.evaluate(async () => {
          const prefs = await (
            window as unknown as {
              api: { getPreferences: () => Promise<{ autosaveIntervalMs: number }> }
            }
          ).api.getPreferences()
          return prefs.autosaveIntervalMs
        }),
      { timeout: 10_000 }
    )
    .toBe(MIN_AUTOSAVE_SECONDS * 1000)
  // `.first()` because SettingsScreen renders two "← Home" controls (a header
  // one and a footer one) and Playwright's strict mode refuses an ambiguous
  // match. Either is equivalent here.
  await win.getByRole('button', { name: '← Home' }).first().click()
}

test('Gate 36: work typed into a never-saved document survives a hard kill and is offered back on relaunch', async () => {
  // Two full launches plus a real 5s autosave wait, so this needs more than
  // the usual budget -- same 120s bump, same reasoning, as gate14's own.
  test.setTimeout(180_000)

  // The gate owns the profile directory, because it has to outlive the first
  // app -- launchIsolatedApp's own directory is removed by its close(), which
  // would make "relaunch and find your work" untestable by construction. The
  // `pagedown-gate-userdata-` prefix keeps it inside the helper's own
  // stale-directory janitor, so a force-killed worker still cannot leak it
  // permanently.
  let userDataDir: string | undefined
  let closeFirst: (() => Promise<void>) | undefined
  let closeSecond: (() => Promise<void>) | undefined

  try {
    userDataDir = await mkdtemp(join(tmpdir(), 'pagedown-gate-userdata-gate36-'))

    // --- Launch 1: type into a brand-new, never-saved document -----------
    const first = await launchIsolatedApp(['.'], { userDataDir })
    closeFirst = first.close
    const win1 = await getMainWindow(first.app)
    await win1.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    // Nothing has ever been saved in this profile, so there is nothing to
    // recover yet. Asserted BEFORE the work exists so the post-crash
    // assertion cannot pass on a pre-existing artifact.
    expect(await readDrafts(userDataDir)).toEqual([])
    await expect(win1.getByText('Unsaved documents')).toHaveCount(0)

    await setAutosaveIntervalToFloor(win1)

    await win1.getByRole('button', { name: 'New document' }).click()
    await win1.waitForSelector('.milkdown-mount .ProseMirror')

    // Real typing into the real ProseMirror canvas -- the bytes that reach
    // disk have to come through Milkdown's own serializer and its 200ms
    // markdownUpdated debounce, which is the half jsdom cannot drive.
    await win1.locator('.milkdown-mount .ProseMirror').click()
    await win1.keyboard.type('Gate 36 unsaved work', { delay: 20 })

    // The real, unmocked autosave tick. Polling rather than a fixed sleep so
    // a slow machine does not turn a passing feature into a failing gate.
    await expect
      .poll(async () => (await readDrafts(userDataDir as string)).length, { timeout: 30_000 })
      .toBe(1)

    const beforeCrash = await readDrafts(userDataDir)
    expect(beforeCrash[0].content).toContain('Gate 36 unsaved work')

    // --- THE CRASH -------------------------------------------------------
    //
    // SIGKILL, not app.close(): a signal the process can catch would let
    // Electron run `before-quit`, the window-close guard and every graceful
    // teardown path, which is precisely the scenario this feature does NOT
    // exist for (that path already prompts to save). SIGKILL is what a real
    // crash, an OOM kill, or Force Quit looks like -- nothing gets to run on
    // the way out, so anything recovered afterwards was genuinely already on
    // disk before the process died.
    first.app.process().kill('SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    // The killed launch has nothing left to close, and calling close() on it
    // would only burn the bounded timeout.
    closeFirst = undefined

    // The work is still on disk with the app gone. This is the whole claim.
    const afterCrash = await readDrafts(userDataDir)
    expect(afterCrash).toHaveLength(1)
    expect(afterCrash[0].content).toContain('Gate 36 unsaved work')

    // --- Launch 2: the recovery surface ----------------------------------
    const second = await launchIsolatedApp(['.'], { userDataDir })
    closeSecond = second.close
    const win2 = await getMainWindow(second.app)
    await win2.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    // Offered on the Home screen, labelled by its own first line rather than
    // by a bare timestamp.
    await expect(win2.getByText('Unsaved documents')).toBeVisible({ timeout: 30_000 })
    await expect(win2.getByText('Gate 36 unsaved work')).toBeVisible()

    // Recovering puts the typed text back in a real editor.
    await win2.getByRole('button', { name: 'Recover' }).click()
    await win2.waitForSelector('.milkdown-mount .ProseMirror')
    await expect(win2.locator('.milkdown-mount .ProseMirror')).toContainText('Gate 36 unsaved work')
  } finally {
    if (closeSecond) await closeSecond()
    if (closeFirst) await closeFirst()
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true })
  }
})

test('Gate 36: discarding an unsaved document really deletes it, and it is never offered again', async () => {
  test.setTimeout(180_000)

  // The counterpart claim to the one above, and the one this feature area has
  // already got wrong once in production: CLAUDE.md records a shipped Critical
  // bug where "Don't Save" ran a discard that silently deleted NOTHING (a
  // renderer-supplied cutoff that could never match), so the discarded edit
  // came straight back as a "recovered" document on the very next open. This
  // asserts against the real filesystem AND against a real relaunch, because
  // asserting only that the call resolved is exactly what would have passed
  // against that bug.
  let userDataDir: string | undefined
  let closeFirst: (() => Promise<void>) | undefined
  let closeSecond: (() => Promise<void>) | undefined

  try {
    userDataDir = await mkdtemp(join(tmpdir(), 'pagedown-gate-userdata-gate36d-'))

    const first = await launchIsolatedApp(['.'], { userDataDir })
    closeFirst = first.close
    const win1 = await getMainWindow(first.app)
    await win1.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    // Written through the real IPC surface rather than the real timer: this
    // test is about the DISCARD contract, and the write path already has its
    // own end-to-end proof in the test above. Going through window.api still
    // exercises the real contextBridge, the real handler and the real
    // main-minted id.
    const draftId = await win1.evaluate(() =>
      (
        window as unknown as {
          api: { autosaveUnsavedDraft: (id: string | null, c: string) => Promise<string | null> }
        }
      ).api.autosaveUnsavedDraft(null, '# Discard me\n\nThis must not come back.')
    )
    expect(draftId).toMatch(/^[0-9a-f]{32}$/)
    expect(await readDrafts(userDataDir)).toHaveLength(1)

    await win1.evaluate(
      (id) =>
        (
          window as unknown as { api: { discardUnsavedDraft: (i: string) => Promise<void> } }
        ).api.discardUnsavedDraft(id as string),
      draftId
    )

    // Gone from the real filesystem -- not merely absent from a list.
    await expect.poll(async () => (await readDrafts(userDataDir as string)).length).toBe(0)

    await closeFirst()
    closeFirst = undefined

    // And it cannot resurrect on the next launch, which is the failure mode
    // the original bug actually produced.
    const second = await launchIsolatedApp(['.'], { userDataDir })
    closeSecond = second.close
    const win2 = await getMainWindow(second.app)
    await win2.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    await expect(win2.getByRole('button', { name: 'New document' })).toBeVisible({
      timeout: 30_000
    })
    await expect(win2.getByText('Unsaved documents')).toHaveCount(0)
    expect(await readDrafts(userDataDir)).toEqual([])
  } finally {
    if (closeSecond) await closeSecond()
    if (closeFirst) await closeFirst()
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true })
  }
})
