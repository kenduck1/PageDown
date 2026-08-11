import { useEffect, useRef, useState } from 'react'
import type { DocumentWarning } from '../../../markdown/document-warnings'

interface PageCountState {
  pageCount: number | null
  loading: boolean
  error: string | null
  // Non-blocking, informational notices about the document's own Markdown
  // source (2026-08-09 design-doc gap audit's A5) -- malformed frontmatter,
  // an inline pagebreak marker, an alternate pagebreak syntax kept as
  // written. Rides the SAME debounced getPageCount round trip the page
  // count itself already makes; see page-count-generator.ts's own comment
  // for why this is the one channel both warning producers piggyback on.
  // Follows the exact same "keep the last known value, don't flash back to
  // empty" treatment as `pageCount` below on every branch (a fresh content
  // change, a rejected fetch) -- for an identical reason: a warning banner
  // popping in and out on every debounce tick while a fetch is merely in
  // flight would be its own, self-inflicted noise.
  warnings: DocumentWarning[]
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
    error: null,
    warnings: []
  })

  if (prevContent !== content) {
    setPrevContent(content)
    // Deliberately keeps the previous `pageCount` AND `warnings` (and clears
    // `error`, not either of them) rather than resetting to `null`/`[]` -- an
    // editor session re-fetches on essentially every debounce cycle as the
    // user keeps typing, and flashing the status bar back to "Page 1 of —"
    // (or a warning banner flickering off) on every single one (only to
    // re-settle ~500ms+ later) reads far worse than briefly showing the last
    // known-correct state while a fresh one is in flight. `loading: true`
    // still lets a caller show a subtler in-progress affordance if it wants
    // one, without losing either value.
    setState((prev) => ({
      pageCount: prev.pageCount,
      loading: true,
      error: null,
      warnings: prev.warnings
    }))
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
          // `result.warnings ?? []` guards against an older/mocked
          // `window.api.getPageCount` that doesn't return the field at all
          // (this codebase's test suite has plenty of `{ pageCount: N }`-only
          // fixtures predating this feature) -- never trust a wire value's
          // declared type alone for something this cheap to also check at
          // runtime.
          setState({
            pageCount: result.pageCount,
            loading: false,
            error: null,
            warnings: result.warnings ?? []
          })
        })
        .catch((err: unknown) => {
          if (latestRequestRef.current !== requestId) return
          // KEEPS the last known-good count AND warnings rather than
          // resetting either, for the same reason the content-change branch
          // above keeps them -- and for a stronger one. A failed fetch is not
          // new information about the document's length or its warnings: the
          // pagination harness timing out (its 10s deadline), or one render
          // throwing, says nothing about either. The design doc's own
          // requirement is that the page-count reading "shows the last
          // known-good value with a subtle in-progress indicator -- never
          // blank or flickering" (design:189); the same reasoning applies to
          // warnings, which this hook now carries on the identical channel.
          //
          // `pageCount: null` therefore keeps its ONE meaning: never
          // successfully computed at all (a document whose first count
          // failed still shows the em-dash, correctly -- there is no
          // known-good value to show). It never means "we had a number and
          // lost it."
          setState((prev) => ({
            pageCount: prev.pageCount,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
            warnings: prev.warnings
          }))
        })
    }, debounceMs)

    return () => clearTimeout(timer)
  }, [content, filePath, debounceMs, allowRemoteImages])

  return state
}
