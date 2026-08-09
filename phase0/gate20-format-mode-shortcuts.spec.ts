import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'
import { launchIsolatedApp } from './electron-launch'

// Same helper (and same reasoning) as gate9/gate10/gate11/gate17: this app
// launches a SECOND window at startup whose page loads under the sandboxed
// pagedown-render:// scheme with zero contextBridge access. Matched by a
// POSITIVE file:// check rather than a negative exclusion, because every
// window starts on about:blank before its real navigation completes.
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

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

interface OpenedFixture {
  app: ElectronApplication
  close: () => Promise<void>
  win: Page
  fixtureDir: string
  restoreRecents: () => Promise<void>
}

// Same seed-into-recents-then-click-through-Home-screen approach as
// gate17's own openFixtureDocument.
async function openFixtureDocument(body: string): Promise<OpenedFixture> {
  const {
    app,
    close,
    userDataDir: expectedUserDataDir
  } = await launchIsolatedApp(['out/main/index.js'])
  const win = await getMainWindow(app)
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

  const userDataDir = await app.evaluate(({ app }) => app.getPath('userData'))
  expect(await realpath(userDataDir)).toBe(await realpath(expectedUserDataDir))

  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate20-'))
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const fixtureFilename = `gate20-fixture-${nonce}.md`
  const fixturePath = join(fixtureDir, fixtureFilename)
  await writeFile(fixturePath, body, 'utf8')

  const originalRecents = await readRecentFiles(userDataDir)
  const restoreRecents = async (): Promise<void> => {
    await writeRecentFiles(userDataDir, originalRecents)
  }

  const seeded = mergeRecentFiles(originalRecents, fixturePath, new Date().toISOString())
  await writeRecentFiles(userDataDir, seeded)

  await win.reload()
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
  await win
    .getByRole('button', { name: new RegExp(fixtureFilename.replace(/[.]/g, '\\.')) })
    .click()
  await win.waitForSelector('.milkdown-mount .ProseMirror')

  return { app, close, win, fixtureDir, restoreRecents }
}

test('Gate 20: Mod-Z undoes and Mod-Shift-Z redoes a real Format-mode edit', async () => {
  test.setTimeout(90_000)

  const fixture = await openFixtureDocument('# Gate 20 Fixture\n\nOriginal text.\n')
  const { close, win, fixtureDir, restoreRecents } = fixture

  try {
    const paragraph = win.locator('.milkdown-mount .ProseMirror p')
    await expect(paragraph).toHaveText('Original text.')

    // A real click to place a real cursor, then real typing -- not a
    // programmatic content mutation.
    await paragraph.click()
    await win.keyboard.press('End')
    await win.keyboard.type(' Added text.', { delay: 20 })
    await expect(paragraph).toHaveText('Original text. Added text.')

    // The real accelerator through Chromium's own input pipeline -- the
    // whole point of this gate, per its own header.
    await win.keyboard.press(`${MOD}+z`)
    await expect(paragraph).toHaveText('Original text.')

    await win.keyboard.press(`${MOD}+Shift+z`)
    await expect(paragraph).toHaveText('Original text. Added text.')
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})
