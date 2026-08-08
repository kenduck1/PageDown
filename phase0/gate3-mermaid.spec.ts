import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { markdownToHtml } from '../src/markdown/pipeline'
import { launchIsolatedApp } from './electron-launch'
// The shared DEFAULT (no-frontmatter, Letter/portrait/1in) geometry every
// harness-driving gate paginates at -- see gate-geometry.ts for why it's one
// shared constant, and why it has to be threaded through app.evaluate()'s
// own single argument rather than referenced from inside the callback.
import { LETTER_GEOMETRY } from './gate-geometry'

// Same two mechanical deviations from the brief's literal sample as every
// other Phase 0 gate spec (see gate1/gate5/gate7's own comments for the
// full reasoning, confirmed empirically in Task 3/Gate 5, not re-derived
// here): `__dirname` (not `import.meta.url`) for corpus paths, since this
// file transpiles to CommonJS; and the `globalThis.__pagedownPhase0` bridge
// (not a dynamic `import()` inside `app.evaluate()`), since that callback
// runs in a bare V8 context with no working dynamic import.
// `markdownToHtml`, like gate1/gate7, IS reached via a plain top-level Node
// import here — it runs in this file's own Node/Playwright process, not
// inside `app.evaluate()`.

interface DiagramBox {
  id: string
  width: number
  height: number
}

interface SendDocumentResult {
  pageCount: number
  ready: boolean
  layoutMs: number
  diagramBoxes: DiagramBox[]
}

test('Gate 3: Mermaid diagrams render with non-zero, deterministic size in the WebContentsView render context', async () => {
  const { app, close } = await launchIsolatedApp(['.'])

  const markdown = readFileSync(join(__dirname, 'corpus', 'mermaid-diagrams.md'), 'utf8')
  const { html } = markdownToHtml(markdown)

  const result = (await app.evaluate(
    async ({ BaseWindow }, { html, geometry }) => {
      const { createPaginationHarness } = (
        globalThis as unknown as {
          __pagedownPhase0: {
            createPaginationHarness: (typeof import('../src/main/pagination-window'))['createPaginationHarness']
          }
        }
      ).__pagedownPhase0
      const win = new BaseWindow({ show: false })
      const harness = await createPaginationHarness(win)
      return harness.sendDocument(html, geometry)
    },
    { html, geometry: LETTER_GEOMETRY }
  )) as SendDocumentResult

  console.log(
    'Gate 3 result:',
    JSON.stringify(
      { pageCount: result.pageCount, ready: result.ready, diagramBoxes: result.diagramBoxes },
      null,
      2
    )
  )

  expect(result.ready).toBe(true)
  expect(result.pageCount).toBeGreaterThan(0)

  // The actual signal Gate 3 exists to produce: does ANY diagram-wrapper
  // instance report a zero-size box (the exact getBBox()/layout failure
  // mode the design doc flags)? Checked per-instance, with the offending id
  // in the failure message. NOT asserting `diagramBoxes.length === 3` here:
  // running this for real (see the findings doc / this task's report)
  // showed the corpus's oversized diagram gets split into multiple page
  // clones by Paged.js's own overflow handling (each a real,
  // independently-measured element in the final DOM) — so the honest
  // per-*diagram* count is the number of DISTINCT ids, checked below, not
  // the raw array length.
  for (const box of result.diagramBoxes) {
    expect(box.width, `diagram "${box.id}" reported zero width`).toBeGreaterThan(0)
    expect(box.height, `diagram "${box.id}" reported zero height`).toBeGreaterThan(0)
  }

  // The corpus fixture has exactly 3 fenced ```mermaid blocks (small
  // flowchart, sequence diagram, oversized flowchart) — pinned exactly
  // (not just `.length > 0`) on the SET of distinct ids, so a regression
  // that silently drops or duplicates a *diagram* (as opposed to a page
  // clone of one) from the replacement pass is actually caught.
  const distinctIds = [...new Set(result.diagramBoxes.map((b) => b.id))].sort()
  expect(distinctIds).toEqual(['pagedown-mermaid-0', 'pagedown-mermaid-1', 'pagedown-mermaid-2'])

  // The small flowchart (fits comfortably within the page content box) and
  // the sequence diagram (wider than the content box, so it's expected to
  // be clamped) must each appear as exactly ONE wrapper instance — i.e.
  // NOT split, unlike the oversized diagram (see the second test below).
  const smallCount = result.diagramBoxes.filter((b) => b.id === 'pagedown-mermaid-0').length
  const sequenceCount = result.diagramBoxes.filter((b) => b.id === 'pagedown-mermaid-1').length
  expect(smallCount).toBe(1)
  expect(sequenceCount).toBe(1)

  const small = result.diagramBoxes.find((b) => b.id === 'pagedown-mermaid-0')!
  const sequence = result.diagramBoxes.find((b) => b.id === 'pagedown-mermaid-1')!
  // Confirms the design doc's flagged "CSS auto-sizing inflates a small
  // diagram to fill the page content width" failure mode does NOT occur
  // here: the small flowchart's measured width must be its own natural
  // size, well under the page content box's width (624px at this harness's
  // Letter/1in-margin default — see `sequence`'s width below, which IS
  // exactly 624, confirming that's the real clamp boundary), not stretched
  // to fill it.
  console.log(
    'Gate 3 small flowchart box (must NOT be inflated to page width):',
    JSON.stringify(small)
  )
  expect(small.width).toBeLessThan(400)

  // The oversized diagram (corpus's third ```mermaid block, a 20-stage
  // vertical chain deliberately built to exceed one page) is
  // `pagedown-mermaid-2` — element ids are assigned by index within a
  // render pass, 0-based, in resources/pagination-render/index.ts's
  // renderMermaidDiagrams. Logged specifically per the brief ("log the
  // oversized diagram's fitted dimensions") — every page-clone instance
  // reports the SAME (real, un-clipped) size, since getBoundingClientRect()
  // measures the element's own box, not what an ancestor's page-boundary
  // overflow clipping visually hides.
  const oversizedInstances = result.diagramBoxes.filter((b) => b.id === 'pagedown-mermaid-2')
  console.log(
    'Gate 3 oversized diagram fitted dimensions (per page-clone instance):',
    JSON.stringify(oversizedInstances)
  )
  expect(sequence.width).toBe(624)

  await close()
})

test('Gate 3: oversized-diagram page-break behavior is deterministic, and CSP still blocks script injection alongside Mermaid styling', async () => {
  const { app, close } = await launchIsolatedApp(['.'])

  const markdown = readFileSync(join(__dirname, 'corpus', 'mermaid-diagrams.md'), 'utf8')
  const { html } = markdownToHtml(markdown)

  const result = await app.evaluate(
    async ({ BaseWindow }, { html, geometry }) => {
      const { createPaginationHarness } = (
        globalThis as unknown as {
          __pagedownPhase0: {
            createPaginationHarness: (typeof import('../src/main/pagination-window'))['createPaginationHarness']
          }
        }
      ).__pagedownPhase0
      const win = new BaseWindow({ show: false })
      const harness = await createPaginationHarness(win)

      const consoleMessages: string[] = []
      harness.view.webContents.on('console-message', (event) => {
        consoleMessages.push(event.message)
      })

      const sendResult = await harness.sendDocument(html, geometry)

      // Structural "did it split across pages" check: counts how many
      // elements carry the oversized diagram's data-mermaid-diagram-id in the
      // final paginated output. `break-inside: avoid-page` is applied to this
      // wrapper (see ensureMermaidPageBreakStyleInjected in
      // resources/pagination-render/index.ts), but — measured for real here,
      // not assumed — Paged.js does NOT honor it when the block's own content
      // is taller than a full page: instead of moving the whole figure to one
      // fresh page and letting it overflow, the chunker falls back to its
      // normal overflow-splitting behavior, which clones the wrapper into
      // each page it spans and relies on the page container's own overflow
      // clipping to show only the relevant vertical band per page (the same
      // mechanism Paged.js uses to split an ordinary long paragraph or image
      // across pages — it has no special case for "unbreakable" content that
      // is simply too tall). This matches the design doc's own caveat that
      // Paged.js's break-inside handling is "incompletely implemented" and
      // explicitly flagged for validation, not an assumption this test makes
      // on its own — see this task's report/findings-doc entry for the full
      // writeup.
      const oversizedWrapperCount = await harness.view.webContents.executeJavaScript(
        `document.querySelectorAll('[data-mermaid-diagram-id="pagedown-mermaid-2"]').length`
      )

      // A real, grounded comparison for "does it overflow past its own
      // page's usable content height": the oversized diagram's own measured
      // height against an ACTUAL rendered `.pagedjs_page` element's height in
      // the same document (not an assumed/guessed page size).
      const pageMetrics = await harness.view.webContents.executeJavaScript(`
      (() => {
        const page = document.querySelector('.pagedjs_page')
        const rect = page ? page.getBoundingClientRect() : null
        return { pageCount: document.querySelectorAll('.pagedjs_page').length, pageHeight: rect ? rect.height : null }
      })()
    `)

      // Direct proof the CSP-nonce reattachment fix actually took effect —
      // not just "no violation was logged" (checked below via console
      // messages) but that every Mermaid-generated <style> element inside a
      // diagram wrapper genuinely carries this page-load's real nonce value,
      // read the same way resources/pagination-render/index.ts's own
      // bootstrap shim reads it. Also checks the SECOND CSP problem found by
      // actually running this gate (not anticipated by the design doc, which
      // only discusses the <style> BLOCK): Mermaid's SVG output also carries
      // many individual inline `style="..."` ATTRIBUTES on shape/marker
      // elements, which CSP blocks outright (no nonce mechanism applies to
      // attributes) — resources/pagination-render/index.ts's
      // hoistInlineStyleAttributes moves these into the same nonced
      // stylesheet, so `styleAttrCount` here (elements with a lingering
      // `style=""` anywhere inside a rendered diagram) must be exactly 0, and
      // the hoisted rules must be genuinely ACTIVE (not just present as inert
      // text) — checked via the CSSOM (`sheet.cssRules`), which is empty/null
      // for a <style> element CSP actually blocked, not just inspecting the
      // source text.
      const nonceCheck = await harness.view.webContents.executeJavaScript(`
      (() => {
        const meta = document.querySelector('meta[name="csp-style-nonce"]')
        const nonce = meta ? meta.getAttribute('content') : null
        const styles = Array.from(document.querySelectorAll('.pagedown-mermaid-diagram style'))
        const styleAttrCount = document.querySelectorAll('.pagedown-mermaid-diagram [style]').length
        const hoistedRuleCounts = styles.map((s) => {
          const sheet = s.sheet
          if (!sheet) return 0
          try {
            return Array.from(sheet.cssRules).filter((r) => r.selectorText && r.selectorText.startsWith('.pd-hoisted-style-')).length
          } catch {
            return -1 // access threw -- treat as "not verifiable" rather than silently 0
          }
        })
        return {
          nonce,
          styleCount: styles.length,
          styleNonces: styles.map((s) => s.nonce),
          styleAttrCount,
          hoistedRuleCounts
        }
      })()
    `)

      // Negative control, alongside the diagram content above (not in a
      // separate harness): CSP must still block a genuine inline-script
      // injection attempt after the render context has been through the new
      // Mermaid/document.createElement-heavy code path. Same payload shape as
      // Gate 5's own script-injection regression test (an onerror attribute,
      // not a <script> tag — <script> inserted via innerHTML never executes
      // at all, CSP or no CSP, so it would pass vacuously).
      //
      // `consoleMessagesBeforeInjection` snapshots the count HERE, immediately
      // before sending the payload — not asserted against directly, but read
      // below to isolate violations caused BY the injection specifically.
      // Asserting "some violation was logged" against the FULL message list
      // (Gate 5's own check) would be vacuous here in a way it isn't there:
      // Mermaid's own internal rendering above already logs ~970 style-src
      // violations of its own (see the findings-doc/report writeup), so
      // `consoleMessages.length > 0` would trivially pass regardless of
      // whether the injection attempt produced its own violation at all —
      // exactly the kind of "test that can't fail" shape Gate 5's own review
      // history already flagged once. Snapshotting first and diffing after
      // keeps this check genuinely tied to the injection, not to noise
      // already present from an unrelated part of this same render pass.
      const consoleMessagesBeforeInjection = consoleMessages.length
      await harness.sendDocument(
        '<img src="this-file-does-not-exist.png" onerror="window.__pwned = true">',
        geometry
      )
      await new Promise((resolve) => setTimeout(resolve, 500))
      const pwned = await harness.view.webContents.executeJavaScript(`typeof (window).__pwned`)
      const injectionViolationCount = consoleMessages
        .slice(consoleMessagesBeforeInjection)
        .filter((m) => /content security policy|refused to/i.test(m)).length

      return {
        sendResult,
        consoleMessages,
        oversizedWrapperCount,
        pageMetrics,
        nonceCheck,
        pwned,
        injectionViolationCount
      }
    },
    { html, geometry: LETTER_GEOMETRY }
  )

  console.log('Gate 3 page metrics:', JSON.stringify(result.pageMetrics))
  console.log('Gate 3 mermaid style nonce check:', JSON.stringify(result.nonceCheck))

  // Measured (across repeated runs — see this task's report) at exactly 3
  // page-clone instances for this fixture's oversized diagram at the time
  // this gate was written, every time — i.e. the split itself IS
  // deterministic, even though it is a split (break-inside: avoid-page does
  // not prevent it). Pinned to the actual observed value, not a loose
  // `> 1`, so a change in this number (e.g. from a future page-size/margin
  // change) is visible here rather than silently drifting.
  //
  // Updated to 4 by Task 10 (Gate 6) — a real, expected, and correctly
  // understood shift, not a silent drift papered over: Task 10's
  // `KeepWithNextHandler` (src/pagination/break-handlers.ts) fixes this
  // exact fixture's "# Oversized Diagram" H1 being stranded alone at the
  // bottom of a page (measured directly, both before and after: without
  // the handler, the heading sat at the end of one page while the diagram
  // itself started fresh on the next; with it, the heading now correctly
  // starts the SAME page as the diagram's first page-clone). Pulling the
  // heading down by one page's worth of a few lines shifts where the
  // diagram's own overflow-based page-splitting boundaries land for the
  // rest of its (independently oversized, break-inside-avoid-page-not-
  // withstanding) content — one more page-clone instance is needed to fit
  // the same diagram content once the heading occupies space at the top of
  // its starting page. This is the expected, correct cost of not stranding
  // the heading, not a regression in this gate's own diagram-splitting
  // finding above, which is otherwise unchanged (still a real split, still
  // not honoring break-inside: avoid-page for oversized content).
  expect(result.oversizedWrapperCount).toBe(4)

  const oversizedBoxes = result.sendResult.diagramBoxes.filter(
    (b: DiagramBox) => b.id === 'pagedown-mermaid-2'
  )
  // Every clone instance reports the SAME real, un-clipped height (see the
  // comment above oversizedWrapperCount) — confirmed here rather than
  // assumed, and compared against a real measured page height so the
  // "genuinely taller than one page" claim is grounded in an actual number
  // from this run, not the corpus fixture's own stated intent.
  const oversizedHeights = [...new Set(oversizedBoxes.map((b: DiagramBox) => b.height))]
  console.log(
    'Gate 3 oversized diagram vs. one page height:',
    JSON.stringify({
      distinctHeightsAcrossClones: oversizedHeights,
      pageHeight: result.pageMetrics.pageHeight
    })
  )
  expect(oversizedHeights.length).toBe(1) // all clones agree on the diagram's own real size
  expect(oversizedHeights[0]).toBeGreaterThan(result.pageMetrics.pageHeight) // genuinely taller than one page, not an artifact

  // CSP-positive case, part 1 (the <style> BLOCK): Mermaid's own internal
  // <style> block (created via document.createElement inside mermaid.render,
  // then stripped of its nonce by Mermaid's own DOMPurify.sanitize() pass
  // under securityLevel:'strict', then re-created via reattachNoncedStyles —
  // see resources/pagination-render/index.ts) must carry a real, matching
  // nonce.
  expect(result.nonceCheck.nonce).toBeTruthy()
  // Not literally "one <style> per diagram, per mermaid.render()" despite
  // the comment this replaced — only ONE of the oversized diagram's 3 (now
  // 4, see the oversizedWrapperCount comment above) page-clone instances
  // happens to retain its own <style> block across Paged.js's
  // overflow-splitting (Range.extractContents()); the other clones lose it
  // the same way Task 9/Gate 4 found they lose <rect>/<text> content on
  // split. Measured at 3 (small=1 + sequence=1 + oversized=1-of-3) before
  // Task 10's KeepWithNextHandler shifted the oversized diagram's own split
  // boundaries (see oversizedWrapperCount above): with the heading now
  // pulled onto the diagram's starting page, a SECOND of the oversized
  // diagram's 4 clones also happens to retain its <style> block post-split
  // (small=1 + sequence=1 + oversized=2-of-4 = 4) — visible directly in
  // `hoistedRuleCounts` below, which now has two `46`s instead of one.
  // This is the same content-loss-on-split behavior Gate 4 already
  // documents, landing on a different clone once the split boundary moved;
  // not a new bug, and not something this gate's own CSP/nonce assertions
  // depend on being any particular count beyond "every retained <style>
  // carries a real, matching nonce" (checked below, unconditionally).
  expect(result.nonceCheck.styleCount).toBe(4)
  for (const styleNonce of result.nonceCheck.styleNonces) {
    expect(styleNonce).toBe(result.nonceCheck.nonce)
  }

  // CSP-positive case, part 2 (the inline style ATTRIBUTE problem found by
  // actually running this gate): the FINAL, displayed diagrams must carry
  // zero lingering `style=""` attributes (there is no nonce mechanism for
  // attributes at all, so this can only be satisfied by hoisting them away,
  // never by "fixing" the nonce), and the hoisted rules must be genuinely
  // ACTIVE — not just present as inert, CSP-blocked text — proving Mermaid's
  // legitimate styling actually still applies in what a user would see.
  expect(result.nonceCheck.styleAttrCount).toBe(0)
  for (const ruleCount of result.nonceCheck.hoistedRuleCounts) {
    expect(ruleCount).toBeGreaterThan(0)
  }

  // What this does NOT and cannot assert: zero CSP console violations
  // overall. Measured directly (see this task's report): rendering this
  // 3-diagram corpus logs exactly 972 "Applying inline style violates..."
  // violations, reproducibly (not flaky/random — repeated runs against this
  // same corpus all log 972), entirely from Mermaid's OWN internal rendering
  // (d3 painting temporary elements it appends live to this page's real
  // document.body — see mermaidAPI.render() in
  // node_modules/mermaid/dist/mermaid.core.mjs) — these fire and are gone
  // before renderMermaidToSvg even returns a string, so no amount of
  // post-processing the returned SVG can prevent them; only loosening this
  // app's style-src (unacceptable — it's the exact protection the design
  // doc's SiYuan reference exists to keep) would. Logged here for
  // visibility, not gated on an exact-equality assertion, since pinning 972
  // would be pinning a Mermaid-internal implementation detail this app has
  // no control over (a Mermaid version bump could change it for reasons
  // having nothing to do with this app's own correctness).
  const cspViolations = result.consoleMessages.filter((m: string) =>
    /content security policy|refused to/i.test(m)
  )
  console.log(
    'Gate 3 total CSP console violations this run (expected: Mermaid-internal style-src noise, not zero):',
    cspViolations.length
  )

  // CSP-negative case: a genuine injection attempt, sent on the SAME
  // harness right after the Mermaid render, must still be blocked — both
  // that the payload never executed (the actual security-relevant
  // assertion) AND that a real, attributable CSP violation was logged FOR
  // IT specifically (isolated from Mermaid's own unrelated noise above via
  // the before/after snapshot — see the comment where
  // injectionViolationCount is computed). Checking both closes exactly the
  // "assertion could never fail" shape Gate 5's own review history already
  // found once in this app's CSP tests: a version of this test that only
  // checked `pwned` would still pass if CSP enforcement broke in a way that
  // stopped the specific onerror execution by some other accident (e.g. the
  // image request itself failing before onerror could even fire) without
  // CSP actually being the thing that blocked it.
  expect(result.pwned).toBe('undefined')
  expect(result.injectionViolationCount).toBeGreaterThan(0)

  // Committed machine-readable result, matching gate2/gate7's own pattern
  // (phase0/results/gate2-timing.json, phase0/results/gate7-findings.json)
  // rather than leaving these numbers to live only in prose in the findings
  // doc and this test's console.log output.
  mkdirSync(join(__dirname, 'results'), { recursive: true })
  writeFileSync(
    join(__dirname, 'results', 'gate3-mermaid-findings.json'),
    JSON.stringify(
      {
        diagramBoxes: result.sendResult.diagramBoxes,
        oversizedWrapperCount: result.oversizedWrapperCount,
        oversizedHeights,
        pageHeight: result.pageMetrics.pageHeight,
        pageCount: result.pageMetrics.pageCount,
        nonceCheck: result.nonceCheck,
        totalCspViolations: cspViolations.length,
        injectionViolationCount: result.injectionViolationCount,
        pwned: result.pwned
      },
      null,
      2
    )
  )

  await close()
})
