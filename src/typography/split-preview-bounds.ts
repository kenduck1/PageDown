interface CssRect {
  x: number
  y: number
  width: number
  height: number
}

// Converts a CSS-pixel rectangle (getBoundingClientRect()'s own unit) to
// the physical-pixel Rectangle WebContentsView.setBounds() expects.
// Electron's own types declare Rectangle's fields as plain `number` with
// no documented fractional guarantee; setBounds is observed in practice
// to require integers, hence the rounding here rather than in each call
// site.
export function toPhysicalBounds(cssBounds: CssRect, devicePixelRatio: number): CssRect {
  return {
    x: Math.round(cssBounds.x * devicePixelRatio),
    y: Math.round(cssBounds.y * devicePixelRatio),
    width: Math.round(cssBounds.width * devicePixelRatio),
    height: Math.round(cssBounds.height * devicePixelRatio)
  }
}
