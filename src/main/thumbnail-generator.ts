import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { BaseWindow } from 'electron'
import { markdownToHtml } from '../markdown/pipeline'
import { createPaginationHarness, type PaginationHarness } from './pagination-window'

const THUMBNAIL_DIR = 'thumbnails'
// 2x the largest on-screen display size (168px template cards) for crisp
// rendering at typical HiDPI scale factors, without generating a
// full-resolution page image nobody needs for a preview this small.
const THUMBNAIL_WIDTH = 336

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
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

// Lazily created, then reused for every getThumbnail call within this app
// session — deliberately a SEPARATE instance from the Phase-0-spike harness
// wired in src/main/index.ts (see this task's own design note: reusing that
// one would couple this feature to whatever the future live-preview
// sub-project does with it).
function getHarness(win: BaseWindow): Promise<PaginationHarness> {
  if (!harnessPromise) {
    harnessPromise = createPaginationHarness(win).then((harness) => {
      harness.view.setBounds({ x: -9999, y: -9999, width: 816, height: 1056 })
      return harness
    })
  }
  return harnessPromise
}

async function cachePaths(
  userDataDir: string,
  hash: string
): Promise<{ pngPath: string; jsonPath: string }> {
  const dir = join(userDataDir, THUMBNAIL_DIR)
  await mkdir(dir, { recursive: true })
  return { pngPath: join(dir, `${hash}.png`), jsonPath: join(dir, `${hash}.json`) }
}

export async function getThumbnail(
  win: BaseWindow,
  content: string,
  userDataDir: string
): Promise<{ dataUrl: string; pageCount: number }> {
  const hash = hashContent(content)
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
    const harness = await getHarness(win)
    const { html } = markdownToHtml(content)
    const result = await harness.sendDocument(html)

    const image = await harness.view.webContents.capturePage()
    const resized = image.resize({ width: THUMBNAIL_WIDTH })
    const png = resized.toPNG()

    await writeFile(pngPath, png)
    await writeFile(jsonPath, JSON.stringify({ pageCount: result.pageCount }))

    return { dataUrl: resized.toDataURL(), pageCount: result.pageCount }
  })
}
