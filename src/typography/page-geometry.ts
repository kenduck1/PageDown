//
// Single source of truth for the page-content pixel geometry every
// pagination-related surface needs. Before this module existed, the same
// 816×1056 numbers were hardcoded independently in three files
// (src/main/pagination-window.ts, src/main/index.ts, src/main/pdf-exporter.ts)
// -- they happened to agree, but nothing enforced that. This is the Letter-
// at-96dpi geometry `DEFAULT_PAGE_CONFIG` (src/markdown/page-config.ts)
// already specifies (pageSize: 'Letter', 1in margins) -- NOT a new design
// decision. Page size/margins are not yet interactive (PageSetupModal's own
// settings don't affect layout today -- see its file-level comment), so this
// stays a fixed constant, not a function of the live PageConfig, until that
// separate Page Setup wiring sub-project lands.
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
