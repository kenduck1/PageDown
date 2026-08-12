import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile, rm, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'
import { launchIsolatedApp } from './electron-launch'
import { markdownToHtml } from '../src/markdown/pipeline'
import { encodeCommentMeta } from '../src/markdown/comment-plugin'
import { LETTER_GEOMETRY, DEFAULT_STYLE } from './gate-geometry'

// Gate 27 -- Comments, against the REAL built app. Two halves, mirroring the
// same split this feature's own architecture has (docs/superpowers/specs/
// 2026-08-09-comments-design.md): a real UI add/resolve/persist round trip
// (Test 1, matching Gate 20/22's real-app-UI template), and proof that a
// comment is 100% invisible on the sandboxed pagination/PDF surface (Test 2,
// matching Gate 3/26's harness-driven template) -- the two things a
// component/unit-test suite structurally cannot prove: that a real
// Chromium/ProseMirror selection genuinely produces a real DOM mark, and
// that nothing about a comment leaks into what actually gets printed.
//
// FLAKE NOTE: both tests pass individually, quickly (under ~2s each) and
// repeatably in isolation (`-g "<test name>"`) -- verified repeatedly while
// building this gate. Running the whole file in one Playwright worker hit
// this session's own already-documented `launchIsolatedApp`-under-host-load
// flake (a zero-console-output "Worker teardown timeout") once; the SAME
// class already independently reproduced on gate11/gate13/gate14 (unmodified
// files) and gate26-math-equations.spec.ts earlier in this session -- see
// CLAUDE.md's Testing section. Re-run the specific failing test in isolation
// before assuming a regression.

// Same positive file:// match as gate9/gate10/gate11/gate17/gate20 -- this
// app launches a second, sandboxed window with no contextBridge access.
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
  fixturePath: string
  restoreRecents: () => Promise<void>
}

// Same seed-into-recents-then-click-through-Home-screen approach as
// gate17/gate20's own openFixtureDocument.
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

  const fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate27-'))
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const fixtureFilename = `gate27-fixture-${nonce}.md`
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

  return { app, close, win, fixtureDir, fixturePath, restoreRecents }
}

test('Gate 27: adding and resolving a comment through the real UI persists and un-persists real marker syntax on disk', async () => {
  test.setTimeout(90_000)

  const fixture = await openFixtureDocument('# Gate 27 Fixture\n\nOriginal marked sentence.\n')
  const { close, win, fixtureDir, fixturePath, restoreRecents } = fixture

  try {
    const paragraph = win.locator('.milkdown-mount .ProseMirror p')
    await expect(paragraph).toHaveText('Original marked sentence.')

    // A real triple-click -- the standard, universally-supported "select
    // this paragraph" browser gesture, which ProseMirror handles as a
    // native DOM selection event. Tried first with a real click + Home +
    // Shift+End keyboard sequence and reverted: it opened the composer
    // correctly but addCommentCommand consistently refused with "Select
    // some text within a single paragraph first," meaning that sequence
    // was not actually producing the non-empty, single-block selection it
    // looks like it should from the keys alone -- triple-click sidesteps
    // whatever that discrepancy was by using a selection mechanism the
    // browser/ProseMirror already agree on the meaning of.
    await paragraph.click({ clickCount: 3 })

    // Mod-Shift-M (the keyboard shortcut), NOT a click on the toolbar's own
    // "Add comment" button.
    //
    // HISTORICAL NOTE, KEPT BECAUSE IT NAMES A REAL BUG THAT WAS LATER FIXED
    // ELSEWHERE. This was originally a deterministic finding from building
    // this gate rather than a style choice -- but it described the app as it
    // was, and both halves of that description have since moved: the default
    // window is 1000x840 (window-bounds.ts's DEFAULT_WINDOW_WIDTH/HEIGHT, not
    // the 900x670 named below), and the toolbar-reachability pass made every
    // control reachable at that size and pinned it with
    // gate33-toolbar-reachability.spec.ts. The workaround below is retained
    // anyway: driving a shortcut is strictly more robust than driving a
    // toolbar whose layout is not this gate's subject, and it matches
    // gate17-find-replace.spec.ts's own precedent. What follows is the
    // original finding, at the THEN-default 900x670 window.
    //
    // At the app's own then-default 900x670 window
    // (src/main/index.ts's createWindow), that button sat far
    // enough right in the toolbar's scrollable region that scrolling it
    // into view still left it UNDER the sticky left group (undo/redo +
    // paragraph-style/font/size, `sticky left-0 z-10`) -- confirmed
    // directly: Playwright's own actionability check reported the Font Size
    // <select> intercepting the click at the SAME coordinates on every
    // retry over several seconds (not a timing flake), and even `force:
    // true` (which bypasses Playwright's pre-click checks, not Chromium's
    // own real hit-testing at those screen coordinates) still delivered the
    // click to whatever was actually on top, not the button underneath it.
    // Resizing the real window to work around this was also tried and
    // reverted: it triggered a severe, reproducible hang in this
    // environment (worker force-killed after 300s+, twice). The keyboard
    // shortcut sidesteps the whole toolbar-layout question entirely --
    // exactly the same reason gate17-find-replace.spec.ts drives Find via
    // Mod-F rather than clicking that toolbar button either.
    await win.keyboard.press(`${MOD}+Shift+m`)
    await expect(win.getByRole('group', { name: 'Add comment' })).toBeVisible()
    await win.getByRole('textbox', { name: 'Comment text' }).fill('needs a citation')
    await win.getByRole('button', { name: 'Add', exact: true }).click()

    // A real comment mark now wraps the real paragraph text.
    const mark = win.locator('.pagedown-comment-mark')
    await expect(mark).toBeVisible()
    await expect(mark).toHaveText('Original marked sentence.')
    const commentId = await mark.getAttribute('data-comment-id')
    expect(commentId).toBeTruthy()

    // A real click on the real Save button -- this app has no Cmd/Ctrl+S
    // keyboard shortcut (confirmed against ShortcutsHelpModal.tsx's own
    // real, verified reference list, which names none), so the button is
    // the only real save path. Writes directly to the already-known
    // fixture path -- no native dialog involved, so this is safely
    // driveable from Playwright.
    await win.getByRole('button', { name: 'Save' }).click()
    await expect
      .poll(async () => (await readFile(fixturePath, 'utf8')).includes('<!--comment'), {
        timeout: 10_000
      })
      .toBe(true)

    const savedWithComment = await readFile(fixturePath, 'utf8')
    expect(savedWithComment).toContain(`<!--comment id="${commentId}"`)
    expect(savedWithComment).toContain('Original marked sentence.')
    expect(savedWithComment).toContain(`<!--/comment id="${commentId}"-->`)

    // The real Comments sidebar tab lists it, via the real extractComments
    // parse of the just-saved source.
    await win.getByRole('button', { name: 'Comments' }).click()
    await expect(win.getByText('needs a citation')).toBeVisible()
    await expect(win.getByText('"Original marked sentence."')).toBeVisible()

    await win.getByRole('button', { name: 'Resolve' }).click()
    await expect(win.locator('.pagedown-comment-mark')).toHaveCount(0)
    await expect(paragraph).toHaveText('Original marked sentence.')

    await win.getByRole('button', { name: 'Save' }).click()
    await expect
      .poll(async () => !(await readFile(fixturePath, 'utf8')).includes('<!--comment'), {
        timeout: 10_000
      })
      .toBe(true)

    const savedResolved = await readFile(fixturePath, 'utf8')
    expect(savedResolved).not.toContain('<!--comment')
    expect(savedResolved).not.toContain('<!--/comment')
    expect(savedResolved).toContain('Original marked sentence.')
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})

// The SAME real-app flow as Test 1, but on a HAND-WRAPPED paragraph -- the
// gesture that used to corrupt the document. Test 1's fixture is deliberately
// left exactly as it was rather than replaced: with no line break in the
// marked span, correct and incorrect behaviour coincide on that input, so it
// structurally cannot discriminate here (the same anti-pattern CLAUDE.md
// records for Gate 29's empty-paragraph fixture). Keeping both means the
// single-line path stays covered and the wrapped path is covered too.
//
// What used to happen, measured end to end before the fix: TWO marker pairs
// sharing one id, the user's paragraph permanently split in two, and a stray
// visible backslash in the rendered output -- compounding on every
// save/reload cycle.
test('Gate 27: commenting a hand-wrapped paragraph writes ONE marker pair and does not split the paragraph', async () => {
  test.setTimeout(90_000)

  const body = '# Gate 27 Wrapped\n\nfirst line\nsecond line tail.\n'
  const fixture = await openFixtureDocument(body)
  const { close, win, fixtureDir, fixturePath, restoreRecents } = fixture

  try {
    const paragraph = win.locator('.milkdown-mount .ProseMirror p')
    await expect(paragraph).toHaveText(/first line\s*second line tail\./)

    await paragraph.click({ clickCount: 3 })
    await win.keyboard.press(`${MOD}+Shift+m`)
    await expect(win.getByRole('group', { name: 'Add comment' })).toBeVisible()
    await win.getByRole('textbox', { name: 'Comment text' }).fill('spans a wrap')
    await win.getByRole('button', { name: 'Add', exact: true }).click()

    // TWO marked runs in the DOM, because @milkdown/preset-commonmark's
    // hardbreakClearMarkPlugin refuses to let any mark sit on a hardbreak --
    // that is expected and fine. What must NOT happen is those two runs
    // reaching DISK as two marker pairs.
    const marks = win.locator('.pagedown-comment-mark')
    await expect(marks).toHaveCount(2)
    const commentId = await marks.first().getAttribute('data-comment-id')
    expect(commentId).toBeTruthy()
    expect(await marks.nth(1).getAttribute('data-comment-id')).toBe(commentId)

    await win.getByRole('button', { name: 'Save' }).click()
    await expect
      .poll(async () => (await readFile(fixturePath, 'utf8')).includes('<!--comment'), {
        timeout: 10_000
      })
      .toBe(true)

    const saved = await readFile(fixturePath, 'utf8')
    expect(saved.match(/<!--comment id=/g) ?? []).toHaveLength(1)
    expect(saved.match(/<!--\/comment id=/g) ?? []).toHaveLength(1)

    // The rendered document -- what the paginated preview, the exported PDF
    // and HTML export all show -- must be structurally identical to the
    // uncommented original: same paragraph count, no stray backslash, and a
    // soft wrap still a soft wrap rather than a hard <br>.
    const renderedBefore = markdownToHtml(body).html
    const renderedAfter = markdownToHtml(saved).html
    const paragraphCount = (html: string): number => (html.match(/<p[\s>]/g) ?? []).length
    expect(paragraphCount(renderedBefore)).toBe(1)
    expect(paragraphCount(renderedAfter)).toBe(paragraphCount(renderedBefore))
    expect(renderedAfter).not.toContain('\\')
    expect(renderedAfter).not.toContain('<br')

    // One logical comment, so exactly one sidebar row.
    await win.getByRole('button', { name: 'Comments' }).click()
    await expect(win.getByText('spans a wrap')).toHaveCount(1)
    // `\s+`, not a literal space: the reunited comment's matched text holds
    // the real soft break, and Playwright normalises whitespace only for
    // STRING matchers, never for a regex.
    await expect(win.getByText(/"first line\s+second line tail\."/)).toBeVisible()
  } finally {
    await restoreRecents()
    await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})

test('Gate 27: a comment is invisible in the sandboxed pagination preview and never leaks into exported PDF text', async () => {
  const { app, close } = await launchIsolatedApp(['.'])

  try {
    const dataAttr = encodeCommentMeta({
      author: 'Kai',
      text: 'needs a citation',
      createdAt: '2026-08-09T06:00:00Z'
    })
    const markdown = `# Gate 27 Preview Check\n\nBefore. <!--comment id="c1" data="${dataAttr}"-->the marked phrase<!--/comment id="c1"-->. After.\n`
    const { html } = markdownToHtml(markdown)

    const result = await app.evaluate(
      async ({ BaseWindow }, { html, geometry, documentStyle }) => {
        const bridge = (
          globalThis as unknown as {
            __pagedownPhase0: {
              createPaginationHarness: (typeof import('../src/main/pagination-window'))['createPaginationHarness']
              exportToPdf: (typeof import('../src/export/export-pdf'))['exportToPdf']
            }
          }
        ).__pagedownPhase0
        const win = new BaseWindow({ show: false })
        const harness = await bridge.createPaginationHarness(win)
        const sendResult = await harness.sendDocument(html, geometry, documentStyle)

        const bodyText: string = await harness.view.webContents.executeJavaScript(
          'document.body.textContent'
        )
        const commentTraceCount = await harness.view.webContents.executeJavaScript(`
          document.querySelectorAll('.pagedown-comment-mark, [data-comment-id]').length
        `)

        const pdfBuffer = await bridge.exportToPdf(harness)

        return {
          sendResult,
          bodyText,
          commentTraceCount,
          pdfBuffer: Array.from(new Uint8Array(pdfBuffer))
        }
      },
      { html, geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
    )

    expect(result.sendResult.ready).toBe(true)
    // The marked TEXT survives, completely ordinary -- proving the comment-
    // to-hast passthrough handler didn't drop content, only its own marker
    // structure.
    expect(result.bodyText).toContain('the marked phrase')
    // Zero structural trace of the comment anywhere in the sandboxed DOM.
    expect(result.commentTraceCount).toBe(0)
    expect(result.bodyText).not.toContain('<!--comment')
    expect(result.bodyText).not.toContain('needs a citation')

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const pdfBuffer = Buffer.from(result.pdfBuffer)
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(pdfBuffer) })
    const pdfDoc = await loadingTask.promise
    let extractedText = ''
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i)
      const textContent = await page.getTextContent()
      extractedText += textContent.items.map((item) => ('str' in item ? item.str : '')).join('')
    }

    expect(extractedText).toContain('the marked phrase')
    expect(extractedText).not.toContain('<!--comment')
    expect(extractedText).not.toContain('needs a citation')
  } finally {
    await close()
  }
})
