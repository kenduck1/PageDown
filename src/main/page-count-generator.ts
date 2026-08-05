import { BaseWindow } from 'electron'
import { markdownToHtml } from '../markdown/pipeline'
import { createPaginationHarness, type PaginationHarness } from './pagination-window'

// Same queue/harness pattern as `thumbnail-generator.ts`'s `getThumbnail`
// (see that file's own comment for the full mechanism this mirrors), but a
// SEPARATE harness/queue pair -- per this codebase's established "don't
// couple unrelated harness consumers" rule (CLAUDE.md's Markdown &
// pagination pipeline section): the status bar's page-count fetches have
// nothing to do with thumbnail generation (or the Phase-0-spike harness in
// src/main/index.ts) and shouldn't share either one's queue or lifecycle.
// Every caller into `resources/pagination-render/index.ts`'s single shared
// render context must still serialize itself, though -- that render context
// only ever tracks ONE in-flight request at a time (a single
// `currentRequestId` module variable) and silently drops any request that
// isn't the most recently dispatched one, so this file needs its own
// promise-chaining queue for exactly the same reason thumbnail-generator.ts
// has one.
let harnessQueue: Promise<unknown> = Promise.resolve()

function enqueueHarnessWork<T>(task: () => Promise<T>): Promise<T> {
  const result = harnessQueue.then(task)
  // Chain the queue's tail through a value- and rejection-swallowing
  // continuation, not `result` directly -- otherwise one rejected
  // getPageCount call would permanently wedge the queue for every caller
  // after it (see thumbnail-generator.ts's identical comment).
  harnessQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

let harnessPromise: Promise<PaginationHarness> | null = null

// Tracked alongside `harnessPromise` so the dedicated window can actually be
// torn down (see `destroyPageCountHarness` below) -- `PaginationHarness`
// itself only exposes the WebContentsView, not the BaseWindow it was
// constructed against.
let harnessWindow: BaseWindow | null = null

// Lazily created, then reused for every getPageCount call within this app
// session -- deliberately a SEPARATE instance from thumbnail-generator.ts's
// own harness and the Phase-0-spike harness wired in src/main/index.ts (see
// the module comment above).
//
// Deliberately attached to a PRIVATE, DEDICATED, never-shown `BaseWindow`
// this module creates and owns itself -- NOT the real `mainWindow` every
// other harness in this codebase (thumbnail-generator.ts, the Phase-0-spike
// wiring in src/main/index.ts) attaches to, and its child view is
// deliberately left at `createPaginationHarness`'s own default bounds
// (0,0,816,1056), NEVER repositioned off-canvas via `setBounds` the way
// every other harness's view is. Both of these are load-bearing, not
// stylistic:
//
// A real, reproducible bug was found building this feature: repositioning a
// harness's view off-canvas (`{x:-9999,y:-9999,...}`, the pattern
// thumbnail-generator.ts and the Phase-0-spike harness both use) makes
// Chromium treat that view as occluded/not-visible, which throttles
// requestAnimationFrame and requestIdleCallback for its renderer --
// Paged.js's own Chunker leans on exactly those APIs for its progressive,
// per-chunk layout work (confirmed by reading pagedjs's own source:
// `this.tick = requestAnimationFrame` in its Chunker, plus a
// requestIdleCallback fallback chain elsewhere). The practical effect,
// measured directly against this exact codebase (throwaway diagnostic
// scripts, not committed): a trivial ~2-page document went from ~15ms of
// real Paged.js layout time to a ~3s plateau after just 2-3 calls on an
// off-canvas-positioned harness, and a genuinely multi-page ~13-page
// document took **9+ seconds on its very first call** -- comfortably enough
// to blow past `sendDocument`'s own 10s poll deadline for any real,
// longer document. This was never caught by any existing gate because every
// existing off-canvas harness consumer either (a) only ever tests trivial,
// single-paragraph fixture content (phase0/gate8-thumbnail-generation.spec.ts),
// or (b) dispatches a small, fixed number of calls in a tight burst right
// after harness creation (Home screen's template thumbnails) -- neither
// pattern gives the throttle enough successive occluded frames to ramp up.
// A status bar's page count, called repeatedly across an entire editing
// session, is exactly the usage pattern that exposes this for real.
//
// The fix that actually worked (verified directly, both for a reused
// harness across many calls AND for large content on a harness's very
// first call): don't let Chromium ever consider the view "occluded" in the
// first place. Positioning the ENTIRE PARENT WINDOW off any physical
// display (a real, mapped, but literally off-desktop `BaseWindow`) while
// leaving the CHILD VIEW at its own parent-relative default bounds
// (0,0,816,1056 -- i.e. filling its own window exactly, never clipped
// relative to it) avoids the occlusion state entirely: measured at a
// steady ~110-180ms per call, including for the same 13-page document that
// took 9+ seconds when off-canvas-positioned within a normal window. A
// simpler `show: false` (never-shown) dedicated window, with the child view
// still left at its own default bounds, measured identically fast -- and is
// simpler and more clearly cross-platform (no reliance on window
// positioning quirks), so that's what's used here. (An `opacity: 0`
// variant of a real, on-desktop, shown window was also tried and also
// worked -- but `BaseWindow.setOpacity`/`setOpacity` is documented as
// win32/darwin-only in Electron's own typings, with no effect on Linux,
// which this project ships a build target for -- so it was rejected in
// favor of the `show: false` approach, which has no such platform caveat.)
//
// This fix is intentionally scoped to ONLY this file: `createPaginationHarness`
// (pagination-window.ts) and its existing consumers (thumbnail-generator.ts,
// the Phase-0-spike harness) are untouched. Both of those are very likely
// exposed to the exact same underlying issue for a large enough document
// (nothing about the bug is specific to page counting), but re-architecting
// shared harness-hiding infrastructure other concurrently-developed tracks
// depend on is a bigger, riskier change than this task's scope -- flagged
// prominently in this sub-project's own report as a real, verified,
// pre-existing issue for whoever owns that shared code next, not silently
// worked around everywhere at once.
function getHarness(): Promise<PaginationHarness> {
  if (!harnessPromise) {
    const win = new BaseWindow({ show: false })
    harnessWindow = win
    harnessPromise = createPaginationHarness(win).then((harness) => {
      // Same self-healing behavior as thumbnail-generator.ts's harness: if
      // the underlying WebContentsView is ever destroyed, drop the
      // memoized promise so the NEXT getPageCount call creates a fresh
      // harness (and a fresh dedicated window) instead of silently failing
      // every request for the rest of the app session against a dead view.
      //
      // Unlike thumbnail-generator.ts's version, this ALSO has to destroy
      // `win` itself: thumbnail-generator.ts's harness attaches to the
      // caller's own `mainWindow`, which someone else is responsible for
      // destroying, but `win` here is a BaseWindow THIS module created
      // and owns -- if this handler only dropped `harnessPromise` without
      // also destroying `win`, the orphaned window would leak (it's never
      // referenced anywhere else), and each self-heal cycle would leak one
      // more, compounding the exact "extra BaseWindow keeps the app alive"
      // problem `destroyPageCountHarness` below exists to prevent.
      harness.view.webContents.once('destroyed', () => {
        harnessPromise = null
        if (!win.isDestroyed()) win.destroy()
        if (harnessWindow === win) harnessWindow = null
      })
      return harness
    })
  }
  return harnessPromise
}

/**
 * Tears down this module's dedicated harness window, if one currently
 * exists. Must be called when the app's real window(s) close and the app
 * is expected to quit (see `src/main/index.ts`'s `mainWindow` `'closed'`
 * handler) -- this harness's `BaseWindow` is a genuine, separate top-level
 * window, and `app.on('window-all-closed', ...)`'s underlying window count
 * includes it. A real, verified regression before this existed: after even
 * one `getPageCount` call, closing the app's only visible window left this
 * harness's hidden `BaseWindow` alive, `BaseWindow.getAllWindows().length`
 * never reached 0, and `window-all-closed` never fired -- meaning the app
 * process never quit on Windows/Linux (both shipped build targets) after a
 * single status-bar page-count fetch. Safe to call even if no harness has
 * been created yet (a no-op), and safe to call more than once.
 */
export function destroyPageCountHarness(): void {
  const win = harnessWindow
  harnessPromise = null
  harnessWindow = null
  if (win && !win.isDestroyed()) win.destroy()
}

// Single-entry, in-memory-only cache for the most recently computed result --
// no disk persistence (unlike thumbnail-generator.ts's PNG cache, there's no
// expensive image encode/resize/write step here to amortize across app
// restarts, just the pagination pass itself). A plain string-equality check
// against the last-seen content, not a hash: for a single in-memory slot
// there's no need for a hash's usual benefits (a compact/stable key for a
// Map, a filename, cross-process comparison) -- direct comparison is simpler
// and strictly more precise (zero collision surface) with no real cost, since
// V8 string equality on same-reference or differing-length strings is
// effectively O(1) in the common case this cache targets anyway (repeated
// calls for the exact same content string, e.g. usePageCount's own debounced
// re-fetch firing again for content that didn't actually change, or a Save
// happening shortly after the last status-bar update already computed the
// same count). A real edit always produces a different content string, so
// this never serves a stale count for genuinely changed content.
let lastContent: string | null = null
let lastResult: { pageCount: number } | null = null

/**
 * Returns the real, correct page count for a document's raw Markdown
 * content, via a one-shot round trip through the sandboxed pagination
 * render harness (the same `markdownToHtml` -> `harness.sendDocument`
 * pattern `thumbnail-generator.ts` uses, minus the thumbnail image capture
 * and disk cache -- the status bar only ever needs the number). Skips the
 * harness/queue entirely on a cache hit (see `lastContent`/`lastResult`
 * above) -- otherwise does a fresh (harness-queue-serialized) pagination
 * pass.
 *
 * Deliberately takes no `win` parameter, unlike `getThumbnail` -- see
 * `getHarness`'s own comment above for why this harness owns a private,
 * dedicated, never-shown `BaseWindow` instead of attaching to the caller's
 * real app window.
 */
export async function getPageCount(content: string): Promise<{ pageCount: number }> {
  if (lastContent === content && lastResult) {
    return lastResult
  }
  return enqueueHarnessWork(async () => {
    const harness = await getHarness()
    const { html } = markdownToHtml(content)
    const result = await harness.sendDocument(html)
    const pageCount = { pageCount: result.pageCount }
    lastContent = content
    lastResult = pageCount
    return pageCount
  })
}
