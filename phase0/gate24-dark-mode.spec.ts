import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchIsolatedApp } from './electron-launch'

// Gate 24 -- App-level dark mode, against the REAL built app.
//
// WHY THIS GATE EXISTS. Dark mode is inherently a visual feature -- CSS
// custom-property overrides under `:root[data-theme='dark']`
// (src/renderer/src/assets/base.css) either resolve correctly in a real
// browser or they don't, and jsdom-based component tests (App.test.tsx)
// can only prove `document.documentElement.dataset.theme` gets SET
// correctly, not that any real element actually PAINTS a different color
// as a result. This gate reads real `getComputedStyle` values out of the
// actual running app, proving both halves of this feature's own core
// invariant in one run: the app-shell CHROME genuinely goes dark, and
// document content (the page card, the Milkdown canvas) genuinely does
// NOT -- the print-fidelity guarantee this whole app exists for.

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

let app: ElectronApplication | undefined
let close: (() => Promise<void>) | undefined
let win: Page

test.setTimeout(90_000)

test('Gate 24: switching to Dark genuinely repaints the chrome while the document page stays light', async () => {
  const launched = await launchIsolatedApp(['out/main/index.js'])
  app = launched.app
  close = launched.close

  try {
    win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    // Real baseline, in Light (the real default before this test touches
    // anything): the Settings header bar's real painted background.
    await win.getByRole('button', { name: 'Settings' }).click()
    const settingsHeader = win.locator('h1', { hasText: 'Settings' }).locator('..')
    const lightHeaderBg = await settingsHeader.evaluate(
      (el) => getComputedStyle(el).backgroundColor
    )
    console.log('Gate 24 Settings header bg (light):', lightHeaderBg)

    // Real user action: switch Color scheme to Dark.
    await win.getByRole('combobox', { name: 'Color scheme' }).selectOption('dark')

    await expect
      .poll(() => win.evaluate(() => document.documentElement.dataset.theme), {
        message: 'expected <html data-theme="dark"> after selecting Dark',
        timeout: 10_000
      })
      .toBe('dark')

    const darkHeaderBg = await settingsHeader.evaluate((el) => getComputedStyle(el).backgroundColor)
    console.log('Gate 24 Settings header bg (dark):', darkHeaderBg)
    expect(darkHeaderBg, 'the chrome must genuinely repaint to a different color in Dark').not.toBe(
      lightHeaderBg
    )
    // The real dark-mode --color-page value (#2c2c2f) this app ships.
    expect(darkHeaderBg).toBe('rgb(44, 44, 47)')

    // Now open a real document and confirm the PAGE ITSELF ignores dark
    // mode entirely -- the actual print-fidelity invariant.
    await win.getByRole('button', { name: '← Home' }).click()
    await win.getByRole('button', { name: 'New document' }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')

    const pageCard = win.getByTestId('page-card')
    const pageCardBg = await pageCard.evaluate((el) => getComputedStyle(el).backgroundColor)
    console.log('Gate 24 page-card bg (app in Dark):', pageCardBg)
    expect(pageCardBg, 'the page card must stay white regardless of app theme').toBe(
      'rgb(255, 255, 255)'
    )

    // Type real text so there's a real paragraph to measure text color on.
    await win.locator('.milkdown-mount .ProseMirror').click()
    await win.keyboard.type('Real document text.')
    const paragraphColor = await win
      .locator('.milkdown-mount .ProseMirror p')
      .first()
      .evaluate((el) => getComputedStyle(el).color)
    console.log('Gate 24 document paragraph text color (app in Dark):', paragraphColor)
    // The real light-mode text-primary value (#202124) this app ships --
    // must hold even though the app chrome around it is dark.
    expect(paragraphColor).toBe('rgb(32, 33, 36)')

    // And the surrounding chrome (the toolbar) really is dark at the same
    // time, proving this isn't "dark mode silently did nothing at all".
    const toolbarBg = await win
      .getByRole('button', { name: '← Home' })
      .locator('..')
      .evaluate((el) => getComputedStyle(el).backgroundColor)
    console.log('Gate 24 editor toolbar bg (app in Dark):', toolbarBg)
    expect(toolbarBg).not.toBe('rgb(255, 255, 255)')
  } finally {
    if (app && close) await safeClose(app, close)
  }
})
