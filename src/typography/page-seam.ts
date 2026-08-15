// The vertical space a PAGE BOUNDARY occupies in the Format-mode canvas.
//
// The editor canvas used to be one continuous page-WIDTH strip: it carried a
// real page width and real left/right margins, but a fixed 22px/34px of
// cosmetic top/bottom chrome, no page height, and no vertical divisions at
// all. The master design doc opens with "pages are the primary editing unit
// (like Word/Google Docs)", and that was the one part of the premise the
// canvas did not deliver -- a blank document rendered as a short strip rather
// than a sheet of paper.
//
// This module holds the arithmetic for the missing half. It is PURE and
// dependency-free so that it can be unit-tested and, more importantly, so
// that phase0/gate37-page-break-guides.spec.ts can compute the SAME expected
// numbers from the SAME source the app renders from -- the gate asserts real
// measured displacement against a value derived here, never against a
// hardcoded literal it could be fitted to.
//
// WHY NOT IN page-geometry.ts, next to computePageGeometry. That module is
// BUNDLED INTO THE SANDBOXED RENDER CONTEXT (resources/pagination-render/
// imports it), and everything here is editor-only by construction: the
// paginator draws real, separate pages and has no seam to draw. Keeping this
// out of that module keeps the sandbox's dependency surface exactly where it
// is -- the same reasoning that forces page-geometry.ts's own `PageConfig`
// import to stay `import type`.

import type { PageGeometry } from './page-geometry'

/**
 * The visible gutter BETWEEN two sheets, in CSS px -- the canvas showing
 * through where one sheet ends and the next begins.
 *
 * This is the only number here that is a design choice rather than a
 * consequence of the document's own page config. Deliberately smaller than
 * the 32px (`my-8`) the page card already floats above the canvas by: that
 * outer margin separates the document from the app chrome, while this one
 * separates two sheets of the SAME document, and reading it as a bigger break
 * than the document's own edge would be backwards.
 */
export const PAGE_SEAM_GAP_PX = 24

/**
 * The three stacked bands a seam is made of, top to bottom, plus their sum.
 *
 * A page boundary is not a line, it is a REGION, and naming its three parts
 * is what lets the CSS paint it honestly rather than approximate it:
 *
 *   `paperAbovePx`  the rest of the ENDING page's bottom margin -- still
 *                   paper, still part of page N.
 *   `gapPx`         the gutter between the two sheets -- not paper at all.
 *   `paperBelowPx`  the STARTING page's top margin -- paper again, page N+1.
 *
 * Taking these from the document's own margins rather than from a fixed
 * constant is the whole point: a document with 0.5in margins has a visibly
 * tighter page boundary than one with 1in margins, exactly as its printed
 * output does.
 */
export interface PageSeamMetrics {
  paperAbovePx: number
  gapPx: number
  paperBelowPx: number
  /** `paperAbovePx + gapPx + paperBelowPx` -- the seam's full outer height. */
  heightPx: number
}

export function computePageSeamMetrics(geometry: PageGeometry): PageSeamMetrics {
  const paperAbovePx = geometry.marginBottomPx
  const paperBelowPx = geometry.marginTopPx
  return {
    paperAbovePx,
    gapPx: PAGE_SEAM_GAP_PX,
    paperBelowPx,
    heightPx: paperAbovePx + PAGE_SEAM_GAP_PX + paperBelowPx
  }
}

/**
 * How tall the page card must be to read as `seamCount + 1` whole sheets.
 *
 * A `min-height`, never a fixed height: the card still grows with its content
 * whenever content genuinely exceeds this. But it can only ever be REACHED
 * from below, never exceeded, and that is provable rather than hopeful --
 * each page's editor content is at most `contentHeightPx` tall (that is what
 * made it a page break rather than a longer page), so:
 *
 *   natural height = marginTop + SUM(used_k) + seamCount * seamHeight + marginBottom
 *                  <= marginTop + n * contentHeight + seamCount * seamHeight + marginBottom
 *                  == n * pageHeight + seamCount * gap
 *                  == this function's result
 *
 * with n = seamCount + 1. So the min-height always binds and the last sheet
 * is a whole sheet like every other one, instead of ending wherever the text
 * happened to stop -- which was the "short strip" complaint in miniature.
 *
 * `seamCount` is the number of seams ACTUALLY DRAWN, not the number of page
 * breaks the last render recovered. The two differ exactly when the guides
 * fail closed (a stale block count, see page-guide-plugin.ts's own guards),
 * and in that case this must fall back with them -- a card sized for five
 * sheets with no seams drawn in it would be a blank half-page of nothing at
 * the bottom, i.e. the wrong-layout-with-no-explanation failure the whole
 * fail-closed posture exists to avoid.
 */
export function computePageCardMinHeightPx(geometry: PageGeometry, seamCount: number): number {
  const sheets = Math.max(0, Math.floor(seamCount)) + 1
  return sheets * geometry.pageHeightPx + (sheets - 1) * PAGE_SEAM_GAP_PX
}

/**
 * The CSS custom properties the seam rule in base.css reads, and which
 * MilkdownEditor's mount div publishes from the live `PageGeometry`.
 *
 * Declared here, as a pair with the values that fill them, for the same
 * reason `BLOCK_INDEX_ATTRIBUTE`/`BLOCK_INDEX_HAST_PROPERTY` are declared
 * together in page-breaks.ts: the contract spans a `.ts` file and a `.css`
 * file, and CSS cannot import a constant, so the only alternatives are one
 * shared symbol plus a test that checks the stylesheet really uses it (this),
 * or a comment in one file asking a reader to trust a string in another. An
 * unresolved `var()` in CSS is silently invalid-at-computed-value-time -- the
 * exact failure mode that once made `h5`/`h6` render at the wrong size on one
 * surface only -- so page-seam.test.ts pins every name below against
 * base.css's real text.
 */
export const PAGE_SEAM_CSS_VARIABLES = {
  paperAbove: '--pagedown-seam-paper-above',
  gap: '--pagedown-seam-gap',
  paperBelow: '--pagedown-seam-paper-below',
  /** Left/right bleed: how far the seam must escape the mount to reach the sheet's own edges. */
  bleedLeft: '--pagedown-seam-bleed-left',
  bleedRight: '--pagedown-seam-bleed-right'
} as const

/**
 * Those variables, filled in for one document, ready to spread into a React
 * `style` prop.
 *
 * THE BLEED VALUES ARE THE DOCUMENT'S OWN SIDE MARGINS, and that is not a
 * coincidence to be simplified away. The seam is a descendant of the Milkdown
 * mount, whose content box is exactly `contentWidthPx` wide and centred in a
 * card whose horizontal padding is exactly the two side margins. So pulling
 * the seam out by `marginLeftPx` on the left and `marginRightPx` on the right
 * lands its edges exactly on the sheet's edges:
 *
 *   contentWidthPx + marginLeftPx + marginRightPx === pageWidthPx
 *
 * which is `computePageGeometry`'s own defining identity, the same one Gate 10
 * depends on. A seam that stopped at the text column would read as a rule
 * drawn ON the page rather than as the end of the sheet.
 */
export function pageSeamCssVariables(geometry: PageGeometry): Record<string, string> {
  const metrics = computePageSeamMetrics(geometry)
  return {
    [PAGE_SEAM_CSS_VARIABLES.paperAbove]: `${metrics.paperAbovePx}px`,
    [PAGE_SEAM_CSS_VARIABLES.gap]: `${metrics.gapPx}px`,
    [PAGE_SEAM_CSS_VARIABLES.paperBelow]: `${metrics.paperBelowPx}px`,
    [PAGE_SEAM_CSS_VARIABLES.bleedLeft]: `${geometry.marginLeftPx}px`,
    [PAGE_SEAM_CSS_VARIABLES.bleedRight]: `${geometry.marginRightPx}px`
  }
}
