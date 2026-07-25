import { WebContentsView, BaseWindow, protocol } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

// __dirname here resolves at runtime to the directory of the bundled main
// process output (out/main/), regardless of this file's pre-bundle source
// location, so this always lands on out/pagination-render — the static
// bundle produced by scripts/build-pagination-render.ts.
const RENDER_ROOT = path.join(__dirname, '../../out/pagination-render')

const RENDER_SCHEME = 'pagedown-render'

let schemeHandlerRegistered = false

// `protocol.handle()` operates on the default session and (unlike
// `protocol.registerSchemesAsPrivileged`, which must run before app ready)
// requires the app to already be ready. The brief's sample registers this at
// module scope, but this module is imported statically from src/main/index.ts,
// and static imports execute at module-load time — before app.whenReady()
// resolves. Registering lazily here instead, on first call to
// createPaginationHarness, sidesteps that ordering hazard entirely: nothing
// can construct a BaseWindow (a precondition for calling this function)
// before the app is ready anyway. The `schemeHandlerRegistered` guard makes
// this safe to call from multiple harnesses (e.g. repeated test runs) without
// Electron complaining about a double-registered scheme handler.
function ensureSchemeHandlerRegistered(): void {
  if (schemeHandlerRegistered) return

  protocol.handle(RENDER_SCHEME, async (request) => {
    const url = new URL(request.url)
    const relPath =
      url.pathname === '/' || url.pathname === '' ? 'index.html' : url.pathname.replace(/^\//, '')
    const filePath = path.join(RENDER_ROOT, relPath)

    // Stay inside RENDER_ROOT — this scheme only ever serves the static
    // render-context bundle, never arbitrary filesystem paths.
    if (!filePath.startsWith(RENDER_ROOT + path.sep) && filePath !== RENDER_ROOT) {
      return new Response('Not found', { status: 404 })
    }

    const body = await readFile(filePath)
    const contentType = filePath.endsWith('.html')
      ? 'text/html'
      : filePath.endsWith('.js')
        ? 'text/javascript'
        : 'application/octet-stream'
    return new Response(body, { headers: { 'Content-Type': contentType } })
  })

  schemeHandlerRegistered = true
}

export interface PaginationResult {
  pageCount: number
  ready: boolean
}

export interface PaginationHarness {
  view: WebContentsView
  sendDocument(html: string): Promise<PaginationResult>
}

// Builds the sandboxed pagination render harness: a WebContentsView (not an
// <iframe> — see the design doc's rejection of the iframe approach) loaded
// from the privileged pagedown-render:// scheme, with no preload script and
// no IPC access. Every later Phase 0 gate script and the real pagination
// pipeline build on this function.
export async function createPaginationHarness(win: BaseWindow): Promise<PaginationHarness> {
  ensureSchemeHandlerRegistered()

  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
      // No `preload` — this context has no bridge to Node/Electron APIs.
    }
  })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 816, height: 1056 }) // Letter @ 96dpi, for now off to one side / unattached in real use
  await view.webContents.loadURL(`${RENDER_SCHEME}://render/index.html`)

  async function sendDocument(html: string): Promise<PaginationResult> {
    const requestId = randomUUID()
    await view.webContents.executeJavaScript(
      `window.postMessage(${JSON.stringify({ type: 'render', html, requestId })}, '*')`
    )

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const result = await view.webContents.executeJavaScript(
        `(window.__pagedownResult && window.__pagedownResult.requestId === ${JSON.stringify(requestId)}) ? window.__pagedownResult : null`
      )
      if (result) return { pageCount: result.pageCount, ready: result.ready }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('Pagination harness timed out waiting for a result')
  }

  return { view, sendDocument }
}
