import { WebContentsView, BaseWindow, session, type Session } from 'electron'
import { randomUUID, randomBytes } from 'node:crypto'
import path from 'node:path'
import { readFile, realpath, stat } from 'node:fs/promises'
import { PAGE_WIDTH_PX, PAGE_HEIGHT_PX, type PageGeometry } from '../typography/page-geometry'
import type { DocumentStyle } from '../typography/document-style'
import type { RenderRequestMessage } from '../pagination/render-message'
import type { PageBreakPosition } from '../pagination/page-breaks'

// __dirname here resolves at runtime to the directory of the bundled main
// process output (out/main/), regardless of this file's pre-bundle source
// location, so this always lands on out/pagination-render — the static
// bundle produced by scripts/build-pagination-render.ts.
const RENDER_ROOT = path.join(__dirname, '../../out/pagination-render')

const RENDER_SCHEME = 'pagedown-render'
const RENDER_HOST = 'render'
const RENDER_PARTITION = 'pagedown-render-sandbox' // no `persist:` prefix -> in-memory only

// --- Local asset loading: token-scoped document-directory registry --------
//
// A document can reference local images (`![x](./figures/chart.png)`), and
// the sandboxed render context needs to be able to serve those bytes even
// though it otherwise only ever serves its own static bundle out of
// RENDER_ROOT (see the protocol handler below). Rather than have the render
// context trust an arbitrary absolute path handed to it per-request (which
// would make every request a potential arbitrary-file-read), the currently
// open document's directory is registered ONCE per document load, behind an
// unguessable per-load token, and every asset request must present that
// token plus a path that resolves (after symlink resolution) to a
// descendant of that specific directory. See resolveAssetPath below for the
// actual confinement check this rests on.
interface AssetRootEntry {
  documentDir: string
}

const assetRootRegistry = new Map<string, AssetRootEntry>()

// Throws on a non-absolute (including empty-string) documentDir rather than
// silently registering it: a relative path here would confine assets to
// wherever the main process's cwd happens to be, not to any real document
// directory -- a structural bug, not a legitimate input, so this fails loud
// rather than quietly misbehaving. This is a programming-error guard, not
// user-input validation: the correct behavior for an unsaved/untitled
// document (which has no real on-disk directory at all) is for the CALLER
// to never invoke registerAssetRoot in the first place and skip local-asset
// loading entirely for that document -- that's Task 3's responsibility, not
// something this function can paper over by returning a token that can
// never resolve.
export function registerAssetRoot(documentDir: string): string {
  if (!path.isAbsolute(documentDir)) {
    throw new Error(
      `registerAssetRoot: documentDir must be an absolute path, got: ${JSON.stringify(documentDir)}`
    )
  }
  const token = randomBytes(16).toString('hex')
  assetRootRegistry.set(token, { documentDir })
  return token
}

export function unregisterAssetRoot(token: string): void {
  assetRootRegistry.delete(token)
}

// The one function this feature's whole confinement guarantee rests on --
// deliberately kept pure/Electron-free (no `session`/`protocol` dependency)
// so it's directly unit-testable against a real temp directory, matching
// this codebase's established `isKnownPath`-style testability convention
// (see recent-files.ts's own comment on why THAT function stays
// Electron-free). Returns the real, symlink-resolved absolute path if (and
// only if) `relativePath` resolves to a real file that is a descendant of
// `documentDir` after symlink resolution -- null for every other case
// (absolute path, `..` escape, missing file, symlink escape). Deliberately
// does NOT distinguish these failure reasons in its return type: every
// caller treats "not resolvable" as a plain 404, and a codebase-wide
// convention of "don't leak WHY a path was denied" avoids giving a hostile
// document a oracle for probing the filesystem (e.g. distinguishing
// "doesn't exist" from "exists but escapes the sandbox" one bit at a time).
//
// This is a real symlink-resolving confinement check via fs.realpath on
// BOTH sides, not a raw string-prefix check on the unresolved path -- unlike
// the RENDER_ROOT check a little further down in this file, which IS a raw
// prefix check. That's fine there because RENDER_ROOT only ever serves this
// project's own build output (a trusted, non-symlinked directory this
// project controls); documentDir here can be anywhere on a user's disk and
// can contain symlinks planted by a hostile document's own bundled files
// (e.g. a `.md` shipped alongside a symlink disguised as an image), so
// resolving symlinks before the confinement comparison is required, not
// optional hardening.
export async function resolveAssetPath(
  documentDir: string,
  relativePath: string
): Promise<string | null> {
  // path.isAbsolute is the correct rejection for "absolute paths... denied
  // by default" per this plan's Global Constraints -- an absolute reference
  // is refused on policy grounds regardless of where it would resolve to,
  // not merely as an incidental side effect of the realpath-confinement
  // check below. This is genuinely load-bearing, not redundant with that
  // check: the protocol handler decodeURIComponent()s the path segment
  // before calling this function, so a request path containing `%2f`
  // (encoded `/`) arrives here as a real absolute string (e.g.
  // `/etc/passwd`) -- this is exactly the case this guard exists to catch.
  // Checked BEFORE path.join, not after: path.isAbsolute reads relativePath
  // itself, and doing this check post-join would require re-deriving
  // "was the original segment absolute" from the joined result, which is
  // strictly more error-prone for no benefit.
  if (path.isAbsolute(relativePath)) return null

  const candidate = path.join(documentDir, relativePath)

  let realDocumentDir: string
  let realCandidate: string
  try {
    realDocumentDir = await realpath(documentDir)
    realCandidate = await realpath(candidate)
  } catch {
    // Missing file, missing documentDir, or a symlink loop realpath refuses
    // to resolve -- all denied the same way.
    return null
  }

  if (realCandidate !== realDocumentDir && !realCandidate.startsWith(realDocumentDir + path.sep)) {
    return null
  }

  const stats = await stat(realCandidate).catch(() => null)
  if (!stats || !stats.isFile()) return null

  return realCandidate
}

const ASSET_PATH_PREFIX = '/__asset__/'
// Exported so src/main/html-exporter.ts enforces the IDENTICAL cap when
// inlining a local image as a data: URI for HTML export -- one source of
// truth for "how big a local asset this app will ever read into memory on
// a document's behalf," rather than a second hand-copied 10 * 1024 * 1024
// that could silently drift from this one.
export const MAX_ASSET_BYTES = 10 * 1024 * 1024 // 10 MiB, per this plan's Global Constraints

// Real magic-byte sniffing, not a file-extension guess -- "content-type
// sniffed server-side... non-image types rejected" per the design doc.
// Checked against the file's actual leading bytes so a non-image file
// renamed to `.png` is correctly rejected rather than served as image/png.
// Exported (beyond what the brief's own Step 5 code block shows) so this
// specific security property -- content-byte sniffing, not extension
// matching -- is directly unit-testable: the protocol handler branch that
// calls this can only be exercised through a real Electron `session`, which
// a plain Vitest test can't construct, so testing the sniffer "indirectly"
// through the full request flow isn't practical here. Same testability
// rationale as resolveAssetPath's own exported-for-testing precedent above.
export function sniffImageContentType(buffer: Buffer): string | null {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString('latin1') === 'GIF87a' ||
      buffer.subarray(0, 6).toString('latin1') === 'GIF89a')
  ) {
    return 'image/gif'
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  // SVG: XML-based, no fixed magic bytes -- accept only if the sniffed text
  // genuinely looks like an SVG root element within the first 512 bytes
  // (mirrors how real browsers/servers commonly sniff SVG, without needing
  // a full XML parse just to classify content-type).
  const head = buffer.subarray(0, 512).toString('utf8')
  if (/<svg[\s>]/i.test(head)) {
    return 'image/svg+xml'
  }
  return null
}

// Keep this in sync with resources/pagination-render/index.html's CSP
// <meta http-equiv> tag — they must carry the identical policy. Previously
// the nonce was delivered ONLY via that <meta> tag; a `<meta
// http-equiv="Content-Security-Policy">` tag only takes effect once the HTML
// parser reaches it, so anything the parser processes before that point
// (there is nothing that currently does, but it costs nothing to close this
// off) would run under no CSP at all. Setting the identical policy as a
// real `Content-Security-Policy` response header as well covers the whole
// navigation from the very first byte, the way CSP is normally deployed.
//
// img-src permits https:/http: as a permanent, coarse backstop for the
// remote-image-consent feature — see index.html's own longer comment on
// this exact line for why the real per-document gate lives in
// src/markdown/pipeline.ts's stripRemoteImageSrcs instead, not here.
// connect-src stays 'none': this only ever permits passive `<img>` loads,
// never script-initiated fetch/XHR/WebSocket.
const CSP_POLICY_TEMPLATE =
  "default-src 'self'; style-src 'self' 'nonce-%%CSP_STYLE_NONCE%%'; script-src 'self'; img-src 'self' data: https: http:; font-src data:; connect-src 'none';"

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
//
// Exported (Split mode / Task 2 of the 2026-08-07-split-mode plan) so
// `split-preview-window.ts`'s own harness -- a second, visible
// WebContentsView attached to the real mainWindow, not the headless
// BaseWindow every existing harness uses -- can share this exact session
// and protocol-handler setup rather than duplicating this function's body.
// Verified empirically (not just by reading the comment above) that calling
// this a second time from a second harness module is genuinely safe: see
// split-preview-window.ts's own manual-verification notes.
export function ensureRenderInfraRegistered(): Session {
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

      // Local-asset requests are a separate namespace from the static
      // RENDER_ROOT bundle below -- checked first, since `__asset__` paths
      // never live under RENDER_ROOT and would otherwise just 404 out of
      // the generic branch below with no chance to actually serve them.
      if (url.pathname.startsWith(ASSET_PATH_PREFIX)) {
        const rest = url.pathname.slice(ASSET_PATH_PREFIX.length)
        const slashIndex = rest.indexOf('/')
        if (slashIndex === -1) return new Response('Not found', { status: 404 })

        const token = rest.slice(0, slashIndex)
        const encodedRelativePath = rest.slice(slashIndex + 1)
        const entry = assetRootRegistry.get(token)
        if (!entry) return new Response('Not found', { status: 404 })

        let relativePath: string
        try {
          relativePath = decodeURIComponent(encodedRelativePath)
        } catch {
          return new Response('Not found', { status: 404 })
        }

        const resolved = await resolveAssetPath(entry.documentDir, relativePath)
        if (!resolved) return new Response('Not found', { status: 404 })

        const stats = await stat(resolved).catch(() => null)
        if (!stats || stats.size > MAX_ASSET_BYTES)
          return new Response('Not found', { status: 404 })

        const body = await readFile(resolved).catch(() => null)
        if (!body) return new Response('Not found', { status: 404 })

        const contentType = sniffImageContentType(body)
        if (!contentType) return new Response('Not found', { status: 404 })

        // `X-Content-Type-Options: nosniff` alone is not enough for the
        // `image/svg+xml` case: the type here is DECLARED svg+xml (real
        // sniffing already confirmed the bytes genuinely look like one), and
        // SVG can carry <script> and event-handler attributes. nosniff only
        // stops a browser from re-interpreting the declared type -- it does
        // nothing once the declared type itself is script-capable. An <img>
        // load can't execute an embedded SVG's script (images are loaded in
        // "image mode", scripting disabled by spec) and the sanitize schema
        // already strips iframe/object/embed from rendered document HTML, so
        // there's no reachable path today -- but if this response is ever
        // loaded as its own document (iframe/object/embed, or a direct
        // navigation), a real per-resource CSP is what stops it from running
        // as an unrestricted document in the pagedown-render://render
        // origin. `default-src 'none'; sandbox;` is maximally strict (the
        // bare `sandbox` directive with no allow-* tokens denies scripts,
        // forms, and top-level navigation, same as an <iframe sandbox> with
        // no allowlist) and costs nothing for the ordinary PNG/JPEG/GIF/WebP
        // cases: CSP response headers are only enforced against the
        // document a response becomes, never against an <img> subresource
        // fetch, so this header is inert for every non-SVG asset response.
        return new Response(body, {
          headers: {
            'Content-Type': contentType,
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox;"
          }
        })
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
  // Local-asset loading: per-`<img>` intrinsic dimensions, measured in the
  // paginated output after every image settled (see
  // resources/pagination-render/index.ts's own `imageBoxes` comment). A
  // silently-404'd local image reference leaves an `<img>` that is present
  // AND `complete`, but zero-sized — so `naturalWidth > 0` is the only
  // genuine proof the bytes were actually served through the
  // `pagedown-render://` asset handler and decoded, exactly as
  // `diagramBoxes` above is the only genuine proof a Mermaid diagram really
  // rendered. `[]` for documents with no images.
  imageBoxes: Array<{
    src: string
    resolvedSrc: string
    naturalWidth: number
    naturalHeight: number
  }>
  // Editor page-break guides: one entry per page TRANSITION, naming the
  // top-level source block the break landed at or inside, recovered from the
  // `data-pd-block` stamps markdownToHtml emits (see
  // src/pagination/page-breaks.ts for the whole mechanism and its disclosed
  // block-granularity limitation). `[]` for a single-page document.
  pageBreaks: PageBreakPosition[]
}

export interface PaginationHarness {
  view: WebContentsView
  // `timeoutMs` defaults to DEFAULT_SEND_DOCUMENT_TIMEOUT_MS below when
  // omitted -- added (fix-round review, PDF export track) so a caller with
  // a heavier-than-routine workload (large-document PDF export) can ask for
  // a longer allowance than the default without changing that default for
  // every other caller (thumbnail generation, Phase 0 gates) that's always
  // been fine with it.
  //
  // `geometry` (Page Geometry Wiring) is REQUIRED, not defaulted here: this
  // harness has no document content of its own to derive a PageConfig from
  // (it only ever sees already-converted HTML), so every real caller must
  // compute it from the document's own frontmatter (Task 4's job) or from
  // DEFAULT_PAGE_CONFIG where there is deliberately no document to read one
  // from (see src/pagination/paginate.ts and the gate specs).
  //
  // `documentStyle` (Page Setup Completeness, Task 5) is REQUIRED for the
  // exact same reason and positioned right after `geometry`, before the
  // optional `timeoutMs`: this harness has no document content of its own
  // to derive a DocumentStyle from either, so every real caller computes it
  // via `resolveDocumentStyle` from the same PageConfig it already read
  // `geometry` from, or passes `DEFAULT_DOCUMENT_STYLE` where there is
  // deliberately no document (the gate specs).
  sendDocument(
    html: string,
    geometry: PageGeometry,
    documentStyle: DocumentStyle,
    timeoutMs?: number
  ): Promise<PaginationResult>
}

// The general-purpose default every existing caller (thumbnail-generator.ts,
// every gate) implicitly relied on before this became a real
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
export interface PaginationHarnessOptions {
  /**
   * Render this harness's view OFFSCREEN (Chromium's OSR mode) instead of
   * through a real compositor surface.
   *
   * Exists for exactly one consumer -- thumbnail-generator.ts -- and for one
   * reason: **`capturePage()` cannot capture a view inside a never-shown
   * `BaseWindow`.** It rejects with `Current display surface not available for
   * capture`, because there is no display surface. That was a real,
   * user-visible failure: the Home screen's template cards and recent-file
   * rows logged that error on every mount and rendered blank.
   *
   * Measured directly rather than reasoned about (probe against this exact
   * Electron build, three strategies, one page each):
   *
   *   neverShown_noOSR              -> "Current display surface not available"
   *   neverShown_OSR                -> ok, 1600x1200, non-empty
   *   show:false + offscreen window position -> same failure as the first
   *
   * So OSR is not a preference here, it is the only one of the three that
   * works. The third result also rules out the tempting "just move the window
   * off-screen" fix.
   *
   * Deliberately OPT-IN rather than applied to every harness. Page counting,
   * PDF export and the Split-mode preview never call `capturePage()` -- page
   * count reads no pixels at all, PDF export goes through `printToPDF`, and
   * the Split preview is a real on-screen view -- so none of them has the
   * problem this solves, and OSR would change their rendering path for no
   * benefit. It changes nothing about the sandbox: `sandbox`,
   * `contextIsolation`, `nodeIntegration` and the isolated `session` below
   * are untouched.
   */
  offscreen?: boolean
}

export async function createPaginationHarness(
  win: BaseWindow,
  options: PaginationHarnessOptions = {}
): Promise<PaginationHarness> {
  const renderSession = ensureRenderInfraRegistered()

  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: renderSession,
      // See PaginationHarnessOptions.offscreen -- opt-in, and the only way
      // capturePage() can succeed against a never-shown window.
      offscreen: options.offscreen === true,
      // No `preload` — this context has no bridge to Node/Electron APIs.
      //
      // Real-world defense-in-depth for the rAF-starvation bug fixed at its
      // actual source in resources/pagination-render/index.ts (see that
      // file's own comment on the `requestAnimationFrame` shim installed
      // there) — this alone does NOT fix that bug (confirmed empirically: it
      // did not unblock the reproduction described there), because the root
      // cause isn't Chromium's ordinary background-throttling *rate* (which
      // this flag governs) but a genuinely never-shown `BaseWindow`'s view
      // never receiving a real compositor frame callback AT ALL. Kept anyway
      // because it's a real, low-risk hardening against the *milder*,
      // well-documented throttling class this flag is designed for, on a
      // view that legitimately never needs to be de-prioritized.
      backgroundThrottling: false
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
  view.setBounds({ x: 0, y: 0, width: PAGE_WIDTH_PX, height: PAGE_HEIGHT_PX })
  await view.webContents.loadURL(`${RENDER_SCHEME}://${RENDER_HOST}/index.html`)

  async function sendDocument(
    html: string,
    geometry: PageGeometry,
    documentStyle: DocumentStyle,
    timeoutMs: number = DEFAULT_SEND_DOCUMENT_TIMEOUT_MS
  ): Promise<PaginationResult> {
    const requestId = randomUUID()
    // Built through an explicitly-typed local, not an inline object literal,
    // so a forgotten field (e.g. `geometry` or `documentStyle`) is a real
    // tsc error here rather than a silent runtime NaN/undefined in the
    // render context's `@page` rule -- see src/pagination/render-message.ts's
    // own header comment for the full rationale.
    const message: RenderRequestMessage = {
      type: 'render',
      html,
      requestId,
      geometry,
      documentStyle
    }
    await view.webContents.executeJavaScript(`window.postMessage(${JSON.stringify(message)}, '*')`)

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
          diagramBoxes: result.diagramBoxes ?? [],
          imageBoxes: result.imageBoxes ?? [],
          pageBreaks: result.pageBreaks ?? []
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
// regular sendDocument() path passes an `@page` rule that declares only
// `size` and `margin` and no margin-box rules at all, so no corpus document
// ever gets real running-header/footer/page-number content to inspect the
// tagging of. (It used to pass an empty stylesheet array; that changed with
// the Document Typography sub-project, but the consequence for THIS probe
// did not — margin boxes still need `@top-center`/`@bottom-center` rules
// nobody supplies.) This sends real `@page` CSS containing those margin-box
// rules alongside the body HTML so the render context actually generates
// that content once, for tests/gates/gate4-export.spec.ts to export and inspect.
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
