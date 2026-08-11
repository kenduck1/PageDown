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
 * The FINAL index the dragged tab should end up at -- i.e. exactly what
 * documentStore's `reorderTab(tabId, toIndex)` contract takes.
 *
 * `fromIndex` is where the dragged tab sits now; `overIndex` is the tab it was
 * dropped on; `dropAfter` is isDropAfter's answer for that drop.
 *
 * The off-by-one this exists to get right: the natural way to think about a
 * drop is as an INSERTION SLOT in the current array (`overIndex`, or
 * `overIndex + 1` for the after-side). But the dragged tab is removed before
 * it is re-inserted, and that removal shifts every slot after `fromIndex` down
 * by one. So a rightward move -- and only a rightward move -- needs the
 * decrement. Getting this wrong is invisible for a leftward drag and off by
 * exactly one tab for a rightward one, which is precisely the kind of bug that
 * reads as "reordering is just slightly wrong sometimes".
 */
export function computeReorderIndex(
  fromIndex: number,
  overIndex: number,
  dropAfter: boolean
): number {
  const insertionSlot = overIndex + (dropAfter ? 1 : 0)
  return insertionSlot > fromIndex ? insertionSlot - 1 : insertionSlot
}
