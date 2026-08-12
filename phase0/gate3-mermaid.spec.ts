import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { markdownToHtml } from '../src/markdown/pipeline'
import { launchIsolatedApp } from './electron-launch'
// The shared DEFAULT (no-frontmatter, Letter/portrait/1in) geometry every
// harness-driving gate paginates at, plus the shared default DocumentStyle
// sendDocument now also requires -- see gate-geometry.ts for why they're one
// shared pair, and why they have to be threaded through app.evaluate()'s
// own single argument rather than referenced from inside the callback.
import { LETTER_GEOMETRY, DEFAULT_STYLE } from './gate-geometry'

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

// Must match src/diagrams/render-mermaid.ts's MERMAID_LABEL_FONT_FAMILY.
// Deliberately restated as a literal here rather than imported from that
// module, and this is the one place in this file where duplication is the
// point: an expectation computed by the code under test moves with that
// code's bugs, so `fontFamily: <whatever the module says>` would keep
// passing if someone reverted the pin to a font that does not exist. Same
// hand-derived-literal rule gate16-page-geometry.spec.ts states for its own
// page dimensions.
const MERMAID_LABEL_FONT_FAMILY = 'Inter Variable'
const MERMAID_LABEL_FONT_SPEC = `16px "${MERMAID_LABEL_FONT_FAMILY}"`

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

  try {
    const markdown = readFileSync(join(__dirname, 'corpus', 'mermaid-diagrams.md'), 'utf8')
    const { html } = markdownToHtml(markdown)

    const result = (await app.evaluate(
      async ({ BaseWindow }, { html, geometry, documentStyle }) => {
        const { createPaginationHarness } = (
          globalThis as unknown as {
            __pagedownPhase0: {
              createPaginationHarness: (typeof import('../src/main/pagination-window'))['createPaginationHarness']
            }
          }
        ).__pagedownPhase0
        const win = new BaseWindow({ show: false })
        const harness = await createPaginationHarness(win)
        return harness.sendDocument(html, geometry, documentStyle)
      },
      { html, geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
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
  } finally {
    await close()
  }
})

test('Gate 3: oversized-diagram page-break behavior is deterministic, and CSP still blocks script injection alongside Mermaid styling', async () => {
  const { app, close } = await launchIsolatedApp(['.'])

  try {
    const markdown = readFileSync(join(__dirname, 'corpus', 'mermaid-diagrams.md'), 'utf8')
    const { html } = markdownToHtml(markdown)

    const result = await app.evaluate(
      async ({ BaseWindow }, { html, geometry, documentStyle }) => {
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

        const sendResult = await harness.sendDocument(html, geometry, documentStyle)

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

        const fitProbe = await harness.view.webContents.executeJavaScript(`
        (() => {
          const wrappers = Array.from(document.querySelectorAll('[data-mermaid-diagram-id="pagedown-mermaid-2"]'))
          const area = document.querySelector('.pagedjs_area')
          return {
            areaHeight: area ? area.getBoundingClientRect().height : null,
            wrappers: wrappers.map((w) => {
              const svg = w.querySelector('svg')
              const wr = w.getBoundingClientRect()
              const page = w.closest('.pagedjs_page')
              const pa = page ? page.querySelector('.pagedjs_area') : null
              const par = pa ? pa.getBoundingClientRect() : null
              const cs = getComputedStyle(w)
              return {
                fittedScaleAttr: w.getAttribute('data-mermaid-fitted-scale'),
                dataBreakInside: w.getAttribute('data-break-inside'),
                computedBreakInside: cs.breakInside,
                wrapperH: wr.height,
                topWithinArea: par ? wr.top - par.top : null,
                svgHeightAttr: svg ? svg.getAttribute('height') : null,
                svgBoxH: svg ? svg.getBoundingClientRect().height : null,
                note: (w.querySelector('.pagedown-mermaid-scaled-note') || {}).textContent || null,
                rects: w.querySelectorAll('rect').length,
                texts: w.querySelectorAll('text').length,
                pageIndex: page ? Array.from(document.querySelectorAll('.pagedjs_page')).indexOf(page) : null,
                pageText: pa ? (pa.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : null
              }
            })
          }
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
          consoleMessages,
          oversizedWrapperCount,
          pageMetrics,
          fitProbe,
          nonceCheck,
          pwned,
          injectionViolationCount
        }
      },
      { html, geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
    )

    console.log('Gate 3 page metrics:', JSON.stringify(result.pageMetrics))
    console.log('Gate 3 FIT PROBE:', JSON.stringify(result.fitProbe, null, 2))
    console.log('Gate 3 mermaid style nonce check:', JSON.stringify(result.nonceCheck))

    // OVERSIZED-DIAGRAM POLICY. This block used to pin the SPLIT: 3
    // page-clone instances, then 4 after Task 10's KeepWithNextHandler moved
    // the boundaries. Both numbers were real, and pinning them was right at
    // the time — but what they pinned was a BUG, and the design doc says so
    // in terms: "the split diagram loses its own rendered content ... an
    // oversized Mermaid diagram is currently unusable if it's allowed to
    // split", filed as "a required V1 fix, not a documented-and-deferred edge
    // case".
    //
    // Measured directly here before changing anything, by counting what
    // actually survived in each of the 4 clones:
    //
    //     clone 0: 0 <rect>, 0 <text>, 0 <path>
    //     clone 1: 0 <rect>, 0 <text>, 13 <path>
    //     clone 2: 0 <rect>, 0 <text>, 0 <path>
    //     clone 3: 0 <rect>, 0 <text>, 9 <path>
    //
    // Every node box and every label of a 20-node flowchart was gone: four
    // pages of near-blank paper carrying 22 stray edges. `break-inside:
    // avoid-page` cannot save it, because Paged.js only honours that for
    // content that COULD fit a page and falls back to ordinary
    // overflow-splitting otherwise.
    //
    // resources/pagination-render/index.ts's fitSvgToPageBox now scales a
    // too-tall diagram to the page content box (design:97's own prescribed
    // mechanism), so the split path never runs. ONE wrapper, not four, and it
    // holds the whole diagram — asserted structurally below rather than taken
    // on trust, since a correctly-sized box that is visually empty is exactly
    // the failure this gate previously could not see.
    expect(result.oversizedWrapperCount).toBe(1)

    const fitted = result.fitProbe.wrappers[0]
    console.log('Gate 3 fitted oversized diagram:', JSON.stringify(fitted))

    // The content is really there. 60 <rect> and 20 <text> for a 20-stage
    // chain; the old split produced 0 and 0. This is the assertion the whole
    // policy exists for, and it is deliberately a structural census rather
    // than a bounding box.
    expect(fitted.rects).toBeGreaterThan(0)
    expect(fitted.texts).toBeGreaterThan(0)

    // ...and it genuinely fits its page, rather than being clipped by the
    // page container's overflow while reporting a healthy box.
    expect(fitted.wrapperH).toBeLessThanOrEqual(result.fitProbe.areaHeight)

    // design:97's legibility floor fired for this fixture (0.39 < 0.5), so
    // the affordance must be present and must name the real scale rather
    // than silently rendering a diagram nobody can read.
    expect(fitted.fittedScaleAttr).toBeTruthy()
    expect(Number(fitted.fittedScaleAttr)).toBeLessThan(0.5)
    expect(fitted.note).toContain('scaled to')
    expect(fitted.note).toContain('%')

    const oversizedBoxes = result.sendResult.diagramBoxes.filter(
      (b: DiagramBox) => b.id === 'pagedown-mermaid-2'
    )
    const oversizedHeights = [...new Set(oversizedBoxes.map((b: DiagramBox) => b.height))]
    console.log(
      'Gate 3 oversized diagram vs. one page height:',
      JSON.stringify({
        distinctHeightsAcrossClones: oversizedHeights,
        pageHeight: result.pageMetrics.pageHeight
      })
    )
    expect(oversizedHeights.length).toBe(1)
    // Inverted on purpose, and this is the single clearest statement of what
    // changed: this diagram used to measure TALLER than a whole page (1956px
    // against an 864px content box) and be sliced apart for it. It is now
    // shorter than the content box it had to fit into.
    expect(oversizedHeights[0]).toBeLessThan(result.fitProbe.areaHeight)

    // CSP-positive case, part 1 (the <style> BLOCK): Mermaid's own internal
    // <style> block (created via document.createElement inside mermaid.render,
    // then stripped of its nonce by Mermaid's own DOMPurify.sanitize() pass
    // under securityLevel:'strict', then re-created via reattachNoncedStyles —
    // see resources/pagination-render/index.ts) must carry a real, matching
    // nonce.
    expect(result.nonceCheck.nonce).toBeTruthy()
    // Now literally one <style> per diagram — small + sequence + oversized —
    // and that is a direct consequence of the oversized-diagram fit above.
    // This used to be 4, with a long comment explaining that the number was
    // an accident of WHERE the split landed: only some of the oversized
    // diagram's page-clones happened to retain their own <style> block across
    // Paged.js's `Range.extractContents()`, the same mechanism that was
    // losing the <rect>/<text> content. It was 3 before Task 10 moved the
    // split boundary and 4 after. With the diagram no longer split at all,
    // the count is 3 BY CONSTRUCTION rather than by coincidence — a strictly
    // better assertion than either previous value.
    expect(result.nonceCheck.styleCount).toBe(3)
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
  } finally {
    await close()
  }
})

// The design doc's Mermaid section requires pinning "a bundled OFL font in
// Mermaid's fontFamily config (Mermaid's default font stack -- Trebuchet MS,
// Verdana, Arial -- isn't bundled by Chromium, so diagram sizing would
// otherwise depend on what's installed on the machine, undercutting the
// determinism argument used to choose Electron over Tauri)" and an
// "await document.fonts.load(...) for that font before calling
// mermaid.render()". Neither existed: the pinned family was the string
// 'PageDownSans', which named no font file anywhere in this repo, and
// document.fonts.load was never called at all. Mermaid measured every label
// against a host-installed fallback, so node box sizes -- and therefore the
// page counts of any document containing a diagram -- varied by machine.
//
// This test is the regression gate for both halves, and it deliberately
// checks the two things a unit test structurally cannot. Whether a font is
// LOADED is a property of a live FontFaceSet in a real Chromium renderer,
// and whether it is APPLIED is a property of real computed style over real
// SVG produced by the real Mermaid build -- neither exists under jsdom, and
// neither can be inferred from "renderMermaidToSvg returned a well-formed
// SVG", which it does identically whether the label font resolved to Inter
// Variable or to whatever the host had lying around. Probing via
// app.evaluate + harness.view.webContents.executeJavaScript follows Gate
// 19/26's own template for reaching into the sandboxed WebContentsView.
//
// The diagram-free negative control at the start is not padding. The face
// must be registered CONDITIONALLY -- Paged.js's Chunker.flow() awaits
// loadFonts(), which loads every FontFace registered in document.fonts
// whether or not the page uses it, so an unconditionally-registered label
// font would charge every plain-prose document an awaited decode on every
// render. Asserting the face is genuinely ABSENT before any diagram has
// been rendered, on the same long-lived harness, is what makes that a
// tested invariant rather than a claim in a comment.
test('Gate 3: the Mermaid label font is a real bundled face, loaded before render and applied to labels, and costs diagram-free documents nothing', async () => {
  const { app, close } = await launchIsolatedApp(['.'])

  try {
    const markdown = readFileSync(join(__dirname, 'corpus', 'mermaid-diagrams.md'), 'utf8')
    const { html } = markdownToHtml(markdown)

    const result = await app.evaluate(
      async ({ BaseWindow }, { html, geometry, documentStyle, fontFamily, fontSpec }) => {
        const { createPaginationHarness } = (
          globalThis as unknown as {
            __pagedownPhase0: {
              createPaginationHarness: (typeof import('../src/main/pagination-window'))['createPaginationHarness']
            }
          }
        ).__pagedownPhase0
        const win = new BaseWindow({ show: false })
        const harness = await createPaginationHarness(win)

        // `faceStatuses` (derived by iterating the real FontFaceSet) is the
        // primary signal, not `check`, and the difference matters for the
        // negative control specifically: document.fonts.check() answers
        // "would rendering this font list have to wait for a web font",
        // so for a family with NO registered face it reports true (nothing
        // to wait for) -- the same true it reports for a fully loaded one.
        // Only the face list distinguishes "loaded" from "never existed",
        // which is exactly the distinction the original bug lived in.
        const probeLabelFont = (): Promise<{ check: boolean; faceStatuses: string[] }> =>
          harness.view.webContents.executeJavaScript(`
            (() => {
              const family = ${JSON.stringify(fontFamily)}
              const faces = Array.from(document.fonts).filter(
                (f) => f.family.replace(/^['"]|['"]$/g, '') === family
              )
              return {
                check: document.fonts.check(${JSON.stringify(fontSpec)}),
                faceStatuses: faces.map((f) => f.status)
              }
            })()
          `)

        // Negative control FIRST, on this same harness: a document with no
        // ```mermaid block at all must leave the label font unregistered.
        // DEFAULT_STYLE selects source-serif-4, so buildDocumentStylesheet
        // emits only that face -- nothing else in this render can pull Inter
        // Variable in behind the diagram path's back.
        await harness.sendDocument(
          '<p>A document with no diagrams at all.</p>',
          geometry,
          documentStyle
        )
        const beforeAnyDiagram = await probeLabelFont()

        await harness.sendDocument(html, geometry, documentStyle)
        const afterDiagrams = await probeLabelFont()

        // Scoped to pagedown-mermaid-0 (the small flowchart) on purpose:
        // it is the one diagram this fixture renders as exactly ONE
        // un-split wrapper that keeps its own Mermaid <style> block. The
        // oversized diagram is cloned across pages by Paged.js's overflow
        // splitting and some clones lose that block entirely (already
        // measured and documented by the styleCount assertion in the test
        // above), so their text would resolve to the inherited document
        // font through no fault of the font pin.
        const appliedFont = await harness.view.webContents.executeJavaScript(`
          (() => {
            const texts = Array.from(
              document.querySelectorAll('[data-mermaid-diagram-id="pagedown-mermaid-0"] svg text')
            )
            return {
              textCount: texts.length,
              resolvedFamilies: [...new Set(texts.map((t) => getComputedStyle(t).fontFamily))]
            }
          })()
        `)

        return { beforeAnyDiagram, afterDiagrams, appliedFont }
      },
      {
        html,
        geometry: LETTER_GEOMETRY,
        documentStyle: DEFAULT_STYLE,
        fontFamily: MERMAID_LABEL_FONT_FAMILY,
        fontSpec: MERMAID_LABEL_FONT_SPEC
      }
    )

    console.log('Gate 3 Mermaid label font:', JSON.stringify(result, null, 2))

    // Conditional registration: nothing at all before the first diagram.
    expect(
      result.beforeAnyDiagram.faceStatuses,
      'a diagram-free document must not register the Mermaid label font -- Chunker.loadFonts() would then decode it on every render'
    ).toEqual([])

    // Registered AND actually loaded once a diagram renders. `status` is
    // 'loaded' only after the bytes have been fetched and decoded, which is
    // what the explicit document.fonts.load() before mermaid.render() buys;
    // a face left to load lazily would still read 'unloaded' here.
    expect(result.afterDiagrams.faceStatuses.length).toBeGreaterThan(0)
    for (const status of result.afterDiagrams.faceStatuses) {
      expect(status).toBe('loaded')
    }
    expect(result.afterDiagrams.check).toBe(true)

    // Loaded is not the same as used. Mermaid writes its configured
    // fontFamily into the diagram's own <style> block as
    // --mermaid-font-family, so this is the assertion that the pin in
    // src/diagrams/render-mermaid.ts genuinely reaches the label glyphs
    // rather than merely making a font available for something else.
    expect(result.appliedFont.textCount).toBeGreaterThan(0)
    expect(result.appliedFont.resolvedFamilies.length).toBeGreaterThan(0)
    for (const family of result.appliedFont.resolvedFamilies) {
      expect(family, 'Mermaid label text must resolve to the bundled label font').toContain(
        MERMAID_LABEL_FONT_FAMILY
      )
    }
  } finally {
    await close()
  }
})

// design:97's content-addressed render cache, and the cross-document
// height-inheritance bug that keying retained sizes by POSITION caused.
//
// Two halves, in one run on ONE long-lived harness (which is what Split mode
// actually is), because each half is the other's anti-vacuity control:
//
//   1. THE CACHE IS REAL. Proven by CSP style-src violation count, not by a
//      timer and not by an instrumentation counter this app would otherwise
//      have no reason to expose. Mermaid's own internal d3 painting logs a
//      large, reproducible number of "Applying inline style violates..."
//      violations on every mermaid.render() call, and nothing else in a
//      render pass does (see resources/pagination-render/index.ts's DOMParser
//      comment for why they exist and are unavoidable) — so that count IS a
//      behavioural fingerprint of whether Mermaid ran. Measured against the
//      3-diagram corpus before the cache existed: two byte-identical sends
//      logged 970 violations EACH. A wall-clock assertion was rejected as the
//      primary signal because it is load-dependent and this suite's own
//      documented environmental flake lives on exactly that axis.
//
//   2. RETENTION STILL WORKS, AND ONLY WITHIN ONE DOCUMENT. design:107 wants
//      a broken diagram's placeholder to keep the last known-good height so
//      page counts don't thrash mid-typing. CLAUDE.md recorded the cost of
//      doing that positionally: "on a long-lived harness a broken diagram can
//      inherit the height of a DIFFERENT document's diagram that happened to
//      sit at the same index". Asserting only that retention works would pass
//      against the old buggy code; asserting only that cross-document
//      inheritance is gone would pass against code that simply deleted
//      retention. Both are asserted, against two documents whose diagram
//      heights are deliberately far apart so the two outcomes cannot be
//      confused for each other.
//
// The retained size is a min-height FLOOR on the placeholder, so a
// cross-document inheritance shows up as a placeholder inflated to the other
// document's diagram height — which is what the numbers below discriminate.
const TALL_DIAGRAM = `flowchart TD
  A[Alpha stage one] --> B[Alpha stage two]
  B --> C[Alpha stage three]
  C --> D[Alpha stage four]
  D --> E[Alpha stage five]
  E --> F[Alpha stage six]`

const SHORT_DIAGRAM = `flowchart TD
  X[Beta] --> Y[Gamma]`

// Document B's own half-typed edit of SHORT_DIAGRAM — an unterminated node
// label, the same shape as BROKEN_DIAGRAM further down. Declared separately
// rather than reusing that constant purely for ordering (it is defined below
// this test), and it should be a distinct string anyway: this is document B's
// content, not the other fixture's.
const SHORT_DIAGRAM_BROKEN = `flowchart TD
  X[Beta] --> Y[Gamma`

function singleDiagramDocument(heading: string, prose: string, diagram: string): string {
  return [`# ${heading}`, '', prose, '', '```mermaid', diagram, '```', ''].join('\n')
}

// DOC_A and DOC_B differ in every component of the slot scope
// (resources/pagination-render/index.ts's diagramSlotScope): different
// heading, different prose length, different anchor text. DOC_B_VALID and
// DOC_B_BROKEN differ ONLY inside the fence, which is precisely the edit
// scope is designed to be invariant under — that is what makes half 2's two
// assertions test opposite things rather than the same thing twice.
const DOC_A = singleDiagramDocument(
  'Alpha Document',
  'Prose that belongs to the first document only.',
  TALL_DIAGRAM
)
const DOC_B_VALID = singleDiagramDocument('Beta', 'Second document.', SHORT_DIAGRAM)
const DOC_B_BROKEN = singleDiagramDocument('Beta', 'Second document.', SHORT_DIAGRAM_BROKEN)

test('Gate 3: an unchanged diagram is served from the content-addressed cache, and a retained placeholder size never crosses documents', async () => {
  const { app, close } = await launchIsolatedApp(['.'])

  try {
    const docA = markdownToHtml(DOC_A).html
    const docBValid = markdownToHtml(DOC_B_VALID).html
    const docBBroken = markdownToHtml(DOC_B_BROKEN).html

    const result = await app.evaluate(
      async ({ BaseWindow }, { docA, docBValid, docBBroken, geometry, documentStyle }) => {
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

        // Sends one document and reports both its result and the CSP
        // violations attributable to THAT send specifically (snapshot-and-diff,
        // the same isolation technique the injection test above uses, and for
        // the same reason: the absolute count is dominated by noise from
        // earlier sends on this same long-lived harness).
        const send = async (
          html: string
        ): Promise<{
          height: number
          pageCount: number
          violations: number
          boxes: DiagramBox[]
        }> => {
          const before = consoleMessages.length
          const r = await harness.sendDocument(html, geometry, documentStyle)
          const violations = consoleMessages
            .slice(before)
            .filter((m) => /content security policy|refused to/i.test(m)).length
          return {
            height: r.diagramBoxes[0]?.height ?? 0,
            pageCount: r.pageCount,
            violations,
            boxes: r.diagramBoxes
          }
        }

        const aFirst = await send(docA)
        // Immediately re-sent, byte-identical: the cache-hit case.
        const aRepeat = await send(docA)

        // A DIFFERENT document whose only diagram is broken, sent with no
        // valid render of ITS OWN ever having happened on this harness. The
        // only height available to inherit is document A's.
        const bBrokenCold = await send(docBBroken)

        // Now give document B a real known-good render, then break it — the
        // genuine design:107 mid-typing case.
        const bValid = await send(docBValid)
        const bBrokenWarm = await send(docBBroken)

        return { aFirst, aRepeat, bBrokenCold, bValid, bBrokenWarm }
      },
      { docA, docBValid, docBBroken, geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
    )

    console.log('Gate 3 cache + cross-document retention:', JSON.stringify(result, null, 2))

    // --- Half 1: the cache is real -----------------------------------------
    // The first render of document A must genuinely run Mermaid...
    expect(
      result.aFirst.violations,
      'the first render of a diagram must actually run mermaid.render()'
    ).toBeGreaterThan(0)
    // ...and the byte-identical repeat must not. Compared as a fraction of
    // the first send rather than to an absolute number, because the absolute
    // count is a Mermaid implementation detail this app does not control (the
    // corpus test above deliberately refuses to pin its own 972 for the same
    // reason). A cache miss would reproduce essentially the whole count.
    expect(
      result.aRepeat.violations,
      'a byte-identical re-render must be served from the cache, not re-rendered'
    ).toBeLessThan(result.aFirst.violations / 4)

    // A cache that returns something subtly different from what an uncached
    // render would have produced is worse than no cache: page geometry here is
    // pinned to fractional pixels everywhere else in this suite.
    expect(result.aRepeat.boxes).toEqual(result.aFirst.boxes)
    expect(result.aRepeat.pageCount).toBe(result.aFirst.pageCount)

    // --- Half 2: retention is scoped to one document -----------------------
    // The two documents' diagrams must be far enough apart for the two
    // assertions below to be distinguishable at all — asserted, not assumed,
    // so this test can never silently degrade into comparing two equal
    // numbers.
    expect(result.aFirst.height).toBeGreaterThan(result.bValid.height * 1.5)

    // THE BUG. Document B's placeholder must not be inflated to document A's
    // diagram height. With the old positional key it inherited exactly that.
    expect(
      result.bBrokenCold.height,
      "a broken diagram must not inherit a different document's diagram height"
    ).toBeLessThan(result.aFirst.height)

    // ...and the feature that key was protecting still works: once document B
    // has its own known-good render, breaking it retains B's OWN height.
    expect(result.bBrokenWarm.height).toBeCloseTo(result.bValid.height, 0)
  } finally {
    await close()
  }
})

// A3 (docs/superpowers/plans/2026-08-09-design-doc-gap-audit.md): one
// malformed Mermaid diagram used to abort pagination of the ENTIRE document.
// `await renderMermaidToSvg(...)` was unguarded inside the per-diagram loop
// and the missing-<svg> path threw on its own, so the only catch was the
// whole-pass handler -- which publishes an error result, leaving the preview
// blank and the page count unobtainable. For content the design doc itself
// says is invalid "constantly mid-typing" (design:107), and which Split mode
// re-renders on exactly that cadence.
//
// This test lives here rather than in a unit test for the reason A3 and A4
// went unnoticed in the first place: `resources/` is outside vitest's
// include, so nothing in that directory has any unit coverage at all. Real
// Mermaid parse failure, real Paged.js layout, real measured boxes, or
// nothing.
//
// Three sequential sends on ONE long-lived harness, which is what Split mode
// actually is, and each send is load-bearing:
//   1. all-valid  -- establishes the known-good geometry
//   2. one broken -- the actual regression: the other diagrams must still
//                    render, the document must still paginate, the broken
//                    one must become a visible placeholder that RETAINS the
//                    height it had in step 1 (design:107, so page counts
//                    don't thrash while the user types), and Mermaid's own
//                    leaked error-diagram container must be cleaned up
//   3. all-valid  -- the diagram recovers, AND its geometry is byte-identical
//                    to step 1.
//
// That last comparison is worth more than it looks, and it is here because it
// caught something real. Nothing else in this suite compares two renders on
// ONE harness against each other, so nothing else could see that Mermaid's
// own internal text measurement is sensitive to whatever stylesheet happens
// to be in <head> when it runs. A version of the render handler that deferred
// the Polisher destroy (to stop a failed render blanking the preview, per
// design:212) measured these same diagrams at 369.945px on run 3 against
// 370.148px on run 1 -- same document, same harness, different answer
// depending on how many documents had been rendered before it. That change
// was backed out; this assertion is what stops it, or anything else with the
// same effect, coming back unnoticed.
const VALID_DIAGRAM = `flowchart TD
  A[Start] --> B{Approved?}
  B -->|Yes| C[Ship]
  B -->|No| D[Revise]
  D --> B`

// A real flowchart parse error, not an unknown diagram type: an unterminated
// node label is what a half-typed edit actually looks like.
const BROKEN_DIAGRAM = `flowchart TD
  A[Start] --> B[Unterminated`

function diagramDocument(second: string): string {
  return [
    '# One',
    '',
    '```mermaid',
    VALID_DIAGRAM,
    '```',
    '',
    '# Two',
    '',
    '```mermaid',
    second,
    '```',
    '',
    '# Three',
    '',
    '```mermaid',
    VALID_DIAGRAM,
    '```',
    ''
  ].join('\n')
}

test('Gate 3: one malformed diagram degrades to a placeholder instead of aborting the whole document', async () => {
  const { app, close } = await launchIsolatedApp(['.'])

  try {
    const { html: validHtml } = markdownToHtml(diagramDocument(VALID_DIAGRAM))
    const { html: brokenHtml } = markdownToHtml(diagramDocument(BROKEN_DIAGRAM))

    const result = await app.evaluate(
      async ({ BaseWindow }, { validHtml, brokenHtml, geometry, documentStyle }) => {
        const { createPaginationHarness } = (
          globalThis as unknown as {
            __pagedownPhase0: {
              createPaginationHarness: (typeof import('../src/main/pagination-window'))['createPaginationHarness']
            }
          }
        ).__pagedownPhase0
        const win = new BaseWindow({ show: false })
        const harness = await createPaginationHarness(win)

        // Reads the real paginated DOM rather than trusting the result
        // payload alone: whether a diagram is a genuine <svg> or a
        // placeholder is a structural fact about what a user would see, and
        // `leakedMermaidContainers` can only be observed here at all --
        // Mermaid's temp container is a sibling of #content-root, so it
        // appears in no result payload while being fully visible on screen.
        const probe = (): Promise<{
          renderedSvgIds: string[]
          errorPlaceholderIds: string[]
          errorText: string
          leakedMermaidContainers: number
        }> =>
          harness.view.webContents.executeJavaScript(`
            (() => {
              const wrappers = Array.from(document.querySelectorAll('[data-mermaid-diagram-id]'))
              const idOf = (el) => el.getAttribute('data-mermaid-diagram-id')
              const errors = wrappers.filter((el) => el.hasAttribute('data-mermaid-error'))
              return {
                renderedSvgIds: [...new Set(wrappers.filter((el) => el.querySelector('svg')).map(idOf))].sort(),
                errorPlaceholderIds: [...new Set(errors.map(idOf))].sort(),
                errorText: errors.map((el) => el.textContent).join(' | '),
                leakedMermaidContainers: document.querySelectorAll('body > div[id^="dpagedown-mermaid-"]').length
              }
            })()
          `)

        const firstValid = await harness.sendDocument(validHtml, geometry, documentStyle)
        const firstProbe = await probe()

        const broken = await harness.sendDocument(brokenHtml, geometry, documentStyle)
        const brokenProbe = await probe()

        const secondValid = await harness.sendDocument(validHtml, geometry, documentStyle)
        const secondProbe = await probe()

        return { firstValid, firstProbe, broken, brokenProbe, secondValid, secondProbe }
      },
      { validHtml, brokenHtml, geometry: LETTER_GEOMETRY, documentStyle: DEFAULT_STYLE }
    )

    console.log(
      'Gate 3 malformed-diagram run:',
      JSON.stringify(
        {
          firstValid: {
            pageCount: result.firstValid.pageCount,
            diagramBoxes: result.firstValid.diagramBoxes
          },
          broken: {
            pageCount: result.broken.pageCount,
            diagramBoxes: result.broken.diagramBoxes,
            probe: result.brokenProbe
          },
          secondValid: {
            pageCount: result.secondValid.pageCount,
            diagramBoxes: result.secondValid.diagramBoxes
          }
        },
        null,
        2
      )
    )

    // Baseline: all three diagrams really rendered.
    expect(result.firstProbe.renderedSvgIds).toEqual([
      'pagedown-mermaid-0',
      'pagedown-mermaid-1',
      'pagedown-mermaid-2'
    ])
    expect(result.firstProbe.errorPlaceholderIds).toEqual([])

    // THE regression. Before the per-diagram try/catch this send produced an
    // error result: no pages, no boxes, a blank preview for the whole
    // document because of one unterminated bracket.
    expect(result.broken.ready).toBe(true)
    expect(result.broken.pageCount).toBeGreaterThan(0)
    expect(result.brokenProbe.renderedSvgIds).toEqual(['pagedown-mermaid-0', 'pagedown-mermaid-2'])
    expect(result.brokenProbe.errorPlaceholderIds).toEqual(['pagedown-mermaid-1'])
    // The placeholder is a real, readable figure, not an invisible gap: it
    // names the failure and shows the source that caused it.
    expect(result.brokenProbe.errorText).toContain('Diagram could not be rendered')
    expect(result.brokenProbe.errorText).toContain('Unterminated')

    // Mermaid's own parse-error path renders its "Syntax error in text" bomb
    // graphic into a temp <div> hung directly off document.body and then
    // throws on the line ABOVE its own removeTempElements() call (read from
    // mermaid.core.mjs, not assumed) -- so without the explicit cleanup in
    // the catch, that graphic paints loose in the preview, outside
    // #content-root, above the real pages.
    expect(result.brokenProbe.leakedMermaidContainers).toBe(0)

    // design:107's "retains the last known-good diagram's dimensions rather
    // than collapsing to a different size, to avoid pagination thrashing
    // while the user is mid-edit". Compared against the SAME diagram's real
    // measured height from the send before it, on this same harness.
    const goodHeight = result.firstValid.diagramBoxes.find(
      (b: DiagramBox) => b.id === 'pagedown-mermaid-1'
    )!.height
    const placeholderHeight = result.broken.diagramBoxes.find(
      (b: DiagramBox) => b.id === 'pagedown-mermaid-1'
    )!.height
    console.log(
      'Gate 3 retained placeholder height vs last known-good:',
      JSON.stringify({ goodHeight, placeholderHeight })
    )
    expect(goodHeight).toBeGreaterThan(0)
    expect(placeholderHeight).toBeCloseTo(goodHeight, 0)

    // Recovery, plus the determinism check the commit-point change needs:
    // fixing the diagram brings it back, at byte-identical geometry to the
    // first render on this harness.
    expect(result.secondProbe.renderedSvgIds).toEqual([
      'pagedown-mermaid-0',
      'pagedown-mermaid-1',
      'pagedown-mermaid-2'
    ])
    expect(result.secondProbe.errorPlaceholderIds).toEqual([])
    expect(result.secondValid.diagramBoxes).toEqual(result.firstValid.diagramBoxes)
    expect(result.secondValid.pageCount).toBe(result.firstValid.pageCount)
  } finally {
    await close()
  }
})
