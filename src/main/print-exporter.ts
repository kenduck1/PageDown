import { markdownToHtml } from '../markdown/pipeline'
import { registerAssetRoot, unregisterAssetRoot, type PaginationHarness } from './pagination-window'
import { resolvePageConfig } from '../markdown/page-config'
import { computePageGeometry } from '../typography/page-geometry'
import { resolveDocumentStyle } from '../typography/document-style'
import { withFreshHarness, enqueueExport } from './pdf-exporter'
import { dirname } from 'node:path'

// Same 30s allowance as PDF export's own EXPORT_PAGINATION_TIMEOUT_MS --
// printing paginates through the identical harness/sendDocument path, so a
// large document needs the same longer-than-routine budget.
const PRINT_PAGINATION_TIMEOUT_MS = 30_000

// Electron's own documented failureReason string for a user-cancelled print
// dialog (electron.d.ts's own doc comment on WebContents.print: "Some
// possible failureReasons for print failure include: ... 'Print job
// canceled' ..."). Note the single-L American spelling -- Electron's own
// string, not a typo to "fix" here. A cancelled dialog is not a failure from
// this app's own perspective (the user declined, same as PDF export's own
// dialog.showSaveDialog `canceled` branch returning null rather than
// throwing), so this string is checked explicitly to route it there instead
// of surfacing as an error.
const PRINT_CANCELLED_REASON = 'Print job canceled'

function printWebContents(harness: PaginationHarness): Promise<{ cancelled: boolean }> {
  return new Promise((resolve, reject) => {
    harness.view.webContents.print(
      {
        silent: false,
        printBackground: true,
        // Explicit rather than relying on Electron's own default (also
        // `true`) -- a document's colors (link/heading accents, table
        // borders, a themed background) should print as authored unless the
        // user's own OS print dialog overrides it, not silently downgrade to
        // grayscale by omission.
        color: true
        // No print()-specific "prefer CSS page size" option exists (checked
        // Electron's own WebContentsPrintOptions type directly -- there
        // isn't one, unlike printToPDF's preferCSSPageSize). Nothing to opt
        // into: Chromium's print pipeline already respects a real @page CSS
        // rule for page size by default, confirmed by the same
        // buildDocumentStylesheet-authored @page rule this harness's own
        // sendDocument call always sends (resources/pagination-render/
        // index.ts's own "What this rule does and does NOT do" note).
      },
      (success, failureReason) => {
        if (success) {
          resolve({ cancelled: false })
          return
        }
        if (failureReason === PRINT_CANCELLED_REASON) {
          resolve({ cancelled: true })
          return
        }
        reject(new Error(`Print failed: ${failureReason}`))
      }
    )
  })
}

// Full end-to-end native print: markdownToHtml -> send to a fresh, single-use
// pagination harness (exact same dedicated-hidden-window-per-call fix PDF
// export uses, see withFreshHarness's own long comment in pdf-exporter.ts
// for the ~12x-slower-after-first-call bug this avoids) -> the real OS print
// dialog via webContents.print(). Deliberately has NO save-destination
// dialog of its own (unlike exportDocumentToPdf) -- printing has no file to
// choose, only a printer, which the OS dialog itself handles -- and
// deliberately takes no `win` parameter for that same reason: unlike
// dialog.showSaveDialog, webContents.print()'s own OS dialog needs no parent
// window for modality, and this codebase avoids unused parameters kept only
// for hypothetical future symmetry.
export async function printDocument(
  content: string,
  documentPath?: string,
  allowRemoteImages = false
): Promise<{ cancelled: boolean }> {
  const documentDir = documentPath ? dirname(documentPath) : null
  const pageConfig = resolvePageConfig(content)
  const geometry = computePageGeometry(pageConfig)
  const documentStyle = resolveDocumentStyle(pageConfig)

  return enqueueExport(() =>
    withFreshHarness(geometry, async (harness) => {
      const assetToken = documentDir ? registerAssetRoot(documentDir) : undefined
      try {
        const { html } = markdownToHtml(content, { assetToken, allowRemoteImages })
        await harness.sendDocument(html, geometry, documentStyle, PRINT_PAGINATION_TIMEOUT_MS)
        return printWebContents(harness)
      } finally {
        if (assetToken) unregisterAssetRoot(assetToken)
      }
    })
  )
}
