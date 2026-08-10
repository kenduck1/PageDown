import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'
import { ONE_PX_PNG, writeFixtureFile } from './asset-evidence'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'

// Gate 32 -- HTML export's own real-app proof (product-completeness audit
// §2.3). Numbered 32 because 31 (the capability-gap pass) was the highest
// taken at the time; check `git ls-tree main phase0/` before adding another
// during parallel work.
//
// Three things are measured here, and NONE of them are reachable from a
// plain Vitest run:
//
//  1. THE `?asset` IMPORT MECHANISM GENUINELY WORKS IN THE PACKAGED-SHAPED
//     BUILD. src/main/html-exporter.ts reads document-typography.css and
//     three vendored .woff2 fonts via electron-vite's `?asset` import
//     (the same mechanism src/main/index.ts already uses for the Dock
//     icon) -- unit tests structurally cannot exercise this at all (see
//     inline-local-images.ts's own module comment on why the testable core
//     of this feature was split out from html-exporter.ts specifically to
//     avoid needing this import resolved under Vitest). This gate launches
//     the real BUILT app (`out/main/index.js`, via launchIsolatedApp), so a
//     real exported file with a real embedded `@font-face` base64 payload
//     is the only genuine proof this path resolves correctly at all.
//
//  2. A REAL LOCAL IMAGE ENDS UP INLINED AS A data: URI. Exercises
//     resolveAssetPath (pagination-window.ts) end to end against a real
//     temp directory and a real PNG's real magic bytes, through
//     inline-local-images.ts's own quote-aware tag scanning, all inside the
//     real compiled app.
//
//  3. REMOTE-IMAGE CONSENT IS RESPECTED THE SAME WAY EVERY OTHER RENDER
//     SURFACE ALREADY HONORS IT. A remote `<img>` reference must NOT survive
//     into the export when `allowRemoteImages` is false -- the same
//     `applyRemoteImagePolicy` markdownToHtml already applies for the
//     paginated preview/PDF export, exercised here for the new export path.
//
// `dialog.showSaveDialog` is monkey-patched via `app.evaluate()` before
// triggering the export -- gate13-pdf-export-ipc.spec.ts's own established
// pattern for making a real native Save dialog deterministic under test;
// every other piece of the pipeline (markdownToHtml, local-image inlining,
// font/CSS asset loading, the disk write) runs for real, unmocked.

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

async function seedRecentFile(userDataDir: string, filePath: string): Promise<void> {
  const existing = await readRecentFiles(userDataDir)
  await writeRecentFiles(
    userDataDir,
    mergeRecentFiles(existing, filePath, new Date().toISOString())
  )
}

type ExportApi = {
  exportHtml: (
    content: string,
    filePath?: string | null,
    allowRemoteImages?: boolean
  ) => Promise<{ filePath: string } | null>
}

test('Gate 32: window.api.exportHtml writes a real, self-contained HTML file with an inlined local image and no remote image (consent withheld)', async () => {
  test.setTimeout(60_000)

  const { app, close } = await launchIsolatedApp(['.'])

  try {
    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    const userDataDir = await app.evaluate(({ app: electronApp }) =>
      electronApp.getPath('userData')
    )
    const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate32-'))

    try {
      const sourcePath = join(fixtureDir, 'gate32-source.md')
      await writeFixtureFile(join(fixtureDir, 'photo.png'), ONE_PX_PNG)
      // The source .md itself is never actually read by exportDocumentToHtml
      // (only its directory matters, for local-asset resolution) -- written
      // anyway so `sourcePath` is a real, existing thing on disk, matching
      // what a real open document always is.
      await writeFixtureFile(
        sourcePath,
        '# placeholder -- exportHtml receives its content as an argument, not by reading this file'
      )
      await seedRecentFile(userDataDir, sourcePath)

      const content = [
        '# Gate 32 Export',
        '',
        'A real paragraph with a local image below.',
        '',
        '![local](photo.png)',
        '',
        '![blocked](https://example.com/should-not-appear.png)',
        '',
        '```js',
        'const x = 1 // exercises the hasCode -> mono font-face branch',
        '```'
      ].join('\n')

      const targetPath = join(fixtureDir, 'gate32-export.html')
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = (() =>
          Promise.resolve({ canceled: false, filePath })) as typeof dialog.showSaveDialog
      }, targetPath)

      const result = await win.evaluate(
        (args) => {
          const api = (window as unknown as { api: ExportApi }).api
          return api.exportHtml(args.content, args.sourcePath, false)
        },
        { content, sourcePath }
      )

      expect(result).toEqual({ filePath: targetPath })

      const stats = await stat(targetPath)
      expect(stats.size).toBeGreaterThan(0)

      const html = await readFile(targetPath, 'utf8')

      // A well-formed, self-contained document.
      expect(html.startsWith('<!doctype html>')).toBe(true)
      expect(html).not.toContain('<link')
      expect(html).not.toContain('<script')

      // The local image is genuinely inlined -- proves resolveAssetPath +
      // the quote-aware tag scan work against a real temp directory in the
      // real compiled app, not merely against Vitest's own stubbed electron.
      expect(html).not.toContain('src="photo.png"')
      expect(html).toMatch(/<img src="data:image\/png;base64,[^"]+" alt="local">/)

      // Never a `pagedown-render://` reference -- that scheme only resolves
      // inside this app's own sandboxed session and would 404 anywhere else.
      expect(html).not.toContain('pagedown-render://')

      // Remote image consent withheld -> no live remote src anywhere.
      expect(html).not.toContain('example.com')

      // A real, base64-embedded font -- proves the `?asset` import
      // mechanism resolved a real file path in the packaged-shaped build
      // and this process could read real bytes from it.
      expect(html).toMatch(/@font-face\s*{[^}]*font-family: 'Source Serif 4'/)
      expect(html).toMatch(/src: url\(data:font\/woff2;base64,[A-Za-z0-9+/]{100,}\)/)

      // hasCode gate: the fenced code block should have pulled in the mono
      // face too.
      expect(html).toContain("font-family: 'Source Code Pro'")

      // The document-typography.css text really landed (a real, known rule
      // from that stylesheet, not just "some CSS exists").
      expect(html).toContain('.pagedown-document')
    } finally {
      await rm(fixtureDir, { recursive: true, force: true })
    }
  } finally {
    await close()
  }
})

test('Gate 32: window.api.exportHtml resolves to null (writes nothing) when the Save dialog is cancelled', async () => {
  test.setTimeout(60_000)

  const { app, close } = await launchIsolatedApp(['.'])

  try {
    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = (() =>
        Promise.resolve({ canceled: true, filePath: '' })) as typeof dialog.showSaveDialog
    })

    const result = await win.evaluate((content) => {
      const api = (window as unknown as { api: ExportApi }).api
      return api.exportHtml(content, null, false)
    }, '# Cancelled export\n')

    expect(result).toBeNull()
  } finally {
    await close()
  }
})
