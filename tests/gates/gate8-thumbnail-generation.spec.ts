import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../../src/main/recent-files'
import { launchIsolatedApp } from './electron-launch'
import {
  ONE_PX_PNG,
  TWO_PX_PNG,
  assetUrlPattern,
  readImageBoxes,
  writeFixtureFile
} from './asset-evidence'

let app: ElectronApplication
let close: () => Promise<void>

test.beforeAll(async () => {
  const isolated = await launchIsolatedApp(['out/main/index.js'])
  app = isolated.app
  close = isolated.close
  await app.firstWindow()
})

test.afterAll(async () => {
  // Guarded: if beforeAll's launchIsolatedApp itself threw, `close` was
  // never assigned, and an unguarded call here would mask that real
  // failure with a TypeError.
  if (close) await close()
})

test('Gate 8: getThumbnail generates a real PNG, caches it, and reports a correct page count', async () => {
  const userDataDir = await app.evaluate(({ app }) => app.getPath('userData'))

  const first = await app.evaluate(async (_electron, dir) => {
    const globalAny = global as unknown as {
      __pagedownPhase0: {
        getThumbnail: (
          content: string,
          dir: string
        ) => Promise<{ dataUrl: string; pageCount: number }>
      }
    }
    return globalAny.__pagedownPhase0.getThumbnail('# Gate 8 Fixture\n\nOne page of content.', dir)
  }, userDataDir)

  expect(first.dataUrl).toMatch(/^data:image\/png;base64,/)
  expect(first.pageCount).toBeGreaterThanOrEqual(1)

  const thumbnailFiles = await readdir(join(userDataDir, 'thumbnails'))
  expect(thumbnailFiles.some((f) => f.endsWith('.png'))).toBe(true)

  const pngFile = thumbnailFiles.find((f) => f.endsWith('.png'))!
  const stats = await stat(join(userDataDir, 'thumbnails', pngFile))
  expect(stats.size).toBeGreaterThan(0)

  // Second call for identical content must be a cache hit: same dataUrl,
  // no new file appears, and — the real proof it didn't regenerate, since
  // the deterministic hash-derived filename and deterministic render output
  // mean a regression that always regenerates would still produce the same
  // filename and likely the same bytes — the existing file's mtime is
  // unchanged (an overwrite-on-regenerate would bump it even if the bytes
  // happened to come out identical).
  const filesBefore = (await readdir(join(userDataDir, 'thumbnails'))).length
  const statsBeforeSecondCall = await stat(join(userDataDir, 'thumbnails', pngFile))
  const mtimeBeforeSecondCall = statsBeforeSecondCall.mtimeMs
  const second = await app.evaluate(async (_electron, dir) => {
    const globalAny = global as unknown as {
      __pagedownPhase0: {
        getThumbnail: (
          content: string,
          dir: string
        ) => Promise<{ dataUrl: string; pageCount: number }>
      }
    }
    return globalAny.__pagedownPhase0.getThumbnail('# Gate 8 Fixture\n\nOne page of content.', dir)
  }, userDataDir)
  const filesAfter = (await readdir(join(userDataDir, 'thumbnails'))).length

  expect(second.dataUrl).toBe(first.dataUrl)
  expect(second.pageCount).toBe(first.pageCount)
  expect(filesAfter).toBe(filesBefore)

  const statsAfterSecondCall = await stat(join(userDataDir, 'thumbnails', pngFile))
  expect(statsAfterSecondCall.mtimeMs).toBe(mtimeBeforeSecondCall)
})

// Regression test for a real, verified bug: getHarness() used to position its
// pagination-rendering WebContentsView off-canvas (setBounds({ x: -9999, ... }))
// inside the caller's REAL, shown BaseWindow (mainWindow). A WebContentsView
// that isn't actually being composited inside a shown window gets Chromium's
// rendering-throttle treatment — requestAnimationFrame serviced at ~2Hz
// instead of ~60Hz — and Paged.js's Chunker depends on rAF for its whole
// progressive page-layout loop. Measured, reproducible consequence before the
// fix: a ~13-page document (this test's own fixture size) took ~11.8s,
// already past the harness's 10s poll deadline, and a ~30-page document
// failed outright every time with "Pagination harness timed out waiting for a
// result". `setVisible(false)` on the view was tested too and is equally
// broken; the fix is a genuinely separate, dedicated BaseWindow created with
// `show: false` and never shown at all (see thumbnail-generator.ts's
// getHarness). This asserts real wall-clock elapsed time, not just that the
// call eventually resolves, since "eventually resolves" is exactly what a
// reintroduced throttling regression would still technically do, right up
// until it exceeds the 10s timeout.
test('Gate 8 regression: a ~13-page document paginates well under the harness timeout (throttled-WebContentsView fix)', async () => {
  const userDataDir = await app.evaluate(({ app }) => app.getPath('userData'))

  // Generated inline (not read from tests/gates/corpus/) so this test has no
  // dependency on a corpus fixture that might get regenerated/recalibrated
  // for unrelated reasons (see the phase0 findings doc's own history of
  // long.md/very-long.md's section-to-page ratio being recalibrated twice).
  // ~4.33 sections/page (measured in tests/gates/corpus/generate-long.ts's own
  // calibration) x 52 sections targets ~12 pages — squarely inside the
  // bug's confirmed failure range (12-page: ~11.8s, over the 10s timeout;
  // 30-page: failed outright) without this test itself taking long to run.
  const paragraphs = [
    'The committee reviewed the quarterly submission and found the methodology sound, though several reviewers noted that the sampling window could be extended in future cycles to capture seasonal variation.',
    'Subsequent analysis revealed a consistent pattern across all four regions, with the northern district showing the most pronounced deviation from the projected baseline established in the prior fiscal year.',
    'It is recommended that the working group reconvene no later than the end of next month to finalize the revised timeline and communicate any changes to the affected stakeholders in writing.'
  ]
  let content = '---\ntitle: Gate 8 Regression Fixture\npage: A4\nmargins: 1in\n---\n\n'
  for (let section = 1; section <= 52; section++) {
    content += `## Section ${section}\n\n`
    content += `${paragraphs[section % paragraphs.length]}\n\n`
    content += `${paragraphs[(section + 1) % paragraphs.length]}\n\n`
  }

  const start = Date.now()
  const result = await app.evaluate(
    async (_electron, args) => {
      const globalAny = global as unknown as {
        __pagedownPhase0: {
          getThumbnail: (
            content: string,
            dir: string
          ) => Promise<{ dataUrl: string; pageCount: number }>
        }
      }
      return globalAny.__pagedownPhase0.getThumbnail(args.content, args.dir)
    },
    { content, dir: userDataDir }
  )
  const elapsedMs = Date.now() - start

  expect(result.dataUrl).toMatch(/^data:image\/png;base64,/)
  expect(result.pageCount).toBeGreaterThanOrEqual(10)

  // Measured post-fix: ~350-450ms for a fixture this size (well under 1s).
  // 6s leaves generous headroom for a slower CI machine while staying
  // nowhere near the harness's 10s poll deadline the pre-fix throttled path
  // used to hit almost exactly (~11.8s) -- a reintroduced throttling
  // regression would blow well past this bound, not just marginally miss it.
  expect(elapsedMs).toBeLessThan(6_000)
})

// --- Local asset loading (2026-08-05 sub-project) --------------------------
//
// Local image references in a Markdown document silently 404'd against the
// `pagedown-render://` scheme since this project began (already recorded, as
// a deliberately-asserted gap, in tests/gates/gate4-export.spec.ts). These cases
// prove the fix end to end through the REAL chain -- real `window.api`
// contextBridge call, real `isKnownPath` validation, real `readFileByPath`,
// real `registerAssetRoot`, the REAL `markdownToHtml` src rewrite, and the
// real `pagedown-render://` protocol handler -- and prove that the
// document-directory confinement the rewrite rests on actually holds against
// real traversal attempts.
//
// Deliberately driven through the renderer page's `window.api.getThumbnail`
// rather than this file's older `__pagedownPhase0.getThumbnail` bridge calls
// above: CLAUDE.md states the renderer-page pattern (Gate 9's convention) is
// preferred for new gates, and only that path exercises the `file:
// getThumbnail` IPC handler's own `isKnownPath` check and its new
// filePath-forwarding.

// Same pattern as gate9/gate11/gate12's own `getMainWindow` -- this app
// launches a SECOND window at startup (the Phase 0 spike's sandboxed
// `pagedown-render://` harness), and `firstWindow()` races between the two.
// Matched by a POSITIVE `file://` check for the reason gate9 documents:
// every window starts on `about:blank` before its real navigation completes.
async function getMainWindow(application: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    for (const candidate of application.windows()) {
      try {
        await candidate.waitForLoadState('domcontentloaded', { timeout: 500 })
      } catch {
        continue
      }
      if (candidate.url().startsWith('file://')) return candidate
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out locating the main app-shell window (only found the sandboxed one)')
}

// Adds `filePath` to the real recent-files allowlist `isKnownPath` reads, so
// the real `file:getThumbnail` handler will accept it. Writes into the
// ISOLATED userData directory `launchIsolatedApp` created (not the
// developer's real one), which is torn down wholesale by `close()` -- so
// unlike tests/gates/gate11-editor-save-race.spec.ts this needs no backup/restore
// of an original file.
async function seedRecentFile(userDataDir: string, filePath: string): Promise<void> {
  const existing = await readRecentFiles(userDataDir)
  await writeRecentFiles(
    userDataDir,
    mergeRecentFiles(existing, filePath, new Date().toISOString())
  )
}

async function getThumbnailViaApi(win: Page, filePath: string): Promise<{ pageCount: number }> {
  return win.evaluate(async (path) => {
    const result = await (
      window as unknown as {
        api: { getThumbnail: (f: string) => Promise<{ dataUrl: string; pageCount: number }> }
      }
    ).api.getThumbnail(path)
    // Only the page count crosses back -- a full base64 data URL is a large,
    // pointless payload to serialize through evaluate(), and the real
    // image-loading evidence comes from the render context's own imageBoxes
    // measurements, not from the captured PNG.
    return { pageCount: result.pageCount }
  }, filePath)
}

test('Gate 8: a local relative image reference in the document actually loads (not silently 404ing)', async () => {
  test.setTimeout(90_000)

  const win = await getMainWindow(app)
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
  const userDataDir = await app.evaluate(({ app }) => app.getPath('userData'))

  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate8-assets-'))
  const nonce = randomBytes(6).toString('hex')

  try {
    // A plain nested relative path, plus a SECOND reference whose filename
    // carries a space and a non-ASCII character. The second one is the real
    // "realistic input" check for the pipeline<->protocol-handler seam: mdast
    // percent-encodes those characters on its own before `markdownToHtml`'s
    // rewrite ever sees the src, the rewrite decodes that layer and
    // re-encodes the whole path as ONE opaque segment, and the protocol
    // handler decodes exactly once -- a mismatch anywhere in that chain
    // produces a filename that doesn't exist on disk and silently 404s.
    const plainImagePath = join(fixtureDir, 'figures', `chart-${nonce}.png`)
    const awkwardImagePath = join(fixtureDir, 'figures', `chärt one-${nonce}.png`)
    await writeFixtureFile(plainImagePath, ONE_PX_PNG)
    await writeFixtureFile(awkwardImagePath, ONE_PX_PNG)

    const docPath = join(fixtureDir, `doc-${nonce}.md`)
    await writeFixtureFile(
      docPath,
      `# Gate 8 asset fixture ${nonce}\n\n` +
        `![chart](./figures/chart-${nonce}.png)\n\n` +
        `![awkward](<./figures/chärt one-${nonce}.png>)\n`
    )
    await seedRecentFile(userDataDir, docPath)

    const result = await getThumbnailViaApi(win, docPath)
    expect(result.pageCount).toBeGreaterThanOrEqual(1)

    const boxes = await readImageBoxes(app, `chart-${nonce}.png`)
    expect(boxes).toHaveLength(2)

    const plain = boxes.find((box) => box.src.includes(`chart-${nonce}.png`))!
    const awkward = boxes.find((box) => box.src.includes(`one-${nonce}.png`))!

    // Seam obligation: the src actually requested is the one this project's
    // REAL rewrite produced -- asset scheme, a fresh 32-hex-char per-render
    // token, and the relative path as one encodeURIComponent'd segment.
    expect(plain.src).toMatch(assetUrlPattern(`.%2Ffigures%2Fchart-${nonce}.png`))
    expect(awkward.src).toMatch(assetUrlPattern(`.%2Ffigures%2Fch%C3%A4rt%20one-${nonce}.png`))

    // Seam obligation: Chromium's own WHATWG URL parse -- the same
    // normalization `new URL(request.url)` performs inside the protocol
    // handler -- does not mangle either URL. The token segment survives
    // intact and the encoded path segment is byte-identical, so what the
    // handler splits on `/` and `decodeURIComponent`s is exactly what the
    // pipeline intended.
    expect(plain.resolvedSrc).toBe(plain.src)
    expect(awkward.resolvedSrc).toBe(awkward.src)

    // The actual proof the bytes were served AND decoded: the intrinsic size
    // matches the real 1x1 PNG written above. A silent 404 reads 0x0 here
    // (that exact signature is what tests/gates/gate4-export.spec.ts asserts for
    // the corpus's still-unserved images), so this also confirms that Task
    // 1's `Content-Security-Policy: default-src 'none'; sandbox;` response
    // header on asset responses does NOT interfere with an ordinary <img>
    // subresource load -- CSP response headers only govern the document a
    // response becomes, never an image fetch.
    expect(plain.naturalWidth).toBe(1)
    expect(plain.naturalHeight).toBe(1)
    expect(awkward.naturalWidth).toBe(1)
    expect(awkward.naturalHeight).toBe(1)
  } finally {
    await rm(fixtureDir, { recursive: true, force: true })
  }
})

test('Gate 8: a local image reference using ../ escaping the document directory does NOT load', async () => {
  test.setTimeout(90_000)

  const win = await getMainWindow(app)
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
  const userDataDir = await app.evaluate(({ app }) => app.getPath('userData'))

  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate8-traversal-'))
  const nonce = randomBytes(6).toString('hex')

  try {
    // Two REAL, valid, decodable 2x2 PNGs placed two directories ABOVE the
    // document -- the denial under test must be genuine confinement, not the
    // incidental "that file doesn't exist" 404 a nonexistent target would
    // produce. A traversal that wrongly succeeded would read 2x2 here, which
    // no in-tree fixture in these gates ever produces.
    const plainSecretPath = join(fixtureDir, `secret-plain-${nonce}.png`)
    const rawSecretPath = join(fixtureDir, `secret-raw-${nonce}.png`)
    await writeFixtureFile(plainSecretPath, TWO_PX_PNG)
    await writeFixtureFile(rawSecretPath, TWO_PX_PNG)
    expect((await stat(plainSecretPath)).size).toBeGreaterThan(0)
    expect((await stat(rawSecretPath)).size).toBeGreaterThan(0)

    const docPath = join(fixtureDir, 'doc', 'sub', `doc-${nonce}.md`)
    await writeFixtureFile(
      docPath,
      `# Gate 8 traversal fixture ${nonce}\n\n` +
        // A plain Markdown `../../` escape...
        `![escape](../../secret-plain-${nonce}.png)\n\n` +
        // ...and a percent-encoded raw-HTML one. `%2e%2e` is `..` after a
        // single decode, so this specifically probes whether encoding the
        // dot-segments smuggles them past the rewrite and the handler.
        `<img src="%2e%2e/%2e%2e/secret-raw-${nonce}.png" alt="encoded escape">\n`
    )
    await seedRecentFile(userDataDir, docPath)

    const result = await getThumbnailViaApi(win, docPath)
    expect(result.pageCount).toBeGreaterThanOrEqual(1)

    const boxes = await readImageBoxes(app, `secret-plain-${nonce}.png`)
    expect(boxes).toHaveLength(2)

    const plain = boxes.find((box) => box.src.includes(`secret-plain-${nonce}.png`))!
    const raw = boxes.find((box) => box.src.includes(`secret-raw-${nonce}.png`))!

    // Both traversal attempts are rewritten into real, token-bearing asset
    // URLs and really dispatched -- this is a genuine end-to-end request
    // through the live protocol handler, not `resolveAssetPath` checked in
    // isolation. Note the percent-encoded raw-HTML form normalizes to the
    // identical shape as the plain one: `markdownToHtml`'s rewrite decodes
    // the author's encoding layer before re-encoding the path as one
    // segment, so `%2e%2e` never reaches the handler as a way to hide `..`.
    expect(plain.src).toMatch(assetUrlPattern(`..%2F..%2Fsecret-plain-${nonce}.png`))
    expect(raw.src).toMatch(assetUrlPattern(`..%2F..%2Fsecret-raw-${nonce}.png`))
    expect(plain.resolvedSrc).toBe(plain.src)
    expect(raw.resolvedSrc).toBe(raw.src)

    // Denied by the handler: 0x0, not the 2x2 the out-of-tree files really
    // decode to.
    expect(plain.naturalWidth).toBe(0)
    expect(plain.naturalHeight).toBe(0)
    expect(raw.naturalWidth).toBe(0)
    expect(raw.naturalHeight).toBe(0)
  } finally {
    await rm(fixtureDir, { recursive: true, force: true })
  }
})

test('Gate 8: a relative path of exactly ".." collapses under URL normalization and is denied', async () => {
  test.setTimeout(90_000)

  // Pins a low-severity but genuinely untested corner, so nobody later
  // "fixes" it into something worse. `encodeURIComponent('..')` is `..`
  // (neither dot is a reserved character), so the rewrite emits a BARE `..`
  // path segment -- and WHATWG URL parsing removes dot segments, popping the
  // token segment off entirely before the request ever reaches the protocol
  // handler. The result names no registered asset root at all, so it is
  // still a denial (Chromium strips the traversal before the app sees it),
  // just not via the confinement check in `resolveAssetPath`.
  const win = await getMainWindow(app)
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
  const userDataDir = await app.evaluate(({ app }) => app.getPath('userData'))

  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate8-dotdot-'))
  const nonce = randomBytes(6).toString('hex')

  try {
    // An ordinary sibling image acts as this case's own control: it proves
    // the render really happened and really CAN serve assets from this
    // document's directory, so the `..` reference's failure is about the
    // `..` and nothing else.
    const anchorPath = join(fixtureDir, `anchor-${nonce}.png`)
    await writeFixtureFile(anchorPath, ONE_PX_PNG)

    const docPath = join(fixtureDir, `doc-${nonce}.md`)
    await writeFixtureFile(
      docPath,
      `# Gate 8 bare dot-dot fixture ${nonce}\n\n` +
        `![up](..)\n\n` +
        `![anchor](./anchor-${nonce}.png)\n`
    )
    await seedRecentFile(userDataDir, docPath)

    await getThumbnailViaApi(win, docPath)

    const boxes = await readImageBoxes(app, `anchor-${nonce}.png`)
    expect(boxes).toHaveLength(2)

    const anchor = boxes.find((box) => box.src.includes(`anchor-${nonce}.png`))!
    const dotdot = boxes.find((box) => box.src.endsWith('/..'))!

    expect(anchor.naturalWidth).toBe(1)

    // What the rewrite emitted: a real token followed by a bare `..`.
    expect(dotdot.src).toMatch(assetUrlPattern('..'))
    // What Chromium actually requested: the token is gone, dot-segment
    // removal having popped it and left a trailing empty segment. The
    // handler's `/__asset__/` prefix check still matches, but there is no
    // `/` left after it to split a token off, so it 404s.
    expect(dotdot.resolvedSrc).toBe('pagedown-render://render/__asset__/')
    expect(dotdot.naturalWidth).toBe(0)
    expect(dotdot.naturalHeight).toBe(0)
  } finally {
    await rm(fixtureDir, { recursive: true, force: true })
  }
})
