import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'

// Gate 23 -- Drag-and-drop image insertion, against the REAL built app.
//
// WHY THIS GATE EXISTS. src/renderer/src/milkdown/drop-image.test.ts already
// proves insertDroppedImages' own logic under Vitest, but deliberately
// cannot exercise createDropImagePlugin's own `handleDOMEvents.drop`
// handler at all: it calls `view.posAtCoords`, which THROWS under jsdom
// (`document.elementFromPoint is not a function` -- jsdom implements no
// real layout/hit-testing). This gate is the other half: a REAL synthetic
// `drop` DragEvent, carrying a REAL `File` + `DataTransfer` constructed
// entirely inside actual Chromium (real layout, real posAtCoords), proving
// the whole pipeline -- native drop -> save to the document's own
// directory via real IPC -> real file written to real disk -> a real
// markdown image reference landing in the saved document.
//
// `new DataTransfer()` + `dataTransfer.items.add(file)` is a well-established
// technique for synthesizing a file drop in a real browser context (real
// browsers restrict DataTransfer mutation only during a TRUSTED, OS-driven
// drag gesture; a script-dispatched DragEvent has no such restriction).

const CLOSE_TIMEOUT_MS = 20_000

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

// Real 8-byte PNG magic-byte signature -- enough for sniffImageContentType
// (src/main/pagination-window.ts) to classify it as a real image; this gate
// never needs a decodable image, only real magic bytes.
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]

let app: ElectronApplication | undefined
let close: (() => Promise<void>) | undefined
let win: Page
let userDataDir: string
let fixtureDir: string

test.setTimeout(120_000)

test('Gate 23: a real native file drop inserts a real image reference and writes a real file next to the document', async () => {
  const launched = await launchIsolatedApp(['out/main/index.js'])
  app = launched.app
  close = launched.close
  userDataDir = launched.userDataDir

  try {
    win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
    console.log('Gate 23: main window ready')

    fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate23-'))
    const marker = `Gate23 ${Date.now()}`
    const filename = `gate23-${Date.now()}.md`
    const path = join(fixtureDir, filename)
    await writeFile(path, `# ${marker}\n\nSome body text.\n`, 'utf8')

    const originalRecents = await readRecentFiles(userDataDir)
    await writeRecentFiles(
      userDataDir,
      mergeRecentFiles(originalRecents, path, new Date().toISOString())
    )

    await win.reload()
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
    await win.getByRole('button', { name: new RegExp(filename.replace(/[.]/g, '\\.')) }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')
    console.log('Gate 23: document opened, ProseMirror mounted')

    // A real synthetic drop, dispatched directly at the real ProseMirror
    // DOM node, carrying a real File + DataTransfer built entirely inside
    // this Chromium instance.
    await win.evaluate((pngBytes) => {
      const target = document.querySelector('.milkdown-mount .ProseMirror')
      if (!target) throw new Error('ProseMirror mount not found')
      const rect = target.getBoundingClientRect()
      const file = new File([new Uint8Array(pngBytes)], 'dropped-photo.png', {
        type: 'image/png'
      })
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(file)
      const event = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 10,
        clientY: rect.top + 10,
        dataTransfer
      })
      target.dispatchEvent(event)
    }, PNG_BYTES)
    console.log('Gate 23: synthetic drop event dispatched')

    // Real disk evidence: the file genuinely landed next to the document,
    // not just referenced in the markdown.
    await expect
      .poll(
        async () =>
          readFile(join(fixtureDir, 'dropped-photo.png')).then(
            (buf) => buf.length,
            () => -1
          ),
        {
          message: 'expected dropped-photo.png to be written into the document directory',
          timeout: 15_000
        }
      )
      .toBeGreaterThan(0)

    console.log('Gate 23: dropped-photo.png confirmed written to disk')

    const writtenBytes = await readFile(join(fixtureDir, 'dropped-photo.png'))
    expect(Array.from(writtenBytes.subarray(0, 8))).toEqual(PNG_BYTES.slice(0, 8))

    // Real markdown evidence: switch to Source mode and read the exact
    // underlying bytes (same technique Gate 17/Gate 21 use for the same
    // "read the real file, not a rendered view of it" reason).
    await win.getByRole('button', { name: 'Source', exact: true }).click()
    const textarea = win.getByRole('textbox', { name: 'Markdown source' })
    await expect(textarea).toBeVisible()
    await expect
      .poll(() => textarea.inputValue(), {
        message: 'expected the dropped image reference to appear in the source',
        timeout: 15_000
      })
      .toContain('![dropped-photo.png](dropped-photo.png)')
  } finally {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
    if (app && close) await safeClose(app, close)
  }
})
