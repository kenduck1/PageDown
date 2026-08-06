import { useEffect, useRef } from 'react'

const AUTOSAVE_INTERVAL_MS = 45_000

interface UseAutosaveArgs {
  content: string
  filePath: string | null
  isDirty: boolean
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
 * tolerance window. This still ticks repeatedly on a 45s cadence for as long
 * as the document stays continuously dirty (a single `setInterval` handles
 * that; the effect only re-runs on an `isDirty` transition, not per-tick).
 *
 * Known, accepted limitation: `documentStore` is multi-tab, but this hook
 * only ever sees whichever tab is ACTIVE -- `EditorScreen` feeds it the
 * store's top-level `content`/`filePath`/`isDirty` mirror fields, not a
 * per-tab value. A dirty BACKGROUND tab therefore does not autosave until
 * the user switches back to it. This matches the hook's own signature (no
 * per-tab argument) and is out of scope for this task, not an oversight.
 */
export function useAutosave({ content, filePath, isDirty }: UseAutosaveArgs): void {
  // Tick-time reads go through this ref rather than the closed-over
  // content/filePath/isDirty, so a stale closure inside a long-lived
  // setInterval never fires a snapshot of outdated content.
  const latestRef = useRef({ content, filePath, isDirty })
  useEffect(() => {
    latestRef.current = { content, filePath, isDirty }
  })

  useEffect(() => {
    if (!isDirty) return
    const interval = setInterval(() => {
      const {
        content: currentContent,
        filePath: currentFilePath,
        isDirty: currentIsDirty
      } = latestRef.current
      if (currentIsDirty && currentFilePath) {
        void window.api.autosaveSnapshot(currentContent, currentFilePath)
      }
    }, AUTOSAVE_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [isDirty])
}
