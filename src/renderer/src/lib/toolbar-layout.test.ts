import { describe, it, expect } from 'vitest'
import { MIN_STICKY_REVEAL_PX, shouldPinToolbarGroup } from './toolbar-layout'

describe('shouldPinToolbarGroup', () => {
  it('pins while the group leaves at least MIN_STICKY_REVEAL_PX of scrollable region beside it', () => {
    expect(shouldPinToolbarGroup(420, 972)).toBe(true)
    // Exactly at the boundary still pins -- the reveal is a minimum, not a
    // strict inequality.
    expect(shouldPinToolbarGroup(420, 420 + MIN_STICKY_REVEAL_PX)).toBe(true)
  })

  it('un-pins at the REAL measured numbers that shipped the occlusion bug', () => {
    // Format mode, default 1000x840 window: a 420.5px group inside a 407px
    // visible region -- it covered the whole region at every scroll position.
    expect(shouldPinToolbarGroup(420.5, 407)).toBe(false)
    // Split mode at the same window size, which was worse still.
    expect(shouldPinToolbarGroup(420.5, 189)).toBe(false)
  })

  it('un-pins as soon as the reveal would drop below the minimum, before full occlusion', () => {
    // The group still FITS here (420 < 500) -- the point of the guard is that
    // a group leaving only 80px of usable region is already unusable, not that
    // it has to cover the region completely before anything is done about it.
    expect(shouldPinToolbarGroup(420, 500)).toBe(false)
  })

  it('treats an unmeasured container as "keep the pinned default"', () => {
    // jsdom reports 0 for every width, and so does the very first render
    // before the ResizeObserver fires -- un-pinning there would flash an
    // unpinned frame on every mount for no reason.
    expect(shouldPinToolbarGroup(0, 0)).toBe(true)
    expect(shouldPinToolbarGroup(420, 0)).toBe(true)
  })
})
