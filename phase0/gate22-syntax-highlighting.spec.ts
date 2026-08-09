import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'

// Gate 22 -- Code block syntax highlighting, against the REAL built app.
//
// WHY THIS GATE EXISTS. `pipeline.test.ts` already proves markdownToHtml
// itself produces highlighted spans, under Vitest -- but Vitest resolves
// ESM/`.default` correctly regardless of how a dependency is packaged.
// rehype-highlight (like every other ESM-only dependency this pipeline
// pulls in) is only genuinely proven safe once it survives electron-vite's
// OWN main-process bundling and a raw `require()` at runtime in the
// COMPILED out/main/index.js -- see CLAUDE.md's "Build quirk #2" for the
// exact failure mode this class of bug takes (compiles, passes every
// Vitest-level test, silently breaks only once the built app actually
// runs). This gate reads the real, live sandboxed pagination render
// context's DOM -- reached through Split mode, the one surface that keeps
// a persistent, inspectable render of the current document on screen --
// via the same app.evaluate()/executeJavaScript() route Gate 19 and Gate 21
// established, since contextBridge deep-freezes window.api and makes
// renderer-side spying categorically impossible (Gate 15's own finding).

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

interface HighlightProbe {
  hasHljsKeyword: boolean
  keywordColor: string
  plainTextColor: string
  unlabeledBlockHasHljsClass: boolean
  text: string
}

// Same family as Gate 19's probePreview/Gate 15's structural read: reaches
// into the real sandboxed WebContentsView via app.evaluate, since it has no
// contextBridge/window.api surface at all (by design -- see CLAUDE.md's
// "Pagination render context" section).
async function probeHighlighting(app: ElectronApplication): Promise<HighlightProbe | null> {
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

    const raw = (await splitView.webContents.executeJavaScript(`
      (function () {
        var keyword = document.querySelector('.hljs-keyword')
        var plain = document.querySelector('.pagedjs_area p')
        var codeBlocks = document.querySelectorAll('.pagedjs_area pre code')
        var unlabeled = codeBlocks.length > 1 ? codeBlocks[1] : null
        return JSON.stringify({
          hasHljsKeyword: !!keyword,
          keywordColor: keyword ? window.getComputedStyle(keyword).color : '',
          plainTextColor: plain ? window.getComputedStyle(plain).color : '',
          unlabeledBlockHasHljsClass: unlabeled ? unlabeled.classList.contains('hljs') : false,
          text: document.getElementById('content-root') ? document.getElementById('content-root').innerText : ''
        })
      })()
    `)) as string
    return JSON.parse(raw) as HighlightProbe
  })
}

let app: ElectronApplication | undefined
let close: (() => Promise<void>) | undefined
let win: Page
let userDataDir: string
let fixtureDir: string

test.setTimeout(120_000)

test('Gate 22: a labeled fenced code block is really syntax-highlighted by the compiled app, an unlabeled one is not', async () => {
  const launched = await launchIsolatedApp(['out/main/index.js'])
  app = launched.app
  close = launched.close
  userDataDir = launched.userDataDir

  try {
    win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate22-'))
    const marker = `Gate22 ${Date.now()}`
    const filename = `gate22-${Date.now()}.md`
    const path = join(fixtureDir, filename)
    await writeFile(
      path,
      [
        `# ${marker}`,
        '',
        'Ordinary body text, for comparison against the highlighted keyword below.',
        '',
        '```js',
        'const total = 1;',
        'function addOne(value) {',
        '  return value + total;',
        '}',
        '```',
        '',
        '```',
        'plain unlabeled text, must not be highlighted',
        '```',
        ''
      ].join('\n'),
      'utf8'
    )

    const originalRecents = await readRecentFiles(userDataDir)
    await writeRecentFiles(
      userDataDir,
      mergeRecentFiles(originalRecents, path, new Date().toISOString())
    )

    await win.reload()
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
    await win.getByRole('button', { name: new RegExp(filename.replace(/[.]/g, '\\.')) }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')

    await win.getByRole('button', { name: 'Split', exact: true }).click()
    await expect(win.getByTestId('split-preview-placeholder')).toBeVisible()

    let probe: HighlightProbe | null = null
    await expect
      .poll(
        async () => {
          probe = await probeHighlighting(app!)
          return probe !== null && probe.text.includes(marker) && probe.hasHljsKeyword
        },
        {
          message: 'expected the split-preview to render a real, syntax-highlighted code block',
          timeout: 30_000,
          intervals: [500]
        }
      )
      .toBe(true)

    console.log('Gate 22 highlight probe:', JSON.stringify(probe, null, 2))

    // The labeled block: a real keyword span exists, and it's colored
    // DIFFERENTLY from ordinary body text -- proving this isn't just an
    // empty class with no matching CSS rule (which is exactly the failure
    // mode a broken/uncompiled highlight theme would produce).
    expect(probe!.hasHljsKeyword, 'expected a real .hljs-keyword span').toBe(true)
    expect(probe!.plainTextColor, 'expected a real ordinary paragraph to compare against').not.toBe(
      ''
    )
    expect(
      probe!.keywordColor,
      'a highlighted keyword must render in a different color than plain body text'
    ).not.toBe(probe!.plainTextColor)

    // The unlabeled block: rehype-highlight's own conservative default
    // (no `detect: true`) means a fenced block with no language info string
    // must NOT be highlighted -- confirms this pipeline didn't quietly
    // enable language auto-detection.
    expect(
      probe!.unlabeledBlockHasHljsClass,
      'an unlabeled fenced code block must not be highlighted'
    ).toBe(false)
  } finally {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
    if (app && close) await safeClose(app, close)
  }
})
