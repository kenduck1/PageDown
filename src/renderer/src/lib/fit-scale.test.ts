import { describe, it, expect } from 'vitest'
import { computeFitScale, FIT_GUTTER_PX, MIN_FIT_SCALE } from './fit-scale'
import { PAGE_WIDTH_PX } from '../../../typography/page-geometry'

// The real measured pane widths this feature was designed against, taken from
// the actual built app at its own default 1000x840 window (canvas 784px beside
// the 216px sidebar rail) via a real Split-mode render. Pinned here so the
// FLOOR's own justification stays checkable arithmetic rather than prose: if
// someone changes MIN_FIT_SCALE, these say what it does to each real
// configuration.
const PANE_AT_DIVIDER_25 = 193
const PANE_AT_DIVIDER_50 = 389
const PANE_AT_DIVIDER_75 = 585

describe('computeFitScale', () => {
  it('returns 1 when the page already fits, and never enlarges past it', () => {
    // Enlarging is a zoom decision, and zoom belongs to the user's own
    // control -- a fit function's job is stopping overflow, not filling space.
    expect(computeFitScale(PAGE_WIDTH_PX + FIT_GUTTER_PX, PAGE_WIDTH_PX)).toBe(1)
    expect(computeFitScale(4000, PAGE_WIDTH_PX)).toBe(1)
  })

  it('shrinks a Letter page to fit a pane narrower than it', () => {
    // 585 - 24 gutter = 561; 561 / 816 = 0.68750, floored to whole percent.
    const scale = computeFitScale(PANE_AT_DIVIDER_75, PAGE_WIDTH_PX)
    expect(scale).toBeCloseTo(0.68, 10)
    // The property that actually matters, stated as the property rather than
    // as the number: the rendered page really does fit the pane it was
    // computed for.
    expect(scale * PAGE_WIDTH_PX).toBeLessThanOrEqual(PANE_AT_DIVIDER_75)
  })

  it('quantises DOWN, never to nearest -- a rounded-up scale would overflow', () => {
    // Contrived so floor and nearest genuinely DISAGREE, and so the answer
    // sits above MIN_FIT_SCALE (below the floor every input collapses to the
    // floor and the quantiser is unobservable -- which is how an earlier
    // version of this test managed to assert nothing at all).
    // 709.4 - 24 gutter = 685.4; 685.4 / 800 = 0.856750, whose nearest whole
    // percent is 0.86 and whose floor is 0.85. Rounding to nearest would
    // render 0.86 * 800 = 688px into a pane whose usable width is 685.4 -- an
    // overflow produced by the very function meant to prevent it. Written
    // against FIT_GUTTER_PX rather than a literal so a future gutter change
    // retunes the fixture instead of silently making this assert nothing.
    const scale = computeFitScale(685.4 + FIT_GUTTER_PX, 800)
    expect(scale).toBeCloseTo(0.85, 10)
    expect(scale * 800).toBeLessThanOrEqual(685.4)
  })

  it('does not lose a whole step to binary floating-point error', () => {
    // 0.71 * 100 is 70.99999999999999 in IEEE-754, so a plain Math.floor here
    // silently quantises an exact 71% down to 70% -- see FIT_SCALE_EPSILON.
    // 575.16 = 0.71 * 816 + 4 gutter, i.e. the pane width whose exact fit is
    // 0.71 to the last bit.
    expect(computeFitScale(0.71 * PAGE_WIDTH_PX + FIT_GUTTER_PX, PAGE_WIDTH_PX)).toBeCloseTo(
      0.71,
      10
    )
  })

  it('stops at the floor rather than shrinking without limit', () => {
    // Only the NARROWEST configuration is sub-floor now. That is the change:
    // the floor is a backstop for panes genuinely too narrow to help, not a
    // policy governing the common case.
    expect(computeFitScale(PANE_AT_DIVIDER_25, PAGE_WIDTH_PX)).toBe(MIN_FIT_SCALE)
    expect(MIN_FIT_SCALE * PAGE_WIDTH_PX).toBeGreaterThan(PANE_AT_DIVIDER_25)
  })

  it('FITS at the default 50/50 divider -- the configuration the old floor broke', () => {
    // The whole point of lowering the floor from 0.7 to 0.4. At 0.7 this pane
    // was clamped UP, rendering a 571px page into 389px and scrolling: the
    // app's single most common Split configuration, scrolling by default.
    // Asserted as the PROPERTY (it fits, with its margin intact) rather than
    // as the number, so a future gutter or floor change has to keep the
    // outcome rather than merely keep the arithmetic.
    const scale = computeFitScale(PANE_AT_DIVIDER_50, PAGE_WIDTH_PX)
    expect(scale).toBeGreaterThan(MIN_FIT_SCALE)
    expect(scale * PAGE_WIDTH_PX).toBeLessThanOrEqual(PANE_AT_DIVIDER_50 - FIT_GUTTER_PX)
  })

  it('leaves a real, visible margin rather than sitting flush against the pane', () => {
    // FIT_GUTTER_PX is TOTAL, so this is 12px each side, and the preview
    // surface paints exactly that much padding. At the old value of 4 the page
    // sat 2px from each edge -- not a margin, and invisible anyway because the
    // sandbox paints its own surround white.
    expect(FIT_GUTTER_PX).toBeGreaterThanOrEqual(16)
    const scale = computeFitScale(PANE_AT_DIVIDER_75, PAGE_WIDTH_PX)
    expect(PANE_AT_DIVIDER_75 - scale * PAGE_WIDTH_PX).toBeGreaterThanOrEqual(FIT_GUTTER_PX)
  })

  it('returns 1 for an unmeasured or nonsensical pane rather than collapsing the document', () => {
    // 0 is the real first-paint value, before the ResizeObserver has
    // delivered its first observation.
    expect(computeFitScale(0, PAGE_WIDTH_PX)).toBe(1)
    expect(computeFitScale(-100, PAGE_WIDTH_PX)).toBe(1)
    expect(computeFitScale(Number.NaN, PAGE_WIDTH_PX)).toBe(1)
    expect(computeFitScale(Number.POSITIVE_INFINITY, PAGE_WIDTH_PX)).toBe(1)
    expect(computeFitScale(400, 0)).toBe(1)
    expect(computeFitScale(400, Number.NaN)).toBe(1)
  })

  it('fits a per-document page size, not a hardcoded Letter width', () => {
    // A4 is 794px wide (computePageGeometry's own value), so the same pane
    // yields a genuinely different scale -- proving the page width really is
    // an input and not decoration.
    const A4_WIDTH_PX = 794
    expect(computeFitScale(PANE_AT_DIVIDER_75, A4_WIDTH_PX)).not.toBe(
      computeFitScale(PANE_AT_DIVIDER_75, PAGE_WIDTH_PX)
    )
    expect(computeFitScale(PANE_AT_DIVIDER_75, A4_WIDTH_PX) * A4_WIDTH_PX).toBeLessThanOrEqual(
      PANE_AT_DIVIDER_75
    )
  })
})
