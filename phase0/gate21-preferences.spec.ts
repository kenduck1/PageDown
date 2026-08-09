import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'

// Gate 21 -- the Settings/Preferences panel + Spell check sub-project's real
// end-to-end proof.
//
// WHY THIS GATE EXISTS. Every renderer-side test for this feature
// (SettingsScreen.test.tsx, preferences.test.ts) runs either under jsdom
// (no real disk, no real Electron session) or against a plain Vitest temp
// directory with no app around it at all. Three things that code can't
// prove on its own: (1) that `preferences:get`/`preferences:set` really
// round-trip through a real `userData/preferences.json` file via real IPC,
// surviving a real renderer reload; (2) that toggling spell check in the
// UI really flips a live Electron `session`'s spellchecker state, not just
// a value sitting in a JSON file nobody reads; (3) that a changed default
// page config in Settings really reaches a brand-new blank document's own
// YAML frontmatter, through the real `applyPageConfig`/`replaceRawFrontmatter`
// pipeline HomeScreen.tsx wires up. Native OS UI (the spellcheck
// suggestion context menu itself, a `Menu.popup()`) is NOT exercised here,
// for the same reason Gate 20/print couldn't automate a native dialog --
// nothing about that surface is scriptable from Playwright. What IS
// automatable is exercised below.
//
// Serial, one app instance for the whole file: later tests deliberately
// build on state earlier tests left behind (the changed default page
// config from the persistence test is what the frontmatter test checks),
// the same structure Gate 14/Gate 19 use for the same reason.

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

// Same positive `file://` filter every other gate's getMainWindow uses --
// this app also opens a second, sandboxed pagedown-render:// window at
// startup, and both windows start on about:blank before their real
// navigation completes.
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
let userDataDir: string

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

test.beforeAll(async () => {
  test.setTimeout(120_000)
  const launched = await launchIsolatedApp(['out/main/index.js'])
  app = launched.app
  close = launched.close
  userDataDir = launched.userDataDir
  win = await getMainWindow(app)
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
})

test.afterAll(async () => {
  if (app && close) await safeClose(app, close)
})

test.describe('Gate 21: Settings/Preferences + spellcheck', () => {
  test('the real DEFAULT_PREFERENCES load from disk on first launch (no preferences.json yet)', async () => {
    await win.getByRole('button', { name: 'Settings' }).click()

    await expect(win.getByRole('checkbox', { name: 'Spell check' })).toBeChecked()
    await expect(win.getByRole('spinbutton', { name: /autosave interval/i })).toHaveValue('45')
    await expect(win.getByRole('combobox', { name: 'Page size' })).toHaveValue('Letter')
    await expect(win.getByRole('combobox', { name: 'Orientation' })).toHaveValue('portrait')
    await expect(win.getByRole('combobox', { name: 'Theme' })).toHaveValue('default')
    await expect(win.getByRole('combobox', { name: 'Font' })).toHaveValue('source-serif-4')
  })

  test('changing preferences writes real, correct JSON to userData/preferences.json, and reloading the app reflects it', async () => {
    await win.getByRole('checkbox', { name: 'Spell check' }).click()

    await win.getByRole('spinbutton', { name: /autosave interval/i }).fill('90')

    await win.getByRole('combobox', { name: 'Page size' }).selectOption('A4')
    await win.getByRole('combobox', { name: 'Orientation' }).selectOption('landscape')
    await win.getByRole('combobox', { name: 'Theme' }).selectOption('resume')
    await win.getByRole('combobox', { name: 'Font' }).selectOption('inter')

    // setPreferences is fire-and-forget from the renderer (documentStore's
    // own established pattern for exactly this reason -- see CLAUDE.md's
    // autosave section), so this polls the real file on disk rather than
    // asserting immediately after the last UI action.
    const prefsPath = join(userDataDir, 'preferences.json')
    await expect
      .poll(
        async () => {
          try {
            return JSON.parse(await readFile(prefsPath, 'utf8'))
          } catch {
            return null
          }
        },
        { message: 'expected preferences.json to be written with the new values', timeout: 15_000 }
      )
      .toMatchObject({
        spellcheckEnabled: false,
        autosaveIntervalMs: 90_000,
        defaultPageConfig: {
          pageSize: 'A4',
          orientation: 'landscape',
          theme: 'resume',
          fontFamily: 'inter'
        }
      })

    // Reload the renderer (not a fresh app launch) -- proves App.tsx's own
    // startup getPreferences() call really reads back what was just
    // persisted, through the real preferences:get IPC round trip.
    await win.reload()
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
    await win.getByRole('button', { name: 'Settings' }).click()

    await expect(win.getByRole('checkbox', { name: 'Spell check' })).not.toBeChecked()
    await expect(win.getByRole('spinbutton', { name: /autosave interval/i })).toHaveValue('90')
    await expect(win.getByRole('combobox', { name: 'Page size' })).toHaveValue('A4')
    await expect(win.getByRole('combobox', { name: 'Orientation' })).toHaveValue('landscape')
    await expect(win.getByRole('combobox', { name: 'Theme' })).toHaveValue('resume')
    await expect(win.getByRole('combobox', { name: 'Font' })).toHaveValue('inter')
  })

  test('toggling spell check applies LIVE to the real Electron session, not only to disk', async () => {
    // Left off (from the previous test) at spellcheckEnabled: false.
    const disabledLive = await app!.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w.webContents.getURL().startsWith('file://')
      )
      return mainWindow ? mainWindow.webContents.session.isSpellCheckerEnabled() : null
    })
    expect(disabledLive, 'the real session must have spellcheck disabled after the toggle').toBe(
      false
    )

    await win.getByRole('checkbox', { name: 'Spell check' }).click()

    await expect
      .poll(
        async () =>
          app!.evaluate(({ BrowserWindow }) => {
            const mainWindow = BrowserWindow.getAllWindows().find(
              (w) => !w.isDestroyed() && w.webContents.getURL().startsWith('file://')
            )
            return mainWindow ? mainWindow.webContents.session.isSpellCheckerEnabled() : null
          }),
        { message: 'expected the real session to re-enable spellcheck live', timeout: 10_000 }
      )
      .toBe(true)
  })

  test('the changed default page config really flows into a brand-new blank document’s YAML frontmatter', async () => {
    // Page size/orientation/theme/font are still A4/landscape/resume/inter,
    // left set by the persistence test above -- this test proves that
    // saved default genuinely drives HomeScreen's own handleNewDocument,
    // not merely that Settings can display and persist it.
    await win.getByRole('button', { name: '← Home' }).click()
    await win.getByRole('button', { name: 'New document' }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')

    // Switch to Source mode through the real toolbar segmented control to
    // read the exact underlying Markdown bytes, same technique Gate 17
    // uses for the same reason (a textarea showing the raw file, not a
    // rendered view of it).
    await win.getByRole('button', { name: 'Source', exact: true }).click()
    const textarea = win.getByRole('textbox', { name: 'Markdown source' })
    await expect(textarea).toBeVisible()

    const source = await textarea.inputValue()
    console.log('Gate 21 new-document frontmatter:', source.split('---')[1])

    expect(source, 'must start with a real YAML frontmatter block').toMatch(/^---\n/)
    expect(source).toContain('page: A4')
    expect(source).toContain('orientation: landscape')
    expect(source).toContain('theme: resume')
    expect(source).toContain('fontFamily: inter')
  })
})
