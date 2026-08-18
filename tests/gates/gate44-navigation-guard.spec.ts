import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'

// Gate 44 -- the privileged renderer cannot be navigated away from the app,
// and a drop onto app chrome cannot navigate it either.
//
// Numbered 44 because 43 (composer popovers) was already taken; per
// CLAUDE.md, check `git ls-tree main tests/gates/` before claiming a number.
//
// WHY THIS GATE EXISTS.
// `setWindowOpenHandler` was already correct -- it denies every `window.open`
// and only hands http/https to `shell.openExternal`. But it covers exactly
// one vector. There was no `will-navigate` handler on any document window,
// and nothing suppressed the browser's default action for a file dropped on
// the app's own chrome. Measured against the real built app before the fix:
//
//   BEFORE : origin=file://, window.api = object (44 methods)
//   NAV    : window.location.href = 'file:///…/evil.html'  -> assigned
//   AFTER  : href=…/evil.html, body="ATTACKER PAGE", window.api = object (44)
//
// That last line is the whole finding. `contextBridge` re-runs the preload
// for the new document, so the app's entire 44-method bridge -- `saveFile`,
// `openPath`, `getRecentFiles`, `exportPdf`, `setPreferences`,
// `resolveLocalImage` -- was handed to attacker-controlled content. The CSP
// on index.html cannot help: CSP governs a document's own subresources, and
// the navigated-to page brings its own (absent) policy. This is item 12 of
// Electron's security checklist ("disable or limit navigation").
//
// WHY A GATE AND NOT A UNIT TEST. Both halves are properties of real
// Chromium, not of any function this repo owns. `will-navigate` is emitted by
// the browser process; jsdom has no navigation to speak of, and no
// `webContents` to attach to. The drop half is worse: jsdom has no DragEvent
// at all (CLAUDE.md already records `fireEvent.drop` silently discarding
// `clientX` for exactly this reason), so a jsdom test could assert a listener
// exists but never that the default action is actually suppressed.
//
// WHY THE DROP HALF ASSERTS `defaultPrevented` RATHER THAN "it did not
// navigate". Chromium's navigate-on-drop is the DEFAULT ACTION of a real OS
// drag, and a synthetic `DragEvent` dispatched from script carries no OS
// payload and triggers no default action -- so a synthetic drop can never
// navigate, and a test asserting "we are still on the app page" after one
// would pass just as happily with the fix reverted. Vacuous. What genuinely
// discriminates is whether the app cancels the event: cancelling `dragover`
// plus `drop` is precisely the mechanism that stops the native default, so
// asserting `defaultPrevented` on both tests the real control.
//
// ONE LAUNCH, SHARED BY BOTH TESTS, AND THE ORDER IS DELIBERATE.
// CLAUDE.md's Testing section records sequential `_electron` launches as the
// axis this suite's environmental flake correlates with -- a launch that
// hangs inside `launchIsolatedApp` before any test logic runs, producing a
// bare timeout that reaches no assertion. Measured while writing this gate:
// an untouched gate11 failed 1 of 3 runs at load average 4.9-6.7, so two
// launches here would double the exposure for no benefit. A serial describe
// with one `beforeAll` launch keeps both assertions independently named --
// so a failure still says WHICH control broke -- at half the risk.
//
// The drop test runs FIRST on purpose. If the navigation guard ever
// regresses, the nav test leaves the window sitting on the attacker page,
// and a drop test running afterwards would then be probing THAT document
// rather than the app -- a second, misleading failure pointing at the wrong
// control. Ordered this way, a navigation regression fails exactly one test.
//
// MUTATION-VERIFIED, each half independently:
//   * neutering only the renderer drop guard fails the drop test by name
//     ("dragover must be cancelled -- Expected: true, Received: false")
//     while the navigation test still passes;
//   * removing only `will-navigate` fails the navigation test by name
//     (Expected ".../out/renderer/index.html", Received ".../evil.html").

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

// How long to let a navigation actually happen before concluding it did not.
// A prevented navigation produces no event to await, so this is a real wait
// rather than a poll: too short and the test passes because Chromium had not
// got round to navigating yet, which is the one way this assertion could go
// vacuous. Measured unguarded, the attacker page was live well inside 2.5s.
const NAVIGATION_SETTLE_MS = 3000

test.describe.configure({ mode: 'serial' })

test.describe('Gate 44: navigation guard', () => {
  let close: (() => Promise<void>) | undefined
  let win: Page
  let fixtureRoot: string | undefined

  test.beforeAll(async () => {
    const launched = await launchIsolatedApp(['out/main/index.js'])
    close = launched.close
    win = await getMainWindow(launched.app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
  })

  test.afterAll(async () => {
    if (close) await close()
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }).catch(() => {})
  })

  test('a drop on app chrome is cancelled, so it cannot navigate the window', async () => {
    // Dispatched on the app's own chrome -- not the editor canvas or the
    // Source textarea, both of which already cancel their own drops in order
    // to insert an image. The gap was everywhere ELSE: toolbar, sidebar, tab
    // bar, status bar, Home, Settings. `document.body` is chrome on every
    // screen, and the app opens on Home.
    const result = await win.evaluate(() => {
      const dragover = new Event('dragover', { bubbles: true, cancelable: true })
      document.body.dispatchEvent(dragover)
      const drop = new Event('drop', { bubbles: true, cancelable: true })
      document.body.dispatchEvent(drop)
      return { dragoverPrevented: dragover.defaultPrevented, dropPrevented: drop.defaultPrevented }
    })

    // Both matter, and for different reasons. An uncancelled `dragover` means
    // the window is not a drop target at all, so Chromium handles the drop
    // itself -- by navigating. A cancelled `dragover` with an uncancelled
    // `drop` is the worse of the two: the drop now fires at the page AND
    // still performs the browser default.
    expect(result.dragoverPrevented, 'dragover must be cancelled').toBe(true)
    expect(result.dropPrevented, 'drop must be cancelled').toBe(true)
  })

  test('a renderer-initiated navigation cannot leave the app origin', async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'pagedown-gate44-'))
    const attackerPage = join(fixtureRoot, 'evil.html')
    await writeFile(
      attackerPage,
      '<!doctype html><html><body><h1>PAGEDOWN_GATE44_ATTACKER</h1></body></html>',
      'utf8'
    )

    const appHrefBefore = await win.evaluate(() => window.location.href)
    expect(appHrefBefore).toContain('index.html')

    // Exactly what a stray <a href>, a scripted redirect, or the default
    // action of a dropped file would do. Assigning `location.href` is
    // renderer-initiated, which is what `will-navigate` exists to intercept.
    await win.evaluate((target) => {
      window.location.href = target
    }, `file://${attackerPage}`)

    await new Promise((resolve) => setTimeout(resolve, NAVIGATION_SETTLE_MS))

    const after = await win.evaluate(() => ({
      href: window.location.href,
      bodyText: document.body.innerText.slice(0, 200)
    }))

    expect(after.href, 'the app window must still be on its own document').toBe(appHrefBefore)
    expect(after.bodyText).not.toContain('PAGEDOWN_GATE44_ATTACKER')
  })
})
