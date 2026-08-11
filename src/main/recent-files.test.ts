import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isKnownPath,
  mergeRecentFiles,
  readRecentFiles,
  writeRecentFiles,
  removeRecentFile,
  clearRecentFiles,
  readRecentFilesWithStatus
} from './recent-files'
import { drainConfigWarnings, resetConfigWarningsForTest } from './config-warnings'

describe('mergeRecentFiles', () => {
  it('prepends a new entry', () => {
    const result = mergeRecentFiles([], '/a.md', '2026-01-01T00:00:00.000Z')
    expect(result).toEqual([{ filePath: '/a.md', editedAt: '2026-01-01T00:00:00.000Z' }])
  })

  it('moves a re-opened existing entry to the front with a fresh timestamp instead of duplicating it', () => {
    const existing = [
      { filePath: '/a.md', editedAt: '2026-01-01T00:00:00.000Z' },
      { filePath: '/b.md', editedAt: '2026-01-02T00:00:00.000Z' }
    ]
    const result = mergeRecentFiles(existing, '/a.md', '2026-01-03T00:00:00.000Z')
    expect(result).toEqual([
      { filePath: '/a.md', editedAt: '2026-01-03T00:00:00.000Z' },
      { filePath: '/b.md', editedAt: '2026-01-02T00:00:00.000Z' }
    ])
  })

  it('caps the result at maxEntries, dropping the oldest', () => {
    const existing = Array.from({ length: 10 }, (_, i) => ({
      filePath: `/f${i}.md`,
      editedAt: `2026-01-01T00:00:0${i}.000Z`
    }))
    const result = mergeRecentFiles(existing, '/new.md', '2026-01-02T00:00:00.000Z', 10)
    expect(result).toHaveLength(10)
    expect(result[0].filePath).toBe('/new.md')
    expect(result.some((e) => e.filePath === '/f9.md')).toBe(false)
  })
})

describe('readRecentFiles / writeRecentFiles', () => {
  it('round-trips entries through a real temp directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
    try {
      const entries = [{ filePath: '/a.md', editedAt: '2026-01-01T00:00:00.000Z' }]
      await writeRecentFiles(dir, entries)
      const readBack = await readRecentFiles(dir)
      expect(readBack).toEqual(entries)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns an empty array when no file exists yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
    try {
      expect(await readRecentFiles(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns an empty array rather than throwing on corrupt JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
    try {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(dir, 'recent-files.json'), 'not valid json{{{', 'utf8')
      expect(await readRecentFiles(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('filters out malformed entries from an otherwise-valid JSON array', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
    try {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(
        join(dir, 'recent-files.json'),
        '[{"filePath":"/a.md","editedAt":"2026-01-01T00:00:00.000Z"},{"filePath":123,"editedAt":"x"},null]',
        'utf8'
      )
      expect(await readRecentFiles(dir)).toEqual([
        { filePath: '/a.md', editedAt: '2026-01-01T00:00:00.000Z' }
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('leaves no leftover temp file behind after an atomic write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
    try {
      await writeRecentFiles(dir, [{ filePath: '/a.md', editedAt: '2026-01-01T00:00:00.000Z' }])
      const { readdir } = await import('node:fs/promises')
      expect(await readdir(dir)).toEqual(['recent-files.json'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('isKnownPath', () => {
  it('returns true for a path in the persisted list and false for one that is not', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
    try {
      await writeRecentFiles(dir, [
        { filePath: '/a.md', editedAt: '2026-01-01T00:00:00.000Z' },
        { filePath: '/b.md', editedAt: '2026-01-02T00:00:00.000Z' }
      ])
      expect(await isKnownPath(dir, '/a.md')).toBe(true)
      expect(await isKnownPath(dir, '/b.md')).toBe(true)
      expect(await isKnownPath(dir, '/etc/passwd')).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns false when no recent-files list exists yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
    try {
      expect(await isKnownPath(dir, '/a.md')).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns false for a path that only appears in a malformed entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
    try {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(dir, 'recent-files.json'), '[{"filePath":"/a.md"}]', 'utf8')
      expect(await isKnownPath(dir, '/a.md')).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// Product-completeness audit 0.6: "a dead recents row cannot be removed" --
// removeRecentFile/clearRecentFiles are the fix. Both can only ever NARROW
// the persisted list (isKnownPath's own allowlist) -- see their own comments
// in recent-files.ts.
describe('removeRecentFile', () => {
  it('removes the matching entry and persists the result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
    try {
      await writeRecentFiles(dir, [
        { filePath: '/a.md', editedAt: '2026-01-01T00:00:00.000Z' },
        { filePath: '/b.md', editedAt: '2026-01-02T00:00:00.000Z' }
      ])

      const result = await removeRecentFile(dir, '/a.md')

      expect(result).toEqual([{ filePath: '/b.md', editedAt: '2026-01-02T00:00:00.000Z' }])
      // Persisted, not just returned -- a fresh read must see the same thing.
      expect(await readRecentFiles(dir)).toEqual(result)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('revokes isKnownPath access to the removed path without touching any other entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
    try {
      await writeRecentFiles(dir, [
        { filePath: '/a.md', editedAt: '2026-01-01T00:00:00.000Z' },
        { filePath: '/b.md', editedAt: '2026-01-02T00:00:00.000Z' }
      ])

      await removeRecentFile(dir, '/a.md')

      expect(await isKnownPath(dir, '/a.md')).toBe(false)
      expect(await isKnownPath(dir, '/b.md')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is a no-op (and does not write) when the path is not in the list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
    try {
      await writeRecentFiles(dir, [{ filePath: '/a.md', editedAt: '2026-01-01T00:00:00.000Z' }])

      const result = await removeRecentFile(dir, '/does-not-exist.md')

      expect(result).toEqual([{ filePath: '/a.md', editedAt: '2026-01-01T00:00:00.000Z' }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns an empty array when the list did not exist yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
    try {
      expect(await removeRecentFile(dir, '/a.md')).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('clearRecentFiles', () => {
  it('wipes every entry and revokes isKnownPath access to all of them, with no preservePaths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
    try {
      await writeRecentFiles(dir, [
        { filePath: '/a.md', editedAt: '2026-01-01T00:00:00.000Z' },
        { filePath: '/b.md', editedAt: '2026-01-02T00:00:00.000Z' }
      ])

      await clearRecentFiles(dir)

      expect(await readRecentFiles(dir)).toEqual([])
      expect(await isKnownPath(dir, '/a.md')).toBe(false)
      expect(await isKnownPath(dir, '/b.md')).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Second-pass product-completeness audit: "Clear all recents silently
  // degrades an already-open document." A path in `preservePaths` survives
  // the clear -- isKnownPath stays true for it, and readRecentFiles keeps
  // its entry -- while everything else is still wiped exactly as before.
  describe('preservePaths', () => {
    it('keeps only the entries whose path is in preservePaths, dropping everything else', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
      try {
        await writeRecentFiles(dir, [
          { filePath: '/a.md', editedAt: '2026-01-01T00:00:00.000Z' },
          { filePath: '/b.md', editedAt: '2026-01-02T00:00:00.000Z' },
          { filePath: '/c.md', editedAt: '2026-01-03T00:00:00.000Z' }
        ])

        const result = await clearRecentFiles(dir, ['/b.md'])

        expect(result).toEqual([{ filePath: '/b.md', editedAt: '2026-01-02T00:00:00.000Z' }])
        expect(await readRecentFiles(dir)).toEqual(result)
        expect(await isKnownPath(dir, '/a.md')).toBe(false)
        expect(await isKnownPath(dir, '/b.md')).toBe(true)
        expect(await isKnownPath(dir, '/c.md')).toBe(false)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('cannot ADD a path -- a preservePaths entry with no matching existing entry is silently ignored', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
      try {
        await writeRecentFiles(dir, [{ filePath: '/a.md', editedAt: '2026-01-01T00:00:00.000Z' }])

        const result = await clearRecentFiles(dir, ['/a.md', '/never-opened.md'])

        expect(result).toEqual([{ filePath: '/a.md', editedAt: '2026-01-01T00:00:00.000Z' }])
        expect(await isKnownPath(dir, '/never-opened.md')).toBe(false)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('is a no-op (and does not write) when every entry is preserved', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
      try {
        await writeRecentFiles(dir, [{ filePath: '/a.md', editedAt: '2026-01-01T00:00:00.000Z' }])

        const result = await clearRecentFiles(dir, ['/a.md'])

        expect(result).toEqual([{ filePath: '/a.md', editedAt: '2026-01-01T00:00:00.000Z' }])
        expect(await readRecentFiles(dir)).toEqual(result)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })
})

describe('readRecentFilesWithStatus', () => {
  it('marks an entry whose file is really there as exists: true, and a deleted one as exists: false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
    try {
      const realFile = join(dir, 'real.md')
      await writeFile(realFile, '# Real', 'utf8')
      await writeRecentFiles(dir, [
        { filePath: realFile, editedAt: '2026-01-01T00:00:00.000Z' },
        { filePath: join(dir, 'deleted.md'), editedAt: '2026-01-02T00:00:00.000Z' }
      ])

      const result = await readRecentFilesWithStatus(dir)

      expect(result).toEqual([
        { filePath: realFile, editedAt: '2026-01-01T00:00:00.000Z', exists: true },
        { filePath: join(dir, 'deleted.md'), editedAt: '2026-01-02T00:00:00.000Z', exists: false }
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns an empty array when no recents list exists yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
    try {
      expect(await readRecentFilesWithStatus(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// The corrupt-config notice (src/main/config-warnings.ts). Both branches
// already degraded correctly -- the missing half was TELLING the user, which
// matters here more than for most silent fallbacks: this list IS the
// isKnownPath allowlist, so an emptied one makes previously-openable documents
// start failing with "Requested path is not a known recent file" and nothing
// anywhere explaining why.
describe('readRecentFiles corrupt-file reporting', () => {
  beforeEach(() => {
    resetConfigWarningsForTest()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetConfigWarningsForTest()
  })

  it('records a warning for an unparseable file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
    try {
      await writeFile(join(dir, 'recent-files.json'), '{not json', 'utf8')

      expect(await readRecentFiles(dir)).toEqual([])
      expect(drainConfigWarnings()).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('records a warning when SOME entries are malformed, not only when all are', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
    try {
      await writeFile(
        join(dir, 'recent-files.json'),
        JSON.stringify([{ filePath: '/a.md', editedAt: '2026-01-01T00:00:00.000Z' }, null]),
        'utf8'
      )

      expect(await readRecentFiles(dir)).toHaveLength(1)
      expect(drainConfigWarnings()).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stays SILENT when the file simply does not exist yet', async () => {
    // The normal first-run state. Warning here would greet every fresh install
    // with a notice about a file that was never meant to exist yet.
    const dir = await mkdtemp(join(tmpdir(), 'pagedown-recent-files-'))
    try {
      expect(await readRecentFiles(dir)).toEqual([])
      expect(drainConfigWarnings()).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
