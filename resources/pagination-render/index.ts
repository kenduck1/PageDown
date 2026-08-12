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
import { renderMermaidToSvg, MERMAID_LABEL_FONT_FAMILY } from '../../src/diagrams/render-mermaid'
import { registerBreakHandlers } from '../../src/pagination/break-handlers'
import { hoistInlineStyleAttributes, reattachNoncedStyles } from './nonce-style-hoisting'
import { renderMathEquations, buildKatexFontFaceCss } from './katex-render'
import documentTypographyCss from '../../src/typography/document-typography.css'
import sourceSerif4Base64 from '../../src/renderer/src/assets/fonts/source-serif-4-variable.woff2'
import interVariableBase64 from '../../src/renderer/src/assets/fonts/inter-variable.woff2'
import sourceCodeProBase64 from '../../src/renderer/src/assets/fonts/source-code-pro-variable.woff2'
import { DPI, type PageGeometry } from '../../src/typography/page-geometry'
import {
  buildRunningContentCss,
  documentStyleClasses,
  type DocumentStyle
} from '../../src/typography/document-style'
import type { RenderRequestMessage } from '../../src/pagination/render-message'
import { clampPageIndex, pickCurrentPage, type PageNavState } from '../../src/pagination/page-nav'
// The SAME fit arithmetic and the SAME argued floor Split mode's editor pane
// uses, deliberately shared rather than re-derived -- the two panes sit side
// by side at the same divider position showing the same document at the same
// 14px baseline, so a second floor here would mean one pane going legible
// while the other went small, at a boundary neither of them explains. Its home
// under src/renderer/src/lib is historical (it was written for the editor pane
// first); it is pure, dependency-free arithmetic, and importing it here is the
// same cross-tree reach this file already makes for the bundled font assets
// above. See that module's own header for the sandbox-bundling contract.
import { computeFitScale } from '../../src/renderer/src/lib/fit-scale'
import {
  readPageBlockIndices,
  recoverPageBreaks,
  type PageBreakPosition
} from '../../src/pagination/page-breaks'

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
//
//      A THIRD @font-face -- Source Code Pro, the fix for audit finding
//      A2's cross-machine determinism bug (--font-mono used to be an
//      unbundled system stack: Menlo/Consolas/whatever fontconfig picks) --
//      joins these two, gated on `hasCode` rather than on a style choice
//      (there's no "which mono face" question the way there is a "which
//      body face" one, so `hasCode` is a boolean, not a third branch of the
//      `fontFace` ternary below). Same loadFonts() cost argument as above,
//      same shape as `hasMath` gating KaTeX's font CSS a few lines down --
//      a document with no code (`pre`/`code` elements) pays nothing.
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
//
// `hasCode` (audit finding A2 fix) is the identical pattern one level up:
// gates whether the vendored Source Code Pro face is registered at all.
// Computed by the 'render' handler as `container.querySelector('pre, code')
// !== null`, checked AFTER both renderMermaidDiagrams and renderMathEquations
// have already run and replaced their own `pre > code.language-mermaid` /
// `code.language-math-*` placeholders with real SVG/KaTeX output -- so this
// never false-positives on a diagram- or equation-only document that
// contains no genuine author-written code. Every real `pre`/`code` element
// that DOES remain (a fenced block, labeled or not, or an inline `` `span` ``)
// renders through --font-mono per document-typography.css, so any one of
// them is sufficient to justify paying the decode cost.
function buildDocumentStylesheet(
  geometry: PageGeometry,
  style: DocumentStyle,
  hasMath: boolean,
  hasCode: boolean
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

  // Audit finding A2 fix. See this file's own top-of-file comment (piece 2)
  // and --font-mono's comment just below for the full writeup; this is the
  // hasCode-gated counterpart to the body-font ternary immediately above.
  const monoFontFace = hasCode
    ? `@font-face {
  font-family: 'Source Code Pro';
  font-style: normal;
  font-weight: 200 900;
  font-display: block;
  src: url(data:font/woff2;base64,${sourceCodeProBase64}) format('woff2-variations');
}`
    : ''

  return `
:root {
  --font-serif: 'Source Serif 4', serif;
  /* Audit finding A2, FIXED (previously a known, deliberate, documented
     exception -- see git history / commit be38f55's own trailer for the
     original deferred writeup this replaces). Used to be an UNBUNDLED
     SYSTEM STACK: 'ui-monospace, SFMono-Regular, Menlo, Consolas,
     monospace' -- Menlo ships on macOS, Consolas on Windows, Linux
     resolves the generic keyword to whatever fontconfig picks. Every
     fenced code block (and every inline inline-code span) measured in a
     different face per platform, so a code-containing document's page
     count was host-dependent -- the identical failure mode Mermaid's label
     font had (fixed by commit be38f55, same session), and identical to why
     the design doc chose Electron over Tauri in the first place: this app's
     whole determinism argument rests on every render running against
     bundled assets, never a host default.

     NOTE: this comment lives INSIDE a JS template literal (the CSS text
     buildDocumentStylesheet returns), so it deliberately never uses a
     backtick character anywhere in its own prose, including for inline
     code terms that would normally get one -- a literal backtick here
     would terminate the surrounding template literal and fail to compile.

     Fixed the same way: point the token at a real, vendored, OFL-licensed
     face (this file's own monoFontFace local, hasCode-gated like
     buildKatexFontFaceCss's hasMath gating) instead of a name the host
     happens to resolve. Source Code Pro was chosen over two other
     candidates, measured rather than estimated (latin subset, variable
     weight axis, actually fetched and sized): JetBrains Mono, at 40,404
     bytes on disk / 53,872 base64 characters once inlined, is nearly
     double the cost for no correctness benefit over Source Code Pro's
     22,044 / 29,392. KaTeX's already-bundled KaTeX_Typewriter-Regular
     (13,568 / 18,091, zero new bytes) was the cheapest option and still
     disqualified, twice over: single weight (no real bold -- the
     highlight.js theme below sets a bold font-weight on .hljs-strong/
     .hljs-section) and roman-only (no real italic -- the same theme sets
     an italic font-style on .hljs-emphasis), and it is a MATH face
     (Computer Modern Typewriter), not a code face, so reusing it here
     would be borrowing KaTeX's own visual identity for an unrelated
     surface. Source Code Pro's variable weight axis gives a genuine bold
     instance rather than Chromium's synthetic-bold thickening; italic
     still falls back to Chromium's synthetic-oblique transform (this
     vendored file is upright-only, matching the exact single file already
     measured above) -- but that fallback is itself fully deterministic,
     computed by the browser engine Electron pins, never by a host font, so
     it doesn't reopen the bug this fix exists to close.

     src/renderer/src/assets/base.css carries the matching --font-mono copy
     for the Milkdown mount (plus the real, Vite-bundled @font-face this
     sandboxed context's own base64 data: URI mirrors) -- the two MUST stay
     byte-for-byte identical strings, not just resolve to the same face by
     different means: src/typography/document-typography.test.ts's
     cross-check enforces exactly that, because a one-sided edit here would
     trade a cross-machine divergence for a same-machine editor-vs-
     paginator one, which would break Gate 10's 0.000px parity -- strictly
     worse than the bug being fixed. The plain monospace generic family is
     kept as the sole fallback (matching --font-serif/--font-doc-sans's own
     "pinned face, one generic keyword, nothing else" pattern) rather than
     restating the old system names, since Chunker.loadFonts() (documented
     at length where buildDocumentStylesheet is defined below) awaits the
     real face before anything is measured whenever hasCode is true, so the
     fallback is never actually exercised by real layout.

     Corpus page counts (Gates 2/4/6) were re-measured after this fix, per
     the same "check, don't assume" discipline commit be38f55 used for
     Mermaid: see that gate's own committed results for whether any moved
     and why -- none of the pinned corpus fixtures contain a real (non-
     Mermaid-consumed) fenced code block or backtick span long enough to
     cross a page boundary, so a lack of movement here is an expected,
     verified result, not a skipped check. */
  --font-mono: 'Source Code Pro', monospace;
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

${monoFontFace}

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
// unaffected — nothing here ever nonces a <script>), and `stripExternalCssRefs`
// (Task 8 / Gate 3) already strips `@import`/external `url(...)` from
// exactly this text before it reaches the nonced style block, unconditionally
// — this is now the SOLE defense against this specific vector (a CSS
// `background`/`url()` fetch as a tracking-pixel-style beacon), not backed
// up by `img-src` the way an earlier version of this comment claimed:
// img-src now permits `https:`/`http:` unconditionally as a permanent
// backstop for the remote-image-consent feature (see pagination-window.ts's
// CSP_POLICY_TEMPLATE), so it no longer blocks this class of request on its
// own. `connect-src 'none'` / `default-src 'self'` are unaffected and still
// block every OTHER egress path a raw CSS injection could exploit (font
// fetches, `@font-face src`, etc.). This is also, per the design
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
  // Editor page-break guides (design:50-58, the master design doc's own
  // "review's highest-value finding"): one entry per page TRANSITION, saying
  // which top-level source block the break landed at or inside. Recovered
  // from the `data-pd-block` stamps markdownToHtml puts on the pre-pagination
  // HTML, which survive into the paginated output because Paged.js's Chunker
  // clones and relocates REAL DOM nodes rather than re-serializing.
  //
  // Read from the paginated DOM under `root` for the same reason
  // `diagramBoxes`/`imageBoxes` are, and NOT from Paged.js's own
  // `afterPageLayout`/`breakToken` hook, which is what design:57 originally
  // called for. The design doc's own second-review correction (design:60)
  // already establishes why that hook is the wrong instrument: a `breakToken`
  // points into RENDERED text (`node`/`offset` after `**bold**` has become
  // `bold`), so it can only be turned into a source position by machinery
  // this codebase does not have. Reading the stamps back out of the finished
  // pages needs none of it and answers the block-granularity question exactly.
  // `[]` for a single-page document (no transitions) and for the
  // empty-content short-circuit below.
  pageBreaks: PageBreakPosition[]
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
// Paged.js's own per-page wrapper class. Named once and shared with the
// page-break recovery in the 'render' handler below so the two cannot drift
// apart -- they have to agree on what counts as a page, or the recovered
// break positions would describe a different page numbering than the one
// page navigation scrolls to.
const PAGE_SELECTOR = '.pagedjs_page'

function readPageElements(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(PAGE_SELECTOR))
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

// --- Split-mode fit-to-width for the PREVIEW pane -------------------------
//
// Split mode's editor pane already scales its fixed-width page card down to
// fit (src/renderer/src/lib/fit-scale.ts). The preview pane beside it did not,
// and that asymmetry was measured rather than assumed: at the divider position
// the editor's own fit-to-width documents as its success case, this context
// showed roughly 193px of an 816px page -- about 24% -- i.e. the fix for one
// pane had made the other one relatively worse.
//
// MECHANISM: CSS `zoom` on #content-root, applied AFTER pagination, driven by
// this context's own content-box width. Three alternatives were considered and
// each is rejected for a concrete reason, recorded here because every one of
// them looks more natural than what is actually correct:
//
//  1. `webContents.setZoomFactor()` on the preview's own view, from main. The
//     obvious candidate, genuinely available, and with a real advantage over
//     what is built here: browser zoom changes the CSS-px -> device-px
//     mapping WITHOUT changing what the page's own layout reports, so
//     measurements and pagination would stay in the one coordinate space
//     every other surface already speaks. It is rejected anyway, on a
//     MEASURED fact rather than on the documentation alone.
//
//     Chromium's zoom policy is SAME-ORIGIN -- Electron's own `setZoomLevel`
//     docs say it "propagates across all instances of windows with the same
//     domain" (node_modules/electron/electron.d.ts) -- and every pagination
//     harness in this app loads the identical
//     `pagedown-render://render/index.html` in the identical session
//     (ensureRenderInfraRegistered). Confirmed against this app's own real
//     harnesses rather than inferred: `setZoomFactor(0.7)` on one harness
//     read back 0.7 on a SECOND, already-live, independent harness AND on a
//     THIRD created afterwards --
//
//       { sameSession: true, sameOrigin: true, zoomA: 1, zoomC: 1 }
//       -> setZoomFactor(0.7) on A ->
//       { zoomA: 0.7, zoomC_existingOtherHarness: 0.7,
//         zoomD_freshHarnessCreatedAfter: 0.7 }
//
//     That third value is the one that settles it: PDF export builds a FRESH
//     harness per call (pdf-exporter.ts's withFreshHarness), so a user who
//     had merely OPENED Split mode would export every subsequent PDF, and
//     render every subsequent thumbnail, at the preview pane's scale --
//     silently breaking "the preview and the exported PDF are pixel-identical
//     by construction", for the rest of the session. A preview that is
//     cropped is an annoyance; a PDF whose geometry silently follows a
//     divider position is a correctness bug.
//
//     It would also feed back on itself here: zooming a webContents changes
//     its own `innerWidth`, which is the input this scale is computed from.
//  2. Sending a smaller `geometry`. That is not scaling, it is re-paginating
//     at a different page size: page counts would move as the user dragged
//     the divider.
//  3. `transform: scale()`. Same reason the editor pane rejected it: a
//     transform does not participate in layout, so this context's own scroll
//     extents (and therefore `scrollIntoView`, and `pickCurrentPage`'s
//     viewport-relative page tops) would still describe the unscaled page.
//     `zoom` participates, so page navigation above needs no change at all.
//
// The floor is MIN_FIT_SCALE, unchanged and shared. Its argument transfers
// verbatim: below the floor the pane scrolls anyway, so shrinking further buys
// less scrolling while still scrolling, at the cost of the only thing left
// worth optimising -- whether the text can be read. It binds harder here than
// on the editor side, because at the default 50/50 divider the preview pane is
// the same ~389px and a page needs ~0.47 to fit it: the cost is that the
// preview still scrolls horizontally at the default divider, showing ~68% of
// the page instead of ~48%, and only genuinely fits once the divider is
// dragged to give the preview about three quarters of the canvas. Fitting
// exactly at 389px would mean 6.6px body text, which is not a preview of
// anything.
//
// CONSEQUENCE FOR ANYTHING THAT MEASURES THIS CONTEXT FROM OUTSIDE, and it is
// not obvious enough to leave unwritten: `zoom` participates in layout, so
// `getBoundingClientRect()` in here comes back ALREADY multiplied by the
// scale (a 794px box under 0.7 reports 555.80), while `offsetWidth` and
// `getComputedStyle().width` still report the document-space value. Several
// gates probe this DOM through `executeJavaScript` asking document-space
// questions ("is an A4 page 794px wide?"); they divide by the live scale via
// phase0/gate-geometry.ts's PREVIEW_DOCUMENT_SCALE_JS. A new probe that
// forgets to will silently measure the divider position instead of the
// document.
let previewFitStyle: HTMLStyleElement | undefined

// The page width the CURRENT render is being fitted to, or 0 for "this
// caller did not ask to be fitted" -- which is every harness except Split
// mode's live preview. Module state rather than a parameter because the input
// that changes most often (the viewport, via a divider drag) arrives as a
// `resize` event with no render attached to it.
let previewFitPageWidthPx = 0

// The two rules that make the pane's width a MEASURABLE, STABLE number, as
// opposed to the scale itself. Both exist only in a fitting harness, and both
// are load-bearing:
//
//   `scrollbar-gutter: stable` closes a real feedback loop -- a document short
//   enough to lose its vertical scrollbar widens the content box, which raises
//   the scale, which makes the content taller, which brings the scrollbar
//   back. The editor pane pins its own copy of this loop with the same
//   declaration.
//
//   `body { margin: 0 }` reclaims the UA's default 8px-a-side body margin.
//   Invisible here (this context paints white on white, so that margin is not
//   a visible gutter), and worth 16px of a pane where 16px decides the
//   outcome: at the widest divider setting the pane is 585px, a fitted Letter
//   page at the 0.71 the arithmetic wants is 579.4px, and the same page at the
//   0.70 the margin forces it down to is 571.2px inside a 569px box -- i.e.
//   keeping the margin turns "it fits" into "it overflows by 2px", which is
//   the whole user-visible point of the widest setting.
//
// Deliberately NOT emitted for a non-fitting harness. A thumbnail captures a
// view sized to exactly one page, so changing its body margin would move what
// that capture frames.
const PREVIEW_FIT_CHROME_CSS = 'html { scrollbar-gutter: stable; }\nbody { margin: 0; }'

function applyPreviewFitScale(): void {
  const fitting = previewFitPageWidthPx > 0
  // Nothing to say and nothing said before: stay out of <head> entirely, so a
  // headless harness never grows an element it has no use for.
  if (!fitting && !previewFitStyle) return
  if (!previewFitStyle) {
    // `document.createElement`, so the nonce shim at the top of this file
    // stamps it -- an inline `style` attribute would be blocked outright by
    // this context's style-src. Created once and rewritten thereafter, the
    // same shape as applyMermaidErrorSizes, so a long-lived harness cannot
    // accumulate one of these per render.
    previewFitStyle = document.createElement('style')
    document.head.appendChild(previewFitStyle)
  }

  // TWO WRITES, AND THE ORDER IS THE POINT. The chrome rules above change the
  // very box this function then measures, so writing them together with the
  // scale would compute the first fitting render's scale against the
  // pre-reset, 16px-narrower body -- and then never revisit it until the next
  // resize, since nothing else invalidates it. Writing the chrome first and
  // reading `clientWidth` second is what makes the measurement see the reset:
  // `clientWidth` is a forced-layout property, so the read flushes the style
  // change rather than observing a stale box.
  previewFitStyle.textContent = PREVIEW_FIT_CHROME_CSS

  // `document.body.clientWidth`, and BOTH of the things it is not are
  // deliberate. Not `window.innerWidth`: that is a border-box measurement
  // still containing a classic vertical scrollbar's track, so fitting against
  // it would overflow by the scrollbar's width on Windows/Linux while being
  // silently correct on macOS's overlay scrollbars -- exactly the
  // platform-split bug computeFitScale's own doc comment warns its callers
  // about. And not `documentElement.clientWidth` either: that is the viewport,
  // whereas #content-root is a child of <body> and gets whatever <body>'s own
  // content box is -- reading the body keeps this correct if <body> ever gains
  // padding or a border, without another round of this same lesson. It cannot
  // become self-referential: the `zoom` below is on #content-root, a
  // DESCENDANT, so it never moves the box being measured.
  const scale = fitting ? computeFitScale(document.body.clientWidth, previewFitPageWidthPx) : 1
  previewFitStyle.textContent = `${PREVIEW_FIT_CHROME_CSS}\n#content-root { zoom: ${scale}; }`
}

// A divider drag resizes this view through WebContentsView.setBounds() and
// nothing re-renders, so `resize` is the only signal that the fit needs
// recomputing. Pure CSS from here: no re-pagination, no IPC, and no round
// trip through the harness's serialized work queue -- which is what makes
// this cheap enough to run on every frame of a drag.
window.addEventListener('resize', applyPreviewFitScale)

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

// Carried by the per-diagram error placeholder ALONGSIDE
// MERMAID_DIAGRAM_CLASS (never instead of it): an unrenderable diagram is
// still a single figure occupying a diagram's slot, so it wants the same
// `break-inside: avoid-page` policy and the same measureDiagramBoxes
// reporting as a real one. See renderMermaidDiagrams's per-diagram
// try/catch for why this exists at all.
const MERMAID_ERROR_CLASS = 'pagedown-mermaid-error'

// Carried by the caption fitSvgToPageBox's affordance appends beneath a
// diagram that only fits the page by being scaled below the legibility floor.
const MERMAID_SCALED_NOTE_CLASS = 'pagedown-mermaid-scaled-note'

// design:97: "Define that floor — a diagram whose computed fitted size falls
// under some minimum readable scale shows a 'diagram too large for one page'
// affordance rather than silently rendering illegibly small."
//
// 0.5. Mermaid measures and paints every label at 16px (see
// renderMermaidDiagrams's own `document.fonts.load` spec), so the floor is
// 8px of real label text — genuinely small, but still the point below which
// this app should stop quietly pretending the diagram is fine.
//
// Deliberately LESS conservative than Split mode's own fit-to-width floor
// (0.7), and the difference is not an inconsistency. Below its floor Split
// mode SCROLLS: it has an escape hatch, so refusing to shrink further costs
// the user nothing but a drag. A printed page has no escape hatch, and the
// alternative to scaling here is the measured content-loss split above — so
// this floor cannot be a refusal to scale, only a decision about when to say
// so. Scaling below it and captioning is strictly better than either
// rendering blank pages or clipping the diagram.
const MERMAID_LEGIBILITY_FLOOR_SCALE = 0.5

// The caption's own line box, in px, pinned as a constant BECAUSE THE FIT HAS
// TO SUBTRACT IT. A caption appended under a diagram already scaled to exactly
// the full content height would push the figure back over one page and
// reintroduce the very split this policy exists to prevent — so the note's
// height is reserved from the budget before the final scale is computed, and
// the CSS `line-height` below is driven from this same constant so the two
// cannot drift.
const MERMAID_SCALED_NOTE_HEIGHT_PX = 18

// Fraction of the page content box deliberately left FREE around a
// page-fitted figure. Required, not padding, and the number was measured
// rather than picked:
//
//   - fitting to exactly `contentHeightPx` still split the corpus diagram,
//     into 2 page-clones (down from 4) — the first of them a fully EMPTY
//     838px shell on the heading's page, with all 60 <rect>/20 <text> on the
//     next. A figure that exactly equals the content box cannot share its
//     page with anything, and this app pins a heading to the figure below it
//     on purpose (KeepWithNextHandler, src/pagination/break-handlers.ts), so
//     "exactly one page tall" is precisely one heading too tall.
//   - leaving ~10% free produced ONE wrapper containing the whole diagram, on
//     the same page as its own heading: no split, no empty shell, no stranded
//     heading.
//
// Expressed as a fraction of the real content box rather than a pixel
// constant so it stays correct for A4, Legal, custom sizes and non-default
// margins — all of which this app supports and none of which are 864px tall.
const MERMAID_FIT_HEADROOM_FRACTION = 0.1

let mermaidStylesInjected = false

// Injected exactly once per render-context lifetime (not once per
// sendDocument() call — the rules are content-independent, so re-adding them
// on every run would just be another unbounded <head> leak of the kind the
// activePreviewer/Polisher cleanup above already exists to prevent).
// Created via `document.createElement`, so the bootstrap shim at the top of
// this file stamps this run's CSP style nonce onto it automatically — the
// same mechanism Paged.js's own Polisher-created <style> elements rely on,
// reused here rather than reinvented.
//
// Every selector below is deliberately class-only and every ELEMENT the
// error placeholder builds is a plain <div> — never a <p>/<pre> — because
// document-typography.css styles those tags at `.pagedown-document p`
// (0,1,1), which outranks a bare `.pagedown-mermaid-error-message` (0,1,0)
// and would silently take back the margins/padding/size set here. Divs have
// no such tag rule to lose to.
function ensureMermaidStylesInjected(): void {
  if (mermaidStylesInjected) return
  const style = document.createElement('style')
  style.textContent = `
    .${MERMAID_DIAGRAM_CLASS} { break-inside: avoid-page; page-break-inside: avoid; }
    .${MERMAID_DIAGRAM_CLASS} svg { display: block; max-width: 100%; height: auto; }
    .${MERMAID_ERROR_CLASS} {
      box-sizing: border-box;
      border: 1px dashed #b3261e;
      border-radius: 4px;
      padding: 0.6em 0.8em;
      color: #b3261e;
    }
    .${MERMAID_ERROR_CLASS}-message { font-weight: 600; margin-bottom: 0.35em; }
    .${MERMAID_ERROR_CLASS}-detail { margin-bottom: 0.35em; }
    .${MERMAID_ERROR_CLASS}-source {
      white-space: pre-wrap;
      font-family: monospace;
      color: #5f6368;
      max-height: 6em;
      overflow: hidden;
    }
    .${MERMAID_SCALED_NOTE_CLASS} {
      font-size: 12px;
      line-height: ${MERMAID_SCALED_NOTE_HEIGHT_PX}px;
      color: #5f6368;
    }
  `
  document.head.appendChild(style)
  mermaidStylesInjected = true
}

// --- design:97's content-addressed diagram render cache ---------------------
//
// design:97: "render once per diagram, keyed by a content hash (+ theme +
// page config), and reuse the resulting fixed-dimension SVG verbatim ...
// Cache by content hash so an unchanged diagram is never re-rendered on
// subsequent re-pagination passes." Unbuilt until this change:
// renderMermaidDiagrams re-queried and unconditionally re-rendered every
// block on every pass, which on Split mode's long-lived harness means every
// diagram re-renders on every settled edit — directly on the latency path
// that mode's own disclosed ceiling already lives on.
//
// MEASURED before building it, rather than assumed: two byte-identical
// sendDocument() calls on ONE harness against phase0/corpus/mermaid-
// diagrams.md logged 970 CSP style-src violations EACH. That count is a
// direct behavioural fingerprint of Mermaid's own internal d3 painting (see
// renderMermaidDiagrams's DOMParser comment for why those violations exist
// and are unavoidable), so it is positive proof the second render genuinely
// re-ran mermaid.render() for all three diagrams rather than reusing
// anything. Gate 3 now asserts the post-cache version of exactly that
// number.
interface MermaidCacheEntry {
  // The rendered SVG AFTER hoistInlineStyleAttributes has already stripped
  // every `style=""` attribute out of it, so re-importing it into this live,
  // CSP-governed document can never re-trigger the style-src violations that
  // hoisting exists to prevent.
  svgHtml: string
  hoistedCss: string
  // Characters, not bytes — this is a UTF-16 string, so real memory is
  // roughly double. Used for the byte-axis bound below.
  sizeChars: number
  // The last SUCCESSFULLY RENDERED, really-laid-out size of THIS diagram
  // (this exact source, at this style/geometry). Written only by
  // rememberGoodDiagramSizes, post-pagination, from real measured boxes —
  // never from the SVG's own viewBox, which is its UNCLAMPED natural size and
  // therefore wrong for any diagram wide enough to hit `max-width: 100%`.
  lastGoodSize?: { width: number; height: number }
}

// KEY = elementId + styleKey + the diagram's exact source text. Three
// deliberate choices, each of which a "simplification" would break:
//
// (1) The SOURCE TEXT ITSELF, never a hash of it. This context renders
//     UNTRUSTED document content, and a short non-cryptographic hash is a
//     forgeable collision: a document could carry two diagrams whose hashes
//     collide and get one rendered in the other's place. The entry payload
//     (~15KB of SVG markup for the corpus's small flowchart, measured) dwarfs
//     the key either way, so hashing would buy no memory worth the risk, and
//     a cryptographic hash would mean growing this bundle's dependency
//     surface — the one thing this context must not do.
// (2) elementId, because MERMAID BAKES IT INTO THE OUTPUT. Measured directly
//     rather than assumed: the corpus's small flowchart renders descendant
//     ids `pagedown-mermaid-0_flowchart-v2-pointEnd` (plus five more) and a
//     real `url(#pagedown-mermaid-0_flowchart-v2-pointEnd)` marker reference.
//     Reusing one slot's cached markup at a DIFFERENT slot would therefore
//     duplicate those ids within one document and let two diagrams' arrowhead
//     markers resolve against each other's <defs>. The only cost of including
//     it is that the same diagram appearing twice in one document renders
//     twice — strictly better than an id collision.
// (3) styleKey = the WHOLE DocumentStyle plus the content box, deliberately a
//     SUPERSET of what can currently matter. Today renderMermaidToSvg pins
//     one global Mermaid config, so the MARKUP depends on neither; but the
//     `lastGoodSize` recorded on this entry depends on the `max-width: 100%`
//     clamp (contentWidthPx), and design:97 names theme and page config
//     explicitly. A superset key can only ever cost an extra miss; a subset
//     key can serve a stale render, which is the failure that actually hurts.
function mermaidStyleKey(geometry: PageGeometry, style: DocumentStyle): string {
  // JSON.stringify key order is stable here because both objects are built by
  // resolveDocumentStyle/computePageGeometry and arrive over one JSON round
  // trip that preserves it -- and a reordering would only ever cost a miss.
  return `${geometry.contentWidthPx}x${geometry.contentHeightPx}|${JSON.stringify(style)}`
}

// Bounded on BOTH axes, and that is not belt-and-braces: an entry count alone
// bounds nothing when one entry can be an enormous diagram's markup (the same
// lesson the renderer's own local-image cache already records), while a byte
// budget alone would let thousands of tiny diagrams accumulate Map overhead.
// The per-entry ceiling additionally stops one pathological diagram from
// evicting the entire working set to store itself.
const MERMAID_CACHE_MAX_ENTRIES = 48
const MERMAID_CACHE_MAX_CHARS = 4_000_000
const MERMAID_CACHE_MAX_ENTRY_CHARS = 512_000

// Insertion-ordered Map used as a real LRU: `mermaidCacheGet` re-inserts on
// every hit so eviction takes the genuinely least-recently-used entry. A
// plain FIFO would be actively wrong here — the diagram a user is editing is
// the one touched most often, and a FIFO would evict it first.
const mermaidRenderCache = new Map<string, MermaidCacheEntry>()
let mermaidCacheChars = 0

function mermaidCacheGet(key: string): MermaidCacheEntry | undefined {
  const entry = mermaidRenderCache.get(key)
  if (!entry) return undefined
  mermaidRenderCache.delete(key)
  mermaidRenderCache.set(key, entry)
  return entry
}

function mermaidCachePut(key: string, entry: MermaidCacheEntry): void {
  if (entry.sizeChars > MERMAID_CACHE_MAX_ENTRY_CHARS) return
  const existing = mermaidRenderCache.get(key)
  if (existing) mermaidCacheChars -= existing.sizeChars
  mermaidRenderCache.set(key, entry)
  mermaidCacheChars += entry.sizeChars
  while (
    mermaidRenderCache.size > MERMAID_CACHE_MAX_ENTRIES ||
    mermaidCacheChars > MERMAID_CACHE_MAX_CHARS
  ) {
    const oldest = mermaidRenderCache.keys().next()
    if (oldest.done) break
    const evicted = mermaidRenderCache.get(oldest.value)
    mermaidRenderCache.delete(oldest.value)
    if (evicted) mermaidCacheChars -= evicted.sizeChars
  }
}

// Which cache entry backs each diagram slot of the PREVIOUS pass, plus the
// scope that pass belonged to. This is what design:107's retained error
// placeholder size ("retains the last known-good diagram's dimensions rather
// than collapsing to a different size, to avoid pagination thrashing while
// the user is mid-edit") reads through, and it deliberately does NOT reuse
// the content-addressed cache key for the lookup.
//
// WHY NOT, since everything else here is content-addressed: at the moment a
// diagram breaks mid-typing its SOURCE HAS JUST CHANGED, so a content key
// finds nothing by construction. The thing that must be stable across that
// specific edit is the SLOT, not the content — which is exactly what the old
// positional `lastGoodDiagramSizes` map got right, and exactly why its
// document-independence was the bug (CLAUDE.md: "on a long-lived harness a
// broken diagram can inherit the height of a DIFFERENT document's diagram
// that happened to sit at the same index").
//
// `scope` is what closes that hole: it is a fingerprint of the document
// AROUND the diagrams, so it is invariant under the one edit that has to keep
// working (typing inside a ```mermaid fence changes no prose) and different
// for two different documents. A scope mismatch means "this is not the
// document that pass belonged to", and no size is inherited at all.
interface MermaidPassLineage {
  scope: string
  entryByIndex: Map<number, MermaidCacheEntry>
}
let previousPassLineage: MermaidPassLineage | undefined

// Rebuilt every pass: which cache entry each rendered elementId came from, so
// rememberGoodDiagramSizes can write the measured size back onto the right
// content-addressed entry after Paged.js has laid the document out.
const currentPassEntryByElementId = new Map<string, MermaidCacheEntry>()

// The document fingerprint described above. Three components, each carrying
// its own weight:
//   - the style key, so a theme/geometry change never inherits a size
//     measured under the old one;
//   - the diagram COUNT and the length of all NON-diagram text, both of which
//     are invariant under editing inside a fence and both of which move when
//     the surrounding document does;
//   - each diagram's ANCHOR, the text of the element immediately before its
//     <pre> (in practice its heading), capped so a pathological document
//     cannot make this string grow without bound.
// Deliberately NOT a hash of the whole document HTML: that changes on every
// keystroke anywhere, which would break retention for the mid-typing case
// this exists to serve. Deliberately NOT the diagram sources themselves,
// for the same reason. The honest residual is that two documents agreeing on
// all three components would still cross-inherit; the consequence is bounded
// to one error placeholder's min-height floor, never to real content.
function diagramSlotScope(
  container: DocumentFragment,
  codeBlocks: HTMLElement[],
  styleKey: string
): string {
  let diagramChars = 0
  const anchors: string[] = []
  for (const code of codeBlocks) {
    diagramChars += (code.textContent ?? '').length
    const anchorText = code.parentElement?.previousElementSibling?.textContent ?? ''
    anchors.push(anchorText.trim().slice(0, 120))
  }
  const nonDiagramChars = (container.textContent ?? '').length - diagramChars
  // Control-character separators rather than a comma or a space: every
  // component here can legitimately contain both (styleKey embeds JSON,
  // anchors embed arbitrary heading text), and an ambiguous join would let
  // two genuinely different documents collapse onto one identical scope.
  return [styleKey, codeBlocks.length, nonDiagramChars, anchors.join('\u0001')].join('\u0000')
}

let mermaidLabelFontRegistered = false

// Registers the ONE @font-face Mermaid measures and paints diagram labels
// in (src/diagrams/render-mermaid.ts's MERMAID_LABEL_FONT_FAMILY, currently
// Inter Variable — see that module for why the pinned family used to name a
// font that did not exist, and what that cost).
//
// WHY THIS IS A SEPARATE, PERMANENT <head> STYLE RATHER THAN ONE MORE
// CONDITIONAL RULE IN buildDocumentStylesheet(), which is where every other
// @font-face in this context lives. Purely an ORDERING constraint, not a
// preference: buildDocumentStylesheet's output only reaches the document
// when Paged.js's Polisher installs it, inside `previewer.preview()` — and
// renderMermaidDiagrams runs BEFORE that call, by design (the whole point
// of the mermaid pass is to replace code blocks with real SVG before
// Paged.js ever lays the document out). Mermaid does all of its text
// measurement during `mermaid.render()`, so a face that only appears at
// preview() time appears strictly too late to affect a single label's size.
// A font emitted there would paint correctly and measure wrongly, which is
// the worst of both worlds: silently host-dependent geometry that LOOKS
// right in the final output.
//
// It is also why this is a plain <style> element rather than something the
// Polisher owns: `activePreviewer.polisher?.destroy()` tears the
// per-request stylesheet down at the top of the NEXT render, so a
// Polisher-owned face would be gone again by the time the next request's
// mermaid pass ran.
//
// WHY IT IS STILL CONDITIONAL, and how that keeps the loadFonts() invariant
// this file's own buildDocumentStylesheet comment (piece 2) documents.
// `Chunker.flow()` awaits `loadFonts()`, which calls `.load()` on EVERY
// FontFace registered in `document.fonts` regardless of whether anything on
// the page uses it (node_modules/pagedjs/src/chunker/chunker.js:170,
// :541-557) — so an unconditionally-registered face costs a real, awaited
// decode on every render of every document. This function is called only
// from inside renderMermaidDiagrams, AFTER its `codeBlocks.length === 0`
// early return, so a document with no diagrams never registers it and never
// pays for it — exactly the same shape as `hasMath` gating KaTeX's ~394KB
// of font CSS.
//
// The honest residual, stated rather than glossed: the flag is per
// RENDER-CONTEXT lifetime, not per request, so on a long-lived harness
// (Split mode's persistent WebContentsView) a document containing a diagram
// leaves this face registered for every LATER, diagram-free document
// rendered in the same context. That costs nothing measurable, because
// loadFonts() skips any face whose `status` is already `'loaded'` (read
// from the source above, not assumed) and our own `document.fonts.load()`
// below has already driven it to exactly that state. What it must not
// become is an unconditional registration at module scope, which would
// re-introduce the first-render decode for every diagram-free document.
//
// The `data:` URI needs no CSP change: this context's `font-src data:` was
// already added for Source Serif 4 / Inter Variable, and this reuses the
// same vendored .woff2 bytes esbuild already inlines for the document-font
// case (scripts/build-pagination-render.ts's base64 loader), so it adds
// nothing to the bundle either. For a document that itself selects
// `fontFamily: 'inter'`, this registers a second FontFace with the same
// family/descriptors as buildDocumentStylesheet's own — harmless and NOT a
// new per-render cost: the Polisher-owned copy is already re-registered and
// re-loaded on every render today, and this permanent copy is loaded once
// ever.
//
// Created via `document.createElement`, so the bootstrap shim at the top of
// this file stamps this page-load's CSP style nonce onto it automatically.
function ensureMermaidLabelFontRegistered(): void {
  if (mermaidLabelFontRegistered) return
  const style = document.createElement('style')
  // Kept declaration-for-declaration in sync with base.css's own Inter
  // Variable rule and with buildDocumentStylesheet's copy above -- same
  // hand-synced-pair convention, and a difference between the three reads
  // as drift rather than intent.
  style.textContent = `@font-face {
  font-family: '${MERMAID_LABEL_FONT_FAMILY}';
  font-style: normal;
  font-weight: 100 900;
  font-display: block;
  src: url(data:font/woff2;base64,${interVariableBase64}) format('woff2-variations');
}`
  document.head.appendChild(style)
  mermaidLabelFontRegistered = true
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
//
// OVERSIZED-DIAGRAM POLICY (design:97's legibility floor, and the content-loss
// bug the design doc's own Phase 0 correction calls "a required V1 fix, not a
// documented-and-deferred edge case").
//
// What this used to do: set width/height from the viewBox and stop, leaving a
// diagram taller than the page to Paged.js. MEASURED, in the real app, before
// changing anything — phase0/corpus/mermaid-diagrams.md's 20-stage chain
// (144.05 x 1956px natural, against a 624 x 864px content box) split into
// FOUR page-clones, and a per-clone structural census of what survived reads:
//
//     clone 0: 0 <rect>, 0 <text>, 0 <path>
//     clone 1: 0 <rect>, 0 <text>, 13 <path>
//     clone 2: 0 <rect>, 0 <text>, 0 <path>
//     clone 3: 0 <rect>, 0 <text>, 9 <path>
//
// Every node box and every label of a 20-node flowchart is GONE — four pages
// of near-blank paper carrying 22 stray edges between them, on screen and in
// exported PDF identically. Paged.js's `removeOverflow` moves an overflowing
// tail with `Range.extractContents()`, which has no special case for one
// indivisible SVG shape tree sharing <defs>/marker/id references, and
// `break-inside: avoid-page` does not save it: Paged.js only honours that for
// content that COULD fit on a page, falling back to ordinary
// overflow-splitting for content that simply cannot.
//
// So the fix is to make it fit, which is also the design doc's own pragmatic
// V1 answer ("treat 'diagram taller than one page' as a hard product
// constraint ... rather than let Paged.js's split path run at all") and its
// prescribed mechanism ("compute the fitted width/height in JS (preserving
// aspect ratio, clamped to the page content box) and emit them as explicit
// absolute-unit attributes on the SVG root"). Once the diagram fits within one
// page, `break-inside: avoid-page` becomes honourable again and Paged.js moves
// the whole figure to a fresh page instead of slicing it.
//
// DELIBERATELY SURGICAL: the width-only case is left exactly as it was. A
// diagram that is merely wider than the content box has always been handled
// correctly by the `max-width: 100%; height: auto` CSS clamp — that is what
// makes the corpus's sequence diagram measure exactly 624px wide, an
// assertion Gate 3 has carried untouched since Task 8. Recomputing that in JS
// would risk sub-pixel drift against a proven number for no benefit, so this
// only intervenes when the diagram is genuinely TALLER than the page after
// that clamp has already been accounted for. The small flowchart and the
// sequence diagram therefore keep byte-identical geometry.
//
// Reports whether the page-HEIGHT fit fired and at what scale, so the caller
// can decide whether the result is still legible — see
// MERMAID_LEGIBILITY_FLOOR_SCALE.
//
// `fittedToPageHeight` deliberately distinguishes this from the pre-existing
// width clamp, and the caller only ever offers the affordance for the former.
// A diagram that is merely wide has been clamped by CSS since Task 8, loses no
// content, and is a shape authors already understand; captioning every one of
// them now would be an unrelated, much wider behaviour change on documents
// that are not broken. Whether a severely width-clamped diagram deserves the
// same affordance is a real question, deliberately left open rather than
// silently answered here.
interface DiagramFit {
  scale: number
  fittedToPageHeight: boolean
}

function fitSvgToPageBox(svgElement: SVGElement, geometry: PageGeometry): DiagramFit {
  const unfitted: DiagramFit = { scale: 1, fittedToPageHeight: false }
  const viewBoxAttr = svgElement.getAttribute('viewBox')
  if (!viewBoxAttr) return unfitted
  const parts = viewBoxAttr.trim().split(/\s+/).map(Number)
  if (parts.length !== 4 || !parts.every((n) => Number.isFinite(n))) return unfitted
  const [, , naturalWidth, naturalHeight] = parts
  if (naturalWidth <= 0 || naturalHeight <= 0) return unfitted

  // What the existing CSS clamp alone would already do to this diagram.
  const cssWidthScale = Math.min(1, geometry.contentWidthPx / naturalWidth)
  const heightAfterCssClamp = naturalHeight * cssWidthScale
  const availablePx = geometry.contentHeightPx * (1 - MERMAID_FIT_HEADROOM_FRACTION)

  if (heightAfterCssClamp <= availablePx) {
    // Unchanged legacy path: emit the diagram's true natural size and let the
    // CSS clamp do the width-only work it has always done correctly.
    svgElement.setAttribute('width', String(naturalWidth))
    svgElement.setAttribute('height', String(naturalHeight))
    svgElement.removeAttribute('style')
    return unfitted
  }

  // Genuinely taller than one page even after width clamping: this is the case
  // that used to split and lose its content. Scale on the binding axis
  // (height), preserving aspect ratio. The result is <= cssWidthScale by
  // construction, so the CSS width clamp can never fire on top of this and
  // shrink the diagram a second time.
  //
  // Computed in two steps so the caption can be paid for out of the same page
  // budget: the provisional scale decides WHETHER a caption appears, and only
  // then is its reserved height subtracted. That ordering terminates because
  // the second scale is strictly smaller than the first, so a diagram that
  // qualified for a caption still qualifies after the subtraction — there is
  // no oscillation between the two branches.
  const provisionalScale = availablePx / naturalHeight
  const budgetPx =
    provisionalScale < MERMAID_LEGIBILITY_FLOOR_SCALE
      ? availablePx - MERMAID_SCALED_NOTE_HEIGHT_PX
      : availablePx
  const scale = budgetPx / naturalHeight
  svgElement.setAttribute('width', String(naturalWidth * scale))
  svgElement.setAttribute('height', String(naturalHeight * scale))
  svgElement.removeAttribute('style')
  return { scale, fittedToPageHeight: true }
}

// The ONE <head> <style> element carrying this pass's retained-size rules for
// error placeholders, reused and rewritten wholesale on every pass.
//
// A single reused element rather than one per pass for the reason the
// activePreviewer/Polisher cleanup above already documents: <style> elements
// appended to <head> per sendDocument() call leak without bound against a
// long-lived harness. Rewriting `textContent` also makes the previous pass's
// rules disappear by construction, which is required and not incidental —
// a diagram that renders correctly again must stop being pinned to the
// height it had while broken.
//
// Created lazily via `document.createElement` (nonce shim) and only once
// there is something to say; a document that never had a diagram fail never
// creates it at all.
let mermaidErrorSizeStyle: HTMLStyleElement | undefined

function applyMermaidErrorSizes(rules: string[]): void {
  if (rules.length === 0 && !mermaidErrorSizeStyle) return
  if (!mermaidErrorSizeStyle) {
    mermaidErrorSizeStyle = document.createElement('style')
    document.head.appendChild(mermaidErrorSizeStyle)
  }
  mermaidErrorSizeStyle.textContent = rules.join('\n')
}

// Records the real, laid-out size of every diagram that genuinely rendered in
// THIS pass, for a later pass's error placeholder to fall back to. Called
// after previewer.preview() resolves, from the same paginated `root`
// measureDiagramBoxes reads — that timing is the point: this is the only
// moment a diagram's size reflects the CSS clamp (`max-width: 100%`) that
// applies to anything wider than the page content box, which the SVG's own
// viewBox (its unclamped natural size) does not.
//
// Skips error placeholders explicitly: their box IS the retained size (or the
// size of an error message), so recording it would let one failure's own
// dimensions masquerade as a known-good measurement forever after.
//
// Writes onto the CONTENT-ADDRESSED cache entry this pass actually used for
// that slot, via currentPassEntryByElementId, rather than into a map keyed by
// the positional element id. That indirection is the whole point: the size
// now belongs to "this diagram source, at this style and geometry" and can
// never be handed to a different document's diagram that happens to sit at
// the same index.
function rememberGoodDiagramSizes(root: HTMLElement): void {
  const wrappers = Array.from(
    root.querySelectorAll(`.${MERMAID_DIAGRAM_CLASS}:not(.${MERMAID_ERROR_CLASS})`)
  ) as HTMLElement[]
  for (const wrapper of wrappers) {
    const id = wrapper.getAttribute('data-mermaid-diagram-id')
    const svg = wrapper.querySelector('svg')
    if (!id || !svg) continue
    const entry = currentPassEntryByElementId.get(id)
    if (!entry) continue
    const rect = svg.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      entry.lastGoodSize = { width: rect.width, height: rect.height }
    }
  }
}

// Mermaid leaks its own internal measurement container when a diagram fails
// to PARSE, and this cleanup is required, not defensive padding — read
// directly out of node_modules/mermaid/dist/mermaid.core.mjs's `render()`
// rather than assumed. On the parse-error path it stashes the exception
// (`parseEncounteredException`), renders its own built-in "Syntax error in
// text" bomb graphic into the temp container instead, and then does
// `if (parseEncounteredException) throw parseEncounteredException` on the
// line ABOVE its own `removeTempElements()` call — so the throw skips the
// cleanup entirely.
//
// The consequence is not a silent memory nibble: that container is a direct
// child of `document.body`, i.e. a SIBLING of #content-root, so a leaked one
// paints the syntax-error bomb loose in the Split-mode preview, above the
// real pages, for the rest of the harness's life. Mermaid does clear a
// same-id container at the start of its next render (removeExistingElements),
// so this self-heals on the next pass — but "next pass" can be a user
// keystroke away, and a diagram that stays broken never gets one.
//
// Removes both ids Mermaid's own removeExistingElements targets for the
// non-sandboxed security levels this app uses: the enclosing div (`"d" + id`)
// and the svg itself (`id`).
function removeMermaidTempElements(elementId: string): void {
  document.getElementById(`d${elementId}`)?.remove()
  document.getElementById(elementId)?.remove()
}

// Builds the visible per-diagram failure placeholder that replaces one
// unrenderable ```mermaid block, so a single syntax error degrades to one
// bad figure instead of aborting the whole document's pagination (design:107
// — invalid diagram syntax "happens constantly mid-typing", which is exactly
// when Split mode re-renders).
//
// Carries MERMAID_DIAGRAM_CLASS as well as MERMAID_ERROR_CLASS, and the same
// `data-mermaid-diagram-id` a successful render would: it occupies that
// diagram's slot for break policy, for measureDiagramBoxes, and for anything
// downstream keying off diagram ids, so the ids reported for a document stay
// positionally complete whether or not every diagram rendered.
//
// Every child is a <div> (see ensureMermaidStylesInjected for why not
// <p>/<pre>) and every string reaching the DOM goes through `textContent`,
// never innerHTML — `diagramSource` is untrusted document content and the
// error text is Mermaid's own, neither of which is markup here.
function buildMermaidErrorPlaceholder(
  elementId: string,
  diagramSource: string,
  err: unknown
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = `${MERMAID_DIAGRAM_CLASS} ${MERMAID_ERROR_CLASS}`
  wrapper.setAttribute('data-mermaid-diagram-id', elementId)
  wrapper.setAttribute('data-mermaid-error', 'true')

  const message = document.createElement('div')
  message.className = `${MERMAID_ERROR_CLASS}-message`
  message.textContent = 'Diagram could not be rendered'
  wrapper.appendChild(message)

  // Mermaid's parse errors name the offending line and token, which is the
  // single most useful thing to put in front of someone whose diagram just
  // stopped rendering. Only the first line: the rest is a multi-line
  // token-expectation dump that would dominate the placeholder.
  const detailText = (err instanceof Error ? err.message : String(err)).split('\n')[0].trim()
  if (detailText) {
    const detail = document.createElement('div')
    detail.className = `${MERMAID_ERROR_CLASS}-detail`
    detail.textContent = detailText
    wrapper.appendChild(detail)
  }

  const source = document.createElement('div')
  source.className = `${MERMAID_ERROR_CLASS}-source`
  source.textContent = diagramSource
  wrapper.appendChild(source)

  return wrapper
}

// Turns a cache entry (fresh or reused) into a live, CSP-clean <svg> element
// owned by THIS document. Shared by both the cache-hit and cache-miss paths —
// see the call site for why a miss deliberately routes through here too.
//
// The parse target is a scratch DOMParser document rather than this page's
// own, for the same reason the miss path's original parse was: a genuinely
// separate Document has no CSP of its own. The stored markup is already
// style-attribute-free, so this is belt-and-braces rather than load-bearing
// here, but it keeps the two paths byte-identical.
function instantiateDiagram(
  entry: MermaidCacheEntry,
  elementId: string,
  geometry: PageGeometry
): { svgElement: SVGElement; fit: DiagramFit } {
  const scratchDoc = new DOMParser().parseFromString(entry.svgHtml, 'text/html')
  const scratchSvgElement = scratchDoc.body.firstElementChild as SVGElement | null
  if (!scratchSvgElement) {
    throw new Error(`Cached Mermaid markup for diagram "${elementId}" is not an <svg> element`)
  }
  const svgElement = document.importNode(scratchSvgElement, true) as SVGElement
  // reattachNoncedStyles must run AFTER import, not before: it creates the
  // replacement <style> via THIS page's own `document.createElement` (the only
  // one the bootstrap nonce shim at the top of this file patches) so the fresh
  // element actually receives a real, matching nonce — a <style> created via
  // `scratchDoc.createElement` would carry no nonce at all, since the shim
  // never touches the scratch document.
  reattachNoncedStyles(svgElement, entry.hoistedCss)
  const fit = fitSvgToPageBox(svgElement, geometry)
  return { svgElement, fit }
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
async function renderMermaidDiagrams(
  container: DocumentFragment,
  geometry: PageGeometry,
  documentStyle: DocumentStyle
): Promise<void> {
  const codeBlocks = Array.from(
    container.querySelectorAll('pre > code.language-mermaid')
  ) as HTMLElement[]
  // Cleared BEFORE the early return, not after it: rememberGoodDiagramSizes
  // runs unconditionally on every pass, and leaving a previous pass's map in
  // place would let a diagram-free render write sizes onto stale entries.
  currentPassEntryByElementId.clear()
  if (codeBlocks.length === 0) {
    // A document with no diagrams is not a continuation of one that had them,
    // so the lineage is dropped rather than carried across. Fail-closed: the
    // cost is one lost retained min-height, never a wrong one.
    previousPassLineage = undefined
    return
  }

  // Per the design doc's resource-settling-gate ordering: layout-affecting
  // resources (fonts, images, diagrams) must be settled before anything
  // measures text, or measurements silently bake in fallback-font metrics.
  // Awaited once per render pass, before the first mermaid.render() call —
  // not per-diagram: this loads one variable font FILE covering the whole
  // 100-900 weight range, so every label in every diagram of this pass is
  // covered by the single load.
  //
  // THIS REPLACES A BARE `await document.fonts.ready`, which the comment it
  // replaced already admitted was not a real gate — and it was right.
  // `.ready` resolves once font loading is IDLE, i.e. once every face the
  // document has already REQUESTED has settled; it does not request
  // anything itself. At this point `container` is still the DETACHED
  // fragment built by the caller, nothing in it is laid out, and Mermaid
  // has not run yet, so nothing has requested the label font at all and
  // `.ready` resolves immediately having guaranteed nothing. That is
  // precisely the "unreliable immediately after injecting new HTML" case
  // the design doc's resource-settling-gate section warns about, which is
  // why it prescribes an explicit `document.fonts.load(...)` PER DECLARED
  // FACE instead. The old note closed by saying a real implementation
  // "needs to build the fuller gate the design doc describes, not assume
  // this line already is one" — this is that gate.
  //
  // Order is load-bearing: register the face (above), force the fetch and
  // decode (here), and only then let Mermaid measure. Reversing any two
  // puts a fallback font's metrics into the diagram geometry, which is
  // undetectable downstream — the SVG that comes back is well-formed and
  // non-zero-sized either way.
  ensureMermaidLabelFontRegistered()
  const labelFontSpec = `16px "${MERMAID_LABEL_FONT_FAMILY}"`
  try {
    const loaded = await document.fonts.load(labelFontSpec)
    // `load()` resolves with the faces it MATCHED, so an empty array is a
    // silent no-op, not an error — the exact failure shape that let the
    // original `fontFamily: 'PageDownSans'` bug survive. Surfaced as a
    // console warning rather than a thrown error, matching
    // awaitImagesSettled's own "degrade to a weaker guarantee, never a
    // failed render" posture: a font problem should cost a document
    // machine-dependent diagram metrics, not a blank preview and an
    // undiagnostic export failure. Gate 3 is where this is a hard failure
    // — it asserts document.fonts.check() and the diagrams' real resolved
    // font in the running app, so a regression here fails CI loudly even
    // though it degrades quietly in production.
    if (loaded.length === 0) {
      console.warn(
        `Mermaid label font ${labelFontSpec} matched no registered @font-face; ` +
          'diagram sizing will fall back to a host-installed font and stop being deterministic'
      )
    }
  } catch (err) {
    console.warn(`Mermaid label font ${labelFontSpec} failed to load:`, err)
  }

  ensureMermaidStylesInjected()

  // Per-diagram retained-size rules for this pass only (see
  // previousPassLineage and applyMermaidErrorSizes below). Collected here
  // rather than written straight to the DOM so the whole set replaces the
  // previous pass's wholesale, with no accumulation.
  const errorSizeRules: string[] = []

  const styleKey = mermaidStyleKey(geometry, documentStyle)
  // Computed BEFORE the loop, which mutates `container` by replacing each
  // <pre> with a rendered wrapper -- the anchors this reads (each diagram's
  // preceding sibling) and the non-diagram text length would both be measured
  // against a partially-rewritten document otherwise.
  const slotScope = diagramSlotScope(container, codeBlocks, styleKey)
  const lineage = new Map<number, MermaidCacheEntry>()
  // Only a lineage from the SAME document (see diagramSlotScope) may donate a
  // retained size. This single comparison is what closes the cross-document
  // height-inheritance bug the positional map had.
  const inheritableLineage =
    previousPassLineage?.scope === slotScope ? previousPassLineage.entryByIndex : undefined

  for (let i = 0; i < codeBlocks.length; i++) {
    const code = codeBlocks[i]
    const pre = code.parentElement
    if (!pre) continue // unreachable for a `pre > code` match, but keeps this a type-safe non-null narrowing rather than a cast

    const diagramSource = code.textContent ?? ''
    const elementId = `pagedown-mermaid-${i}`

    // ONE diagram's render, guarded on its own. Before this try/catch the
    // await below (and the missing-<svg> throw further down) propagated
    // straight out of this function to the 'render' handler's whole-pass
    // catch, so a single mistyped arrow published an error result for the
    // ENTIRE document and the preview went blank — for content the design
    // doc itself says is invalid "constantly mid-typing" (design:107).
    // Mirrors the per-equation guard renderMathPlaceholder already has in
    // katex-render.ts, for the identical reason.
    try {
      // design:97's cache lookup. A hit skips mermaid.render() entirely --
      // which is where essentially all of this pass's cost AND all of its
      // unavoidable CSP style-src console noise comes from (see the DOMParser
      // comment below) -- so on Split mode's long-lived harness an unchanged
      // diagram costs a parse and an import instead of a full re-render on
      // every settled edit.
      const cacheKey = `${elementId}\u0000${styleKey}\u0000${diagramSource}`
      let entry = mermaidCacheGet(cacheKey)

      if (!entry) {
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
          throw new Error(
            `Mermaid render for diagram "${elementId}" did not produce an <svg> element`
          )
        }

        // Hoisting runs here, on the scratch element, BEFORE import — order is
        // load-bearing: it must remove every `style=""` attribute while the
        // element is still in the CSP-free scratch document, so nothing is left
        // to trigger a violation at the moment importNode below moves it into
        // this page's own CSP-governed document.
        //
        // It is also why the CACHED form is captured here, after hoisting
        // rather than before: the stored markup then carries no `style=""` at
        // all, so a later cache hit re-importing it into this live document
        // cannot reintroduce the very violations hoisting exists to remove.
        // The synthetic `.pd-hoisted-style-N` class names frozen into it are
        // safe to persist because that counter is module-level and strictly
        // monotonic (nonce-style-hoisting.ts) — it never reissues a name, so a
        // cached entry's rules can never collide with a later diagram's.
        const hoistedCss = hoistInlineStyleAttributes(scratchSvgElement)
        const svgHtml = scratchSvgElement.outerHTML
        entry = { svgHtml, hoistedCss, sizeChars: svgHtml.length + hoistedCss.length }
        mermaidCachePut(cacheKey, entry)
      }

      // ONE instantiation path for both a cache hit and a cache miss, on
      // purpose: a miss re-parses the markup it just produced rather than
      // reusing the scratch element it already has in hand. That costs one
      // extra parse of ~15KB (negligible beside a mermaid.render() call) and
      // buys the property that a hit and a miss cannot produce different DOM
      // — which matters because Gate 3 pins diagram geometry to fractional
      // pixels, and a second, subtly different code path is exactly how a
      // cache starts returning something that is nearly, but not quite, what
      // the uncached render would have.
      const { svgElement, fit } = instantiateDiagram(entry, elementId, geometry)

      const wrapper = document.createElement('div')
      wrapper.className = MERMAID_DIAGRAM_CLASS
      wrapper.setAttribute('data-mermaid-diagram-id', elementId)
      wrapper.appendChild(svgElement)

      if (fit.fittedToPageHeight) {
        // Recorded on the wrapper whether or not a caption is shown: it is the
        // one machine-readable signal that this diagram was scaled to fit
        // rather than rendered at its natural size, and Gate 3 asserts on it.
        wrapper.setAttribute('data-mermaid-fitted-scale', fit.scale.toFixed(4))
      }
      if (fit.fittedToPageHeight && fit.scale < MERMAID_LEGIBILITY_FLOOR_SCALE) {
        // design:97's "diagram too large for one page" affordance. This is the
        // ONLY channel available: the sandbox has no IPC and no contextBridge,
        // so a warning that does not appear in the document appears nowhere at
        // all — the same reasoning that makes the broken-diagram placeholder a
        // real, printed figure. Deliberately names the actual scale and the
        // action that fixes it, rather than a bare "too large".
        //
        // textContent, never innerHTML, and the percentage is derived from a
        // number this code computed — nothing document-supplied reaches it.
        const note = document.createElement('div')
        note.className = MERMAID_SCALED_NOTE_CLASS
        note.textContent =
          `Diagram scaled to ${Math.round(fit.scale * 100)}% to fit one page — ` +
          'split it into smaller diagrams to keep it readable.'
        wrapper.appendChild(note)
      }

      pre.replaceWith(wrapper)
      currentPassEntryByElementId.set(elementId, entry)
      lineage.set(i, entry)
    } catch (err) {
      // One bad diagram, one bad figure — the rest of the document still
      // paginates. Logged rather than swallowed silently (this context has no
      // channel to the app shell at all: no IPC, no contextBridge, and
      // `markdownToHtml` returns no warning surface either — see the gap
      // audit's A5), so the failure is at least visible in the render
      // context's own console alongside the placeholder the user sees.
      console.warn(`Mermaid diagram "${elementId}" failed to render:`, err)
      removeMermaidTempElements(elementId)

      // design:107's retained size, now read through the slot lineage rather
      // than a positional map. `inheritableLineage` is undefined unless the
      // previous pass belonged to the SAME document (diagramSlotScope), so a
      // broken diagram in document B can no longer inherit the height of
      // document A's diagram at the same index on a long-lived harness.
      const inherited = inheritableLineage?.get(i)
      const retained = inherited?.lastGoodSize
      // Carried forward even though nothing rendered here: without this, a
      // SECOND consecutive broken pass (the user keeps typing) would find an
      // empty lineage slot and lose the retained floor mid-edit — precisely
      // the pagination thrash design:107 exists to prevent.
      if (inherited) lineage.set(i, inherited)
      if (retained) {
        // Attribute selector on an id THIS function assigned (never
        // document-supplied), so there is nothing here for content to inject
        // into. `min-height`, not `height`: an error message longer than the
        // diagram it replaces must stay readable rather than be clipped —
        // the retained size is a floor that keeps pagination stable, not a
        // clamp.
        errorSizeRules.push(
          `.${MERMAID_ERROR_CLASS}[data-mermaid-diagram-id="${elementId}"] ` +
            `{ min-height: ${retained.height}px; }`
        )
      }

      pre.replaceWith(buildMermaidErrorPlaceholder(elementId, diagramSource, err))
    }
  }

  applyMermaidErrorSizes(errorSizeRules)
  previousPassLineage = { scope: slotScope, entryByIndex: lineage }
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
    // Falls back to the WRAPPER's own box when there is no <svg> inside it,
    // which is exactly the error-placeholder case (see
    // buildMermaidErrorPlaceholder). Reporting 0x0 there — what this did
    // before per-diagram error handling existed — would be actively
    // misleading: a zero-size box is the specific getBBox()/layout failure
    // signal Gate 3 exists to detect, and an error placeholder occupying real
    // space is not that failure.
    const svg = wrapper.querySelector('svg')
    const rect = (svg ?? wrapper).getBoundingClientRect()
    return { id, width: rect.width, height: rect.height }
  })
}

window.addEventListener('message', async (event: MessageEvent<IncomingMessage>) => {
  // Not every message on this window is necessarily a 'render' request from
  // sendDocument (e.g. Electron/Chromium internals can post other messages
  // on the same window) — this is the one early return in this handler that
  // is genuinely fine to leave silent: there is no requestId to publish a
  // result against and no caller waiting on one.
  if (event.data?.type !== 'render') return

  const { requestId, html, geometry, documentStyle, fitToWidth } = event.data
  currentRequestId = requestId

  // Fit-to-width OFF for the whole of this render, restored only once the
  // result below has been measured. Not housekeeping: Paged.js lays out
  // against real computed lengths, and every post-pagination measurement this
  // handler takes (measureDiagramBoxes, measureImageBoxes, and Gate 3's
  // fractional-pixel diagram pins behind them) reads
  // getBoundingClientRect(), which comes back already scaled under an
  // ancestor `zoom`. On a long-lived harness -- which is exactly the harness
  // that asks for fitting -- leaving the previous render's scale in place
  // would silently multiply this render's numbers by it.
  previewFitPageWidthPx = 0
  applyPreviewFitScale()

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
  //
  // The class list itself comes from documentStyleClasses (document-style.ts),
  // shared verbatim with the Milkdown mount -- a class added for one surface
  // and forgotten on the other is precisely the divergence this whole shared-
  // typography design exists to prevent, and the body-size class added by the
  // capability-gap pass would have been the third hand-copied entry here.
  document.body.className = ['pagedown-document', ...documentStyleClasses(documentStyle)].join(' ')
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
  let rootForFailureNotice: HTMLElement | undefined
  try {
    // Destroy the previous run's Polisher-injected <style> elements before
    // starting a new one, and clear its rendered pages.
    //
    // Deliberately at the TOP, and this position is now a MEASURED
    // constraint rather than an incidental one. Deferring it to just before
    // previewer.preview() -- so that a failure in the Mermaid/KaTeX/image
    // passes would leave the previous, correct render on screen instead of
    // blanking it, per design:212 -- was built, measured, and backed out:
    // it leaves the PREVIOUS run's stylesheet in <head> while Mermaid does
    // its own internal text measurement, and Gate 3's own
    // render-1-vs-render-3 comparison caught the same document paginating
    // differently depending on how many documents that harness had already
    // rendered (369.945px vs 370.148px per diagram, identical widths). The
    // obvious culprit -- typography inherited by Mermaid's temp measurement
    // container -- was ruled OUT by direct probe (it computes to Times/16px/
    // normal either way), so the perturbation is somewhere else in that
    // stylesheet and is not something a targeted reset can be trusted to
    // pin. See this sub-project's report; the retained-render behavior is
    // deferred, not abandoned.
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
    // Held for the catch below, which needs a root to write its failure
    // notice into and cannot re-run the getElementById lookup safely (the
    // #content-root-disappears case above is exactly when that lookup fails).
    rootForFailureNotice = root

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
        imageBoxes: [],
        pageBreaks: []
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
    // geometry/documentStyle are threaded in for design:97's cache key: an
    // entry records a diagram's really-measured size, which depends on the
    // content box it was clamped against and on the document's typography, so
    // reusing one across a page-size or theme change would retain a size that
    // was never true for the current document.
    await renderMermaidDiagrams(container, geometry, documentStyle)
    // Synchronous (unlike renderMermaidDiagrams) -- katex.renderToString does
    // no async work, so this needs no `await`. Must still run before
    // buildDocumentStylesheet below, since its return value decides whether
    // that call includes KaTeX's own font-face CSS at all.
    const hasMath = renderMathEquations(container)
    // Audit finding A2 fix: gates whether the vendored Source Code Pro
    // @font-face is registered at all (buildDocumentStylesheet's own
    // `monoFontFace`), same shape as hasMath immediately above. Checked
    // AFTER both renderMermaidDiagrams and renderMathEquations have already
    // replaced their own `pre > code.language-mermaid` / `code.language-
    // math-*` placeholders with real SVG/KaTeX output, so a document whose
    // only "code-shaped" markup was a diagram or an equation doesn't pay
    // the decode cost for a face nothing on the page actually uses.
    const hasCode = container.querySelector('pre, code') !== null

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
      [
        {
          'document-typography': buildDocumentStylesheet(geometry, documentStyle, hasMath, hasCode)
        }
      ],
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

    // Record what every diagram that DID render actually measured, for a
    // later pass's error placeholder to fall back to -- see
    // rememberGoodDiagramSizes and lastGoodDiagramSizes. Here, not earlier:
    // a diagram's real size only exists once Paged.js has laid it out.
    rememberGoodDiagramSizes(root)

    const result: OutgoingSuccess = {
      type: 'result',
      requestId,
      pageCount: flow.total,
      ready: true,
      layoutMs: t1 - t0,
      diagramBoxes: measureDiagramBoxes(root),
      imageBoxes: measureImageBoxes(root),
      pageBreaks: recoverPageBreaks(readPageBlockIndices(root.querySelectorAll(PAGE_SELECTOR)))
    }

    // Strictly AFTER `result` is built -- every measurement inside that object
    // literal has already been taken, in the unscaled document coordinate
    // space they are pinned in. Before publishing, so a caller that probes the
    // DOM the moment its result arrives sees the finished state rather than a
    // frame of unscaled page.
    previewFitPageWidthPx = fitToWidth === true ? geometry.pageWidthPx : 0
    applyPreviewFitScale()

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

    // Say something on screen rather than leaving a silent blank pane.
    //
    // This is the partial answer to design:212's "preview falls back to
    // showing the last known-good paginated state rather than going blank."
    // The full answer -- keeping the previous render -- is deferred (see the
    // Polisher-destroy comment at the top of this handler for the measured
    // reason), but "blank white rectangle, no explanation" was never the only
    // alternative: by this point the run has genuinely failed, whatever
    // partial page tree Paged.js managed to append is misleading rather than
    // useful, and this is the ONE surface a user actually looks at (the
    // headless harnesses -- thumbnails, page count, PDF export -- are never
    // shown, and their callers reject on the error result below regardless).
    //
    // Strictly after the stale-request guard above: a superseded run must not
    // paint over the render that replaced it.
    if (rootForFailureNotice) {
      const notice = document.createElement('div')
      notice.setAttribute('data-pagedown-render-error', 'true')
      notice.className = 'pagedown-render-error'
      notice.textContent = 'This preview could not be rendered.'
      // textContent throughout, and a `style` element created through the
      // nonce-stamping document.createElement -- an inline style attribute
      // would be blocked outright by this context's style-src (no
      // 'unsafe-inline'), the same constraint every other DOM this file
      // builds has to satisfy.
      const noticeStyle = document.createElement('style')
      noticeStyle.textContent = `.pagedown-render-error {
        margin: 2rem;
        font-family: system-ui, sans-serif;
        font-size: 14px;
        color: #5f6368;
      }`
      rootForFailureNotice.replaceChildren(noticeStyle, notice)
    }

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
