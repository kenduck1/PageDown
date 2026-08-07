//
// Single source of truth for the page-content pixel geometry every
// pagination-related surface needs. Before this module existed, the same
// 816×1056 numbers were hardcoded independently in three files
// (src/main/pagination-window.ts, src/main/index.ts, src/main/pdf-exporter.ts)
// -- they happened to agree, but nothing enforced that. This is the Letter-
// at-96dpi geometry `DEFAULT_PAGE_CONFIG` (src/markdown/page-config.ts)
// already specifies (pageSize: 'Letter', 1in margins) -- NOT a new design
// decision. `computePageGeometry` below is now the real per-document path,
// turning a live PageConfig into real per-document geometry (Page Geometry
// Wiring sub-project); the constants below remain the fixed Letter/
// portrait/1in defaults, used by Gate 10's fixture and any other caller not
// yet migrated onto computePageGeometry.
//
// 96 = the standard CSS reference pixel density (96px per inch), the same
// value Chromium/Paged.js use internally and the value implied by every
// existing `816`/`1056` literal this module replaces (8.5in and 11in at
// 96dpi).
//
// Exported, not module-private: the pagination render context
// (resources/pagination-render/index.ts) builds an `@page` rule in inches
// (@page's native unit) and therefore has to divide these pixel constants
// back out by the same density. It used to hardcode its own `/ 96` there,
// which is exactly the kind of independently-restated magic number this
// module exists to eliminate -- so the constant itself is part of the
// module's public surface, not just the values derived from it.
export const DPI = 96

export const PAGE_WIDTH_PX = 8.5 * DPI // 816
export const PAGE_HEIGHT_PX = 11 * DPI // 1056
export const PAGE_MARGIN_PX = 1 * DPI // 96 (DEFAULT_PAGE_CONFIG's 1in margin, each side)
export const CONTENT_WIDTH_PX = PAGE_WIDTH_PX - PAGE_MARGIN_PX * 2 // 624

// Type-only: this module is bundled into the sandboxed pagination render
// context (resources/pagination-render/index.ts imports from it), and a
// runtime import of page-config.ts would drag the `yaml` package into that
// sandboxed bundle for no reason -- PageConfig is only ever needed here as
// a type.
import type { PageConfig } from '../markdown/page-config'

export interface PageGeometry {
  pageWidthPx: number
  pageHeightPx: number
  marginTopPx: number
  marginBottomPx: number
  marginLeftPx: number
  marginRightPx: number
  contentWidthPx: number
  contentHeightPx: number
}

// Real, standard sheet dimensions at 96dpi -- NOT the same numbers CSS's
// own printed-page defaults use (those round to whole mm/in in a way that
// drifts slightly from a pure unit conversion). Pinned here as the one
// source computePageGeometry uses, so a future direct consumer can't
// silently diverge the way this file's own header comment already warns
// about for the DPI constant.
const PAGE_SIZES_IN: Record<'Letter' | 'A4' | 'Legal', { width: number; height: number }> = {
  Letter: { width: 8.5, height: 11 },
  A4: { width: 8.2677, height: 11.6929 }, // 210mm x 297mm
  Legal: { width: 8.5, height: 14 }
}

// 'Custom' falls back to 'Letter' -- no customWidth/customHeight fields
// exist on PageConfig (deliberately out of scope), the same non-blocking-
// fallback treatment this codebase already gives malformed or missing
// frontmatter elsewhere.
export function computePageGeometry(config: PageConfig): PageGeometry {
  const size = config.pageSize === 'Custom' ? 'Letter' : config.pageSize
  const { width, height } = PAGE_SIZES_IN[size]
  const [wIn, hIn] = config.orientation === 'landscape' ? [height, width] : [width, height]
  const pageWidthPx = Math.round(wIn * DPI)
  const pageHeightPx = Math.round(hIn * DPI)
  const marginTopPx = Math.round(config.margins.top * DPI)
  const marginBottomPx = Math.round(config.margins.bottom * DPI)
  const marginLeftPx = Math.round(config.margins.left * DPI)
  const marginRightPx = Math.round(config.margins.right * DPI)
  return {
    pageWidthPx,
    pageHeightPx,
    marginTopPx,
    marginBottomPx,
    marginLeftPx,
    marginRightPx,
    contentWidthPx: pageWidthPx - marginLeftPx - marginRightPx,
    contentHeightPx: pageHeightPx - marginTopPx - marginBottomPx
  }
}
