import { describe, it, expect } from 'vitest'
import { groupSnapshots } from './groupSnapshots'
import type { SnapshotMeta } from '../../../preload/index.d'

function meta(id: string, isoTimestamp: string): SnapshotMeta {
  return { id, timestamp: isoTimestamp, sizeBytes: 10 }
}

describe('groupSnapshots', () => {
  it('returns [] for no snapshots', () => {
    expect(groupSnapshots([])).toEqual([])
  })

  it('puts a single snapshot in its own group', () => {
    const snapshots = [meta('a', '2026-08-05T12:00:00.000Z')]
    const groups = groupSnapshots(snapshots)
    expect(groups).toHaveLength(1)
    expect(groups[0].entries).toEqual(snapshots)
  })

  it('groups snapshots within 10 minutes of their neighbor into one group', () => {
    const snapshots = [
      meta('a', '2026-08-05T12:00:00.000Z'),
      meta('b', '2026-08-05T12:05:00.000Z'),
      meta('c', '2026-08-05T12:09:00.000Z')
    ]
    const groups = groupSnapshots(snapshots)
    expect(groups).toHaveLength(1)
    expect(groups[0].entries.map((entry) => entry.id)).toEqual(['c', 'b', 'a'])
    expect(groups[0].newest.id).toBe('c')
    expect(groups[0].oldest.id).toBe('a')
  })

  it('splits into separate groups when the gap exceeds 10 minutes', () => {
    const snapshots = [
      meta('a', '2026-08-05T12:00:00.000Z'),
      meta('b', '2026-08-05T12:05:00.000Z'),
      meta('c', '2026-08-05T13:00:00.000Z')
    ]
    const groups = groupSnapshots(snapshots)
    expect(groups).toHaveLength(2)
    expect(groups[0].entries.map((entry) => entry.id)).toEqual(['c'])
    expect(groups[1].entries.map((entry) => entry.id)).toEqual(['b', 'a'])
  })

  it('returns groups newest-first', () => {
    const snapshots = [
      meta('old', '2026-08-01T00:00:00.000Z'),
      meta('new', '2026-08-05T00:00:00.000Z')
    ]
    const groups = groupSnapshots(snapshots)
    expect(groups.map((group) => group.newest.id)).toEqual(['new', 'old'])
  })

  it('accepts a custom gap threshold', () => {
    const snapshots = [meta('a', '2026-08-05T12:00:00.000Z'), meta('b', '2026-08-05T12:03:00.000Z')]
    expect(groupSnapshots(snapshots, 2)).toHaveLength(2)
    expect(groupSnapshots(snapshots, 5)).toHaveLength(1)
  })
})
