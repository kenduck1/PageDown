// Pure layout arithmetic for EditorToolbar's horizontally scrollable
// formatting region. Lives in lib/ (not inside the component) for the same
// reason floating-position.ts does: it is the RULE, and a rule that decides
// whether real controls are reachable deserves a direct unit test rather than
// only being exercised through a component render that jsdom cannot measure
// anyway (jsdom reports every width as 0).

// How much of the scrollable region must remain usable BESIDE the pinned
// left group before pinning is allowed at all. 96px is three 30px icon
// buttons plus their gaps -- i.e. enough that scrolling reveals genuinely
// clickable controls rather than a sliver.
export const MIN_STICKY_REVEAL_PX = 96

/**
 * Whether the toolbar's leading group (undo/redo + the paragraph/font/size
 * selects) may stay `position: sticky` at the scrollable region's left edge.
 *
 * WHY THIS EXISTS -- a measured, shipped bug, not a hypothetical. At the
 * app's own default 1000x840 window the pinned group measured 420.5px wide
 * inside a 407px visible scroll region, so it covered the ENTIRE region at
 * EVERY scroll position: Bold, Italic, all three list buttons, link, image,
 * table, page break, Add comment and Find were unreachable by any means
 * (verified by real hit-testing in the built app -- `document.elementFromPoint`
 * at each button's centre returned the pinned group). Split mode was worse:
 * 189px visible. CLAUDE.md already recorded the symptom from the other end --
 * Gate 27 could not click its own "Add comment" toolbar button and worked
 * around it with a keyboard shortcut.
 *
 * The primary fix is that the toolbar now WRAPS its right-hand cluster onto a
 * second line rather than squeezing the formatting region (see
 * EditorToolbar.tsx), which at 1000px leaves the whole formatting row visible
 * with nothing to scroll. This guard is the structural backstop for the
 * narrow widths that still scroll (the window's own 760px minimum, a future
 * locale with wider select labels, a control added to the group later):
 * pinning is a nice-to-have, reaching the controls is not, so the group
 * un-pins and scrolls away with the content rather than occluding it.
 *
 * Ruled out as fixes on their own: widening the default window (the width is
 * pinned near 1000px by Gate 28/29's clamp assertions, which go VACUOUS above
 * ~1050px -- window-bounds.ts records the measured crossover), and simply
 * deleting the pinned group (undo/redo and the paragraph-style select are the
 * controls most worth keeping on screen while scrolling, which is what the
 * pinning is for).
 *
 * `containerWidth <= 0` means "not measured yet" (first render, or jsdom,
 * where every width is 0) and keeps the pinned default rather than flashing
 * an un-pinned frame before the ResizeObserver reports real numbers.
 */
export function shouldPinToolbarGroup(groupWidth: number, containerWidth: number): boolean {
  if (containerWidth <= 0) return true
  return groupWidth + MIN_STICKY_REVEAL_PX <= containerWidth
}
