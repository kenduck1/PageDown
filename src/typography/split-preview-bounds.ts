interface CssRect {
  x: number
  y: number
  width: number
  height: number
}

// Converts a CSS-pixel rectangle (getBoundingClientRect()'s own unit) to
// WebContentsView.setBounds()'s own Rectangle units.
//
// NOT a physical-pixel conversion, despite an earlier draft of this file
// (and its name) claiming otherwise -- final whole-branch review finding
// (Minor, M1), corrected before merge specifically because the stale name/
// comment were actively misleading, not just imprecise: a future
// contributor reading only this file would have reintroduced the
// `x devicePixelRatio` bug the plan's original formula had. Verified
// empirically (src/main/index.ts's own `split-preview:setBounds` handler
// comment has the full evidence): WebContentsView.setBounds() takes DIP
// ("device independent pixels"), the SAME unit getBoundingClientRect()
// already reports -- Chromium scales DIP bounds up to the display's real
// physical pixels internally, the same way it does for an ordinary
// BrowserWindow. `zoomFactor` here is Electron's own webContents zoom level
// (`getZoomFactor()`), a genuine but separate axis from device pixel ratio --
// nothing in this codebase calls `setZoomFactor()` today, so this is 1.0 in
// practice, but the parameter exists so a future zoom feature has somewhere
// to plug in without another silent unit mismatch.
export function toViewBounds(cssBounds: CssRect, zoomFactor: number): CssRect {
  return {
    x: Math.round(cssBounds.x * zoomFactor),
    y: Math.round(cssBounds.y * zoomFactor),
    width: Math.round(cssBounds.width * zoomFactor),
    height: Math.round(cssBounds.height * zoomFactor)
  }
}
