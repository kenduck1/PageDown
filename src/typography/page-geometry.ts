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

// Type-only, and it MUST stay that way: this module is bundled into the
// sandboxed pagination render context (resources/pagination-render/index.ts
// imports DPI and this file's PageGeometry type from it), so a RUNTIME
// import of page-config.ts would pull that module's own runtime dependencies
// into the sandbox bundle with it -- `unified`, `remark-parse` and
// `remark-frontmatter`, by way of src/markdown/frontmatter-splice.ts.
// Checked against the real built bundle, not assumed: out/pagination-render/
// index.js contains zero occurrences of `remark-frontmatter` or `micromark`.
//
// Do NOT test this invariant by grepping the bundle for `js-yaml`, which
// page-config.ts also imports: js-yaml is ALREADY in that bundle, pulled in
// transitively by mermaid@11.4.1 for its own diagram frontmatter, so it is
// present whether or not this import is type-only.
//
// The tempting change that would silently break this is importing a VALUE
// for a default parameter (`import { DEFAULT_PAGE_CONFIG }`) -- it compiles,
// passes every test, and shows up only as a bigger bundle.
//
// PageConfig is only ever needed here as a type.
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

// The minimum content extent this function will leave on either axis, in px
// (1in). See `clampMarginPair` below for why a floor exists at all.
const MIN_CONTENT_PX = DPI

// Safety clamp, NOT input validation -- the distinction matters for where
// this lives and what it is allowed to do. It silently produces a
// *renderable* page from a margin pair that would otherwise leave no room to
// render into; it does not reject, warn, or tell the user anything. Real
// validation in Page Setup (min/max on the margin inputs, an inline "margins
// exceed the page" message) is still worth doing separately, and would be the
// thing that makes this clamp unreachable from the UI -- it can never make it
// unreachable from a `.md` file, which is the point below.
//
// WHY HERE, and not in PageSetupModal. Two reasons:
//   1. All five surfaces that lay a document out (the Milkdown page card, the
//      sandboxed pagination preview, the page count, the thumbnail, PDF
//      export) route through this one pure function, so one guard here covers
//      every one of them -- whereas a fix in the modal would cover exactly
//      one entry point.
//   2. Margins are read from a document's own YAML frontmatter, which is
//      hand-editable (and, in this project's threat model, attacker-
//      controllable -- a `.md` file is untrusted input). `min`/`max`
//      attributes on the modal's inputs cannot constrain a value that never
//      passes through the modal at all.
//
// WHAT IT PREVENTS, concretely. `PageSetupModal`'s margin inputs are
// `<input type="number" step="0.05">` with no min/max and a
// `parseFloat(...) || 0`, and `parseMargins` (src/markdown/page-config.ts)
// accepts any finite number per side -- so a plausible typo (`6` for `0.6`,
// top and bottom, on Letter) yields a content height of
// 1056 - 576 - 576 = -96px, which was previously interpolated straight into
// the sandboxed `@page` rule and the editor's CSS. Verified against the
// pinned pagedjs@0.4.3 rather than assumed: that does NOT hang (`Chunker.
// layout` has a real "Layout repeated" break-token guard), but at zero
// available height `findBreakToken` returns early without calling
// `removeOverflow`, so Paged.js emits roughly one page per top-level source
// node WITH THE FULL DOCUMENT DUPLICATED ON EVERY PAGE -- thousands of pages
// for a real document, indistinguishable from a hang to a user, and well past
// `sendDocument`'s 10s deadline.
//
// Only margins need this. `pageWidthPx`/`pageHeightPx` come from a 3-entry
// allowlist lookup, so hostile frontmatter cannot reach `setBounds` (or the
// `@page` rule) with an absurd extent, and a JS number cannot inject CSS
// syntax; margins are the one free-form path.
//
// Scaling BOTH sides proportionally rather than truncating one preserves the
// asymmetry the user asked for (a 1:3 top:bottom ratio stays 1:3), which is
// the closest renderable answer to what was actually requested. The second
// side is derived as `maxTotal - <rounded first>` rather than rounded
// independently, so the pair sums to exactly `maxTotal` and the content
// extent lands exactly on the floor instead of a pixel either side of it.
// A both-zero pair is left alone by the early return (0 <= maxTotal always).
function clampMarginPair(startPx: number, endPx: number, extentPx: number): [number, number] {
  const maxTotal = Math.max(0, extentPx - MIN_CONTENT_PX)
  const total = startPx + endPx
  if (total <= maxTotal) return [Math.round(startPx), Math.round(endPx)]
  const scaled = Math.round((startPx / total) * maxTotal)
  return [scaled, maxTotal - scaled]
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
  // A negative margin is reachable too (parseMargins accepts any finite
  // number), and would inflate the content box past the page rather than
  // collapse it -- floored to 0 before the pair clamp, which assumes
  // non-negative inputs when it scales by ratio.
  const [marginTopPx, marginBottomPx] = clampMarginPair(
    Math.max(0, config.margins.top) * DPI,
    Math.max(0, config.margins.bottom) * DPI,
    pageHeightPx
  )
  const [marginLeftPx, marginRightPx] = clampMarginPair(
    Math.max(0, config.margins.left) * DPI,
    Math.max(0, config.margins.right) * DPI,
    pageWidthPx
  )
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
