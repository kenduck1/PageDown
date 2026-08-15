/**
 * Captures the README screenshots from the REAL built app.
 *
 *   pnpm build && pnpm exec tsx scripts/capture-screenshots.ts
 *
 * Output lands in docs/screenshots/.
 *
 * WHY SPLIT MODE NEEDS A COMPOSITE
 *
 * Split mode's preview pane is a WebContentsView -- a separate renderer
 * process with its own compositing surface, which Chromium's browser process
 * draws on top of the main window at display time. `capturePage()` asks ONE
 * renderer for a bitmap of ITS OWN surface, so a main-window capture contains
 * the DOM and a blank rectangle where the native child view sits. The view's
 * own `capturePage()` returns the real paginated pages perfectly well.
 *
 * So the Split screenshot is assembled from two real captures, pasted at the
 * bounds the app itself reports (`view.getBounds()`, the same rectangle
 * SplitPreview.tsx measures and the main process applies via setBounds()).
 * Every pixel is real output at its real position -- nothing is mocked or
 * redrawn -- and gate15 already asserts those bounds match the placeholder's
 * own client rect exactly, so the seam is correct by construction.
 *
 * Compositing happens on a canvas inside the main window, using
 * createImageBitmap over a Blob rather than assigning a data: URL to an
 * Image. That is deliberate: the renderer ships a `default-src 'self'` CSP,
 * which an <img src="data:..."> would be subject to, while createImageBitmap
 * on a Blob is not a fetch and never consults CSP at all.
 *
 * The window is NEVER resized. Driving a resize from an automated session is
 * recorded in this project's notes as triggering a reproducible multi-minute
 * hang, and the default 1000x840 window is a fine screenshot size anyway.
 */
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchIsolatedApp } from '../phase0/electron-launch'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')
const OUT_DIR = join(REPO_ROOT, 'docs', 'screenshots')

const GET_MAIN_WINDOW_TIMEOUT_MS = 60_000
const SPLIT_RENDER_TIMEOUT_MS = 30_000

/**
 * Switching between Format and Source destroys ProseMirror's undo history,
 * and the app raises a ~3s toast saying so. It is pinned to the top-centre of
 * the viewport, directly over the tab bar, so a capture taken too soon after
 * a mode switch has a notification banner across it.
 */
const TOAST_SETTLE_MS = 3800

/**
 * The document used for every editor screenshot.
 *
 * Deliberately long enough to paginate: the shipped Report template is a
 * single, mostly-empty page, which shows a page-first editor demonstrating no
 * pages. This runs to a second page, so both the Format canvas's own page
 * seam and the preview's per-page footers are visible -- the whole premise of
 * the app, rather than a screenshot of a text box.
 *
 * The frontmatter is real, and is what drives page size, margins and the
 * running header/footer on every rendering surface.
 */
// Frontmatter uses the app's own real convention: visibility and content are
// SEPARATE FLAT KEYS (`header: true` + `headerCenter: "..."`), not one nested
// `header: { center: ... }` block. A nested block parses as a YAML mapping,
// fails the `typeof parsed.header === 'boolean'` check, and is silently
// ignored -- which is exactly how the first version of this document ended up
// screenshotting a header that never rendered.
//
// The running-content values are quoted deliberately: a bare value beginning
// with `{` opens a YAML flow mapping, so an unquoted `footerCenter: {n}` is
// silently rejected. The app's own writer always quotes these.
const DEMO_DOCUMENT = `---
page: Letter
orientation: portrait
margins:
  top: 1
  bottom: 1
  left: 1
  right: 1
header: true
headerCenter: "Northwind Analytics"
footer: true
footerCenter: "Page {n} of {total}"
---

# Quarterly Business Review

## Summary

Revenue grew 12% quarter over quarter, driven almost entirely by the Mobile
line following the onboarding redesign shipped in Q2. Enterprise remains the
largest single contributor by absolute revenue but continues to grow below
plan, and is the focus of the review scheduled for next quarter.

Headcount was flat. Gross margin improved by 1.4 points, mostly from the
infrastructure consolidation completed in June.

## Results by product line

| Product line | Revenue | Growth | Notes |
| --- | --- | --- | --- |
| Core Platform | $1.2M | +8% | Steady; renewal rate 94% |
| Mobile | $640K | +15% | Onboarding redesign landed |
| Enterprise | $2.1M | +3% | Below plan; see review |
| Services | $310K | +21% | Two large implementations |

## What worked

- **Onboarding redesign.** Activation within the first session rose from 41%
  to 58%. This is the single clearest win of the quarter.
- **Infrastructure consolidation.** Retiring the second region removed a
  standing cost without a measurable latency regression.
- **Renewal motion.** Moving renewals to 90-day outreach lifted the Core
  Platform renewal rate by two points.

> Enterprise growth is the one number that did not move. Every other line
> beat plan, which makes it easy to read the quarter as uniformly strong.
> It was not.

## What did not

Enterprise pipeline coverage ended the quarter at 2.1x against a 3.0x
target. The shortfall is concentrated in the upper segment, where the
average cycle has lengthened by roughly five weeks year over year. Three
deals that had been forecast to close in the final month slipped without
being re-qualified, which suggests a forecasting problem alongside the
pipeline one.

## Recommendations

1. Re-qualify every Enterprise opportunity above $100K before the next
   forecast call.
2. Fund a second implementation engineer against the Services backlog, which
   is now the constraint on recognising that revenue.
3. Hold Mobile spend flat and let the activation gain compound for one more
   quarter before adding acquisition budget on top of it.

## Appendix: methodology

Revenue figures are recognised, not booked, and exclude the two contracts
still in legal review at quarter end. Growth percentages compare against the
immediately preceding quarter rather than the same quarter last year.
`

/**
 * Positive `file://` match, not a negative "isn't pagedown-render://" one.
 * This app opens a second window at startup (the dev-only Phase 0 spike
 * harness), and every window starts on about:blank -- which a negative
 * filter would also accept, intermittently returning the wrong window.
 */
async function getMainWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + GET_MAIN_WINDOW_TIMEOUT_MS
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
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
  throw new Error('Timed out locating the main app-shell window')
}

async function save(name: string, base64: string): Promise<void> {
  const bytes = Buffer.from(base64, 'base64')
  const path = join(OUT_DIR, `${name}.png`)
  await writeFile(path, bytes)
  // PNG dimensions live in the IHDR chunk: 8-byte signature, 4-byte length,
  // 4-byte type, then width/height as big-endian uint32. Read directly so
  // the log reports real pixels without pulling in an image library.
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  console.log(`  wrote ${name}.png  ${width}x${height}`)
}

/** Captures the main window's own web contents (no native child views). */
async function captureWindow(app: ElectronApplication): Promise<string> {
  return app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().startsWith('file://')
    )
    if (!win) throw new Error('main window not found')
    const image = await win.webContents.capturePage()
    return image.toPNG().toString('base64')
  })
}

interface SplitCapture {
  window: string
  view: string
  /** Content-area size in device-independent pixels. */
  windowDip: { width: number; height: number }
  /** The preview view's rectangle, in DIP, relative to the content area. */
  viewDip: { x: number; y: number; width: number; height: number }
}

/**
 * Captures the main window and the split preview's own WebContentsView
 * separately. Returns null while no on-screen preview view is attached.
 */
async function captureSplit(app: ElectronApplication): Promise<SplitCapture | null> {
  return app.evaluate(async ({ BrowserWindow, WebContentsView }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().startsWith('file://')
    )
    if (!win) return null

    // The same window also hosts a permanently OFF-SCREEN pagedown-render://
    // view (the dev-only Phase 0 spike harness, parked at -9999,-9999).
    // Filtering to a genuinely on-screen rectangle is what isolates the
    // split preview from it.
    const view = win.contentView.children.find(
      (child): child is InstanceType<typeof WebContentsView> => {
        if (!(child instanceof WebContentsView)) return false
        if (child.webContents.isDestroyed()) return false
        if (!child.webContents.getURL().startsWith('pagedown-render://')) return false
        const b = child.getBounds()
        return b.x >= 0 && b.y >= 0 && b.width > 0 && b.height > 0
      }
    )
    if (!view) return null

    // Only capture once the sandboxed context has actually finished a
    // render -- otherwise the pane is genuinely blank and the composite
    // would faithfully reproduce an empty preview.
    const ready = (await view.webContents.executeJavaScript(
      '!!(window.__pagedownResult && window.__pagedownResult.ready) && ' +
        "!!document.querySelector('.pagedjs_page')"
    )) as boolean
    if (!ready) return null

    const [winImage, viewImage] = await Promise.all([
      win.webContents.capturePage(),
      view.webContents.capturePage()
    ])
    const contentBounds = win.getContentBounds()
    return {
      window: winImage.toPNG().toString('base64'),
      view: viewImage.toPNG().toString('base64'),
      windowDip: { width: contentBounds.width, height: contentBounds.height },
      viewDip: view.getBounds()
    }
  })
}

/**
 * Pastes the preview capture into the window capture at the app-reported
 * bounds, scaling the offset by the ratio actually observed between the
 * captured bitmap and the window's DIP size -- measured rather than assumed,
 * so this is correct on Retina and non-Retina displays alike.
 */
async function compositeSplit(win: Page, capture: SplitCapture): Promise<string> {
  const dataUrl = await win.evaluate(async (input: SplitCapture) => {
    // Deliberately written with NO named function bindings inside this
    // callback. tsx compiles through esbuild with keepNames on, which
    // rewrites `const f = () => {}` into `const f = __name(() => {}, 'f')`
    // -- and __name does not exist in the page context Playwright
    // serializes this into, so any inner named function fails at runtime
    // with `ReferenceError: __name is not defined`. Anonymous callbacks
    // passed straight to .find()/.map() are untouched and remain fine.
    const bitmaps: ImageBitmap[] = []
    for (const base64 of [input.window, input.view]) {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      // A Blob, not a data: URL on an <img> -- createImageBitmap is not a
      // fetch, so the renderer's default-src 'self' CSP never applies.
      bitmaps.push(await createImageBitmap(new Blob([bytes], { type: 'image/png' })))
    }
    const [windowBitmap, viewBitmap] = bitmaps

    const scale = windowBitmap.width / input.windowDip.width
    const canvas = document.createElement('canvas')
    canvas.width = windowBitmap.width
    canvas.height = windowBitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(windowBitmap, 0, 0)
    ctx.drawImage(
      viewBitmap,
      Math.round(input.viewDip.x * scale),
      Math.round(input.viewDip.y * scale),
      Math.round(input.viewDip.width * scale),
      Math.round(input.viewDip.height * scale)
    )
    return canvas.toDataURL('image/png')
  }, capture)

  return dataUrl.replace(/^data:image\/png;base64,/, '')
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })

  const { app, close } = await launchIsolatedApp(['out/main/index.js'])
  try {
    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    // --- Home ------------------------------------------------------------
    await win.waitForSelector('text=New document')
    // Templates render their thumbnails through the real pagination harness;
    // give them a moment so the gallery isn't captured mid-load.
    await win.waitForTimeout(2500)
    console.log('Home')
    await save('home', await captureWindow(app))

    // --- Load the demo document via Source mode --------------------------
    // Filling the raw textarea is instantaneous and exact, where typing the
    // same content through the Format canvas would be slow and would run
    // every input rule along the way.
    await win.getByRole('button', { name: 'New document' }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')
    await win.getByRole('button', { name: 'Source', exact: true }).first().click()
    const sourceArea = win.locator('textarea').first()
    await sourceArea.waitFor()
    await sourceArea.fill(DEMO_DOCUMENT)
    await win.waitForTimeout(600)

    // --- Source mode -----------------------------------------------------
    // Captured here, while Source is already on screen, rather than
    // switching back to it later -- one fewer mode switch, one fewer toast.
    //
    // fill() leaves the caret at the end, so the textarea is scrolled to the
    // bottom. Scroll back to the top: the frontmatter block is the thing
    // worth showing here, since it is where page size, margins and the
    // running header/footer actually live.
    await sourceArea.evaluate((el) => {
      el.scrollTop = 0
    })
    await win.waitForTimeout(TOAST_SETTLE_MS)
    console.log('Source mode')
    await save('source-mode', await captureWindow(app))

    // --- Format mode -----------------------------------------------------
    await win.getByRole('button', { name: 'Format', exact: true }).first().click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')
    // Zoom out so a WHOLE page and the seam after it are on screen. At the
    // default 100% only the top of page one is visible, which shows a
    // page-first editor demonstrating no pages -- the one thing this
    // screenshot exists to show. 50% is the only stop on the app's own zoom
    // scale at which a full Letter page fits this window's content area.
    await win.getByLabel('Zoom level').selectOption('0.5')
    await win.waitForTimeout(TOAST_SETTLE_MS)
    console.log('Format mode')
    await save('format-mode', await captureWindow(app))

    // --- Split mode (composite) ------------------------------------------
    await win.getByRole('button', { name: 'Split', exact: true }).click()
    await win.waitForSelector('[data-testid="split-preview-placeholder"]')

    let split: SplitCapture | null = null
    const deadline = Date.now() + SPLIT_RENDER_TIMEOUT_MS
    while (Date.now() < deadline) {
      split = await captureSplit(app)
      if (split) break
      await win.waitForTimeout(500)
    }
    if (!split) {
      throw new Error('Split preview never reported a finished render; nothing to composite')
    }
    // Re-capture after the toast has cleared. The render itself is already
    // known finished at this point, so this only waits out the notification.
    await win.waitForTimeout(TOAST_SETTLE_MS)
    split = await captureSplit(app)
    if (!split) {
      throw new Error('Split preview went away while waiting for the toast to clear')
    }
    console.log(
      `Split mode  (preview view at ${split.viewDip.x},${split.viewDip.y} ` +
        `${split.viewDip.width}x${split.viewDip.height} DIP)`
    )
    await save('split-mode', await compositeSplit(win, split))

    // --- Page Setup ------------------------------------------------------
    await win
      .getByRole('button', { name: /Page Setup/i })
      .first()
      .click()
    await win.waitForTimeout(800)
    console.log('Page Setup')
    await save('page-setup', await captureWindow(app))
    await win.keyboard.press('Escape')
    await win.waitForTimeout(500)

    console.log(`\nDone. ${OUT_DIR}`)
  } finally {
    await close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
