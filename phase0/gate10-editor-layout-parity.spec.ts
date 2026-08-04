import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { markdownToHtml } from '../src/markdown/pipeline'
import { REPORT_TEMPLATE } from '../src/renderer/src/templates/report.md'

// Phase 1 Gate 3 (docs/superpowers/plans/2026-07-28-phase1-findings.md)
// measured editor/pagination layout parity against a throwaway
// chromium.launch() + local-HTML-fixture harness, because Milkdown wasn't
// mounted in the real app yet -- it now is (the Editor Canvas sub-project).
// This gate re-measures the same class of comparison against the REAL,
// BUILT app on both sides: the same __pagedownPhase0 pagination-harness
// bridge Gate 3 used, and the real mounted EditorScreen (reached via real
// Home-screen UI interaction -- clicking the Report template card) instead
// of a throwaway fixture. Same 1px tolerance, same "matched top-level
// blocks, compare relative top position" methodology.
const TOLERANCE_PX = 1

interface BlockMeasurement {
  tag: string
  text: string
  relativeTop: number
}

// Same pattern as phase0/gate9-thumbnail-concurrency.spec.ts's own
// `getMainWindow` -- this app launches a SECOND window at startup (the
// Phase 0 spike's `createPaginationHarness(mainWindow)` wiring in
// src/main/index.ts), whose page loads under the sandboxed
// `pagedown-render://` custom scheme and has zero contextBridge/`window.api`
// access. `app.firstWindow()` races between the two and is not safe to use
// here. Matched by a POSITIVE `file://` check (not a negative
// "isn't pagedown-render://" exclusion) for the same reason documented in
// gate9: every window starts on `about:blank` before its real navigation
// completes, and a negative-only filter would misidentify an un-navigated
// sandboxed window as the app shell.
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

test('Gate 10: editor/paginator layout parity for the real mounted Milkdown canvas', async () => {
  // This is a deliberately-failing gate, not a red test to explain away:
  // the design doc's Testing section recommends "belongs in phase1/ if it's
  // framed as completing Gate 3's finding" since phase0/ is meant to be a
  // suite that fully passes end-to-end. Relocating the file this late was
  // judged a real (if small) config-compatibility risk, so instead this
  // uses Playwright's own mechanism for an intentionally-failing test:
  // test.fail() flips the suite's own accounting -- the run reports GREEN
  // as long as this test keeps failing, and loudly reports a NEW failure if
  // the underlying finding is ever fixed (i.e. if this starts *passing*
  // unexpectedly). See CLAUDE.md's "Milkdown/ProseMirror" section and
  // docs/superpowers/plans/2026-08-04-overnight-decisions-log.md for the
  // full root-cause writeup (two unrelated typographic systems: the
  // sandboxed pagination context has zero author CSS, the Milkdown mount
  // inherits the app shell's Tailwind Preflight reset).
  test.fail()

  test.setTimeout(60_000)

  const app = await electron.launch({ args: ['out/main/index.js'] })

  // --- Pagination side: real harness, same document -----------------------
  // No type annotation on the destructured Electron-namespace param -- it's
  // inferred from ElectronApplication.evaluate()'s own signature, matching
  // phase1/gate3-layout-parity.spec.ts's identical, already-working pattern.
  // @playwright/test does not export Electron's own `BaseWindow` type, so
  // importing one to annotate this would not resolve.
  await app.evaluate(async ({ BaseWindow }) => {
    const bridge = (
      globalThis as unknown as {
        __pagedownPhase0: {
          createPaginationHarness: typeof import('../src/main/pagination-window').createPaginationHarness
        }
      }
    ).__pagedownPhase0
    const win = new BaseWindow({ show: false })
    ;(globalThis as unknown as { __gate10Harness: unknown }).__gate10Harness =
      await bridge.createPaginationHarness(win)
    return true
  })

  const { html } = markdownToHtml(REPORT_TEMPLATE)

  const paginationResult = (await app.evaluate(async (_electronNS, html) => {
    const harness = (
      globalThis as unknown as {
        __gate10Harness: import('../src/main/pagination-window').PaginationHarness
      }
    ).__gate10Harness
    const sendResult = await harness.sendDocument(html)

    const raw = (await harness.view.webContents.executeJavaScript(`
      (function () {
        var area = document.querySelector('.pagedjs_area')
        if (!area) return JSON.stringify({ error: 'no .pagedjs_area found' })
        var areaTop = area.getBoundingClientRect().top
        var blocks = Array.prototype.slice.call(area.querySelectorAll(':scope > .pagedjs_page_content > div > *'))
        var out = blocks.map(function (el) {
          var r = el.getBoundingClientRect()
          return { tag: el.tagName, text: String(el.textContent || '').trim().slice(0, 50), relativeTop: r.top - areaTop }
        })
        return JSON.stringify(out)
      })()
    `)) as string

    return { sendResult, blocks: JSON.parse(raw) as BlockMeasurement[] }
  }, html)) as { sendResult: { pageCount: number }; blocks: BlockMeasurement[] }

  expect(
    paginationResult.sendResult.pageCount,
    'REPORT_TEMPLATE is expected to fit on a single page at Letter/1in-margin geometry'
  ).toBe(1)

  // --- Milkdown side: the REAL app, real UI interaction --------------------
  const win = await getMainWindow(app)
  await win.waitForFunction(() => (window as unknown as { api?: unknown }).api !== undefined)

  await win.getByRole('button', { name: /report/i }).click()

  const milkdownParsed = await win.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (document.querySelector('.milkdown-mount .ProseMirror')) resolve()
        else requestAnimationFrame(check)
      }
      check()
    })
    // Two animation-frame ticks after mount is detected, matching every
    // other paint-dependent measurement in this codebase (thumbnail
    // capture, Phase 1 Gate 3) -- the mount being present in the DOM does
    // not guarantee its layout has settled to final values yet.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )

    const editorRoot = document.querySelector('.milkdown-mount .ProseMirror')
    if (!editorRoot) return { error: 'no .ProseMirror element found' }
    const rect = editorRoot.getBoundingClientRect()
    const blocks = Array.from(editorRoot.children).map((el) => {
      const r = el.getBoundingClientRect()
      return {
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 50),
        relativeTop: r.top - rect.top
      }
    })
    return { rootWidth: rect.width, blocks }
  })

  if ('error' in milkdownParsed) {
    throw new Error(milkdownParsed.error)
  }

  await app.close()

  // --- Per-block comparison -------------------------------------------------
  const rows = paginationResult.blocks.map((pagBlock, i) => {
    const mdBlock = milkdownParsed.blocks[i]
    const tagsMatch = mdBlock ? pagBlock.tag === mdBlock.tag : false
    const delta = mdBlock ? Math.abs(pagBlock.relativeTop - mdBlock.relativeTop) : null
    return {
      index: i,
      paginationTag: pagBlock.tag,
      paginationText: pagBlock.text,
      paginationTop: Number(pagBlock.relativeTop.toFixed(3)),
      milkdownTag: mdBlock?.tag ?? '(missing)',
      milkdownTop: mdBlock ? Number(mdBlock.relativeTop.toFixed(3)) : null,
      deltaPx: delta !== null ? Number(delta.toFixed(3)) : null,
      tagsMatch
    }
  })

  console.log(`\nGate 10 per-block layout comparison (tolerance: ${TOLERANCE_PX}px):`)
  console.table(rows)

  expect(
    milkdownParsed.blocks.length,
    'expected the same top-level block count on both sides'
  ).toBe(paginationResult.blocks.length)

  for (const row of rows) {
    expect(row.tagsMatch, `block ${row.index}: tag mismatch`).toBe(true)
  }

  for (const row of rows) {
    expect(
      row.deltaPx,
      `block ${row.index} (${row.paginationTag} "${row.paginationText}"): pagination top=${row.paginationTop}px, milkdown top=${row.milkdownTop}px`
    ).toBeLessThanOrEqual(TOLERANCE_PX)
  }
})
