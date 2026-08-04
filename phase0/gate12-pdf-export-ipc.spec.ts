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
