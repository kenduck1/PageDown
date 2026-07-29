import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isKnownPath, mergeRecentFiles, readRecentFiles, writeRecentFiles } from './recent-files'

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
