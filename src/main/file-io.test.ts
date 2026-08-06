import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as versionHistory from './version-history'
import { writeSnapshot, getLatestSnapshot } from './version-history'

// file-io.ts imports `dialog` (and the `BrowserWindow` type, unused at
// runtime) from 'electron', which doesn't resolve to a real API object
// outside a running Electron process -- mocked here the same way this
// project's other Electron-dependent main-process tests would, per
// task-2-brief.md's controller-resolved decision #1 (recent-files.test.ts's
// real-temp-directory fixture conventions are otherwise followed as closely
// as possible, but that file is Electron-free and has no dialog to mock).
vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    showMessageBox: vi.fn()
  }
}))

import { dialog } from 'electron'
import { openFileDialog, readFileByPath, saveFile, canonicalizeDocumentPath } from './file-io'

// Builds a document reachable through TWO distinct spellings -- a real
// directory and a symlink pointing at it -- inside the given parent. Used by
// the recovery-on-open tests below so their proof that canonicalization
// actually ran doesn't depend on the host OS incidentally having raw !==
// canonical paths under its own tmpdir (true on macOS, where /var -> /private
// /var, but NOT on Linux, where /tmp is a real directory and raw === canonical
// there regardless of whether canonicalizeDocumentPath is even called).
async function createSymlinkedDocFixture(
  parentDir: string,
  name: string
): Promise<{ docViaReal: string; docViaLink: string }> {
  const realDir = join(parentDir, `${name}-real`)
  const linkDir = join(parentDir, `${name}-link`)
  await mkdir(realDir)
  await symlink(realDir, linkDir)
  return { docViaReal: join(realDir, 'doc.md'), docViaLink: join(linkDir, 'doc.md') }
}

describe('readFileByPath / openFileDialog recovery-on-open', () => {
  let userDataDir: string
  let fixtureDir: string

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'pagedown-file-io-userdata-'))
    fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-file-io-docs-'))
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
    await rm(fixtureDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('returns the on-disk content and recoveredFromAutosave: false when no newer autosave exists', async () => {
    const docPath = join(fixtureDir, 'plain.md')
    await writeFile(docPath, '# On disk content')

    const result = await readFileByPath(docPath, userDataDir)

    expect(result).toEqual({
      filePath: docPath,
      content: '# On disk content',
      recoveredFromAutosave: false
    })
  })

  it("returns a newer autosave snapshot's content instead of the on-disk file, with recoveredFromAutosave: true -- proven through a symlinked directory so this can't pass merely because raw === canonical happens to hold on this OS", async () => {
    const { docViaReal, docViaLink } = await createSymlinkedDocFixture(fixtureDir, 'newer-autosave')
    await writeFile(docViaReal, '# Old on-disk content')
    // Force the on-disk mtime to be safely (1 hour) older than the snapshot
    // below via utimes rather than a real-time sleep -- deterministic, and
    // comfortably clears the 2s mtime-granularity tolerance floor so this
    // test isolates "does canonicalization make the snapshot findable at
    // all," not the tolerance/content-equality guards covered separately
    // below.
    const oldMtime = new Date(Date.now() - 60 * 60 * 1000)
    await utimes(docViaReal, oldMtime, oldMtime)
    // Snapshot keyed by the REAL (non-symlinked) canonical spelling; the
    // read below goes through the SYMLINK spelling -- this only passes if
    // readFileByPath actually canonicalizes before its own lookup, matching
    // what the real file:autosaveSnapshot IPC handler does (see
    // canonicalizeDocumentPath).
    await writeSnapshot(
      userDataDir,
      await canonicalizeDocumentPath(docViaReal),
      '# Newer autosaved content'
    )

    const result = await readFileByPath(docViaLink, userDataDir)

    expect(result).toEqual({
      filePath: docViaLink,
      content: '# Newer autosaved content',
      recoveredFromAutosave: true
    })
  })

  it('does not treat a snapshot within the mtime-granularity tolerance window as recovery-worthy (guards against exFAT/FAT32/HFS+ mtime truncation silently reverting a real save)', async () => {
    const docPath = join(fixtureDir, 'tolerance.md')
    await writeFile(docPath, '# On disk content')
    // No artificial delay: the snapshot below is written immediately after
    // the file, so its real timestamp is only a few milliseconds newer than
    // the file's real mtime -- comfortably inside the 2s tolerance floor
    // that absorbs coarse filesystem mtime granularity, and nowhere near
    // "meaningfully newer." This is exactly the truncation scenario: a
    // snapshot genuinely newer by the clock, but not newer enough to be
    // trusted over what a real, just-completed Save wrote to disk.
    await writeSnapshot(
      userDataDir,
      await canonicalizeDocumentPath(docPath),
      '# Different autosaved content'
    )

    const result = await readFileByPath(docPath, userDataDir)

    expect(result).toEqual({
      filePath: docPath,
      content: '# On disk content',
      recoveredFromAutosave: false
    })
  })

  it('does not treat a snapshot as recovery-worthy when its content is byte-identical to what is already on disk, even though its timestamp is clearly (well beyond the tolerance) newer than the mtime', async () => {
    const docPath = join(fixtureDir, 'identical-content.md')
    await writeFile(docPath, '# Same content')
    // 1 hour in the past -- safely beyond the 2s tolerance, so this
    // isolates the content-equality guard from the tolerance check above:
    // isMeaningfullyNewer is unambiguously true here, and only the
    // content-equality check is what should be keeping recovery from
    // firing.
    const oldMtime = new Date(Date.now() - 60 * 60 * 1000)
    await utimes(docPath, oldMtime, oldMtime)
    await writeSnapshot(userDataDir, await canonicalizeDocumentPath(docPath), '# Same content')

    const result = await readFileByPath(docPath, userDataDir)

    expect(result).toEqual({
      filePath: docPath,
      content: '# Same content',
      recoveredFromAutosave: false
    })
  })

  it('ignores an OLDER autosave snapshot and returns the on-disk content', async () => {
    const docPath = join(fixtureDir, 'stale-autosave.md')
    await writeSnapshot(
      userDataDir,
      await canonicalizeDocumentPath(docPath),
      '# Stale autosaved content'
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    await writeFile(docPath, '# Newer on-disk content')

    const result = await readFileByPath(docPath, userDataDir)

    expect(result).toEqual({
      filePath: docPath,
      content: '# Newer on-disk content',
      recoveredFromAutosave: false
    })
  })

  it('falls back to the on-disk content (recoveredFromAutosave: false) when the version-history lookup throws, rather than failing the open', async () => {
    const docPath = join(fixtureDir, 'lookup-throws.md')
    await writeFile(docPath, '# On disk content')
    const spy = vi
      .spyOn(versionHistory, 'getLatestSnapshot')
      .mockRejectedValue(new Error('simulated version-history failure'))
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const result = await readFileByPath(docPath, userDataDir)
      expect(result).toEqual({
        filePath: docPath,
        content: '# On disk content',
        recoveredFromAutosave: false
      })
      expect(consoleErrorSpy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('openFileDialog reads the chosen file through the same recovery-on-open path as readFileByPath, proven through a symlinked directory for the same reason as above', async () => {
    const { docViaReal, docViaLink } = await createSymlinkedDocFixture(fixtureDir, 'via-dialog')
    await writeFile(docViaReal, '# Old on-disk content')
    const oldMtime = new Date(Date.now() - 60 * 60 * 1000)
    await utimes(docViaReal, oldMtime, oldMtime)
    await writeSnapshot(
      userDataDir,
      await canonicalizeDocumentPath(docViaReal),
      '# Newer autosaved content'
    )
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [docViaLink]
    } as Awaited<ReturnType<typeof dialog.showOpenDialog>>)

    const result = await openFileDialog(userDataDir)

    expect(result).toEqual({
      filePath: docViaLink,
      content: '# Newer autosaved content',
      recoveredFromAutosave: true
    })
  })

  it('openFileDialog returns null without touching version history when the dialog is cancelled', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: true,
      filePaths: []
    } as Awaited<ReturnType<typeof dialog.showOpenDialog>>)

    const result = await openFileDialog(userDataDir)

    expect(result).toBeNull()
  })
})

describe('canonicalizeDocumentPath', () => {
  let parentDir: string

  beforeEach(async () => {
    parentDir = await mkdtemp(join(tmpdir(), 'pagedown-file-io-canon-'))
  })

  afterEach(async () => {
    await rm(parentDir, { recursive: true, force: true })
  })

  it('resolves a symlinked directory spelling to the same canonical path as the real directory', async () => {
    const realDir = join(parentDir, 'real')
    const linkPath = join(parentDir, 'link')
    await mkdir(realDir)
    await symlink(realDir, linkPath)
    const docViaReal = join(realDir, 'doc.md')
    const docViaLink = join(linkPath, 'doc.md')
    await writeFile(docViaReal, '# content')

    expect(await canonicalizeDocumentPath(docViaLink)).toBe(
      await canonicalizeDocumentPath(docViaReal)
    )
  })

  it('two spellings of the same file (a symlinked path and its realpath) resolve to the SAME version history, not two split histories', async () => {
    let userDataDir = ''
    try {
      userDataDir = await mkdtemp(join(tmpdir(), 'pagedown-file-io-userdata-canon-'))
      const realDir = join(parentDir, 'real2')
      const linkPath = join(parentDir, 'link2')
      await mkdir(realDir)
      await symlink(realDir, linkPath)
      const docViaLink = join(linkPath, 'doc.md')
      const docViaReal = join(realDir, 'doc.md')
      await writeFile(docViaReal, '# content')

      // A snapshot is written keyed by the canonical form of the SYMLINK
      // spelling...
      const canonicalFromLink = await canonicalizeDocumentPath(docViaLink)
      await writeSnapshot(userDataDir, canonicalFromLink, '# snapshot content')

      // ...and must be visible via a lookup keyed by the canonical form of
      // the REAL spelling -- proving both spellings land in one shared
      // history rather than two silently-split ones.
      const canonicalFromReal = await canonicalizeDocumentPath(docViaReal)
      const latest = await getLatestSnapshot(userDataDir, canonicalFromReal)
      expect(latest?.content).toBe('# snapshot content')
    } finally {
      if (userDataDir) await rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('canonicalizes via the parent directory when the file itself does not exist yet, rather than falling all the way back to the raw path', async () => {
    const doesNotExist = join(parentDir, 'nope.md')
    const expected = join(await realpath(parentDir), 'nope.md')

    expect(await canonicalizeDocumentPath(doesNotExist)).toBe(expected)
  })

  it('canonicalizes a not-yet-created file through its SYMLINKED parent directory (the split-history scenario this fallback exists to close)', async () => {
    const realDir = join(parentDir, 'real3')
    const linkDir = join(parentDir, 'link3')
    await mkdir(realDir)
    await symlink(realDir, linkDir)
    const notYetCreated = join(linkDir, 'not-yet-created.md')

    const canonical = await canonicalizeDocumentPath(notYetCreated)

    expect(canonical).toBe(join(await realpath(realDir), 'not-yet-created.md'))
    // Critically NOT the raw, unresolved symlink spelling -- proving the
    // parent-directory resolution actually ran rather than silently falling
    // straight through to the raw-path last resort.
    expect(canonical).not.toBe(notYetCreated)
  })

  it('falls back to the fully raw path only as a last resort, when even the parent directory cannot be resolved', async () => {
    const nonExistentParent = join(parentDir, 'does-not-exist-dir', 'nope.md')

    expect(await canonicalizeDocumentPath(nonExistentParent)).toBe(nonExistentParent)
  })
})

describe('saveFile (sanity, unaffected by the recovery changes)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes the given content to the given path without prompting a dialog', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-file-io-save-'))
    try {
      const targetPath = join(dir, 'saved.md')
      const result = await saveFile(targetPath, '# Saved content')
      expect(result).toEqual({ filePath: targetPath })
      expect(dialog.showSaveDialog).not.toHaveBeenCalled()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
