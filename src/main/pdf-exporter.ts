import { dialog, type BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { markdownToHtml } from '../markdown/pipeline'
import { createPaginationHarness, type PaginationHarness } from './pagination-window'
import { exportToPdf } from '../export/export-pdf'

// Serializes every call that dispatches into this module's OWN harness --
// the exact same enqueueHarnessWork pattern thumbnail-generator.ts uses, for
// the exact same reason (see this project's CLAUDE.md: "The pagination
// render harness handles exactly ONE in-flight request at a time --
// concurrent callers must serialize themselves"). Needed here for real: a
// user could click "Export PDF" while a Home-screen thumbnail is mid-render,
// or trigger two exports back to back, and either would otherwise race the
// harness's single `currentRequestId` and silently lose one caller's result
// (see resources/pagination-render/index.ts).
let harnessQueue: Promise<unknown> = Promise.resolve()

function enqueueHarnessWork<T>(task: () => Promise<T>): Promise<T> {
  const result = harnessQueue.then(task)
  // Chain the queue's tail through a value- and rejection-swallowing
  // continuation, not `result` directly -- otherwise one rejected export
  // would permanently wedge the queue for every export after it, since a
  // rejected promise used as the next `.then()`'s receiver short-circuits
  // every subsequent `.then()` in the chain. Same fix thumbnail-generator.ts
  // already applies to its own queue.
  harnessQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

let harnessPromise: Promise<PaginationHarness> | null = null

// Lazily created, then reused for every exportDocumentToPdf call within
// this app session -- deliberately a SEPARATE instance from both the
// Phase-0-spike harness (src/main/index.ts) and thumbnail-generator.ts's own
// harness, per this codebase's established "don't couple unrelated harness
// consumers" convention (see thumbnail-generator.ts's own comment on why ITS
// harness is separate from the Phase-0 one). Exporting a PDF while a
// thumbnail is mid-render must not contend over a harness whose single
// bounds/webContents state is being driven by an unrelated feature.
function getHarness(win: BrowserWindow): Promise<PaginationHarness> {
  if (!harnessPromise) {
    harnessPromise = createPaginationHarness(win).then((harness) => {
      harness.view.setBounds({ x: -9999, y: -9999, width: 816, height: 1056 })
      // Same self-healing behavior as thumbnail-generator.ts's own harness:
      // if the underlying WebContentsView is ever destroyed (e.g. alongside
      // a closed mainWindow), drop the memoized promise so the next export
      // creates a fresh harness instead of failing every request for the
      // rest of the session against a dead view.
      harness.view.webContents.once('destroyed', () => {
        harnessPromise = null
      })
      return harness
    })
  }
  return harnessPromise
}

// Full end-to-end PDF export: real Save dialog -> markdownToHtml -> send to
// this module's dedicated pagination harness -> printToPDF via
// exportToPdf() (src/export/export-pdf.ts, already correct/unchanged here)
// -> write the resulting buffer to the chosen path. Returns null if the user
// cancels the Save dialog, matching saveFile()'s own null-on-cancel contract
// in file-io.ts.
//
// The Save dialog runs BEFORE any rendering work, not after: failing fast on
// a cancelled dialog avoids paying for a pagination+printToPDF round trip
// the user has already declined.
//
// No isKnownPath() check is needed here (contrast file-io.ts's
// saveFileToKnownOrChosenPath): the destination path comes directly from a
// real native dialog.showSaveDialog() result, which is exactly the
// "already vetted" source isKnownPath's own allowlist exists to recognize --
// see CLAUDE.md's File I/O security invariant section.
export async function exportDocumentToPdf(
  win: BrowserWindow,
  content: string
): Promise<{ filePath: string } | null> {
  const result = await dialog.showSaveDialog(win, {
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    defaultPath: 'document.pdf'
  })
  if (result.canceled || !result.filePath) return null

  const pdfBuffer = await enqueueHarnessWork(async () => {
    const harness = await getHarness(win)
    const { html } = markdownToHtml(content)
    await harness.sendDocument(html)
    return exportToPdf(harness)
  })

  await writeFile(result.filePath, pdfBuffer)
  return { filePath: result.filePath }
}
