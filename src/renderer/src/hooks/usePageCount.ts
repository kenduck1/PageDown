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
 */
export function usePageCount(content: string, debounceMs = DEFAULT_DEBOUNCE_MS): PageCountState {
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
        .getPageCount(content)
        .then((result) => {
          if (latestRequestRef.current !== requestId) return
          setState({ pageCount: result.pageCount, loading: false, error: null })
        })
        .catch((err: unknown) => {
          if (latestRequestRef.current !== requestId) return
          setState({
            pageCount: null,
            loading: false,
            error: err instanceof Error ? err.message : String(err)
          })
        })
    }, debounceMs)

    return () => clearTimeout(timer)
  }, [content, debounceMs])

  return state
}
