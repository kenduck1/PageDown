// Fit-to-width scaling for BOTH of Split mode's panes: how much to shrink a
// fixed-width page so it fits the pane it is sitting in, and where to stop
// shrinking.
//
// Pure arithmetic, in its own module for the same reason floating-position.ts
// is: the interesting decision here is the FLOOR, and a floor that only exists
// inside a React component's render path is a floor that cannot be
// unit-tested. fit-scale.test.ts exercises every branch below, including the
// two the real app reaches least often (a pane wider than the page, and a pane
// so narrow the floor binds).
//
// TWO CONSUMERS, and the second one constrains this file. The editor pane
// (EditorScreen.tsx) was first; the paginated PREVIEW pane calls this too,
// from inside the sandboxed render context
// (resources/pagination-render/index.ts's applyPreviewFitScale). That means
// THIS MODULE IS BUNDLED INTO THE SANDBOX and must stay dependency-free --
// the same contract src/pagination/page-nav.ts and src/typography/
// page-geometry.ts already carry, and for the same reason: a runtime import
// here would drag its dependencies into the one context that deliberately
// runs untrusted document HTML. Keep this file pure arithmetic. (Its home
// under src/renderer/src/lib is now arguably wrong -- src/typography/, beside
// page-geometry.ts and split-preview-bounds.ts, is where the other shared
// pure layout helpers live -- but a move would buy tidiness, not behaviour.)
//
// Sharing it is not merely convenient. The two panes sit side by side at the
// same divider position, showing the same document at the same 14px baseline;
// a second copy of the floor would mean one pane staying legible while the
// other went small, at a boundary neither of them could explain.
//
// WHY THIS EXISTS AT ALL. EditorScreen's page card is a FIXED `width`, never a
// `max-width` -- see that file's own long comment for why (a max-width silently
// reflows the document's real layout width, which is precisely what Gate 10's
// 0.000px editor/paginator parity forbids). In the single-pane branch that
// fixed width is fine, because the zoom wrapper + `overflow-auto` let the user
// pick a scale. Split mode had neither: the two-pane row renders outside the
// zoom wrapper (the right pane is a native WebContentsView whose bounds come
// from a DOM rect a CSS scale would silently desync), and the zoom control is
// deliberately disabled there. So an 816px Letter page sat in a ~389px pane at
// the app's own default window and the user horizontally scrolled their own
// document to read it. Scaling is the only fix that keeps the card's real
// layout width intact.

/**
 * The smallest scale fit-to-width will ever apply. Below this the page is left
 * at the floor and the pane scrolls horizontally instead.
 *
 * WHY 0.7, and why it is deliberately NOT `ZOOM_OPTIONS`' own 0.5 minimum:
 *
 * 1. BELOW THE FLOOR THE PANE SCROLLS ANYWAY -- that is what "floor" means
 *    here. So in the sub-floor regime, shrinking further trades legibility for
 *    *less* scrolling while still scrolling: the worst of both. Once scrolling
 *    is unavoidable the only thing left worth optimising is whether the text
 *    can be read, which argues for a HIGH floor, not a low one. (This is the
 *    reasoning that flipped an earlier draft, which had picked 0.4 so that the
 *    default 50/50 split would fit exactly.)
 * 2. `document-typography.css` pins body text at 14px on both surfaces, so 0.7
 *    renders it at 9.8px -- the smallest size at which continuous body text
 *    stays comfortably readable on a desktop display at 100% OS scaling. The
 *    app cannot lean on a 2x display to rescue a smaller value: it pins fonts
 *    and metrics precisely (see the `--font-mono`/Mermaid-font findings) so
 *    that layout is deterministic across machines, and a floor that is only
 *    legible on Retina would undercut exactly that.
 * 3. The asymmetry with the manual 50% zoom level is the point, not an
 *    inconsistency. 50% is something a user picks ON PURPOSE, momentarily, to
 *    see a whole page; fit-to-width is something the app does TO them on every
 *    single entry into Split mode. An automatic path must not silently render
 *    someone's document at a size they would never have chosen.
 *
 * Measured consequences at the app's own default 1000x840 window (canvas
 * 784px wide beside the 216px sidebar rail), Letter/1in:
 *
 *   divider 25%  pane 193px  fit needs 0.237 -> floor 0.70, page 571px, scrolls
 *   divider 50%  pane 389px  fit needs 0.477 -> floor 0.70, page 571px, scrolls
 *   divider 75%  pane 585px  fit needs 0.712 -> 0.71 applied, page 579px, FITS
 *
 * i.e. the page genuinely stops overflowing once the editor pane is given
 * roughly three quarters of the canvas, and everywhere narrower it renders
 * 30% smaller than before with correspondingly less horizontal scrolling.
 *
 * The PREVIEW pane's numbers are the mirror image, since the divider splits
 * one row: it fits once the divider gives the PREVIEW about three quarters,
 * and at the default 50/50 it is at the floor showing ~68% of the page rather
 * than the ~48% it showed before being fitted at all. That is the honest cost
 * of the floor on this side, and it is the right trade for the same reason:
 * an exact fit at 389px would render body text at 14 x 0.47 = 6.6px, a page
 * you can see the shape of and cannot read.
 */
export const MIN_FIT_SCALE = 0.7

/**
 * Breathing room subtracted from the pane's available width before fitting, so
 * a page that exactly fits is not flush against both pane edges with its
 * `shadow-page` clipped on each side.
 *
 * Deliberately tiny. It is subtracted from a width the caller has already
 * taken from `clientWidth` (the content box, i.e. scrollbar already excluded),
 * so it is pure aesthetics rather than a scrollbar reserve -- see
 * `computeFitScale`'s own note on why the caller must pass a content-box width
 * and not a border-box one.
 */
export const FIT_GUTTER_PX = 4

/**
 * Fit scales are quantised DOWN to whole percentage points.
 *
 * Two reasons, both real. (1) The Split divider is draggable, so without this
 * every mousemove frame would write a new, marginally different `zoom` onto a
 * wrapper containing the whole ProseMirror document -- a full subtree relayout
 * per frame for a difference nobody can see. Whole percents cut that to at
 * most ~30 distinct values across a full-width drag. (2) The status bar
 * renders this number as a percentage, and a readout flickering through
 * 71.6842% is not a readout.
 *
 * DOWN, never nearest: rounding up would produce a scale whose rendered page
 * is fractionally WIDER than the pane it was computed to fit into, which is
 * the one outcome this whole function exists to prevent.
 */
const FIT_SCALE_STEPS_PER_UNIT = 100

/**
 * Absorbs binary-floating-point representation error before the floor above.
 * Not defensive padding: `0.71 * 100` is `70.99999999999999`, so a plain
 * `Math.floor` would quantise an exactly-representable-looking 71% down to
 * 70% -- a whole step lost for free, on every value that happens to land on a
 * step boundary. Same family of finding as `pickCurrentPage`'s
 * divide-don't-reciprocal-multiply note in src/pagination/page-nav.ts.
 */
const FIT_SCALE_EPSILON = 1e-9

/**
 * The scale to render a `pageWidthPx`-wide page card at inside a pane whose
 * content box is `paneWidthPx` wide.
 *
 * `paneWidthPx` MUST be a content-box width (`clientWidth`), not a border-box
 * one: a border-box width still contains the vertical scrollbar's track on
 * platforms with classic (non-overlay) scrollbars, so fitting against it would
 * overflow by the scrollbar's width on Windows/Linux and be silently correct
 * on macOS -- the exact shape of bug that only shows up on someone else's
 * machine. EditorScreen additionally sets `scrollbar-gutter: stable` on that
 * pane so `clientWidth` does not itself depend on whether the scrollbar is
 * currently showing, which would otherwise be a genuine feedback loop
 * (narrower scale -> shorter content -> no scrollbar -> wider pane -> larger
 * scale -> taller content -> scrollbar back).
 *
 * Never returns more than 1. Enlarging a page to fill a very wide pane is a
 * zoom decision and belongs to the user's own zoom control, not to a function
 * whose job is stopping content from overflowing; auto-enlarging would also
 * make Split render text at a size the Format canvas never would.
 *
 * Returns 1 for any non-positive or non-finite input -- the first paint before
 * the pane has been measured passes `0` here, and rendering the document at
 * scale 0 (invisible) or NaN (Chromium falls back to 1 anyway, but silently)
 * is strictly worse than one frame at full size.
 */
export function computeFitScale(paneWidthPx: number, pageWidthPx: number): number {
  if (!Number.isFinite(paneWidthPx) || !Number.isFinite(pageWidthPx)) return 1
  if (!(paneWidthPx > 0) || !(pageWidthPx > 0)) return 1

  const available = paneWidthPx - FIT_GUTTER_PX
  if (available >= pageWidthPx) return 1

  const raw = available / pageWidthPx
  // Quantise before clamping, not after: clamping first and then flooring
  // would drag a scale that had just been raised to the floor back BELOW it
  // (0.7 floors to 0.7 here only because 0.7 happens to be a whole percent --
  // relying on that would be a trap for whoever next changes MIN_FIT_SCALE).
  const stepped =
    Math.floor(raw * FIT_SCALE_STEPS_PER_UNIT + FIT_SCALE_EPSILON) / FIT_SCALE_STEPS_PER_UNIT
  return Math.min(1, Math.max(MIN_FIT_SCALE, stepped))
}
