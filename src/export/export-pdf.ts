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
//   part of its own `@page` box; a second, Chromium-applied print margin on
//   top would double-margin the output. (This used to add "or its default
//   page-box fallback — see pagination-window.ts's PaginationResult for how
//   this harness currently has no explicit page stylesheet". Both halves are
//   now stale: the render context authors a real `@page` rule of its own
//   since the Document Typography sub-project — see `buildDocumentStylesheet` in
//   resources/pagination-render/index.ts — and `PaginationResult` never
//   carried a note about stylesheets to point at in the first place.)
// - `generateTaggedPDF: true` — Electron/Chromium's experimental tagged-PDF
//   option (see printToPDF's docs). Phase 0 Gate 4
//   (tests/gates/gate4-export.spec.ts) exists specifically to try this for real
//   and record what the resulting tag tree actually contains, rather than
//   assume either "it works" or "PDFs from this pipeline are unavoidably
//   untagged" — see this project's findings doc for the measured result.
export async function exportToPdf(harness: PaginationHarness): Promise<Buffer> {
  return harness.view.webContents.printToPDF({
    preferCSSPageSize: true,
    printBackground: true,
    // Electron 43 replaced the `marginType: 'default'|'none'|...` enum with a
    // plain per-side margin object measured in INCHES, and its default is
    // ~0.4in on every side rather than zero. So this cannot be omitted: doing
    // so would silently inset every exported page by 0.4in on top of the
    // document's own margins, shrinking the content box and moving page
    // breaks -- a change that looks like a pagination bug rather than a
    // dependency upgrade.
    //
    // Explicit zeros are the exact equivalent of the old `marginType: 'none'`,
    // and being zeros they are unit-independent, so the inches-vs-pixels
    // change between versions cannot bite. `preferCSSPageSize: true` above
    // means the document's own @page rule is what actually establishes the
    // page box; these margins only have to add nothing to it.
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    generateTaggedPDF: true
  })
}
