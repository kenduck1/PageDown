// The arithmetic behind drag-to-resize for an image in the Format canvas
// (src/renderer/src/milkdown/image-security.ts drives it). Pure, and separated
// from the DOM wiring on purpose: jsdom has no layout engine and no real
// pointer events, so a drag can only be proven end to end in a gate
// (phase0/gate41-image-resize.spec.ts) -- but the geometry itself is ordinary
// arithmetic that deserves real unit tests rather than a 60-second Electron
// launch per case.
//
// ---------------------------------------------------------------------------
// WHY A PERCENTAGE AND NOT A PIXEL COUNT
// ---------------------------------------------------------------------------
// `{width=...}` accepts both, and `parseAttributeBlock` normalizes an absolute
// unit to whole pixels -- so emitting pixels would have been the smaller
// change. A dragged size is emitted as a PERCENTAGE anyway, for two reasons
// that pixels cannot satisfy:
//
//   1. The gesture the user performs IS a fraction. Dragging a logo to "half
//      the text column" means half the text column, and it should still mean
//      that after Page Setup switches the document from Letter to A4, or
//      changes the margins -- both of which move the content box. A pixel
//      count baked in at drag time silently stops meaning what was dragged.
//   2. A percentage is what the existing normalization already understands
//      best: parseAttributeBlock clamps it at 100%, which is exactly where
//      `max-width: 100%` caps the rendered image on BOTH surfaces, so the
//      value in the file and the pixels on the page cannot disagree.
//
// ---------------------------------------------------------------------------
// WHY THIS IS ZOOM-INVARIANT WITHOUT DIVIDING BY THE ZOOM FACTOR
// ---------------------------------------------------------------------------
// The Format canvas sits inside a CSS `zoom` wrapper (EditorScreen's zoom
// control, and Split mode's fit-to-width scale). CLAUDE.md's standing rule for
// the bubble menu is "do NOT divide by zoom" because getBoundingClientRect()
// already returns post-zoom viewport coordinates -- and the same fact makes
// this function need no zoom input at all. Every length here is measured in
// that one post-zoom viewport space: the image's own rect, its container's
// rect, and a raw pointer delta. A ratio of two post-zoom lengths equals the
// ratio of the same two layout lengths, so the percentage falls out correct at
// any zoom, with nothing to pass in and nothing to get backwards.
//
// ---------------------------------------------------------------------------
// WHY ONLY THE HORIZONTAL COMPONENT OF THE DRAG IS READ
// ---------------------------------------------------------------------------
// A corner handle that ignores vertical movement looks like an oversight and
// is not. Both rendering surfaces set `height: auto` on document images, and
// `{height=...}` is REJECTED by parseAttributeBlock rather than unimplemented
// (see its own comment: an author stylesheet beats a presentational hint, so
// an emitted `height` attribute would do nothing on either surface). So width
// is the only dimension this document format can express, and reading the
// vertical delta would let the user drag out an aspect ratio the file has no
// way to record -- the resize would snap back on the next save. Honouring only
// the axis that can be saved is the honest behaviour.

// Floor rather than parseAttributeBlock's own 1%-of-anything: at 5% of a
// 624px content box an image is ~31px, still visibly an image and still an
// obvious drag target. Below that a mis-drag produces something the user can
// see is there but cannot easily grab to undo by the same gesture. The ceiling
// is 100 for the same reason parseAttributeBlock clamps there -- past it the
// value and the painted result stop agreeing.
export const MIN_WIDTH_PERCENT = 5
export const MAX_WIDTH_PERCENT = 100

export interface ResizeMeasurements {
  /** The image's rendered width when the drag began, from getBoundingClientRect(). */
  startWidthPx: number
  /**
   * The width a `%` actually resolves against: the containing block of the
   * `<img>`, i.e. its parent block box. Measured, never derived from
   * PAGE_WIDTH_PX or computePageGeometry -- the canvas is inside a zoom
   * wrapper and, in Split mode, a fit-to-width scale, so the only number that
   * is true at drag time is the one read off the live DOM.
   */
  containerWidthPx: number
  /** Pointer movement along X since the drag began, in the same viewport space. */
  deltaPx: number
}

/**
 * The `{width=...}` value a drag should produce, as a normalized percentage
 * string ready for `formatAttributeBlock` -- or `null` when the measurements
 * cannot support an answer (a container of zero width, a detached element, a
 * non-finite pointer coordinate).
 *
 * `null` rather than a fallback percentage is deliberate: the caller's correct
 * response is to leave the document completely alone, and any number returned
 * here would be written into the user's file as though it had been asked for.
 */
export function resizeWidthPercent(measurements: ResizeMeasurements): string | null {
  const { startWidthPx, containerWidthPx, deltaPx } = measurements
  if (!Number.isFinite(startWidthPx) || !Number.isFinite(deltaPx)) return null
  if (!Number.isFinite(containerWidthPx) || containerWidthPx <= 0) return null

  const percent = Math.round(((startWidthPx + deltaPx) / containerWidthPx) * 100)
  // NaN cannot reach here (all three inputs are finite), so a plain clamp is
  // enough -- no Number.isNaN guard that would read as defensive padding.
  const clamped = Math.min(MAX_WIDTH_PERCENT, Math.max(MIN_WIDTH_PERCENT, percent))
  return `${clamped}%`
}
