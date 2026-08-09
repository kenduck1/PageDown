import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markdownToHtml } from '../src/markdown/pipeline'
import { launchIsolatedApp } from './electron-launch'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'
import { LETTER_GEOMETRY, DEFAULT_STYLE } from './gate-geometry'

// Gate 26 -- the math-equations (KaTeX) sub-project's own real-app proof,
// mirroring Gate 3's (Mermaid) architecture and methodology closely: math
// renders in exactly ONE place (resources/pagination-render/katex-render.ts,
// inside this sandboxed context), and never in the privileged app-shell
// renderer — see CLAUDE.md's Mermaid section, which this feature's own
// design deliberately copies.
//
// WHY THIS FIXTURE IS INLINE, NOT A phase0/corpus/ FILE (unlike Gate 3's own
// mermaid-diagrams.md): a math fixture WAS tried in phase0/corpus/ first,
// which Gate 4's own readdirSync sweep automatically picks up and requires
// categorizing as either an EXACT_MATCH or SUBSEQUENCE_ONLY file. It fit
// neither, for a real, measured reason (dumped via a throwaway diagnostic
// script, not assumed): Chromium's PDF text extraction does not merely ADD
// extra characters around KaTeX's rendered output the way list markers or
// image alt-text fallbacks do (Gate 4's own two existing SUBSEQUENCE_ONLY
// causes) — it RELOCATES every KaTeX-rendered span's text to the END of the
// page's text stream, out of its natural reading-order position relative to
// surrounding prose. This is a real, previously-undocumented extension of
// the SAME class of bug CLAUDE.md's footnote `<sup>` fix already found for
// this pipeline (Preflight's `position: relative` there measurably changed
// PDF text-extraction order) — KaTeX's own vlist-based layout leans on
// `position: relative` even more heavily (see nonce-style-hoisting.ts's own
// comment on why its inline styles are load-bearing, not decorative), and
// evidently confuses Chromium's PDF reading-order heuristic badly enough
// that content reordered THIS FAR breaks subsequence matching, not just
// exact matching: a subsequence check can tolerate extra interleaved
// characters, but not a genuine out-of-order relocation, since matching can
// only move forward through the haystack. Forcing this fixture into either
// of Gate 4's categories would mean either a spuriously failing gate or a
// weakened assertion silently laundering a real ordering difference — Gate
// 4's own header comment already warns against exactly that trade. This
// gate instead verifies the thing that actually matters for export
// fidelity — every expected substring is PRESENT somewhere in the exported
// PDF's text, i.e. nothing was silently dropped — without asserting order,
// and documents the reordering finding explicitly rather than papering over
// it.
//
// FLAKE NOTE, worth reading before "fixing" a failure here: every one of
// this file's four tests passes individually, quickly (under ~2s), and
// deterministically when run in isolation (`-g "<test name>"`) — verified
// repeatedly while building this gate. Running the whole FILE in one
// Playwright worker intermittently hangs on a DIFFERENT test each time (a
// zero-console-output "Worker teardown timeout" after 60-120s, never a real
// assertion failure) — this is CLAUDE.md's own already-documented
// `launchIsolatedApp`-under-host-load flake class (see the Testing
// section's "_electron launches can hang indefinitely" paragraph),
// independently reproduced here across four completely unrelated tests in
// this same file, not something specific to math rendering. Directly
// ruled out as a real hang in KaTeX itself: a standalone Node script
// calling `katex.renderToString` with this file's own hostile/malformed
// inputs (`\href{javascript:...}`, unbalanced `\frac{1{2}`) resolves in 1-2ms
// every time. If this file hangs in a combined run, re-run the specific
// failing test in isolation before assuming a regression.
const MATH_MARKDOWN = `# Math Equations

This project grew revenue from $50K to $120K last year, and costs held at
$5 per unit — plain dollar amounts in running prose, never treated as math.

The quadratic formula is inline: $$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$ —
right in the middle of a sentence.

$$
E = mc^2
$$

Ordinary text continues after the equation, unaffected.
`

const NO_MATH_MARKDOWN = '# No Math Here\n\nJust an ordinary paragraph, no equations at all.\n'

interface MathElementInfo {
  className: string
  width: number
  height: number
  hasKatexClass: boolean
}

test('Gate 26: math equations render as real, non-zero-size KaTeX output, currency prose is left alone, and CSP stays enforced', async () => {
  const { app, close } = await launchIsolatedApp(['.'])

  try {
    const { html } = markdownToHtml(MATH_MARKDOWN)

    const result = await app.evaluate(
      async ({ BaseWindow }, { html, geometry, documentStyle }) => {
        const bridge = (
          globalThis as unknown as {
            __pagedownPhase0: {
              createPaginationHarness: (typeof import('../src/main/pagination-window'))['createPaginationHarness']
            }
          }
        ).__pagedownPhase0
        const win = new BaseWindow({ show: false })
        const harness = await bridge.createPaginationHarness(win)

        const consoleMessages: string[] = []
        harness.view.webContents.on('console-message', (event) => {
          consoleMessages.push(event.message)
        })

        const sendResult = await harness.sendDocument(html, geometry, documentStyle)

        const mathElements: MathElementInfo[] = await harness.view.webContents.executeJavaScript(`
          Array.from(document.querySelectorAll('.pagedown-math-inline, .pagedown-math-block')).map(el => {
            const rect = el.getBoundingClientRect()
            return {
              className: el.className,
              width: rect.width,
              height: rect.height,
              hasKatexClass: !!el.querySelector('.katex')
            }
          })
        `)

        // Same nonce/hoisting proof Gate 3 runs for Mermaid, scoped to the
        // math wrappers specifically — see nonce-style-hoisting.ts's own
        // comment for why KaTeX's inline styles are load-bearing (fraction
        // bars, exponent stacking) rather than decorative, unlike Mermaid's.
        const nonceCheck = await harness.view.webContents.executeJavaScript(`
          (() => {
            const meta = document.querySelector('meta[name="csp-style-nonce"]')
            const nonce = meta ? meta.getAttribute('content') : null
            // ':is(...)' — NOT '.pagedown-math-inline, .pagedown-math-block'
            // concatenated directly with a trailing combinator. A comma-
            // separated selector LIST with a suffix appended as a plain
            // string only applies that suffix to the LAST alternative ('A, B
            // X' parses as the two selectors 'A' and 'B X'), so 'A' would
            // match bare wrapper elements with no [style]/style requirement
            // at all — caught by a throwaway diagnostic script during this
            // gate's own development, which is exactly why this comment is
            // here now: it silently reported a false-positive leftover
            // style="" attribute (actually just the wrapper span itself,
            // matched with zero style-attribute filtering) before the fix.
            // ':is()' correctly applies the descendant combinator to BOTH
            // alternatives as one group.
            const scope = ':is(.pagedown-math-inline, .pagedown-math-block)'
            const styleAttrCount = document.querySelectorAll(scope + ' [style]').length
            const styles = Array.from(document.querySelectorAll(scope + ' style'))
            return { nonce, styleAttrCount, styleNonces: styles.map(s => s.nonce), styleCount: styles.length }
          })()
        `)

        // The whole-page text, to confirm the currency amounts survive as
        // literal text (never swallowed into a math span) and that "50K"/
        // "120K"/"5" never appear INSIDE a math wrapper.
        const bodyText: string = await harness.view.webContents.executeJavaScript(
          'document.body.textContent'
        )
        const currencyInsideMath: boolean = await harness.view.webContents.executeJavaScript(`
          Array.from(document.querySelectorAll('.pagedown-math-inline, .pagedown-math-block'))
            .some(el => el.textContent.includes('50K') || el.textContent.includes('120K'))
        `)

        // Negative control, same shape as Gate 3's own: CSP must still block a
        // genuine injection attempt after this render pass's own
        // document.createElement-heavy code path (katex-render.ts,
        // nonce-style-hoisting.ts). Snapshotting the count first isolates
        // this from KaTeX's own harmless internal noise, if any (unlike
        // Mermaid, KaTeX renders via renderToString with no live DOM painting
        // of its own, so none is expected here — see the assertion below).
        const consoleMessagesBeforeInjection = consoleMessages.length
        await harness.sendDocument(
          '<img src="this-file-does-not-exist.png" onerror="window.__pwned = true">',
          geometry,
          documentStyle
        )
        await new Promise((resolve) => setTimeout(resolve, 500))
        const pwned = await harness.view.webContents.executeJavaScript(`typeof (window).__pwned`)
        const injectionViolationCount = consoleMessages
          .slice(consoleMessagesBeforeInjection)
          .filter((m) => /content security policy|refused to/i.test(m)).length

        return {
          sendResult,
          mathElements,
          nonceCheck,
          bodyText,
          currencyInsideMath,
          consoleMessages,
          pwned,
          injectionViolationCount
        }
      },
      { html, geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
    )

    console.log('Gate 26 math elements:', JSON.stringify(result.mathElements))
    console.log('Gate 26 nonce check:', JSON.stringify(result.nonceCheck))

    expect(result.sendResult.ready).toBe(true)

    // Exactly 1 block equation + 1 inline equation, per MATH_MARKDOWN above —
    // pinned exactly (not just `.length > 0`), matching Gate 3's own "pinned
    // set of distinct diagrams" precedent, so a regression that silently
    // drops or duplicates an equation is caught.
    expect(result.mathElements).toHaveLength(2)
    const blockCount = result.mathElements.filter((el) =>
      el.className.includes('pagedown-math-block')
    ).length
    const inlineCount = result.mathElements.filter((el) =>
      el.className.includes('pagedown-math-inline')
    ).length
    expect(blockCount).toBe(1)
    expect(inlineCount).toBe(1)

    // The real signal Gate 3 exists to produce for diagrams, mirrored here for
    // equations: no element reports a zero-size box (a silent KaTeX
    // render/layout failure), and every one contains KaTeX's own real
    // `.katex` class (proving renderToString's actual output landed, not a
    // fallback/error placeholder).
    for (const el of result.mathElements) {
      expect(el.width, `${el.className} reported zero width`).toBeGreaterThan(0)
      expect(el.height, `${el.className} reported zero height`).toBeGreaterThan(0)
      expect(el.hasKatexClass, `${el.className} missing real KaTeX output`).toBe(true)
    }

    // Currency false-positive proof, end to end (not just the pipeline.test.ts
    // unit-level proof) — the dollar amounts must survive as literal page
    // text and must never end up inside a math wrapper.
    expect(result.bodyText).toContain('$50K')
    expect(result.bodyText).toContain('$120K')
    expect(result.currencyInsideMath).toBe(false)

    // CSP-nonce/hoisting proof: zero lingering style="" attributes anywhere
    // under a math wrapper (hoistInlineStyleAttributes moved every one out),
    // and any retained <style> element carries this render's real nonce.
    expect(result.nonceCheck.styleAttrCount).toBe(0)
    if (result.nonceCheck.styleCount > 0) {
      expect(result.nonceCheck.nonce).toBeTruthy()
      for (const styleNonce of result.nonceCheck.styleNonces) {
        expect(styleNonce).toBe(result.nonceCheck.nonce)
      }
    }

    // CSP-negative case: injection still blocked on the same harness right
    // after math rendering, same double-check shape as Gate 3 (payload never
    // executed AND a real, attributable violation was logged for it).
    expect(result.pwned).toBe('undefined')
    expect(result.injectionViolationCount).toBeGreaterThan(0)
  } finally {
    await close()
  }
})

test('Gate 26: KaTeX font-face CSS is only registered in document.fonts when the document actually contains math', async () => {
  const { app, close } = await launchIsolatedApp(['.'])

  try {
    const { html: mathHtml } = markdownToHtml(MATH_MARKDOWN)
    const { html: noMathHtml } = markdownToHtml(NO_MATH_MARKDOWN)

    const result = await app.evaluate(
      async ({ BaseWindow }, { mathHtml, noMathHtml, geometry, documentStyle }) => {
        const bridge = (
          globalThis as unknown as {
            __pagedownPhase0: {
              createPaginationHarness: (typeof import('../src/main/pagination-window'))['createPaginationHarness']
            }
          }
        ).__pagedownPhase0
        const win = new BaseWindow({ show: false })
        const harness = await bridge.createPaginationHarness(win)

        await harness.sendDocument(noMathHtml, geometry, documentStyle)
        const familiesWithoutMath: string[] = await harness.view.webContents.executeJavaScript(
          `Array.from(document.fonts).map(f => f.family)`
        )

        // Same long-lived harness, second request — proves the gating is a
        // real PER-REQUEST decision (buildDocumentStylesheet's `hasMath`
        // parameter), not something baked in once at harness-creation time.
        await harness.sendDocument(mathHtml, geometry, documentStyle)
        const familiesWithMath: string[] = await harness.view.webContents.executeJavaScript(
          `Array.from(document.fonts).map(f => f.family)`
        )

        return { familiesWithoutMath, familiesWithMath }
      },
      { mathHtml, noMathHtml, geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
    )

    console.log('Gate 26 fonts without math:', JSON.stringify(result.familiesWithoutMath))
    console.log('Gate 26 fonts with math:', JSON.stringify(result.familiesWithMath))

    // Real, load-bearing check, not a micro-optimization proof for its own
    // sake: see buildKatexFontFaceCss's own comment (katex-render.ts) for why
    // registering all 20 KaTeX fonts unconditionally would cost a real,
    // awaited decode on EVERY render via Paged.js's Chunker.loadFonts(), even
    // for documents with no math at all.
    expect(result.familiesWithoutMath.some((f) => f.includes('KaTeX'))).toBe(false)
    expect(result.familiesWithMath.some((f) => f.includes('KaTeX_Main'))).toBe(true)
  } finally {
    await close()
  }
})

test('Gate 26: a malformed/hostile equation degrades gracefully and cannot inject a live link or crash the render', async () => {
  const { app, close } = await launchIsolatedApp(['.'])

  try {
    // \href is one of the commands KaTeX's own `trust` option gates (default,
    // and explicit here, `trust: false` — see katex-render.ts's own
    // KATEX_RENDER_OPTIONS comment). Malformed LaTeX (unbalanced braces) is
    // included in the SAME document to prove one broken equation doesn't
    // abort the whole render (throwOnError: false).
    const hostileMarkdown =
      '# Hostile Math\n\n' +
      'Link attempt: $$\\href{javascript:alert(1)}{click}$$\n\n' +
      'Malformed: $$\\frac{1{2}$$\n\n' +
      'Still here.\n'
    const { html } = markdownToHtml(hostileMarkdown)

    const result = await app.evaluate(
      async ({ BaseWindow }, { html, geometry, documentStyle }) => {
        const bridge = (
          globalThis as unknown as {
            __pagedownPhase0: {
              createPaginationHarness: (typeof import('../src/main/pagination-window'))['createPaginationHarness']
            }
          }
        ).__pagedownPhase0
        const win = new BaseWindow({ show: false })
        const harness = await bridge.createPaginationHarness(win)
        const sendResult = await harness.sendDocument(html, geometry, documentStyle)
        const dangerousHrefCount = await harness.view.webContents.executeJavaScript(
          `document.querySelectorAll('a[href*="javascript:"]').length`
        )
        const bodyText: string = await harness.view.webContents.executeJavaScript(
          'document.body.textContent'
        )
        return { sendResult, dangerousHrefCount, bodyText }
      },
      { html, geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
    )

    // The render must complete at all (throwOnError: false + this file's own
    // defensive catch in renderMathPlaceholder) rather than time out/error.
    expect(result.sendResult.ready).toBe(true)
    // trust: false must leave no real javascript: URL anywhere in the DOM.
    expect(result.dangerousHrefCount).toBe(0)
    // The rest of the document must still be present — one hostile/malformed
    // equation must not blank out everything after it.
    expect(result.bodyText).toContain('Still here.')
  } finally {
    await close()
  }
})

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

interface MathProbe {
  text: string
  mathElementCount: number
  hasKatexClass: boolean
}

async function probeMath(app: ElectronApplication): Promise<MathProbe | null> {
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
        var mathEls = document.querySelectorAll('.pagedown-math-inline, .pagedown-math-block')
        var first = mathEls.length > 0 ? mathEls[0] : null
        return JSON.stringify({
          text: document.getElementById('content-root') ? document.getElementById('content-root').innerText : '',
          mathElementCount: mathEls.length,
          hasKatexClass: first ? !!first.querySelector('.katex') : false
        })
      })()
    `)) as string
    return JSON.parse(raw) as MathProbe
  })
}

test.setTimeout(120_000)

test('Gate 26: the real compiled out/main/index.js parses math syntax and the real compiled sandboxed bundle renders it', async () => {
  const launched = await launchIsolatedApp(['out/main/index.js'])
  const { app, close } = launched
  const userDataDir = launched.userDataDir
  let win: Page
  let fixtureDir: string | undefined

  try {
    win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate26-'))
    const marker = `Gate26 ${Date.now()}`
    const filename = `gate26-${Date.now()}.md`
    const path = join(fixtureDir, filename)
    await writeFile(
      path,
      [
        `# ${marker}`,
        '',
        'Costs held at $5 per unit — plain currency, not math.',
        '',
        'The block equation below is real LaTeX:',
        '',
        '$$',
        'E = mc^2',
        '$$',
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

    let probe: MathProbe | null = null
    await expect
      .poll(
        async () => {
          probe = await probeMath(app)
          return probe !== null && probe.text.includes(marker) && probe.mathElementCount > 0
        },
        {
          message:
            'expected the split-preview to render real KaTeX output for a document opened through the real compiled app',
          timeout: 30_000,
          intervals: [500]
        }
      )
      .toBe(true)

    console.log('Gate 26 real-app math probe:', JSON.stringify(probe, null, 2))

    // Proves markdownToHtml, running inside the REAL compiled
    // out/main/index.js (not this spec file's own TS import), correctly
    // parsed the block equation into a placeholder AND that the real
    // compiled out/pagination-render/index.js bundle rendered it for
    // real — the exact round trip the exclude-list change exists to keep
    // working.
    expect(probe!.mathElementCount).toBeGreaterThan(0)
    expect(probe!.hasKatexClass, 'expected real KaTeX output, not a fallback placeholder').toBe(
      true
    )
  } finally {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
    await close()
  }
})
