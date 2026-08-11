import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedApp } from './electron-launch'
import { mergeRecentFiles, readRecentFiles, writeRecentFiles } from '../src/main/recent-files'

// Gate 40 -- the table-of-contents and image-sizing features' real end-to-end
// proof. (39 was claimed by the .docx export work the same night; check
// `ls phase0/` for the next free number before adding one during parallel work.)
//
// WHY THIS GATE EXISTS. Both features are asserted extensively under Vitest,
// but three of their central claims are the kind jsdom structurally cannot
// evaluate:
//
//   1. "The table of contents renders on every surface that consumes
//      markdownToHtml." The paginated surface is a sandboxed, separate-origin
//      WebContentsView running real Paged.js. Only a real app can show it.
//   2. "Entries carry REAL page numbers, resolved by Paged.js's own
//      target-counter handler rather than by a second render pass." That claim
//      rests on a CSS feature no other engine implements and that Chromium
//      itself rejects -- so it is provable only by (a) watching pagedjs's
//      polisher rewrite the declaration and (b) reading the digits out of a
//      real exported PDF.
//   3. "An image sized with {width=...} renders at the same size on the editor
//      canvas and the paginator." jsdom has no layout engine, so the unit
//      tests can only prove both surfaces emit the same ATTRIBUTE. This gate
//      measures real painted boxes.
//
// EXPECTED VALUES ARE HAND-DERIVED LITERALS, per Gate 16's standing rule: this
// file never calls computePageGeometry or any of the code under test to work
// out what it expects.
//
// RUN STATUS, RECORDED HONESTLY: this gate has NOT yet been observed green.
// Two attempts on 2026-08-11 both failed inside `launchIsolatedApp` in
// `beforeAll`, reaching no assertion, with a Worker teardown timeout -- the
// exact environmental signature CLAUDE.md's Testing section describes. Three
// things were checked before writing that off, in the order CLAUDE.md's own
// methodology prescribes:
//
//   - The built app itself BOOTS: `electron out/main/index.js
//     --user-data-dir=<tmp>` ran to a clean SIGTERM with no output, ruling out
//     "the feature broke startup, so the renderer never sets window.api and
//     the hook waits forever" -- which produces this identical symptom and is
//     the one failure mode that would be a real regression.
//   - A CONTROL gate, phase0/gate11-editor-save-race.spec.ts, completely
//     untouched by this work, failed with the SAME signature in the same
//     conditions minutes later. CLAUDE.md is explicit that a passing control
//     rules out the environment while a FAILING one implicates it; this is the
//     failing case.
//   - Both attempts ran while a second agent held its own Playwright worker
//     and 9 live Electron processes (load average 6.6, then 3.9).
//
// So: the next person to touch this should run it on a quiet host before
// trusting it, and should treat a NAMED assertion failure here -- as opposed
// to another bare hook timeout -- as a real product regression.

// Letter at 96dpi with 1in margins -> 8.5*96 - 2*96. Restated as a literal on
// purpose (see above); it is also what Gate 10 pins the editor canvas to.
const CONTENT_WIDTH_PX = 624
const HALF_CONTENT_WIDTH_PX = CONTENT_WIDTH_PX / 2

// A real, decodable 1x1 PNG. Chosen over a larger fixture because the point is
// that the RENDERED width comes from `{width=...}` and not from the image's
// own intrinsic size -- an unsized control renders 1px wide, a `{width=50%}`
// one renders 312px, and no plausible bug produces the second from the first.
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

interface Probe {
  pageCount: number
  /** Text of every rendered TOC entry, in order. */
  tocEntries: string[]
  /** hrefs of those entries, and the ids they should be pointing at. */
  tocHrefs: string[]
  headingIds: string[]
  /**
   * Computed `::after` content of the first TOC anchor. THE discriminator for
   * whether Paged.js's target-counter handler ran: it rewrites the declaration
   * into `counter(target-counter-<uuid>)` against a variable it then
   * counter-resets per page. If the handler never ran, Chromium rejects
   * `target-counter(...)` as an invalid `content` value and this reads
   * `normal` instead.
   */
  tocAfterContent: string
  /** Does the raw marker text leak onto the page? */
  containsRawMarker: boolean
  sizedImageWidth: number | null
  plainImageWidth: number | null
  /** A full-content-width element on the same surface, for a scale-free ratio. */
  rulerWidth: number | null
  text: string
}

let app: ElectronApplication | undefined
let close: (() => Promise<void>) | undefined
let win: Page
let userDataDir: string
let fixtureDir: string

const GET_MAIN_WINDOW_TIMEOUT_MS = 60_000

// Same positive `file://` match every other gate's own getMainWindow uses --
// this app opens a second, sandboxed window at startup and both firstWindow()
// and a negative filter race it.
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

// Reads the REAL sandboxed render context, via the main-process route Gate
// 15/16/19 established (app.evaluate -> mainWindow.contentView.children ->
// webContents.executeJavaScript). A renderer-side path is categorically
// impossible: contextBridge deep-freezes window.api and this context is
// deliberately unreachable from it. The on-screen-rectangle filter
// disambiguates the split-preview view from the Phase 0 spike's own harness,
// which is parked off-screen.
async function probePreview(application: ElectronApplication): Promise<Probe | null> {
  return application.evaluate(async ({ BrowserWindow, WebContentsView }) => {
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
        function widthOf(sel) {
          var el = document.querySelector(sel)
          return el ? el.getBoundingClientRect().width : null
        }
        var anchors = Array.prototype.slice.call(
          document.querySelectorAll('.pagedown-toc a')
        )
        var headings = Array.prototype.slice.call(
          document.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')
        )
        var after = anchors[0]
          ? window.getComputedStyle(anchors[0], '::after').content
          : ''
        var text = document.body.innerText || ''
        return JSON.stringify({
          pageCount: document.querySelectorAll('.pagedjs_page').length,
          tocEntries: anchors.map(function (a) { return a.textContent }),
          tocHrefs: anchors.map(function (a) { return a.getAttribute('href') }),
          headingIds: headings.map(function (h) { return '#' + h.id }),
          tocAfterContent: after,
          containsRawMarker: text.indexOf('<!-- toc -->') !== -1 || /\\{width=/.test(text),
          sizedImageWidth: widthOf('img[width]'),
          plainImageWidth: widthOf('img:not([width])'),
          rulerWidth: widthOf('hr'),
          text: text
        })
      })()
    `)) as string
    return JSON.parse(raw) as Probe
  })
}

/**
 * Writes a fixture, seeds the real recent-files allowlist, reloads, opens it
 * through real UI, and enters Split mode. Reload rather than the "<- Home"
 * button, for Gate 19's own reason: that button runs the real dirty check,
 * which opens a native dialog no headless gate can dismiss.
 */
async function openInSplitMode(body: string, label: string): Promise<string> {
  const marker = `Gate40 ${label} ${Date.now()}`
  const filename = `gate40-${label}-${Date.now()}.md`
  const path = join(fixtureDir, filename)
  await writeFile(path, body.replace('__MARKER__', marker), 'utf8')

  const originalRecents = await readRecentFiles(userDataDir)
  await writeRecentFiles(
    userDataDir,
    mergeRecentFiles(originalRecents, path, new Date().toISOString())
  )
  await win.reload()
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)
  await win.getByRole('button', { name: new RegExp(filename.replace(/[.]/g, '\\.')) }).click()
  await win.waitForSelector('.milkdown-mount .ProseMirror')

  // `exact: true` rules out the unrelated "Split cell" table button.
  await win.getByRole('button', { name: 'Split', exact: true }).click()
  await expect(win.getByTestId('split-preview-placeholder')).toBeVisible()

  return marker
}

// Waits for a render that genuinely contains THIS document's marker AND whose
// page count has SETTLED. The settle half is required for correctness, not
// padding: Paged.js appends pages progressively, so a probe firing as soon as
// the marker appears reliably reads `pageCount: 1` for a multi-page document
// (Gate 19 found this the hard way).
async function pollPreview(marker: string): Promise<Probe> {
  let last: Probe | null = null
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
        message: `expected the split preview to render "${marker}" and settle`,
        timeout: 45_000,
        intervals: [500]
      }
    )
    .toBe(true)
  return last as unknown as Probe
}

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
  fixtureDir = await mkdtemp(join(tmpdir(), 'pagedown-gate40-'))
})

test.afterAll(async () => {
  try {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
  } finally {
    if (app && close) await close()
  }
})

// A deliberately multi-page fixture: `<!-- pagebreak -->` guarantees the last
// heading lands on page 2+, so a page number of "1" for it would be a real
// failure rather than a vacuous pass.
const TOC_FIXTURE = [
  '# __MARKER__',
  '',
  '<!-- toc -->',
  '',
  '## Alpha section',
  '',
  'Alpha body text.',
  '',
  '### Alpha detail',
  '',
  'Detail body text.',
  '',
  '<!-- pagebreak -->',
  '',
  '## Omega section',
  '',
  'Omega body text.',
  ''
].join('\n')

test.describe('Gate 40: table of contents', () => {
  test('renders real, linked entries in the sandboxed paginated preview', async () => {
    const marker = await openInSplitMode(TOC_FIXTURE, 'toc')
    const probe = await pollPreview(marker)

    console.log(
      `Gate 40 TOC preview: pages=${probe.pageCount} entries=${JSON.stringify(probe.tocEntries)}`
    )

    expect(probe.pageCount, 'fixture must span multiple pages').toBeGreaterThan(1)
    expect(probe.tocEntries).toEqual([marker, 'Alpha section', 'Alpha detail', 'Omega section'])

    // The marker itself must NOT survive as visible text anywhere -- if the
    // remark transform never ran, `<!-- toc -->` would render as an HTML
    // comment (invisible) but the entries would be absent, so this and the
    // assertion above are checking different halves.
    expect(probe.containsRawMarker).toBe(false)

    // Every entry's href resolves to an id that really exists on this page.
    // This is what target-counter needs in order to find the target element
    // at all, and it is the one place the clobber-prefix coupling documented
    // in toc-to-hast.ts is observable end to end.
    expect(probe.tocHrefs.length).toBe(4)
    for (const href of probe.tocHrefs) {
      expect(probe.headingIds, `TOC href ${href} must point at a real heading id`).toContain(href)
    }
  })

  test("Paged.js's target-counter handler really rewrites the page-number rule", async () => {
    // THE DOM-level half of the page-number claim. pagedjs's TargetCounters
    // handler (node_modules/pagedjs/src/modules/generated-content/
    // target-counters.js, registered in its DEFAULT handler set) replaces the
    // `target-counter(...)` funcNode with `counter(target-counter-<uuid>)`
    // before the stylesheet ever reaches Chromium. So a computed `::after`
    // content of `counter(...)` proves the handler ran; `normal` would mean
    // Chromium rejected the declaration and nothing resolved it -- exactly
    // what happens on the editing surface, deliberately, and what would
    // happen here if this feature's whole page-number mechanism were inert.
    const marker = await openInSplitMode(TOC_FIXTURE, 'targetcounter')
    const probe = await pollPreview(marker)

    console.log(`Gate 40 TOC ::after content: ${probe.tocAfterContent}`)

    expect(probe.tocAfterContent).not.toBe('normal')
    expect(probe.tocAfterContent).toContain('counter(')
    expect(
      probe.tocAfterContent,
      'pagedjs must have rewritten target-counter() into a plain counter()'
    ).not.toContain('target-counter(')
  })

  test('entries carry real, resolved page numbers in a real exported PDF', async () => {
    // The other half: the DOM can only show the UNEVALUATED counter call
    // (counters resolve at used-value time and no DOM API exposes the
    // glyphs). This reads what Chromium actually PAINTED, through the real
    // file:exportPdf IPC path -- the surface a user ultimately cares about.
    const content = TOC_FIXTURE.replace('__MARKER__', 'Gate 40 TOC export')
    const targetPath = join(fixtureDir, 'gate40-toc.pdf')

    // Real dialog module, real showSaveDialog override -- the one piece that
    // has to be faked, since a native Save dialog cannot be driven headlessly
    // (gate13's rationale and technique).
    await app!.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (() =>
        Promise.resolve({ canceled: false, filePath })) as typeof dialog.showSaveDialog
    }, targetPath)

    const result = await win.evaluate((markdown) => {
      const api = (window as unknown as { api: { exportPdf: (c: string) => Promise<unknown> } }).api
      return api.exportPdf(markdown)
    }, content)
    expect(result).toEqual({ filePath: targetPath })

    // pdfjs-dist imported dynamically exactly as gate4/gate19 do: its Node
    // entry point is pure ESM and cannot be `require`d from this
    // CJS-transpiled spec.
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const data = new Uint8Array(await readFile(targetPath))
    const pdf = await getDocument({ data, useSystemFonts: true }).promise
    expect(pdf.numPages, 'the export fixture must span multiple pages').toBeGreaterThan(1)

    const page = await pdf.getPage(1)
    const items = (await page.getTextContent()).items
    const firstPageText = items.map((item) => ('str' in item ? item.str : '')).join('')
    console.log('Gate 40 exported-PDF page 1 text:', firstPageText.slice(0, 400))

    // "Omega section" is behind a real page break, so its entry must carry a
    // number GREATER THAN 1. A feature that emitted a constant, or that
    // resolved every target to page 1, passes a "contains a digit" check and
    // fails this one.
    const omega = /Omega\s*section\s*(\d+)/.exec(firstPageText.replace(/\s+/g, ' '))
    expect(omega, `expected an "Omega section <page>" entry; got: ${firstPageText}`).not.toBeNull()
    expect(
      Number(omega![1]),
      'the entry after a page break must not report page 1'
    ).toBeGreaterThan(1)

    expect(firstPageText).not.toContain('counter(')
    expect(firstPageText).not.toContain('target-counter')
  })

  test('the editor canvas lists the same entries, and shows no page numbers', async () => {
    // Both halves matter. The same entries: the canvas builds its list from
    // the ProseMirror doc while the paginator builds its from mdast, through
    // two entirely separate code paths, so agreement is a real claim. No page
    // numbers: the canvas is one continuous page card with no pages to number,
    // and it gets that for free because Chromium rejects target-counter --
    // which is only true if nothing else in the app is quietly filling it in.
    const marker = await openInSplitMode(TOC_FIXTURE, 'canvas')
    const preview = await pollPreview(marker)

    const canvas = await win.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('.milkdown-mount .pagedown-toc a'))
      return {
        entries: anchors.map((a) => a.textContent ?? ''),
        after: anchors[0] ? window.getComputedStyle(anchors[0], '::after').content : ''
      }
    })

    console.log(`Gate 40 canvas TOC: ${JSON.stringify(canvas)}`)

    expect(canvas.entries).toEqual(preview.tocEntries)
    // `none`, not `normal`. Per CSS Content Level 3 the initial value of
    // `content` is `normal`, and on a ::before/::after pseudo-element `normal`
    // COMPUTES TO `none` -- so `none` is exactly what a rejected declaration
    // looks like from getComputedStyle, and it is what Chromium really
    // reports here (this assertion originally said `normal` and was written
    // from the spec's initial value rather than from a measurement).
    //
    // Asserted two ways rather than one, because the thing that must be true
    // is "no page number is painted", and a single equality against one
    // sentinel string would also pass if some future rule set `content: none`
    // for an unrelated reason while another painted a number elsewhere. So:
    // no generated box at all, AND nothing digit-shaped in the value.
    expect(canvas.after, 'the editing canvas must not generate an ::after box').toBe('none')
    expect(canvas.after, 'the editing canvas must not paint a page number').not.toMatch(/\d/)
  })
})

const IMAGE_FIXTURE = [
  '# __MARKER__',
  '',
  '---',
  '',
  `![Sized](${PNG_1X1}){width=50%}`,
  '',
  `![Plain](${PNG_1X1})`,
  ''
].join('\n')

test.describe('Gate 40: image sizing', () => {
  test('a {width=50%} image really paints at half the content width, on both surfaces', async () => {
    const marker = await openInSplitMode(IMAGE_FIXTURE, 'image')
    const preview = await pollPreview(marker)

    console.log(
      `Gate 40 preview widths: sized=${preview.sizedImageWidth} plain=${preview.plainImageWidth} ruler=${preview.rulerWidth}`
    )

    expect(preview.rulerWidth, 'the <hr> ruler must be the full content width').toBeCloseTo(
      CONTENT_WIDTH_PX,
      0
    )
    expect(
      preview.sizedImageWidth,
      'the sized image must paint at half the content width on the paginated surface'
    ).toBeCloseTo(HALF_CONTENT_WIDTH_PX, 0)
    // The control: a 1x1 PNG with no size block stays 1px. Without it, a bug
    // that stretched EVERY image to the content width would still satisfy the
    // assertion above at some window sizes.
    expect(preview.plainImageWidth, 'an unsized image must keep its intrinsic width').toBeLessThan(
      10
    )

    // Now the editing canvas, in FORMAT mode -- not Split, whose left pane
    // applies a fit-to-width CSS `zoom` that would scale every measurement
    // (see CLAUDE.md's Split-mode fit-to-width section). Format mode's canvas
    // is the surface Gate 10 pins at 0.000px against the paginator.
    await win.getByRole('button', { name: 'Format', exact: true }).click()
    await win.waitForSelector('.milkdown-mount .ProseMirror')

    const canvas = await win.evaluate(() => {
      const width = (selector: string): number | null => {
        const element = document.querySelector(selector)
        return element ? element.getBoundingClientRect().width : null
      }
      return {
        sized: width('.milkdown-mount img[width]'),
        plain: width('.milkdown-mount img:not([width])'),
        ruler: width('.milkdown-mount hr')
      }
    })

    console.log(`Gate 40 canvas widths: ${JSON.stringify(canvas)}`)

    expect(canvas.ruler).toBeCloseTo(CONTENT_WIDTH_PX, 0)
    expect(
      canvas.sized,
      'the editor canvas must paint the sized image at the SAME width as the paginator'
    ).toBeCloseTo(preview.sizedImageWidth!, 0)
    expect(canvas.plain).toBeLessThan(10)
  })
})
