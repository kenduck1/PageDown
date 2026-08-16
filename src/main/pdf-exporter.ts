import { dialog, BaseWindow, type BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { markdownToHtml } from '../markdown/pipeline'
import {
  createPaginationHarness,
  registerAssetRoot,
  unregisterAssetRoot,
  type PaginationHarness
} from './pagination-window'
import { exportToPdf } from '../export/export-pdf'
import { resolvePageConfig } from '../markdown/page-config'
import { computePageGeometry, type PageGeometry } from '../typography/page-geometry'
import { resolveDocumentStyle } from '../typography/document-style'

// --- Fix-round finding (verified empirically, not theorized) --------------
//
// The ORIGINAL version of this module memoized a single pagination harness
// across every export call, attached to the real app-shell `mainWindow`
// (the same `win` this module has always been called with) -- and every
// export after the first measured ~12x slower: six consecutive exports of
// the same 60-paragraph document measured 325ms, then
// 3642/4000/4044/3975/4059ms.
//
// The FIRST fix attempted -- a fresh, single-use harness per export instead
// of a memoized one, still attached to `mainWindow` -- did NOT actually fix
// this, contrary to initial expectation. Measured directly: three
// consecutive exports on fresh per-call harnesses still degraded
// (488ms, then 3584ms, then 4392ms) -- statistically indistinguishable from
// the original memoized-harness bug. Two further hypotheses were tested and
// also ruled out the same way (measured, not assumed): giving each export
// its own isolated session/StoragePartition instead of the shared one
// (still degraded: 1467/3431/4310ms), and disabling `generateTaggedPDF`
// (still degraded: 491/3472/4371ms).
//
// The actual cause, isolated via a controlled A/B diagnostic (a throwaway
// script comparing a MEMOIZED harness against a FRESH-per-call harness,
// with both scenarios attached to their own dedicated, never-shown
// `BaseWindow` instead of the real mainWindow): printToPDF timing was FLAT
// in BOTH scenarios once the harness's WebContentsView was attached to a
// dedicated window instead of the real app-shell `mainWindow` -- memoized
// harness: [85, 70, 69]ms; fresh harness: [78, 71, 75]ms. Reusing vs.
// re-creating the harness turned out not to matter at all; what mattered
// was which WINDOW the harness's view was attached to. Repeatedly adding
// and removing a child WebContentsView on `mainWindow` -- the real,
// visible, actively-composited/focused app-shell window -- accumulates
// real overhead across repeated printToPDF calls, even though the view
// itself is positioned off-screen; a dedicated, always-hidden `BaseWindow`
// used for nothing else doesn't have that cost.
//
// The fix taken here: a fresh, dedicated, hidden BaseWindow PER EXPORT
// (destroyed afterward) for the harness -- `mainWindow` (`win`) is now used
// ONLY for `dialog.showSaveDialog`'s modality, never as the harness's
// parent window. Confirmed via tests/gates/gate12-pdf-export-ipc.spec.ts's own
// repeated-export regression test, through the real IPC path end to end
// (not just the raw diagnostic above): three consecutive real exports of a
// 60-paragraph document no longer degrade.
//
// Real, user-visible consequence of the bug this fixes: a ~10-page document
// (250 paragraphs) exported fine in ~2.9s as the FIRST export of a session,
// but failed outright as a LATER export in the same session -- the
// ~12x-slower steady state pushed it past sendDocument's timeout, surfacing
// to the user as a raw "Pagination harness timed out waiting for a result"
// IPC error.
// Exported for print-exporter.ts (src/main/print-exporter.ts), which needs
// the EXACT same dedicated-hidden-window-per-call fix -- printing shares the
// same underlying pagination-harness/printToPDF-adjacent Chromium print
// pipeline, so it is exposed to the identical "harness reused/attached to
// mainWindow degrades ~12x after the first call" bug this function's own
// long comment documents. Duplicating this function instead of exporting it
// would risk the two copies drifting apart on a fix like this one.
export async function withFreshHarness<T>(
  geometry: PageGeometry,
  task: (harness: PaginationHarness) => Promise<T>
): Promise<T> {
  const harnessWindow = new BaseWindow({ show: false })
  try {
    const harness = await createPaginationHarness(harnessWindow)
    // Sized to the DOCUMENT's own real page geometry rather than
    // `createPaginationHarness`'s fixed Letter default (816x1056), so the view
    // stays consistent with the page box it's hosting (Page Geometry Wiring).
    //
    // This is consistency and defence in depth, NOT a correctness requirement
    // — be precise about that, because the tempting stronger claim is false
    // and has already cost this repo a review round. Paged.js's layout does
    // NOT depend on the viewport: the content box is driven by the `@page`
    // rule and Paged.js's own `--pagedjs-margin-*` custom properties, as
    // documented at length in resources/pagination-render/index.ts (see its
    // "What this rule does and does NOT do" note, itself a correction of an
    // earlier wrong claim) and confirmed independently by
    // tests/gates/gate3-mermaid.spec.ts's untouched `expect(sequence.width)
    // .toBe(624)`. The exported PDF follows the same `@page` box, because
    // src/export/export-pdf.ts passes `preferCSSPageSize: true` — not the
    // view bounds. So export would produce correct geometry without this
    // call; it's here so the view never disagrees with the page it hosts.
    //
    // Do NOT read this as a reason to add a matching setBounds to
    // page-count-generator.ts — that file genuinely does not need one, and
    // its harness deliberately never calls setBounds at all (see its
    // getHarness comment on rAF throttling). The one place view bounds really
    // are load-bearing is thumbnail-generator.ts, for a different and real
    // mechanism: capturePage() captures the view's own bounds rectangle, so a
    // Letter-sized view genuinely crops a non-Letter page out of the image.
    harness.view.setBounds({
      x: 0,
      y: 0,
      width: geometry.pageWidthPx,
      height: geometry.pageHeightPx
    })
    return await task(harness)
  } finally {
    // Destroying the dedicated window destroys its owned WebContentsView
    // (and the view's own webContents) with it -- this window has no other
    // purpose and nothing else can reach it, so there's no separate
    // removeChildView/webContents.close() cleanup needed the way there
    // would be for a harness sharing someone else's window.
    try {
      harnessWindow.destroy()
    } catch {
      // Best-effort -- the app may already be quitting mid-export.
    }
  }
}

// Serializes export calls -- NOT because of contention with thumbnail-
// generator.ts's own harness (that's a fully separate instance, per this
// codebase's "don't couple unrelated harness consumers" convention, and the
// two literally cannot race each other), but so that several back-to-back
// "Export PDF" clicks don't spin up multiple full pagination render
// contexts (BaseWindow + WebContentsView + Paged.js evaluation)
// concurrently for no benefit -- only one PDF can be mid-save via one
// native Save dialog at a time anyway, so there's nothing to gain from
// letting exports overlap and real memory/CPU cost to letting them.
// `enqueueExport` (below) is shared with print-exporter.ts on purpose, not
// given a separate queue per export TYPE -- only one native dialog (Save, or
// the OS print dialog) can be open at a time either way, and letting a print
// job and a PDF export spin up dedicated harness windows concurrently would
// cost real memory/CPU for no benefit, exactly like letting two PDF exports
// overlap would.
let exportQueue: Promise<unknown> = Promise.resolve()

export function enqueueExport<T>(task: () => Promise<T>): Promise<T> {
  const result = exportQueue.then(task)
  // Chain the queue's tail through a value- and rejection-swallowing
  // continuation, not `result` directly -- otherwise one rejected export
  // would permanently wedge the queue for every export after it, since a
  // rejected promise used as the next `.then()`'s receiver short-circuits
  // every subsequent `.then()` in the chain. Same fix thumbnail-generator.ts
  // already applies to its own queue.
  exportQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

// Large documents' pagination can approach (though, with the dedicated-
// window fix above, should no longer routinely exceed) sendDocument's own
// 10s general-purpose default -- export gets a longer allowance than that
// default on purpose, the same "give a known-heavier workload more time
// than the routine case" reasoning Gate 7's own spike uses for its
// own 30s poll deadline (see pagination-window.ts's GATE7_POLL_DEADLINE_MS).
const EXPORT_PAGINATION_TIMEOUT_MS = 30_000

// Full end-to-end PDF export: real Save dialog -> markdownToHtml -> send to
// a fresh, single-use pagination harness (its own dedicated, hidden window,
// per the fix above) -> printToPDF via exportToPdf() (src/export/export-pdf.ts,
// unchanged here) -> write the resulting buffer to the chosen path. Returns
// null if the user cancels the Save dialog, matching saveFile()'s own
// null-on-cancel contract in file-io.ts.
//
// The Save dialog runs BEFORE any rendering work, not after: failing fast on
// a cancelled dialog avoids paying for a pagination+printToPDF round trip
// the user has already declined. `win` (the real mainWindow) is used ONLY
// for this dialog's modality -- see withFreshHarness's own comment for why
// the harness itself deliberately does NOT attach to `win`.
//
// No isKnownPath() check is needed here for the SAVE DESTINATION (contrast
// file-io.ts's saveFileToKnownOrChosenPath): that path comes directly from a
// real native dialog.showSaveDialog() result, which is exactly the
// "already vetted" source isKnownPath's own allowlist exists to recognize --
// see CLAUDE.md's File I/O security invariant section. `documentPath` (the
// SOURCE document currently open, used only to resolve local image
// references against its own directory) is a different renderer-supplied
// path with no such built-in vetting, so THAT one is validated by
// `src/main/index.ts`'s `file:exportPdf` handler via `isKnownPath` before it
// ever reaches this function -- same drop-not-throw treatment as
// `file:getPageCount` (see page-count-generator.ts's own `getPageCount` doc
// comment), since exporting never strictly needs the path and dropping it
// just means local images in the exported PDF resolve to nothing, not a
// failed export.
export async function exportDocumentToPdf(
  win: BrowserWindow,
  content: string,
  documentPath?: string,
  allowRemoteImages = false
): Promise<{ filePath: string } | null> {
  const result = await dialog.showSaveDialog(win, {
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    defaultPath: 'document.pdf'
  })
  if (result.canceled || !result.filePath) return null

  const documentDir = documentPath ? dirname(documentPath) : null
  // Computed BEFORE withFreshHarness so it's in scope for that helper's own
  // view-sizing setBounds as well as sendDocument below -- the two have to
  // agree on one geometry, per the comment inside withFreshHarness. Parsed
  // once and reused for `documentStyle` below (Task 5) rather than
  // re-parsing frontmatter a second time.
  const pageConfig = resolvePageConfig(content)
  const geometry = computePageGeometry(pageConfig)
  // The exported PDF has to carry the document's own theme/font and running
  // header/footer content, not just its page geometry -- this is the export
  // parity guarantee (src/export/export-pdf.ts's own header comment) applied
  // to the same PageConfig that already drives `geometry`.
  const documentStyle = resolveDocumentStyle(pageConfig)
  const pdfBuffer = await enqueueExport(() =>
    withFreshHarness(geometry, async (harness) => {
      // Same registerAssetRoot/finally pattern as getThumbnail/getPageCount
      // (see page-count-generator.ts's getPageCount): skipped entirely (not
      // called with a placeholder) when there's no validated document
      // directory, since registerAssetRoot throws on a non-absolute path by
      // design and a document with no known path must load no local assets.
      const assetToken = documentDir ? registerAssetRoot(documentDir) : undefined
      try {
        const { html } = markdownToHtml(content, { assetToken, allowRemoteImages })
        await harness.sendDocument(html, geometry, documentStyle, EXPORT_PAGINATION_TIMEOUT_MS)
        return exportToPdf(harness)
      } finally {
        if (assetToken) unregisterAssetRoot(assetToken)
      }
    })
  )

  await writeFile(result.filePath, pdfBuffer)
  return { filePath: result.filePath }
}
