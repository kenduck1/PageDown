import { describe, expect, it } from 'vitest'
import { DEFAULT_ZOOM, ZOOM_OPTIONS, nextZoomLevel, previousZoomLevel } from './zoom-levels'

describe('zoom levels', () => {
  it('steps to the adjacent level, in the order the status bar renders them', () => {
    expect(nextZoomLevel(1)).toBe(1.25)
    expect(previousZoomLevel(1)).toBe(0.9)
  })

  it('only ever produces values from the shared option list', () => {
    // The whole reason this list is shared rather than duplicated: the status
    // bar's zoom control is a controlled <select>, and a value not present as
    // an <option> makes it render BLANK.
    const values = ZOOM_OPTIONS.map((option) => option.value)
    for (const value of values) {
      expect(values).toContain(nextZoomLevel(value))
      expect(values).toContain(previousZoomLevel(value))
    }
  })

  it('clamps at both ends instead of wrapping', () => {
    // Wrapping 200% round to 50% on a repeated keypress would be a genuinely
    // surprising jump; every editor clamps.
    const smallest = ZOOM_OPTIONS[0].value
    const largest = ZOOM_OPTIONS[ZOOM_OPTIONS.length - 1].value
    expect(previousZoomLevel(smallest)).toBe(smallest)
    expect(nextZoomLevel(largest)).toBe(largest)
  })

  it('recovers to 100% from a value that is not on the list at all', () => {
    // Defensive rather than currently reachable: a NaN or an off-list value
    // must not propagate into `transform: scale(NaN)`.
    expect(nextZoomLevel(0.83)).toBe(DEFAULT_ZOOM)
    expect(previousZoomLevel(Number.NaN)).toBe(DEFAULT_ZOOM)
  })
})
