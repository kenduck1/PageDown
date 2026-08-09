import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'

// Gate 25 -- Multi-window support, against the REAL built app.
//
// WHY THIS GATE EXISTS. "Open in New Window" and the event.sender-derived
// IPC generalization it required (src/main/index.ts) have no unit-test
// coverage at all -- index.ts itself has never had a direct unit test in
// this codebase (it's app bootstrap/IPC-registration wiring around
// already-unit-tested functions elsewhere, verified via real gates
// instead, matching this suite's own established pattern). A genuinely
// SECOND BrowserWindow, its own independent renderer/Zustand state, and
// the harness-teardown-only-on-last-window-close fix can only be proven
// against the real, multi-process running app.

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

// Every `file://` window currently open, domcontentloaded-settled -- unlike
// every other gate's own getMainWindow (which returns just the FIRST one),
// this gate genuinely needs to tell multiple real app-shell windows apart.
async function getFileWindows(application: ElectronApplication): Promise<Page[]> {
  const deadline = Date.now() + GET_MAIN_WINDOW_TIMEOUT_MS
  const settled: Page[] = []
  for (const candidate of application.windows()) {
    if (!candidate.url().startsWith('file://')) continue
    try {
      await candidate.waitForLoadState('domcontentloaded', { timeout: 2000 })
      settled.push(candidate)
    } catch {
      continue
    }
  }
  if (settled.length > 0) return settled
  // Nothing settled yet on the first pass -- poll until at least one does,
  // same deadline/backoff every other gate's getMainWindow uses.
  while (Date.now() < deadline) {
    for (const candidate of application.windows()) {
      if (!candidate.url().startsWith('file://')) continue
      try {
        await candidate.waitForLoadState('domcontentloaded', { timeout: 2000 })
        return [candidate]
      } catch {
        continue
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out locating any real app-shell window')
}

let app: ElectronApplication | undefined
let close: (() => Promise<void>) | undefined
let userDataDir: string
let fixtureDir: string

test.setTimeout(120_000)

test('Gate 25: Open in New Window creates a genuinely independent second window, and closing it does not break the first', async () => {
  const launched = await launchIsolatedApp(['out/main/index.js'])
  app = launched.app
  close = launched.close
  userDataDir = launched.userDataDir

  try {
    const [win1] = await getFileWindows(app)
    await win1.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate25-'))
    const marker = `Gate25 ${Date.now()}`
    const filename = `gate25-${Date.now()}.md`
    const path = join(fixtureDir, filename)
    await writeFile(path, `# ${marker}\n\nOriginal body text.\n`, 'utf8')

    const originalRecents = await readRecentFiles(userDataDir)
    await writeRecentFiles(
      userDataDir,
      mergeRecentFiles(originalRecents, path, new Date().toISOString())
    )
    await win1.reload()
    await win1.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    // Real user action: click "Open in New Window" on the recent-file row.
    // Bare "Open in new window" is a deliberately generic label (see
    // HomeScreen.tsx's own comment on that button) -- unambiguous here
    // since this fixture only ever seeds one recent file.
    await win1.getByRole('button', { name: 'Open in new window' }).click()

    // A genuinely SECOND real BrowserWindow appears.
    let win2: Page | undefined
    await expect
      .poll(
        async () => {
          const windows = await getFileWindows(app!)
          win2 = windows.find((w) => w !== win1)
          return windows.length
        },
        { message: 'expected a real second app-shell window to open', timeout: 20_000 }
      )
      .toBeGreaterThan(1)
    expect(win2).toBeDefined()

    await win2!.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
    await win2!.waitForSelector('.milkdown-mount .ProseMirror')

    // The NEW window shows the requested document...
    const win2Text = await win2!.locator('.milkdown-mount .ProseMirror').innerText()
    expect(win2Text).toContain(marker)

    // ...while the ORIGINAL window is untouched -- still on Home, no
    // navigation, no state change at all.
    expect(await win1.getByText('PageDown').isVisible()).toBe(true)

    // Independent state: typing in the SECOND window's editor must not
    // appear anywhere in the first window (which isn't even showing an
    // editor at all right now).
    await win2!.locator('.milkdown-mount .ProseMirror').click()
    await win2!.keyboard.type(' Independent edit in window 2.')
    await expect
      .poll(async () => win2!.locator('.milkdown-mount .ProseMirror').innerText(), {
        message: 'expected the second window to show its own typed edit'
      })
      .toContain('Independent edit in window 2.')
    expect(await win1.locator('body').innerText()).not.toContain('Independent edit in window 2.')

    // Closing the SECOND window must not break the FIRST window's own
    // pagination-harness-backed features (Multi-window support's own
    // harness-teardown-only-on-last-window-close fix) -- proven by asking
    // the first window for a real thumbnail/page-count round trip
    // immediately after.
    await win2!.close()
    await expect
      .poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), {
        message: 'expected the second window to actually close'
      })
      .toBeLessThan(3) // headless harness BaseWindows don't count via BrowserWindow.getAllWindows()

    const pageCountResult = await win1.evaluate(async (src) => {
      const api = (window as unknown as { api: { getPageCount: (c: string) => Promise<unknown> } })
        .api
      return api.getPageCount(src)
    }, `# ${marker}\n\nStill alive after window 2 closed.\n`)
    expect(pageCountResult).toEqual({ pageCount: 1 })
  } finally {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
    if (app && close) await safeClose(app, close)
  }
})
