import { describe, expect, it } from 'vitest'
import { toViewBounds } from './split-preview-bounds'

describe('toViewBounds', () => {
  it('passes through unchanged at zoomFactor 1', () => {
    expect(toViewBounds({ x: 10, y: 20, width: 300, height: 400 }, 1)).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 400
    })
  })

  it('scales by zoomFactor and rounds to integers', () => {
    expect(toViewBounds({ x: 10.4, y: 20.6, width: 300.2, height: 400.8 }, 2)).toEqual({
      x: 21,
      y: 41,
      width: 600,
      height: 802
    })
  })

  it('never produces a negative dimension from a zero-size rectangle', () => {
    expect(toViewBounds({ x: 0, y: 0, width: 0, height: 0 }, 2)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0
    })
  })
})
