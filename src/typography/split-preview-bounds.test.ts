import { describe, expect, it } from 'vitest'
import { toPhysicalBounds } from './split-preview-bounds'

describe('toPhysicalBounds', () => {
  it('passes through unchanged at devicePixelRatio 1', () => {
    expect(toPhysicalBounds({ x: 10, y: 20, width: 300, height: 400 }, 1)).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 400
    })
  })

  it('scales by devicePixelRatio and rounds to integers', () => {
    expect(toPhysicalBounds({ x: 10.4, y: 20.6, width: 300.2, height: 400.8 }, 2)).toEqual({
      x: 21,
      y: 41,
      width: 600,
      height: 802
    })
  })

  it('never produces a negative dimension from a zero-size rectangle', () => {
    expect(toPhysicalBounds({ x: 0, y: 0, width: 0, height: 0 }, 2)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0
    })
  })
})
