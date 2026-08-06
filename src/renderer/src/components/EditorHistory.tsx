import { useEffect, useState } from 'react'
import { groupSnapshots, type SnapshotGroup } from '../lib/groupSnapshots'
import type { SnapshotMeta } from '../../../preload/index.d'

export interface EditorHistoryProps {
  filePath: string | null
  onRestore: (content: string) => void
}

function formatTimestampLabel(isoTimestamp: string): string {
  const date = new Date(isoTimestamp)
  const dateLabel = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const timeLabel = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${dateLabel}, ${timeLabel}`
}

// Uses SnapshotGroup directly (the named exported type from groupSnapshots.ts)
// rather than `ReturnType<typeof groupSnapshots>[number]` -- needlessly
// indirect when the named type is right there.
function formatGroupLabel(group: SnapshotGroup): string {
  if (group.entries.length === 1) {
    return formatTimestampLabel(group.newest.timestamp)
  }
  const dateLabel = new Date(group.newest.timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })
  const oldestTime = new Date(group.oldest.timestamp).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
  const newestTime = new Date(group.newest.timestamp).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
  return `${dateLabel}, ${oldestTime}–${newestTime} · ${group.entries.length} saves`
}

function EditorHistory({ filePath, onRestore }: EditorHistoryProps): React.JSX.Element {
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([])
  const [loading, setLoading] = useState(true)
  // Which groups (by SnapshotGroup.id, i.e. the group's own newest
  // snapshot's id) currently have their individual entries revealed.
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set())
  const [prevFilePath, setPrevFilePath] = useState(filePath)

  // Reset which groups are expanded, and flag a fresh fetch as loading,
  // whenever the document being shown changes -- compared against the
  // previous render's filePath directly, synchronously during render,
  // rather than inside a useEffect body (which would force an extra,
  // avoidable render pass and trips eslint's own react-hooks/set-state-in-effect
  // rule). This is React's documented "adjust state in response to a prop
  // change" pattern; see PageSetupModal.tsx's own draft-reseeding logic
  // and usePageCount.ts's own prevContent/setPrevContent for the
  // precedent this follows in this codebase.
  if (filePath !== prevFilePath) {
    setPrevFilePath(filePath)
    setExpandedGroupIds(new Set())
    if (filePath) setLoading(true)
  }

  useEffect(() => {
    // No fetch to make for an unsaved document -- and no state to reset
    // either: the render below returns its own "save this document first"
    // branch unconditionally whenever `filePath` is null, before `loading`/
    // `snapshots` are ever consulted, so they're inert in that case.
    if (!filePath) return
    // Both setState calls below run inside the IPC call's own .then()
    // callback (data arriving from an external system), not synchronously
    // in the effect body -- the pattern react-hooks/set-state-in-effect
    // actually endorses. The corresponding setLoading(true) lives in the
    // render-phase adjustment above, not here. Deliberately inlined rather
    // than routed through a shared helper function: eslint's rule flags a
    // *call* to any locally-defined function whose body (even many
    // `await`s deep) eventually calls setState, treating it the same as
    // calling setState directly in the effect body -- so handleRestore's
    // post-restore refresh below duplicates this fetch rather than sharing
    // a `fetchHistory` helper with this effect.
    window.api.getVersionHistory(filePath).then((result) => {
      setSnapshots(result)
      setLoading(false)
    })
  }, [filePath])

  const handleRestore = async (snapshotId: string): Promise<void> => {
    if (!filePath) return
    const content = await window.api.restoreVersionContent(filePath, snapshotId)
    if (content === null) return
    onRestore(content)
    // Restoring flushes and Saves the current document first (see
    // EditorScreen's handleRestoreVersion), and a Save writes a new
    // snapshot -- so the list we just showed the user is immediately
    // stale. Re-fetch once the restore round-trip finishes. The list is
    // otherwise only fetched on mount/filePath change (switching sidebar
    // tabs remounts this component, which covers the common case) --
    // deliberately no live subscription here. This runs from a click
    // handler, not a useEffect body, so setState here isn't subject to
    // (and doesn't need to route around) the effect-body rule above.
    const refreshed = await window.api.getVersionHistory(filePath)
    setSnapshots(refreshed)
  }

  const toggleExpanded = (groupId: string): void => {
    setExpandedGroupIds((current) => {
      const next = new Set(current)
      if (next.has(groupId)) {
        next.delete(groupId)
      } else {
        next.add(groupId)
      }
      return next
    })
  }

  if (!filePath) {
    return (
      <div className="px-3 py-4 text-11 text-text-tertiary">
        Save this document first to start keeping version history.
      </div>
    )
  }

  if (loading) {
    return <div className="px-3 py-4 text-11 text-text-tertiary">Loading history…</div>
  }

  if (snapshots.length === 0) {
    return <div className="px-3 py-4 text-11 text-text-tertiary">No saved versions yet.</div>
  }

  const groups = groupSnapshots(snapshots)

  return (
    <ul className="flex flex-col gap-px overflow-y-auto px-2 py-2">
      {groups.map((group) => {
        const isGroup = group.entries.length > 1
        const isExpanded = expandedGroupIds.has(group.id)

        return (
          <li key={group.id}>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                aria-label={`Restore version from ${formatGroupLabel(group)}`}
                onClick={() => void handleRestore(group.newest.id)}
                className="block flex-1 truncate rounded-sm px-2 py-[7px] text-left text-12-5 text-text-primary hover:bg-chrome-dark"
              >
                {formatGroupLabel(group)}
              </button>
              {isGroup && (
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  aria-label={
                    isExpanded
                      ? `Hide ${group.entries.length} versions in this group`
                      : `Show ${group.entries.length} versions in this group`
                  }
                  onClick={() => toggleExpanded(group.id)}
                  className="shrink-0 rounded-sm px-1.5 py-[7px] text-11 text-text-tertiary hover:bg-chrome-dark"
                >
                  {isExpanded ? '▾' : '▸'}
                </button>
              )}
            </div>
            {isGroup && isExpanded && (
              <ul className="ml-3 flex flex-col gap-px border-l border-border-subtle pl-2">
                {group.entries.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      aria-label={`Restore version from ${formatTimestampLabel(entry.timestamp)}`}
                      onClick={() => void handleRestore(entry.id)}
                      className="block w-full truncate rounded-sm px-2 py-1.5 text-left text-11-5 text-text-secondary hover:bg-chrome-dark"
                    >
                      {formatTimestampLabel(entry.timestamp)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export default EditorHistory
