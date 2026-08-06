import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
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

  it("returns a newer autosave snapshot's content instead of the on-disk file, with recoveredFromAutosave: true", async () => {
    const docPath = join(fixtureDir, 'with-autosave.md')
    await writeFile(docPath, '# Old on-disk content')
    await new Promise((resolve) => setTimeout(resolve, 10))
    // Snapshot writes must key by the CANONICAL path, matching what the real
    // file:autosaveSnapshot IPC handler does (see canonicalizeDocumentPath) --
    // otherwise this fixture and readFileByPath's own internal canonicalizing
    // lookup would silently key two different history entries for the same
    // file (exactly the bug decision #3 in task-2-brief.md guards against),
    // and this test would false-negative on any OS where fixtureDir's own
    // path isn't already in fully-resolved form (e.g. macOS's /var ->
    // /private/var symlink).
    await writeSnapshot(
      userDataDir,
      await canonicalizeDocumentPath(docPath),
      '# Newer autosaved content'
    )

    const result = await readFileByPath(docPath, userDataDir)

    expect(result).toEqual({
      filePath: docPath,
      content: '# Newer autosaved content',
      recoveredFromAutosave: true
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

  it('openFileDialog reads the chosen file through the same recovery-on-open path as readFileByPath', async () => {
    const docPath = join(fixtureDir, 'via-dialog.md')
    await writeFile(docPath, '# Old on-disk content')
    await new Promise((resolve) => setTimeout(resolve, 10))
    await writeSnapshot(
      userDataDir,
      await canonicalizeDocumentPath(docPath),
      '# Newer autosaved content'
    )
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [docPath]
    } as Awaited<ReturnType<typeof dialog.showOpenDialog>>)

    const result = await openFileDialog(userDataDir)

    expect(result).toEqual({
      filePath: docPath,
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

  it('falls back to the raw path when realpath throws (e.g. a not-yet-created file)', async () => {
    const doesNotExist = join(parentDir, 'nope.md')
    expect(await canonicalizeDocumentPath(doesNotExist)).toBe(doesNotExist)
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
