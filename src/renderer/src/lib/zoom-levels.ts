// The canvas zoom levels, shared by the status bar's own zoom <select> and by
// View > Zoom In / Zoom Out / Actual Size.
//
// Shared rather than duplicated for a reason that is not merely tidiness: the
// status bar's control is a real controlled `<select value={String(zoom)}>`,
// so a zoom value the option list does not contain renders as a BLANK select.
// A menu that stepped by, say, 0.1 would therefore silently blank that
// control on the way past 0.9 -- the two surfaces have to agree on the exact
// set of levels, not merely on a range.
export const ZOOM_OPTIONS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '50%', value: 0.5 },
  { label: '75%', value: 0.75 },
  { label: '90%', value: 0.9 },
  { label: '100%', value: 1 },
  { label: '125%', value: 1.25 },
  { label: '150%', value: 1.5 },
  { label: '200%', value: 2 }
]

// What "Actual Size" restores, and EditorScreen's own initial zoom.
export const DEFAULT_ZOOM = 1

// Both steppers CLAMP at the ends rather than wrapping: a Zoom In at 200%
// staying at 200% is what every editor does, and wrapping round to 50% from a
// repeated keypress would be a genuinely surprising jump.
//
// Matching by index rather than by `>` comparison so a zoom value that is
// somehow off-list (an older persisted value, a future free-form control)
// still resolves somewhere sensible -- `findIndex` returning -1 falls through
// to the first/last level rather than to NaN.
export function nextZoomLevel(current: number): number {
  const index = ZOOM_OPTIONS.findIndex((option) => option.value === current)
  if (index === -1) return DEFAULT_ZOOM
  return ZOOM_OPTIONS[Math.min(index + 1, ZOOM_OPTIONS.length - 1)].value
}

export function previousZoomLevel(current: number): number {
  const index = ZOOM_OPTIONS.findIndex((option) => option.value === current)
  if (index === -1) return DEFAULT_ZOOM
  return ZOOM_OPTIONS[Math.max(index - 1, 0)].value
}
