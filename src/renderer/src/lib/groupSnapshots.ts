import type { SnapshotMeta } from '../../../preload/index.d'

export interface SnapshotGroup {
  id: string
  newest: SnapshotMeta
  oldest: SnapshotMeta
  entries: SnapshotMeta[]
}

const DEFAULT_GAP_MINUTES = 10

// Input is newest-last (matching version-history.ts's own storage order);
// output is newest-first groups, each internally newest-first -- the
// natural order for a "most recent first" history list.
export function groupSnapshots(
  snapshots: SnapshotMeta[],
  gapMinutes: number = DEFAULT_GAP_MINUTES
): SnapshotGroup[] {
  if (snapshots.length === 0) return []

  const newestFirst = [...snapshots].reverse()
  const gapMs = gapMinutes * 60 * 1000
  const groups: SnapshotMeta[][] = []

  for (const entry of newestFirst) {
    const currentGroup = groups.at(-1)
    const previousEntry = currentGroup?.at(-1)
    if (
      currentGroup &&
      previousEntry &&
      new Date(previousEntry.timestamp).getTime() - new Date(entry.timestamp).getTime() <= gapMs
    ) {
      currentGroup.push(entry)
    } else {
      groups.push([entry])
    }
  }

  return groups.map((entries) => ({
    id: entries[0].id,
    newest: entries[0],
    oldest: entries.at(-1) as SnapshotMeta,
    entries
  }))
}
