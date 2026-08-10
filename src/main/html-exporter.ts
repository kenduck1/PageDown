import { dialog, type BrowserWindow } from 'electron'
import { writeFile, readFile } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import { markdownToHtml } from '../markdown/pipeline'
import { resolvePageConfig, type PageFontFamily } from '../markdown/page-config'
import { computePageGeometry } from '../typography/page-geometry'
import { resolveDocumentStyle } from '../typography/document-style'
import {
  buildStaticHtmlDocument,
  type StaticHtmlFontAssets
} from '../typography/static-html-document'
import { inlineLocalImages } from './inline-local-images'
// electron-vite's own `?asset` import (node.d.ts's `declare module '*?asset'`,
// already the exact mechanism src/main/index.ts uses for the Dock/tray icon)
// resolves to a real absolute file path in BOTH dev and a packaged build --
// works cleanly for the three .woff2 fonts below, but NOT for the .css
// import just above them: a REAL, caught-by-actually-building finding, not
// theorized -- `pnpm build` failed with "'default' is not exported by
// '...document-typography.css?asset'" the first time this was tried. Vite's
// own core CSS plugin intercepts any `.css`-extensioned import before the
// generic `?asset`/asset-URL plugin ever sees it (CSS gets its own dedicated
// handling regardless of query string), and in this SSR/Node-targeted build
// that produces a module with no real `default` export for Rollup to bind
// to. `?raw` sidesteps this: it's Vite's own documented, guaranteed-priority
// mechanism for "give me this file's exact text as a string, no matter what
// extension it has" (used here for exactly the property `?asset` normally
// gives -- a build-time-resolved value, not a runtime fs read against a
// path -- which is why this import needs NO node:fs call at all, unlike the
// three font paths below). Needs its own ambient module declaration
// (asset-types.d.ts) -- electron-vite's own node.d.ts declares `*?asset`
// but not `*?raw`.
import documentTypographyCss from '../typography/document-typography.css?raw'
import sourceSerif4Path from '../renderer/src/assets/fonts/source-serif-4-variable.woff2?asset'
import interVariablePath from '../renderer/src/assets/fonts/inter-variable.woff2?asset'
import sourceCodeProPath from '../renderer/src/assets/fonts/source-code-pro-variable.woff2?asset'

// Reads exactly the fonts THIS export actually needs -- the active body
// family only (never both), and the mono face only when `hasCode` -- same
// "don't pay for what you don't use" discipline
// resources/pagination-render/index.ts's own buildDocumentStylesheet
// applies, and worth even more here: this is a portable file a reader
// downloads/emails/commits once, not a long-lived render harness.
async function loadFontAssets(
  fontFamily: PageFontFamily,
  hasCode: boolean
): Promise<StaticHtmlFontAssets> {
  const bodyPath = fontFamily === 'inter' ? interVariablePath : sourceSerif4Path
  const bodyFontBase64 = (await readFile(bodyPath)).toString('base64')
  const monoFontBase64 = hasCode ? (await readFile(sourceCodeProPath)).toString('base64') : null
  return {
    bodyFontFamilyName: fontFamily === 'inter' ? 'Inter Variable' : 'Source Serif 4',
    bodyFontWeightRange: fontFamily === 'inter' ? '100 900' : '200 900',
    bodyFontBase64,
    monoFontBase64
  }
}

// Full end-to-end HTML export: real Save dialog -> markdownToHtml (no
// assetToken -- see inline-local-images.ts's own comment for why) -> local
// images inlined as data: URIs -> a self-contained <!doctype html> document
// (static-html-document.ts) -> written to the chosen path. Returns null on a
// cancelled Save dialog, matching exportDocumentToPdf's own null-on-cancel
// contract in pdf-exporter.ts.
//
// `documentPath` is ALREADY isKnownPath-validated by the caller
// (src/main/index.ts's file:exportHtml handler) before it ever reaches this
// function -- identical division of responsibility to exportDocumentToPdf's
// own `documentPath` parameter; see that function's own comment for the
// full reasoning (this export never strictly NEEDS the source path, so an
// unknown/stale one just means local images in the export resolve to
// nothing, not a failed export).
//
// Unlike PDF export/print, this function never touches the pagination
// harness at all (no BaseWindow, no WebContentsView, no sendDocument round
// trip) -- the whole job is Node-side string/file assembly, so it is not
// routed through pdf-exporter.ts's shared `enqueueExport` queue. That queue
// exists specifically to stop several PDF exports (or a PDF export and a
// print job) from spinning up multiple full sandboxed render contexts
// concurrently; HTML export has no such resource to contend over, and
// documentStore's own `isExportingHtml` guard (renderer side) already stops
// a single window's own double-click from overlapping with itself.
export async function exportDocumentToHtml(
  win: BrowserWindow,
  content: string,
  documentPath?: string,
  allowRemoteImages = false
): Promise<{ filePath: string } | null> {
  const result = await dialog.showSaveDialog(win, {
    filters: [{ name: 'HTML', extensions: ['html'] }],
    defaultPath: 'document.html'
  })
  if (result.canceled || !result.filePath) return null

  const documentDir = documentPath ? dirname(documentPath) : null
  const pageConfig = resolvePageConfig(content)
  const geometry = computePageGeometry(pageConfig)
  const style = resolveDocumentStyle(pageConfig)

  const { html: bodyHtmlWithLocalRefs } = markdownToHtml(content, { allowRemoteImages })
  const bodyHtml = await inlineLocalImages(bodyHtmlWithLocalRefs, documentDir)

  // Same detection shape as resources/pagination-render/index.ts's own
  // `hasCode` gate (`container.querySelector('pre, code') !== null`) --
  // this context has no DOM to query, so a plain tag-presence check on the
  // final HTML string stands in for it. Run AFTER local-image inlining
  // (irrelevant to the result either way -- inlining only ever touches
  // `<img>` tags -- but keeping the check adjacent to its one use below
  // reads clearer than hoisting it earlier for no benefit).
  const hasCode = /<pre[\s>]|<code[\s>]/i.test(bodyHtml)
  const fonts = await loadFontAssets(style.fontFamily, hasCode)
  // documentTypographyCss is already a real string, resolved at BUILD time
  // by the `?raw` import above -- no fs read needed here, unlike the font
  // paths (which `?asset` resolves to a file PATH, still requiring the
  // node:fs reads inside loadFontAssets).

  // The document's own filename, extension stripped -- the closest thing
  // this app has to a document "title" (frontmatter carries no such field).
  // 'Untitled Document' matches SourceEditor/tabLabel's own "Untitled"
  // fallback in spirit for a never-saved document, expanded to a full
  // phrase since this becomes a real, user-visible browser-tab title rather
  // than a compact tab-bar label.
  const title = documentPath
    ? basename(documentPath).replace(/\.(md|markdown)$/i, '')
    : 'Untitled Document'

  const html = buildStaticHtmlDocument({
    title,
    bodyHtml,
    geometry,
    style,
    documentTypographyCss,
    fonts
  })

  await writeFile(result.filePath, html, 'utf8')
  return { filePath: result.filePath }
}
