import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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

  // Renamed from "returns null for an unknown id": once id-format validation was
  // added (see the path-traversal test below), 'not-a-real-id' fails
  // SNAPSHOT_ID_PATTERN and returns null via the format-validation early return
  // WITHOUT ever reaching the readFile try/catch below -- so this now covers
  // format rejection, not "unknown but well-formed id". See the next test for
  // that case.
  it('readSnapshotContent returns null for a malformed (non-conforming) id', async () => {
    await writeSnapshot(userDataDir, docPath, 'x')
    expect(await readSnapshotContent(userDataDir, docPath, 'not-a-real-id')).toBeNull()
  })

  it('readSnapshotContent returns null for a well-formed id with no backing file', async () => {
    await writeSnapshot(userDataDir, docPath, 'x')
    // Passes SNAPSHOT_ID_PATTERN (24-char ISO timestamp + '-' + 4 lowercase hex
    // chars, 'dead' being valid hex) but was never written, so this exercises the
    // readFile-fails/catch-returns-null path specifically, not the format guard.
    const wellFormedButUnknown = `${new Date().toISOString()}-dead`
    expect(await readSnapshotContent(userDataDir, docPath, wellFormedButUnknown)).toBeNull()
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

describe('readIndex corruption resilience', () => {
  let userDataDir: string
  const docPath = '/corrupt/doc.md'

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'pagedown-vh-corrupt-'))
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  // A syntactically valid JSON file can still be the wrong shape. The governing
  // rule (per fix-round-1 review) is "a corrupted or unreadable index.json is no
  // history for this document, not an error" -- these write a raw, malformed
  // index.json directly (bypassing writeSnapshot/writeIndex entirely) and assert
  // the public read APIs degrade gracefully instead of throwing.
  async function writeRawIndex(raw: string): Promise<void> {
    const dir = join(userDataDir, 'version-history', hashDocumentPath(docPath))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'index.json'), raw, 'utf8')
  }

  it('treats a JSON object (not an array) index.json as no history', async () => {
    await writeRawIndex('{}')
    expect(await listSnapshots(userDataDir, docPath)).toEqual([])
    expect(await getLatestSnapshot(userDataDir, docPath)).toBeNull()
  })

  it('treats a JSON null index.json as no history', async () => {
    await writeRawIndex('null')
    expect(await listSnapshots(userDataDir, docPath)).toEqual([])
    expect(await getLatestSnapshot(userDataDir, docPath)).toBeNull()
  })

  it('filters out malformed entries from an otherwise-valid array, keeping well-formed ones', async () => {
    const validTimestamp = new Date(2026, 0, 1, 0, 0, 0).toISOString()
    const validId = `${validTimestamp}-abcd`
    await writeRawIndex(
      JSON.stringify([
        null,
        { id: 123, timestamp: 'x', sizeBytes: 'y' },
        { id: validId, timestamp: validTimestamp, sizeBytes: 5 }
      ])
    )
    const snapshots = await listSnapshots(userDataDir, docPath)
    expect(snapshots).toEqual([{ id: validId, timestamp: validTimestamp, sizeBytes: 5 }])
  })
})

describe('per-document write serialization', () => {
  let userDataDir: string
  const docA = '/concurrent/doc-a.md'
  const docB = '/concurrent/doc-b.md'

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'pagedown-vh-concurrency-'))
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  // Regression test for the fix-round-1 Critical finding: writeSnapshot used to
  // be read-index -> compute -> write-index with no lock, so overlapping calls
  // for the SAME document (e.g. the 45s autosave timer racing an explicit Save)
  // could each compute their new index from a stale read, and whichever
  // writeIndex finished last would silently drop the other's entry from
  // index.json -- the snapshot .md file stays on disk but becomes permanently
  // unreachable. Firing several concurrent writeSnapshot calls (distinct
  // content, so none is deduped as a no-op) and asserting every returned id
  // ends up in the index directly exercises the fix.
  it('serializes concurrent writeSnapshot calls for the SAME document so none is lost', async () => {
    const ids = await Promise.all([
      writeSnapshot(userDataDir, docA, 'race content 1'),
      writeSnapshot(userDataDir, docA, 'race content 2'),
      writeSnapshot(userDataDir, docA, 'race content 3'),
      writeSnapshot(userDataDir, docA, 'race content 4'),
      writeSnapshot(userDataDir, docA, 'race content 5')
    ])
    const snapshots = await listSnapshots(userDataDir, docA)
    expect(snapshots).toHaveLength(5)
    const indexedIds = new Set(snapshots.map((entry) => entry.id))
    for (const id of ids) {
      expect(indexedIds.has(id)).toBe(true)
    }
  })

  // The serialization queue is keyed PER DOCUMENT (hashDocumentPath), not a
  // single shared queue -- an autosave for one document must not queue behind
  // an unrelated document's write. This is a structural property, not just a
  // final-state one: a (buggy) single global queue would still produce correct
  // final state for both documents, just slower, so this test discriminates on
  // completion ORDER rather than outcome alone. docA gets 30 sequential writes
  // enqueued first; docB's single write is enqueued after all 30. Under a global
  // queue, docB's call is necessarily queued behind all 30 of docA's and can only
  // ever resolve LAST. Under the correct per-document queue, docB has no
  // dependency on docA's backlog and resolves promptly -- it should never be the
  // very last of the 31 completions.
  it('does NOT serialize writeSnapshot calls for DIFFERENT documents against each other', async () => {
    const completions: string[] = []

    const docAWrites = Array.from({ length: 30 }, (_, i) =>
      writeSnapshot(userDataDir, docA, `doc A content ${i}`).then((id) => {
        completions.push('A')
        return id
      })
    )
    const docBWrite = writeSnapshot(userDataDir, docB, 'doc B content').then((id) => {
      completions.push('B')
      return id
    })

    await Promise.all([...docAWrites, docBWrite])

    expect(completions).toContain('B')
    expect(completions.indexOf('B')).toBeLessThan(completions.length - 1)

    const aSnapshots = await listSnapshots(userDataDir, docA)
    const bSnapshots = await listSnapshots(userDataDir, docB)
    expect(aSnapshots).toHaveLength(30)
    expect(bSnapshots).toHaveLength(1)
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
