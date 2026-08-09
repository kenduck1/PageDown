import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'

// Real, end-to-end coverage for page navigation
// (docs/superpowers/specs/2026-08-08-page-navigation-design.md): a real
// click on the real status bar's "Next page" control, through the real
// appStore -> SplitPreview -> split-preview:scrollToPage IPC ->
// createSplitPreviewHarness -> executeJavaScript path, into the real
// sandboxed pagedown-render:// context, ending in a real scroll of real
// Paged.js output.
//
// WHY THIS GATE EXISTS AT ALL: every renderer-side assertion for this
// feature runs under jsdom, which has no layout engine, no Electron, and no
// sandbox. A jsdom test can prove `window.api.scrollSplitPreviewToPage` was
// called with 2; it structurally CANNOT prove that anything scrolled, that
// `.pagedjs_page` elements exist, or that the second one ended up at the
// top of the pane. That cross-process round trip is the entire feature, so
// this is the only place it can be verified.
//
// Uses launchIsolatedApp (phase0/electron-launch.ts), never a bare
// electron.launch() -- see that helper's own comment and CLAUDE.md's
// Testing section for why a bare launch silently reads/writes the
// developer's real userData directory.
//
// close() is wrapped in try/finally via the bounded safeClose below,
// following gate15-split-mode.spec.ts's own template (which CLAUDE.md names
// as the one to copy): under real host load, _electron's app.close() can
// hang indefinitely, so this races it against a deadline and SIGKILLs the
// process tree on expiry.
//
// ASSERTION MECHANISM: the paginated DOM lives ONLY inside a sandboxed
// WebContentsView with no preload and no contextBridge, so it is by design
// unreachable from the renderer -- and gate15 separately proved that
// contextBridge deep-freezes window.api, making renderer-side spying
// impossible anyway. So this reads the sandbox through app.evaluate() +
// mainWindow.contentView.children + executeJavaScript, the same family as
// asset-evidence.ts's readImageBoxes (used by gate8/gate12) and gate15's
// own probeSplitPreviewView -- NOT the discouraged __pagedownPhase0 bridge.

const GET_MAIN_WINDOW_TIMEOUT_MS = 60_000
const CLOSE_TIMEOUT_MS = 15_000

// Same POSITIVE file:// match as gate9/gate11/gate12/gate14/gate15's own
// getMainWindow -- this app opens a SECOND window at startup (the Phase 0
// spike's sandboxed pagedown-render:// harness), and both firstWindow() and
// a negative "isn't pagedown-render://" filter would race or misidentify it.
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
  throw new Error('Timed out locating the main app-shell window (only found the sandboxed one)')
}

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
      // SIGKILL, not SIGTERM -- a hung app.close() means the graceful
      // shutdown path is itself what isn't completing.
      app.process().kill('SIGKILL')
    } catch {
      // Best-effort; the process may already be gone.
    }
  }
}

interface PageScrollProbe {
  scrollY: number
  pageCount: number
  /** Each .pagedjs_page's viewport-relative top, in document order. */
  pageTops: number[]
}

// Reads the REAL scroll state of the real sandboxed split-preview context.
//
// Disambiguation (same as gate15's): this mainWindow also hosts a SECOND,
// unrelated pagedown-render:// WebContentsView from app startup -- the
// Phase 0 spike harness, parked permanently off-screen at {x:-9999,y:-9999}.
// Filtering to a genuinely on-screen rectangle is what isolates the split
// preview's own view from that pre-existing one.
async function probePageScroll(app: ElectronApplication): Promise<PageScrollProbe | null> {
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

    return (await splitView.webContents.executeJavaScript(
      `(() => {
         const pages = Array.from(document.querySelectorAll('.pagedjs_page'))
         return {
           scrollY: window.scrollY,
           pageCount: pages.length,
           pageTops: pages.map((p) => p.getBoundingClientRect().top)
         }
       })()`
    )) as PageScrollProbe
  })
}

// Deliberately long enough to guarantee 3+ real pages at the default
// Letter/1in geometry (624 x 864px content box, 14px/1.7 body text). 40
// heading+paragraph blocks is comfortably past that with real margin, so
// this gate does not become flaky if typography is retuned by a few px.
function buildMultiPageFixture(): string {
  const blocks: string[] = ['# Gate 18 Page Navigation Fixture', '']
  for (let i = 1; i <= 40; i += 1) {
    blocks.push(`## Section ${i}`)
    blocks.push('')
    blocks.push(
      `Body paragraph for section ${i}. This fixture exists to produce a genuinely ` +
        'multi-page document through the real Paged.js pipeline, so that page ' +
        'navigation has real page boundaries to move between rather than a ' +
        'single-page document where every target resolves to page one.'
    )
    blocks.push('')
  }
  return blocks.join('\n')
}

test('Gate 18: clicking "Next page" really scrolls the sandboxed paginated preview to page 2', async () => {
  test.setTimeout(120_000)

  let app: ElectronApplication | undefined
  let close: (() => Promise<void>) | undefined
  let fixtureDir: string | undefined
  let userDataDir: string | undefined
  let originalRecents: Awaited<ReturnType<typeof readRecentFiles>> | undefined

  try {
    const launched = await launchIsolatedApp(['out/main/index.js'])
    app = launched.app
    close = launched.close

    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    // Confirm the isolated userData override really took effect before
    // writing into it -- same proof as gate11/gate5.
    userDataDir = await app.evaluate(({ app }) => app.getPath('userData'))
    expect(await realpath(userDataDir)).toBe(await realpath(launched.userDataDir))

    fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate18-'))
    const fixtureFilename = 'gate18-navigation.md'
    const fixturePath = join(fixtureDir, fixtureFilename)
    await writeFile(fixturePath, buildMultiPageFixture(), 'utf8')

    // Seed the fixture into the real allowlist that isKnownPath checks, so
    // the real file:openPath handler will actually open it.
    originalRecents = await readRecentFiles(userDataDir)
    await writeRecentFiles(
      userDataDir,
      mergeRecentFiles(originalRecents, fixturePath, new Date().toISOString())
    )

    // HomeScreen fetches recentFiles once on mount, which already ran with
    // the pre-seed allowlist. Reload so it re-fetches with our fixture.
    await win.reload()
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    await win
      .getByRole('button', { name: new RegExp(fixtureFilename.replace(/[.]/g, '\\.')) })
      .click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')

    // The status bar's own real, Paged.js-derived count must arrive and be
    // genuinely multi-page before navigation means anything.
    const readout = win.getByRole('button', { name: /^Page \d+ of \d+$/ })
    await expect(readout).toBeVisible({ timeout: 30_000 })
    await expect(readout).toHaveText(/^Page 1 of \d+$/)
    const totalPages = Number(/of (\d+)$/.exec((await readout.textContent()) ?? '')?.[1] ?? '0')
    expect(totalPages).toBeGreaterThanOrEqual(3)

    // Real click on the real toolbar's Split button. `exact: true` rules
    // out the unrelated "Split cell" table-toolbar button.
    await win.getByRole('button', { name: 'Split', exact: true }).click()
    await expect(win.getByTestId('split-preview-placeholder')).toBeVisible()

    // Wait for the real sandboxed render to actually produce pages.
    let before: PageScrollProbe | null = null
    await expect
      .poll(
        async () => {
          before = await probePageScroll(app!)
          return before?.pageCount ?? 0
        },
        { timeout: 40_000, intervals: [500] }
      )
      .toBeGreaterThanOrEqual(3)

    // ASSERTION 1 -- baseline: the preview starts at the top, on page 1.
    expect(before).not.toBeNull()
    expect(before!.scrollY).toBe(0)

    // ASSERTION 2 -- the real cross-process navigation actually scrolled
    // the sandboxed document, and landed the SECOND page at the top of the
    // pane. Checking the second page's own rect (not merely "scrollY grew")
    // is what makes this a page-navigation assertion rather than a
    // scrolled-by-some-amount assertion.
    await win.getByRole('button', { name: 'Next page' }).click()

    let after: PageScrollProbe | null = null
    await expect
      .poll(
        async () => {
          after = await probePageScroll(app!)
          return after ? Math.abs(after.pageTops[1] ?? Number.NaN) : Number.NaN
        },
        { timeout: 20_000, intervals: [250] }
      )
      // scrollIntoView({ block: 'start' }) puts the target's top edge at the
      // viewport top; a few px of tolerance absorbs sub-pixel layout.
      .toBeLessThanOrEqual(3)

    expect(after).not.toBeNull()
    expect(after!.scrollY).toBeGreaterThan(0)
    expect(after!.pageCount).toBe(before!.pageCount)

    // ASSERTION 3 -- the round trip closed back into the real UI. Without
    // this, the sandbox could be scrolling correctly while the status bar
    // still claimed page 1, which is the state the feature existed to fix.
    await expect(win.getByRole('button', { name: `Page 2 of ${totalPages}` })).toBeVisible()
  } finally {
    if (userDataDir && originalRecents) {
      await writeRecentFiles(userDataDir, originalRecents).catch(() => {})
    }
    if (fixtureDir) {
      await rm(fixtureDir, { recursive: true, force: true }).catch(() => {})
    }
    if (app && close) {
      await safeClose(app, close)
    }
  }
})
