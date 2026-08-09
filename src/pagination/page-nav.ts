// Pure page-navigation helpers, shared by the sandboxed pagination render
// context (resources/pagination-render/index.ts) and the main process.
//
// This module is BUNDLED INTO THE SANDBOX, so it must stay dependency-free
// -- see CLAUDE.md's note on why page-geometry.ts's PageConfig import has to
// stay `import type`. A runtime import here would drag that module's own
// dependencies into the one context that deliberately runs untrusted
// document HTML. Keep this file pure arithmetic.

/** Where the paginated preview currently sits, and how many pages it has. */
export interface PageNavState {
  /** 1-based. Always >= 1, even when `pageCount` is 0. */
  currentPage: number
  pageCount: number
}

/**
 * The divisor for the viewport height to find the threshold above which a
 * page counts as "the page you are looking at". A page becomes current once
 * its top edge reaches the upper third of the pane, which is what a reader
 * means by "I'm on page 3" and is stable under partial scrolls (no oscillation
 * at a boundary). Uses division, not reciprocal multiply (viewportHeight / 3
 * not viewportHeight * (1/3)), to avoid floating-point precision loss at
 * exact-boundary cases.
 */
const CURRENT_PAGE_THRESHOLD_DIVISOR = 3

/** Clamps a requested 1-based page into `[1, pageCount]`, or 1 if empty. */
export function clampPageIndex(requested: number, pageCount: number): number {
  if (pageCount <= 0) return 1
  if (Number.isNaN(requested)) return 1
  const floored = Math.floor(requested)
  if (floored < 1) return 1
  if (floored > pageCount) return pageCount
  return floored
}

/**
 * Given each page's `getBoundingClientRect().top` (viewport-relative, so
 * scrolled-past pages are negative) and the viewport height, returns the
 * 1-based page currently being read.
 */
export function pickCurrentPage(pageTops: readonly number[], viewportHeight: number): number {
  if (pageTops.length === 0) return 1
  if (!(viewportHeight > 0)) return 1
  const threshold = viewportHeight / CURRENT_PAGE_THRESHOLD_DIVISOR
  let current = 1
  for (let index = 0; index < pageTops.length; index += 1) {
    if (pageTops[index] <= threshold) current = index + 1
  }
  return current
}
