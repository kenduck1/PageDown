import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'

// Gate 34 -- Local images actually RENDER in the Format-mode editor canvas,
// and the confinement guards that make that safe still hold, against the
// REAL built app.
//
// Numbered 34 because 33 (toolbar reachability) was already taken; per
// CLAUDE.md, check `git ls-tree main phase0/` before claiming a number.
//
// WHY THIS GATE EXISTS, i.e. what jsdom structurally cannot do here.
// image-security.test.tsx already proves the node view's own logic under
// Vitest -- that a resolver result reaches `<img>.src`, that a relative path
// never does, that a stale resolution is discarded. What it CANNOT prove is
// the only thing the user actually reported: that an image APPEARS. jsdom
// performs no resource loading and no decoding at all, so `naturalWidth` is
// permanently 0 there for every image, real or fake; a data: URI that was
// truncated, mis-base64'd, or carried the wrong content-type would pass
// every unit test in this repo and render as a broken image in the product.
// Only real Chromium decoding real bytes can distinguish "a plausible string
// is on the element" from "the user can see their picture". This gate
// asserts `naturalWidth > 0` for exactly that reason.
//
// It also carries the real-app half of the security story. The unit tests
// mutation-check `isKnownPath` and resolveAssetPath's symlink-resolved
// confinement directly (inline-local-images.test.ts), but they call
// resolveDocumentLocalImage as a function. This drives the whole chain the
// way a hostile document would: real Markdown, parsed by the real pipeline,
// rendered by the real node view, over the real contextBridge, into the real
// IPC handler. The traversal fixture is deliberately NON-VACUOUS -- the file
// it points at genuinely exists and is a genuinely decodable PNG in a real
// sibling directory, so the ONLY thing preventing it from rendering is the
// confinement check. If that check were removed, the assertion would fail by
// name rather than pass for the wrong reason.

const GET_MAIN_WINDOW_TIMEOUT_MS = 60_000

async function getMainWindow(application: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + GET_MAIN_WINDOW_TIMEOUT_MS
  while (Date.now() < deadline) {
    for (const candidate of application.windows()) {
      if (!candidate.url().startsWith('file://')) continue
      try {
        await candidate.waitForLoadState('domcontentloaded', { timeout: 2000 })
      } catch {
        continue
      }
      return candidate
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out locating the main app-shell window (only found the sandboxed one)')
}

// A REAL, decodable 1x1 PNG -- not just the 8 magic bytes Gate 23 uses. This
// gate's whole point is that Chromium genuinely decodes the bytes that came
// back over IPC, so the fixture has to be something a decoder accepts.
const REAL_1X1_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

interface ImageProbe {
  alt: string
  state: string | null
  hasSrc: boolean
  srcPrefix: string
  naturalWidth: number
  note: string
}

let app: ElectronApplication | undefined
let close: (() => Promise<void>) | undefined
let fixtureRoot: string | undefined

test.setTimeout(120_000)

test('Gate 34: a local image renders for real in the Format canvas, while a `..` escape and a remote src stay denied', async () => {
  const launched = await launchIsolatedApp(['out/main/index.js'])
  app = launched.app
  close = launched.close
  const userDataDir = launched.userDataDir

  try {
    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
    console.log('Gate 34: main window ready')

    // Two sibling directories under one root, so `../<outside>/secret.png` is
    // a genuinely resolvable path to a genuinely real image -- the escape has
    // to be real for its denial to mean anything.
    fixtureRoot = await mkdtemp(join(tmpdir(), 'pagedown-gate34-'))
    const documentDir = join(fixtureRoot, 'doc')
    const outsideDir = join(fixtureRoot, 'outside')
    await mkdir(documentDir, { recursive: true })
    await mkdir(outsideDir, { recursive: true })
    await writeFile(join(documentDir, 'local.png'), REAL_1X1_PNG)
    await writeFile(join(outsideDir, 'secret.png'), REAL_1X1_PNG)

    const filename = `gate34-${Date.now()}.md`
    const documentPath = join(documentDir, filename)
    await writeFile(
      documentPath,
      [
        '# Gate 34',
        '',
        '![inside](local.png)',
        '',
        `![escape](../${basename(outsideDir)}/secret.png)`,
        '',
        '![remote](https://example.invalid/tracker.png)',
        ''
      ].join('\n'),
      'utf8'
    )

    const originalRecents = await readRecentFiles(userDataDir)
    await writeRecentFiles(
      userDataDir,
      mergeRecentFiles(originalRecents, documentPath, new Date().toISOString())
    )

    await win.reload()
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
    await win.getByRole('button', { name: new RegExp(filename.replace(/[.]/g, '\\.')) }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')
    console.log('Gate 34: document opened, ProseMirror mounted')

    const probe = async (): Promise<ImageProbe[]> =>
      win.evaluate(() =>
        Array.from(document.querySelectorAll('.milkdown-mount .pagedown-image')).map((wrapper) => {
          const img = wrapper.querySelector('img') as HTMLImageElement | null
          return {
            alt: img?.alt ?? '',
            state: wrapper.getAttribute('data-state'),
            hasSrc: img?.hasAttribute('src') ?? false,
            srcPrefix: (img?.getAttribute('src') ?? '').slice(0, 22),
            naturalWidth: img?.naturalWidth ?? 0,
            note: wrapper.querySelector('.pagedown-image-note')?.textContent ?? ''
          }
        })
      )

    // Poll until the in-document local image has actually resolved AND
    // decoded -- resolution is a real async IPC round trip plus a real image
    // decode, neither of which is synchronous with the mount.
    await expect
      .poll(
        async () => (await probe()).find((image) => image.alt === 'inside')?.naturalWidth ?? 0,
        {
          message: 'expected the document-local image to genuinely decode in the Format canvas',
          timeout: 20_000
        }
      )
      .toBeGreaterThan(0)

    const images = await probe()
    console.log('Gate 34: image probe =', JSON.stringify(images, null, 2))

    const inside = images.find((image) => image.alt === 'inside')
    const escape = images.find((image) => image.alt === 'escape')
    const remote = images.find((image) => image.alt === 'remote')

    expect(inside, 'the in-document image node should exist').toBeDefined()
    expect(escape, 'the traversal image node should exist').toBeDefined()
    expect(remote, 'the remote image node should exist').toBeDefined()

    // 1. THE FIX. A plain relative reference renders as a real, decoded image
    //    -- the defect was that this showed as a blocked placeholder.
    expect(inside!.state).toBe('ok')
    expect(inside!.naturalWidth).toBeGreaterThan(0)
    // And it got there as a data: URI, never as a path the renderer fetched.
    expect(inside!.srcPrefix).toBe('data:image/png;base64,')

    // 2. THE CONFINEMENT GUARD, in the real app. The file exists, is a real
    //    PNG, and is one `..` away -- and it still does not render, with no
    //    src ever placed on the element.
    expect(escape!.state).toBe('missing')
    expect(escape!.hasSrc).toBe(false)
    expect(escape!.naturalWidth).toBe(0)
    expect(escape!.note).toContain('Image not found')

    // 3. REMOTE CONSENT is not routed around by the new resolver: with no
    //    consent granted for this document, a remote src stays blocked on
    //    this surface and carries an honest explanation rather than a silent
    //    blank.
    expect(remote!.state).toBe('blocked')
    expect(remote!.hasSrc).toBe(false)
    expect(remote!.note).toContain('Remote image')

    // 4. The degraded states are VISIBLE, not merely present in the DOM. A
    //    note collapsed to zero area would pass every assertion above and be
    //    invisible to a user -- the same trap Gate 17 documents for find
    //    highlights.
    const escapeNote = win.locator('.pagedown-image[data-state="missing"] .pagedown-image-note')
    await expect(escapeNote.first()).toBeVisible()
    const noteBox = await escapeNote.first().boundingBox()
    expect(noteBox, 'the missing-image note should occupy real space').not.toBeNull()
    expect(noteBox!.width).toBeGreaterThan(0)
    expect(noteBox!.height).toBeGreaterThan(0)
  } finally {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
    if (app && close) await close()
  }
})
