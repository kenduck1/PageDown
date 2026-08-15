import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'
import { ONE_PX_PNG, writeFixtureFile } from './asset-evidence'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../../src/main/recent-files'
import { listDocxEntries, readDocxEntry, readDocxDocumentXml } from '../../src/export/docx-zip'

// Gate 39 -- .docx export's own real-app proof, following gate32 (HTML export)
// and gate13 (PDF export) exactly. Numbered 39 because 38 was the highest
// taken at the time; check `git ls-tree main tests/gates/` before adding another
// during parallel work.
//
// The headline reason this gate exists is CLAUDE.md's "Build quirk #2", and it
// is worth naming precisely because it is the one failure mode that passes
// every unit test and still breaks the shipped app. electron-vite externalizes
// every package.json dependency in the main-process build, emitting a raw
// `require("docx")` into out/main/index.js. `docx` is `"type": "module"` --
// the exact trigger condition -- but ALSO ships a real CommonJS build declared
// in `exports["."].require`, so the require(esm) interop trap is never
// reached and it is deliberately NOT on electron.vite.config.ts's exclude
// list. That reasoning is only worth as much as the check behind it: Vitest
// and Playwright both transform imports themselves and would resolve `docx`
// correctly no matter what the compiled bundle does, so ONLY launching the
// real built app and having it genuinely produce a .docx can tell the
// difference. If the interop assumption ever breaks -- a `docx` major that
// drops its CJS entry, an electron-vite change -- this gate fails and the
// unit suite stays green.
//
// Four further things measured here, none reachable from a plain Vitest run:
//
//  1. THE FILE IS A REAL OOXML PACKAGE. Not "bytes were written": the zip is
//     opened (by src/export/docx-zip.ts's own independent central-directory
//     parser, deliberately not by the zip implementation `docx` used to write
//     it) and `word/document.xml` is asserted on directly.
//
//  2. A REAL LOCAL IMAGE IS EMBEDDED AS A REAL MEDIA PART, through
//     resolveAssetPath's own symlink-resolving confinement check and real
//     magic-byte sniff, against a real temp directory in the real compiled
//     app -- not against Vitest's stubbed electron.
//
//  3. REMOTE-IMAGE CONSENT IS RESPECTED. With consent withheld, no remote URL
//     survives into the exported file at all.
//
//  4. THE EXPORT REGISTERS ITS OWN OUTPUT AS REVEALABLE. `shell:showItemInFolder`
//     only ever reveals a path this process itself just wrote, tracked in a
//     small remembered set populated inside the export handler's success
//     branch. That set is main-process module state with no other observable
//     effect, so a real IPC round trip is the only way to prove the new
//     handler populates it -- and that an unrelated path still does not.
//
// `dialog.showSaveDialog` is monkey-patched via `app.evaluate()` before
// triggering the export -- gate13/gate32's own established pattern for making
// a real native Save dialog deterministic. Everything else (the mdast parse,
// the OOXML build, the local-image reads, the disk write) runs for real.

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
  exportDocx: (
    content: string,
    filePath?: string | null,
    allowRemoteImages?: boolean
  ) => Promise<{ filePath: string } | null>
  showItemInFolder: (filePath: string) => Promise<boolean>
}

test('Gate 39: window.api.exportDocx writes a real OOXML package with a page break, a table, an embedded local image and no remote image (consent withheld)', async () => {
  test.setTimeout(60_000)

  const { app, close } = await launchIsolatedApp(['.'])

  try {
    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    const userDataDir = await app.evaluate(({ app: electronApp }) =>
      electronApp.getPath('userData')
    )
    const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate39-'))

    try {
      const sourcePath = join(fixtureDir, 'gate39-source.md')
      await writeFixtureFile(join(fixtureDir, 'photo.png'), ONE_PX_PNG)
      // Never actually read by exportDocumentToDocx (only its DIRECTORY
      // matters, for local-asset resolution) -- written anyway so `sourcePath`
      // is a real, existing thing on disk, matching what a real open document
      // always is, and so seedRecentFile's allowlist entry names something
      // real.
      await writeFixtureFile(sourcePath, '# placeholder -- content is passed as an argument')
      await seedRecentFile(userDataDir, sourcePath)

      const content = [
        '---',
        'page: A4',
        'header: true',
        'headerLeft: "Gate 39 Header"',
        '---',
        '',
        '# Gate 39 Export',
        '',
        'A paragraph with **bold** text and a [link](https://example.com/ok).',
        '',
        '![local](photo.png)',
        '',
        '![blocked](https://cdn.example.com/should-not-appear.png)',
        '',
        '<!-- pagebreak -->',
        '',
        '## After the break',
        '',
        '| Column A | Column B |',
        '|:---------|---------:|',
        '| one      | two      |'
      ].join('\n')

      const targetPath = join(fixtureDir, 'gate39-export.docx')
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = (() =>
          Promise.resolve({ canceled: false, filePath })) as typeof dialog.showSaveDialog
      }, targetPath)

      const result = await win.evaluate(
        (args) => {
          const api = (window as unknown as { api: ExportApi }).api
          return api.exportDocx(args.content, args.sourcePath, false)
        },
        { content, sourcePath }
      )

      expect(result).toEqual({ filePath: targetPath })
      expect((await stat(targetPath)).size).toBeGreaterThan(0)

      const written = await readFile(targetPath)

      // ---- 1. A real OOXML package ----------------------------------------
      // "PK": if this is not a zip, nothing below means anything.
      expect(written.subarray(0, 2).toString('latin1')).toBe('PK')
      const entries = listDocxEntries(written)
      expect(entries).toContain('[Content_Types].xml')
      expect(entries).toContain('word/document.xml')
      expect(entries).toContain('word/styles.xml')

      const documentXml = readDocxDocumentXml(written)

      // ---- Structure survived the conversion ------------------------------
      expect(documentXml).toContain('<w:pStyle w:val="Heading1"/>')
      expect(documentXml).toContain('Gate 39 Export')
      expect(documentXml).toContain('<w:b/>')
      // The app's own marker convention became a real Word hard page break --
      // the one construct in this whole export that translates exactly.
      expect(documentXml).toContain('<w:br w:type="page"/>')
      expect(documentXml).toContain('<w:tbl>')
      expect(documentXml).toContain('<w:tblHeader/>')
      // The document's own PageConfig drove the section: A4 at 96dpi is
      // 794x1123 CSS px, x15 twips per px.
      expect(documentXml).toContain('<w:pgSz w:w="11910" w:h="16845" w:orient="portrait"/>')

      // Frontmatter is configuration, never body text.
      expect(documentXml).not.toContain('headerLeft')
      expect(documentXml).not.toContain('page: A4')
      // ...but it did reach the running header, as a separate real part.
      expect(entries).toContain('word/header1.xml')
      expect(readDocxEntry(written, 'word/header1.xml')?.toString('utf8')).toContain(
        'Gate 39 Header'
      )

      // ---- 2. The local image is genuinely embedded ------------------------
      expect(entries.some((name) => name.startsWith('word/media/'))).toBe(true)
      expect(documentXml).toContain('<w:drawing>')
      // Never a `pagedown-render://` reference: that scheme only resolves
      // inside this app's own sandboxed session and means nothing in Word.
      expect(documentXml).not.toContain('pagedown-render://')

      // ---- 3. Remote-image consent withheld --------------------------------
      const rels = readDocxEntry(written, 'word/_rels/document.xml.rels')?.toString('utf8') ?? ''
      expect(rels).not.toContain('cdn.example.com')
      expect(documentXml).not.toContain('cdn.example.com')
      // The ordinary link is unaffected -- this blocks remote IMAGES, not
      // hyperlinks the author wrote on purpose.
      expect(rels).toContain('https://example.com/ok')

      // ---- 4. The export registered its own output as revealable ----------
      // shell.showItemInFolder would really open Finder/Explorer, so only that
      // one call is stubbed; the membership check and the stat that gate it
      // both run for real.
      await app.evaluate(({ shell }) => {
        shell.showItemInFolder = (() => undefined) as typeof shell.showItemInFolder
      })
      const revealedExport = await win.evaluate((filePath) => {
        const api = (window as unknown as { api: ExportApi }).api
        return api.showItemInFolder(filePath)
      }, targetPath)
      expect(revealedExport).toBe(true)

      // A path this process never exported is refused even though it exists on
      // disk -- the remembered set is the gate, not mere existence.
      const revealedSource = await win.evaluate((filePath) => {
        const api = (window as unknown as { api: ExportApi }).api
        return api.showItemInFolder(filePath)
      }, sourcePath)
      expect(revealedSource).toBe(false)
    } finally {
      await rm(fixtureDir, { recursive: true, force: true })
    }
  } finally {
    await close()
  }
})

test('Gate 39: window.api.exportDocx resolves to null (writes nothing) when the Save dialog is cancelled', async () => {
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
      return api.exportDocx(content, null, false)
    }, '# Cancelled export\n')

    expect(result).toBeNull()
  } finally {
    await close()
  }
})
