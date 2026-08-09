import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'

// Gate 19 -- the Page Setup Completeness sub-project's real end-to-end proof.
//
// WHY THIS GATE EXISTS. Four PageConfig fields that already round-tripped
// through YAML frontmatter and already had real Page Setup UI reached no
// renderer at all: header/footer CONTENT, the `Custom` page size, the
// document `theme`, and a per-document `fontFamily`. Tasks 1-8 wired them.
// Every renderer-side assertion in those tasks runs under jsdom, WHICH HAS
// NO LAYOUT ENGINE and no CSS cascade worth the name -- a jsdom test can
// assert a mount div received `class="... pagedown-theme-resume"`, but it
// cannot assert that any text is 13px, that a font resolved, or that a
// Paged.js margin box painted anything. This gate measures the real things,
// in the real built app.
//
// EXPECTED VALUES ARE HAND-DERIVED LITERALS, DELIBERATELY, per Gate 16's
// standing rule: this file never calls `computePageGeometry`,
// `resolveDocumentStyle`, or `buildRunningContentCss` to derive what it
// expects. An expectation computed by the code under test moves with that
// code's bugs and the gate passes green against wrong output.
//
// THE ONE NON-OBVIOUS MEASUREMENT TECHNIQUE, and why it is mandatory here:
// Paged.js emits running header/footer text as CSS GENERATED CONTENT, on
// `<margin selector> > .pagedjs_margin-content::after`
// (node_modules/pagedjs/src/modules/paged-media/atpage.js's
// `addMarginaliaContent`). So `.textContent` of a margin box reads EMPTY
// even when the header is plainly painted and plainly present in the
// exported PDF's extracted text -- Gate 4 discovered exactly this and
// asserts it. Every header/footer assertion below therefore reads
// `getComputedStyle(el, '::after').content`, never `textContent`.

const CLOSE_TIMEOUT_MS = 20_000

// --- Hand-derived expectations -------------------------------------------
//
// Custom page size: 5in x 7in at 96dpi. Chosen because it is a legal custom
// size (comfortably inside computePageGeometry's own 2in-200in clamp) and
// is different from every named size in the allowlist, so "the wiring did
// nothing and fell back to Letter" is a distinguishable outcome.
const CUSTOM_PAGE_WIDTH_PX = 5 * 96 // 480
const CUSTOM_PAGE_HEIGHT_PX = 7 * 96 // 672
const LETTER_PAGE_WIDTH_PX = 8.5 * 96 // 816
const LETTER_PAGE_HEIGHT_PX = 11 * 96 // 1056

// The `resume` theme's own body size, from document-typography.css's
// `.pagedown-document.pagedown-theme-resume` block (--text-13). The default
// theme's body is 14px; a surface that ignored the theme class would report
// that instead, which is what makes this discriminating.
const RESUME_BODY_FONT_PX = 13
const DEFAULT_BODY_FONT_PX = 14

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

interface PreviewProbe {
  pageCount: number
  sheet: { width: number; height: number } | null
  // Resolved ::after content for the six margin boxes we can populate.
  // Strings, exactly as getComputedStyle reports them (quoted, e.g. '"Page 1 of 2"').
  topLeft: string
  topCenter: string
  topRight: string
  bottomLeft: string
  bottomCenter: string
  bottomRight: string
  // Computed typography of the first real body paragraph inside the
  // paginated content box -- the theme/font half of this gate.
  bodyFontSize: string
  bodyFontFamily: string
  text: string
}

// Reads the REAL sandboxed render context, via the same main-process route
// Gate 15 and Gate 16 established (app.evaluate -> mainWindow.contentView
// .children -> webContents.executeJavaScript). See Gate 15's header for why
// a renderer-side path is categorically impossible: contextBridge
// deep-freezes window.api, and this context is deliberately unreachable
// from the renderer's bridge surface.
//
// Disambiguation, per Gate 15/16: this mainWindow also hosts a second,
// unrelated pagedown-render:// view from app startup (the Phase 0 spike's
// harness), parked off-screen at {x:-9999,y:-9999}; filtering to a genuinely
// on-screen rectangle isolates the split-preview harness's view from it.
async function probePreview(app: ElectronApplication): Promise<PreviewProbe | null> {
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
        function box(el) {
          if (!el) return null
          var r = el.getBoundingClientRect()
          return { width: r.width, height: r.height }
        }
        // Paged.js renders margin-box text as CSS generated content on
        // .pagedjs_margin-content::after -- textContent is ALWAYS empty
        // here, so this must read the computed ::after content instead.
        function marginContent(loc) {
          var el = document.querySelector('.pagedjs_margin-' + loc + ' > .pagedjs_margin-content')
          if (!el) return ''
          var v = window.getComputedStyle(el, '::after').content
          return v === undefined || v === null ? '' : String(v)
        }
        var root = document.getElementById('content-root')
        var sheetEl = document.querySelector('.pagedjs_sheet')
        // First real body paragraph inside the paginated content box.
        var p = document.querySelector('.pagedjs_area p')
        var pStyle = p ? window.getComputedStyle(p) : null
        return JSON.stringify({
          pageCount: document.querySelectorAll('.pagedjs_page').length,
          sheet: box(sheetEl),
          topLeft: marginContent('top-left'),
          topCenter: marginContent('top-center'),
          topRight: marginContent('top-right'),
          bottomLeft: marginContent('bottom-left'),
          bottomCenter: marginContent('bottom-center'),
          bottomRight: marginContent('bottom-right'),
          bodyFontSize: pStyle ? pStyle.fontSize : '',
          bodyFontFamily: pStyle ? pStyle.fontFamily : '',
          text: root ? root.innerText : ''
        })
      })()
    `)) as string
    return JSON.parse(raw) as PreviewProbe
  })
}

// Body text long enough to force more than one page at every page size this
// gate uses, so `counter(pages)` has something non-trivial to resolve and
// the "does running content change the page count" comparison below is
// measured on a real multi-page document rather than a one-page trivial case.
const BODY_TEXT = Array.from(
  { length: 40 },
  (_, i) =>
    `Paragraph ${i + 1}. Filler prose so this fixture spans several real pages under every page size this gate exercises.`
).join('\n\n')

interface Fixture {
  path: string
  marker: string
}

let app: ElectronApplication | undefined
let close: (() => Promise<void>) | undefined
let win: Page
let userDataDir: string
let fixtureDir: string

// One app instance for the whole file. Every launch/close cycle is a real
// risk of the documented close() hang under host load (see CLAUDE.md's
// Testing section), and every measurement here is a pure read of a
// document the test itself supplies -- so there is nothing to isolate
// between them that reloading the renderer doesn't already isolate.
const GET_MAIN_WINDOW_TIMEOUT_MS = 60_000

// Same POSITIVE `file://` match every other gate's own getMainWindow uses:
// this app opens a SECOND window at startup (the Phase 0 spike's sandboxed
// pagedown-render:// harness), and both `firstWindow()` and a negative
// "isn't pagedown-render://" filter race it, since every window starts on
// about:blank before its real navigation completes.
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

// Every test in this file drives the SAME long-lived app instance and each
// one does a real multi-second Paged.js round trip, so both the per-test and
// the hook budgets need to be well above Playwright's 60s defaults --
// especially the launch hook, which under real host load can spend most of a
// minute just getting to a usable main window (see CLAUDE.md's Testing
// section on `_electron` launches hanging under load).
test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

test.beforeAll(async () => {
  test.setTimeout(180_000)
  const launched = await launchIsolatedApp(['out/main/index.js'])
  app = launched.app
  close = launched.close
  userDataDir = launched.userDataDir
  win = await getMainWindow(app)
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
  fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate19-'))
})

test.afterAll(async () => {
  try {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
  } finally {
    if (app && close) await safeClose(app, close)
  }
})

// Writes a fixture, seeds it into the real recent-files allowlist, reloads
// the renderer, opens it through real UI, and enters Split mode -- the one
// surface that keeps a live, inspectable paginated render of the CURRENT
// document on screen. Returns once the preview genuinely contains this
// document's own unique marker, not merely once "some render happened".
async function openInSplitMode(frontmatter: string, label: string): Promise<Fixture> {
  const marker = `Gate19 ${label} ${Date.now()}`
  const filename = `gate19-${label}-${Date.now()}.md`
  const path = join(fixtureDir, filename)
  await writeFile(path, [frontmatter, '', `# ${marker}`, '', BODY_TEXT, ''].join('\n'), 'utf8')

  const originalRecents = await readRecentFiles(userDataDir)
  await writeRecentFiles(
    userDataDir,
    mergeRecentFiles(originalRecents, path, new Date().toISOString())
  )
  // Reload rather than the "<- Home" button: that button runs EditorScreen's
  // real dirty check, which on a dirty document opens a REAL native
  // Save/Don't Save/Cancel dialog no headless gate can dismiss.
  await win.reload()
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
  await win.getByRole('button', { name: new RegExp(filename.replace(/[.]/g, '\\.')) }).click()
  await win.waitForSelector('.milkdown-mount .ProseMirror')

  // `exact: true` rules out the unrelated "Split cell" table button.
  await win.getByRole('button', { name: 'Split', exact: true }).click()
  await expect(win.getByTestId('split-preview-placeholder')).toBeVisible()

  return { path, marker }
}

// Waits for a render that genuinely contains THIS document's own marker AND
// whose page count has SETTLED.
//
// The settle half is not defensive padding -- it is required for
// correctness, and its absence produced a real false failure while this gate
// was being written: Paged.js's Chunker appends pages progressively, so a
// probe that fires as soon as the marker text appears reliably catches the
// document mid-pagination and reports `pageCount: 1` for a document that
// ends up 3 pages long. The page-count comparison this gate makes would be
// meaningless read that way. Two consecutive identical, non-zero counts is
// the settle condition.
async function pollPreview(marker: string): Promise<PreviewProbe> {
  let last: PreviewProbe | null = null
  let previousCount = -1
  await expect
    .poll(
      async () => {
        const probe = await probePreview(app!)
        if (!probe || !probe.text.includes(marker)) {
          previousCount = -1
          return false
        }
        const settled = probe.pageCount > 0 && probe.pageCount === previousCount
        previousCount = probe.pageCount
        last = probe
        return settled
      },
      {
        message: `expected the split-preview WebContentsView to render "${marker}" and settle`,
        timeout: 45_000,
        intervals: [500]
      }
    )
    .toBe(true)
  return last as unknown as PreviewProbe
}

test.describe('Gate 19: Page Setup completeness', () => {
  test('header and footer content really render into the Paged.js margin boxes', async () => {
    const { marker } = await openInSplitMode(
      [
        '---',
        'header: true',
        'headerLeft: Acme Corp',
        'headerCenter: Quarterly Report',
        'footer: true',
        'footerCenter: Page {n} of {total}',
        'footerRight: Confidential',
        '---'
      ].join('\n'),
      'headerfooter'
    )
    const probe = await pollPreview(marker)
    console.log('Gate 19 header/footer probe:', JSON.stringify(probe, null, 2))

    // Literal strings reach the top band.
    expect(probe.topLeft, 'headerLeft must render in the @top-left margin box').toContain(
      'Acme Corp'
    )
    expect(probe.topCenter, 'headerCenter must render in the @top-center margin box').toContain(
      'Quarterly Report'
    )
    // An empty side must emit NO rule at all -- Paged.js flags a box
    // .hasContent for any content other than `none`, so an emitted
    // `content: ""` would produce a present-but-empty box rather than none.
    expect(probe.topRight, 'an unset header side must emit no generated content').not.toContain(
      'Acme'
    )

    // {n}/{total} became REAL CSS counters, not literal braces.
    //
    // MEASUREMENT LIMIT, stated plainly because it looks like a weaker
    // assertion than it is: `getComputedStyle(el, '::after').content`
    // returns the COMPUTED value, and a counter's computed value is still
    // the unevaluated `counter(page)` function -- counters resolve at
    // used-value time, during layout, and no DOM API on this side exposes
    // the resolved glyphs. So this half asserts the substitution (the thing
    // src/typography/document-style.ts is responsible for), and the
    // separate PDF test below asserts the RESOLUTION (the thing Paged.js and
    // Chromium are responsible for), by reading real painted text out of a
    // real exported PDF. Neither alone is sufficient; together they are.
    expect(probe.bottomCenter, 'the footer must not contain unsubstituted tokens').not.toContain(
      '{n}'
    )
    expect(probe.bottomCenter).not.toContain('{total}')
    expect(
      probe.bottomCenter,
      'footerCenter must substitute {n}/{total} into real CSS counters'
    ).toBe('"Page " counter(page) " of " counter(pages)')
    expect(probe.bottomRight, 'footerRight must render in the @bottom-right box').toContain(
      'Confidential'
    )

    // The document really is multi-page, so `counter(pages)` above is a
    // non-trivial number rather than a vacuous "1 of 1".
    expect(probe.pageCount, 'fixture must span multiple pages').toBeGreaterThan(1)
  })

  test('running content does NOT change the page count', async () => {
    // THE LOAD-BEARING INVARIANT OF THE WHOLE HEADER/FOOTER FEATURE.
    // Paged.js's `.pagedjs_pagebox` is a CSS grid whose rows are
    // `[header] margin-top [page] <content> [footer] margin-bottom`
    // (node_modules/pagedjs/src/polisher/base.js), and the margin boxes sit
    // in the header/footer ROWS while `.pagedjs_area` -- the box the Chunker
    // actually fills -- sits in the page row. So enabling a header or footer
    // consumes ZERO content space and cannot move a page boundary.
    //
    // That is a reading of library source, and this asserts it instead of
    // trusting it: the SAME body text, once with running content off and
    // once with it on, must paginate to the SAME number of pages. If this
    // ever fails, every pinned page count in Gate 2 and Gate 6 is suspect.
    const off = await openInSplitMode(
      ['---', 'header: false', 'footer: false', '---'].join('\n'),
      'countoff'
    )
    const offProbe = await pollPreview(off.marker)

    const on = await openInSplitMode(
      [
        '---',
        'header: true',
        'headerCenter: A header that did not exist before',
        'footer: true',
        'footerCenter: Page {n} of {total}',
        '---'
      ].join('\n'),
      'counton'
    )
    const onProbe = await pollPreview(on.marker)

    console.log(
      `Gate 19 page counts: running content off=${offProbe.pageCount}, on=${onProbe.pageCount}`
    )

    expect(offProbe.pageCount, 'the no-running-content fixture must be multi-page').toBeGreaterThan(
      1
    )
    // Proves the second fixture genuinely HAS running content, so a pass
    // here can't come from both documents silently rendering none.
    expect(onProbe.topCenter).toContain('A header that did not exist before')
    expect(
      onProbe.pageCount,
      'enabling a header and footer must not change how many pages the document occupies'
    ).toBe(offProbe.pageCount)
  })

  test('roman page numbers resolve as roman numerals', async () => {
    const { marker } = await openInSplitMode(
      [
        '---',
        'footer: true',
        // QUOTED deliberately. A bare `footerCenter: {n}` is not the string
        // "{n}" in YAML at all -- a value STARTING with `{` opens a flow
        // mapping, so js-yaml yields the object `{ n: null }`,
        // extractPageConfig correctly rejects it as not-a-string, and the
        // document silently falls back to DEFAULT_PAGE_CONFIG's own
        // "Page {n} of {total}". That is exactly what happened on this
        // gate's first run, and it is a fixture bug rather than a product
        // one: applyPageConfig writes every footer/header value through
        // quoteYamlString, so the app itself can never emit the unquoted
        // form. Worth knowing before hand-writing frontmatter in any future
        // fixture.
        'footerCenter: "{n}"',
        'pageNumberFormat: roman',
        '---'
      ].join('\n'),
      'roman'
    )
    const probe = await pollPreview(marker)
    console.log('Gate 19 roman footer:', probe.bottomCenter)

    // Same measurement limit as above: the computed value is the
    // unevaluated counter call, so what is checkable here is that the
    // roman COUNTER STYLE was selected -- a decimal-format document
    // produces a bare `counter(page)` with no style argument, so these two
    // outcomes are genuinely distinguishable. The resolved glyphs are
    // asserted in the PDF test below.
    expect(
      probe.bottomCenter,
      'a roman-format footer must select the lower-roman counter style'
    ).toBe('counter(page, lower-roman)')
  })

  test('a Custom page size renders at its own real pixel dimensions', async () => {
    const custom = await openInSplitMode(
      ['---', 'page: Custom', 'customWidth: 5', 'customHeight: 7', '---'].join('\n'),
      'custom'
    )
    const customProbe = await pollPreview(custom.marker)
    console.log('Gate 19 custom sheet:', JSON.stringify(customProbe.sheet))

    expect(customProbe.sheet, 'expected a rendered .pagedjs_sheet page box').not.toBeNull()
    expect(
      customProbe.sheet!.width,
      `a Custom 5in page must be ${CUSTOM_PAGE_WIDTH_PX}px wide, not Letter's ${LETTER_PAGE_WIDTH_PX}px`
    ).toBeCloseTo(CUSTOM_PAGE_WIDTH_PX, 0)
    expect(customProbe.sheet!.height).toBeCloseTo(CUSTOM_PAGE_HEIGHT_PX, 0)

    // Control in the SAME app instance, same window, same helper: proves the
    // app renders a genuinely DIFFERENT page size for a different document
    // rather than having hardcoded 480 somewhere new. (Gate 16's own
    // methodology; without it, a build that hardcoded the custom size would
    // pass.)
    const letter = await openInSplitMode(['---', 'page: Letter', '---'].join('\n'), 'lettercontrol')
    const letterProbe = await pollPreview(letter.marker)
    console.log('Gate 19 Letter control sheet:', JSON.stringify(letterProbe.sheet))

    expect(letterProbe.sheet!.width).toBeCloseTo(LETTER_PAGE_WIDTH_PX, 0)
    expect(letterProbe.sheet!.height).toBeCloseTo(LETTER_PAGE_HEIGHT_PX, 0)
    expect(
      customProbe.sheet!.width,
      'the Custom document and the Letter document must not render at the same width'
    ).not.toBeCloseTo(letterProbe.sheet!.width, 0)
  })

  test('a document theme changes real typography, on both surfaces alike', async () => {
    const { marker } = await openInSplitMode(['---', 'theme: resume', '---'].join('\n'), 'theme')
    const probe = await pollPreview(marker)

    // Paginator side: the resume theme's own 13px body, not the 14px default.
    expect(
      probe.bodyFontSize,
      `the resume theme must render body text at ${RESUME_BODY_FONT_PX}px in the paginated preview`
    ).toBe(`${RESUME_BODY_FONT_PX}px`)
    expect(probe.bodyFontSize).not.toBe(`${DEFAULT_BODY_FONT_PX}px`)

    // Editor side, measured in the SAME app on the SAME document. A theme
    // that applied to only one surface would silently break the
    // editor/paginator parity Gate 10 exists to protect -- so this is not a
    // duplicate assertion, it is the parity claim itself.
    const editorBody = await win.evaluate(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
      const p = document.querySelector('.milkdown-mount .ProseMirror p')
      return p ? window.getComputedStyle(p).fontSize : ''
    })
    console.log(`Gate 19 theme body size: preview=${probe.bodyFontSize}, editor=${editorBody}`)

    expect(
      editorBody,
      'the editor canvas must apply the same theme body size as the paginator'
    ).toBe(probe.bodyFontSize)
  })

  test('a selected font family resolves on both surfaces', async () => {
    const { marker } = await openInSplitMode(['---', 'fontFamily: inter', '---'].join('\n'), 'font')
    const probe = await pollPreview(marker)

    expect(
      probe.bodyFontFamily,
      'the paginated preview must resolve body text to the selected Inter family'
    ).toContain('Inter Variable')

    const editorFont = await win.evaluate(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
      const p = document.querySelector('.milkdown-mount .ProseMirror p')
      return p ? window.getComputedStyle(p).fontFamily : ''
    })
    console.log(`Gate 19 font: preview=${probe.bodyFontFamily}, editor=${editorFont}`)

    expect(
      editorFont,
      'the editor canvas must resolve the same font family as the paginator'
    ).toContain('Inter Variable')
  })

  test('running content resolves to real page numbers in a real exported PDF', async () => {
    // The other half of the header/footer proof. The DOM probe above can
    // only see the unevaluated `counter(page)` call (see its own comment);
    // this reads the text Chromium actually PAINTED, out of a real PDF
    // written through the real `file:exportPdf` IPC path -- which is also
    // the surface a user ultimately cares about. Text extraction via
    // pdfjs-dist, dynamically imported exactly as gate4-export.spec.ts does
    // (its Node entry point is pure ESM and cannot be `require`d from this
    // CJS-transpiled spec).
    const content = [
      '---',
      'header: true',
      'headerCenter: Gate 19 Running Header',
      'footer: true',
      'footerCenter: Page {n} of {total}',
      '---',
      '',
      '# Export fixture',
      '',
      BODY_TEXT,
      ''
    ].join('\n')

    const targetPath = join(fixtureDir, 'gate19-running-content.pdf')

    // Real `dialog` module, real `showSaveDialog` override -- the one piece
    // that has to be faked, since a native Save dialog cannot be driven
    // headlessly (gate13's own rationale and technique).
    await app!.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (() =>
        Promise.resolve({ canceled: false, filePath })) as typeof dialog.showSaveDialog
    }, targetPath)

    const result = await win.evaluate((markdown) => {
      const api = (window as unknown as { api: { exportPdf: (c: string) => Promise<unknown> } }).api
      return api.exportPdf(markdown)
    }, content)
    expect(result).toEqual({ filePath: targetPath })

    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const data = new Uint8Array(await readFile(targetPath))
    const pdf = await getDocument({ data, useSystemFonts: true }).promise
    expect(pdf.numPages, 'the export fixture must span multiple pages').toBeGreaterThan(1)

    let allText = ''
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const textContent = await page.getTextContent()
      allText += textContent.items
        .map((item) => ('str' in item ? item.str : ''))
        .join('')
        .concat('\n')
    }
    console.log('Gate 19 exported-PDF running content sample:', allText.slice(0, 400))

    // The running header, painted on a real page.
    expect(allText, 'the running header must appear in the exported PDF').toContain(
      'Gate 19 Running Header'
    )
    // THE RESOLUTION CLAIM: real digits, from counter(page)/counter(pages),
    // with the total matching the PDF's own real page count. A literal
    // `{n}`/`{total}` or an unevaluated `counter(page)` would fail here.
    expect(allText, 'counter(page)/counter(pages) must resolve to real digits').toMatch(
      new RegExp(`Page\\s*1\\s*of\\s*${pdf.numPages}`)
    )
    expect(allText).not.toContain('{n}')
    expect(allText).not.toContain('counter(')
  })
})
