// Pure rect arithmetic for placing a floating overlay (the selection bubble
// today; the slash menu next) inside a measured "safe" rectangle. No DOM
// access, no React, no ProseMirror -- the same role src/pagination/page-nav.ts
// plays for page navigation, and for the same reason: THE OCCLUSION GUARANTEE
// THIS WHOLE FEATURE RESTS ON LIVES HERE, and a guarantee that only exists
// inside a React component's render path is a guarantee that cannot be
// unit-tested. Everything in this file is exercised directly by
// floating-position.test.ts, including the one assertion that is the design's
// core claim ("given the split-mode safe rect and a selection at its right
// edge, the overlay's right edge never reaches the native preview view").
//
// Named floating-position.ts rather than the design doc's own
// bubble-position.ts, deliberately: nothing below is bubble-specific (it is
// rect arithmetic over an anchor, a size and a safe box), the slash-menu
// sub-project needs the identical clamp against the identical safe rect, and
// the design doc's own residual-risk list asks for exactly this generalization.
//
// WHY A CLAMP AT ALL, restated because it is invisible from this file's types:
// Split mode's live preview pane is a real native WebContentsView, and a
// WebContentsView composites above ALL DOM, unconditionally (the property that
// partially occluded PageSetupModal and forced its zero-size-rectangle
// workaround). The editor pane and that view are disjoint rectangles, but the
// page card is a FIXED width inside a narrower scroller, so it overflows to the
// right and a selection near the right edge of a visible line sits within a few
// pixels of the native view's left edge -- an overlay centred there would hang
// underneath it. Clamping into `intersect(canvas, editorPane)` makes that
// structurally impossible instead of visually unlikely.
//
// The zero-rect workaround PageSetupModal uses is deliberately NOT reused here:
// a selection overlay appears on essentially every selection, so blanking the
// whole preview each time would strobe, and each blank/restore is a native
// setBounds() round trip through the same serialized queue that carries real
// renders and teardown.

/**
 * A viewport-relative rectangle. Deliberately structural (left/top/right/
 * bottom) so a real `DOMRect` can be passed straight in with no conversion --
 * width/height are derived here rather than carried, so a caller can never
 * hand in a rect whose width disagrees with its own edges.
 */
export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** The measured size of the floating element itself. */
export interface FloatingSize {
  width: number
  height: number
}

export interface FloatingPlacement {
  /** Viewport-relative, for `position: fixed`. */
  left: number
  top: number
  /**
   * The widest the overlay may render. Never negative. A narrow pane (Split
   * mode's own MIN_SPLIT_RATIO of 25% gives a ~168px left pane, narrower than
   * any plausible bubble) must make the overlay scroll internally rather than
   * widen past the safe rect -- widening is exactly what would put it under
   * the native view.
   */
  maxWidth: number
  /** Which side of the anchor the overlay ended up on. */
  placement: 'above' | 'below'
}

/** Breathing room between the overlay and the safe rect's own edges. */
export const FLOATING_EDGE_PAD = 8

/** Vertical gap between the overlay and the anchor (the selected text). */
export const FLOATING_ANCHOR_GAP = 8

export function rectWidth(rect: Rect): number {
  return rect.right - rect.left
}

export function rectHeight(rect: Rect): number {
  return rect.bottom - rect.top
}

/**
 * The smallest rect containing both. Used to build the selection anchor from
 * the coordinates of its two ends: a union is stable across a drag, where
 * head-vs-anchor ordering flips and either end alone jitters.
 */
export function unionRect(a: Rect, b: Rect): Rect {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom)
  }
}

/**
 * The overlapping region, or `null` when they do not overlap (or touch only
 * along an edge, i.e. zero area).
 *
 * Returning `null` rather than an inverted/zero rect is load-bearing for the
 * caller: "there is no measurable safe area" must mean "do not render," never
 * "render somewhere arbitrary." An overlay placed against a degenerate safe
 * rect is precisely the case whose non-occlusion cannot be guaranteed.
 */
export function intersectRect(a: Rect, b: Rect): Rect | null {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.min(a.right, b.right)
  const bottom = Math.min(a.bottom, b.bottom)
  if (right <= left || bottom <= top) return null
  return { left, top, right, bottom }
}

/**
 * Whether two (possibly absent) rects describe the same box, within a
 * sub-pixel tolerance. Callers re-measure on every scroll/resize tick and feed
 * the result into React state; without this they would re-render on every tick
 * that produced a byte-identical rect. The tolerance exists because
 * `getBoundingClientRect()` returns fractional values that differ in the last
 * bit between reads at the same visual position under a CSS transform.
 */
export function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.right - b.right) < 0.5 &&
    Math.abs(a.bottom - b.bottom) < 0.5
  )
}

/**
 * A zero-width, zero-height anchor at the horizontal centre of `rect`'s TOP
 * edge -- the "we could not locate the selection, put it where the layout row
 * used to be" fallback for the composer popovers (LinkComposer /
 * CommentComposer).
 *
 * It is needed because those two, unlike the bubble and the slash palette, can
 * be opened from surfaces that have no ProseMirror selection to anchor to at
 * all: EditorToolbar's own buttons and the Mod-Shift-M shortcut both fire in
 * SOURCE mode, where `editorRef` is null and `getSelectionRect()` therefore
 * cannot return anything. Rendering nothing there -- SelectionBubble's own
 * answer to a missing rect -- is the wrong trade for a composer: a bubble that
 * declines to appear costs the user nothing (every command it offers is also
 * on the toolbar and in a keymap), whereas a composer that declines to appear
 * after an explicit "Insert link" click IS the dead control this codebase
 * repeatedly names as worse than any visual glitch.
 *
 * Feeding this through computeFloatingPosition lands the overlay at
 * `safe.top + FLOATING_EDGE_PAD`, horizontally centred: the anchor cannot fit
 * an overlay ABOVE it (it sits on the safe rect's own top edge), so placement
 * flips below and then clamps to exactly that. That is deliberately the same
 * place the layout row occupied, so the fallback degrades to the OLD
 * behaviour rather than to an arbitrary corner -- and, being a real anchor fed
 * through the real clamp, it keeps the occlusion guarantee intact rather than
 * bypassing it.
 */
export function topCenterAnchor(rect: Rect): Rect {
  const centerX = (rect.left + rect.right) / 2
  return { left: centerX, right: centerX, top: rect.top, bottom: rect.top }
}

/**
 * Places an overlay of `size` against `anchor`, confined to `safe`.
 *
 * Preferred placement is ABOVE the anchor, horizontally centred on it -- the
 * convention every editor with a selection bubble uses, and the one that keeps
 * the overlay off the text the user is about to act on. It flips BELOW when
 * there is not enough room above inside `safe`, then clamps on both axes.
 *
 * Two clamp-ordering decisions that look interchangeable and are not:
 *
 * - HORIZONTALLY, the RIGHT edge wins when the safe rect is too narrow to
 *   satisfy both bounds (i.e. `Math.min(maxLeft, Math.max(minLeft, left))`,
 *   not the other way round). That case is only reachable when the safe rect
 *   is narrower than 2*FLOATING_EDGE_PAD, since `maxWidth` below already
 *   guarantees the overlay itself fits -- but which bound survives it decides
 *   whether a degenerate measurement can push the overlay INTO the native
 *   view's column. The right edge is the one with a native view behind it, so
 *   the right edge is the one that must never lose.
 * - VERTICALLY, the TOP edge wins, because nothing composites above the DOM
 *   along that axis (the native view spans the pane's full height; only the
 *   horizontal axis separates them), so the tie-break is purely "stay
 *   on-screen," and being pushed off the bottom is worse than overlapping the
 *   anchor.
 */
export function computeFloatingPosition(
  anchor: Rect,
  size: FloatingSize,
  safe: Rect
): FloatingPlacement {
  const maxWidth = Math.max(0, rectWidth(safe) - FLOATING_EDGE_PAD * 2)
  // Never wider than the safe rect allows -- see FloatingPlacement.maxWidth.
  // The caller renders at `maxWidth` with internal scrolling; this local is
  // what the CENTRING and CLAMPING below must use, since laying out against a
  // width the overlay will never actually have would mis-centre it.
  const width = Math.min(size.width, maxWidth)
  const height = size.height

  const above = anchor.top - FLOATING_ANCHOR_GAP - height
  const fitsAbove = above >= safe.top + FLOATING_EDGE_PAD
  const placement: 'above' | 'below' = fitsAbove ? 'above' : 'below'
  const unclampedTop = fitsAbove ? above : anchor.bottom + FLOATING_ANCHOR_GAP

  const minTop = safe.top + FLOATING_EDGE_PAD
  const maxTop = safe.bottom - FLOATING_EDGE_PAD - height
  const top = Math.max(minTop, Math.min(maxTop, unclampedTop))

  const centerX = (anchor.left + anchor.right) / 2
  const minLeft = safe.left + FLOATING_EDGE_PAD
  const maxLeft = safe.right - FLOATING_EDGE_PAD - width
  const left = Math.min(maxLeft, Math.max(minLeft, centerX - width / 2))

  return { left, top, maxWidth, placement }
}
