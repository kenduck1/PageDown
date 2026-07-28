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
import { Previewer } from 'pagedjs'
import { renderMermaidToSvg } from '../../src/diagrams/render-mermaid'
import { registerBreakHandlers } from '../../src/pagination/break-handlers'

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

interface IncomingMessage {
  type: 'render'
  html: string
  requestId: string
}

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
// because of what Gate 4 found by actually running it: this harness's
// regular 'render' path (above) always calls `previewer.preview(container,
// [], root)` — an explicitly EMPTY stylesheet array (see the 'render'
// handler's own comment on why `[]`, not falsy, matters: Previewer.preview()
// only calls its own `removeStyles()` auto-detection when `stylesheets` is
// falsy, and `[]` is truthy) — which means NO `@page` at-rule ever reaches
// Paged.js's Polisher for ANY document this harness paginates today. Traced
// directly (not assumed): `node_modules/pagedjs/src/chunker/page.js` never
// creates the per-page margin-box DOM elements; that template lives in
// `chunker.js`'s page template (14 `.pagedjs_margin-*` divs, always present,
// always empty absent a matching `@page` rule) and is populated only by
// `src/modules/paged-media/atpage.js`'s `@page`-rule handler — which never
// runs here, since there is no stylesheet for it to read. Net effect: this
// harness's on-screen render and PDF export never contain ANY running
// header/footer/page-number content for ANY corpus document today (a real,
// separate gap from this task's own scope — Gate 2's findings doc already
// flagged that frontmatter page/margin metadata isn't wired into an `@page`
// stylesheet at all). That means the design doc's "are running
// headers/footers/page numbers tagged as content vs. artifacts" Gate 4
// criterion has literally nothing to inspect against this harness's regular
// output — not a pass, not a fail, just no signal at all. This probe exists
// solely to manufacture that missing signal: it accepts an explicit `css`
// string (containing real `@page`/`@top-center`/`@bottom-center` rules) and
// forwards it to `previewer.preview()` as a real, non-empty stylesheet —
// something no other code path in this render context does — so
// `phase0/gate4-export.spec.ts` has actual generated running-header/footer
// content to export and inspect the tagging of. Reuses the SAME
// `activePreviewer`/`currentRequestId` module state as the 'render' handler
// above (Polisher-cleanup-before-next-run and stale-result-discarding both
// still apply — this is still just a `previewer.preview()` call under the
// hood), but skips the Mermaid preprocessing pass and the empty-content
// short-circuit, neither of which this probe's own callers need.
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

// Strips `@import` and external `url(...)` references from a Mermaid-
// generated <style> block's CSS text. Per the design doc's third-review
// correction (the SiYuan reference): Mermaid's rendered SVG carries an
// inline <style> block whose content is reachable, indirectly, from the
// diagram author (Mermaid `classDef` syntax accepts arbitrary CSS
// declarations on node classes), and can carry `@import`/external `url()`
// references that would fire a real outbound network request from this
// sandboxed context the moment the style is applied — the same class of
// leak `connect-src 'none'` and the remote-image-blocking policy exist to
// close everywhere else. Neutralized here as plain string surgery (not a
// full CSS parse) — adequate for this spike's corpus (none of which uses
// classDef at all, so this path is exercised defensively, not against a
// real adversarial fixture — see this task's findings-doc entry and report
// for why a dedicated adversarial-classDef corpus fixture was judged
// out of scope here).
function stripExternalCssRefs(css: string): string {
  return css
    .replace(/@import\s+[^;]+;/gi, '')
    .replace(/url\(\s*(['"]?)(?:https?:)?\/\/[^)'"]*\1\s*\)/gi, 'url()')
}

// Mermaid's render() (see node_modules/mermaid/dist/mermaid.core.mjs)
// creates its own internal <style> element via `document.createElement`
// too — meaning the SAME bootstrap shim that nonces Paged.js's own
// dynamically-created styles nonces this one too, automatically, at
// creation time, with no Mermaid-specific code required for that part.
// But with `securityLevel: 'strict'` (never 'loose'/'sandbox'), Mermaid
// pipes its fully-serialized SVG string through `DOMPurify.sanitize()`
// before returning it from renderMermaidToSvg — confirmed by reading
// mermaid.core.mjs's render() directly — and DOMPurify's default allowlist
// does not include the `nonce` attribute, so the nonce this shim attached
// survives on the live element for only as long as Mermaid keeps that
// element in the DOM, and is gone from the STRING renderMermaidToSvg
// actually returns. A <style> re-parsed from that string (e.g. via
// `element.innerHTML = svgMarkup`, exactly what this function does to turn
// the string back into a real SVG element) is nonce-less and would be
// silently blocked by this context's own CSP the instant it takes effect —
// this is the "sanitized-SVG handoff has its own CSP problem" the design
// doc's third review flags. Fixed the same way Paged.js's own styles are
// handled: never trust a nonce that arrived via markup parsing — discard the
// stale, sanitizer-stripped <style> entirely and re-create a fresh one via
// `document.createElement` (so the bootstrap shim nonces THIS one, for
// real, at creation time) carrying the same (now-scrubbed) CSS text.
function reattachNoncedStyles(svgElement: SVGElement, extraCss = ''): void {
  const staleStyles = Array.from(svgElement.querySelectorAll('style'))
  for (const stale of staleStyles) {
    const fresh = document.createElement('style')
    fresh.textContent = [stripExternalCssRefs(stale.textContent ?? ''), extraCss]
      .filter(Boolean)
      .join('\n')
    stale.replaceWith(fresh)
  }
  // Mermaid's render() always creates its own <style> (see the comment
  // above), so `staleStyles` is never actually empty in practice — this
  // branch only exists so `extraCss` (from hoistInlineStyleAttributes
  // below) is never silently dropped if that assumption ever stops holding.
  if (staleStyles.length === 0 && extraCss.trim()) {
    const fresh = document.createElement('style')
    fresh.textContent = extraCss
    svgElement.insertBefore(fresh, svgElement.firstChild)
  }
}

let hoistedStyleCounter = 0

// A SECOND, initially-unanticipated CSP problem, found only by actually
// running Gate 3 against real diagrams (not by reading the design doc, which
// only discusses the <style> BLOCK case above): Mermaid's SVG output also
// carries many individual, non-empty inline `style="..."` ATTRIBUTES —
// confirmed by dumping real rendered markup, e.g.
// `style="stroke-width: 1; stroke-dasharray: 1, 0;"` on arrow-marker
// `<path>`/`<circle>` elements, `style="stroke: none"` on node background
// `<rect>`s, and (despite `htmlLabels: false`, which does not fully
// eliminate `foreignObject` usage for flowchart EDGE labels specifically —
// itself a secondary finding worth flagging) HTML layout styles on a `<div>`
// inside a `foreignObject`. Unlike the <style> BLOCK case, there is no
// nonce-based fix for these at all: CSP nonces apply only to elements that
// carry a `nonce` content attribute (`<style>`/`<script>`), never to a
// `style=""` attribute on an arbitrary element — confirmed empirically here
// too, not just from the spec, by first observing ~130 real "Applying
// inline style violates..." console violations with only the <style>-block
// fix in place. The only CSP-compatible fix is to stop using inline style
// ATTRIBUTES entirely: this hoists every element's inline style declarations
// into a synthetic class selector and returns the equivalent CSS text, for
// the caller to fold into the SAME nonced <style> element reattachNoncedStyles
// creates — reusing that one mechanism rather than adding a second one.
// Deliberately generic (moves ANY property:value declarations, not a
// Mermaid-specific property allowlist) so this isn't reverse-engineering
// Mermaid's current internals, and works uniformly for both SVG presentation
// properties and the foreignObject HTML div's CSS layout properties, which a
// presentation-attribute conversion (the alternative fix for the SVG-only
// case) would not have covered.
//
// Untested risk, flagged on review rather than chased down here: this
// changes CSS SPECIFICITY, not just mechanism — an inline `style=""`
// attribute always wins the cascade unbeatable by any selector-based rule
// short of `!important`; a `.pd-hoisted-style-N { ... }` class rule does
// not. For THIS corpus (no diagram uses Mermaid's `classDef` syntax, which
// is how a diagram author would apply their OWN class-selector-based CSS to
// a node) this is inert — there is nothing else competing for specificity
// on these elements. A diagram that DOES use `classDef` could, in
// principle, have its own class-based styling interact differently with a
// hoisted rule than it would have with the original inline attribute
// (equal-specificity class-vs-class rules resolve by SOURCE ORDER, not by
// "inline always wins," once the inline attribute is gone) — not verified
// either way here. Worth an explicit classDef fixture in Task 9's
// pixel-identical (editor/preview/export) comparison, not assumed safe by
// extension from this corpus's result.
//
// Includes `svgElement` ITSELF, not just its descendants (Task 8 review
// fix) — `svgElement.querySelectorAll('[style]')` only matches descendants
// by definition, but Mermaid's own `configureSvgSize`/`calculateSvgSizeAttrs`
// (see fitSvgToNaturalSize's comment above) sets a `style="max-width:...px"`
// attribute directly on the SVG ROOT, which was being silently missed by
// this scan entirely. On this app's own happy path that root style
// attribute gets removed anyway, as a side effect of
// fitSvgToNaturalSize()'s own `removeAttribute('style')` call — but every
// EARLY-RETURN path through that function (missing/malformed viewBox,
// non-positive dimensions) previously left that un-hoisted, un-nonced
// `style=""` attribute sitting in the final output, uncovered by CSP,
// entirely by omission, not by any deliberate exception. Scanning the root
// here means the root's style is ALWAYS hoisted into the same nonced
// mechanism as every other element's, regardless of which path
// fitSvgToNaturalSize takes afterward.
function hoistInlineStyleAttributes(svgElement: SVGElement): string {
  const styledElements: Element[] = [svgElement, ...svgElement.querySelectorAll('[style]')]
  const rules: string[] = []
  for (const el of styledElements) {
    const declarations = el.getAttribute('style') ?? ''
    el.removeAttribute('style')
    if (!declarations.trim()) continue // e.g. Mermaid's own `style=""` no-op attributes — nothing to hoist
    const marker = `pd-hoisted-style-${hoistedStyleCounter++}`
    el.classList.add(marker)
    rules.push(`.${marker} { ${stripExternalCssRefs(declarations)} }`)
  }
  return rules.join('\n')
}

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

  const { requestId, html } = event.data
  currentRequestId = requestId

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
        diagramBoxes: []
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

    const t0 = performance.now()
    const previewer = new Previewer()
    activePreviewer = previewer
    // Passing `[]` for stylesheets: neither markdownToHtml's output nor
    // this handler's own mermaid post-processing adds any top-level
    // <style>/<link> tag of `container`'s own (remark-rehype's
    // allowDangerousHtml: false drops raw HTML nodes entirely — see
    // src/markdown/pipeline.ts; the <style> elements renderMermaidDiagrams
    // adds live inside each diagram's own <svg> subtree, not as a direct
    // child of `container`), so there is nothing for
    // Previewer.wrapContent()/removeStyles() to harvest from the document;
    // passing `container` directly as `content` and an explicit empty
    // stylesheet list avoids Previewer trying to reinterpret the whole
    // render-context <body> as the source document.
    const flow = await previewer.preview(container, [], root)
    const t1 = performance.now()

    // Discard a stale/abandoned run's result rather than publish it — see
    // the comment above `currentRequestId`. A newer 'render' message may
    // have already been dispatched (and possibly already resolved) while
    // this preview() call was still running.
    if (currentRequestId !== requestId) return

    const result: OutgoingSuccess = {
      type: 'result',
      requestId,
      pageCount: flow.total,
      ready: true,
      layoutMs: t1 - t0,
      diagramBoxes: measureDiagramBoxes(root)
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
        // pages being replaced, 147 of them here) — see this task's
        // findings doc for why that's a documented, not re-measured,
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
        // against a DOM that still holds phase 1's 297 attached page
        // elements (gate7Root isn't removed until after this call) — a
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
