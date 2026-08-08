import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BaseWindow } from 'electron'
import { markdownToHtml } from '../markdown/pipeline'
import { resolvePageConfig } from '../markdown/page-config'
import { computePageGeometry } from '../typography/page-geometry'
import {
  createPaginationHarness,
  registerAssetRoot,
  unregisterAssetRoot,
  type PaginationHarness
} from './pagination-window'

const THUMBNAIL_DIR = 'thumbnails'
// 2x the largest on-screen display size (168px template cards) for crisp
// rendering at typical HiDPI scale factors, without generating a
// full-resolution page image nobody needs for a preview this small.
const THUMBNAIL_WIDTH = 336

// The on-disk thumbnail cache key. `documentDir` participates in it because
// rendered output genuinely depends on it once local assets load: two
// documents with byte-identical content living in different directories
// resolve `![x](./figures/chart.png)` to two DIFFERENT images, so keying on
// content alone would serve directory A's picture inside directory B's
// thumbnail. Omitting the directory (templates, and any document with no
// validated path) keeps the exact pre-existing key, so those cache entries
// are unaffected; documents that DO have a directory get a new key, which
// simply regenerates their thumbnail once.
export function hashContent(content: string, documentDir?: string | null): string {
  const hash = createHash('sha256')
  // A NUL separator, and only when a directory is present: NUL cannot appear
  // in a POSIX path or a Windows path, so within the has-a-directory
  // namespace, no `documentDir`/`content` pair can be confused for a
  // different one by concatenation. This does NOT domain-separate ACROSS the
  // has-directory/no-directory namespaces: the no-directory case emits no
  // separator at all (deliberately — see the doc comment above, preserving
  // the pre-existing content-only key), so e.g. hashContent('/a\0# Hi', null)
  // and hashContent('# Hi', '/a') hash identical bytes. Exotic (it requires a
  // NUL byte in real document content) and low-stakes (worst case is a wrong
  // cached preview image), not something this function's return value alone
  // protects against.
  if (documentDir) hash.update(`${documentDir}\0`, 'utf8')
  return hash.update(content, 'utf8').digest('hex')
}

// Serializes every call that actually dispatches into the shared harness
// below. Required because resources/pagination-render/index.ts's render
// context tracks only ONE in-flight request at a time (a single
// `currentRequestId` module variable) and silently drops the result of any
// request that isn't the most recently dispatched one — a second
// `sendDocument` call before the first's pagination finishes makes the
// first's eventual result vanish, and its caller in `pagination-window.ts`
// spins until its own 10s poll deadline and throws a timeout. This was
// never a problem for this harness's original callers (Phase 0 gates, each
// awaiting one full round trip before starting the next), but HomeScreen
// mounts several TemplateCard/RecentRow components in the same render
// pass, each independently calling getThumbnail on mount — a genuinely new
// concurrent-caller pattern this harness was never designed for. Found and
// verified via manual `pnpm dev` testing during the Home Screen
// sub-project's HomeScreen task: 2 of 3 concurrent calls failed with
// "Pagination harness timed out waiting for a result" before this fix;
// sequential calls always succeeded.
let harnessQueue: Promise<unknown> = Promise.resolve()

function enqueueHarnessWork<T>(task: () => Promise<T>): Promise<T> {
  const result = harnessQueue.then(task)
  // Chain the queue's tail through a value- and rejection-swallowing
  // continuation, not `result` directly — otherwise one rejected thumbnail
  // request would permanently wedge the queue, since a rejected promise
  // used as the next `.then()`'s receiver short-circuits every subsequent
  // `.then()` in the chain.
  harnessQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

let harnessPromise: Promise<PaginationHarness> | null = null
let harnessWindow: BaseWindow | null = null

// Lazily created, then reused for every getThumbnail call within this app
// session — deliberately a SEPARATE instance from the Phase-0-spike harness
// wired in src/main/index.ts (see this task's own design note: reusing that
// one would couple this feature to whatever the future live-preview
// sub-project does with it).
//
// Owns a dedicated, never-shown `BaseWindow` (`show: false`, and never
// `.show()`-ed after construction) rather than accepting the caller's real
// `mainWindow`, which was the previous design and is a confirmed,
// independently-measured bug: a WebContentsView positioned off-canvas
// inside a REAL, shown BaseWindow still gets Chromium's rendering-throttle
// treatment (requestAnimationFrame serviced at ~2Hz instead of ~60Hz)
// because it isn't actually being composited, and Paged.js's Chunker drives
// its whole progressive-layout loop off rAF. Measured consequence: a
// ~12-page document landed right at the harness's 10s timeout and a
// ~30-page document failed outright every time. `setVisible(false)` on the
// view was tested too and is equally broken — the fix has to be a window
// that is never shown at all, not one merely hidden after creation. A view
// filling a genuinely never-shown BaseWindow is not throttled — restores
// flat ~300ms pagination even for large documents. Off-canvas
// `setBounds({ x: -9999, ... })` positioning is no longer needed now that
// the harness lives in a window nothing ever displays, so it's dropped
// entirely rather than kept as defensive-but-pointless belt-and-suspenders.
function getHarness(): Promise<PaginationHarness> {
  if (!harnessPromise) {
    const win = new BaseWindow({ show: false })
    harnessWindow = win
    harnessPromise = createPaginationHarness(win).then((harness) => {
      // If the underlying WebContentsView is ever destroyed (e.g. via
      // destroyThumbnailHarness below, or some future unexpected teardown
      // of harnessWindow), drop the memoized promise so the NEXT
      // getThumbnail call creates a fresh harness instead of silently
      // failing every cache-miss request for the rest of the app session
      // against a dead view.
      harness.view.webContents.once('destroyed', () => {
        harnessPromise = null
      })
      return harness
    })
  }
  return harnessPromise
}

// Destroys the dedicated, never-shown BaseWindow backing the thumbnail
// pagination harness, if one has been created. Must be called at the same
// point the app decides its last real window has closed (see
// src/main/index.ts's `createWindow`/`window-all-closed` wiring) — a
// BaseWindow that's never destroyed keeps `BaseWindow.getAllWindows()` from
// ever returning to zero, which silently prevents `window-all-closed` from
// firing on Windows/Linux, leaving the app running invisibly forever after
// the user closes what looks like the last window. This exact regression
// was hit once already tonight by the parallel track that built the
// dedicated-window pattern first; this is the fix carried over. Safe to
// call even when no harness was ever created (e.g. the user never visited
// Home screen) or when it's already been destroyed.
export function destroyThumbnailHarness(): void {
  const win = harnessWindow
  harnessWindow = null
  harnessPromise = null
  if (win && !win.isDestroyed()) {
    win.destroy()
  }
}

async function cachePaths(
  userDataDir: string,
  hash: string
): Promise<{ pngPath: string; jsonPath: string }> {
  const dir = join(userDataDir, THUMBNAIL_DIR)
  await mkdir(dir, { recursive: true })
  return { pngPath: join(dir, `${hash}.png`), jsonPath: join(dir, `${hash}.json`) }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Renders `content` to a cached PNG thumbnail.
 *
 * `documentPath` is OPTIONAL and is the document's own on-disk path, used
 * only to resolve local asset references (`![x](./figures/chart.png)`)
 * against its directory. Callers must pass it ONLY for a path they have
 * already validated — `src/main/index.ts`'s `file:getThumbnail` handler
 * passes the path it just checked with `isKnownPath`. Omitting it (template
 * thumbnails, and any document with no validated path) is not a degraded
 * mode to be worked around: it is exactly how "a document with no real
 * directory denies all local assets" is enforced, since without a token
 * `markdownToHtml` leaves image srcs completely untouched and the render
 * context has nothing to resolve them against.
 */
export async function getThumbnail(
  content: string,
  userDataDir: string,
  documentPath?: string
): Promise<{ dataUrl: string; pageCount: number }> {
  const documentDir = documentPath ? dirname(documentPath) : null
  const hash = hashContent(content, documentDir)
  const { pngPath, jsonPath } = await cachePaths(userDataDir, hash)

  try {
    const [png, meta] = await Promise.all([readFile(pngPath), readFile(jsonPath, 'utf8')])
    const { pageCount } = JSON.parse(meta) as { pageCount: number }
    return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, pageCount }
  } catch {
    // Cache miss (either file missing or unparseable) — fall through to
    // generation below. A partially-corrupt cache entry degrades to a full
    // regeneration rather than a hard failure.
  }

  return enqueueHarnessWork(async () => {
    const harness = await getHarness()
    // Registered INSIDE the enqueued body and released in a `finally` that
    // wraps the whole body, not just the sendDocument call: the render
    // context still needs to fetch the images while it paints, and
    // capturePage() below happens well after sendDocument resolves.
    // Unregistering any earlier would produce a thumbnail whose images
    // 404'd for no visible reason. Skipped entirely (rather than called with
    // a placeholder) when there's no document directory — registerAssetRoot
    // throws on a non-absolute path by design, and a document with no
    // validated path must load no local assets at all.
    const assetToken = documentDir ? registerAssetRoot(documentDir) : undefined
    try {
      const { html } = markdownToHtml(content, { assetToken })
      // The document's own page size/orientation/margins, read out of its
      // real YAML frontmatter (Page Geometry Wiring) -- an A4 or landscape
      // document's thumbnail has to be that shape, not a fixed Letter one.
      // `resolvePageConfig` merges over DEFAULT_PAGE_CONFIG, so a document
      // with no frontmatter (every template) still yields a complete config.
      const geometry = computePageGeometry(resolvePageConfig(content))
      const result = await harness.sendDocument(html, geometry)

      // sendDocument resolves once the render context publishes its result,
      // immediately after Paged.js finishes mutating the DOM — nothing
      // guarantees the compositor has actually painted that frame yet.
      // Waiting two animation frames (not one — the first rAF fires before
      // the current frame is presented, the callback passed to it fires
      // after) is the standard "wait for the next real paint" pattern.
      // Without this, a mis-timed capture could be cached permanently under
      // the wrong content's hash.
      await withTimeout(
        harness.view.webContents.executeJavaScript(
          'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'
        ),
        5_000,
        'Timed out waiting for the render context to paint before capturing a thumbnail'
      )

      const image = await harness.view.webContents.capturePage()
      if (image.isEmpty()) {
        throw new Error('Captured thumbnail image was empty — refusing to cache a blank result')
      }
      const resized = image.resize({ width: THUMBNAIL_WIDTH })
      const png = resized.toPNG()

      await writeFile(pngPath, png)
      await writeFile(jsonPath, JSON.stringify({ pageCount: result.pageCount }))

      return { dataUrl: resized.toDataURL(), pageCount: result.pageCount }
    } finally {
      if (assetToken) unregisterAssetRoot(assetToken)
    }
  })
}
