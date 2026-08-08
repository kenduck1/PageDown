import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'
import { ONE_PX_PNG, TWO_PX_PNG, writeFixtureFile, readImageBoxes } from './asset-evidence'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'

// Real, end-to-end coverage for the new `file:exportPdf` IPC surface
// (src/main/pdf-exporter.ts / src/main/index.ts / src/preload/index.ts):
// a real renderer-page `window.api.exportPdf(content)` call, through the
// real contextBridge, into the real main-process handler, through this
// project's real pagination harness + `printToPDF` (src/export/export-pdf.ts,
// unchanged here), landing a real PDF file on a real path on disk. Uses
// `launchIsolatedApp` (phase0/electron-launch.ts), NOT a bare
// `electron.launch()` call -- a bare call resolves Electron's default
// userData path to the SAME directory a developer's own interactively-run
// app instance uses, which previously left real, lasting damage to a real
// recent-files.json (see electron-launch.ts's own comment and the commit
// that introduced it).
//
// `dialog.showSaveDialog` is a real native OS modal that would otherwise
// hang this test forever waiting for a human -- monkey-patched via
// `app.evaluate()` before triggering the export, exactly the same
// "electron argument is passed directly into the callback, no require()/
// dynamic import needed" mechanism gate2/gate11 already rely on for
// reaching `app`/`BaseWindow`. This is the ONE legitimate way found to
// make a real Save dialog deterministic in this environment; every other
// piece of the pipeline (harness, pagination, printToPDF, disk write) runs
// for real, unmocked.
//
// Same pattern as gate9/gate10/gate11's own `getMainWindow`: this app
// launches a SECOND window at startup (src/main/index.ts's Phase 0 spike
// `createPaginationHarness(mainWindow)` wiring), whose page loads under the
// sandboxed `pagedown-render://` scheme with zero contextBridge/`window.api`
// access. Matched by a POSITIVE `file://` check (not a negative exclusion)
// for the same reason documented there: every window starts on
// `about:blank` before its real navigation completes, which a
// negative-only filter would misidentify.
async function getMainWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      try {
        await candidate.waitForLoadState('domcontentloaded', { timeout: 500 })
      } catch {
        continue
      }
      if (candidate.url().startsWith('file://')) {
        return candidate
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out locating the main app-shell window (only found the sandboxed one)')
}

const CLOSE_TIMEOUT_MS = 15_000

// Bounded close(), matching gate15-split-mode.spec.ts / gate16-page-geometry.
// spec.ts. CLAUDE.md records that the tests already in THIS file use a bare,
// unwrapped close() -- a known, accepted gap -- and that repeated
// launch/close cycles under host load can hang indefinitely at app.close(),
// leaking a live 6+-process Electron tree. Retrofitting the pre-existing
// tests here is out of this task's scope, but the A4 test added at the
// bottom of this file uses this rather than copying the unsafe pattern.
async function safeClose(app: ElectronApplication, close: () => Promise<void>): Promise<void> {
  const closeOutcome = close().then(
    () => 'closed' as const,
    () => 'closed' as const
  )
  const outcome = await Promise.race([
    closeOutcome,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), CLOSE_TIMEOUT_MS))
  ])
  if (outcome === 'timeout') {
    try {
      app.process().kill('SIGKILL')
    } catch {
      // Best-effort; the process may already be gone.
    }
  }
}

const SAMPLE_MARKDOWN = '# Gate 13 Export\n\nA real paragraph of exported content.\n'

test('Gate 13: window.api.exportPdf writes a real PDF file to the chosen path', async () => {
  test.setTimeout(60_000)

  const { app, close } = await launchIsolatedApp(['.'])
  const win = await getMainWindow(app)
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate13-'))
  const targetPath = join(fixtureDir, 'gate13-export.pdf')

  try {
    // Real `dialog` module, real `showSaveDialog` override -- see this
    // file's own module comment for why this is the one piece that has to
    // be faked (a real native Save dialog can't be driven headlessly) and
    // why `app.evaluate()` is a safe way to reach `dialog` directly.
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (() =>
        Promise.resolve({ canceled: false, filePath })) as typeof dialog.showSaveDialog
    }, targetPath)

    const result = await win.evaluate((content) => {
      const api = (window as unknown as { api: { exportPdf: (c: string) => Promise<unknown> } }).api
      return api.exportPdf(content)
    }, SAMPLE_MARKDOWN)

    expect(result).toEqual({ filePath: targetPath })

    const stats = await stat(targetPath)
    expect(stats.size).toBeGreaterThan(0)

    const buffer = await readFile(targetPath)
    // The real PDF magic bytes -- the minimum bar for "this is genuinely a
    // PDF file," not just a non-empty file written to the right path.
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  } finally {
    await rm(fixtureDir, { recursive: true, force: true })
  }

  await close()
})

test('Gate 13: window.api.exportPdf resolves to null (writes nothing) when the Save dialog is cancelled', async () => {
  test.setTimeout(60_000)

  const { app, close } = await launchIsolatedApp(['.'])
  const win = await getMainWindow(app)
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: true, filePath: '' })) as typeof dialog.showSaveDialog
  })

  const result = await win.evaluate((content) => {
    const api = (window as unknown as { api: { exportPdf: (c: string) => Promise<unknown> } }).api
    return api.exportPdf(content)
  }, SAMPLE_MARKDOWN)

  expect(result).toBeNull()

  await close()
})

// Fix-round regression guard. The ORIGINAL src/main/pdf-exporter.ts
// memoized a single pagination harness across every export call within an
// app session -- verified (fix-round review) to make every export after
// the first ~12x slower: six consecutive exports of the same 60-paragraph
// document measured 325ms, then 3642/4000/4044/3975/4059ms. Concretely, a
// ~10-page document exported fine as the FIRST export of a session but
// failed outright ("Pagination harness timed out waiting for a result") as
// a LATER export in the same session, once the ~12x-slower steady state
// pushed it past sendDocument's timeout. The original version of this gate
// only ever exported once per launched app and structurally could not have
// caught this -- it always measured the "first export" case, never a
// later one. This test exports the same multi-paragraph document THREE
// times in one app session and asserts later exports don't degrade,
// closing that gap. The fix (src/main/pdf-exporter.ts): a fresh,
// single-use pagination harness per export call instead of one memoized
// across calls.
test('Gate 13: exporting the same multi-paragraph document repeatedly in one app session does not degrade', async () => {
  test.setTimeout(90_000)

  const { app, close } = await launchIsolatedApp(['.'])
  const win = await getMainWindow(app)
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate13-repeat-'))

  try {
    // A real 60-paragraph document -- the same size the fix-round review
    // used to originally measure and verify this regression.
    const paragraphs = Array.from(
      { length: 60 },
      (_, i) =>
        `Paragraph ${i + 1}. ${'Real export-timing regression-guard filler text. '.repeat(8)}`
    )
    const content = `# Gate 13 Repeated Export\n\n${paragraphs.join('\n\n')}\n`

    const durationsMs: number[] = []
    for (let i = 0; i < 3; i++) {
      const targetPath = join(fixtureDir, `export-${i}.pdf`)
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = (() =>
          Promise.resolve({ canceled: false, filePath })) as typeof dialog.showSaveDialog
      }, targetPath)

      const start = Date.now()
      const result = await win.evaluate((c) => {
        const api = (window as unknown as { api: { exportPdf: (x: string) => Promise<unknown> } })
          .api
        return api.exportPdf(c)
      }, content)
      durationsMs.push(Date.now() - start)

      expect(result).toEqual({ filePath: targetPath })
      const buffer = await readFile(targetPath)
      expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    }

    console.log('Gate 13 repeated-export timings (ms):', durationsMs)

    // Generous regression guard, not a tight performance bound: a later
    // export must not balloon to several times the first export's
    // duration, which is exactly the ~12x-slowdown signature the original
    // memoized-harness bug produced. `Math.max(..., 2000)` keeps this from
    // being flaky against a fast, low-millisecond first export on a quick
    // machine, where ordinary run-to-run noise alone could otherwise exceed
    // a small multiplier, while staying tight enough to actually catch a
    // regression: a healthy first export measures ~390-450ms in this
    // environment, so the 2000ms floor still leaves ~5x headroom over that
    // steady state (fix-round finding: a 5000ms floor was tried first and
    // found to be too loose -- it let a real, measured partial-fix
    // regression slip through silently. See this test's own history in
    // GA_TRACK_2_REPORT.md's fix-round addenda for the exact numbers: an
    // earlier "fresh harness, but still attached to the real mainWindow"
    // fix attempt for this same bug measured 488/3584/4392ms -- a genuine
    // ~9x degradation -- and every one of those values was still under a
    // 5000ms floor, so that guard would NOT have caught a regression back
    // to that exact bug shape. Re-verified against the 2000ms floor: the
    // same 3584ms/4392ms values now correctly exceed it.).
    const [first, ...rest] = durationsMs
    for (const later of rest) {
      expect(later).toBeLessThan(Math.max(first * 5, 2000))
    }
  } finally {
    await rm(fixtureDir, { recursive: true, force: true })
  }

  await close()
})

// Follow-up to the local-asset-loading plan (docs/superpowers/plans/
// 2026-08-05-local-asset-loading.md): that plan wired local image
// resolution into thumbnail and page-count generation, but deliberately
// left PDF export untouched pending a decision on the plan/spec
// contradiction its own final review flagged (see the GA-push decisions
// log's "Local asset loading" entries) -- with local image geometry now
// affecting the status bar's page count but not the exported PDF, a
// document with local images would show e.g. "Page 1 of 4" while exporting
// 6 pages, a NEW divergence that didn't exist when both surfaces
// consistently rendered every local image at 0x0. These two tests close
// that gap for exportPdf specifically, mirroring gate8/gate12's own
// document-directory-confined local-asset test shape exactly (same fixture
// PNGs, same readImageBoxes evidence helper -- see asset-evidence.ts).
//
// `file:exportPdf`'s source-document path is validated via `isKnownPath`
// (src/main/index.ts), same as `file:getPageCount` -- so, like gate12's own
// equivalent tests, the fixture document's path must be seeded into a real
// recent-files.json before calling exportPdf, or the path is correctly,
// securely dropped as unknown and the asset token is never registered at
// all (verified the hard way: the first version of these two tests omitted
// this and the "loads" case failed with the image src left completely
// unrewritten -- proving isKnownPath's drop-not-throw path, not a bug in
// the rewrite/protocol-handler code).
async function seedRecentFile(userDataDir: string, filePath: string): Promise<void> {
  const existing = await readRecentFiles(userDataDir)
  await writeRecentFiles(
    userDataDir,
    mergeRecentFiles(existing, filePath, new Date().toISOString())
  )
}

test('Gate 13: a local relative image reference in the document actually loads in the exported PDF (not silently 404ing)', async () => {
  test.setTimeout(60_000)

  const { app, close } = await launchIsolatedApp(['.'])
  const win = await getMainWindow(app)
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
  const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))

  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate13-asset-'))
  const docPath = join(fixtureDir, 'doc.md')
  const targetPath = join(fixtureDir, 'export-with-image.pdf')

  try {
    await writeFixtureFile(join(fixtureDir, 'figures', 'gate13-chart.png'), ONE_PX_PNG)
    const content = '# Gate 13 Local Image\n\n![chart](./figures/gate13-chart.png)\n\nBody text.\n'
    await writeFixtureFile(docPath, content)
    await seedRecentFile(userDataDir, docPath)

    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (() =>
        Promise.resolve({ canceled: false, filePath })) as typeof dialog.showSaveDialog
    }, targetPath)

    const result = await win.evaluate(
      ({ c, p }) => {
        const api = (
          window as unknown as {
            api: { exportPdf: (c: string, p: string | null) => Promise<unknown> }
          }
        ).api
        return api.exportPdf(c, p)
      },
      { c: content, p: docPath }
    )

    expect(result).toEqual({ filePath: targetPath })

    const boxes = await readImageBoxes(app, 'gate13-chart.png')
    const loaded = boxes.find((box) => box.src.includes('gate13-chart.png'))
    expect(loaded).toBeDefined()
    expect(loaded?.naturalWidth).toBe(1)
    expect(loaded?.naturalHeight).toBe(1)

    const buffer = await readFile(targetPath)
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  } finally {
    await rm(fixtureDir, { recursive: true, force: true })
  }

  await close()
})

test("Gate 13: a local image reference using ../ escaping the exported document's directory does NOT load", async () => {
  test.setTimeout(60_000)

  const { app, close } = await launchIsolatedApp(['.'])
  const win = await getMainWindow(app)
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
  const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))

  const fixtureRoot = await mkdtemp(join(tmpdir(), 'pagedown-gate13-escape-'))
  const docDir = join(fixtureRoot, 'doc')
  const docPath = join(docDir, 'doc.md')
  const targetPath = join(fixtureRoot, 'export-escape.pdf')

  try {
    // The out-of-tree file lives OUTSIDE docDir -- a real, different-sized
    // (2x2 vs. the in-tree 1x1) image, so "denied" and "wrong file served"
    // are distinguishable outcomes, not just "something rendered."
    await writeFixtureFile(join(fixtureRoot, 'secret.png'), TWO_PX_PNG)
    const content = '# Gate 13 Traversal\n\n![escape](../secret.png)\n\nBody text.\n'
    await writeFixtureFile(docPath, content)
    await seedRecentFile(userDataDir, docPath)

    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (() =>
        Promise.resolve({ canceled: false, filePath })) as typeof dialog.showSaveDialog
    }, targetPath)

    const result = await win.evaluate(
      ({ c, p }) => {
        const api = (
          window as unknown as {
            api: { exportPdf: (c: string, p: string | null) => Promise<unknown> }
          }
        ).api
        return api.exportPdf(c, p)
      },
      { c: content, p: docPath }
    )

    expect(result).toEqual({ filePath: targetPath })

    const boxes = await readImageBoxes(app, 'secret.png')
    const denied = boxes.find((box) => box.src.includes('secret.png'))
    expect(denied).toBeDefined()
    expect(denied?.naturalWidth).toBe(0)
    expect(denied?.naturalHeight).toBe(0)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }

  await close()
})

// Page Geometry Wiring (Task 6). Every other test in this file exports a
// document with no page-config frontmatter, so all of them only ever
// exercised the default Letter geometry -- and none of them ever looked at
// the exported PDF's page DIMENSIONS at all, only its magic bytes, its page
// count, and its embedded images. That left the last link of this
// sub-project's chain unverified against a real artifact: `pdf-exporter.ts`
// computes `computePageGeometry(resolvePageConfig(content))` and hands it to
// both the harness view's setBounds and sendDocument, the render context
// turns it into a real `@page` rule, and `printToPDF({ preferCSSPageSize:
// true })` is supposed to honour that rule rather than Chromium's own
// default page size. This test is the end of that chain: a real A4 document,
// exported through the real IPC surface, whose resulting FILE ON DISK is
// then measured in PDF points.
//
// Point conversion: PDF's own unit is 1/72in, independent of this project's
// 96 CSS px/in. The pipeline rounds to whole CSS pixels first (794 x 1123),
// so the exported page is 794/96*72 = 595.5 x 1123/96*72 = 842.25 pt --
// about a third of a point off nominal A4 (595.28 x 841.89). Both are
// asserted below, at different tolerances, because they answer different
// questions: "is this genuinely A4 paper" (nominal, +/-5pt, which still
// leaves a 16pt margin against US Letter's 612pt width and a 50pt one
// against its 792pt height) and "is it exactly what OUR geometry implies"
// (+/-1pt around 595.5 x 842.25). Neither expectation is computed by
// calling computePageGeometry -- see gate16-page-geometry.spec.ts's header
// for why that would make this vacuous.
const A4_FRONTMATTER_DOC = [
  '---',
  'page: A4',
  'margins:',
  '  top: 0.75',
  '  bottom: 0.75',
  '  left: 0.5',
  '  right: 0.5',
  '---',
  '',
  '# Gate 13 A4 Export',
  '',
  'A real paragraph in a document whose frontmatter asks for A4 paper.',
  ''
].join('\n')

const NOMINAL_A4_WIDTH_PT = 595.28
const NOMINAL_A4_HEIGHT_PT = 841.89
const GEOMETRY_A4_WIDTH_PT = 595.5
const GEOMETRY_A4_HEIGHT_PT = 842.25
const US_LETTER_WIDTH_PT = 612
const US_LETTER_HEIGHT_PT = 792

test('Gate 13: a document whose frontmatter sets A4 exports a genuinely A4-sized PDF', async () => {
  test.setTimeout(60_000)

  // Dynamic import, exactly as gate4-export.spec.ts does it and for exactly
  // the reason documented at the top of that file: pdfjs-dist's Node entry
  // point is a pure-ESM .mjs that this file's CommonJS transpile cannot
  // `require()` (ERR_REQUIRE_ESM), so a static top-level import would fail;
  // `await import(...)` goes through Node's real ESM loader instead. Safe
  // here -- unlike inside an app.evaluate() callback -- because this runs in
  // the Playwright test process, a real modern Node runtime.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

  let app: ElectronApplication | undefined
  let close: (() => Promise<void>) | undefined
  let fixtureDir: string | undefined

  try {
    const launched = await launchIsolatedApp(['.'])
    app = launched.app
    close = launched.close

    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate13-a4-'))
    const targetPath = join(fixtureDir, 'gate13-a4-export.pdf')

    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (() =>
        Promise.resolve({ canceled: false, filePath })) as typeof dialog.showSaveDialog
    }, targetPath)

    // No document path is passed: `pdf-exporter.ts` reads the page config out
    // of the CONTENT itself (resolvePageConfig), so this needs no
    // recent-files seeding and proves the geometry came from the document's
    // own frontmatter rather than from any path-derived state.
    const result = await win.evaluate((content) => {
      const api = (window as unknown as { api: { exportPdf: (c: string) => Promise<unknown> } }).api
      return api.exportPdf(content)
    }, A4_FRONTMATTER_DOC)

    expect(result).toEqual({ filePath: targetPath })

    const buffer = await readFile(targetPath)
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')

    // Real pdfjs page API against the real file's bytes. `getViewport({
    // scale: 1 })` reports the page's real size in PDF points with any /Rotate
    // applied; `page.view` is the raw MediaBox, logged alongside it as the
    // unprocessed source value.
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise
    expect(doc.numPages).toBeGreaterThanOrEqual(1)
    const page = await doc.getPage(1)
    const viewport = page.getViewport({ scale: 1 })

    console.log(
      `Gate 13 A4 export: numPages=${doc.numPages} mediaBox=${JSON.stringify(page.view)} ` +
        `viewport=${viewport.width}x${viewport.height}pt rotate=${page.rotate}`
    )

    expect(
      viewport.width,
      `exported page width must be A4 (~${NOMINAL_A4_WIDTH_PT}pt), not US Letter's ${US_LETTER_WIDTH_PT}pt`
    ).toBeCloseTo(NOMINAL_A4_WIDTH_PT, -1)
    expect(
      viewport.height,
      `exported page height must be A4 (~${NOMINAL_A4_HEIGHT_PT}pt), not US Letter's ${US_LETTER_HEIGHT_PT}pt`
    ).toBeCloseTo(NOMINAL_A4_HEIGHT_PT, -1)

    // Tighter, pipeline-specific pin: the whole-CSS-pixel geometry this
    // project actually computes, converted to points.
    expect(Math.abs(viewport.width - GEOMETRY_A4_WIDTH_PT)).toBeLessThanOrEqual(1)
    expect(Math.abs(viewport.height - GEOMETRY_A4_HEIGHT_PT)).toBeLessThanOrEqual(1)

    // Durable artifact, alongside gate4's own committed exported PDFs, so
    // this file's dimensions can be re-checked independently of a gate run
    // (see this sub-project's task-6 report).
    await mkdir(join(__dirname, 'results'), { recursive: true })
    await copyFile(targetPath, join(__dirname, 'results', 'gate13-a4-export.pdf'))
  } finally {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
    if (app && close) await safeClose(app, close)
  }
})
