// The Electron half of .docx export: a real Save dialog, the security-vetted
// local-image reads, and the disk write. All the actual Markdown -> OOXML
// conversion lives in src/export/markdown-to-docx.ts, which is Electron-free
// and directly unit-testable -- the same split html-exporter.ts /
// static-html-document.ts already uses, and for the same reason.
//
// See markdown-to-docx.ts's own header for what this format does and does not
// preserve. Short version for anyone touching this file: it is a CONTENT
// export, Word repaginates it, and PDF remains the fidelity path.
import { dialog, type BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import {
  markdownToDocx,
  parseDocxTree,
  collectLocalImageSrcs,
  type DocxImageAsset
} from '../export/markdown-to-docx'
import { readImageDimensions } from '../export/docx-image'
import { resolveLocalImageDataUri } from './inline-local-images'

// `data:<mime>;base64,<payload>` -- the exact shape resolveLocalImageDataUri
// produces, matched narrowly rather than with a permissive parser because this
// function's only input is that function's own output.
const DATA_URI_PATTERN = /^data:([^;,]+);base64,(.*)$/s

/**
 * Reads and measures every local image a document references, reusing
 * inline-local-images.ts's `resolveLocalImageDataUri` -- deliberately, rather
 * than opening the files here.
 *
 * That reuse is the whole security story for this feature, and it is worth
 * being explicit about why it takes the roundabout data:-URI-then-decode route
 * instead of a direct read. Every guard a local image read needs already lives
 * behind that one function: `resolveAssetPath`'s symlink-resolved confinement
 * to the document's own directory, its refusal of absolute paths and `..`
 * escapes, the 10 MiB stat-BEFORE-read cap, and the real magic-byte content
 * sniff. Adding a second read path here -- even a careful one -- would mean a
 * second, independently-reasoned-about copy of four security properties, which
 * is precisely how one of them ends up subtly weaker than the other. Base64
 * round-tripping a file that is already capped at 10 MiB is a real but small
 * cost, paid once per image per export, in exchange for adding NO new
 * filesystem-reaching code to this app at all.
 *
 * A src that resolves to nothing -- denied, missing, oversized, or in a format
 * `docx` cannot embed (WebP/SVG reach every other surface fine but have no
 * ImageRun representation) -- is simply absent from the returned map, and the
 * converter renders its alt text. One unreadable picture must never fail an
 * export.
 */
async function loadLocalImages(
  content: string,
  documentDir: string | null
): Promise<Map<string, DocxImageAsset>> {
  const images = new Map<string, DocxImageAsset>()
  // No validated document path means no directory to resolve against, which is
  // the correct "deny all local assets until saved" posture every other
  // surface in this app already takes (CLAUDE.md's File I/O security
  // invariant).
  if (!documentDir) return images

  const srcs = collectLocalImageSrcs(parseDocxTree(content))
  await Promise.all(
    srcs.map(async (src) => {
      const dataUri = await resolveLocalImageDataUri(documentDir, src)
      if (!dataUri) return
      const match = DATA_URI_PATTERN.exec(dataUri)
      if (!match) return
      const data = new Uint8Array(Buffer.from(match[2], 'base64'))
      // Measured from the bytes rather than trusted from the sniffed MIME type:
      // `docx` needs real pixel dimensions, and the two questions ("what format
      // is this" and "how big is it") have to agree, so the same header parse
      // answers both. A format sniffImageContentType accepts but this cannot
      // measure (image/webp, image/svg+xml) correctly falls out here.
      const dimensions = readImageDimensions(data)
      if (!dimensions) return
      images.set(src, {
        data,
        type: dimensions.type,
        widthPx: dimensions.widthPx,
        heightPx: dimensions.heightPx
      })
    })
  )
  return images
}

/**
 * Full end-to-end .docx export: real Save dialog -> Markdown parsed to mdast ->
 * local images read through the vetted path -> real OOXML -> written to the
 * chosen path. Returns null on a cancelled dialog, matching
 * exportDocumentToPdf / exportDocumentToHtml's own null-on-cancel contract.
 *
 * `documentPath` is ALREADY isKnownPath-validated by the caller (the
 * `file:exportDocx` handler in src/main/index.ts), identically to the PDF and
 * HTML exporters -- an unknown or stale path just means local images resolve
 * to nothing, never a failed export.
 *
 * Like HTML export and unlike PDF/print, this never touches the pagination
 * harness -- there is no sandboxed render context involved at all, just
 * Node-side tree walking and file writing -- so it is deliberately not routed
 * through pdf-exporter.ts's shared `enqueueExport` queue. That queue exists to
 * stop concurrent exports spinning up multiple sandboxed renderers; there is
 * no such resource to contend over here.
 */
export async function exportDocumentToDocx(
  win: BrowserWindow,
  content: string,
  documentPath?: string,
  allowRemoteImages = false
): Promise<{ filePath: string } | null> {
  const result = await dialog.showSaveDialog(win, {
    filters: [{ name: 'Word Document', extensions: ['docx'] }],
    defaultPath: 'document.docx'
  })
  if (result.canceled || !result.filePath) return null

  const documentDir = documentPath ? dirname(documentPath) : null
  const images = await loadLocalImages(content, documentDir)

  // The document's own filename, extension stripped -- the closest thing this
  // app has to a document title (frontmatter carries no such field). Same
  // derivation, and the same 'Untitled Document' fallback, html-exporter.ts
  // uses for the browser tab title; here it lands in the .docx core properties,
  // which is what Word shows in File > Info and what a document-management
  // system indexes on.
  const title = documentPath
    ? basename(documentPath).replace(/\.(md|markdown)$/i, '')
    : 'Untitled Document'

  const buffer = await markdownToDocx({ content, images, allowRemoteImages, title })
  await writeFile(result.filePath, buffer)
  return { filePath: result.filePath }
}
