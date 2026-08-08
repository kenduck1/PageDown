import { describe, it, expect } from 'vitest'
import { clampPageIndex, pickCurrentPage } from './page-nav'

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
