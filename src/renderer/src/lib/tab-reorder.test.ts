import { describe, it, expect } from 'vitest'
import { computeReorderIndex, isDropAfter } from './tab-reorder'

describe('isDropAfter', () => {
  it('is false in the left half and true in the right half', () => {
    // A tab spanning x=100..200, so the midpoint is 150.
    expect(isDropAfter(101, 100, 100)).toBe(false)
    expect(isDropAfter(149, 100, 100)).toBe(false)
    expect(isDropAfter(151, 100, 100)).toBe(true)
    expect(isDropAfter(199, 100, 100)).toBe(true)
  })

  it('resolves the exact midpoint deterministically rather than by rounding luck', () => {
    expect(isDropAfter(150, 100, 100)).toBe(true)
  })
})

// The whole point of extracting this: the off-by-one only appears for a
// RIGHTWARD move, so a test suite that only ever drags leftward passes against
// a completely wrong implementation. Every case below is enumerated for a
// 4-tab bar, both directions.
describe('computeReorderIndex', () => {
  // Independent oracle: actually perform the move on a labelled array, so the
  // expectations below are checked against real resulting ORDER, not against
  // the same arithmetic they are testing.
  function applyMove(items: string[], fromIndex: number, toIndex: number): string[] {
    const next = items.slice()
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    return next
  }

  const TABS = ['a', 'b', 'c', 'd']

  it('dropping on the LEFT half of a tab to the right puts the dragged tab immediately before it', () => {
    // Drag "a" (0) onto the left half of "c" (2) -> a lands before c.
    const index = computeReorderIndex(0, 2, false)
    expect(index).toBe(1)
    expect(applyMove(TABS, 0, index)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('dropping on the RIGHT half of a tab to the right puts the dragged tab immediately after it', () => {
    const index = computeReorderIndex(0, 2, true)
    expect(index).toBe(2)
    expect(applyMove(TABS, 0, index)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('dropping on the LEFT half of a tab to the left puts the dragged tab immediately before it', () => {
    // Drag "d" (3) onto the left half of "b" (1) -> d lands before b.
    const index = computeReorderIndex(3, 1, false)
    expect(index).toBe(1)
    expect(applyMove(TABS, 3, index)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('dropping on the RIGHT half of a tab to the left puts the dragged tab immediately after it', () => {
    const index = computeReorderIndex(3, 1, true)
    expect(index).toBe(2)
    expect(applyMove(TABS, 3, index)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('a drop past the last tab moves the dragged tab to the end', () => {
    const index = computeReorderIndex(0, 3, true)
    expect(index).toBe(3)
    expect(applyMove(TABS, 0, index)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('a drop before the first tab moves the dragged tab to the start', () => {
    const index = computeReorderIndex(2, 0, false)
    expect(index).toBe(0)
    expect(applyMove(TABS, 2, index)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('dropping a tab back onto itself is a no-op on either half', () => {
    expect(computeReorderIndex(2, 2, false)).toBe(2)
    expect(computeReorderIndex(2, 2, true)).toBe(2)
  })

  it('dropping on the adjacent side of a neighbour is a no-op, not a swap', () => {
    // "b" (1) dropped on the RIGHT half of "a" (0) already means "b sits
    // right after a", which is where it already is.
    expect(computeReorderIndex(1, 0, true)).toBe(1)
    // Symmetrically, "b" dropped on the LEFT half of "c" (2).
    expect(computeReorderIndex(1, 2, false)).toBe(1)
  })
})
