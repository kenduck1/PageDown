// Runs inside the sandboxed pagedown-render:// context. This script has no
// Node.js or Electron API access (sandbox: true, no preload script) and is
// built as a fully self-contained bundle independent of the main app's
// renderer — see scripts/build-pagination-render.ts.
//
// Communication with the main process is one-directional-in / poll-out:
//   in:  window.postMessage(...) from view.webContents.executeJavaScript
//   out: main polls `window.__pagedownResult` via executeJavaScript
// This avoids any IPC/preload surface on this context.
//
// Task 6 replaces the Task 3 synthetic echo placeholder with the real
// Paged.js `Previewer`: the injected HTML is actually paginated, and
// `pageCount` (`flow.total`) reflects real layout work rather than a
// hardcoded `1`.
//
// requestAnimationFrame SHIM — must run before Paged.js's `Previewer` is
// ever constructed (module-load time, before any import that could
// transitively read `window.requestAnimationFrame`), and is the actual fix
// for a real, previously-undiscovered, pre-existing bug (reproduced back to
// before this session's "GA push" work even started — this is not a
// regression from anything built recently): Paged.js's own internal task
// queue (node_modules/pagedjs/src/utils/queue.js) sets `this.tick =
// requestAnimationFrame` and drives its ENTIRE progressive-layout loop
// through it — `Chunker.render()`'s per-step loop
// (node_modules/pagedjs/src/chunker/chunker.js) enqueues every layout step
// onto this queue, and the queue only ever dequeues the next step inside a
// callback registered via `this.tick.call(window, ...)`. If rAF never
// fires for this webContents, NOTHING inside Chunker.render() ever
// progresses — confirmed directly by listening to the Chunker's own
// `rendering`/`page`/`renderedPage`/`rendered` events: `rendering` fires
// once (it's emitted synchronously, before the queue is ever touched), and
// then silence forever, even after waiting 60+ seconds — not merely slow,
// a genuine permanent hang. Font loading, `document.fonts`, and this
// script's own `setInterval` heartbeats all worked fine throughout,
// isolating the stall specifically to rAF servicing, not to any actual
// application code, malformed CSS, or a slow underlying render.
//
// Root cause: `BaseWindow({ show: false })` (thumbnail-generator.ts,
// page-count-generator.ts, pdf-exporter.ts, and the Phase 0 spike harness
// in src/main/index.ts ALL use one) avoids Chromium's per-view COMPOSITOR
// OCCLUSION throttle — see thumbnail-generator.ts's own `getHarness`
// comment for that earlier, separate, already-fixed bug (a real, shown
// window's occluded view gets rAF serviced at ~2Hz instead of ~60Hz) — but
// a genuinely never-shown window has no structural guarantee of ever
// producing a real compositor frame AT ALL, and `requestAnimationFrame` is
// specified to fire "before the next repaint": no repaint, no callback,
// not even a throttled one. `backgroundThrottling: false`
// (pagination-window.ts/split-preview-window.ts's own `webPreferences`) was
// tried first and confirmed, empirically, NOT sufficient on its own — that
// flag governs Chromium's deliberate THROTTLING of an already-firing rAF,
// not the more fundamental "never fires for a surface that's never
// composited" case. Split mode's own harness (`split-preview-window.ts`)
// never hit this because it's the one harness attached to a REAL, visible,
// composited window.
//
// The fix: since Paged.js's layout correctness does not depend on rAF's
// real timing semantics (it only needs its internal queue to keep
// draining, not to be synchronized with an actual screen refresh — nothing
// about pagination correctness is frame-rate-sensitive), overriding
// `requestAnimationFrame`/`cancelAnimationFrame` with a `setTimeout`/
// `clearTimeout`-based equivalent sidesteps the entire "does this
// window/OS/compositor configuration ever produce a real paint" question
// rather than depending on it — a well-established pattern for headless
// rendering with rAF-driven libraries. ~16ms matches a 60fps-equivalent
// cadence so this doesn't change perceptible timing for Split mode's own
// genuinely-visible case either.
window.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
  return window.setTimeout(() => callback(performance.now()), 16)
}) as typeof window.requestAnimationFrame
window.cancelAnimationFrame = ((handle: number): void => {
  window.clearTimeout(handle)
}) as typeof window.cancelAnimationFrame

import { Previewer } from 'pagedjs'
import { renderMermaidToSvg } from '../../src/diagrams/render-mermaid'
import { registerBreakHandlers } from '../../src/pagination/break-handlers'
import { hoistInlineStyleAttributes, reattachNoncedStyles } from './nonce-style-hoisting'
import { renderMathEquations, buildKatexFontFaceCss } from './katex-render'
import documentTypographyCss from '../../src/typography/document-typography.css'
import sourceSerif4Base64 from '../../src/renderer/src/assets/fonts/source-serif-4-variable.woff2'
import interVariableBase64 from '../../src/renderer/src/assets/fonts/inter-variable.woff2'
import { DPI, type PageGeometry } from '../../src/typography/page-geometry'
import { buildRunningContentCss, type DocumentStyle } from '../../src/typography/document-style'
import type { RenderRequestMessage } from '../../src/pagination/render-message'
import { clampPageIndex, pickCurrentPage, type PageNavState } from '../../src/pagination/page-nav'

// Task 10 / Gate 6: register the first-party keep-with-next/table-
// continuation handlers exactly once, before the first `new Previewer()`
// below is ever constructed. Per src/pagination/break-handlers.ts's own
// top comment (grounded in reading node_modules/pagedjs/src/polyfill/
// previewer.js and utils/handlers.js directly): Paged.js has no
// per-Previewer-instance handler option — `registerHandlers(...)` mutates
// a module-level array that EVERY `new Previewer().preview()` call reads
// from, so this belongs at module scope here, not inside the per-request
// 'render' handler below (which would re-register, and therefore
// re-instantiate and re-fire, these handlers once per past render on every
// subsequent call).
registerBreakHandlers()

// Document Typography sub-project: the ONLY place in this render context
// that builds a real, non-empty stylesheet for previewer.preview() -- every
// render before this sub-project passed `[]` (see the 'render' handler
// below for the historical reasoning that's no longer current). Four
// pieces, concatenated in this order:
//   1. A `:root` block defining the exact CSS custom properties
//      document-typography.css's rules (piece 4, below) consume:
//      --font-serif, --font-mono, --font-doc-sans, --text-12, --text-13,
//      --text-14, --text-15, --text-16, --text-20, --text-21, --text-26,
//      --text-32 (the last four of those -- font-doc-sans, text-15,
//      text-21, text-32 -- added by the theme/font-family rules at the end
//      of document-typography.css). Those properties are normally
//      minted by Tailwind's `@theme static` block in
//      src/renderer/src/assets/base.css, which exists ONLY in the app-shell
//      renderer -- this sandboxed context has no Tailwind and no base.css
//      at all, so without this block every one of
//      document-typography.css's declarations below would be invalid at
//      computed-value time (an unresolved var() falls back to `unset`, i.e.
//      inherit) and headings/body text would silently render at inherited
//      sizes. Hand-synced with base.css's `@theme
//      static` block -- same "kept in sync by hand" pattern already used
//      for this app's CSP nonce policy string (index.html) and
//      document-typography.css's own literal px values; if base.css's
//      values ever change, update these to match. Nothing else in
//      base.css's @theme block is referenced by document-typography.css,
//      so nothing else is duplicated here.
//
//      *** THIS LIST MUST COVER EVERY `var(--...)` IN THE SHARED
//      STYLESHEET. *** A reference with no definition here is
//      invalid-at-computed-value-time, and because both `font-size` and
//      `font-family` INHERIT, the property silently falls back to the
//      nearest ancestor's value instead of erroring -- so the rule appears
//      to work, on the pagination surface only, at the wrong value. This is
//      not hypothetical: the h4-h6 rules added by the final whole-branch
//      review introduced `--text-13`/`--text-12` into the shared stylesheet
//      without adding them here, and h5/h6 rendered at the baseline's 14px
//      in the preview and exported PDF while the editor rendered them at
//      13px and 12px (with knock-on line-height/margin drift, both being
//      em-relative). No gate caught it -- neither the corpus nor Gate 10's
//      fixture contains an h4-h6 heading. `src/typography/
//      document-typography.test.ts` now closes this mechanically by
//      cross-checking all three files, so adding a var() reference without a
//      definition fails `pnpm test:unit` rather than shipping.
//   2. Two @font-face rules -- Source Serif 4 and (added by Task 4) Inter
//      Variable -- built here rather than shipped inside
//      document-typography.css itself -- that file is shared with the
//      Milkdown mount, which loads both fonts through its own,
//      already-existing Vite-bundled @font-face rules in base.css; only
//      THIS context needs self-contained, CSP-safe data: URIs (see Task 5
//      for the font-src data: CSP change these rules depend on). Kept
//      declaration-for-declaration in sync with base.css's copies,
//      including `font-display: block` -- inert here (Paged.js's
//      Chunker.loadFonts() awaits every FontFace in document.fonts before
//      it lays anything out, so there is no window in which a fallback
//      face could paint), but the rules are documented as hand-synced pairs
//      and an unexplained declaration difference between a pair reads as
//      drift.
//
//      Only the face `documentStyle.fontFamily` actually selects is
//      emitted (Task 5) -- NOT both unconditionally, which is what an
//      earlier version of this comment (and of `buildDocumentStylesheet`)
//      shipped as a disclosed, temporary cost. Confirmed by reading
//      Paged.js's own source, not assumed: `Chunker.flow()` awaits
//      `this.loadFonts()` (node_modules/pagedjs/src/chunker/chunker.js:170),
//      and `loadFonts()` iterates EVERY entry already registered in
//      `document.fonts`, calls `.load()` on each one not yet loaded, and
//      awaits all of them (same file, ~541-557) -- it has no concept of
//      "only load faces something on the page actually uses." Registering
//      BOTH faces unconditionally therefore forced a real, awaited ~48KB
//      base64 decode on every single render, even for a document whose
//      theme never resolved to the unused one. Now that
//      `buildDocumentStylesheet` receives the document's own
//      `DocumentStyle`, it emits exactly one `@font-face` rule -- whichever
//      `documentStyle.fontFamily` ('source-serif-4' | 'inter') actually
//      names -- and pays that decode cost for that one face only.
//   3. An explicit @page rule matching src/typography/page-geometry.ts's
//      constants (in inches, @page's native unit, matching
//      DEFAULT_PAGE_CONFIG's own inch-denominated margins).
//      What this rule does and does NOT do -- corrected by the final
//      whole-branch review, which found the original claim here (and in
//      CLAUDE.md, Gate 4 and Gate 6) to be flatly wrong:
//        - It does NOT change the page box. Paged.js's base.js DOES
//          unconditionally inject `@page { size: letter; margin: 0 }`, but
//          that is the BROWSER PRINT page rule -- it exists to stop
//          Chromium adding its own margins around the `.pagedjs_sheet`
//          elements Paged.js generates. The actual content box is driven by
//          CSS custom properties in that same file, which already default
//          to one inch: `--pagedjs-margin-top/right/bottom/left: 1in`
//          (node_modules/pagedjs/src/polisher/base.js:12-15), consumed by
//          the `.pagedjs_pagebox` grid template at lines 264-265. `baseStyles`
//          is inserted as raw CSS and never parsed through atpage.js, so
//          those defaults stood. This context's content box has therefore
//          been 624 x 864 px all along -- confirmed independently by
//          phase0/gate3-mermaid.spec.ts's untouched `expect(sequence.width)
//          .toBe(624)` assertion, which passes both before and after this
//          rule existed. This rule restates that same geometry exactly, so
//          it is geometrically a no-op today.
//        - What it DOES buy is robustness, which is the real reason to keep
//          it: the layout no longer silently depends on an undocumented
//          library default that a Paged.js upgrade could change without
//          warning. It also answers the design doc's open technical
//          question (does a real, non-empty stylesheet change Paged.js's
//          default-page-box handling?) by construction rather than by
//          measurement -- an authored @page rule doesn't care what the
//          default would have been.
//        - Every page-count change measured on this branch (Gate 4/Gate 6's
//          synthetic-table row retune, tables-spanning-pages.md moving
//          1 -> 2) is caused by piece 4 below, the TYPOGRAPHY: 14px/1.7 body
//          text against the UA's 16px/`normal`, a 1.15 heading line-height,
//          and 0.4em 0.6em table cell padding. The page box did not change;
//          what fills it did. (Gate 2's own corpus counts, sometimes quoted
//          alongside those, did NOT move at all across this branch --
//          re-measured at 108/322, matching its committed baseline.)
//   4. document-typography.css's own tag-selector rules, imported as raw
//      text (Step 1's build.loader change, scripts/build-pagination-render.ts).
//      Every selector in that file is scoped under `.pagedown-document` --
//      this context supplies that class on its own <body> element (see
//      index.html) so these rules actually match the pages Paged.js
//      generates underneath it; without that class on <body>, every rule in
//      this piece silently stops matching (no error, it just never applies).
// Built fresh per-request from the geometry the main process computed
// from the DOCUMENT'S OWN PageConfig (src/typography/page-geometry.ts's
// computePageGeometry) -- this sandboxed context never sees raw
// Markdown/frontmatter at all (only the already-converted HTML, via
// `html` on the same incoming message), so it cannot compute PageConfig
// itself and must receive the result. Was a module-level constant built
// once at load time from the fixed PAGE_WIDTH_PX/PAGE_HEIGHT_PX/
// PAGE_MARGIN_PX -- Page Geometry Wiring's whole point is that those
// three fixed values no longer describe every document, so this can no
// longer be computed once and reused.
//
// Per-side margins (not one uniform PAGE_MARGIN_PX) -- @page's `margin`
// shorthand accepts up to four space-separated values in top/right/
// bottom/left order (standard CSS box-model order, matching `padding`/
// `border-width`), so an asymmetric PageConfig produces a real asymmetric
// @page rule, not a uniform approximation. Do NOT disturb this order --
// gate16-page-geometry.spec.ts pins it directly (see that gate's own
// header comment), asserting the content box's OFFSET within the sheet,
// not just its size, specifically because a size alone can't distinguish a
// top<->bottom or left<->right transposition from the correct order.
//
// `style` (Task 5) supplies the NON-geometric per-document inputs --
// theme/font (applied as <body> classes by the 'render' handler below, not
// here) and the running header/footer content spliced into this SAME
// `@page` block via `buildRunningContentCss(style)`. Those margin-box
// rules (`@top-center`, `@bottom-left`, etc.) are only ever meaningful
// NESTED inside an existing `@page { ... }` block -- see
// src/typography/document-style.ts's own comment on `buildRunningContentCss`
// -- so they're spliced directly into the same template literal below,
// never emitted as a second, standalone `@page` rule.
// `hasMath` (Task 101 / math equations) gates whether buildKatexFontFaceCss's
// ~394KB of embedded font data is included at all -- see that function's own
// comment for why this mirrors the fontFace gating immediately below it, not
// a new pattern. The caller (the 'render' handler further down) only ever
// passes `true` once renderMathEquations has ALREADY found and replaced at
// least one math placeholder in this request's own content, so this is a
// real per-request decision, not a static default.
function buildDocumentStylesheet(
  geometry: PageGeometry,
  style: DocumentStyle,
  hasMath: boolean
): string {
  // Exactly one @font-face rule is emitted -- whichever family
  // `style.fontFamily` actually selects -- not both unconditionally. See
  // this file's own top-of-file comment (piece 2) for why an unconditional
  // second face is a real, non-free cost: Paged.js's Chunker.loadFonts()
  // awaits every registered FontFace regardless of whether the document
  // uses it.
  const fontFace =
    style.fontFamily === 'inter'
      ? `@font-face {
  font-family: 'Inter Variable';
  font-style: normal;
  font-weight: 100 900;
  font-display: block;
  src: url(data:font/woff2;base64,${interVariableBase64}) format('woff2-variations');
}`
      : `@font-face {
  font-family: 'Source Serif 4';
  font-style: normal;
  font-weight: 200 900;
  font-display: block;
  src: url(data:font/woff2;base64,${sourceSerif4Base64}) format('woff2-variations');
}`

  return `
:root {
  --font-serif: 'Source Serif 4', serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --font-doc-sans: 'Inter Variable', sans-serif;
  --text-12: 12px;
  --text-13: 13px;
  --text-14: 14px;
  --text-15: 15px;
  --text-16: 16px;
  --text-20: 20px;
  --text-21: 21px;
  --text-26: 26px;
  --text-32: 32px;
}

${fontFace}

${hasMath ? buildKatexFontFaceCss() : ''}

@page {
  size: ${geometry.pageWidthPx / DPI}in ${geometry.pageHeightPx / DPI}in;
  margin: ${geometry.marginTopPx / DPI}in ${geometry.marginRightPx / DPI}in ${geometry.marginBottomPx / DPI}in ${geometry.marginLeftPx / DPI}in;
${buildRunningContentCss(style)}
}

${documentTypographyCss}

.pagedown-math-block {
  break-inside: avoid-page;
  page-break-inside: avoid;
  margin: 1em 0;
  text-align: center;
  overflow-x: auto;
}
`
}

// Trusted bootstrap, runs before any 'render' message can possibly arrive.
// This whole module is loaded via `<script type="module" src="./index.js">`
// under `script-src 'self'`, and module evaluation completes synchronously
// before `createPaginationHarness()` (which awaits this page's initial
// navigation) ever returns control to a caller — so this always runs before
// the first `postMessage` a caller could send.
//
// Stamps this page-load's CSP style nonce (generated per-request by the
// pagedown-render:// protocol handler in src/main/pagination-window.ts,
// published via <meta name="csp-style-nonce"> — see index.html) onto every
// <style> element created via `document.createElement`. This is exactly how
// Paged.js's Previewer/Polisher create their computed pagination CSS
// (`document.createElement("style")`, never by parsing HTML — confirmed
// against pagedjs's own source), and is deliberately narrower than a
// blanket `style-src 'unsafe-inline'`: only scripts running on this page can
// mint a nonced <style> element at all.
//
// Corrected (Task 8 review) — the invariant this shim enforces is narrower
// than an earlier version of this comment claimed. It is NOT "content that
// arrived via HTML parsing can never end up nonced": `reattachNoncedStyles`
// (below, Task 8 / Gate 3) does exactly that for Mermaid's own theme CSS —
// takes text that Mermaid produced (and that DOMPurify's sanitize() pass,
// itself parsing/serializing HTML, already ran over) and re-creates it as a
// fresh `<style>` via this same `document.createElement`, which nonces it.
// The real invariant is narrower and CODE-PATH-based, not
// parsing-vs-scripting-based: only THIS RENDER CONTEXT'S OWN trusted code
// (this file, and the pinned mermaid dependency it calls) ever calls
// `document.createElement('style')` at all — attacker-controlled Markdown
// content, which only ever becomes DOM via `Range.createContextualFragment`
// (see the 'render' handler below) or Mermaid's internal parsing of a
// ```mermaid code block's TEXT, never gets a chance to have ITS OWN
// `document.createElement` calls run, so it still can't mint an
// attacker-authored `<style>` tag directly.
//
// This narrower invariant does leave one real, bounded-severity residual
// path this shim's own re-nonce of Mermaid's theme CSS opens, found on
// review, not by this task's own testing (the corpus contains no diagram
// that exercises it): Mermaid's `%%{init: {...}}%%` frontmatter directive
// (parsed from the ```mermaid code block's own text, before rendering) lets
// a diagram author set `themeCSS`, and `themeCSS` is not in Mermaid's own
// "secure keys" init-sanitization list — so a diagram could embed
// `%%{init: {"themeCSS": "..."}}%%` and have that CSS text end up inside
// the theme `<style>` block this shim then nonces on Mermaid's behalf.
// Bounded, not unrestricted: this is CSS only (script-src is completely
// unaffected — nothing here ever nonces a <script>), `stripExternalCssRefs`
// (Task 8 / Gate 3) already strips `@import`/external `url(...)` from
// exactly this text before it reaches the nonced style block, and
// `connect-src 'none'` / `img-src 'self' data:` / `default-src 'self'`
// still block any other egress path a raw CSS injection could otherwise
// exploit (font/background `url()` fetches, etc. — the same class of
// attack `stripExternalCssRefs` targets). This is also, per the design
// doc's own Mermaid section, the PRESCRIBED mechanism (render once, strip
// dangerous refs, re-attach with the document's nonce) — not a new gap
// introduced by accident, but its actual blast radius (arbitrary
// same-origin-scoped CSS applied inside the render context, via a
// mermaid-authored diagram) is worth a future task's attention rather than
// treating this comment's account of it as the final word.
const styleNonce =
  document.querySelector('meta[name="csp-style-nonce"]')?.getAttribute('content') ?? ''
if (styleNonce) {
  const nativeCreateElement = document.createElement.bind(document)
  document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
    const element = nativeCreateElement(tagName, options)
    if (typeof tagName === 'string' && tagName.toLowerCase() === 'style') {
      element.setAttribute('nonce', styleNonce)
    }
    return element
  }) as typeof document.createElement
}

// Derived from the shared src/pagination/render-message.ts contract, not
// restated by hand -- see that module's own header comment for why: a
// second, independently-maintained copy of this shape is exactly what let a
// missing `geometry` field go uncaught by tsc in the first place.
type IncomingMessage = RenderRequestMessage

interface OutgoingSuccess {
  type: 'result'
  requestId: string
  pageCount: number
  ready: true
  // Wall-clock time (performance.now() delta), measured entirely inside
  // this render context, for `new Previewer().preview()` alone — i.e. real
  // Paged.js layout work, with none of the main-process round-trip
  // (executeJavaScript dispatch, the sendDocument poll loop's up-to-50ms
  // detection granularity) folded in. Surfaced on `PaginationResult` (see
  // src/main/pagination-window.ts) and forwarded through
  // `paginateAndTime`'s return value so a reader of the committed timing
  // JSON can sanity-check how much of the main-process-measured
  // "sendAndPaginate" stage is genuine layout time versus harness/poll
  // overhead, without needing an ad hoc/uncommitted probe to find out.
  // `0` for the empty-content short-circuit below, since no Paged.js layout
  // ran at all in that case.
  layoutMs: number
  // Task 8 / Gate 3: one entry per `.pagedown-mermaid-diagram` wrapper
  // actually present in the PAGINATED output under `root` (i.e. read back
  // AFTER previewer.preview() has cloned content into real page elements —
  // "post-pagination" per the brief, not measured against the pre-pagination
  // working copy). `width`/`height` come from the rendered SVG's own
  // `getBoundingClientRect()` — the real, on-screen, CSS-and-layout-applied
  // box, not the SVG's internal `getBBox()` content geometry (which Mermaid
  // already used internally, inside renderMermaidToSvg, to size the
  // viewBox — see that module and the "Task 8 / Gate 3" section below for
  // why a *second*, independent read here, from the actual paginated DOM,
  // is the thing that can actually catch a zero-size failure rather than
  // just inferring "it probably worked" from the absence of a thrown error.
  // `[]` for documents with no mermaid diagrams (including the
  // empty-content short-circuit below).
  diagramBoxes: Array<{ id: string; width: number; height: number }>
  // Local-asset loading (2026-08-05 sub-project): one entry per `<img>`
  // actually present in the PAGINATED output under `root`, read back AFTER
  // previewer.preview() has cloned content into real page elements and
  // AFTER every image has settled (see awaitImagesSettled below). Exists
  // for exactly the same reason `diagramBoxes` does, one layer down: a
  // local image reference that silently 404s produces an `<img>` element
  // that is present, `complete === true`, and `naturalWidth === 0` -- the
  // classic "failed to load" signature (phase0/gate4-export.spec.ts already
  // asserts precisely that signature for the corpus's unserved images).
  // Nothing about "pagination finished without throwing" distinguishes a
  // real, decoded image from that failure, so a non-zero `naturalWidth`
  // read from the real paginated DOM is the only genuine proof that the
  // bytes were fetched through the pagedown-render:// asset handler AND
  // decoded. `[]` for documents with no images (including the
  // empty-content short-circuit below).
  imageBoxes: Array<{
    src: string
    resolvedSrc: string
    naturalWidth: number
    naturalHeight: number
  }>
}

interface OutgoingError {
  type: 'error'
  requestId: string
  error: string
}

type OutgoingMessage = OutgoingSuccess | OutgoingError

// --- Task 7 / Gate 7: incremental re-layout spike -------------------------
//
// Separate message types/result channel from the 'render'/__pagedownResult
// pair above, deliberately: gate7 needs to keep a Previewer/Chunker instance
// ALIVE across two separate messages (phase 1, then phase 2 — see the
// listener below), whereas every 'render' call is fully self-contained and
// tears its Previewer down implicitly on the next call (see
// `activePreviewer` below). Reusing __pagedownResult's shape/lifecycle for
// this would conflate two different state machines for no benefit.
//
// Deferred cleanup, not done as part of this Phase 0 spike: like the rest
// of the __pagedownPhase0 bridge (src/main/index.ts), these gate7-phase1/
// gate7-phase2 handlers ship unconditionally in this render bundle rather
// than being gated behind a dev/test-only flag — consistent with that
// existing precedent, but worth closing before Phase 0's scaffolding is
// considered final. Also: `controlPreviewer`'s Polisher (created in the
// gate7-phase2 handler below) is never `destroy()`-ed, unlike
// `gate7Previewer`'s — a small, one-off `<style>`-element leak on top of
// this render context's own DOM, harmless for this single-test-run spike
// but the same class of leak Task 6 fixed for the regular 'render' path.
interface Gate7Phase1Message {
  type: 'gate7-phase1'
  requestId: string
  html: string
  targetPageIndex: number
}

interface Gate7Phase2Message {
  type: 'gate7-phase2'
  requestId: string
  editSectionNumber: number
  markerText: string
  editedHtml: string
  targetPageIndex: number
}

interface Gate7Phase1Success {
  type: 'gate7-phase1-result'
  requestId: string
  ok: true
  fullOriginalMs: number
  totalPagesOriginal: number
  // Section number (from the corpus's "## Section N" headings) nearest the
  // captured breakToken, discovered by walking chunker.source backward from
  // the breakToken's node to the nearest preceding <h2> — MEASURED from the
  // real DOM, not estimated from the corpus's known sections-per-page ratio.
  // `null` only if that walk somehow found no preceding heading at all.
  sectionNumberAtBreakpoint: number | null
  resumeNoEditMs: number
  totalPagesAfterResumeNoEdit: number
  baselinePagesText: string[]
  resumedNoEditPagesText: string[]
}

interface Gate7Phase2Success {
  type: 'gate7-phase2-result'
  requestId: string
  ok: true
  resumeWithEditMs: number
  totalPagesAfterEdit: number
  resumedWithEditPagesText: string[]
  // Pages [0, targetPageIndex) — the retained prefix, untouched by the
  // resume, captured for direct comparison against `controlPrefixPagesText`
  // (see the render context's phase-2 handler for why this is checked
  // rather than assumed).
  resumedPrefixPagesText: string[]
  fullEditedMs: number
  totalPagesEdited: number
  controlPagesText: string[]
  controlPrefixPagesText: string[]
}

interface Gate7Error {
  type: 'gate7-error'
  requestId: string
  ok: false
  error: string
}

type Gate7Result = Gate7Phase1Success | Gate7Phase2Success | Gate7Error

// --- Task 9 / Gate 4: header/footer artifact-vs-content tagging probe -----
//
// A separate, deliberately narrow message type/result channel, added ONLY
// because of what Gate 4 found by actually running it.
//
// PREMISE CORRECTED by the Document Typography sub-project (and by the
// final whole-branch review that caught this comment still asserting the
// old one). As originally written, this said the regular 'render' path
// always passes an explicitly EMPTY stylesheet array, so "NO `@page`
// at-rule ever reaches Paged.js's Polisher for ANY document this harness
// paginates today". That is no longer true: the regular path now passes
// buildDocumentStylesheet(geometry) (see the top of this file), which
// contains a real `@page` rule, so `atpage.js`'s handler DOES run on every
// render.
//
// The probe's PURPOSE survives that correction intact, because the thing it
// manufactures was never merely "an `@page` rule" — it is running
// header/footer/page-number CONTENT. Traced directly (not assumed):
// `node_modules/pagedjs/src/chunker/page.js` never creates the per-page
// margin-box DOM elements; that template lives in `chunker.js`'s page
// template (16 `.pagedjs_margin-*` divs — 4 corners + 3 top + 3 bottom + 3
// left + 3 right, always present, always empty absent a matching
// MARGIN-BOX rule) and is populated only by
// `src/modules/paged-media/atpage.js`'s `@page`-rule handler, from
// `@top-center`/`@bottom-center`-style nested rules. At the time this
// comment was written, the `@page` rule buildDocumentStylesheet(geometry)
// built declared only `size` and `margin` and contained no margin-box
// rules at all, so those 16 divs were still always empty for every real
// document: this harness's on-screen render and PDF export contained NO
// running header/footer/page-number content for ANY corpus document (a real,
// separate gap from this task's own scope — Gate 2's findings doc already
// flagged that frontmatter page/margin metadata isn't wired into an `@page`
// stylesheet at all). That means the design doc's "are running
// headers/footers/page numbers tagged as content vs. artifacts" Gate 4
// criterion still has nothing to inspect against this harness's regular
// output — not a pass, not a fail, just no signal at all. This probe exists
// solely to manufacture that missing signal: it accepts an explicit `css`
// string (containing real `@page`/`@top-center`/`@bottom-center` rules) and
// forwards it to `previewer.preview()` as a real, non-empty stylesheet —
// which, since the Document Typography sub-project, is no longer unique to
// this probe (the regular 'render' path passes
// buildDocumentStylesheet(geometry)'s result); what remains unique is that
// the stylesheet is CALLER-SUPPLIED per request and carries margin-box
// rules — so
// `phase0/gate4-export.spec.ts` has actual generated running-header/footer
// content to export and inspect the tagging of. Reuses the SAME
// `activePreviewer`/`currentRequestId` module state as the 'render' handler
// above (Polisher-cleanup-before-next-run and stale-result-discarding both
// still apply — this is still just a `previewer.preview()` call under the
// hood), but skips the Mermaid preprocessing pass and the empty-content
// short-circuit, neither of which this probe's own callers need.
//
// SECOND CORRECTION (Task 5 / Page Setup Completeness): the paragraph above
// is now stale in one more way, worth recording rather than silently
// re-editing out. `buildDocumentStylesheet` has grown a second parameter
// (`buildDocumentStylesheet(geometry, style)`, `style: DocumentStyle`) that
// splices `buildRunningContentCss(style)`'s own `@top-*`/`@bottom-*` rules
// directly into the SAME `@page` block the regular 'render' path already
// builds — so that path now DOES populate real margin-box content whenever
// the document's own style configures a header or footer.
// `DEFAULT_DOCUMENT_STYLE` itself sets a non-null footer
// (`{ center: 'Page {n} of {total}' }`), so this fires for every
// default-styled document, including every gate below that passes
// `DEFAULT_DOCUMENT_STYLE` — this harness's regular output is no longer
// running-header/footer-content-free. This probe is therefore no longer the
// ONLY source of margin-box content in this harness, but it remains the
// only one whose stylesheet is CALLER-SUPPLIED, which is what lets
// `phase0/gate4-export.spec.ts` pin an exact, hand-authored
// `@top-center`/`@bottom-center` shape rather than whatever a fixture's own
// `DocumentStyle` happens to produce.
interface Gate4ProbeMessage {
  type: 'gate4-header-footer-probe'
  requestId: string
  html: string
  css: string
}

interface Gate4ProbeSuccess {
  type: 'gate4-header-footer-probe-result'
  requestId: string
  ok: true
  pageCount: number
}

interface Gate4ProbeError {
  type: 'gate4-header-footer-probe-error'
  requestId: string
  ok: false
  error: string
}

type Gate4ProbeResult = Gate4ProbeSuccess | Gate4ProbeError

// Marks this file as a module (rather than a global script) so the
// `declare global` augmentation below is valid — nothing else here needs
// to be imported/exported.
export {}

declare global {
  interface Window {
    __pagedownResult?: OutgoingMessage
    __pagedownGate7Result?: Gate7Result
    __pagedownGate4ProbeResult?: Gate4ProbeResult
    __pagedownPageNav?: {
      scrollToPage(requestedPage: number): PageNavState
      getPage(): PageNavState
    }
  }
}

// Page navigation (docs/superpowers/specs/2026-08-08-page-navigation-design.md).
//
// Deliberately NOT routed through the postMessage + window.__pagedownResult
// protocol the 'render' message uses. That protocol exists because pagination
// is ASYNCHRONOUS -- main has to poll for a result that arrives whenever
// Paged.js finishes. Scrolling is synchronous, and executeJavaScript already
// returns the evaluated value straight back to main, so a message type here
// would add a second in-flight result channel racing the render one for no
// benefit. RenderRequestMessage stays exactly as it is.
//
// Lives in this bundled, type-checked module rather than in a string injected
// from main: only a validated integer is ever interpolated into injected JS
// (see split-preview-window.ts). A hostile document cannot reach this --
// sanitization strips scripts and `script-src 'self'` blocks inline
// execution -- and in the worst case an override could only break scrolling,
// never escalate.
function readPageElements(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.pagedjs_page'))
}

function currentPageState(pages: HTMLElement[]): PageNavState {
  const tops = pages.map((page) => page.getBoundingClientRect().top)
  return {
    currentPage: pickCurrentPage(tops, window.innerHeight),
    pageCount: pages.length
  }
}

window.__pagedownPageNav = {
  scrollToPage(requestedPage: number): PageNavState {
    const pages = readPageElements()
    if (pages.length === 0) return { currentPage: 1, pageCount: 0 }
    const target = clampPageIndex(requestedPage, pages.length)
    // 'auto' rather than 'smooth': main resolves its promise as soon as this
    // returns, and a smooth scroll would still be animating -- so the state
    // reported back (and any immediately-following getPage poll) would
    // describe a position the view is only on its way to.
    pages[target - 1].scrollIntoView({ behavior: 'auto', block: 'start' })
    return { currentPage: target, pageCount: pages.length }
  },
  getPage(): PageNavState {
    return currentPageState(readPageElements())
  }
}

// Tracks the most recently created Previewer so its Polisher's injected
// <style> elements can be torn down before the next run starts. Neither
// Previewer nor Polisher ever calls `Polisher.destroy()` itself — every
// `new Previewer()` + `.preview()` call leaves at least two <style>
// elements permanently in <head> (one for Paged.js's own base styles, one
// for the run's computed page-box/break rules; confirmed by reading
// pagedjs's own source, node_modules/pagedjs/src/polisher/polisher.js).
// `root.innerHTML = ''` below only clears the rendered page CONTENT; it has
// no effect on these <head> elements at all. Left unfixed, this leaks
// without bound across repeated sendDocument() calls against the same
// reused harness — exactly Task 6's own harness-reuse methodology, and
// exactly what the real app's edit-debounce loop will do on every
// keystroke-settle — and each run would paginate against a progressively
// dirtier <head> than the last.
let activePreviewer: InstanceType<typeof Previewer> | undefined

// The requestId of the most recently DISPATCHED 'render' message (not
// necessarily the most recently RESOLVED one). `sendDocument`
// (src/main/pagination-window.ts) abandons a render after its own 10-second
// deadline and returns control to its caller, which is then free to send a
// new 'render' message — but Paged.js has no cancellation mechanism, so an
// abandoned run keeps executing in this context until it naturally
// resolves or throws, arbitrarily later. Without this guard, that late
// completion would unconditionally overwrite `window.__pagedownResult` with
// STALE data, potentially clobbering a newer, already-published result.
// Every publish below (both success and error) checks this before writing,
// so a superseded run's eventual outcome is silently discarded instead of
// stomping on the current one.
//
// Honest limitation, not papered over: this is NOT full cancellation — it
// stops the data corruption, not the wasted work. An abandoned run keeps
// running for real (and, per the note above `activePreviewer`, can even
// have its own Polisher's stylesheets destroyed out from under it by the
// NEXT run, which is expected to make it throw and land on the
// discarded-error path below) until it settles on its own. At today's
// worst measured case (~2.7s at ~300 pages, see the Gate 2 findings) this
// is unreachable — the 10-second deadline is never actually hit — but
// Tasks 7-10 are explicitly expected to push toward and past it, so this is
// a real, currently-latent gap, not a hypothetical one.
let currentRequestId: string | undefined

// --- Task 8 / Gate 3: Mermaid diagram rendering -----------------------------
//
// Wired in AHEAD of Paged.js pagination (called from the 'render' handler
// below, before `new Previewer().preview()` ever runs): every
// `<pre><code class="language-mermaid">` block rehype-stringify produced for
// a fenced ```mermaid block (see src/markdown/pipeline.ts) is replaced with
// the real rendered SVG from renderMermaidToSvg (src/diagrams/render-mermaid.ts)
// before Paged.js ever sees the document, exactly per the brief.
//
// A diagram is a single figure, not a flow of rows like a table (per the
// design doc's "Page-break policy for diagrams") — it must never be sliced
// across two pages. `break-inside: avoid-page` on this wrapper class is
// this spike's entire page-break policy for diagrams (the design doc's
// fuller "diagram too large for one page" legibility-floor affordance is
// explicitly out of scope here — see the class-level comment above).
const MERMAID_DIAGRAM_CLASS = 'pagedown-mermaid-diagram'

let mermaidPageBreakStyleInjected = false

// Injected exactly once per render-context lifetime (not once per
// sendDocument() call — the rule is content-independent, so re-adding it on
// every run would just be another unbounded <head> leak of the kind the
// activePreviewer/Polisher cleanup above already exists to prevent).
// Created via `document.createElement`, so the bootstrap shim at the top of
// this file stamps this run's CSP style nonce onto it automatically — the
// same mechanism Paged.js's own Polisher-created <style> elements rely on,
// reused here rather than reinvented.
function ensureMermaidPageBreakStyleInjected(): void {
  if (mermaidPageBreakStyleInjected) return
  const style = document.createElement('style')
  style.textContent = `
    .${MERMAID_DIAGRAM_CLASS} { break-inside: avoid-page; page-break-inside: avoid; }
    .${MERMAID_DIAGRAM_CLASS} svg { display: block; max-width: 100%; height: auto; }
  `
  document.head.appendChild(style)
  mermaidPageBreakStyleInjected = true
}

// Mermaid's default sizing (`useMaxWidth: true`, the default for every
// diagram type this spike's corpus exercises) bakes `width="100%"` plus a
// `style="max-width: <natural-width>px;"` onto the SVG root — see
// node_modules/mermaid/dist/chunks/mermaid.core/chunk-6DBFFHIP.mjs's
// `calculateSvgSizeAttrs`. That stretches the SVG to fill its container's
// width regardless of the diagram's own natural size: fine for a diagram
// that's naturally wider than the page content box, but actively wrong for
// this corpus's small flowchart (which would inflate to full page width)
// and, worse, for the oversized diagram — a tall, narrow chain whose small
// natural width means the width:100% stretch would multiply its already
// oversized height even further, corrupting the exact measurement this
// gate exists to produce. This is the concrete case the design doc's third
// review calls out under "Page-break policy for diagrams": CSS auto-sizing
// via a bare viewBox does not do the right thing here, so this reads the
// SVG's own viewBox (its genuine natural size, already computed by
// Mermaid's internal getBBox()-based layout) and sets explicit width/height
// attributes from it, then drops Mermaid's forced-stretch inline style.
// Actual page-fit clamping (this spike's `max-width: 100%; height: auto`
// CSS above) then applies uniformly from the diagram's own true aspect
// ratio, the same way it would for a normal image.
//
// `removeAttribute('style')` below is now purely DEFENSIVE, not load-bearing
// (Task 8 review correction) — this function is always called AFTER
// hoistInlineStyleAttributes, which already scans `svgElement` itself (not
// just its descendants) and removes/hoists any `style=""` it carries,
// nonce-safely, before this function ever runs. Kept here anyway as a
// second, cheap guarantee that this function's own successful path never
// leaves a stray inline style behind, independent of hoisting's own
// correctness — but the actual CSP-relevant removal, on EVERY path through
// this function including the early returns below, already happened
// upstream.
function fitSvgToNaturalSize(svgElement: SVGElement): void {
  const viewBoxAttr = svgElement.getAttribute('viewBox')
  if (!viewBoxAttr) return
  const parts = viewBoxAttr.trim().split(/\s+/).map(Number)
  if (parts.length !== 4 || !parts.every((n) => Number.isFinite(n))) return
  const [, , naturalWidth, naturalHeight] = parts
  if (naturalWidth <= 0 || naturalHeight <= 0) return
  svgElement.setAttribute('width', String(naturalWidth))
  svgElement.setAttribute('height', String(naturalHeight))
  svgElement.removeAttribute('style')
}

// hoistInlineStyleAttributes/reattachNoncedStyles used to live here as
// Mermaid-specific, SVGElement-typed functions. The math-equations
// sub-project generalized and extracted them to nonce-style-hoisting.ts
// (Element-typed, no Mermaid-specific logic ever existed in either
// function's BODY — only in their comments) so katex-render.ts can reuse
// the exact same CSP-nonce mechanism for KaTeX's own inline `style="..."`
// output, which depends on it for correct positioning even more directly
// than Mermaid's own (mostly decorative) inline styles do. See that file
// for the full mechanism writeup.

// Finds every `<pre><code class="language-mermaid">` block inside
// `container` and replaces it in place with a `.pagedown-mermaid-diagram`
// wrapper holding the rendered, CSP-safe SVG. Mutates `container` directly
// (no return value) so the caller can pass the SAME container straight into
// `previewer.preview()` afterward — see the 'render' handler below for why
// that matters (passing a live DOM node, rather than round-tripping back
// through an HTML string, is what keeps the nonces set in this function
// valid; re-serializing to a string and letting Paged.js's own
// ContentParser re-parse it via `Range.createContextualFragment` would lose
// them — parser-inserted nonce attributes from fragment parsing are not
// honored by CSP, by design, which is exactly why Paged.js's own Polisher
// styles are created via `document.createElement` in the first place; see
// this file's bootstrap comment at the top).
async function renderMermaidDiagrams(container: DocumentFragment): Promise<void> {
  const codeBlocks = Array.from(
    container.querySelectorAll('pre > code.language-mermaid')
  ) as HTMLElement[]
  if (codeBlocks.length === 0) return

  // Per the design doc's resource-settling-gate ordering: layout-affecting
  // resources (fonts, images, diagrams) must be settled before anything
  // measures text, or measurements silently bake in fallback-font metrics.
  // Awaited once per render pass, before the first mermaid.render() call,
  // per the brief — not per-diagram (document.fonts.ready reflects the
  // whole document's font state, not a single element's).
  //
  // Honest limitation (Task 8 review) — this await is present per the
  // brief's literal instruction, but it does NOT actually validate the
  // resource-settling gate the design doc describes: `container` at this
  // point is still the DETACHED fragment built above, not yet part of any
  // rendered layout, and `document.fonts.ready` only reflects fonts the
  // document has already REQUESTED via currently-laid-out content — which
  // is exactly the unreliable-immediately-after-injecting-new-HTML case the
  // design doc's own resource-settling-gate section warns about (it
  // prescribes an explicit `document.fonts.load(...)` per declared face,
  // not just an await on `.ready`, for exactly this reason). No actual
  // `PageDownSans` font is bundled in this Phase 0 spike (see
  // render-mermaid.ts's own comment), so there was nothing concrete to
  // `.load()` here yet, and this await was not separately verified to do
  // anything beyond "resolve immediately" against this corpus — it is
  // scaffolding matching the brief's shape, not a validated gate. A real
  // font-loading implementation, landing alongside the actual bundled font,
  // needs to build the fuller gate the design doc describes, not assume
  // this line already is one.
  await document.fonts.ready

  ensureMermaidPageBreakStyleInjected()

  for (let i = 0; i < codeBlocks.length; i++) {
    const code = codeBlocks[i]
    const pre = code.parentElement
    if (!pre) continue // unreachable for a `pre > code` match, but keeps this a type-safe non-null narrowing rather than a cast

    const diagramSource = code.textContent ?? ''
    const elementId = `pagedown-mermaid-${i}`

    const svgMarkup = await renderMermaidToSvg(diagramSource, elementId)

    // Parsed via a SEPARATE DOMParser document, not `element.innerHTML =`
    // on a node already living in THIS page. Investigated, not assumed: a
    // real Gate 3 run against this app's 3-diagram corpus logs 972 real
    // "Applying inline style violates..." console violations — an exact,
    // reproducible count across repeated runs, NOT a random/flaky number —
    // regardless of whether this parsing step uses a live-document element
    // or a DOMParser scratch document (measured both ways, identical counts
    // either way) — meaning essentially ALL of
    // them come from EARLIER, inside `renderMermaidToSvg` itself: Mermaid's
    // own internal rendering (see mermaidAPI.render() in
    // node_modules/mermaid/dist/mermaid.core.mjs) draws the diagram using
    // real d3 selections, appended live to this page's actual
    // `document.body` (`appendDivSvgG(select("body"), ...)`), and d3's
    // `.style(...)` calls set inline style properties directly — CSP
    // evaluates and blocks each one, on the spot, as an unavoidable
    // byproduct of Mermaid's implementation running under this app's strict,
    // no-`unsafe-inline` `style-src`. No post-processing of the STRING
    // `renderMermaidToSvg` eventually returns can prevent violations that
    // already fired before that string existed — see this task's
    // report/findings-doc entry for the fuller writeup and why this doesn't
    // change Gate 3's sizing verdict (geometry comes from SVG attributes and
    // the properly-nonced <style> block's font metrics, not from these
    // blocked, paint-only per-element declarations).
    //
    // What THIS parsing choice actually still buys: Mermaid's OUTPUT STRING
    // (even after its own DOMPurify.sanitize() pass under
    // `securityLevel: 'strict'`) legitimately keeps plain `style="..."`
    // attributes on individual shape elements (DOMPurify's default allowlist
    // permits `style`, unlike `nonce` — confirmed by dumping the raw
    // returned string). Parsing that string directly into a node owned by
    // THIS page's live document, then removing those attributes a moment
    // later (hoistInlineStyleAttributes below), still risks re-triggering
    // the same class of violation for THIS app's own parsing step, on top of
    // Mermaid's already-unavoidable internal ones. A `DOMParser` result
    // document is a genuinely separate Document with no CSP of its own — the
    // same mechanism DOMPurify itself relies on internally to sanitize
    // untrusted markup without tripping the host page's policy — so doing
    // the parse and all style-attribute stripping/hoisting there, and only
    // importing the result into this page's live document via
    // `document.importNode()` once it no longer carries any `style=""`
    // attribute at all, keeps this app's OWN contribution to the violation
    // count at zero, whatever Mermaid's internals do on their own.
    const scratchDoc = new DOMParser().parseFromString(svgMarkup, 'text/html')
    const scratchSvgElement = scratchDoc.body.firstElementChild as SVGElement | null
    if (!scratchSvgElement) {
      throw new Error(`Mermaid render for diagram "${elementId}" did not produce an <svg> element`)
    }

    // Hoisting runs here, on the scratch element, BEFORE import — order is
    // load-bearing: it must remove every `style=""` attribute while the
    // element is still in the CSP-free scratch document, so nothing is left
    // to trigger a violation at the moment importNode below moves it into
    // this page's own CSP-governed document.
    const hoistedCss = hoistInlineStyleAttributes(scratchSvgElement)

    const svgElement = document.importNode(scratchSvgElement, true) as SVGElement
    // reattachNoncedStyles must run AFTER import, not before: it creates
    // the replacement <style> via THIS page's own `document.createElement`
    // (the only one the bootstrap nonce shim at the top of this file
    // patches) so the fresh element actually receives a real, matching
    // nonce — a <style> created via `scratchDoc.createElement` would carry
    // no nonce at all, since the shim never touches the scratch document.
    reattachNoncedStyles(svgElement, hoistedCss)
    fitSvgToNaturalSize(svgElement)

    const wrapper = document.createElement('div')
    wrapper.className = MERMAID_DIAGRAM_CLASS
    wrapper.setAttribute('data-mermaid-diagram-id', elementId)
    wrapper.appendChild(svgElement)

    pre.replaceWith(wrapper)
  }
}

// Reads back real, on-screen bounding boxes for every mermaid diagram
// actually present in the PAGINATED output under `root` — called AFTER
// previewer.preview() resolves, per the brief's "post-pagination" framing.
// This is deliberately a SEPARATE read from anything Mermaid measured
// internally via getBBox() while rendering (see renderMermaidToSvg) —
// that internal measurement only proves Mermaid could compute a viewBox
// for itself; it says nothing about whether the diagram actually occupies
// real, non-zero space once cloned into Paged.js's rendered page tree
// under this context's real CSP/layout, which is the thing Gate 3 is
// actually supposed to catch a failure of.
// Upper bound on how long a single render pass will wait for its images to
// finish loading. Generous relative to what a local, on-disk asset served
// by this app's own protocol handler actually costs (a denied/404'd request
// fires `error` essentially immediately; a real local PNG resolves in low
// single-digit ms) — but awaitImagesSettled (below) is called TWICE per
// render pass (once before Paged.js lays the document out, once again
// against the paginated clone after preview() resolves — see both call
// sites further down), so the real worst case this timeout can contribute
// is 2 * IMAGE_SETTLE_TIMEOUT_MS = 6s of sendDocument's own 10s poll
// deadline, before any actual layout time is even counted. Not reachable
// today (a stuck image would have to hang for the full 3s on BOTH passes),
// but a future caller raising this constant needs to budget for the
// doubled cost, not the single-pass number.
const IMAGE_SETTLE_TIMEOUT_MS = 3_000

// Waits for every `<img>` under `scope` to settle -- load OR error, both are
// "settled" -- before returning, bounded by IMAGE_SETTLE_TIMEOUT_MS.
//
// Load-bearing twice over, not a measurement convenience:
//   1. Paged.js measures real boxes to decide page breaks. An image whose
//      bytes haven't arrived yet measures as a zero-size box, so a document
//      would paginate against the wrong geometry and (for thumbnails) get
//      captured before the image ever painted -- the capture is cached
//      permanently under the content's hash, so a mistimed one is not
//      self-correcting.
//   2. `naturalWidth` is only meaningful once the image has settled;
//      measuring before that can't tell "not loaded yet" from "failed to
//      load", which is exactly the distinction measureImageBoxes exists to
//      report.
// Deliberately resolves (rather than rejects) on the timeout: a stuck image
// must degrade to "this render reports it as not-loaded", never to a failed
// pagination.
async function awaitImagesSettled(scope: ParentNode): Promise<void> {
  const pending = (Array.from(scope.querySelectorAll('img')) as HTMLImageElement[]).filter(
    (img) => !img.complete
  )
  if (pending.length === 0) return
  await Promise.race([
    Promise.all(
      pending.map(
        (img) =>
          new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true })
            img.addEventListener('error', () => resolve(), { once: true })
          })
      )
    ),
    new Promise<void>((resolve) => setTimeout(resolve, IMAGE_SETTLE_TIMEOUT_MS))
  ])
}

// Reads back every `<img>` in the PAGINATED output under `root`, with the
// natural (intrinsic, post-decode) dimensions that distinguish a genuinely
// loaded image from a silently-404'd one. Same "measure the real paginated
// DOM, don't infer success from the absence of an error" reasoning as
// measureDiagramBoxes below -- see `imageBoxes` on OutgoingSuccess.
function measureImageBoxes(root: HTMLElement): Array<{
  src: string
  resolvedSrc: string
  naturalWidth: number
  naturalHeight: number
}> {
  const images = Array.from(root.querySelectorAll('img')) as HTMLImageElement[]
  return images.map((img) => ({
    // Both the raw attribute AND the browser's own resolved form,
    // deliberately: `getAttribute('src')` is byte-for-byte what
    // src/markdown/pipeline.ts's rewrite wrote, while the `src` IDL property
    // is that same value after Chromium's real WHATWG URL parse/normalize --
    // i.e. the URL the protocol handler in src/main/pagination-window.ts
    // actually receives. Reporting both is what lets a caller prove the
    // token segment and percent-encoded path survive URL normalization
    // intact for realistic inputs (they compare equal), and pin the one
    // input where they genuinely do NOT (a relative path of exactly `..`,
    // whose bare `..` segment WHATWG dot-segment removal collapses,
    // dropping the token entirely -- a denial, since the resulting URL can
    // no longer name any registered asset root).
    src: img.getAttribute('src') ?? '',
    resolvedSrc: img.src,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight
  }))
}

function measureDiagramBoxes(
  root: HTMLElement
): Array<{ id: string; width: number; height: number }> {
  const wrappers = Array.from(root.querySelectorAll(`.${MERMAID_DIAGRAM_CLASS}`)) as HTMLElement[]
  return wrappers.map((wrapper) => {
    const id = wrapper.getAttribute('data-mermaid-diagram-id') ?? ''
    const svg = wrapper.querySelector('svg')
    const rect = svg?.getBoundingClientRect()
    return { id, width: rect?.width ?? 0, height: rect?.height ?? 0 }
  })
}

window.addEventListener('message', async (event: MessageEvent<IncomingMessage>) => {
  // Not every message on this window is necessarily a 'render' request from
  // sendDocument (e.g. Electron/Chromium internals can post other messages
  // on the same window) — this is the one early return in this handler that
  // is genuinely fine to leave silent: there is no requestId to publish a
  // result against and no caller waiting on one.
  if (event.data?.type !== 'render') return

  const { requestId, html, geometry, documentStyle } = event.data
  currentRequestId = requestId

  // The sandbox's <body> carries `.pagedown-document` statically
  // (index.html); theme and font are per-document, so they're set per
  // request, here, BEFORE previewer.preview() runs (document-typography.css's
  // theme/font rules key off these classes, and Paged.js clones content
  // that's already in the DOM at preview() time). Replaces `className`
  // WHOLESALE rather than appending -- this harness can be long-lived
  // (Split mode's own persistent WebContentsView, see
  // src/main/split-preview-window.ts), so a second render against the same
  // <body> must not accumulate a stale `pagedown-theme-*`/`pagedown-font-*`
  // class from a PREVIOUS request alongside the current one.
  document.body.className = [
    'pagedown-document',
    `pagedown-theme-${documentStyle.theme}`,
    `pagedown-font-${documentStyle.fontFamily}`
  ].join(' ')
  // Native `dir` attribute (mirrors MilkdownEditor.tsx's own mount div),
  // not a CSS `direction` override -- it drives the browser's bidi text-run
  // resolution and list/table mirroring during Paged.js's own layout pass,
  // not just final paint. Reassigned unconditionally per request for the
  // same reason as className above: this harness can be long-lived.
  document.body.dir = documentStyle.direction

  // Everything below is inside one try/catch, deliberately, so that no path
  // through this handler — including Polisher cleanup and the DOM lookup
  // below, not just previewer.preview() itself — can leave
  // window.__pagedownResult unset and silently hang the main process's poll
  // loop for its full 10-second deadline. That exact symptom (a real
  // failure looking identical to "no result yet") is what made this task's
  // original CSP bug expensive to diagnose in the first place; leaving any
  // other path capable of the same silent hang would have defeated the
  // point of the fix.
  try {
    // Destroy the previous run's Polisher-injected <style> elements before
    // starting a new one. The reference is cleared FIRST, before calling
    // destroy(): `destroy()` dereferences `this.styleEl` unconditionally
    // (see polisher.js), which is only assigned once a previous preview()
    // call reached its style-setup step — a previous run that threw BEFORE
    // that point leaves a Previewer whose own destroy() call itself throws.
    // Clearing the reference first means that failure mode is handled like
    // any other error in this try block (caught below, published, and not
    // retried against the same broken instance next time) instead of being
    // a separate, uncaught throw sitting outside the try/catch.
    if (activePreviewer) {
      const previous = activePreviewer
      activePreviewer = undefined
      previous.polisher?.destroy()
    }

    const root = document.getElementById('content-root')
    if (!root) {
      // Reachable in practice, not just in theory: Paged.js's own
      // `Previewer.preview()` treats a falsy `content` argument (including
      // `''`, which is exactly what `markdownToHtml('')` or frontmatter-only
      // Markdown produces) as "no content was passed" and falls back to its
      // own `wrapContent()`, which replaces the ENTIRE <body>'s innerHTML
      // with a <template> wrapping the previous body — including this
      // context's own #content-root div, which becomes permanently
      // unreachable via getElementById afterward (template content lives in
      // an inert document fragment, invisible to normal DOM queries on the
      // main document). Without the empty-content short-circuit below, this
      // is exactly how that fallback got triggered, and every subsequent
      // sendDocument() call against the same harness would hit this branch
      // and hang for a full 10 seconds, permanently, since nothing restores
      // #content-root short of a fresh navigation. Throwing here (rather
      // than silently returning) means this failure mode is published as a
      // diagnostic error instead of a silent hang if it is ever reached by
      // some other path in the future.
      throw new Error('content-root element is missing from the document')
    }

    // Clear any previous run's rendered pages before starting a fresh one —
    // Previewer.preview() appends a new `.pagedjs_pages` container into
    // `renderTo` rather than replacing it, so without this, repeated
    // sendDocument() calls against the same harness would accumulate stale
    // page trees underneath the new one instead of replacing them.
    root.innerHTML = ''

    // Empty-content short-circuit: this is the actual fix for the
    // #content-root-disappears failure mode described above. `html === ''`
    // (or whitespace-only) is exactly the falsy value that trips Paged.js's
    // own `if (!content) { content = this.wrapContent() }` fallback inside
    // `previewer.preview()` — never reached here, since we never call
    // preview() with falsy content in the first place. Deliberately does
    // NOT attempt real Paged.js layout for this case (there is nothing to
    // lay out), and deliberately reports `pageCount: 0` rather than
    // guessing at a UX-appropriate "1 blank page" convention — that's a
    // product decision for later tasks (the real editor's empty-document
    // behavior is out of scope here), not something this timing/harness fix
    // should assert on its own authority.
    if (html.trim().length === 0) {
      const result: OutgoingSuccess = {
        type: 'result',
        requestId,
        pageCount: 0,
        ready: true,
        layoutMs: 0,
        diagramBoxes: [],
        imageBoxes: []
      }
      if (currentRequestId === requestId) window.__pagedownResult = result
      return
    }

    // Task 8 / Gate 3: build a DETACHED working copy of the injected HTML
    // and run the mermaid-replacement pass over it BEFORE Paged.js ever
    // sees the document — per the brief ("before invoking
    // Previewer.preview(), find every <pre><code class="language-mermaid">
    // block ... and only then hand the resulting HTML to Paged.js"). Built
    // via `Range.createContextualFragment()` — the EXACT mechanism Paged.js's
    // own `ContentParser.parse()` uses internally for the string-content path
    // (see node_modules/pagedjs/src/chunker/parser.js) — not a <template>
    // element, which this function used in an earlier version of this task
    // and which is a REAL regression, not a cosmetic difference: a
    // <template>'s `.content` DocumentFragment is specced as INERT (images,
    // scripts, etc. inside it never activate/load while they remain there),
    // whereas a Range-created fragment is an ordinary, non-inert
    // DocumentFragment. That inertness silently broke Gate 5's own
    // pre-existing "CSP blocks inline script execution" regression test
    // (phase0/gate5-sandbox.spec.ts) — caught by actually re-running the
    // full Phase 0 suite after this task's changes, not assumed safe: the
    // injected `<img onerror=...>` payload still never executed (CSP's own
    // protection was never actually at risk), but the browser stopped even
    // ATTEMPTING the image load/error cycle in the first place once it was
    // built via an inert template, so the CSP violation this test exists to
    // observe never fired for it to detect — a test that stops observing
    // the thing it claims to verify is exactly the kind of silent gap this
    // project's review rounds have repeatedly caught, so this was fixed
    // rather than left in place with a weakened assertion. Confirmed fixed
    // by re-running gate5-sandbox.spec.ts's full suite after this change:
    // all tests, including the CSP one, pass again.
    // `container` is deliberately passed to previewer.preview() as this DOM
    // NODE below, not serialized back to a string first: ContentParser
    // accepts either a string or a node (same file), and passing the live
    // node is what keeps renderMermaidDiagrams's nonced <style> elements
    // valid — see that function's own comment for why round-tripping
    // through a string would silently break them.
    const container = document.createRange().createContextualFragment(html)
    await renderMermaidDiagrams(container)
    // Synchronous (unlike renderMermaidDiagrams) -- katex.renderToString does
    // no async work, so this needs no `await`. Must still run before
    // buildDocumentStylesheet below, since its return value decides whether
    // that call includes KaTeX's own font-face CSS at all.
    const hasMath = renderMathEquations(container)

    // Settle images BEFORE Paged.js measures anything -- a
    // Range.createContextualFragment fragment is deliberately NON-inert (see
    // the comment above), so its `<img>` elements start fetching the moment
    // the fragment is built, and this only has to wait for those already
    // in-flight requests to finish. Skipping this would hand Paged.js
    // zero-size image boxes and paginate against the wrong geometry.
    await awaitImagesSettled(container)

    const t0 = performance.now()
    const previewer = new Previewer()
    activePreviewer = previewer
    // Document Typography sub-project: buildDocumentStylesheet(geometry, style)
    // (called inline below) is now a real, non-empty stylesheet --
    // markdownToHtml's own sanitize schema still strips any <style>/<link> a
    // document's own Markdown source might contain (src/markdown/pipeline.ts),
    // so this stylesheet is exclusively PageDown's own authored
    // typography/@page rules, never anything document-supplied. Page Geometry
    // Wiring made this a per-request function of the incoming message's own
    // `geometry` (see buildDocumentStylesheet's own comment above) rather
    // than a module-level constant, so a document with non-default page
    // size/orientation/margins produces a genuinely different `@page` rule.
    // Task 5 added the second `style` parameter for the same reason: a
    // document's font-face selection and running header/footer content are
    // just as per-document as its geometry.
    //
    // Passed as `[{ 'document-typography': buildDocumentStylesheet(geometry, documentStyle) }]`,
    // not the bare string: Previewer.preview() spreads its stylesheets array
    // into Polisher.add(...) (node_modules/pagedjs/src/polyfill/previewer.js),
    // and Polisher.add treats any non-object array entry as a URL to fetch
    // via request() (node_modules/pagedjs/src/polisher/polisher.js) -- which
    // this context's `connect-src 'none'` CSP blocks outright, so a raw CSS
    // string here would silently never apply. The object form
    // `{ [name]: cssText }` is what actually passes CSS TEXT directly,
    // matching the shape Previewer's own removeStyles() builds internally
    // from real <style> elements. Precedent: the Gate 4 header/footer probe
    // below already does exactly this (`{ 'gate4-probe-stylesheet': css }`).
    const flow = await previewer.preview(
      container,
      [{ 'document-typography': buildDocumentStylesheet(geometry, documentStyle, hasMath) }],
      root
    )
    const t1 = performance.now()

    // Discard a stale/abandoned run's result rather than publish it — see
    // the comment above `currentRequestId`. A newer 'render' message may
    // have already been dispatched (and possibly already resolved) while
    // this preview() call was still running.
    if (currentRequestId !== requestId) return

    // A second settle pass, against the paginated output rather than the
    // working copy: Paged.js's Layout appends CLONES of the source nodes
    // into its page elements, and a cloned `<img>` starts its own load (from
    // the memory cache, so effectively instant) rather than inheriting the
    // original's completed state. Without this, measureImageBoxes could read
    // `naturalWidth === 0` off a clone that simply hadn't finished yet and
    // report a successfully-served asset as a failure.
    await awaitImagesSettled(root)

    // Re-checked because the settle above is itself an await: a newer
    // 'render' message can be dispatched (and even resolve) while this run
    // is waiting on its images, and publishing here unconditionally would
    // reintroduce exactly the stale-result-clobbering this guard exists to
    // prevent.
    if (currentRequestId !== requestId) return

    const result: OutgoingSuccess = {
      type: 'result',
      requestId,
      pageCount: flow.total,
      ready: true,
      layoutMs: t1 - t0,
      diagramBoxes: measureDiagramBoxes(root),
      imageBoxes: measureImageBoxes(root)
    }
    window.__pagedownResult = result
  } catch (err) {
    // Without this, a rejected/thrown previewer.preview() (which Tasks 7-10
    // will stress with diagrams, oversized tables, and a patched Chunker) —
    // or a thrown Polisher.destroy()/missing #content-root, per the fixes
    // above — never sets window.__pagedownResult at all, and the main
    // process's poll loop just spins for its full 10-second deadline before
    // reporting a generic, undiagnostic timeout. Publishing a distinct
    // error result lets sendDocument (src/main/pagination-window.ts) detect
    // and surface the failure immediately instead of waiting it out.
    if (currentRequestId !== requestId) return // see currentRequestId comment: discard stale errors too
    const result: OutgoingError = {
      type: 'error',
      requestId,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err)
    }
    window.__pagedownResult = result
  }
})

// --- Task 7 / Gate 7: incremental re-layout spike -------------------------
//
// Investigates whether Paged.js's Chunker can resume pagination from a
// retained breakToken/page boundary instead of always re-laying-out a
// document from scratch. Read directly from the installed Paged.js source
// (node_modules/pagedjs/src/chunker/chunker.js, layout.js, page.js,
// breaktoken.js — pagedjs@0.4.3):
//
// - `Chunker.layout(content, startAt)` (chunker.js) is a generator that
//   DOES accept a `startAt` breakToken and resumes from it — this is not a
//   hypothetical/patched capability, it's the exact mechanism Paged.js uses
//   internally, in `flow()`'s own cancel/retry loop (chunker.js:172-176):
//   `let rendered = await this.render(parsed, this.breakToken); while
//   (rendered.canceled) { this.start(); rendered = await
//   this.render(parsed, this.breakToken); }`. When a page overflows during
//   INITIAL layout, `addPage()`'s `onOverflow` handler (chunker.js, inside
//   `addPage`) calls `this.stop()` and sets `this.breakToken =
//   overflowToken` (both reachable/executed — chunker.js:439-442), which
//   makes the in-flight `render()` call observe `this.stopped` and resolve
//   as `{ done: true, canceled: true }`; `flow()`'s loop above then calls
//   `this.render(parsed, this.breakToken)` AGAIN, resuming from the
//   retained token against the SAME `parsed` content object. (`addPage()`'s
//   onOverflow ALSO contains a second, more direct-looking
//   `this.render(this.source, this.breakToken)` call of its own,
//   chunker.js:447-459 — traced this closely and confirmed it is dead code:
//   it's gated on `this.rendered === true`, immediately after an earlier
//   `if (this.rendered) { return; }` early-out in the same synchronous
//   callback, chunker.js:431-434 — nothing sets `this.rendered` in between,
//   so that branch can never execute. `flow()`'s retry loop above, not this
//   second call, is the real internal precedent for what this spike does.)
// - The critical constraint: a BreakToken (breaktoken.js) carries a live DOM
//   `node` reference (plus a text `offset`), not a serializable/portable
//   position. `Chunker.flow()` always creates a brand-new `ContentParser`
//   (parser.js) for whatever content it's given — `parsed = new
//   ContentParser(content); this.source = parsed;` — discarding any
//   previous tree. A NEW ContentParser run assigns entirely NEW `data-ref`
//   UUIDs (`ContentParser.addRefs`) to entirely NEW DOM nodes, so a
//   breakToken captured from run N's tree has no meaningful counterpart in
//   run N+1's freshly-reparsed tree — there is no "look up this breakToken
//   in the new tree" operation anywhere in Paged.js.
// - `Layout.renderTo()` (layout.js) walks the tree with `walk(start,
//   limiter)` (utils/dom.js), using real `node.childNodes` /
//   `node.nextSibling` / `node.parentNode` navigation bounded by identity
//   (`node === limiter`) — it requires `start` to be a genuine descendant of
//   `source`. `Layout.append()` calls `rebuildAncestors(node)`
//   (utils/dom.js) when a node's rendered parent isn't already in the
//   destination page, walking the REAL ancestor chain to reconstruct
//   wrapping elements (list nesting, table rows, etc.) — this only produces
//   correct output when `node`'s ancestors are the genuine, original
//   ancestors, not a freshly-reparsed lookalike.
//
// Conclusion this spike tests for real: resumption is possible ONLY by
// keeping the SAME Chunker instance and the SAME live `chunker.source` DOM
// tree across an edit — i.e. by mutating that tree in place for the edited
// region (leaving the untouched prefix's nodes, and the breakToken's node,
// completely alone) and then calling `chunker.removePages(fromIndex)` +
// `chunker.render(chunker.source, breakToken)` directly, bypassing
// `flow()`/`preview()` entirely for the resumed call. `render` and
// `removePages` are ordinary (non-underscored) Chunker methods, so no
// source patching of Paged.js itself was required to call them — but doing
// so is reaching past Paged.js's only documented entry point (`flow()`, via
// `Previewer.preview()`) to call methods that exist for Paged.js's own
// internal reuse, not for external callers, and depends on undocumented
// internals (`data-ref` identity, live node identity, ancestor-rebuild
// behavior) that aren't part of any stable contract. The "same instance"
// requirement itself is reasoned from the source above (BreakToken.node's
// live-identity dependency, ContentParser reparsing fresh data-ref UUIDs
// every flow() call), not independently confirmed here by a negative
// control (e.g. a fresh Chunker fed a retained token from another
// instance) — this spike's phases 1/2 both always run against the ONE
// gate7Previewer instance, so that specific failure mode was never
// deliberately provoked and observed. See
// docs/superpowers/plans/2026-07-25-phase0-findings.md's Gate 7 section for
// the full writeup and phase0/gate7-incremental-relayout.spec.ts for the
// two-phase experiment that exercises this against very-long.md.
//
// Phase 1 (below): full paginate of the original document, capturing the
// breakToken at `targetPageIndex` via the `afterPageLayout` hook, then an
// immediate resume-with-NO-edit as the most basic possible sanity check
// that bypassing flow() this way even produces correct output at all.
// Phase 2 (a later message, same render-context module instance so
// `gate7Previewer`/`gate7BreakToken` below are still alive): a real edit —
// a new text node appended to an existing paragraph strictly AFTER the
// retained breakToken, directly on the live `chunker.source` tree — then a
// real resume, timed against a from-scratch full layout of the equivalently
// edited document for comparison.

let gate7Previewer: InstanceType<typeof Previewer> | undefined
let gate7BreakToken: unknown
let gate7TargetPageIndex = 0
let gate7Root: HTMLElement | undefined

// Walks `node` up via `.parentNode` until it reaches a direct child of
// `root` (chunker.source is a flat DocumentFragment of top-level
// h2/p/p/h2/p/p/... siblings for this corpus — see
// phase0/corpus/generate-long.ts — so this is at most a couple of hops for
// a breakToken whose node is a paragraph's text node).
function findTopLevelAncestor(node: Node, root: Node): Node {
  let current = node
  while (current.parentNode && current.parentNode !== root) {
    current = current.parentNode
  }
  return current
}

// Walks backward from `node`'s top-level position to the nearest preceding
// "## Section N" heading, to discover (measured, not estimated from the
// corpus's known sections-per-page ratio) which section a captured
// breakToken actually landed in.
function findSectionNumberNear(node: Node, root: Node): number | null {
  let el: Node | null = findTopLevelAncestor(node, root)
  while (el) {
    if (el.nodeType === 1 && (el as HTMLElement).tagName === 'H2') {
      const match = /Section (\d+)/.exec((el as HTMLElement).textContent ?? '')
      if (match) return Number(match[1])
    }
    el = el.previousSibling
  }
  return null
}

// Finds the first <p> following the "## Section N" heading with the given
// number, for the phase-2 edit target. Exact match on trimmed textContent
// (not a substring match) so "Section 6" can't accidentally match inside
// "Section 65" etc.
function findParagraphForSection(sectionNumber: number, root: ParentNode): HTMLElement | null {
  const headings = Array.from(root.querySelectorAll('h2')) as HTMLElement[]
  const heading = headings.find((h) => (h.textContent ?? '').trim() === `Section ${sectionNumber}`)
  if (!heading) return null
  let sibling: Element | null = heading.nextElementSibling
  while (sibling && sibling.tagName !== 'P') {
    sibling = sibling.nextElementSibling
  }
  return sibling as HTMLElement | null
}

function makeOffscreenRoot(): HTMLElement {
  // Must be attached to `document` (not a detached fragment) for Paged.js's
  // layout measurement (getBoundingClientRect/ResizeObserver) to produce
  // real, non-zero sizes — positioned off the visible viewport rather than
  // `display: none` (a display:none subtree also measures as zero-size).
  const root = document.createElement('div')
  root.style.position = 'fixed'
  root.style.left = '-99999px'
  root.style.top = '0'
  document.body.appendChild(root)
  return root
}

window.addEventListener(
  'message',
  async (event: MessageEvent<Gate7Phase1Message | Gate7Phase2Message>) => {
    if (event.data?.type === 'gate7-phase1') {
      const { requestId, html, targetPageIndex } = event.data
      try {
        const previewer = new Previewer()

        let capturedBreakToken: unknown
        let capturedAtPage = -1
        previewer.chunker.hooks.afterPageLayout.register(
          (_pageElement: HTMLElement, page: { position: number }, breakToken: unknown) => {
            if (capturedAtPage === -1 && page.position === targetPageIndex - 1) {
              capturedBreakToken = breakToken
              capturedAtPage = page.position
            }
          }
        )

        const root = makeOffscreenRoot()

        const t0 = performance.now()
        const flow = await previewer.preview(html, [], root)
        const t1 = performance.now()

        if (!capturedBreakToken) {
          throw new Error(
            `Never captured a breakToken at page index ${targetPageIndex - 1} — document only produced ${flow.total} pages`
          )
        }

        const chunker = previewer.chunker
        const sectionNumberAtBreakpoint = findSectionNumberNear(
          (capturedBreakToken as { node: Node }).node,
          chunker.source
        )

        const baselinePagesText: string[] = chunker.pages
          .slice(targetPageIndex)
          .map((p: { element: HTMLElement }) => p.element.textContent ?? '')

        // The resume-no-edit sanity check: the same removePages(fromIndex)
        // + render(source, breakToken) pair `flow()`'s own cancel/retry
        // loop uses internally (see the block comment above), called from
        // outside that loop instead of from within it, on UNCHANGED
        // content — the simplest possible test of whether bypassing
        // flow() this way produces correct output at all. Excluded from
        // both this timing and the phase-2 timings below: the real cost
        // of `removePages(targetPageIndex)` itself (destroying the
        // pages being replaced, 172 of them here — was 147 before Task 10's
        // KeepWithNextHandler shifted very-long.md's page count) — see this
        // task's findings doc for why that's a documented, not re-measured,
        // simplification.
        chunker.removePages(targetPageIndex)
        const t2 = performance.now()
        await chunker.render(chunker.source, capturedBreakToken)
        const t3 = performance.now()

        const resumedNoEditPagesText: string[] = chunker.pages
          .slice(targetPageIndex)
          .map((p: { element: HTMLElement }) => p.element.textContent ?? '')

        // Persist for the 'gate7-phase2' message — this module stays loaded
        // (and its top-level state alive) between postMessage events on the
        // same render-context page, exactly like `activePreviewer` above.
        gate7Previewer = previewer
        gate7BreakToken = capturedBreakToken
        gate7TargetPageIndex = targetPageIndex
        gate7Root = root

        const result: Gate7Phase1Success = {
          type: 'gate7-phase1-result',
          requestId,
          ok: true,
          fullOriginalMs: t1 - t0,
          totalPagesOriginal: flow.total,
          sectionNumberAtBreakpoint,
          resumeNoEditMs: t3 - t2,
          totalPagesAfterResumeNoEdit: chunker.total,
          baselinePagesText,
          resumedNoEditPagesText
        }
        window.__pagedownGate7Result = result
      } catch (err) {
        const result: Gate7Error = {
          type: 'gate7-error',
          requestId,
          ok: false,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err)
        }
        window.__pagedownGate7Result = result
      }
      return
    }

    if (event.data?.type === 'gate7-phase2') {
      const { requestId, editSectionNumber, markerText, editedHtml, targetPageIndex } = event.data
      try {
        if (!gate7Previewer || !gate7BreakToken) {
          throw new Error('gate7-phase2 received before a successful gate7-phase1 run')
        }
        if (targetPageIndex !== gate7TargetPageIndex) {
          throw new Error(
            `gate7-phase2 targetPageIndex (${targetPageIndex}) does not match the value phase 1 captured its breakToken for (${gate7TargetPageIndex})`
          )
        }

        const chunker = gate7Previewer.chunker

        // Captured BEFORE the edit/resume below touches anything — this is
        // the retained prefix (pages before targetPageIndex) exactly as it
        // stood at the end of phase 1, for a direct comparison against the
        // control run's own same-numbered pages further down. `removePages`
        // never mutates anything below `fromIndex`, so this snapshot and
        // the post-resume `chunker.pages[0..targetPageIndex)` are the same
        // pages either way — this array exists as its own explicit
        // equivalence input, not because the resume could have touched it.
        const resumedPrefixPagesText: string[] = chunker.pages
          .slice(0, targetPageIndex)
          .map((p: { element: HTMLElement }) => p.element.textContent ?? '')

        const paragraph = findParagraphForSection(editSectionNumber, chunker.source as ParentNode)
        if (!paragraph) {
          throw new Error(`Could not find a paragraph for Section ${editSectionNumber} to edit`)
        }
        // The actual edit: append a new TEXT node to an EXISTING paragraph,
        // directly on the SAME live chunker.source tree that produced the
        // retained breakToken — not a re-parse of new HTML. A plain text
        // node needs no `data-ref` bookkeeping (only ELEMENT nodes get one,
        // via ContentParser.addRefs), so this is the simplest edit that
        // stays entirely within Paged.js's existing node-identity
        // assumptions. `editSectionNumber` is chosen by the caller to be
        // safely after `gate7TargetPageIndex`'s breakToken (see the spec
        // file), so the retained prefix (pages before the breakpoint) is
        // genuinely untouched by this mutation.
        paragraph.appendChild(document.createTextNode(' ' + markerText))

        chunker.removePages(targetPageIndex)
        const t0 = performance.now()
        await chunker.render(chunker.source, gate7BreakToken)
        const t1 = performance.now()

        const resumedWithEditPagesText: string[] = chunker.pages
          .slice(targetPageIndex)
          .map((p: { element: HTMLElement }) => p.element.textContent ?? '')
        const totalPagesAfterEdit = chunker.total

        // Tear down phase 1's Previewer's Polisher-injected <style>
        // elements before creating a second, independent Previewer below —
        // same reasoning as the regular 'render' handler's own
        // activePreviewer cleanup above (neither Previewer nor Polisher
        // ever calls destroy() on its own, so without this, two Previewers'
        // worth of base/computed pagination styles would coexist in <head>
        // while the control run measures its own layout, which is exactly
        // the kind of cross-run contamination that would make this spike's
        // own control comparison suspect). Safe to do now: everything this
        // function still needs from `gate7Previewer`/`chunker` above
        // (resumedWithEditPagesText, totalPagesAfterEdit) has already been
        // read into plain values.
        gate7Previewer.polisher?.destroy()

        // Control: a completely independent, from-scratch Previewer/Chunker
        // laying out the equivalently-edited FULL document (built by the
        // main process via the real markdownToHtml pipeline on an edited
        // markdown string — see the spec file), for direct comparison
        // against the resumed run above. Note this measures fullEditedMs
        // against a DOM that still holds phase 1's ~322 attached page
        // elements (was ~297 before Task 10's KeepWithNextHandler shifted
        // very-long.md's page count — see the findings doc's Gate 2/Gate 7
        // update notes) (gate7Root isn't removed until after this call) — a
        // second, independent layout/paint surface sharing the page with a
        // large already-rendered tree, not a pristine one. Not corrected
        // for here; see the findings doc for why this and the excluded
        // `removePages` cost above are judged to roughly offset rather than
        // re-measured.
        const controlRoot = makeOffscreenRoot()
        const controlPreviewer = new Previewer()
        const t2 = performance.now()
        const controlFlow = await controlPreviewer.preview(editedHtml, [], controlRoot)
        const t3 = performance.now()
        const controlPagesText: string[] = controlPreviewer.chunker.pages
          .slice(targetPageIndex)
          .map((p: { element: HTMLElement }) => p.element.textContent ?? '')
        // The control run's own pages before targetPageIndex — unaffected
        // by the edit (which lands well downstream, at editSectionNumber),
        // so this is directly comparable to `resumedPrefixPagesText` above:
        // does the RETAINED prefix (never touched by the resumed run at
        // all) actually match what a from-scratch layout of the same
        // unedited prefix content produces, rather than just assuming it
        // does because the resumed run "didn't touch it"?
        const controlPrefixPagesText: string[] = controlPreviewer.chunker.pages
          .slice(0, targetPageIndex)
          .map((p: { element: HTMLElement }) => p.element.textContent ?? '')

        controlRoot.remove()
        gate7Root?.remove()
        gate7Previewer = undefined
        gate7BreakToken = undefined
        gate7Root = undefined

        const result: Gate7Phase2Success = {
          type: 'gate7-phase2-result',
          requestId,
          ok: true,
          resumeWithEditMs: t1 - t0,
          totalPagesAfterEdit,
          resumedWithEditPagesText,
          resumedPrefixPagesText,
          fullEditedMs: t3 - t2,
          totalPagesEdited: controlFlow.total,
          controlPagesText,
          controlPrefixPagesText
        }
        window.__pagedownGate7Result = result
      } catch (err) {
        const result: Gate7Error = {
          type: 'gate7-error',
          requestId,
          ok: false,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err)
        }
        window.__pagedownGate7Result = result
      }
    }
  }
)

// --- Task 9 / Gate 4: header/footer artifact-vs-content tagging probe -----
// See the block comment above the Gate4Probe*/`__pagedownGate4ProbeResult`
// type declarations for why this exists at all. Mirrors the regular
// 'render' handler's own try/catch-everything/discard-stale-results
// structure (same rationale: a silent hang here is exactly as expensive to
// diagnose as it was for that handler — see this file's Task 6 commentary),
// deliberately without the Mermaid preprocessing pass or the empty-content
// short-circuit, neither of which any caller of this probe needs.
window.addEventListener('message', async (event: MessageEvent<Gate4ProbeMessage>) => {
  if (event.data?.type !== 'gate4-header-footer-probe') return

  const { requestId, html, css } = event.data
  currentRequestId = requestId

  try {
    if (activePreviewer) {
      const previous = activePreviewer
      activePreviewer = undefined
      previous.polisher?.destroy()
    }

    const root = document.getElementById('content-root')
    if (!root) {
      throw new Error('content-root element is missing from the document')
    }
    root.innerHTML = ''

    const container = document.createRange().createContextualFragment(html)
    const previewer = new Previewer()
    activePreviewer = previewer
    // The one thing this probe exists to do differently from the regular
    // 'render' handler: a REAL, non-empty stylesheet (an object keyed by a
    // synthetic href, exactly the shape Previewer.preview()/Polisher.add()
    // already expect — see previewer.js's own `removeStyles()`, which
    // builds this same `{ [href]: cssText }` shape from real `<style>`
    // elements) so Paged.js's `@page`-rule handler (atpage.js) actually has
    // something to read and populate the per-page margin boxes with.
    const flow = await previewer.preview(container, [{ 'gate4-probe-stylesheet': css }], root)

    if (currentRequestId !== requestId) return
    const result: Gate4ProbeSuccess = {
      type: 'gate4-header-footer-probe-result',
      requestId,
      ok: true,
      pageCount: flow.total
    }
    window.__pagedownGate4ProbeResult = result
  } catch (err) {
    if (currentRequestId !== requestId) return
    const result: Gate4ProbeError = {
      type: 'gate4-header-footer-probe-error',
      requestId,
      ok: false,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err)
    }
    window.__pagedownGate4ProbeResult = result
  }
})
