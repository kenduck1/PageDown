import type { PaginationHarness } from '../main/pagination-window'

// Calls `printToPDF` directly on the pagination harness's OWN
// `WebContentsView.webContents` — not a separate hidden `BrowserWindow` — per
// the design doc's third-review correction (see docs/superpowers/specs/
// 2026-07-25-pagedown-design.md, "PDF export (revised)"). This is the exact
// same render context that already produced whatever on-screen Paged.js
// pagination the caller most recently sent via `harness.sendDocument(html)`:
// same webContents, same zoom/device-scale-factor, same stylesheet set, same
// DOM — so there is no second, independently-configured render surface that
// could drift from the first. That's what "closes the export/preview parity
// gap by construction" means concretely: it isn't a claim this module can
// verify on its own (a caller could still call this before ever calling
// sendDocument, or against stale content), only a property of which
// webContents this reaches into.
//
// Option choices, all per the design doc's own PDF-export line item:
// - `preferCSSPageSize: true` — respects Paged.js's computed `@page` box
//   instead of Chromium's own default print page size, so page geometry
//   actually follows what Paged.js laid out on screen.
// - `printBackground: true` — without this, background colors/images in the
//   rendered content are silently dropped from the PDF.
// - `margins: { marginType: 'none' }` — Paged.js already lays out margins as
//   part of its own `@page` box (or its default page-box fallback — see
//   pagination-window.ts's PaginationResult for how this harness currently
//   has no explicit page stylesheet); a second, Chromium-applied print
//   margin on top would double-margin the output.
// - `generateTaggedPDF: true` — Electron/Chromium's experimental tagged-PDF
//   option (see printToPDF's docs). Phase 0 Gate 4
//   (phase0/gate4-export.spec.ts) exists specifically to try this for real
//   and record what the resulting tag tree actually contains, rather than
//   assume either "it works" or "PDFs from this pipeline are unavoidably
//   untagged" — see this project's findings doc for the measured result.
export async function exportToPdf(harness: PaginationHarness): Promise<Buffer> {
  return harness.view.webContents.printToPDF({
    preferCSSPageSize: true,
    printBackground: true,
    margins: { marginType: 'none' },
    generateTaggedPDF: true
  })
}
