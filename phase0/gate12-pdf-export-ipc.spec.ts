import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'

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

const SAMPLE_MARKDOWN = '# Gate 12 Export\n\nA real paragraph of exported content.\n'

test('Gate 12: window.api.exportPdf writes a real PDF file to the chosen path', async () => {
  test.setTimeout(60_000)

  const { app, close } = await launchIsolatedApp(['.'])
  const win = await getMainWindow(app)
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate12-'))
  const targetPath = join(fixtureDir, 'gate12-export.pdf')

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

test('Gate 12: window.api.exportPdf resolves to null (writes nothing) when the Save dialog is cancelled', async () => {
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
test('Gate 12: exporting the same multi-paragraph document repeatedly in one app session does not degrade', async () => {
  test.setTimeout(90_000)

  const { app, close } = await launchIsolatedApp(['.'])
  const win = await getMainWindow(app)
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate12-repeat-'))

  try {
    // A real 60-paragraph document -- the same size the fix-round review
    // used to originally measure and verify this regression.
    const paragraphs = Array.from(
      { length: 60 },
      (_, i) =>
        `Paragraph ${i + 1}. ${'Real export-timing regression-guard filler text. '.repeat(8)}`
    )
    const content = `# Gate 12 Repeated Export\n\n${paragraphs.join('\n\n')}\n`

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

    console.log('Gate 12 repeated-export timings (ms):', durationsMs)

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
