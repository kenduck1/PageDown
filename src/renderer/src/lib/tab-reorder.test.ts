import { describe, it, expect } from 'vitest'
import {
  clampInsertionIndex,
  computeReorderIndex,
  isDropAfter,
  resolveInsertionIndex
} from './tab-reorder'

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

// The property behind a real, user-reported bug: the drop indicator snapped
// between two positions between every pair of tabs, because "after tab N" and
// "before tab N+1" were carried as two different states. They are one gap, and
// this is the function that says so.
describe('resolveInsertionIndex', () => {
  it('collapses "after tab N" and "before tab N+1" to the SAME gap', () => {
    // The interior boundary between tabs 1 and 2, approached from both sides.
    expect(resolveInsertionIndex(1, true)).toBe(2)
    expect(resolveInsertionIndex(2, false)).toBe(2)
  })

  it('agrees on every interior boundary of a 4-tab bar, not just one', () => {
    // Enumerated rather than spot-checked because a formula that happens to
    // agree at one boundary (say, an accidental constant) would pass the case
    // above. Gaps 1, 2 and 3 are the ones with two approaches; 0 and 4 have
    // only one each, which is exactly why the ends never showed the bug.
    for (let boundary = 1; boundary <= 3; boundary++) {
      expect(resolveInsertionIndex(boundary - 1, true)).toBe(boundary)
      expect(resolveInsertionIndex(boundary, false)).toBe(boundary)
    }
  })

  it('numbers the two end gaps distinctly from every interior one', () => {
    // 4 tabs -> 5 gaps, 0..4. Before the first and after the last must be
    // reachable and must not collide with an interior gap.
    expect(resolveInsertionIndex(0, false)).toBe(0)
    expect(resolveInsertionIndex(3, true)).toBe(4)
  })
})

describe('clampInsertionIndex', () => {
  it('holds a gap inside 0..tabCount', () => {
    expect(clampInsertionIndex(-1, 3)).toBe(0)
    expect(clampInsertionIndex(4, 3)).toBe(3)
  })

  it('leaves both real end gaps alone -- tabCount is a VALID gap, not out of range', () => {
    // Off-by-one bait: clamping to tabCount - 1 (the last tab INDEX rather
    // than the last GAP) would silently make "move to the very end"
    // unreachable, which is the single most likely thing anyone wants.
    expect(clampInsertionIndex(0, 3)).toBe(0)
    expect(clampInsertionIndex(3, 3)).toBe(3)
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

  // Composed exactly the way EditorTabBar composes them, so these cases keep
  // describing real DROPS ("the left half of c") rather than bare gap numbers,
  // and so a change to either function has to keep the pair honest.
  function drop(fromIndex: number, overIndex: number, dropAfter: boolean): number {
    return computeReorderIndex(fromIndex, resolveInsertionIndex(overIndex, dropAfter))
  }

  it('dropping on the LEFT half of a tab to the right puts the dragged tab immediately before it', () => {
    // Drag "a" (0) onto the left half of "c" (2) -> a lands before c.
    const index = drop(0, 2, false)
    expect(index).toBe(1)
    expect(applyMove(TABS, 0, index)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('dropping on the RIGHT half of a tab to the right puts the dragged tab immediately after it', () => {
    const index = drop(0, 2, true)
    expect(index).toBe(2)
    expect(applyMove(TABS, 0, index)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('dropping on the LEFT half of a tab to the left puts the dragged tab immediately before it', () => {
    // Drag "d" (3) onto the left half of "b" (1) -> d lands before b.
    const index = drop(3, 1, false)
    expect(index).toBe(1)
    expect(applyMove(TABS, 3, index)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('dropping on the RIGHT half of a tab to the left puts the dragged tab immediately after it', () => {
    const index = drop(3, 1, true)
    expect(index).toBe(2)
    expect(applyMove(TABS, 3, index)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('a drop past the last tab moves the dragged tab to the end', () => {
    const index = drop(0, 3, true)
    expect(index).toBe(3)
    expect(applyMove(TABS, 0, index)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('a drop before the first tab moves the dragged tab to the start', () => {
    const index = drop(2, 0, false)
    expect(index).toBe(0)
    expect(applyMove(TABS, 2, index)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('dropping a tab back onto itself is a no-op on either half', () => {
    expect(drop(2, 2, false)).toBe(2)
    expect(drop(2, 2, true)).toBe(2)
  })

  it('dropping on the adjacent side of a neighbour is a no-op, not a swap', () => {
    // "b" (1) dropped on the RIGHT half of "a" (0) already means "b sits
    // right after a", which is where it already is.
    expect(drop(1, 0, true)).toBe(1)
    // Symmetrically, "b" dropped on the LEFT half of "c" (2).
    expect(drop(1, 2, false)).toBe(1)
  })

  // The behavioural half of the indicator fix. The visual half (one gap, one
  // painted strip) is asserted in EditorTabBar.test.tsx; this is the half that
  // says the two approaches to a gap also RESULT in the same thing, so the
  // single indicator is not merely tidier but honest about the outcome.
  it('both approaches to one gap produce the identical final order, from every start', () => {
    for (let fromIndex = 0; fromIndex < TABS.length; fromIndex++) {
      for (let gap = 1; gap < TABS.length; gap++) {
        const afterLeftTab = drop(fromIndex, gap - 1, true)
        const beforeRightTab = drop(fromIndex, gap, false)
        expect(afterLeftTab).toBe(beforeRightTab)
        expect(applyMove(TABS, fromIndex, afterLeftTab)).toEqual(
          applyMove(TABS, fromIndex, beforeRightTab)
        )
      }
    }
  })

  // The keyboard path (Cmd/Ctrl+Shift+Arrow) does not compute a final index of
  // its own -- it names the gap its nudge aims at and comes through here. If
  // that ever stops matching the drop that lands in the same gap, the two ways
  // of reordering have silently diverged.
  it('a keyboard nudge resolves to exactly what a drop into the same gap resolves to', () => {
    for (let fromIndex = 0; fromIndex < TABS.length; fromIndex++) {
      // Nudge right == "into the gap after my right-hand neighbour" == a drop
      // on that neighbour's right half.
      const nudgeRight = computeReorderIndex(
        fromIndex,
        clampInsertionIndex(fromIndex + 2, TABS.length)
      )
      expect(nudgeRight).toBe(
        fromIndex === TABS.length - 1 ? fromIndex : drop(fromIndex, fromIndex + 1, true)
      )

      // Nudge left == "into the gap before my left-hand neighbour".
      const nudgeLeft = computeReorderIndex(
        fromIndex,
        clampInsertionIndex(fromIndex - 1, TABS.length)
      )
      expect(nudgeLeft).toBe(fromIndex === 0 ? fromIndex : drop(fromIndex, fromIndex - 1, false))
    }
  })
})
