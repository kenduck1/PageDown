import { useEffect, useRef, useState } from 'react'
import { groupSnapshots, type SnapshotGroup } from '../lib/groupSnapshots'
import type { SnapshotMeta } from '../../../preload/index.d'

export interface EditorHistoryProps {
  filePath: string | null
  // Widened to `void | Promise<void>` so an async caller can signal when
  // the restore has actually finished landing -- EditorScreen's
  // handleRestoreVersion has a real async gap (it may flush + Save first),
  // and handleRestore below awaits this before refetching, so the
  // refreshed list reflects the restore's own resulting state rather than
  // racing ahead of it. A synchronous caller can still just return
  // undefined.
  onRestore: (content: string) => void | Promise<void>
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

  // Guards every getVersionHistory response (both the mount/filePath-change
  // fetch below and handleRestore's own post-restore refetch) against
  // resolving out of order and overwriting a newer, correct response with a
  // stale one -- same token-check pattern as usePageCount.ts's own
  // latestRequestRef ("a response only gets applied to state if it's still
  // the most recent one by the time it resolves"). EditorHistory is NOT
  // remounted on a document-tab switch (only MilkdownEditor is, via
  // key={revision}) -- it just receives a new `filePath` prop -- so a slow
  // fetch for the PREVIOUS document resolving after the user has switched
  // to a new one would otherwise silently overwrite the new document's
  // correctly-fetched list.
  const latestRequestRef = useRef(0)
  // A SECOND, independent axis of staleness, not redundant with the
  // counter above: latestRequestRef only tracks DISPATCH ORDER, not WHICH
  // DOCUMENT a request was for. handleRestore's own refetch closes over
  // `filePath` from the render that created the clicked button, then does
  // TWO further awaits (restoreVersionContent, then the caller's own
  // onRestore -- EditorScreen's real flush+Save gap) before it dispatches
  // that refetch. If the user switches tabs during that gap -- now an
  // explicitly SAFE, supported action per replaceContentForTab's own fix
  // in documentStore.ts -- this component re-renders with a new `filePath`
  // prop, its effect correctly fetches and displays the NEW document's
  // list, and then handleRestore's delayed refetch finally fires for the
  // OLD (now-wrong) document, dispatched LAST. latestRequestRef alone
  // would wave that stale-document response through, since "dispatched
  // last" is exactly what it checks -- it has no way to know the response
  // is for a document that isn't being displayed anymore. currentFilePathRef
  // tracks the CURRENT prop, so a response can be checked against "is this
  // even still the right document" independently of "is this the most
  // recently dispatched request for whatever document it's for."
  const currentFilePathRef = useRef(filePath)

  useEffect(() => {
    // Updated here, inside the effect, rather than as a plain mutation in
    // the render body -- eslint's react-hooks/refs rule flags mutating a
    // ref during render (React docs: refs are for use outside of render).
    // This still runs correctly ordered: this effect fires synchronously
    // as part of React's render+commit+effects cycle for the update that
    // changed `filePath`, which fully completes (ref included) before any
    // previously-dispatched promise's `.then()` callback gets a chance to
    // run (those are queued microtasks that can't preempt synchronous JS,
    // including this cycle) -- so by the time any stale response resolves,
    // this ref is guaranteed to already reflect the current prop.
    currentFilePathRef.current = filePath
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
    const requestId = ++latestRequestRef.current
    window.api.getVersionHistory(filePath).then((result) => {
      if (latestRequestRef.current !== requestId) return
      if (filePath !== currentFilePathRef.current) return
      setSnapshots(result)
      setLoading(false)
    })
  }, [filePath])

  const handleRestore = async (snapshotId: string): Promise<void> => {
    if (!filePath) return
    const content = await window.api.restoreVersionContent(filePath, snapshotId)
    if (content === null) return
    // Await the caller's own restore completion (EditorScreen's
    // handleRestoreVersion may flush + Save first -- a real async gap)
    // before refetching below. Without this, the refetch typically
    // resolves before that Save even starts, returning the same stale
    // list and defeating the whole point of refreshing.
    //
    // Residual, accepted gap: even awaiting the restore fully doesn't
    // guarantee the freshly-written snapshot is in the list this refetch
    // returns. documentStore.save()'s own version-history snapshot write
    // (`void window.api.autosaveSnapshot(...)`) is deliberately
    // fire-and-forget -- fired without `await`, after the real save has
    // already succeeded and the store has already been updated, NOT after
    // save()'s own returned promise resolves (it's the last statement
    // inside that same async function, so save()'s promise resolves
    // essentially right alongside this call firing, not afterward) --
    // specifically so a slow/failed snapshot write can never block or
    // delay a real Save (see documentStore.ts's own comment on that call)
    // -- that invariant is intentionally NOT weakened here just to make
    // this refresh airtight. In rare timing, this refetch can still beat
    // that snapshot write to disk. Not fixed: switching sidebar tabs
    // (which remounts this component) or reopening History a moment later
    // both self-correct.
    await onRestore(content)
    // Restoring flushes and Saves the current document first (see
    // EditorScreen's handleRestoreVersion), and a Save writes a new
    // snapshot -- so the list we just showed the user is immediately
    // stale. Re-fetch once the restore round-trip finishes. The list is
    // otherwise only fetched on mount/filePath change (switching sidebar
    // tabs remounts this component, which covers the common case) --
    // deliberately no live subscription here. This runs from a click
    // handler, not a useEffect body, so setState here isn't subject to
    // (and doesn't need to route around) the effect-body rule above.
    const requestId = ++latestRequestRef.current
    const refreshed = await window.api.getVersionHistory(filePath)
    if (latestRequestRef.current !== requestId) return
    // `filePath` here is THIS closure's value -- captured from whichever
    // render created the specific handleRestore instance the clicked
    // button was bound to, frozen for this function's entire lifetime.
    // If the user switched documents during either await above (both
    // restoreVersionContent and onRestore are real async gaps), this
    // component has since re-rendered with a DIFFERENT filePath prop, its
    // own effect has already fetched and displayed that document's
    // correct list, and this refetch -- for the OLD document, dispatched
    // LAST -- would otherwise pass the latestRequestRef check above (it
    // genuinely is the most recently dispatched request) and silently
    // clobber the correctly-displayed list with the wrong document's
    // history. Bail if the document has moved on.
    if (filePath !== currentFilePathRef.current) return
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
