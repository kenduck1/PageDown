// Running headers and footers, positioned for the FORMAT-MODE CANVAS.
//
// WHY THIS EXISTS AT ALL
//
// A document's running header/footer is real, printing content: it appears in
// the paginated preview, the exported PDF, the printed page, and HTML/DOCX
// export. On every one of those surfaces it is produced by
// `buildRunningContentCss` (document-style.ts) as CSS `@top-*`/`@bottom-*`
// MARGIN BOXES, which only exist inside a real paged context.
//
// The editor canvas has no paged context -- it is one continuous card with
// seams drawn between sheets -- so it rendered no header or footer at all.
// That is the same class of divergence as the frontmatter box
// (milkdown/nodes/frontmatter.ts): a page-first editor showing pages that are
// missing something the printed page has. This module is the canvas's own
// answer, computing where each band belongs from the SAME `PageGeometry` and
// `DocumentStyle` every other surface already reads.
//
// WHY NOT REUSE buildRunningContentCss
//
// It emits `counter(page)` / `counter(pages)`, which resolve only in a real
// paged context. The canvas knows its page numbers concretely (from the seam
// count), so it substitutes real numbers here instead. Both paths read the
// same `{n}`/`{total}` tokens out of the same `DocumentStyle`, so a document
// cannot show one thing in the editor and another in the PDF.
//
// WHY NOT IN page-geometry.ts
//
// Same reason as page-seam.ts, and it matters: that module is bundled into the
// sandboxed render context, and everything here is editor-only by
// construction. Keeping it out leaves the sandbox's dependency surface exactly
// where it is.

import type { PageGeometry } from './page-geometry'
import type { DocumentStyle } from './document-style'
import type { PageNumberFormat, PageRunningContent } from '../markdown/page-config'
import { PAGE_SEAM_GAP_PX } from './page-seam'

/**
 * One header or footer band, already positioned within the page card.
 *
 * `topPx` is measured from the top of the card's padding box, which is what
 * an absolutely-positioned child of the card is offset against.
 */
export interface EditorRunningBand {
  /** 1-based page this band belongs to. */
  pageNumber: number
  band: 'header' | 'footer'
  topPx: number
  heightPx: number
  leftPx: number
  widthPx: number
  /** Already token-substituted, ready to render as text. */
  left: string
  center: string
  right: string
}

// Largest value the converter below is exercised over. Page counts are bounded
// in practice by the margin clamp in computePageGeometry (which exists to stop
// a frontmatter typo producing an effectively infinite document), so this is a
// backstop for absurd input rather than a real limit anyone reaches.
const ROMAN_NUMERALS: readonly (readonly [number, string])[] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i']
]

/**
 * Lower-case roman numerals, matching CSS `counter(page, lower-roman)`.
 *
 * CSS does this natively on the paginated surface; the canvas has to do it in
 * JS, and the two must agree or a `pageNumberFormat: roman` document would
 * number its pages differently in the editor than in the PDF.
 *
 * Zero and negatives fall back to the decimal rendering, exactly as the CSS
 * `lower-roman` counter style does (it is defined only for positive integers
 * and falls back to `decimal` outside that range).
 */
export function toLowerRoman(value: number): string {
  if (!Number.isFinite(value) || value < 1) return String(value)
  let remaining = Math.floor(value)
  let out = ''
  for (const [amount, numeral] of ROMAN_NUMERALS) {
    while (remaining >= amount) {
      out += numeral
      remaining -= amount
    }
  }
  return out
}

function formatPageNumber(value: number, format: PageNumberFormat): string {
  return format === 'roman' ? toLowerRoman(value) : String(value)
}

// Deliberately the same two tokens buildContentValue substitutes, matched the
// same way. If one side ever learns a third token the other must too, or the
// editor and the PDF would disagree about what a document says.
const TOKEN_PATTERN = /(\{n\}|\{total\})/g

/**
 * Substitutes `{n}` / `{total}` with real page numbers.
 *
 * No escaping happens here, and that is correct rather than an omission: this
 * result is assigned to a DOM node's `textContent` (via React's own text
 * interpolation), never interpolated into CSS or HTML source. The CSS-escaping
 * in document-style.ts exists because that path builds a CSS string literal;
 * this path has no such syntax to break out of.
 */
export function resolveRunningContentText(
  text: string,
  pageNumber: number,
  totalPages: number,
  format: PageNumberFormat
): string {
  return text.replace(TOKEN_PATTERN, (token) =>
    token === '{n}' ? formatPageNumber(pageNumber, format) : formatPageNumber(totalPages, format)
  )
}

function bandFor(
  band: 'header' | 'footer',
  content: PageRunningContent,
  pageNumber: number,
  totalPages: number,
  format: PageNumberFormat,
  geometry: PageGeometry,
  pageTopPx: number
): EditorRunningBand | null {
  const left = resolveRunningContentText(content.left, pageNumber, totalPages, format)
  const center = resolveRunningContentText(content.center, pageNumber, totalPages, format)
  const right = resolveRunningContentText(content.right, pageNumber, totalPages, format)
  // Nothing on any side means no band, mirroring buildBand's own "emit
  // nothing for an empty side" rule -- an empty band would still be a real
  // element the user could see the effect of (and, more subtly, would make
  // the DOM claim a header exists where the PDF has none).
  if (left === '' && center === '' && right === '') return null
  return {
    pageNumber,
    band,
    topPx:
      band === 'header' ? pageTopPx : pageTopPx + geometry.pageHeightPx - geometry.marginBottomPx,
    heightPx: band === 'header' ? geometry.marginTopPx : geometry.marginBottomPx,
    // Aligned to the CONTENT column, not the sheet edge: Paged.js's margin
    // boxes sit in the page grid's content track, so a header lines up with
    // the body text beneath it rather than with the paper's edge.
    leftPx: geometry.marginLeftPx,
    widthPx: geometry.contentWidthPx,
    left,
    center,
    right
  }
}

/**
 * The two bands the CARD can position by geometry alone: the first page's
 * header and the last page's footer.
 *
 * EVERY OTHER BAND IS DRAWN BY THE SEAM, NOT HERE, and the reason is measured
 * rather than stylistic. A seam is placed after the BLOCK that ends its page,
 * so it lands wherever that block happens to end -- at or slightly above the
 * geometric page boundary, never below it. That shortfall accumulates: probed
 * in the real app on a 3-page document, seam 1's gutter sat 1.7px above its
 * geometric position and seam 2's sat 3.4px above. The underfill is bounded by
 * a line height per page, so on a long document a geometrically-positioned
 * header would drift visibly below the top of the sheet it belongs to.
 *
 * These two are exempt because both are pinned to an edge that IS geometric:
 * page one begins at the card's own top, and the last page ends at the card's
 * own bottom (`computePageCardMinHeightPx` proves that min-height always
 * binds, so the card is exactly `pages * pageHeight + (pages - 1) * gap`
 * tall). Nothing between them is.
 *
 * Returns an empty array when the document has neither a header nor a footer,
 * which is the common case and costs no DOM at all.
 */
export function computeEditorRunningBands(
  geometry: PageGeometry,
  style: DocumentStyle,
  pageCount: number
): EditorRunningBand[] {
  if (!style.header && !style.footer) return []
  const pages = Math.max(1, Math.floor(pageCount))
  const pitch = geometry.pageHeightPx + PAGE_SEAM_GAP_PX
  const bands: EditorRunningBand[] = []
  if (style.header) {
    const first = bandFor('header', style.header, 1, pages, style.pageNumberFormat, geometry, 0)
    if (first) bands.push(first)
  }
  if (style.footer) {
    const last = bandFor(
      'footer',
      style.footer,
      pages,
      pages,
      style.pageNumberFormat,
      geometry,
      (pages - 1) * pitch
    )
    if (last) bands.push(last)
  }
  return bands
}

/**
 * The header/footer pair a SEAM draws: the footer of the page ending at it,
 * and the header of the page starting after it.
 *
 * Text only -- the seam's own CSS positions these into the two paper bands it
 * already computes from the document's margins, so no geometry crosses this
 * boundary.
 */
export interface SeamRunningContent {
  footer: { left: string; center: string; right: string } | null
  header: { left: string; center: string; right: string } | null
}

export function computeSeamRunningContent(
  style: DocumentStyle,
  endingPage: number,
  totalPages: number
): SeamRunningContent {
  const resolve = (
    content: PageRunningContent | null,
    pageNumber: number
  ): { left: string; center: string; right: string } | null => {
    if (!content) return null
    const left = resolveRunningContentText(
      content.left,
      pageNumber,
      totalPages,
      style.pageNumberFormat
    )
    const center = resolveRunningContentText(
      content.center,
      pageNumber,
      totalPages,
      style.pageNumberFormat
    )
    const right = resolveRunningContentText(
      content.right,
      pageNumber,
      totalPages,
      style.pageNumberFormat
    )
    if (left === '' && center === '' && right === '') return null
    return { left, center, right }
  }
  return {
    footer: resolve(style.footer, endingPage),
    header: resolve(style.header, endingPage + 1)
  }
}
