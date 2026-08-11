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
    //
    // A SINGLE word, deliberately. This gate is about the accelerator
    // reaching the undo command at all, so its edit must be one undo group by
    // construction, whatever the grouping policy happens to be -- otherwise
    // it silently doubles as a grouping assertion and breaks whenever that
    // policy is tuned. It used to type " Added text." and expect one Mod-Z to
    // remove all of it, which was only true while undo grouped purely on
    // elapsed time; the word-boundary grouping in commands.ts
    // (historyGroupingProse) correctly makes that three groups. Granularity is
    // now asserted on purpose, by the separate test below.
    await paragraph.click()
    await win.keyboard.press('End')
    await win.keyboard.type('Addendum', { delay: 20 })
    await expect(paragraph).toHaveText('Original text.Addendum')

    // The real accelerator through Chromium's own input pipeline -- the
    // whole point of this gate, per its own header.
    await win.keyboard.press(`${MOD}+z`)
    await expect(paragraph).toHaveText('Original text.')

    await win.keyboard.press(`${MOD}+Shift+z`)
    await expect(paragraph).toHaveText('Original text.Addendum')
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})

// The user-reported bug this pins: undo used to group purely on elapsed time
// (prosemirror-history's `newGroupDelay`, nothing else), so how much one
// Cmd+Z removed was a function of typing SPEED -- a fast typist lost a whole
// sentence, a slow one got one character back per press. Grouping now breaks
// at word boundaries instead (commands.ts's historyGroupingProse).
//
// This belongs in a gate, not only in commands.test.ts's own unit coverage,
// for the reason this whole suite exists: the unit tests dispatch
// transactions directly and fake `Date`, because jsdom cannot deliver a real
// keystroke to ProseMirror at all (see commands.test.ts's own note). Only a
// real Chromium keypress at real wall-clock speed proves the policy survives
// contact with the actual input pipeline -- including that typing fast does
// NOT merge the words back together, which is precisely the half a faked
// clock cannot vouch for.
test('Gate 20: undo steps follow word boundaries, not typing speed', async () => {
  test.setTimeout(90_000)

  const fixture = await openFixtureDocument('# Gate 20 Fixture\n\nStart.\n')
  const { close, win, fixtureDir, restoreRecents } = fixture

  // Raw textContent rather than toHaveText: Playwright normalises whitespace
  // in toHaveText, and the exact thing under test here is whether the space
  // that terminates a word is still present after an undo.
  //
  // The NBSP replacement is required, and cost a genuinely baffling failure to
  // find (expected and received rendered identically in the diff): ProseMirror
  // writes a TRAILING space into contenteditable as U+00A0, because a plain
  // trailing space would be collapsed away by HTML whitespace handling and the
  // caret would appear in the wrong place. The document's own markdown is
  // unaffected -- this is a rendering detail of the editable DOM, and this
  // gate reads that DOM.
  // Written as \u00a0 rather than a literal NBSP so the character is visible in
  // review, and so eslint's no-irregular-whitespace rule does not (correctly)
  // flag an invisible character sitting in source.
  const paragraphText = async (): Promise<string> =>
    ((await win.locator('.milkdown-mount .ProseMirror p').textContent()) ?? '').replace(
      /\u00a0/g,
      ' '
    )

  try {
    const paragraph = win.locator('.milkdown-mount .ProseMirror p')
    await expect(paragraph).toHaveText('Start.')

    await paragraph.click()
    await win.keyboard.press('End')
    // No per-keystroke delay at all: every character lands well inside
    // newGroupDelay, so under the old time-only policy this entire phrase was
    // ONE undo step.
    await win.keyboard.type(' alpha beta gamma')
    await expect.poll(paragraphText).toBe('Start. alpha beta gamma')

    // One press removes exactly the last word, leaving everything before it.
    await win.keyboard.press(`${MOD}+z`)
    await expect.poll(paragraphText).toBe('Start. alpha beta ')

    // ...and the next press removes exactly the word before that, rather than
    // the rest of the phrase in one go.
    await win.keyboard.press(`${MOD}+z`)
    await expect.poll(paragraphText).toBe('Start. alpha ')

    // Redo walks back up the same groups.
    await win.keyboard.press(`${MOD}+Shift+z`)
    await expect.poll(paragraphText).toBe('Start. alpha beta ')
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})
