import { WebContentsView, BaseWindow, session, type Session } from 'electron'
import { randomUUID, randomBytes } from 'node:crypto'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

// __dirname here resolves at runtime to the directory of the bundled main
// process output (out/main/), regardless of this file's pre-bundle source
// location, so this always lands on out/pagination-render — the static
// bundle produced by scripts/build-pagination-render.ts.
const RENDER_ROOT = path.join(__dirname, '../../out/pagination-render')

const RENDER_SCHEME = 'pagedown-render'
const RENDER_HOST = 'render'
const RENDER_PARTITION = 'pagedown-render-sandbox' // no `persist:` prefix -> in-memory only

let renderSession: Session | undefined
let schemeHandlerRegistered = false

// One-time setup for the sandboxed render context's infrastructure: its own
// isolated session/storage partition, a deny-all permission handler on that
// session, and the pagedown-render:// file-serving protocol handler.
//
// Everything here needs the app to already be ready (session.fromPartition()
// and protocol.handle() both operate on session/protocol machinery that
// isn't available before the `ready` event — unlike
// protocol.registerSchemesAsPrivileged(), which requires the opposite:
// running *before* ready). This module is imported statically from
// src/main/index.ts, and static imports execute at module-load time, before
// app.whenReady() resolves, so none of this can safely run at module scope.
// Doing it lazily on first call to createPaginationHarness() sidesteps that
// ordering hazard entirely: nothing can construct a BaseWindow (a
// precondition for calling this function) before the app is ready anyway.
// The guard makes this safe to call repeatedly (e.g. multiple harnesses,
// repeated test runs) without double-registering anything.
function ensureRenderInfraRegistered(): Session {
  if (renderSession) return renderSession

  // Dedicated, in-memory session partition for the render context. Rendered
  // HTML is untrusted; if it ever escapes pagedown-render:// (see the
  // navigation guards in createPaginationHarness below) it must not land in
  // the same storage partition as the trusted app shell, and it has no
  // legitimate reason to persist anything to disk across launches.
  renderSession = session.fromPartition(RENDER_PARTITION)

  // Electron grants permission requests (geolocation, notifications, media,
  // clipboard, etc.) by default if no handler is installed. `secure: true`
  // (from registerSchemesAsPrivileged) makes pagedown-render:// a secure
  // context, so it's eligible to request all of these — deny everything
  // unconditionally.
  renderSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })

  if (!schemeHandlerRegistered) {
    renderSession.protocol.handle(RENDER_SCHEME, async (request) => {
      const url = new URL(request.url)

      // Only the `render` host is ever legitimate — pagedown-render:// is a
      // `standard: true` scheme, so (like https://) any host resolves to a
      // distinct-but-still-matching origin unless we reject it ourselves.
      if (url.hostname !== RENDER_HOST) {
        return new Response('Not found', { status: 404 })
      }

      const relPath =
        url.pathname === '/' || url.pathname === '' ? 'index.html' : url.pathname.replace(/^\//, '')
      const filePath = path.join(RENDER_ROOT, relPath)

      // Stay inside RENDER_ROOT — this scheme only ever serves the static
      // render-context bundle, never arbitrary filesystem paths.
      if (!filePath.startsWith(RENDER_ROOT + path.sep) && filePath !== RENDER_ROOT) {
        return new Response('Not found', { status: 404 })
      }

      try {
        // index.html is templated, not served as static bytes: it carries
        // %%CSP_STYLE_NONCE%% placeholders (see that file's own comment)
        // that need a fresh, unguessable value on every navigation. A
        // single per-run nonce would be a nonce in name only — usable in
        // any later request once observed once, no better than the earlier
        // hardcoded-nonce mistake Task 3's review already found — so this
        // generates one per request instead. `randomBytes(16)` is the same
        // 128 bits of entropy CSP's own spec examples use for nonces.
        if (relPath === 'index.html') {
          const template = await readFile(filePath, 'utf8')
          const nonce = randomBytes(16).toString('base64')
          const body = template.replaceAll('%%CSP_STYLE_NONCE%%', nonce)
          return new Response(body, { headers: { 'Content-Type': 'text/html' } })
        }

        const body = await readFile(filePath)
        const contentType = filePath.endsWith('.html')
          ? 'text/html'
          : filePath.endsWith('.js')
            ? 'text/javascript'
            : 'application/octet-stream'
        return new Response(body, { headers: { 'Content-Type': contentType } })
      } catch {
        // Missing/unreadable file — a proper 404 Response, not an unhandled
        // rejection that would otherwise surface to the page as
        // net::ERR_UNEXPECTED / net::ERR_FAILED.
        return new Response('Not found', { status: 404 })
      }
    })
    schemeHandlerRegistered = true
  }

  return renderSession
}

export interface PaginationResult {
  pageCount: number
  ready: boolean
  // Wall-clock time Paged.js's own `previewer.preview()` call took, measured
  // entirely inside the render context (see
  // resources/pagination-render/index.ts) — none of this process's
  // executeJavaScript dispatch or the poll loop below is included. Lets a
  // caller (e.g. the committed Gate 2 timing JSON) show how much of
  // `sendAndPaginate` is genuine Paged.js layout work versus harness/poll
  // overhead, without needing a separate, uncommitted diagnostic to find
  // out.
  layoutMs: number
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
//
// Rendered HTML is untrusted (it's derived from user Markdown), so beyond
// the sandbox/contextIsolation/no-preload basics this also has to assume
// the content will actively try to escape: CSP alone does not govern
// top-level navigation (a `<meta http-equiv="refresh">` or `location.href =`
// navigates the view away from pagedown-render:// regardless of `connect-src
// 'none'`), so navigation and new-window attempts are hard-denied below, on
// top of the isolated session/storage partition from
// ensureRenderInfraRegistered().
export async function createPaginationHarness(win: BaseWindow): Promise<PaginationHarness> {
  const renderSession = ensureRenderInfraRegistered()

  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: renderSession
      // No `preload` — this context has no bridge to Node/Electron APIs.
    }
  })

  // Deny any attempt to navigate this view away from pagedown-render://
  // (top-level or subframe) or to open a new window/tab from it. Without
  // this, injected content like `<meta http-equiv="refresh"
  // content="0;url=https://attacker.example/">` silently navigates the view
  // to an attacker-controlled origin — CSP does not apply to navigation, so
  // `connect-src`/`script-src` etc. provide no protection against this on
  // their own.
  view.webContents.on('will-navigate', (event) => event.preventDefault())
  view.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  win.contentView.addChildView(view)
  // Letter @ 96dpi, positioned at the caller's origin by default. Callers
  // that don't want this view visible in their own window (e.g. this
  // project's Phase 0 spike wiring in src/main/index.ts) are responsible
  // for repositioning it after creation — this default is just "big enough
  // to lay out a page," not "hidden."
  view.setBounds({ x: 0, y: 0, width: 816, height: 1056 })
  await view.webContents.loadURL(`${RENDER_SCHEME}://${RENDER_HOST}/index.html`)

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
      if (result) {
        // The render context publishes a distinct `type: 'error'` result
        // (see resources/pagination-render/index.ts's try/catch) when
        // `previewer.preview()` rejects or throws. Surfacing that
        // immediately, with the actual error message, is the entire point —
        // without this branch, a real pagination failure looked identical
        // to "no result yet" and this loop just spun for the full 10-second
        // deadline before throwing a generic, undiagnostic timeout. That
        // exact symptom is what made this task's own CSP bug expensive to
        // track down; later tasks stressing Paged.js with diagrams/oversized
        // tables/a patched Chunker are exactly where a real failure like
        // this is expected to happen again.
        if (result.type === 'error') {
          throw new Error(`Pagination failed in render context: ${result.error}`)
        }
        return { pageCount: result.pageCount, ready: result.ready, layoutMs: result.layoutMs }
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('Pagination harness timed out waiting for a result')
  }

  return { view, sendDocument }
}
