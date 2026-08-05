import { test, expect, type ElectronApplication } from '@playwright/test'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'

let app: ElectronApplication
let close: () => Promise<void>

test.beforeAll(async () => {
  const isolated = await launchIsolatedApp(['out/main/index.js'])
  app = isolated.app
  close = isolated.close
  await app.firstWindow()
})

test.afterAll(async () => {
  await close()
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

  // Generated inline (not read from phase0/corpus/) so this test has no
  // dependency on a corpus fixture that might get regenerated/recalibrated
  // for unrelated reasons (see the phase0 findings doc's own history of
  // long.md/very-long.md's section-to-page ratio being recalibrated twice).
  // ~4.33 sections/page (measured in phase0/corpus/generate-long.ts's own
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
