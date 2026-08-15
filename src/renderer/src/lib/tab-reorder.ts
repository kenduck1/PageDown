// The arithmetic behind drag-to-reorder in EditorTabBar, kept out of the
// component for the reason this project already applies to page-nav.ts's own
// clampPageIndex/pickCurrentPage: the interesting part is a pure index
// calculation with real off-by-one traps, and a component test that drives it
// through synthetic DragEvents can only ever exercise the handful of positions
// the test bothers to stage. Here it is exhaustively testable.

/**
 * Which side of the hovered tab a drop lands on.
 *
 * The midpoint, not the edges: an edge-based rule ("within 8px of the left
 * border means before") leaves a dead zone in the middle of every tab where a
 * drop means nothing, which is exactly where a pointer spends most of its
 * time. Splitting at the midpoint means every pixel of every tab has an
 * unambiguous answer.
 *
 * `>=` rather than `>` so the exact midpoint resolves to "after" instead of
 * silently depending on subpixel rounding of the caller's rect.
 */
export function isDropAfter(pointerX: number, targetLeft: number, targetWidth: number): boolean {
  return pointerX >= targetLeft + targetWidth / 2
}

/**
 * The INSERTION INDEX a hover resolves to: a gap between tabs, numbered 0
 * (before the first tab) through `tabs.length` (after the last one). N tabs
 * have N + 1 such gaps.
 *
 * This is the whole fix for a real, user-reported bug, and the reason it is a
 * named function rather than an inline `+ (after ? 1 : 0)` at the one call
 * site that needs a number: the drop indicator used to be positioned from
 * `{overIndex, dropAfter}` -- the tab under the POINTER and which half of it
 * -- so it was drawn inside tab N's right edge for "after N" and inside tab
 * N+1's left edge for "before N+1". Those are the SAME GAP, and with the tab
 * row's own 2px `gap-0.5` between tabs the two strips landed 4px apart: the
 * indicator visibly snapped between two spots that meant one thing, and
 * nothing on screen told the user which of the two they were about to get.
 *
 * Collapsing the pair to one number is what makes "one gap, one indicator"
 * structural instead of a rule the render has to remember: `after N` and
 * `before N+1` both come out of here as the integer N+1, and the component
 * renders a gap index, never a tab-and-a-side.
 */
export function resolveInsertionIndex(overIndex: number, dropAfter: boolean): number {
  return overIndex + (dropAfter ? 1 : 0)
}

/**
 * Holds an insertion index inside the 0..tabCount range of real gaps.
 *
 * Clamped rather than wrapped, deliberately: the keyboard path's "nudge one
 * step" would otherwise teleport a tab from one end of the bar to the other on
 * a keystroke whose whole point is a single-place move. (The plain-arrow FOCUS
 * navigation in EditorTabBar does wrap -- moving a cursor past the end is a
 * convenience, moving a tab past the end is a surprise.)
 */
export function clampInsertionIndex(insertionIndex: number, tabCount: number): number {
  return Math.min(Math.max(insertionIndex, 0), tabCount)
}

/**
 * The FINAL index the dragged tab should end up at -- i.e. exactly what
 * documentStore's `reorderTab(tabId, toIndex)` contract takes.
 *
 * `fromIndex` is where the dragged tab sits now; `insertionIndex` is the gap
 * it is being dropped into, as resolved by `resolveInsertionIndex`.
 *
 * The off-by-one this exists to get right: an insertion index is a slot in the
 * array AS IT STANDS, but the dragged tab is removed before it is re-inserted,
 * and that removal shifts every slot after `fromIndex` down by one. So a
 * rightward move -- and only a rightward move -- needs the decrement. Getting
 * this wrong is invisible for a leftward drag and off by exactly one tab for a
 * rightward one, which is precisely the kind of bug that reads as "reordering
 * is just slightly wrong sometimes".
 *
 * Taking the already-resolved gap rather than `(overIndex, dropAfter)` is load
 * bearing, not a tidier signature: it means the reorder and the indicator are
 * driven by the SAME integer, so the two cannot disagree about where a drop is
 * going. It is also what lets the keyboard path express "nudge right" as the
 * gap "after my right-hand neighbour" and get the identical answer a drop
 * there would give, instead of computing a final index by its own separate
 * formula and drifting from the drag path over time.
 */
export function computeReorderIndex(fromIndex: number, insertionIndex: number): number {
  return insertionIndex > fromIndex ? insertionIndex - 1 : insertionIndex
}
