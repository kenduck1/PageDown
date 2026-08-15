import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'
import { PREVIEW_DOCUMENT_SCALE_JS } from './gate-geometry'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../../src/main/recent-files'

// Gate 16 -- the Page Geometry Wiring sub-project's real end-to-end proof.
//
// WHY THIS GATE EXISTS AT ALL. Tasks 1-5 wired `computePageGeometry`
// (src/typography/page-geometry.ts) + `resolvePageConfig`
// (src/markdown/page-config.ts) into every surface that lays a document out:
// the Milkdown page card, the sandboxed pagination preview, the page count,
// and PDF export. Every one of those was verified only by unit tests --
// which run under jsdom, WHICH HAS NO LAYOUT ENGINE. A jsdom test can assert
// that a React component received `style={{ width: 794 }}`; it structurally
// cannot assert that anything is 794 real pixels wide, because nothing in
// jsdom is ever any pixels wide. Every renderer-side assertion in this
// sub-project up to this point is therefore a proxy for the thing that
// actually matters. This gate measures the real thing, in the real built
// app, on both surfaces at once, for one document.
//
// WHAT IT MEASURES, and why both halves are needed:
//   (a) The editor page card's real `getBoundingClientRect()` in the real
//       app-shell renderer -- real Chromium layout, real Tailwind, real
//       mounted Milkdown.
//   (b) The sandboxed pagination preview's real Paged.js page box, read out
//       of the real `pagedown-render://` WebContentsView -- a separate
//       process, a separate origin, a completely independent CSS pipeline
//       (its own `@page` rule built per-request in
//       resources/pagination-render/index.ts).
// A document's configured page size is only genuinely "wired" if BOTH agree.
// One surface alone could be right while the other silently stayed on the
// old fixed Letter geometry, which is exactly the pre-sub-project state.
//
// EXPECTED VALUES ARE HARDCODED LITERALS, DELIBERATELY. This gate does NOT
// call `computePageGeometry` to derive what it expects. If it did, a bug in
// `computePageGeometry` itself would move the expectation and the
// measurement together and the gate would pass green against wrong output --
// the exact vacuity this gate exists to rule out. The literals below are
// derived by hand from the fixture's own frontmatter (see FIXTURE_* ) and
// are the ONE place in this sub-project where the geometry numbers are
// stated independently of the code that computes them. Note this is the
// opposite of gate-geometry.ts's shared LETTER_GEOMETRY, which is a value
// FED INTO the pipeline (and so must come from the real function); these are
// values ASSERTED ON the pipeline's output.
//
// close() is wrapped in try/finally, so a test throwing before reaching it
// can't leak the temp userData directory or a live 6+-process Electron tree.
// The bounded/SIGKILL half now lives inside launchIsolatedApp's own returned
// close() (tests/gates/electron-launch.ts), not in a per-file `safeClose` copy.

// --- The fixture's page configuration, and the geometry it implies --------
//
// A4 portrait with FOUR GENUINELY DIFFERENT margins -- no two sides equal,
// on purpose. Four independent reasons for those exact choices:
//   1. A4 (794 x 1123 px at 96dpi) is a different page size from
//      DEFAULT_PAGE_CONFIG's Letter (816 x 1056), so "the wiring did
//      nothing" and "the wiring worked" are distinguishable outcomes on
//      BOTH axes.
//   2. Every margin differs from the default 1in (96px), so a surface that
//      read the page SIZE but ignored the MARGINS is also a distinguishable
//      outcome -- it would show a 794px-wide card with 96px padding and a
//      602px content box, not 72/144px and 578px.
//   3. Top/bottom differing from left/right exercises the `@page` margin
//      shorthand's real four-value form in the sandboxed render context,
//      rather than a uniform value that would look identical however the
//      four sides were ordered.
//   4. **top != bottom and left != right specifically.** An earlier version
//      of this fixture used 0.75 top/bottom and 0.5 left/right -- asymmetric
//      BETWEEN the axes but symmetric WITHIN each. That is not enough to pin
//      the order of `buildDocumentStylesheet`'s `margin: <top> <right>
//      <bottom> <left>` shorthand (resources/pagination-render/index.ts): a
//      top <-> bottom or left <-> right transposition left every number this
//      gate measured completely unchanged, because the content box's SIZE is
//      a sum (page - start - end) and a sum is transposition-invariant. That
//      function has no unit test at all (`resources/` is outside vitest's
//      include), so this gate is the only place its order can be pinned --
//      hence both distinct-per-axis values AND the content box's OFFSET
//      within the sheet being asserted below, which is what actually
//      distinguishes top from bottom.
const FIXTURE_FRONTMATTER = [
  '---',
  'page: A4',
  'margins:',
  '  top: 0.5',
  '  bottom: 1.25',
  '  left: 0.75',
  '  right: 1.5',
  '---'
].join('\n')

// Hand-derived from the frontmatter above at 96 CSS px/in, NOT computed:
//   width   8.2677in (210mm) * 96 = 793.70 -> 794
//   height 11.6929in (297mm) * 96 = 1122.52 -> 1123
//   margins 0.5in * 96 = 48 (top), 1.25in * 96 = 120 (bottom),
//           0.75in * 96 = 72 (left), 1.5in * 96 = 144 (right)
//   content width  794 - 72 - 144 = 578
//   content height 1123 - 48 - 120 = 955
const A4_PAGE_WIDTH_PX = 794
const A4_PAGE_HEIGHT_PX = 1123
const A4_MARGIN_TOP_PX = 48
const A4_MARGIN_BOTTOM_PX = 120
const A4_MARGIN_LEFT_PX = 72
const A4_MARGIN_RIGHT_PX = 144
const A4_CONTENT_WIDTH_PX = 578
const A4_CONTENT_HEIGHT_PX = 955

// The Letter/1in values this gate must NOT see -- asserted against
// explicitly, so a regression that silently reverts to the old fixed
// geometry fails with a message that names what happened instead of a bare
// "expected 794, got 816".
const LETTER_PAGE_WIDTH_PX = 816
const LETTER_CONTENT_WIDTH_PX = 624
const LETTER_MARGIN_PX = 96

// Deliberately long enough to wrap several times inside either page's
// content box, and used VERBATIM in both passes -- the A4 fixture file's own
// body and the typed Letter control -- so the two screenshot artifacts differ
// only in the page box they were laid out in.
const BODY_TEXT =
  'A real paragraph of body text, long enough to actually wrap inside the page ' +
  'content box on both surfaces, so a content-width regression would show up as ' +
  'genuinely different line breaking and not merely a different box measurement.'

// Sub-pixel tolerance for a real, rendered box. The geometry pipeline
// rounds to whole pixels, but it reaches Chromium as an inches value
// (`@page { size: 8.270833...in }` -- see buildDocumentStylesheet in
// resources/pagination-render/index.ts), so the layout engine's own
// in -> px conversion can land a hair off a whole number.
const PX_TOLERANCE = 0.5

const GET_MAIN_WINDOW_TIMEOUT_MS = 60_000

// Same POSITIVE `file://` match as gate9/gate10/gate11/gate13/gate15's own
// `getMainWindow` -- this app opens a SECOND window at startup (the Phase 0
// spike's sandboxed pagedown-render:// harness). Both `firstWindow()` and a
// negative "isn't pagedown-render://" filter would race or misidentify it,
// since every window starts on about:blank before its real navigation
// completes.
async function getMainWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + GET_MAIN_WINDOW_TIMEOUT_MS
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
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

interface PreviewGeometryProbe {
  pageCount: number
  sheet: { width: number; height: number } | null
  area: { width: number; height: number } | null
  // The content box's top-left corner relative to the page box's. This is
  // what makes the `@page` margin shorthand's ORDER observable: the area's
  // width and height are sums (page - start - end) and so cannot tell a
  // top <-> bottom or left <-> right transposition from the correct order,
  // but its offset can -- it IS the top and left margins, individually.
  // Structurally guaranteed by Paged.js's own base.js, read directly rather
  // than assumed: `.pagedjs_pagebox` is a grid whose column/row tracks are
  // `[left] var(--pagedjs-margin-left) [center] ... [right] ...` /
  // `[header] var(--pagedjs-margin-top) [page] ... [footer] ...` (lines
  // 264-265), `.pagedjs_area` is placed at `grid-column: center; grid-row:
  // page` (line 370-372), and the pagebox itself sits at
  // `sheet-center`/`sheet-middle` inside `.pagedjs_sheet`, offset only by
  // the bleed tracks, which are 0 by default and never set here.
  areaOffset: { top: number; left: number } | null
  text: string
}

// Reads the REAL Paged.js page box out of the REAL, on-screen split-preview
// WebContentsView, using the exact mechanism gate15-split-mode.spec.ts
// established (app.evaluate() -> mainWindow.contentView.children ->
// webContents.executeJavaScript). See gate15's own header comment for why a
// renderer-side path is impossible here: contextBridge deep-freezes
// window.api, and the sandboxed render context is by design unreachable from
// the renderer's bridge surface at all, so a main-process probe isn't a
// shortcut around a real path -- it's the only path that exists for this
// fact. Not the discouraged __pagedownPhase0 bridge either; this is
// Electron's own public main-process API.
//
// Disambiguation, per gate15: this same mainWindow ALSO hosts a second,
// unrelated pagedown-render:// WebContentsView from app startup (the Phase 0
// spike's createPaginationHarness(mainWindow)), parked permanently
// off-screen at {x:-9999,y:-9999}. Filtering to a genuinely on-screen
// rectangle is what isolates the split-preview harness's view from it.
//
// `.pagedjs_sheet` / `.pagedjs_area` are Paged.js's own page-box and
// content-box elements (node_modules/pagedjs/src/chunker/chunker.js's
// TEMPLATE; base.js sizes .pagedjs_sheet from --pagedjs-width/height, which
// atpage.js derives from the @page rule this context was handed).
async function probePreviewGeometry(
  app: ElectronApplication
): Promise<PreviewGeometryProbe | null> {
  return app.evaluate(async ({ BrowserWindow, WebContentsView }, scaleJs) => {
    // PREVIEW_DOCUMENT_SCALE_JS is threaded in as evaluate()'s ARGUMENT, not
    // referenced directly inside this callback. An app.evaluate() callback runs
    // in a bare V8 context with no module resolution, so a transpiled import
    // binding is not reachable from inside one -- referencing it directly
    // fails at runtime with `ReferenceError: _gateGeometry is not defined`,
    // which is exactly how this shipped and how all three of these gates
    // failed. gate-geometry.ts's own module comment states this rule for
    // LETTER_GEOMETRY; it applies identically here.

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
        // Split mode's preview is fitted to width by a CSS \`zoom\` on
        // #content-root, and \`zoom\` participates in layout -- so every rect
        // below comes back already multiplied by it. This gate's question is
        // a DOCUMENT-SPACE one ("is an A4 page 794 CSS px wide?"), not a
        // "how big is it on screen right now" one, so each measurement is
        // divided back out. See gate-geometry.ts's PREVIEW_DOCUMENT_SCALE_JS
        // for the measurement behind this and for why offsetWidth is not the
        // answer. The scale itself is gate35's to pin, not this gate's.
        var scale = ${scaleJs}
        function box(el) {
          if (!el) return null
          var r = el.getBoundingClientRect()
          return { width: r.width / scale, height: r.height / scale }
        }
        function offset(el, ref) {
          if (!el || !ref) return null
          var a = el.getBoundingClientRect()
          var b = ref.getBoundingClientRect()
          return { top: (a.top - b.top) / scale, left: (a.left - b.left) / scale }
        }
        var root = document.getElementById('content-root')
        var sheetEl = document.querySelector('.pagedjs_sheet')
        var areaEl = document.querySelector('.pagedjs_area')
        return JSON.stringify({
          pageCount: document.querySelectorAll('.pagedjs_page').length,
          sheet: box(sheetEl),
          area: box(areaEl),
          areaOffset: offset(areaEl, sheetEl),
          text: root ? root.innerText : ''
        })
      })()
    `)) as string
    return JSON.parse(raw) as PreviewGeometryProbe
  }, PREVIEW_DOCUMENT_SCALE_JS)
}

interface EditorGeometryMeasurement {
  cardWidth: number
  cardPaddingLeft: number
  cardPaddingRight: number
  mountWidth: number
  editingWidth: number
  canvasTransform: string
}

// The real, rendered page-card box in the real app-shell renderer. Shared by
// this gate's two passes (the default-Letter control and the A4 document)
// specifically so both are measured the exact same way -- a control measured
// differently from the case it controls for isn't a control.
async function measureEditorGeometry(win: Page): Promise<EditorGeometryMeasurement> {
  const measured = await win.evaluate(async () => {
    // Two animation-frame ticks after the mount is detected, matching every
    // other paint-dependent measurement in this suite (Gate 10, thumbnail
    // capture, Phase 1 Gate 3): the element being in the DOM does not mean
    // its layout has settled to final values.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
    const card = document.querySelector('[data-testid="page-card"]')
    const mount = document.querySelector('.milkdown-mount')
    const editing = document.querySelector('.milkdown-mount .ProseMirror')
    if (!card || !mount || !editing) return { error: 'expected page card + mounted editor' }
    const cardStyle = window.getComputedStyle(card)
    return {
      cardWidth: card.getBoundingClientRect().width,
      // Deliberately read back as COMPUTED style, not from the React prop:
      // this is what the layout engine actually applied.
      cardPaddingLeft: parseFloat(cardStyle.paddingLeft),
      cardPaddingRight: parseFloat(cardStyle.paddingRight),
      mountWidth: mount.getBoundingClientRect().width,
      editingWidth: editing.getBoundingClientRect().width,
      // Zoom is 1 by default (EditorScreen's own useState(1)); read it back
      // rather than assumed, since a non-1 scale on the wrapper would
      // silently scale every getBoundingClientRect() above.
      canvasTransform: (() => {
        const wrapper = card.parentElement
        return wrapper ? window.getComputedStyle(wrapper).transform : 'none'
      })()
    }
  })
  if ('error' in measured) throw new Error(measured.error as string)
  return measured as EditorGeometryMeasurement
}

// Widens the real app window before anything is measured. Two reasons, both
// about evidence rather than correctness: the default 900px window is
// NARROWER than either page card (816px Letter, 794px A4) once the 216px
// sidebar is taken out, so a screenshot of the card is clipped mid-sentence
// and shows nothing useful about its real width; and the Split-mode preview
// pane gets a usable width instead of a sliver. It does NOT change any
// measurement below -- the card is a FIXED width, deliberately (see
// EditorScreen's own comment on why it's `width` and not `maxWidth`), so it
// stays at its true page size regardless of window size. That independence
// is itself checked, by the Letter control pass measuring exactly 816 in
// this same widened window.
async function widenWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().startsWith('file://')
    )
    mainWindow?.setContentSize(1400, 1000)
  })
}

async function captureCard(win: Page, filename: string): Promise<void> {
  await mkdir(join(__dirname, 'results'), { recursive: true })
  await win.locator('[data-testid="page-card"]').screenshot({
    path: join(__dirname, 'results', filename)
  })
}

test('Gate 16: a document whose frontmatter sets A4 lays out at A4 in BOTH the editor page card and the sandboxed pagination preview', async () => {
  test.setTimeout(120_000)

  let app: ElectronApplication | undefined
  let close: (() => Promise<void>) | undefined
  let fixtureDir: string | undefined

  try {
    const launched = await launchIsolatedApp(['out/main/index.js'])
    app = launched.app
    close = launched.close

    const win = await getMainWindow(app)
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
    await widenWindow(app)

    const userDataDir = await app.evaluate(({ app: electronApp }) =>
      electronApp.getPath('userData')
    )

    // A real fixture file on disk in a real temp directory -- NOT userData,
    // which is reserved for the app's own state (recent-files.json,
    // thumbnails). Same convention as gate11/gate13/gate14.
    fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate16-'))
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const fixtureFilename = `gate16-a4-${nonce}.md`
    const fixturePath = join(fixtureDir, fixtureFilename)
    const marker = `Gate 16 A4 Fixture ${nonce}`
    const content = [FIXTURE_FRONTMATTER, '', `# ${marker}`, '', BODY_TEXT, ''].join('\n')
    await writeFile(fixturePath, content, 'utf8')

    // Real UI navigation to a real file, via the real recent-files allowlist
    // -- the same route gate11 uses. HomeScreen fetches its recent list once
    // on mount, which already happened above, so reload after seeding.
    const originalRecents = await readRecentFiles(userDataDir)
    await writeRecentFiles(
      userDataDir,
      mergeRecentFiles(originalRecents, fixturePath, new Date().toISOString())
    )
    await win.reload()
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

    // ================================================================
    // (0) CONTROL PASS -- the DEFAULT, no-frontmatter document
    // ================================================================
    // Measured in the SAME app instance, the SAME window, at the SAME window
    // size, through the SAME helper as the A4 pass below. Without this, the
    // gate would only show "an A4 document measures 794px" -- which a build
    // that hardcoded 794 everywhere would also satisfy. With it, the gate
    // shows the one thing that actually matters: this app renders a DIFFERENT
    // page size for a DIFFERENT document, and the difference tracks the
    // document's own frontmatter. It also doubles as the Letter-side
    // "before" screenshot the sub-project's manual-verification step asks
    // for.
    await win.getByRole('button', { name: 'New document' }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')

    // Real typed keystrokes of the SAME body text the A4 fixture carries.
    // Not needed for the measurements (an empty card is already exactly
    // 816px wide) -- it's what makes the two screenshot artifacts genuinely
    // comparable: identical text, photographed in both page boxes, so the
    // Letter card's wider text column and later line breaks are directly
    // visible rather than having to be taken on trust from the numbers.
    await win.click('.milkdown-mount .ProseMirror')
    await win.keyboard.type('Gate 16 Letter Control')
    await win.keyboard.press('Enter')
    await win.keyboard.type(BODY_TEXT)

    const letterGeometry = await measureEditorGeometry(win)
    console.log(
      'Gate 16 editor-side measurements (DEFAULT/Letter control):',
      JSON.stringify(letterGeometry, null, 2)
    )

    expect(
      letterGeometry.cardWidth,
      `a document with no page frontmatter must still render at Letter width (${LETTER_PAGE_WIDTH_PX}px)`
    ).toBeCloseTo(LETTER_PAGE_WIDTH_PX, 0)
    expect(
      letterGeometry.cardPaddingLeft,
      `a document with no page frontmatter must keep the default 1in (${LETTER_MARGIN_PX}px) margin`
    ).toBeCloseTo(LETTER_MARGIN_PX, 0)
    expect(letterGeometry.editingWidth).toBeCloseTo(LETTER_CONTENT_WIDTH_PX, 0)

    await captureCard(win, 'gate16-letter-page-card.png')

    // ================================================================
    // (a) EDITOR SIDE -- real rendered pixels in the real app shell
    // ================================================================
    // Back to Home via a renderer reload rather than the "<- Home" button:
    // that button runs EditorScreen's real dirty check, which on a dirty
    // document opens a REAL native Save/Don't Save/Cancel dialog that no
    // headless gate can dismiss. A reload sidesteps that entirely and is
    // exactly what the seeding step above already needed anyway.
    await win.reload()
    await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
    await win
      .getByRole('button', { name: new RegExp(fixtureFilename.replace(/[.]/g, '\\.')) })
      .click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')

    const editorGeometry = await measureEditorGeometry(win)
    console.log(
      'Gate 16 editor-side measurements (A4 document):',
      JSON.stringify(editorGeometry, null, 2)
    )

    // A scaled canvas wrapper would make every measurement below a scaled
    // number rather than the real layout value -- assert the identity
    // transform explicitly instead of trusting the default.
    expect(
      ['none', 'matrix(1, 0, 0, 1, 0, 0)'],
      'the zoom wrapper must be at scale 1 for these to be real layout pixels'
    ).toContain(editorGeometry.canvasTransform)

    expect(
      editorGeometry.cardWidth,
      `the page card must render at A4 width (${A4_PAGE_WIDTH_PX}px), not Letter's ${LETTER_PAGE_WIDTH_PX}px`
    ).toBeCloseTo(A4_PAGE_WIDTH_PX, 0)
    expect(editorGeometry.cardWidth).not.toBeCloseTo(LETTER_PAGE_WIDTH_PX, 0)

    // The margin half of the wiring: a surface that read `page: A4` but
    // ignored `margins:` would still be 794px wide, with 96px padding.
    // Asserted per side against DIFFERENT expected values (0.75in left,
    // 1.5in right), so a left <-> right transposition anywhere in the editor
    // path fails here rather than cancelling out. (The editor card's own top
    // and bottom padding are deliberately FIXED at 22/34px rather than the
    // document's vertical margins -- see EditorScreen's renderPageCard --
    // because the editor canvas is one continuous card, not a sequence of
    // sheets, so there is no vertical-margin claim to make on this surface.)
    expect(
      editorGeometry.cardPaddingLeft,
      'the page card left padding must be the document’s own 0.75in margin'
    ).toBeCloseTo(A4_MARGIN_LEFT_PX, 0)
    expect(
      editorGeometry.cardPaddingRight,
      'the page card right padding must be the document’s own 1.5in margin'
    ).toBeCloseTo(A4_MARGIN_RIGHT_PX, 0)

    expect(
      editorGeometry.mountWidth,
      `the Milkdown mount must be capped to the A4 content box (${A4_CONTENT_WIDTH_PX}px)`
    ).toBeCloseTo(A4_CONTENT_WIDTH_PX, 0)
    expect(
      editorGeometry.editingWidth,
      `the real editing root must be ${A4_CONTENT_WIDTH_PX}px, not Letter's ${LETTER_CONTENT_WIDTH_PX}px`
    ).toBeCloseTo(A4_CONTENT_WIDTH_PX, 0)
    expect(editorGeometry.editingWidth).not.toBeCloseTo(LETTER_CONTENT_WIDTH_PX, 0)

    // The control pass and this one, stated as one comparison: same app,
    // same window, different document, genuinely different page box.
    expect(
      editorGeometry.cardWidth,
      'the A4 document and the default document must not render at the same page width'
    ).not.toBeCloseTo(letterGeometry.cardWidth, 0)

    // Visual evidence artifacts for this sub-project's task report -- real
    // screenshots of the real page cards, Letter (above) and A4 (here),
    // written into tests/gates/results/ like every other durable gate artifact
    // (gate4's exported PDFs, gate2's timing JSON).
    await captureCard(win, 'gate16-a4-page-card.png')

    // ================================================================
    // (b) PAGINATION SIDE -- the real sandboxed render context
    // ================================================================
    // Real click on the real toolbar control. Split mode is the one surface
    // that keeps a live, inspectable paginated render of the CURRENT
    // document on screen; entering it drives the real
    // `split-preview:sendDocument` handler, which computes this document's
    // geometry from the document's OWN content
    // (src/main/split-preview-window.ts) -- the test never supplies it.
    // `exact: true` rules out the unrelated "Split cell" table button.
    await win.getByRole('button', { name: 'Split', exact: true }).click()

    const placeholder = win.getByTestId('split-preview-placeholder')
    await expect(placeholder).toBeVisible()

    // Poll past BOTH stacked debounces (plugin-listener's ~200ms feeding
    // documentStore, then SplitPreview's own 500ms) plus a real Paged.js
    // layout pass, waiting for a render that genuinely contains THIS
    // document's unique marker -- not merely "some render happened."
    let lastProbe: PreviewGeometryProbe | null = null
    await expect
      .poll(
        async () => {
          lastProbe = await probePreviewGeometry(app!)
          return lastProbe?.text.includes(marker) ?? false
        },
        {
          message: 'expected the real split-preview WebContentsView to render the A4 fixture',
          timeout: 30_000
        }
      )
      .toBe(true)

    const probe = lastProbe as PreviewGeometryProbe | null
    expect(probe).not.toBeNull()
    console.log('Gate 16 pagination-side measurements:', JSON.stringify(probe, null, 2))

    expect(probe!.sheet, 'expected a rendered .pagedjs_sheet page box').not.toBeNull()
    expect(probe!.area, 'expected a rendered .pagedjs_area content box').not.toBeNull()

    expect(
      probe!.sheet!.width,
      `the paginated page box must be A4 wide (${A4_PAGE_WIDTH_PX}px), not Letter's ${LETTER_PAGE_WIDTH_PX}px`
    ).toBeCloseTo(A4_PAGE_WIDTH_PX, 0)
    expect(
      probe!.sheet!.height,
      `the paginated page box must be A4 tall (${A4_PAGE_HEIGHT_PX}px), not Letter's 1056px`
    ).toBeCloseTo(A4_PAGE_HEIGHT_PX, 0)
    expect(
      probe!.area!.width,
      `the paginated content box must be ${A4_CONTENT_WIDTH_PX}px wide (${A4_PAGE_WIDTH_PX} - ${A4_MARGIN_LEFT_PX} - ${A4_MARGIN_RIGHT_PX})`
    ).toBeCloseTo(A4_CONTENT_WIDTH_PX, 0)
    expect(
      probe!.area!.height,
      `the paginated content box must be ${A4_CONTENT_HEIGHT_PX}px tall (${A4_PAGE_HEIGHT_PX} - ${A4_MARGIN_TOP_PX} - ${A4_MARGIN_BOTTOM_PX})`
    ).toBeCloseTo(A4_CONTENT_HEIGHT_PX, 0)

    // THE `@page` MARGIN SHORTHAND'S ORDER, pinned. Everything above this
    // point measures sums, which are invariant under a top <-> bottom or
    // left <-> right transposition; these two assertions are the only place
    // in the repo where `buildDocumentStylesheet`'s
    // `margin: <top> <right> <bottom> <left>` is checked against the
    // individual sides it claims to emit. With this fixture's four distinct
    // margins, emitting them in any other order moves this offset.
    expect(probe!.areaOffset, 'expected a measurable content-box offset').not.toBeNull()
    expect(
      probe!.areaOffset!.top,
      `the content box must start ${A4_MARGIN_TOP_PX}px down the page (the 0.5in TOP margin, not the 1.25in bottom one)`
    ).toBeCloseTo(A4_MARGIN_TOP_PX, 0)
    expect(
      probe!.areaOffset!.left,
      `the content box must start ${A4_MARGIN_LEFT_PX}px in from the page edge (the 0.75in LEFT margin, not the 1.5in right one)`
    ).toBeCloseTo(A4_MARGIN_LEFT_PX, 0)
    // Stated as the complementary check too: the bottom and right margins are
    // then whatever is left over, and must be the OTHER two values.
    expect(probe!.sheet!.height - probe!.areaOffset!.top - probe!.area!.height).toBeCloseTo(
      A4_MARGIN_BOTTOM_PX,
      0
    )
    expect(probe!.sheet!.width - probe!.areaOffset!.left - probe!.area!.width).toBeCloseTo(
      A4_MARGIN_RIGHT_PX,
      0
    )

    // ================================================================
    // (c) CROSS-SURFACE AGREEMENT
    // ================================================================
    // The property this whole sub-project exists to deliver, stated as one
    // assertion: the two independently-styled surfaces, in two separate
    // processes, lay this document's text out in identically-wide boxes.
    // Both sides are already pinned to literals above, so this cannot pass
    // vacuously -- it's the explicit statement of what those literals mean.
    expect(
      Math.abs(editorGeometry.editingWidth - probe!.area!.width),
      'the editor and the paginated preview must use the same content width for the same document'
    ).toBeLessThanOrEqual(PX_TOLERANCE)
  } finally {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
    if (app && close) await close()
  }
})
