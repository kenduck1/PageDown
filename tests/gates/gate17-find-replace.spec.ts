import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../../src/main/recent-files'
import { launchIsolatedApp } from './electron-launch'

// The word this gate searches for. Deliberately appears a known number of
// times in the fixture below, and deliberately is NOT a substring of any
// other word there -- so a whole-word bug can't silently change the count
// this gate pins.
const NEEDLE = 'alpha'
const NEEDLE_COUNT = 3

// Same helper (and same reasoning) as gate9/gate10/gate11: this app launches a
// SECOND window at startup whose page loads under the sandboxed
// `pagedown-render://` scheme with zero contextBridge access. Matched by a
// POSITIVE `file://` check rather than a negative exclusion, because every
// window starts on `about:blank` before its real navigation completes.
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

// Cmd on macOS, Ctrl elsewhere -- this is a REAL key event dispatched through
// Chromium's own input pipeline, which is the whole point (jsdom can only
// construct a synthetic KeyboardEvent object).
const FIND_ACCELERATOR = process.platform === 'darwin' ? 'Meta+f' : 'Control+f'

interface OpenedFixture {
  app: ElectronApplication
  close: () => Promise<void>
  win: Page
  fixtureDir: string
  restoreRecents: () => Promise<void>
}

// Launches the real app, seeds a real fixture .md into the real
// recent-files.json allowlist (which is what makes `file:openPath` accept it
// -- see CLAUDE.md's File I/O security invariant), and clicks into the editor
// through the real Home screen UI. Same approach as gate11's own setup.
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

  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate17-'))
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const fixtureFilename = `gate17-fixture-${nonce}.md`
  const fixturePath = join(fixtureDir, fixtureFilename)
  await writeFile(fixturePath, body, 'utf8')

  const originalRecents = await readRecentFiles(userDataDir)
  const restoreRecents = async (): Promise<void> => {
    await writeRecentFiles(userDataDir, originalRecents)
  }

  const seeded = mergeRecentFiles(originalRecents, fixturePath, new Date().toISOString())
  await writeRecentFiles(userDataDir, seeded)

  // HomeScreen fetches its recent-file list once on mount, which already ran
  // with the PRE-seed allowlist by the time getMainWindow() returned.
  await win.reload()
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
  await win
    .getByRole('button', { name: new RegExp(fixtureFilename.replace(/[.]/g, '\\.')) })
    .click()
  await win.waitForSelector('.milkdown-mount .ProseMirror')

  return { app, close, win, fixtureDir, restoreRecents }
}

test('Gate 17: a real Cmd/Ctrl+F paints real find highlights in the Format-mode canvas', async () => {
  test.setTimeout(90_000)

  const fixture = await openFixtureDocument(
    `# Gate 17 Fixture\n\nFirst ${NEEDLE} here.\n\nSecond ${NEEDLE} and third ${NEEDLE}.\n`
  )
  const { close, win, fixtureDir, restoreRecents } = fixture

  try {
    // A REAL accelerator through Chromium's own input pipeline. The find bar
    // does not exist in the DOM at all until this is handled, so its
    // appearance is itself the assertion that the shortcut reached the app.
    await win.keyboard.press(FIND_ACCELERATOR)
    const queryInput = win.getByRole('textbox', { name: 'Find' })
    await expect(queryInput).toBeVisible()

    // Real typing, not a programmatic value set.
    await queryInput.type(NEEDLE, { delay: 20 })

    const matches = win.locator('.milkdown-mount .ProseMirror .pagedown-find-match')
    await expect(matches).toHaveCount(NEEDLE_COUNT)

    const active = win.locator('.milkdown-mount .ProseMirror .pagedown-find-match-active')
    await expect(active).toHaveCount(1)

    // The assertion jsdom structurally cannot make: the highlight occupies
    // real, non-zero pixels on screen. A decoration that is present in the
    // DOM but collapsed to a zero-area box would pass every unit test and be
    // invisible to a user.
    const activeBox = await active.first().boundingBox()
    expect(activeBox).not.toBeNull()
    expect(activeBox!.width).toBeGreaterThan(0)
    expect(activeBox!.height).toBeGreaterThan(0)

    // The count readout reflects the real, painted match list.
    await expect(win.getByTestId('find-count')).toHaveText(`1 / ${NEEDLE_COUNT}`)

    // Navigation moves the active highlight to a DIFFERENT element -- compared
    // by bounding box, since the three matches sit at genuinely different
    // on-screen positions in this fixture.
    await win.getByRole('button', { name: 'Next match' }).click()
    await expect(win.getByTestId('find-count')).toHaveText(`2 / ${NEEDLE_COUNT}`)
    const secondBox = await win
      .locator('.milkdown-mount .ProseMirror .pagedown-find-match-active')
      .first()
      .boundingBox()
    expect(secondBox).not.toBeNull()
    expect(secondBox!.x !== activeBox!.x || secondBox!.y !== activeBox!.y).toBe(true)
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})

test('Gate 17: Replace all rewrites the real document and clears every highlight', async () => {
  test.setTimeout(90_000)

  const fixture = await openFixtureDocument(
    `# Gate 17 Fixture\n\nFirst ${NEEDLE} here.\n\nSecond ${NEEDLE} and third ${NEEDLE}.\n`
  )
  const { close, win, fixtureDir, restoreRecents } = fixture

  try {
    await win.keyboard.press(FIND_ACCELERATOR)
    await win.getByRole('textbox', { name: 'Find' }).type(NEEDLE, { delay: 20 })
    await expect(win.locator('.milkdown-mount .ProseMirror .pagedown-find-match')).toHaveCount(
      NEEDLE_COUNT
    )

    await win.getByRole('button', { name: 'Toggle replace' }).click()
    await win.getByRole('textbox', { name: 'Replace with' }).type('omega', { delay: 20 })
    await win.getByRole('button', { name: 'Replace all' }).click()

    // The real editor DOM now holds the replacement everywhere and the needle
    // nowhere -- read off the live contenteditable, not off any store.
    await expect
      .poll(async () => {
        const text = await win.locator('.milkdown-mount .ProseMirror').innerText()
        return text.split('omega').length - 1
      })
      .toBe(NEEDLE_COUNT)
    const finalText = await win.locator('.milkdown-mount .ProseMirror').innerText()
    expect(finalText).not.toContain(NEEDLE)

    // Nothing matches the old query any more, so every decoration is gone.
    await expect(win.locator('.milkdown-mount .ProseMirror .pagedown-find-match')).toHaveCount(0)
    await expect(win.getByTestId('find-count')).toHaveText('No results')
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})

test('Gate 17: Source mode find moves the real textarea selection to each match', async () => {
  test.setTimeout(90_000)

  const body = `# Gate 17 Fixture\n\nFirst ${NEEDLE} here.\n\nSecond ${NEEDLE} and third ${NEEDLE}.\n`
  const fixture = await openFixtureDocument(body)
  const { close, win, fixtureDir, restoreRecents } = fixture

  try {
    // Switch to Source mode through the real toolbar segmented control.
    await win.getByRole('button', { name: 'Source' }).click()
    const textarea = win.getByRole('textbox', { name: 'Markdown source' })
    await expect(textarea).toBeVisible()

    await win.keyboard.press(FIND_ACCELERATOR)
    // fill(), not type(): the query drives a LIVE search on every keystroke,
    // so character-by-character typing walks through real intermediate
    // queries whose own first match is somewhere else entirely (query "a"
    // first matches the "a" in "Gate"). Polling against those intermediate
    // states is a genuine race -- it caught this gate out once, reporting a
    // selection of "lpha" -- and setting the whole query at once removes it
    // at the source rather than papering over it with a longer timeout.
    await win.getByRole('textbox', { name: 'Find' }).fill(NEEDLE)

    // Source mode shows the CURRENT match using the browser's own selection,
    // because a <textarea> cannot render per-range decorations at all (see
    // the design doc's "Source mode" section). Read the real DOM node's
    // selectionStart/selectionEnd -- the property jsdom can hold but never
    // drive from real layout.
    const readSelection = async (): Promise<{ start: number; end: number; value: string }> =>
      textarea.evaluate((el) => {
        const area = el as HTMLTextAreaElement
        return { start: area.selectionStart, end: area.selectionEnd, value: area.value }
      })

    // Poll on the SELECTED TEXT itself, not on a bare offset being non-zero:
    // the selected substring equalling the needle is the actual property
    // under test, and it is also the only condition that can't be satisfied
    // by a transient intermediate state.
    await expect
      .poll(async () => {
        const selection = await readSelection()
        return selection.value.slice(selection.start, selection.end)
      })
      .toBe(NEEDLE)

    const first = await readSelection()
    expect(first.start).toBe(first.value.indexOf(NEEDLE))

    // Next advances the real textarea selection to the SECOND occurrence in
    // the raw Markdown -- a different offset in the same string.
    const secondOffset = first.value.indexOf(NEEDLE, first.end)
    expect(secondOffset).toBeGreaterThan(first.start)
    await win.getByRole('button', { name: 'Next match' }).click()
    await expect.poll(async () => (await readSelection()).start).toBe(secondOffset)
    const second = await readSelection()
    expect(second.value.slice(second.start, second.end)).toBe(NEEDLE)
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})
