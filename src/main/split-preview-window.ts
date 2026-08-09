import { WebContentsView, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { markdownToHtml } from '../markdown/pipeline'
import { resolvePageConfig } from '../markdown/page-config'
import { computePageGeometry } from '../typography/page-geometry'
import { resolveDocumentStyle } from '../typography/document-style'
import { clampPageIndex, type PageNavState } from '../pagination/page-nav'
import type { RenderRequestMessage } from '../pagination/render-message'
import {
  ensureRenderInfraRegistered,
  registerAssetRoot,
  unregisterAssetRoot,
  type PaginationResult
} from './pagination-window'
import { toViewBounds } from '../typography/split-preview-bounds'

// Structurally identical to (but deliberately not imported from)
// split-preview-bounds.ts's own private `CssRect` -- that interface isn't
// exported there, and this task's brief scopes changes to ONE new file plus
// a minimal export addition to pagination-window.ts, not a second edit to
// Task 1's file for a type alias. TypeScript's structural typing means this
// is interchangeable with toViewBounds' own parameter type below.
interface CssRect {
  x: number
  y: number
  width: number
  height: number
}

export interface SplitPreviewHarness {
  view: WebContentsView
  // Takes raw Markdown content (not pre-rendered HTML, unlike
  // PaginationHarness.sendDocument in pagination-window.ts) plus the
  // document's own on-disk path, mirroring thumbnail-generator.ts's
  // getThumbnail / page-count-generator.ts's getPageCount -- both wrap the
  // lower-level harness.sendDocument(html) with exactly this
  // markdownToHtml-plus-asset-token dance rather than pushing it onto every
  // caller. `filePath: null` means "no validated on-disk path" (an unsaved
  // document, or one Task 3's caller hasn't vetted with isKnownPath) and
  // denies all local assets for that render, same as every other consumer
  // of registerAssetRoot in this codebase. This public signature does NOT
  // grow a `documentStyle` parameter the way `PaginationHarness.sendDocument`
  // does (Task 5) -- exactly like `geometry`, it's derived from `content`
  // internally (`resolveDocumentStyle`, see this function's own body) rather
  // than taken from the caller, since this harness's whole point is that its
  // caller only ever has raw Markdown, never an already-resolved PageConfig.
  sendDocument(content: string, filePath: string | null): Promise<PaginationResult>
  // Converts `cssBounds` (the renderer's own getBoundingClientRect()-shaped
  // rectangle for the right-hand preview pane) via toViewBounds (Task 1,
  // renamed from toPhysicalBounds in the final whole-branch review -- see
  // that file's own comment: WebContentsView.setBounds() takes DIP, not
  // physical pixels) and applies it to the view. The caller supplies
  // whatever scale factor it has determined is correct -- see
  // src/main/index.ts's `split-preview:setBounds` handler for the settled
  // answer (mainWindow.webContents.getZoomFactor() alone, no
  // devicePixelRatio multiply) and the empirical evidence behind it.
  setBounds(cssBounds: CssRect, scaleFactor: number): void
  /**
   * Scrolls the sandboxed preview so `requestedPage` (1-based) is at the top
   * of the pane, and reports where it actually landed. The sandbox clamps, so
   * an out-of-range request is not an error -- it returns the real page it
   * settled on, which is what the renderer reconciles its own state to.
   */
  scrollToPage(requestedPage: number): Promise<PageNavState>
  /** Reports the preview's current page without scrolling it. */
  getPage(): Promise<PageNavState>
  // Tears the view down and detaches it from mainWindow.contentView. Safe
  // to call more than once -- the second call is a deliberate no-op, never
  // a throw, matching this codebase's general "never throw from teardown"
  // discipline (see unregisterAssetRoot's own harmless-no-op-on-unknown-
  // token precedent in pagination-window.ts).
  destroy(): void
}

// Same default every other harness consumer in this codebase (thumbnail-
// generator.ts, page-count-generator.ts, pagination-window.ts itself) has
// always used for a single sendDocument round trip.
const DEFAULT_SEND_DOCUMENT_TIMEOUT_MS = 10_000

// Split mode's own dedicated pagination render harness -- structurally a
// close mirror of createPaginationHarness (pagination-window.ts), but with
// the one deliberate difference that sub-project's design doc calls out:
// this WebContentsView is attached to the real, visible mainWindow's own
// contentView, not a separate, never-shown BaseWindow. Nothing else in this
// codebase composites the sandboxed render context visibly into the app
// window -- every existing harness (thumbnails, page count, PDF export, the
// Phase 0 spike wiring) deliberately keeps its view off-screen or in a
// window nobody ever sees. Split mode's whole point is the opposite: the
// user needs to actually see this view's painted output live, side by side
// with the editor pane.
//
// `createPaginationHarness` itself is NOT reused here (see this
// sub-project's Task 2 brief) -- it hardcodes a BaseWindow parent, sets a
// fixed default size at creation (which would flash the view at the wrong
// place before Task 3/4's real bounds report arrives), and its own
// `sendDocument` closure isn't reachable from outside that function. This
// harness gets its own instance instead, matching this codebase's existing
// one-harness-per-consumer precedent (thumbnail-generator.ts and
// page-count-generator.ts already each own a private harness rather than
// sharing one).
//
// The render context's own session/CSP/protocol-handler setup IS reused,
// via `ensureRenderInfraRegistered` (now exported from pagination-window.ts
// for exactly this reason) -- that function is documented and empirically
// re-verified (see this task's own report) as idempotent and safe to call
// from a second, independent harness module, so this does NOT duplicate its
// body.
export async function createSplitPreviewHarness(
  mainWindow: BrowserWindow
): Promise<SplitPreviewHarness> {
  const renderSession = ensureRenderInfraRegistered()

  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: renderSession
      // No `preload` -- this context has no bridge to Node/Electron APIs,
      // same as every other consumer of the render context.
    }
  })

  // Same navigation/new-window hard-denial as createPaginationHarness --
  // rendered HTML is untrusted (derived from user Markdown) and CSP alone
  // does not govern top-level navigation. See pagination-window.ts's own
  // comment on this for the full rationale; unchanged here.
  view.webContents.on('will-navigate', (event) => event.preventDefault())
  view.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  mainWindow.contentView.addChildView(view)
  // Deliberately NO setBounds() call here, unlike createPaginationHarness's
  // own default ({ x: 0, y: 0, width: PAGE_WIDTH_PX, height: PAGE_HEIGHT_PX
  // }) -- per this task's brief, the view stays unpositioned (Electron
  // defaults a freshly added child view's bounds to { x: 0, y: 0, width: 0,
  // height: 0 }, i.e. invisible) until the caller's setBounds() below is
  // driven by the renderer's own first real bounds report (Task 3/4). A
  // fixed placeholder size here would flash the view at the wrong
  // size/position for one frame before that first report arrives.

  // Scheme/host are hardcoded literals rather than imported from
  // pagination-window.ts, matching src/markdown/pipeline.ts's own existing
  // precedent of hardcoding this same `pagedown-render://render/` origin
  // for asset URLs -- keeps this task's export change to
  // pagination-window.ts limited to exactly the one function
  // (ensureRenderInfraRegistered) this harness genuinely cannot work
  // without, rather than also exporting RENDER_SCHEME/RENDER_HOST for a
  // single string-template use.
  await view.webContents.loadURL('pagedown-render://render/index.html')

  let destroyed = false

  async function sendDocument(
    content: string,
    filePath: string | null,
    timeoutMs: number = DEFAULT_SEND_DOCUMENT_TIMEOUT_MS
  ): Promise<PaginationResult> {
    if (destroyed) {
      throw new Error('createSplitPreviewHarness: sendDocument called after destroy()')
    }

    // Same registerAssetRoot/unregisterAssetRoot-in-finally dance
    // thumbnail-generator.ts's getThumbnail and page-count-generator.ts's
    // getPageCount both use: a document with no validated path (`filePath:
    // null`) registers no asset root at all and denies every local asset,
    // per CLAUDE.md's "A document with no validated path registers no
    // asset root at all" invariant. `filePath` itself is NOT validated
    // here (no isKnownPath check) -- per CLAUDE.md's File I/O security
    // invariant, that is the IPC handler layer's job (Task 3), the same
    // way file:getThumbnail/file:getPageCount validate before ever calling
    // into getThumbnail/getPageCount.
    const documentDir = filePath ? dirname(filePath) : null
    const assetToken = documentDir ? registerAssetRoot(documentDir) : undefined
    try {
      const { html } = markdownToHtml(content, { assetToken })
      // The live preview has to show the document's OWN page geometry (Page
      // Geometry Wiring) -- Split mode is the one surface where the user
      // watches page size/orientation/margin changes take effect, so a fixed
      // Letter/1in assumption here would be immediately visible as wrong.
      // Computed from `content` directly, since unlike pagination-window.ts's
      // harness this sendDocument takes raw Markdown rather than pre-rendered
      // HTML. Parsed ONCE and reused for both `geometry` and `documentStyle`
      // below (Task 5) -- resolvePageConfig() re-parses frontmatter on every
      // call, so calling it twice per sendDocument would double that cost for
      // no benefit; both derived values must agree on which PageConfig they
      // came from anyway.
      const pageConfig = resolvePageConfig(content)
      const geometry = computePageGeometry(pageConfig)
      // Same live-document rationale as `geometry` above, for the
      // NON-geometric per-document inputs (theme, font, running
      // header/footer content) -- Split mode is the one surface where the
      // user watches THESE change live too, not just page size/margins.
      const documentStyle = resolveDocumentStyle(pageConfig)

      const requestId = randomUUID()
      // Built through an explicitly-typed local, not an inline object
      // literal, exactly as pagination-window.ts's own sendDocument does --
      // this is the whole reason src/pagination/render-message.ts exists: an
      // untyped literal here would let a forgotten field (e.g. `geometry` or
      // `documentStyle`) pass tsc silently and surface only as a NaN-valued
      // `@page` rule / missing theme class in the render context. See that
      // module's header comment.
      const message: RenderRequestMessage = {
        type: 'render',
        html,
        requestId,
        geometry,
        documentStyle
      }
      await view.webContents.executeJavaScript(
        `window.postMessage(${JSON.stringify(message)}, '*')`
      )

      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const result = await view.webContents.executeJavaScript(
          `(window.__pagedownResult && window.__pagedownResult.requestId === ${JSON.stringify(requestId)}) ? window.__pagedownResult : null`
        )
        if (result) {
          if (result.type === 'error') {
            throw new Error(`Pagination failed in render context: ${result.error}`)
          }
          return {
            pageCount: result.pageCount,
            ready: result.ready,
            layoutMs: result.layoutMs,
            diagramBoxes: result.diagramBoxes ?? [],
            imageBoxes: result.imageBoxes ?? []
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new Error(`Split preview harness timed out waiting for a result (after ${timeoutMs}ms)`)
    } finally {
      if (assetToken) unregisterAssetRoot(assetToken)
    }
  }

  function setBounds(cssBounds: CssRect, scaleFactor: number): void {
    if (destroyed) return
    view.setBounds(toViewBounds(cssBounds, scaleFactor))
  }

  const EMPTY_PAGE_STATE: PageNavState = { currentPage: 1, pageCount: 0 }

  // Validates whatever came back across the executeJavaScript boundary before
  // trusting it. That boundary is untyped at runtime -- an override, a bundle
  // that failed to evaluate, or a page navigated out from under us can all
  // return something that is not this shape, and a NaN reaching the renderer
  // would surface as "Page NaN of 12" in the status bar.
  function coercePageNavState(value: unknown): PageNavState {
    if (typeof value !== 'object' || value === null) return EMPTY_PAGE_STATE
    const candidate = value as Partial<PageNavState>
    if (!Number.isFinite(candidate.currentPage) || !Number.isFinite(candidate.pageCount)) {
      return EMPTY_PAGE_STATE
    }
    const pageCount = Math.max(0, Math.floor(candidate.pageCount as number))
    return { currentPage: clampPageIndex(candidate.currentPage as number, pageCount), pageCount }
  }

  async function scrollToPage(requestedPage: number): Promise<PageNavState> {
    if (destroyed) return EMPTY_PAGE_STATE
    // Only ever interpolate a validated integer into injected JS. The logic
    // itself lives in the bundled sandbox module, not in this string.
    if (!Number.isFinite(requestedPage)) return EMPTY_PAGE_STATE
    const safePage = Math.max(1, Math.floor(requestedPage))
    const raw = await view.webContents.executeJavaScript(
      `window.__pagedownPageNav ? window.__pagedownPageNav.scrollToPage(${JSON.stringify(safePage)}) : null`
    )
    return coercePageNavState(raw)
  }

  async function getPage(): Promise<PageNavState> {
    if (destroyed) return EMPTY_PAGE_STATE
    const raw = await view.webContents.executeJavaScript(
      `window.__pagedownPageNav ? window.__pagedownPageNav.getPage() : null`
    )
    return coercePageNavState(raw)
  }

  function destroy(): void {
    if (destroyed) return
    destroyed = true
    // Both steps are best-effort: mainWindow (or the view's own
    // webContents) may already be gone by the time destroy() runs -- e.g.
    // the app is quitting and mainWindow's own 'closed' handler is racing
    // this call. Never throw from teardown, matching
    // unregisterAssetRoot's/destroyThumbnailHarness's own established
    // discipline for exactly this situation.
    try {
      if (!mainWindow.isDestroyed()) {
        mainWindow.contentView.removeChildView(view)
      }
    } catch {
      // Best-effort -- see comment above.
    }
    try {
      if (!view.webContents.isDestroyed()) {
        view.webContents.close()
      }
    } catch {
      // Best-effort -- see comment above.
    }
  }

  return { view, sendDocument, setBounds, scrollToPage, getPage, destroy }
}
