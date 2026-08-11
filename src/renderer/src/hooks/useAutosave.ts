import { useEffect, useRef } from 'react'
import { useDocumentStore } from '../store/documentStore'

// Kept as the DEFAULT (not removed) even now that Settings can override
// it (see intervalMs below) -- it's still what every test and every caller
// that doesn't have a real preferences value yet (App.tsx's own
// getPreferences() call may not have resolved by the time EditorScreen
// first mounts) falls back to, matching the pre-existing behavior exactly.
const AUTOSAVE_INTERVAL_MS = 45_000

interface UseAutosaveArgs {
  content: string
  filePath: string | null
  isDirty: boolean
  intervalMs?: number
}

/**
 * Fires `window.api.autosaveSnapshot` on a 45s cadence, but ONLY while the
 * document is dirty and has a real (saved-at-least-once) file path -- an
 * unsaved document has nothing to key a snapshot against (see
 * version-history.ts's own path-keyed storage), matching this codebase's
 * established "no local assets / no history for an unsaved document"
 * precedent. Best-effort: `autosaveSnapshot`'s own IPC handler already
 * validates the path and swallows failures (see `src/main/index.ts`), so no
 * error handling is needed here -- a failed tick just means slightly less
 * protection, never a thrown error visible to the editor.
 *
 * The countdown is driven off `isDirty`, not free-running from mount: the
 * effect below restarts every time the document transitions from clean to
 * dirty (see its dependency array), rather than ticking on a fixed schedule
 * set up once at mount and never resynced. This matters because Task 2's
 * recovery-on-open check ignores any snapshot that isn't more than 2 seconds
 * newer than the file's on-disk mtime -- a free-running timer that happened
 * to land within that 2-second window right after a real Save (which also
 * writes a snapshot, see documentStore.ts's `save()`) would produce a
 * snapshot recovery silently ignores, leaving a crash before the NEXT tick
 * with zero protection for whatever was typed in between. Resetting the
 * countdown on every clean->dirty transition rules this out structurally: a
 * Save always clears `isDirty`, so the next countdown only ever starts on
 * the user's next real edit -- a tick can never land inside the post-Save
 * tolerance window. This still ticks repeatedly on a fixed cadence for as
 * long as the document stays continuously dirty (a single `setInterval`
 * handles that; the effect only re-runs on an `isDirty`/`intervalMs`
 * transition, not per-tick). `intervalMs` (Settings, once real) also
 * restarting the countdown does NOT reopen the post-Save race the paragraph
 * above rules out -- that guarantee is specifically about a tick never
 * landing inside a window right after a SAVE, which a user changing their
 * autosave-interval PREFERENCE mid-edit has no relationship to; it is a
 * genuinely separate kind of transition, and applying a changed interval
 * immediately (rather than only at the next clean->dirty transition) is the
 * correct, expected behavior.
 *
 * Known, accepted limitation: `documentStore` is multi-tab, but this hook
 * only ever sees whichever tab is ACTIVE -- `EditorScreen` feeds it the
 * store's top-level `content`/`filePath`/`isDirty` mirror fields, not a
 * per-tab value. A dirty BACKGROUND tab therefore does not autosave until
 * the user switches back to it. This matches the hook's own signature (no
 * per-tab argument) and is out of scope for this task, not an oversight.
 *
 * --- UNSAVED (untitled) DOCUMENTS ---
 *
 * The same tick ALSO drives crash protection for never-saved documents, via
 * `documentStore.snapshotUnsavedDrafts()`. Three things about that half are
 * deliberately different from the path-keyed half above:
 *
 * 1. It does NOT inherit the active-tab-only limitation. That limitation is
 *    survivable for a saved document -- the file on disk still holds the last
 *    saved state -- but for an untitled one the draft is the ONLY copy, so a
 *    background tab inheriting it would leave the exact hole this protection
 *    exists to close, one tab switch away. It was cheap to avoid because the
 *    store action reads `tabs` itself; nothing had to change at the call site
 *    (`EditorScreen`, which this hook cannot see), which is the constraint
 *    that made the saved half's limitation expensive to fix in the first
 *    place.
 * 2. It is therefore gated on `hasUnsavedDraftWork` (read from the store)
 *    rather than on the `isDirty` prop, so the timer runs even when the
 *    ACTIVE tab is clean and only a background untitled tab is dirty.
 * 3. Adding that flag to the effect's dependency array does NOT weaken the
 *    countdown-restart guarantee documented above. That guarantee is
 *    specifically about a tick never landing inside MTIME_TOLERANCE_MS of a
 *    SAVE; `hasUnsavedDraftWork` can only flip when a never-saved document
 *    starts or stops having unsaved work, which by definition involves no
 *    save at all. In the overwhelmingly common case it flips on the very same
 *    keystroke as `isDirty` (a blank tab's first character makes both true at
 *    once), so it adds no extra restarts there either.
 */
export function useAutosave({
  content,
  filePath,
  isDirty,
  intervalMs = AUTOSAVE_INTERVAL_MS
}: UseAutosaveArgs): void {
  // "Is there any never-saved document with real unsaved work in it, in ANY
  // tab" -- read from the store rather than derived from this hook's props,
  // which describe only the active tab. `content !== ''` mirrors
  // documentStore's own isPristineBlankTab predicate: an empty tab has
  // nothing to protect.
  const hasUnsavedDraftWork = useDocumentStore((state) =>
    state.tabs.some((tab) => tab.filePath === null && tab.isDirty && tab.content !== '')
  )

  // Tick-time reads go through this ref rather than the closed-over
  // content/filePath/isDirty, so a stale closure inside a long-lived
  // setInterval never fires a snapshot of outdated content.
  const latestRef = useRef({ content, filePath, isDirty })
  useEffect(() => {
    latestRef.current = { content, filePath, isDirty }
  })

  useEffect(() => {
    if (!isDirty && !hasUnsavedDraftWork) return
    const interval = setInterval(() => {
      const {
        content: currentContent,
        filePath: currentFilePath,
        isDirty: currentIsDirty
      } = latestRef.current
      if (currentIsDirty && currentFilePath) {
        void window.api.autosaveSnapshot(currentContent, currentFilePath)
      }
      // Reads the live store rather than this tick's captured props, and
      // re-filters there, so it is a no-op (zero IPC) whenever there is
      // nothing untitled to protect -- no second guard is needed here.
      void useDocumentStore.getState().snapshotUnsavedDrafts()
    }, intervalMs)
    return () => clearInterval(interval)
  }, [isDirty, hasUnsavedDraftWork, intervalMs])
}
