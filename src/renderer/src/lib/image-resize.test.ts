import { describe, it, expect } from 'vitest'
import {
  resizeWidthPercent,
  MIN_WIDTH_PERCENT,
  MAX_WIDTH_PERCENT,
  type ResizeMeasurements
} from './image-resize'
import { parseAttributeBlock, formatAttributeBlock } from '../../../markdown/image-size'

// The 624px content box this app's own page geometry derives for Letter at
// 1in margins -- used as the container so the numbers below are the real
// ones a user would produce, not abstract ones.
const CONTENT_WIDTH = 624

function at(overrides: Partial<ResizeMeasurements> = {}): string | null {
  return resizeWidthPercent({
    startWidthPx: 312,
    containerWidthPx: CONTENT_WIDTH,
    deltaPx: 0,
    ...overrides
  })
}

describe('resizeWidthPercent', () => {
  it('reports the width the image already has when nothing has moved yet', () => {
    // The no-op case matters: the first pointermove of any drag has a delta of
    // roughly zero, and it must not jump the image to some other size before
    // the user has actually dragged anywhere.
    expect(at({ deltaPx: 0 })).toBe('50%')
  })

  it('grows and shrinks by the real fraction of the container the pointer moved', () => {
    // +156px on a 624px container is a quarter of the column.
    expect(at({ deltaPx: 156 })).toBe('75%')
    expect(at({ deltaPx: -156 })).toBe('25%')
  })

  it('clamps at 100% rather than letting a drag past the edge keep counting', () => {
    // Past the container's own right edge the image cannot get any wider --
    // `max-width: 100%` caps it on both surfaces -- so a value above 100 would
    // record a size the document never renders. The clamp is also what makes
    // the drag reversible: an uncapped 400% would need three columns of
    // leftward dragging before anything visibly moved.
    expect(at({ deltaPx: 1000 })).toBe(`${MAX_WIDTH_PERCENT}%`)
    expect(at({ startWidthPx: CONTENT_WIDTH, deltaPx: 1 })).toBe('100%')
  })

  it('clamps at the floor rather than shrinking an image to nothing', () => {
    expect(at({ deltaPx: -1000 })).toBe(`${MIN_WIDTH_PERCENT}%`)
    expect(MIN_WIDTH_PERCENT).toBeGreaterThan(0)
  })

  it('returns null, not a guess, when the measurements cannot support an answer', () => {
    // A zero-width container is a detached or not-yet-laid-out element. Any
    // number returned here would be written straight into the user's file as
    // though they had asked for it.
    expect(at({ containerWidthPx: 0 })).toBeNull()
    expect(at({ containerWidthPx: -1 })).toBeNull()
    expect(at({ containerWidthPx: Number.NaN })).toBeNull()
    expect(at({ startWidthPx: Number.NaN })).toBeNull()
    expect(at({ deltaPx: Number.NaN })).toBeNull()
    expect(at({ deltaPx: Number.POSITIVE_INFINITY })).toBeNull()
  })

  it('is invariant under the canvas zoom, with no zoom factor passed in', () => {
    // The property the whole "do NOT divide by zoom" rule rests on. Under CSS
    // `zoom`, getBoundingClientRect() and pointer coordinates are BOTH in the
    // same post-zoom viewport space, so scaling every input by the same factor
    // must not move the answer. Asserted rather than reasoned about, because
    // the failure mode (dividing by zoom "to correct for it") produces a
    // plausible-looking number that is wrong by exactly that factor.
    for (const scale of [0.5, 0.7, 1, 1.5]) {
      expect(
        resizeWidthPercent({
          startWidthPx: 312 * scale,
          containerWidthPx: CONTENT_WIDTH * scale,
          deltaPx: 156 * scale
        })
      ).toBe('75%')
    }
  })

  it('produces a value the document pipeline round-trips unchanged', () => {
    // The contract with src/markdown/image-size.ts: whatever a drag emits has
    // to survive being written to the file and parsed back, or every save
    // would renormalize and mark a clean document dirty. This is the same
    // stability property the `{width=3in}` -> `{width=288px}` test pins from
    // the other direction.
    for (const delta of [-1000, -100, -37, 0, 37, 100, 1000]) {
      const dragged = at({ deltaPx: delta })!
      expect(parseAttributeBlock(`width=${dragged}`)).toBe(dragged)
      expect(formatAttributeBlock(dragged)).toBe(`{width=${dragged}}`)
    }
  })
})
