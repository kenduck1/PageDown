import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'

// Gate 31 -- the capability-gap pass's real-app proof. Numbered 31 because 30
// (the application menu) was the highest taken at the time; check
// `git ls-tree main phase0/` before adding another during parallel work.
//
// Two things are measured here, and NEITHER is reachable from jsdom:
//
//  1. TABLE EDITING REACHES DISK. Tab on the last cell of a table now appends
//     a row. The mechanism is a $prose plugin's `handleKeyDown` deliberately
//     outranking @milkdown/preset-gfm's own priority-100 Tab binding, and the
//     only way to prove the real dispatch order (rather than the one jsdom's
//     synthetic event happens to take) is a genuine Chromium keypress in the
//     real built app, followed by a real Save and a real read of the file.
//     Everything downstream of the editor -- the paginated preview, the PDF,
//     the next session -- reads that file, so the markdown IS the contract.
//
//  2. A DOCUMENT BODY SIZE RENDERS AT REAL PIXELS ON BOTH SURFACES. `fontSize`
//     is a new PageConfig/DocumentStyle field, applied as a shared CSS class on
//     the Milkdown mount and on the sandboxed context's <body>. jsdom can prove
//     the class was set; it has no layout engine and no cascade worth the name,
//     so it cannot prove any text is 16px, and it certainly cannot prove the
//     paginator and the editor agree -- which is the whole claim, and the
//     invariant Gate 10's 0.000px parity depends on. Gate 19's `theme: resume`
//     test is this one's direct template.
//
// EXPECTED VALUES ARE HAND-DERIVED LITERALS, per Gate 16's standing rule: this
// file never calls resolveDocumentStyle or reads document-typography.css to
// derive what it expects. An expectation computed by the code under test moves
// with that code's bugs.

// document-typography.css's `.pagedown-document.pagedown-size-16` block. The
// default body is 14px, so a surface that ignored the class reports that
// instead -- which is what makes this discriminating rather than vacuous.
const CHOSEN_BODY_FONT_PX = 16
const DEFAULT_BODY_FONT_PX = 14
// The same block's proportional heading ramp: h1 is calc(26 / 14 * 1em) of the
// chosen body size. 16 * 26 / 14 = 29.714285... A fixed 26px h1 (i.e. the ramp
// not applying) would be a different number, and so would an h1 that tracked
// the body 1:1.
const CHOSEN_H1_FONT_PX = (16 * 26) / 14

interface PreviewProbe {
  pageCount: number
  bodyFontSize: string
  h1FontSize: string
  text: string
}

// Reads the REAL sandboxed render context through the main process, the
// app.evaluate -> mainWindow.contentView.children -> executeJavaScript route
// Gates 15/16/19 established. A renderer-side path is categorically impossible:
// contextBridge deep-freezes window.api and this context is deliberately
// unreachable from it. The on-screen-rectangle filter disambiguates the split
// preview from the Phase 0 spike's own permanently off-screen harness view.
async function probePreview(app: ElectronApplication): Promise<PreviewProbe | null> {
  return app.evaluate(async ({ BrowserWindow, WebContentsView }) => {
    const mainWindow = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().startsWith('file://')
    )
    if (!mainWindow) return null

    const splitView = mainWindow.contentView.children.find(
      (child): child is InstanceType<typeof WebContentsView> => {
        if (!(child instanceof WebContentsView)) return false
        if (child.webContents.isDestroyed()) return false
        if (!child.webContents.getURL().startsWith('pagedown-render://')) return false
        const bounds = child.getBounds()
        return bounds.x >= 0 && bounds.y >= 0 && bounds.width > 0 && bounds.height > 0
      }
    )
    if (!splitView) return null

    const raw = (await splitView.webContents.executeJavaScript(`
      (function () {
        var root = document.getElementById('content-root')
        var p = document.querySelector('.pagedjs_area p')
        var h1 = document.querySelector('.pagedjs_area h1')
        return JSON.stringify({
          pageCount: document.querySelectorAll('.pagedjs_page').length,
          bodyFontSize: p ? window.getComputedStyle(p).fontSize : '',
          h1FontSize: h1 ? window.getComputedStyle(h1).fontSize : '',
          text: root ? root.innerText : ''
        })
      })()
    `)) as string
    return JSON.parse(raw) as PreviewProbe
  })
}

const BODY_TEXT = Array.from(
  { length: 12 },
  (_, i) => `Paragraph ${i + 1}. Filler prose so the preview has real body text to measure.`
).join('\n\n')

let app: ElectronApplication | undefined
let close: (() => Promise<void>) | undefined
let win: Page
let userDataDir: string
let fixtureDir: string

// One app instance for the whole file, per Gate 19's own reasoning: every
// launch/close cycle is a real exposure to the documented close() hang under
// host load, and every measurement here is a pure read of a document the test
// itself supplies.
test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const GET_MAIN_WINDOW_TIMEOUT_MS = 60_000

// The same POSITIVE `file://` match every other gate's getMainWindow uses --
// this app opens a second, sandboxed pagedown-render:// window at startup, and
// both firstWindow() and a negative filter race it (every window starts on
// about:blank before its real navigation completes).
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

test.beforeAll(async () => {
  test.setTimeout(180_000)
  const launched = await launchIsolatedApp(['out/main/index.js'])
  app = launched.app
  close = launched.close
  userDataDir = launched.userDataDir
  win = await getMainWindow(app)
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
  fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate31-'))
})

test.afterAll(async () => {
  try {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
  } finally {
    if (app && close) await close()
  }
})

// Writes a fixture, seeds it into the real recent-files allowlist, reloads the
// renderer, and opens it through real UI. Reload rather than the "<- Home"
// button, per Gate 19: that button runs EditorScreen's real dirty check, which
// on a dirty document opens a REAL native Save/Don't Save/Cancel dialog no
// headless gate can dismiss.
async function openDocument(body: string, label: string): Promise<string> {
  const filename = `gate31-${label}-${Date.now()}.md`
  const path = join(fixtureDir, filename)
  await writeFile(path, body, 'utf8')

  const originalRecents = await readRecentFiles(userDataDir)
  await writeRecentFiles(
    userDataDir,
    mergeRecentFiles(originalRecents, path, new Date().toISOString())
  )
  await win.reload()
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
  await win.getByRole('button', { name: new RegExp(filename.replace(/[.]/g, '\\.')) }).click()
  await win.waitForSelector('.milkdown-mount .ProseMirror')
  return path
}

// Waits for a render that genuinely contains THIS document's marker AND whose
// page count has SETTLED -- Paged.js appends pages progressively, so a probe
// firing as soon as the marker appears catches the document mid-pagination
// (Gate 19 found this for real). Two consecutive identical non-zero counts.
async function pollPreview(marker: string): Promise<PreviewProbe> {
  let last: PreviewProbe | null = null
  let previousCount = -1
  await expect
    .poll(
      async () => {
        const probe = await probePreview(app!)
        if (!probe || !probe.text.includes(marker)) {
          previousCount = -1
          return false
        }
        const settled = probe.pageCount > 0 && probe.pageCount === previousCount
        previousCount = probe.pageCount
        last = probe
        return settled
      },
      {
        message: `expected the split-preview WebContentsView to render "${marker}" and settle`,
        timeout: 45_000,
        intervals: [500]
      }
    )
    .toBe(true)
  if (!last) throw new Error('preview probe never resolved')
  return last
}

async function readEditorParagraphStyle(): Promise<{ fontSize: string; h1FontSize: string }> {
  return win.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
    const p = document.querySelector('.milkdown-mount .ProseMirror p')
    const h1 = document.querySelector('.milkdown-mount .ProseMirror h1')
    return {
      fontSize: p ? window.getComputedStyle(p).fontSize : '',
      h1FontSize: h1 ? window.getComputedStyle(h1).fontSize : ''
    }
  })
}

test('Tab on the last table cell appends a real row that reaches disk', async () => {
  // A 2x2 GFM table, exactly the shape this app's own "Insert table" button
  // and its Invoice/Report templates produce.
  const path = await openDocument(
    ['# Gate 31 table', '', '| Item | Cost |', '| --- | --- |', '| Widget | 10 |', ''].join('\n'),
    'table'
  )

  // Click into the LAST body cell, then press a genuine Tab. Before this pass,
  // prosemirror-tables' goToNextCell returned false there (no next cell) and
  // the keypress did nothing at all -- so a user who needed one more line item
  // had no way to get one from any surface in the app.
  const cells = win.locator('.milkdown-mount .ProseMirror td')
  await expect(cells).toHaveCount(2)
  await cells.last().click()
  await win.keyboard.press('Tab')

  // Wait for the row to genuinely exist in the DOM before saving, rather than
  // clicking Save and letting the file poll absorb the gap. This is a real
  // readiness condition, not padding: the first version of this test clicked
  // Save immediately and failed its 15s file poll with the row present in the
  // editor but absent from disk -- diagnosed by dumping the live td count,
  // which read 4 while the file still read 3.
  await expect(cells, 'Tab must append a real row to the editor DOM').toHaveCount(4)

  // A real click on the real Save button (this app has no Cmd/Ctrl+S), then a
  // real read of the real file -- the markdown is the contract.
  await win.getByRole('button', { name: 'Save' }).click()
  await expect
    .poll(
      async () =>
        (await readFile(path, 'utf8')).split('\n').filter((l) => l.startsWith('|')).length,
      {
        message: 'expected the saved markdown to gain a fourth table line',
        timeout: 15_000
      }
    )
    .toBe(4)

  const saved = await readFile(path, 'utf8')
  console.log('Gate 31 saved table:\n' + saved)
  const tableLines = saved.split('\n').filter((line) => line.startsWith('|'))
  // header row, delimiter row, the original body row, and the appended one.
  expect(tableLines).toHaveLength(4)
  expect(tableLines[2]).toContain('Widget')
  // The appended row is genuinely empty (an empty GFM cell serializes as
  // `<br />` in this pipeline -- pre-existing, proven independently in
  // table-commands.test.ts against a hand-written empty cell).
  expect(tableLines[3]).not.toContain('Widget')
})

test('an explicit fontSize renders at real pixels on BOTH surfaces', async () => {
  const marker = `Gate31 size ${Date.now()}`
  await openDocument(
    ['---', 'fontSize: 16', '---', '', `# ${marker}`, '', BODY_TEXT, ''].join('\n'),
    'size'
  )
  await win.getByRole('button', { name: 'Split', exact: true }).click()
  await expect(win.getByTestId('split-preview-placeholder')).toBeVisible()

  const probe = await pollPreview(marker)
  const editor = await readEditorParagraphStyle()
  console.log(
    `Gate 31 fontSize 16: preview body=${probe.bodyFontSize} h1=${probe.h1FontSize}, ` +
      `editor body=${editor.fontSize} h1=${editor.h1FontSize}`
  )

  expect(
    probe.bodyFontSize,
    `an explicit fontSize must render body text at ${CHOSEN_BODY_FONT_PX}px in the paginated preview`
  ).toBe(`${CHOSEN_BODY_FONT_PX}px`)
  expect(probe.bodyFontSize).not.toBe(`${DEFAULT_BODY_FONT_PX}px`)

  // THE parity claim, not a duplicate assertion: a size that applied to only
  // one surface would silently break the editor/paginator agreement Gate 10
  // exists to protect.
  expect(editor.fontSize, 'the editor canvas must apply the same body size').toBe(
    probe.bodyFontSize
  )

  // The proportional heading ramp, on both surfaces. Without it, an 18px body
  // would render an h3 SMALLER than its own body text.
  expect(parseFloat(probe.h1FontSize)).toBeCloseTo(CHOSEN_H1_FONT_PX, 1)
  expect(parseFloat(editor.h1FontSize)).toBeCloseTo(CHOSEN_H1_FONT_PX, 1)
})

test('a document with no fontSize still renders at the default, in the same app instance', async () => {
  // The control Gate 16/19's methodology requires: without it, a build that
  // hardcoded 16px somewhere new would pass the test above.
  const marker = `Gate31 default ${Date.now()}`
  await openDocument([`# ${marker}`, '', BODY_TEXT, ''].join('\n'), 'default')
  await win.getByRole('button', { name: 'Split', exact: true }).click()
  await expect(win.getByTestId('split-preview-placeholder')).toBeVisible()

  const probe = await pollPreview(marker)
  const editor = await readEditorParagraphStyle()
  console.log(`Gate 31 default: preview body=${probe.bodyFontSize}, editor body=${editor.fontSize}`)

  expect(probe.bodyFontSize).toBe(`${DEFAULT_BODY_FONT_PX}px`)
  expect(editor.fontSize).toBe(`${DEFAULT_BODY_FONT_PX}px`)
})
