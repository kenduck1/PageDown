import { describe, expect, it } from 'vitest'
import {
  computeFloatingPosition,
  FLOATING_ANCHOR_GAP,
  FLOATING_EDGE_PAD,
  intersectRect,
  rectWidth,
  sameRect,
  unionRect,
  type Rect
} from './floating-position'

// The real numbers, so these tests fail against the actual geometry rather
// than a convenient one: at the app's own default 900x670 window with
// splitRatio 50, the split preview's native WebContentsView occupies
// x 561-900 (pinned at +/-2px by phase0/gate15-split-mode.spec.ts), and the
// editor pane it must never reach into runs x 216-555 (216px sidebar + a 6px
// divider). SAFE below is the intersection the bubble is confined to.
const SPLIT_SAFE: Rect = { left: 216, top: 123, right: 561, bottom: 606 }
const SPLIT_VIEW_LEFT = 561

const BUBBLE = { width: 280, height: 34 }

describe('unionRect', () => {
  it('covers both rects', () => {
    expect(
      unionRect(
        { left: 10, top: 20, right: 30, bottom: 40 },
        { left: 5, top: 25, right: 25, bottom: 60 }
      )
    ).toEqual({ left: 5, top: 20, right: 30, bottom: 60 })
  })

  it('is the identity for a rect with itself -- a single-line selection must not grow its own anchor', () => {
    const rect = { left: 10, top: 20, right: 30, bottom: 40 }
    expect(unionRect(rect, rect)).toEqual(rect)
  })
})

describe('intersectRect', () => {
  it('returns the overlapping region', () => {
    expect(
      intersectRect(
        { left: 0, top: 0, right: 100, bottom: 100 },
        { left: 50, top: 20, right: 200, bottom: 60 }
      )
    ).toEqual({ left: 50, top: 20, right: 100, bottom: 60 })
  })

  it('returns null for disjoint rects', () => {
    expect(
      intersectRect(
        { left: 0, top: 0, right: 100, bottom: 100 },
        { left: 200, top: 0, right: 300, bottom: 100 }
      )
    ).toBeNull()
  })

  it('returns null when the rects only touch along an edge (zero area)', () => {
    // Zero area is not a safe area: an overlay clamped into it has no room at
    // all, and the caller's contract is "null means render nothing" rather
    // than "render into a degenerate box".
    expect(
      intersectRect(
        { left: 0, top: 0, right: 100, bottom: 100 },
        { left: 100, top: 0, right: 200, bottom: 100 }
      )
    ).toBeNull()
  })
})

describe('sameRect', () => {
  it('treats sub-pixel differences as the same box', () => {
    expect(
      sameRect(
        { left: 10, top: 10, right: 20, bottom: 20 },
        { left: 10.2, top: 9.9, right: 20.1, bottom: 20 }
      )
    ).toBe(true)
  })

  it('treats a whole-pixel move as a change', () => {
    expect(
      sameRect(
        { left: 10, top: 10, right: 20, bottom: 20 },
        { left: 11, top: 10, right: 21, bottom: 20 }
      )
    ).toBe(false)
  })

  it('handles absent rects', () => {
    expect(sameRect(null, null)).toBe(true)
    expect(sameRect(null, { left: 0, top: 0, right: 1, bottom: 1 })).toBe(false)
  })
})

describe('computeFloatingPosition', () => {
  it('prefers above the anchor, horizontally centred on it', () => {
    const anchor: Rect = { left: 340, top: 300, right: 400, bottom: 318 }
    const placement = computeFloatingPosition(anchor, BUBBLE, SPLIT_SAFE)
    expect(placement.placement).toBe('above')
    expect(placement.top).toBe(300 - FLOATING_ANCHOR_GAP - BUBBLE.height)
    // Centre of the anchor is 370; a 280-wide bubble centred there starts at 230.
    expect(placement.left).toBe(230)
  })

  it('flips below when there is not enough room above inside the safe rect', () => {
    // The anchor is on the first line of the pane, so `above` would land past
    // the safe rect's own top edge.
    const anchor: Rect = { left: 340, top: 130, right: 400, bottom: 148 }
    const placement = computeFloatingPosition(anchor, BUBBLE, SPLIT_SAFE)
    expect(placement.placement).toBe('below')
    expect(placement.top).toBe(148 + FLOATING_ANCHOR_GAP)
  })

  it('NEVER reaches the native preview view, for a selection at the pane’s right edge', () => {
    // THE assertion this whole module exists for. The page card is a FIXED
    // width inside a narrower scroller, so it overflows right and a selection
    // really can sit at x ~ 550 -- three pixels from the native view -- with a
    // ~280px bubble centred there naturally spanning [410, 690], i.e. ~130px
    // underneath a surface that composites above all DOM.
    const anchor: Rect = { left: 520, top: 300, right: 552, bottom: 318 }
    const placement = computeFloatingPosition(anchor, BUBBLE, SPLIT_SAFE)
    expect(placement.left + BUBBLE.width).toBeLessThanOrEqual(SPLIT_VIEW_LEFT)
    // Stronger, and the actual contract: it stays inside the safe rect with
    // its padding, not merely outside the native view by a hair.
    expect(placement.left + BUBBLE.width).toBeLessThanOrEqual(SPLIT_SAFE.right - FLOATING_EDGE_PAD)
  })

  it('clamps against the safe rect’s left edge too', () => {
    const anchor: Rect = { left: 220, top: 300, right: 240, bottom: 318 }
    const placement = computeFloatingPosition(anchor, BUBBLE, SPLIT_SAFE)
    expect(placement.left).toBe(SPLIT_SAFE.left + FLOATING_EDGE_PAD)
  })

  it('reports a maxWidth that fits the safe rect, for a pane narrower than the bubble', () => {
    // Split mode's MIN_SPLIT_RATIO (25%) gives a ~168px left pane -- narrower
    // than any plausible bubble. The overlay must scroll internally at this
    // width, never widen past the safe rect, because widening is exactly what
    // would push it under the native view.
    const narrow: Rect = { left: 216, top: 123, right: 384, bottom: 606 }
    const anchor: Rect = { left: 360, top: 300, right: 380, bottom: 318 }
    const placement = computeFloatingPosition(anchor, BUBBLE, narrow)
    expect(placement.maxWidth).toBe(rectWidth(narrow) - FLOATING_EDGE_PAD * 2)
    expect(placement.left + placement.maxWidth).toBeLessThanOrEqual(
      narrow.right - FLOATING_EDGE_PAD
    )
  })

  it('never reports a negative maxWidth', () => {
    const sliver: Rect = { left: 216, top: 123, right: 220, bottom: 606 }
    expect(
      computeFloatingPosition({ left: 218, top: 300, right: 219, bottom: 318 }, BUBBLE, sliver)
        .maxWidth
    ).toBe(0)
  })

  it('keeps the RIGHT edge inside the safe rect even when the safe rect is too narrow to satisfy both bounds', () => {
    // Only reachable for a safe rect narrower than 2 * FLOATING_EDGE_PAD, but
    // it decides which bound survives a degenerate measurement -- and the
    // right edge is the one with a native view behind it, so the right edge is
    // the one that must win. Reversing the clamp order in
    // computeFloatingPosition makes exactly this assertion fail.
    const sliver: Rect = { left: 216, top: 123, right: 226, bottom: 606 }
    const placement = computeFloatingPosition(
      { left: 220, top: 300, right: 224, bottom: 318 },
      BUBBLE,
      sliver
    )
    expect(placement.left).toBeLessThanOrEqual(sliver.right - FLOATING_EDGE_PAD)
  })

  it('keeps the TOP edge inside the safe rect when the overlay is taller than the room below', () => {
    // Opposite tie-break from the horizontal one, deliberately: nothing
    // composites above the DOM along this axis, so "stay on screen" wins.
    const shortSafe: Rect = { left: 216, top: 123, right: 561, bottom: 200 }
    const anchor: Rect = { left: 340, top: 180, right: 400, bottom: 198 }
    const placement = computeFloatingPosition(anchor, { width: 280, height: 90 }, shortSafe)
    expect(placement.top).toBe(shortSafe.top + FLOATING_EDGE_PAD)
  })
})
