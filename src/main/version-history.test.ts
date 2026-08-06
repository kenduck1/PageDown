import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hashDocumentPath,
  writeSnapshot,
  getLatestSnapshot,
  listSnapshots,
  readSnapshotContent,
  clearPendingAutosave,
  computeSnapshotsToPrune,
  type SnapshotMeta
} from './version-history'

describe('hashDocumentPath', () => {
  it('returns a 16-character hex string', () => {
    const hash = hashDocumentPath('/Users/someone/notes/report.md')
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is deterministic for the same path', () => {
    expect(hashDocumentPath('/a/b.md')).toBe(hashDocumentPath('/a/b.md'))
  })

  it('differs for different paths', () => {
    expect(hashDocumentPath('/a/b.md')).not.toBe(hashDocumentPath('/a/c.md'))
  })
})

describe('writeSnapshot / getLatestSnapshot / listSnapshots', () => {
  let userDataDir: string
  const docPath = '/Users/someone/notes/report.md'

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'pagedown-vh-test-'))
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('returns null/[] for a document with no history yet', async () => {
    expect(await getLatestSnapshot(userDataDir, docPath)).toBeNull()
    expect(await listSnapshots(userDataDir, docPath)).toEqual([])
  })

  it('writes a snapshot and reads it back as the latest', async () => {
    const id = await writeSnapshot(userDataDir, docPath, '# Hello')
    const latest = await getLatestSnapshot(userDataDir, docPath)
    expect(latest).not.toBeNull()
    expect(latest?.id).toBe(id)
    expect(latest?.content).toBe('# Hello')
    expect(latest?.sizeBytes).toBe(Buffer.byteLength('# Hello'))
  })

  it('lists multiple snapshots newest-last', async () => {
    await writeSnapshot(userDataDir, docPath, 'first')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await writeSnapshot(userDataDir, docPath, 'second')

    const snapshots = await listSnapshots(userDataDir, docPath)
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0].id < snapshots[1].id).toBe(true)
  })

  it('is a no-op (does not create a new snapshot) when content is byte-identical to the current latest', async () => {
    const firstId = await writeSnapshot(userDataDir, docPath, 'same content')
    const secondId = await writeSnapshot(userDataDir, docPath, 'same content')
    expect(secondId).toBe(firstId)
    expect(await listSnapshots(userDataDir, docPath)).toHaveLength(1)
  })

  it('keeps different documents (different canonical paths) fully separate', async () => {
    await writeSnapshot(userDataDir, docPath, 'doc A content')
    await writeSnapshot(userDataDir, '/Users/someone/other/doc-b.md', 'doc B content')

    expect(await listSnapshots(userDataDir, docPath)).toHaveLength(1)
    expect((await getLatestSnapshot(userDataDir, docPath))?.content).toBe('doc A content')
  })

  it('readSnapshotContent returns null for an unknown id', async () => {
    await writeSnapshot(userDataDir, docPath, 'x')
    expect(await readSnapshotContent(userDataDir, docPath, 'not-a-real-id')).toBeNull()
  })

  it('readSnapshotContent returns the exact content for a real id', async () => {
    const id = await writeSnapshot(userDataDir, docPath, 'exact content here')
    expect(await readSnapshotContent(userDataDir, docPath, id)).toBe('exact content here')
  })

  // Controller-resolved decision (see task-1-brief pre-flight review): writeSnapshot
  // must derive the id and the index's `timestamp` field from a single `new Date()`
  // call, since the interface contract says the id encodes the SAME timestamp value.
  // Calling `new Date()` twice (once inside id generation, once for meta.timestamp)
  // can straddle a millisecond boundary and silently violate that contract.
  it('derives id and timestamp from the same instant, so id starts with timestamp', async () => {
    const id = await writeSnapshot(userDataDir, docPath, 'consistent timestamp check')
    const latest = await getLatestSnapshot(userDataDir, docPath)
    expect(latest).not.toBeNull()
    if (latest) {
      expect(latest.id.startsWith(latest.timestamp)).toBe(true)
      expect(latest.id).toBe(id)
    }
  })

  // Controller-resolved decision (security): a later task exposes readSnapshotContent
  // to the renderer as restoreVersionContent(filePath, snapshotId), so `id` must be
  // treated as untrusted input. An id shaped like a path-traversal sequence must be
  // rejected BEFORE any path is built from it, not merely fail to resolve to a real
  // file. This test plants a real file one level above the snapshots directory (a
  // location a naive `../`-based join could reach) and asserts a traversal-shaped id
  // never returns its contents.
  it('rejects a path-traversal-shaped id and does not escape the snapshots directory', async () => {
    await writeSnapshot(userDataDir, docPath, 'safe content')

    const documentDirPath = join(userDataDir, 'version-history', hashDocumentPath(docPath))
    const secretPath = join(documentDirPath, 'secret.md')
    await writeFile(secretPath, 'do not leak me', 'utf8')

    expect(await readSnapshotContent(userDataDir, docPath, '../secret')).toBeNull()
    expect(await readSnapshotContent(userDataDir, docPath, '../../../../etc/passwd')).toBeNull()
    expect(await readSnapshotContent(userDataDir, docPath, '..%2F..%2Fsecret')).toBeNull()
  })
})

describe('clearPendingAutosave', () => {
  let userDataDir: string
  const docPath = '/a/doc.md'

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'pagedown-vh-clear-test-'))
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('deletes every snapshot newer than sinceIso, keeps older ones', async () => {
    const oldId = await writeSnapshot(userDataDir, docPath, 'old, keep me')
    const cutoff = new Date().toISOString()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await writeSnapshot(userDataDir, docPath, 'new, discard me')

    await clearPendingAutosave(userDataDir, docPath, cutoff)

    const remaining = await listSnapshots(userDataDir, docPath)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe(oldId)
    expect(await readSnapshotContent(userDataDir, docPath, oldId)).toBe('old, keep me')
  })

  it('is a no-op when there is nothing newer than sinceIso', async () => {
    await writeSnapshot(userDataDir, docPath, 'only one')
    const futureIso = new Date(Date.now() + 60_000).toISOString()
    await clearPendingAutosave(userDataDir, docPath, futureIso)
    expect(await listSnapshots(userDataDir, docPath)).toHaveLength(1)
  })
})

describe('computeSnapshotsToPrune', () => {
  function meta(id: string, isoTimestamp: string): SnapshotMeta {
    return { id, timestamp: isoTimestamp, sizeBytes: 10 }
  }

  it('keeps everything within the last 30 days untouched', () => {
    // Verified timezone-independent: `now` and every fixture below are within a
    // few days of each other, far from the 30-day cutoff, so no local-timezone
    // shift (at most +/-14h) can move any entry across the cutoff boundary.
    const now = new Date('2026-08-05T12:00:00.000Z')
    const snapshots = [
      meta('a', '2026-08-01T00:00:00.000Z'),
      meta('b', '2026-08-01T00:05:00.000Z'),
      meta('c', '2026-08-04T23:59:00.000Z')
    ]
    expect(computeSnapshotsToPrune(snapshots, now)).toEqual([])
  })

  // Controller-resolved decision (timezone bug fix): the brief's original fixture used
  // UTC ISO literals '2026-08-01T01:00:00.000Z' and '2026-08-01T20:00:00.000Z' and
  // asserted they fall on the SAME local calendar day. They are 19 hours apart, so in
  // any timezone west of UTC+5 (e.g. America/Los_Angeles, UTC-7/-8) they land on
  // different local calendar days (Jul 31 vs Aug 1), making the original assertion
  // fail. Building each fixture timestamp from LOCAL date components via
  // `new Date(year, monthIndex, day, hour, ...)` instead of parsing a UTC literal
  // guarantees "same local day" / "different local day" by construction, in any
  // timezone the test happens to run in.
  it('thins snapshots older than 30 days to one per calendar day (local time), keeping the LATEST of each day', () => {
    const now = new Date(2026, 8, 15, 12, 0, 0) // Sept 15, 2026, local time
    const snapshots = [
      meta('day1-early', new Date(2026, 7, 1, 1, 0, 0).toISOString()), // Aug 1, local
      meta('day1-late', new Date(2026, 7, 1, 20, 0, 0).toISOString()), // Aug 1, local
      meta('day2-only', new Date(2026, 7, 2, 10, 0, 0).toISOString()) // Aug 2, local
    ]
    const toPrune = computeSnapshotsToPrune(snapshots, now)
    expect(toPrune).toEqual(['day1-early'])
  })

  it('never prunes the single latest snapshot overall, even if it is very old', () => {
    // Verified timezone-independent: with only one snapshot it is always both the
    // oldest and the most-recent entry, so the "never prune the most recent" rule
    // excludes it regardless of any local-time day-boundary computation.
    const now = new Date('2026-09-15T12:00:00.000Z')
    const snapshots = [meta('only-one', '2026-01-01T00:00:00.000Z')]
    expect(computeSnapshotsToPrune(snapshots, now)).toEqual([])
  })
})
