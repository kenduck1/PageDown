import { useEffect, useRef, type RefObject } from 'react'
import { estimatePageFromScrollOffset } from '../../../pagination/page-nav'

// Split-mode "Follow" (design recon: docs/superpowers/plans/
// 2026-08-09-design-doc-gap-audit.md's "Follow, not Sync" section).
// Scrolling the editor pane in Split mode estimates a page from that scroll
// offset (estimatePageFromScrollOffset, src/pagination/page-nav.ts) and
// feeds it into the SAME page-navigation path EditorScreen's status-bar
// chevrons already use (`onNavigate`, i.e. handleNavigateToPage) -- zero new
// IPC, per the recon's own explicit instruction. This hook's only job is
// deciding WHEN to call that existing path from a periodic scroll sample.
//
// One-directional by construction, not by an explicit guard: this hook only
// ever READS `scrollElementRef.current.scrollTop` and calls `onNavigate`. It
// never writes to the editor's own scroll position, so there is no code
// path here through which the PREVIEW could ever drive the EDITOR's scroll
// -- the loop-breaking this module is actually responsible for is described
// below, and is about not fighting the STATUS BAR / preview's own existing
// feedback loop, not about a reverse scroll direction that was never wired
// up in the first place.

// Matches (does not undercut) SplitPreview's own 500ms render-send debounce
// -- see that component's own DEBOUNCE_MS. Read CLAUDE.md's Split-mode "ONE
// in-flight request at a time" note and SplitPreview.tsx's pollInFlightRef
// comment before changing this: an unguarded periodic caller competing with
// the render debounce and the 400ms status-bar poll on the exact same
// serialized harness queue (enqueueSplitPreviewWork) is precisely what
// caused real Gate 16/18 hangs previously. This constant governs how often
// this hook is even WILLING to compute a fresh estimate; the in-flight guard
// below (mirroring pollInFlightRef) is what stops it from queueing a second
// request on top of one that hasn't settled yet even at this rate.
const FOLLOW_INTERVAL_MS = 500

// Bounds how long a single Follow-triggered request is treated as
// "in flight" before this guard self-clears.
//
// There is no reliable, always-fires completion signal to hook into from
// here: `SplitPreview`'s own `targetPage` effect calls `onPageChange` only
// on a SUCCESSFUL, non-sentinel `scrollSplitPreviewToPage` resolution --
// never on the promise's `.catch()` path, and never for the
// `{currentPage:1,pageCount:0}` "no harness yet" sentinel either (see that
// component's own targetPage effect). Threading a dedicated
// always-fires-on-settle callback through SplitPreview was considered and
// rejected: it would mean tracking "was this specific onPageChange call
// caused by MY request" across two components for a guard that only needs
// to be conservative, not exact -- see the in-flight ref's own comment below
// for why a same-queue confirmation from ANY source is an adequate proxy in
// the success case. This timeout is the fallback for the cases that proxy
// can't cover (a failed or sentinel-returning request with no subsequent
// harness activity), sized comfortably above the disclosed worst-case
// Split-mode render cost (CLAUDE.md: "~2.5s for 300" pages) since a scroll
// request queued behind a slow render shares that exact same serialized
// queue and must be able to wait behind one without this guard expiring
// mid-render and letting a second request pile on top.
const IN_FLIGHT_TIMEOUT_MS = 3000

interface UseSplitFollowScrollOptions {
  /**
   * Master enable. EditorScreen computes this as `splitFollowEnabled &&
   * viewMode === 'split' && splitLeftMode === 'format'` -- the toggle AND
   * both structural preconditions. The `splitLeftMode === 'format'` half is
   * not optional: `contentHeightPx` is the Milkdown page card's own content
   * box height (Gate 10's 0.000px parity target), which has no relationship
   * to a plain `<textarea>`'s scroll position in Source mode's left pane --
   * applying this arithmetic there would be pure noise dressed up as a
   * position estimate, worse than not building it. In practice this is also
   * self-enforcing: Source mode's textarea absorbs its own overflow
   * internally (it has no `overflow-auto` of its own to spill past, and a
   * `scroll` event on a descendant does not bubble to this hook's own
   * interval sampling of the outer pane regardless), so `scrollElementRef`
   * genuinely never moves there -- but `enabled` is still checked explicitly
   * rather than relying on that as the only guard, since a silent no-op is a
   * worse failure mode to discover later than an explicit, documented one.
   */
  enabled: boolean
  /** EditorScreen's `editorPaneRef` -- the Split-mode left pane's own scroll container. */
  scrollElementRef: RefObject<HTMLDivElement | null>
  /** This document's own per-page content height (computePageGeometry's own `contentHeightPx`). */
  contentHeightPx: number
  /**
   * The CSS `zoom` currently applied to the page card INSIDE `scrollElementRef`
   * (EditorScreen's Split fit-to-width scale, `computeFitScale`). 1 when
   * nothing is scaled.
   *
   * LOAD-BEARING, and it invalidates this hook's original premise rather than
   * merely refining it. `contentHeightPx` is a DOCUMENT-space length (the
   * paginated page's own content box, the same number every other rendering
   * surface uses), but `scrollElementRef.current.scrollTop` is measured in the
   * SCROLL CONTAINER's space -- and standardized CSS `zoom` participates in
   * layout, so the container's `scrollHeight`/`scrollTop` are the document's
   * own lengths already multiplied by the scale. Measured directly rather than
   * assumed: at `zoom: 0.9` the same document's pane reported `scrollHeight`
   * 956 against 1062 unscaled (1062 x 0.9 = 955.8), and setting
   * `scrollTop = 200` moved the page card's own client rect by exactly 200
   * viewport px, i.e. 200 / 0.9 = 222.2 DOCUMENT px.
   *
   * So the two quantities live in different coordinate spaces the moment the
   * scale is not 1, and dividing `scrollTop` by it is what puts them back in
   * the same one. Skipping the division does not fail loudly -- it silently
   * under-reports the page (at 0.7, page 4 of a document reads as page 3), so
   * Follow lands the preview on the wrong page in exactly the mode
   * fit-to-width exists for. This hook's own original comment reasoned it was
   * safe to divide nothing "because Split's left pane is deliberately
   * un-zoomed"; that premise is simply no longer true.
   *
   * NOTE the direction, because this codebase has two documented traps in the
   * opposite direction and they are easy to pattern-match onto this one by
   * mistake: `coordsAtPos` results must NOT be divided by zoom (they are
   * already post-zoom viewport coordinates), and `getBoundingClientRect()`
   * must NOT be multiplied by `devicePixelRatio` before `setSplitPreviewBounds`.
   * Neither applies here: this is not a viewport coordinate being converted to
   * another viewport coordinate, it is a scaled length being converted back
   * into the unscaled length `contentHeightPx` is expressed in.
   */
  scale: number
  /** The status bar's own page count (`usePageCount`'s value) -- `null` before it resolves. */
  pageCount: number | null
  /** EditorScreen's `handleNavigateToPage` -- the existing click-driven page-nav path. */
  onNavigate: (page: number) => void
}

/** See `notifySettled`'s own doc comment on the returned object below. */
export interface SplitFollowScrollHandle {
  /**
   * Call this from SplitPreview's own `onPageChange` callback (i.e.
   * whatever EditorScreen already passes as `onPageChange={(state) =>
   * setCurrentPage(state.currentPage)}`), in ADDITION to that existing
   * call, never instead of it. See `IN_FLIGHT_TIMEOUT_MS`'s own comment for
   * why this exists: it's the fast path that clears the in-flight guard the
   * moment a real confirmation arrives (of ANY origin -- the queue is FIFO,
   * so any confirmation proves this hook's own earlier request already
   * drained), rather than always waiting out the full safety timeout. Safe
   * to call even when this hook never set the guard (a no-op clear), so the
   * caller does not need to know whether a given `onPageChange` firing was
   * "caused by" Follow specifically.
   */
  notifySettled: () => void
}

/**
 * Samples the editor pane's own scroll position on an interval while
 * `enabled`, and calls `onNavigate` with a freshly estimated page whenever
 * that estimate changes. See the design recon cited above for why this is
 * polling at page granularity rather than a continuous pixel-synced scroll,
 * and this file's own top-of-module comment for why zero new IPC is needed.
 */
export function useSplitFollowScroll({
  enabled,
  scrollElementRef,
  contentHeightPx,
  scale,
  pageCount,
  onNavigate
}: UseSplitFollowScrollOptions): SplitFollowScrollHandle {
  // Latest-ref triple, matching MilkdownEditor.tsx's onChangeRef/onErrorRef
  // and SplitPreview.tsx's onPageChangeRef precedent exactly: the effect
  // below has an intentionally narrow dependency array (see its own
  // comment), so anything it reads that changes more often than that array
  // is threaded through a ref updated on every render instead, rather than
  // tearing down and recreating the interval on every keystroke's worth of
  // page-count/geometry recalculation.
  const onNavigateRef = useRef(onNavigate)
  useEffect(() => {
    onNavigateRef.current = onNavigate
  })
  const contentHeightRef = useRef(contentHeightPx)
  useEffect(() => {
    contentHeightRef.current = contentHeightPx
  })
  // Threaded through a ref for the same reason as the other three, and with
  // one extra consequence worth naming: the fit scale changes on every window
  // resize and on every frame of a Split-divider drag, so depending on it
  // directly would tear the interval down and RE-SEED `lastEstimateRef` (see
  // the seeding comment below) tens of times during a single drag gesture.
  const scaleRef = useRef(scale)
  useEffect(() => {
    scaleRef.current = scale
  })
  const pageCountRef = useRef(pageCount)
  useEffect(() => {
    pageCountRef.current = pageCount
  })

  // The last estimate THIS HOOK has dispatched (or treated as already
  // matching reality -- see the seeding logic below). Distinct from
  // SplitPreview's own `lastAppliedPageRef`, which tracks what the preview
  // itself has confirmed; this one only tracks what this hook has asked
  // for, so an unchanged scroll position across ticks is a cheap no-op
  // rather than a redundant re-dispatch of the same page every 500ms.
  const lastEstimateRef = useRef<number | null>(null)
  // Mirrors SplitPreview's own `pollInFlightRef` exactly, and for the same
  // reason: without it, a tick firing while a PREVIOUS Follow-triggered
  // request is still working its way through the shared harness queue would
  // dispatch a SECOND, different `setCurrentPage` value on top of it --
  // `SplitPreview`'s `targetPage` effect has no cancellation of its own (no
  // effect cleanup function at all), so each distinct value it sees fires an
  // independent, unconditionally-queued `scrollSplitPreviewToPage` call. A
  // skipped tick costs nothing (mirroring the poll's own reasoning): the
  // next tick re-reads whatever the CURRENT scroll position is, so no
  // in-between position is ever permanently lost, only briefly not yet
  // reflected in the preview.
  const inFlightRef = useRef(false)
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!enabled) return

    // The ONE place `scrollTop` is converted out of the (possibly scaled)
    // scroll container's coordinate space into the document space
    // `contentHeightPx` is expressed in -- see `scale`'s own doc comment above
    // for the measurement behind it. Both the seed below and every tick go
    // through this deliberately: with the division written out twice, one call
    // site could be corrected while the other silently was not, and the
    // resulting bug (a seed computed in the wrong space) would only surface as
    // one spurious page jump on activation.
    const estimateFor = (el: HTMLDivElement, count: number): number => {
      const currentScale = scaleRef.current
      // `> 0` is false for NaN as well as for 0 and negatives, so every input
      // that cannot be divided by falls back to treating the pane as unscaled
      // rather than producing Infinity/NaN -- which `clampPageIndex` would
      // resolve to the LAST page and to page 1 respectively, both plausible
      // enough to look like a real answer.
      const documentOffsetPx = currentScale > 0 ? el.scrollTop / currentScale : el.scrollTop
      return estimatePageFromScrollOffset(documentOffsetPx, contentHeightRef.current, count)
    }

    // Seed from whatever the editor pane is ALREADY scrolled to right now,
    // not from `null`/1 -- load-bearing, not a style choice. A real,
    // reproduced regression found building this: switching into Split
    // (format) mode via "Next page" sets `currentPage` to the requested
    // page and mounts a FRESH page card, which always starts at
    // `scrollTop === 0` regardless of what page was requested (the page
    // card has no scroll-to-page-on-mount behavior of its own). Seeding
    // `lastEstimateRef` to `null` would make this hook's very first tick
    // compute `estimate = 1` from that stale top-of-card position and
    // dispatch it -- silently snapping the preview BACK to page 1 and
    // undoing the navigation the user just asked for, within 500ms of it
    // landing. Seeding from the CURRENT position instead means this hook
    // only ever reacts to scrolling that happens AFTER it activates, which
    // is exactly its one-directional contract: it must never assert
    // authority over a preview position it did not itself observe the
    // editor move away from.
    const seedEl = scrollElementRef.current
    const seedCount = pageCountRef.current
    lastEstimateRef.current =
      seedEl && seedCount !== null && seedCount > 0 ? estimateFor(seedEl, seedCount) : null
    inFlightRef.current = false

    const tick = (): void => {
      if (inFlightRef.current) return
      const el = scrollElementRef.current
      if (!el) return
      const count = pageCountRef.current
      // `pageCount === null` (not yet resolved) or `<= 0` covers both "the
      // status-bar count hasn't loaded yet" and the main process's own
      // `{currentPage:1,pageCount:0}` "no harness yet" sentinel this hook
      // never sees directly (it goes through `handleNavigateToPage`'s own
      // clamp, not through this hook) -- there is nothing to follow TO yet
      // either way, matching the existing scroll/poll paths' own treatment
      // of that same sentinel in SplitPreview.tsx.
      if (count === null || count <= 0) return
      const estimate = estimateFor(el, count)
      if (estimate === lastEstimateRef.current) return
      lastEstimateRef.current = estimate
      inFlightRef.current = true
      onNavigateRef.current(estimate)
      // Fallback clear -- see IN_FLIGHT_TIMEOUT_MS's own comment for why
      // this is a bounded worst case, not a measured round-trip time.
      safetyTimerRef.current = setTimeout(() => {
        inFlightRef.current = false
        safetyTimerRef.current = null
      }, IN_FLIGHT_TIMEOUT_MS)
    }

    const timer = setInterval(tick, FOLLOW_INTERVAL_MS)
    return () => {
      clearInterval(timer)
      if (safetyTimerRef.current !== null) {
        clearTimeout(safetyTimerRef.current)
        safetyTimerRef.current = null
      }
      inFlightRef.current = false
    }
    // Deliberately narrow: `onNavigate`/`contentHeightPx`/`pageCount` are
    // read through the latest-ref triple above precisely so this effect
    // does NOT tear down and recreate the interval (and re-seed
    // lastEstimateRef) on every keystroke's worth of page-count/geometry
    // recalculation while Follow stays continuously active -- only a real
    // activation change (`enabled`) or a swap to a different scroll
    // container (`scrollElementRef`, stable in practice) should restart it.
    // Reading a ref's `.current` inside an effect body is exempt from
    // react-hooks/exhaustive-deps by design (a ref's own identity is
    // stable), so this array is already complete as far as that rule is
    // concerned -- no eslint-disable needed.
  }, [enabled, scrollElementRef])

  return {
    notifySettled: (): void => {
      inFlightRef.current = false
      if (safetyTimerRef.current !== null) {
        clearTimeout(safetyTimerRef.current)
        safetyTimerRef.current = null
      }
    }
  }
}
