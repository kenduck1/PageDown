import { describe, it, expect } from 'vitest'
import { clampPageIndex, pickCurrentPage, estimatePageFromScrollOffset } from './page-nav'

describe('clampPageIndex', () => {
  it('returns 1 when there are no pages', () => {
    expect(clampPageIndex(5, 0)).toBe(1)
  })

  it('clamps above the last page', () => {
    expect(clampPageIndex(99, 12)).toBe(12)
  })

  it('clamps below the first page', () => {
    expect(clampPageIndex(0, 12)).toBe(1)
    expect(clampPageIndex(-4, 12)).toBe(1)
  })

  it('passes an in-range page through', () => {
    expect(clampPageIndex(7, 12)).toBe(7)
  })

  it('floors a fractional request rather than producing a fractional page', () => {
    expect(clampPageIndex(3.9, 12)).toBe(3)
  })

  it('returns 1 for a non-finite request', () => {
    expect(clampPageIndex(Number.NaN, 12)).toBe(1)
    expect(clampPageIndex(Number.POSITIVE_INFINITY, 12)).toBe(12)
  })
})

describe('pickCurrentPage', () => {
  it('returns 1 when there are no pages', () => {
    expect(pickCurrentPage([], 800)).toBe(1)
  })

  it('returns 1 when every page is still below the threshold', () => {
    // Page 1 at the very top, page 2 far below the 1/3 line (266px).
    expect(pickCurrentPage([0, 1056], 800)).toBe(1)
  })

  it('advances once the next page crosses the one-third line', () => {
    // Threshold is 800/3 = 266.67. Page 2's top at 200 is above it.
    expect(pickCurrentPage([-856, 200], 800)).toBe(2)
  })

  it('picks the LAST page at or above the threshold, not the first', () => {
    expect(pickCurrentPage([-2000, -1000, 100, 1200], 800)).toBe(3)
  })

  it('treats a page exactly on the threshold as current', () => {
    expect(pickCurrentPage([-800, 800 / 3], 800)).toBe(2)
  })

  it('never returns a page beyond the list', () => {
    expect(pickCurrentPage([-100, -50, -10], 800)).toBe(3)
  })

  it('falls back to page 1 for a zero-height viewport', () => {
    expect(pickCurrentPage([0, 1056], 0)).toBe(1)
  })
})

describe('estimatePageFromScrollOffset', () => {
  it('returns page 1 at offset 0', () => {
    expect(estimatePageFromScrollOffset(0, 864, 20)).toBe(1)
  })

  it('returns page 1 for any offset still within the first page', () => {
    expect(estimatePageFromScrollOffset(863, 864, 20)).toBe(1)
  })

  it('advances to page 2 once the offset crosses one content height', () => {
    expect(estimatePageFromScrollOffset(864, 864, 20)).toBe(2)
    expect(estimatePageFromScrollOffset(1000, 864, 20)).toBe(2)
  })

  it('clamps an offset past the last page to the last page', () => {
    // 50 content-heights deep into a 20-page document.
    expect(estimatePageFromScrollOffset(50 * 864, 864, 20)).toBe(20)
  })

  it('returns 1 when pageCount is 0 -- the "no harness yet" sentinel', () => {
    expect(estimatePageFromScrollOffset(5000, 864, 0)).toBe(1)
  })

  it('returns 1 when pageCount is negative', () => {
    expect(estimatePageFromScrollOffset(5000, 864, -3)).toBe(1)
  })

  it('produces a different estimate for the same offset under a different contentHeightPx', () => {
    // Same raw scroll offset, two different documents' own per-page content
    // height (e.g. A4 vs Letter, or different margins) -- the function must
    // read contentHeightPx as a real parameter every call, not a captured
    // constant, or switching documents in Split mode would silently keep
    // estimating against the PREVIOUS document's geometry.
    const tall = estimatePageFromScrollOffset(2000, 1000, 20) // page 3
    const short = estimatePageFromScrollOffset(2000, 400, 20) // page 6
    expect(tall).toBe(3)
    expect(short).toBe(6)
    expect(tall).not.toBe(short)
  })

  it('returns 1 for a non-finite scroll offset', () => {
    expect(estimatePageFromScrollOffset(Number.NaN, 864, 20)).toBe(1)
    expect(estimatePageFromScrollOffset(Number.POSITIVE_INFINITY, 864, 20)).toBe(20)
    expect(estimatePageFromScrollOffset(Number.NEGATIVE_INFINITY, 864, 20)).toBe(1)
  })

  it('returns 1 for a non-finite or non-positive contentHeightPx rather than throwing', () => {
    // A defensive guard, not an expected input -- computePageGeometry always
    // produces a positive contentHeightPx (see its own MIN_CONTENT_PX
    // clamp), but this function must not divide-by-zero-crash if it's ever
    // called before real geometry has resolved.
    expect(estimatePageFromScrollOffset(1000, 0, 20)).toBe(1)
    expect(estimatePageFromScrollOffset(0, 0, 20)).toBe(1)
    expect(estimatePageFromScrollOffset(1000, Number.NaN, 20)).toBe(1)
    expect(estimatePageFromScrollOffset(1000, -500, 20)).toBe(1)
  })

  it('floors a fractional page rather than rounding', () => {
    // 1.5 content-heights deep -- squarely inside page 2, not page 2.5.
    expect(estimatePageFromScrollOffset(1296, 864, 20)).toBe(2)
  })
})
