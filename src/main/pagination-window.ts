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

// Keep this in sync with resources/pagination-render/index.html's CSP
// <meta http-equiv> tag — they must carry the identical policy. Previously
// the nonce was delivered ONLY via that <meta> tag; a `<meta
// http-equiv="Content-Security-Policy">` tag only takes effect once the HTML
// parser reaches it, so anything the parser processes before that point
// (there is nothing that currently does, but it costs nothing to close this
// off) would run under no CSP at all. Setting the identical policy as a
// real `Content-Security-Policy` response header as well covers the whole
// navigation from the very first byte, the way CSP is normally deployed.
const CSP_POLICY_TEMPLATE =
  "default-src 'self'; style-src 'self' 'nonce-%%CSP_STYLE_NONCE%%'; script-src 'self'; img-src 'self' data:; connect-src 'none';"

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
//
// (Fix-round note: a per-caller-isolated-partition variant of this function
// was tried and reverted during the PDF-export timing investigation -- see
// pdf-exporter.ts's own comment for what the slowdown actually turned out
// to be. Session/partition sharing was NOT the cause, so this stays the
// single shared session every caller has always used.)
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

      // Strips ALL leading slashes, not just one: a request like
      // pagedown-render://render//index.html (pathname "//index.html")
      // previously left a single leading slash on relPath after only
      // stripping one, so the `relPath === 'index.html'` exact-match below
      // (which decides whether to run the CSP-nonce templating) would MISS
      // it — falling through to the generic byte-for-byte file-serving
      // branch, which would have served index.html with its
      // %%CSP_STYLE_NONCE%% placeholders un-substituted, reproducing the
      // original silent-hang bug. Not reachable today (this project only
      // ever calls loadURL with a single slash), but cheap to close now
      // rather than leave as a landmine for a future caller.
      const relPath =
        url.pathname === '/' || url.pathname === ''
          ? 'index.html'
          : url.pathname.replace(/^\/+/, '')
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
          const csp = CSP_POLICY_TEMPLATE.replaceAll('%%CSP_STYLE_NONCE%%', nonce)
          return new Response(body, {
            headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': csp }
          })
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
  // Task 8 / Gate 3: per-diagram bounding boxes for every
  // `.pagedown-mermaid-diagram` actually present in the paginated output,
  // measured via getBoundingClientRect() inside the render context AFTER
  // pagination completes (see resources/pagination-render/index.ts's
  // measureDiagramBoxes) — the mechanism for actually detecting a zero-size
  // Mermaid getBBox() failure, rather than just inferring "it probably
  // worked" from the absence of a thrown error. `[]` for documents with no
  // mermaid diagrams.
  diagramBoxes: Array<{ id: string; width: number; height: number }>
}

export interface PaginationHarness {
  view: WebContentsView
  // `timeoutMs` defaults to DEFAULT_SEND_DOCUMENT_TIMEOUT_MS below when
  // omitted -- added (fix-round review, PDF export track) so a caller with
  // a heavier-than-routine workload (large-document PDF export) can ask for
  // a longer allowance than the default without changing that default for
  // every other caller (thumbnail generation, Phase 0 gates) that's always
  // been fine with it.
  sendDocument(html: string, timeoutMs?: number): Promise<PaginationResult>
}

// The general-purpose default every existing caller (thumbnail-generator.ts,
// every phase0/phase1 gate) implicitly relied on before this became a real
// parameter -- unchanged from the literal `10_000` this replaces.
const DEFAULT_SEND_DOCUMENT_TIMEOUT_MS = 10_000

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

  async function sendDocument(
    html: string,
    timeoutMs: number = DEFAULT_SEND_DOCUMENT_TIMEOUT_MS
  ): Promise<PaginationResult> {
    const requestId = randomUUID()
    await view.webContents.executeJavaScript(
      `window.postMessage(${JSON.stringify({ type: 'render', html, requestId })}, '*')`
    )

    const deadline = Date.now() + timeoutMs
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
        return {
          pageCount: result.pageCount,
          ready: result.ready,
          layoutMs: result.layoutMs,
          diagramBoxes: result.diagramBoxes ?? []
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Pagination harness timed out waiting for a result (after ${timeoutMs}ms)`)
  }

  return { view, sendDocument }
}

// --- Task 7 / Gate 7: incremental re-layout spike -------------------------
//
// Separate postMessage/poll pair from `sendDocument` above, deliberately:
// gate7's two phases need to keep ONE Previewer/Chunker instance alive in
// the render context between two round trips (see
// resources/pagination-render/index.ts's `gate7Previewer` module state),
// whereas `sendDocument` is fully self-contained per call. Reusing
// `sendDocument`/`__pagedownResult`'s shape for this would conflate two
// different lifecycles for no benefit — see that file's block comment above
// its gate7 message handlers for the full Chunker-internals writeup this is
// exercising.

export interface Gate7Phase1Result {
  fullOriginalMs: number
  totalPagesOriginal: number
  sectionNumberAtBreakpoint: number | null
  resumeNoEditMs: number
  totalPagesAfterResumeNoEdit: number
  baselinePagesText: string[]
  resumedNoEditPagesText: string[]
}

export interface Gate7Phase2Result {
  resumeWithEditMs: number
  totalPagesAfterEdit: number
  resumedWithEditPagesText: string[]
  resumedPrefixPagesText: string[]
  fullEditedMs: number
  totalPagesEdited: number
  controlPagesText: string[]
  controlPrefixPagesText: string[]
}

// Phase 2's from-scratch control run separately re-lays-out the full ~300
// page document (see gate2's ~2.5s measurement for that alone), on top of
// phase 1's own full run and two partial resumes — comfortably over
// sendDocument's 10s deadline in the worst case, hence the longer budget
// here rather than reusing that constant.
const GATE7_POLL_DEADLINE_MS = 30_000

async function pollGate7Result<T>(
  view: WebContentsView,
  requestId: string,
  resultType: string
): Promise<T> {
  const deadline = Date.now() + GATE7_POLL_DEADLINE_MS
  while (Date.now() < deadline) {
    const result = await view.webContents.executeJavaScript(
      `(window.__pagedownGate7Result && window.__pagedownGate7Result.requestId === ${JSON.stringify(requestId)}) ? window.__pagedownGate7Result : null`
    )
    if (result) {
      if (result.ok === false) {
        throw new Error(`Gate 7 spike failed in render context: ${result.error}`)
      }
      if (result.type !== resultType) {
        throw new Error(
          `Gate 7 spike returned an unexpected result type: expected ${resultType}, got ${result.type}`
        )
      }
      return result as T
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Gate 7 spike timed out waiting for a result')
}

// Phase 1: full paginate `html`, capture the breakToken at `targetPageIndex`
// via the afterPageLayout hook, then an immediate resume-with-no-edit
// sanity check. See resources/pagination-render/index.ts for what actually
// runs; this is just the postMessage/poll plumbing to reach it.
export async function sendGate7Phase1(
  harness: PaginationHarness,
  html: string,
  targetPageIndex: number
): Promise<Gate7Phase1Result> {
  const requestId = randomUUID()
  await harness.view.webContents.executeJavaScript(
    `window.postMessage(${JSON.stringify({ type: 'gate7-phase1', requestId, html, targetPageIndex })}, '*')`
  )
  return pollGate7Result<Gate7Phase1Result>(harness.view, requestId, 'gate7-phase1-result')
}

// Phase 2: apply a real edit to the SAME live chunker.source tree phase 1
// left alive (a new text node appended to the paragraph after
// "## Section {editSectionNumber}"), resume from the retained breakToken,
// and time that against a from-scratch full layout of `editedHtml` (built
// by the caller via the real markdownToHtml pipeline on an edited markdown
// string, so the control run lays out genuinely equivalent content). Must
// be called with the same `targetPageIndex` phase 1 was called with, and
// only after phase 1 has resolved successfully — see the render context's
// own checks for both.
export async function sendGate7Phase2(
  harness: PaginationHarness,
  payload: {
    editSectionNumber: number
    markerText: string
    editedHtml: string
    targetPageIndex: number
  }
): Promise<Gate7Phase2Result> {
  const requestId = randomUUID()
  await harness.view.webContents.executeJavaScript(
    `window.postMessage(${JSON.stringify({ type: 'gate7-phase2', requestId, ...payload })}, '*')`
  )
  return pollGate7Result<Gate7Phase2Result>(harness.view, requestId, 'gate7-phase2-result')
}

// --- Task 9 / Gate 4: header/footer artifact-vs-content tagging probe -----
//
// See resources/pagination-render/index.ts's block comment above its
// 'gate4-header-footer-probe' handler for why this exists: this harness's
// regular sendDocument() path always calls previewer.preview() with an
// empty stylesheet array, so no corpus document ever gets real `@page`
// running-header/footer/page-number content to inspect the tagging of.
// This sends real `@page` CSS (containing @top-center/@bottom-center margin
// box rules) alongside the body HTML so the render context actually
// generates that content once, for phase0/gate4-export.spec.ts to export
// and inspect.
export interface Gate4ProbeResult {
  pageCount: number
}

export async function sendGate4HeaderFooterProbe(
  harness: PaginationHarness,
  html: string,
  css: string
): Promise<Gate4ProbeResult> {
  const requestId = randomUUID()
  await harness.view.webContents.executeJavaScript(
    `window.postMessage(${JSON.stringify({ type: 'gate4-header-footer-probe', requestId, html, css })}, '*')`
  )

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const result = await harness.view.webContents.executeJavaScript(
      `(window.__pagedownGate4ProbeResult && window.__pagedownGate4ProbeResult.requestId === ${JSON.stringify(requestId)}) ? window.__pagedownGate4ProbeResult : null`
    )
    if (result) {
      if (result.ok === false) {
        throw new Error(`Gate 4 header/footer probe failed in render context: ${result.error}`)
      }
      return { pageCount: result.pageCount }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Gate 4 header/footer probe timed out waiting for a result')
}
