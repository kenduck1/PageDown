import { useEffect, useRef, useState } from 'react'

interface PageCountState {
  pageCount: number | null
  loading: boolean
  error: string | null
}

// The pagination render harness backing `window.api.getPageCount` handles
// exactly ONE in-flight request at a time and silently drops the result of
// any request that isn't the most recently dispatched one (see CLAUDE.md's
// "pagination render harness" note and `src/main/page-count-generator.ts`'s
// own queue, which serializes concurrent callers on the main-process side).
// That queue makes concurrent calls safe, but it does nothing to stop this
// hook from firing a fresh IPC round trip on every single keystroke if it
// naively depended on `content` directly -- each one would queue up and
// eventually resolve correctly, but that's still real, wasted main-process
// work (a full markdownToHtml + Paged.js layout pass) on every keystroke.
// Debouncing here, client-side, is what actually avoids hammering the
// harness in the first place, rather than relying on the queue to merely
// survive being hammered.
const DEFAULT_DEBOUNCE_MS = 500

/**
 * Fetches the real page count for `content` via the dedicated pagination
 * harness (`file:getPageCount` IPC, `src/main/page-count-generator.ts`),
 * debounced so a fast typing burst triggers one round trip after typing
 * settles, not one per keystroke.
 *
 * `filePath` is the document's own on-disk path (`documentStore.filePath`),
 * forwarded so the render context can resolve the document's local image
 * references against its own directory. `null` -- an unsaved document, which
 * has no directory -- is a normal, expected value, not a missing argument:
 * it makes that document deny all local assets, which is the correct
 * behavior. The main-process handler independently validates whatever is
 * passed here against the recent-files allowlist, so this is a hint, never a
 * grant.
 *
 * `allowRemoteImages` mirrors the active tab's own remote-image consent
 * decision (`documentStore.remoteImagesAllowed`, coerced to a plain boolean
 * by the caller since `null` there means "undecided," which this hook
 * treats identically to "blocked"). Included in the effect's own dependency
 * array, so toggling consent triggers a fresh (still debounced) fetch --
 * without it, granting consent would silently show a stale, pre-consent
 * page count until some unrelated content edit happened to invalidate it.
 */
export function usePageCount(
  content: string,
  filePath: string | null = null,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  allowRemoteImages = false
): PageCountState {
  // Same "reset on key change" pattern as `useThumbnail.ts`'s own
  // `prevKey`/`setPrevKey`: adjusting state directly in the render body
  // (rather than via a synchronous setState call inside useEffect, which
  // react-hooks' `set-state-in-effect` rule flags as a cascading-render
  // anti-pattern) is React's own documented way to reset state in response
  // to a prop change. https://react.dev/learn/you-might-not-need-an-effect
  const [prevContent, setPrevContent] = useState(content)
  const [state, setState] = useState<PageCountState>({
    pageCount: null,
    loading: true,
    error: null
  })

  if (prevContent !== content) {
    setPrevContent(content)
    // Deliberately keeps the previous `pageCount` (and clears `error`, not
    // `pageCount`) rather than resetting to `null` -- an editor session
    // re-fetches on essentially every debounce cycle as the user keeps
    // typing, and flashing the status bar back to "Page 1 of —" on every
    // single one (only to re-settle ~500ms+ later) reads far worse than
    // briefly showing the last known-correct count while a fresh one is
    // in flight. `loading: true` still lets a caller show a subtler
    // in-progress affordance if it wants one, without losing the number.
    setState((prev) => ({ pageCount: prev.pageCount, loading: true, error: null }))
  }

  // Monotonically-increasing token identifying the most recently FIRED
  // request. A response only gets applied to state if it's still the most
  // recent one by the time it resolves -- guards against a slow earlier
  // response landing after a newer one and clobbering state with a stale
  // page count for content that's no longer current. (The main-process
  // queue already guarantees requests resolve in the order they were
  // enqueued, so in practice this mostly guards the case where `content`
  // changes again -- and a new debounced call fires -- before an
  // in-flight call has resolved; kept as an explicit, independent check
  // rather than relying solely on that ordering guarantee.)
  const latestRequestRef = useRef(0)

  useEffect(() => {
    const timer = setTimeout(() => {
      const requestId = ++latestRequestRef.current
      window.api
        .getPageCount(content, filePath, allowRemoteImages)
        .then((result) => {
          if (latestRequestRef.current !== requestId) return
          setState({ pageCount: result.pageCount, loading: false, error: null })
        })
        .catch((err: unknown) => {
          if (latestRequestRef.current !== requestId) return
          // KEEPS the last known-good count rather than resetting it to
          // `null`, for the same reason the content-change branch above
          // keeps it -- and for a stronger one. A failed count is not new
          // information about the document's length: the pagination harness
          // timing out (its 10s deadline), or one render throwing, says
          // nothing about how many pages the document had a moment ago. The
          // design doc's own requirement is that this reading "shows the
          // last known-good value with a subtle in-progress indicator --
          // never blank or flickering" (design:189), and nulling here made
          // the status bar drop to a literal em-dash on a transient harness
          // failure that the very next debounce cycle usually recovers from.
          //
          // `null` therefore keeps its ONE meaning: never successfully
          // computed at all (a document whose first count failed still shows
          // the em-dash, correctly -- there is no known-good value to show).
          // It never means "we had a number and lost it."
          setState((prev) => ({
            pageCount: prev.pageCount,
            loading: false,
            error: err instanceof Error ? err.message : String(err)
          }))
        })
    }, debounceMs)

    return () => clearTimeout(timer)
  }, [content, filePath, debounceMs, allowRemoteImages])

  return state
}
