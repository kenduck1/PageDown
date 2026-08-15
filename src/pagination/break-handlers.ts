// Task 10 / Gate 6: first-party Paged.js break-quality handlers.
//
// Read directly from the installed Paged.js source (pagedjs@0.4.3 — same
// pin as everywhere else in this project), not guessed from the design
// doc's illustrative placeholder code:
//
// - `Handler` (node_modules/pagedjs/src/modules/handler.js): a plain base
//   class. Its constructor merges `chunker.hooks` + `polisher.hooks` +
//   `caller.hooks` (`caller` is the `Previewer` instance) into one object,
//   then for every hook NAME that also exists as a method name on the
//   subclass instance (`name in this` — true for prototype methods, not
//   just own properties), it calls `hook.register(this[name].bind(this))`.
//   So a handler "declares" which hooks it wants simply by defining a
//   method with that hook's exact name (`afterParsed`, `afterPageLayout`,
//   etc.) — there is no separate registration call inside the class body.
// - Handler *registration* (as opposed to hook wiring) is a MODULE-LEVEL,
//   not per-Previewer-instance, mechanism:
//   node_modules/pagedjs/src/utils/handlers.js exports a mutable
//   `registeredHandlers` array (seeded with the built-in
//   paged-media/generated-content/filter handlers) and a `registerHandlers`
//   function that just pushes onto it. `Previewer.preview()`
//   (node_modules/pagedjs/src/polyfill/previewer.js:150) calls
//   `this.initializeHandlers()`, which calls the imported
//   `initializeHandlers(chunker, polisher, caller)`
//   (utils/handlers.js:29-32), which does `new Handlers(chunker, polisher,
//   caller)` — and `Handlers`' constructor (utils/handlers.js:9-19)
//   iterates the SAME shared `registeredHandlers` array, instantiating a
//   fresh instance of every entry for that one `preview()` call. There is
//   no `new Previewer({ handlers: [...] })` constructor option, and no
//   per-instance `previewer.registerHandlers(...)` that scopes to just that
//   instance either — `Previewer.prototype.registerHandlers` (previewer.js
//   65-67) is only a thin forwarder to the exact same module-level
//   function. Both of the brief's illustrative guesses ("`new
//   Previewer({ handlers: [...] })`" / "`Previewer.registerHandlers(...)`")
//   are therefore not quite how it actually works: the real call is the
//   free function `registerHandlers(...)` imported from `'pagedjs'`,
//   called ONCE (module-scope side effect below), before any `Previewer`
//   is ever constructed — every later `new Previewer().preview()` call
//   picks the registered classes up automatically via the shared array.
//   Registering more than once would instantiate duplicate handler
//   instances (and fire the same hook logic twice per render) on every
//   subsequent `preview()` call, since `Handlers` re-walks the whole
//   shared array every time — `registerBreakHandlers`'s own guard below
//   exists specifically to prevent that.
//
// Both handlers below are grounded in hooks/attributes Paged.js's OWN
// built-in handlers already use for the same class of problem (see the
// per-class comments), not new mechanisms invented for this task.

import { Handler, registerHandlers } from 'pagedjs'

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6'

// --- KeepWithNextHandler ---------------------------------------------------
//
// Goal (design doc's "Known Risks" / Gate 6 criteria): a heading must not be
// stranded alone at the bottom of a page while the content that explains it
// starts the next page.
//
// Mechanism, traced directly through Paged.js's own overflow-detection path
// rather than invented fresh:
// - `Breaks` (node_modules/pagedjs/src/modules/paged-media/breaks.js) is
//   Paged.js's own built-in handler for CSS `break-after`/`break-before`
//   declarations. For a rule like `h2 { break-after: avoid }`, its
//   `processBreaks` (breaks.js:77-121) stamps `data-break-after="avoid"` on
//   the heading itself AND `data-previous-break-after="avoid"` on the
//   element immediately after it (`displayedElementAfter`).
// - `Layout.findOverflow` (node_modules/pagedjs/src/chunker/layout.js,
//   the walk starting at line 539) is what actually decides where a page
//   breaks: while walking the page's rendered content, the first node whose
//   box falls outside the page bounds is found, and line 573 checks
//   `breakAvoid = node.dataset.breakBefore === "avoid" || node.dataset
//   .previousBreakAfter === "avoid"`. When true, `prev = breakAvoid &&
//   nodeBefore(node, rendered)` (line 574) and the break range is set to
//   `prev` instead of the overflowing node itself (lines 620-624) — i.e.
//   the break point is pulled BACKWARD to include the node immediately
//   before the overflowing one, pushing both to the next page as a unit.
//   For the stranded-heading case, `node` is the paragraph that doesn't
//   fit, and (with `data-previous-break-after="avoid"` stamped on it) `prev`
//   resolves to the heading right before it — exactly keep-with-next.
//
// PREMISE CORRECTED (final whole-branch review of the Document Typography
// sub-project). This comment used to justify the attribute-stamping
// approach below on the grounds that this harness's `sendDocument` path
// (resources/pagination-render/index.ts) calls `previewer.preview(container,
// [], root)` with an EXPLICITLY EMPTY stylesheet array, so `Breaks`'
// CSS-declaration-parsing path (`onDeclaration`) could never run and a
// `break-after: avoid` rule in a stylesheet could never reach it. That is
// no longer true: that path now passes a real, non-empty stylesheet
// (`buildDocumentStylesheet`, the shared document typography), so the `Polisher`
// parses author CSS on every render and `Breaks.onDeclaration` DOES run.
// It is a no-op today only because `document-typography.css` declares none
// of the four properties it actually reacts to — read from breaks.js
// directly, those are exactly `page`, `break-before`, `break-after`, and
// the legacy `page-break-before`/`page-break-after` aliases it normalizes
// onto the latter two. `break-inside` is NOT among them; Paged.js honours
// that one on a completely different path, by reading
// `getComputedStyle(node)["break-inside"]` inside `Layout.findOverflow`
// (layout.js:383, 565, 572, 589) and via `breakInsideAvoidParentNode`
// (utils/dom.js:683).
//
// So CSS-driven break control is now genuinely AVAILABLE here, by BOTH
// routes — the Polisher one because a stylesheet is finally being parsed,
// and the computed-style one because that stylesheet's rules now actually
// reach the rendered document. A `break-inside: avoid` on tables or
// headings added to the shared typography stylesheet would be honoured, and
// is a reasonable thing for a future task to reach for. What survives the
// correction is the narrower,
// still-true reason this handler stamps attributes directly rather than
// declaring CSS: the rule it needs is "keep every heading with WHATEVER
// element happens to follow it", which is a relationship between two
// sibling elements, not a property of a selector-matchable one. `Breaks`
// implements exactly that relationship by stamping `data-break-after` on
// the matched element AND `data-previous-break-after` on its
// `displayedElementAfter` — so a hypothetical `h1, h2, ... { break-after:
// avoid }` rule in the shared stylesheet would produce the same two
// attributes this handler writes itself, at the cost of putting a
// pagination-behavior rule inside a file whose whole premise is that both
// surfaces share it (the Milkdown editor has no page boxes and would
// simply ignore it). Stamping here keeps break policy in the pagination
// layer, and reuses the EXACT SAME `data-break-after`/
// `data-previous-break-after` attribute contract `Breaks`/`layout.js`
// already implement and rely on, just populated a different way.
//
// Uses the `afterParsed` hook (fired once per `chunker.flow()` call, right
// after `ContentParser` builds/refs the source tree — chunker.js:168 —
// and BEFORE any page layout starts), the same hook `Breaks`, `Lists`, and
// `Following` all use for their own one-time, whole-document DOM
// annotation passes. Confirmed by reading parser.js: `ContentParser`'s
// constructor `return`s the input Node/DocumentFragment directly
// (parser.js:9-18 — `return this.dom`, a constructor short-circuit), so the
// `parsed` argument here IS the live DocumentFragment `chunker.source` ends
// up pointing at, not a copy — attributes stamped on it here survive into
// every later page's rendered clone (`Layout.append`'s `cloneNode(node,
// deep)` — layout.js:281 — copies all attributes, including these).
export class KeepWithNextHandler extends Handler {
  afterParsed(parsed: ParentNode): void {
    const headings = Array.from(parsed.querySelectorAll(HEADING_SELECTOR))
    for (const heading of headings) {
      const next = nextDisplayedElement(heading)
      if (!next) continue // last element in the document — nothing to keep it with
      heading.setAttribute('data-break-after', 'avoid')
      next.setAttribute('data-previous-break-after', 'avoid')
    }
  }
}

// Simplified stand-in for Paged.js's own `displayedElementAfter`
// (utils/dom.js:103-111, itself not part of the package's public 'pagedjs'
// entry point — only `Chunker`/`Polisher`/`Previewer`/`Handler`/
// `registeredHandlers`/`registerHandlers`/`initializeHandlers` are exported
// from src/index.js, confirmed by reading it directly): `nextElementSibling`
// already skips whitespace/comment/text nodes by DOM spec, which covers
// every heading/paragraph adjacency in this project's reference corpus.
// The one thing the real `displayedElementAfter` additionally skips
// (`dataset.undisplayed` — content Paged.js's own `undisplayed.js` filter
// marks, e.g. `display: none` source content) is not exercised by any
// corpus fixture and is left unhandled here rather than reimplementing
// Paged.js's private utility surface for a case this spike never sees.
function nextDisplayedElement(node: Element): Element | null {
  return node.nextElementSibling
}

// --- TableContinuationHandler -----------------------------------------------
//
// Goal (design doc's "Known Risks" / Gate 6 criteria): a table split across
// a page boundary should repeat its header row on the continuation page,
// not just resume mid-body with no column context.
//
// What Paged.js does WITHOUT this handler, traced directly: when a table
// overflows, `Layout.append` (layout.js:279-308) reconstructs just enough
// ancestor structure for the first node landing on the new page via
// `rebuildAncestors` (utils/dom.js:136-230) — a shallow `cloneNode(false)`
// of every ancestor up to (not including) the page root, each stamped with
// `data-split-from="<original data-ref>"` (dom.js:189). For a `<tr>` whose
// ancestors are `[table, tbody]`, this reconstructs an empty `<table
// data-split-from="...">` and `<tbody data-split-from="...">` — the
// original `<thead>` is a SIBLING of `<tbody>`, not an ancestor of the
// overflowing `<tr>`, so it is never part of this walk and is never
// reconstructed. Confirmed empirically, not just from reading the source:
// Task 9/Gate 4's synthetic-table struct-tree test
// (tests/gates/gate4-export.spec.ts) found exactly 4 `<th>`-tagged struct
// elements total (one header row's worth) across a table that splits into
// two page fragments, not 8 — the header genuinely does not repeat today.
//
// First implementation tried (documented here because the reason it
// changed is real evidence, not just a design note): inserting the cloned
// `<thead>` on `afterPageLayout` (chunker.js:365 — fired once per finalized
// page, the same hook `Splits`/`Breaks`/`Lists` all use for their own
// post-layout fixups), immediately, for EVERY continuation table found on
// that page. That fires AFTER the page's content has already been measured
// and committed to fit the page bounds (`Layout.findOverflow` already
// decided which rows belong on this page before this hook ever runs) — so
// the extra `<thead>` height is never accounted for by Paged.js's own
// overflow measurement. For the specific table tested at a 2-page split
// this was harmless in practice (verified directly, not assumed) — but NOT
// because a table's remainder page is structurally guaranteed to have
// slack (it isn't: nothing prevents a table's last page from happening to
// fill almost exactly to the boundary too). The real structural reason
// this case is safe is the row-completion mechanism described below, not
// leftover space. But for a table spanning 3+ pages,
// inserting a per-row-content `<thead>` on a MIDDLE continuation page (one
// packed tight to the page boundary, per Paged.js's own overflow packing)
// reproducibly broke Chromium's table layout: the LAST `<tr>` on that page
// rendered visually overlapping the newly-inserted `<thead>` instead of
// after the preceding rows — content present and correct in the DOM (all
// cells intact, right text), just catastrophically mispositioned on
// screen/in the PDF. Isolated directly (tests/gates/gate6-break-quality.spec.ts
// and this task's own investigation, not assumed): the bug requires BOTH
// (a) a `<thead>` with at least one real row/cell inserted after the page
// was laid out (an empty `<thead>`, or an unrelated element like
// `<colgroup>`, does not trigger it) AND (b) the page's own last `<tr>`
// having been completed via Paged.js's `Layout.rebuildTableFromBreakToken`
// (layout.js:327-342) mid-row-split-completion path — the mechanism that
// appends a row's remaining `<td>` siblings one at a time so a table row
// split by the page boundary still shows as one complete row, rather than
// a truncated one, on the page where it started. Every MIDDLE continuation
// page's own last row goes through exactly that path (there IS a following
// overflow to complete around); the LAST continuation page of any split
// (2-page or N-page) never does (nothing follows it, so nothing needed
// completing) — which is exactly why the 2-page case never showed the bug
// and the 5-page case did, on every middle page, reproducibly.
//
// Fix: only ever insert the repeated header into the LAST continuation
// fragment of a given original table — the one page-fragment structurally
// guaranteed not to have gone through the row-completion path above, and
// therefore structurally guaranteed not to trigger this bug. This can only
// be determined once ALL pages exist (a fragment can't know whether a LATER
// page will also continue the same table while its own page is still being
// laid out), so this uses `afterRendered` (chunker.js:112/181 — fired
// exactly once, with `this.pages` and the chunker itself, after every page
// is finalized) instead of `afterPageLayout`. Every continuation
// `<table data-split-from="...">` across every finalized page is grouped by
// that shared `data-split-from` ref (identical across every fragment of the
// same original table — `rebuildAncestors`, utils/dom.js:136-230, always
// re-clones from the SAME original ancestor in `chunker.source`, so every
// fragment inherits the same `data-ref`/`data-split-from`); only the
// highest-page-index fragment in each group gets the repeated header.
//
// Honest limitation of this fix, not papered over: a table spanning 3+
// pages now gets its header repeated ONLY on the final page, not on every
// middle continuation page — strictly better than shipping the
// afterPageLayout version's real visual-corruption bug, but still short of
// "every continuation page shows the header," which is what the design doc
// actually wants. Getting every middle page right would mean reserving
// space for the header BEFORE `Layout.findOverflow` measures that page at
// all (e.g. pre-seeding the page wrapper before `Layout.renderTo`'s own
// walk begins, so its own overflow bookkeeping counts the header's height
// from the start) — a materially bigger change than this spike's scope,
// and not attempted here. See this task's report/findings-doc entry for
// the measured evidence behind both the bug and this fix.
export class TableContinuationHandler extends Handler {
  afterRendered(pages: Array<{ element: HTMLElement }>, chunker: { source: ParentNode }): void {
    const fragmentsByRef = new Map<string, Array<{ pageIndex: number; table: HTMLTableElement }>>()

    pages.forEach((page, pageIndex) => {
      const tables = Array.from(
        page.element.querySelectorAll('table[data-split-from]')
      ) as HTMLTableElement[]
      for (const table of tables) {
        const ref = table.getAttribute('data-split-from')
        if (!ref) continue
        const list = fragmentsByRef.get(ref) ?? []
        list.push({ pageIndex, table })
        fragmentsByRef.set(ref, list)
      }
    })

    for (const fragments of fragmentsByRef.values()) {
      // The highest pageIndex in the group is the LAST continuation
      // fragment of this original table — the only one safe to modify per
      // the comment above.
      const last = fragments.reduce((a, b) => (b.pageIndex > a.pageIndex ? b : a))
      const table = last.table

      // Defensive, not expected to ever be true given the traced behavior
      // above — but if some future Paged.js version DOES start carrying
      // `<thead>` across a split, this must not double it up.
      if (table.querySelector(':scope > thead')) continue

      const originalRef = table.getAttribute('data-split-from')
      if (!originalRef) continue

      const originalTable = chunker.source.querySelector(`table[data-ref="${originalRef}"]`)
      const originalThead = originalTable?.querySelector(':scope > thead')
      if (!originalThead) continue // table has no header row to repeat at all

      const clonedThead = originalThead.cloneNode(true) as HTMLElement
      // Strip every `data-ref` in the cloned subtree before it enters the
      // live page tree: `data-ref` is Paged.js's own node-identity key
      // (`Layout.append`, layout.js:310-315, indexes every rendered node
      // with a `data-ref` into `dest.indexOfRefs` for later lookup by
      // `findElement`/`findRef`) — leaving the ORIGINAL thead's refs on
      // this clone would register a second element under the same ref as
      // the original header row, which nothing in this handler needs and
      // which could confuse a later `findElement`/`data-ref` lookup
      // elsewhere in the pipeline.
      clonedThead.removeAttribute('data-ref')
      for (const el of Array.from(clonedThead.querySelectorAll('[data-ref]'))) {
        el.removeAttribute('data-ref')
      }
      clonedThead.classList.add('pagedown-continuation-header')
      table.insertBefore(clonedThead, table.firstChild)
    }
  }
}

// --- OverflowFitHandler ------------------------------------------------------
//
// Fixes a real, measured PRINT-FIDELITY CONTENT-LOSS bug: a long fenced code
// block split across pages silently lost ~1-2 lines of real text from the
// EXPORTED PDF on every page carrying an internal split of that block. Found
// via tests/gates/corpus/code-blocks-spanning-pages.md; characterized before this
// handler existed as gate4-export.spec.ts's `PRE_SPLIT_TRUNCATION_FILES`
// category (now removed, since this fixes it).
//
// ROOT CAUSE, measured end-to-end rather than reasoned from docs:
//
// 1. Paged.js decides a text break in `Layout.textBreak`
//    (node_modules/pagedjs/src/chunker/layout.js:732-790). It walks the
//    overflowing text node word by word and breaks at the first word whose
//    `top >= vEnd`, i.e. the first word that starts BELOW the page's content
//    box. A line whose top is above the boundary but whose BOTTOM falls below
//    it therefore stays on the page, hanging past the content box. Nothing in
//    that walk accounts for the containing element's own bottom padding or
//    bottom border either, which sit BELOW that last line and push the box
//    further past the boundary still.
// 2. That is invisible for ordinary prose in this project's reference corpus
//    (measured directly: of 15 corpus files, only `code-blocks-spanning-
//    pages.md` and `mermaid-diagrams.md` ever leave a page's content
//    extending past the content box at all). A fenced code block is the
//    common case that DOES trip it, because `document-typography.css` gives
//    `pre` a real box -- `padding: 0.85em 1em` plus a 1px border, i.e. 12.9px
//    of chrome below the final line that Paged.js's line-based measurement
//    never sees. Measured overflow on the fixture: 6.59px, 18.48px, 18.48px
//    on its three internally-split pages.
// 3. Chromium's `printToPDF` then does not paint what hangs past the content
//    box. `.pagedjs_page_content` is a fixed-height (`height: 100%` of the
//    864px content area) `column-fill: auto` box, so the excess is treated as
//    fragmentation overflow rather than as visible spill. Confirmed as REAL
//    content loss, not an extraction artifact, three independent ways: pdfjs
//    `getTextContent()`, poppler `pdftotext` (an entirely separate
//    implementation), and rasterising the page with `pdftoppm` and looking at
//    it -- the code block's grey box paints at full height with the final
//    lines simply blank inside it. It is not a tagged-PDF artifact either
//    (`generateTaggedPDF: false` loses exactly the same text), and it is not
//    a page-position clip: absolutely-positioned probe text injected into the
//    SAME subtree at 20px intervals from y=700 to y=1000 painted at EVERY
//    offset, including well below the lines that vanished.
//
// WHAT WAS RULED OUT, so nobody re-treads it:
// - Not a markdown-pipeline bug: `markdownToHtml`'s raw output has every
//   character, checked before the HTML ever reaches the render context.
// - Not `overflow-x: auto` on `pre` per se. Removing the scroll container
//   (`overflow-x: visible`/`clip`) does shrink the loss, but it does not
//   remove it, and it makes things WORSE in a way that is easy to miss: with
//   no scroll container the `<pre>` stops being monolithic, so Chromium
//   fragments it for real -- measured `pre.getClientRects().length === 2`
//   with a used height of 912.59px inside an 864px first fragment, and the
//   second fragment's line boxes land back at the TOP of the same page
//   (y~116px), overlapping content that is already there. `overflow-x: auto`
//   is therefore load-bearing and must stay.
// - Not the `@page` margin, print-media CSS, or a scale/offset difference:
//   `Emulation.setEmulatedMedia('print')` produces layout numbers identical
//   to screen, and PDF text coordinates map 1:1 onto sheet-relative CSS
//   pixels (a code line's PDF x of 83.2pt == the measured 111px text origin).
// - Not fixable by padding tweaks, measured rather than argued: against the
//   shipped CSS, `padding-bottom: 2em` changed nothing (112 characters lost
//   vs. 111 at baseline, same three pages); stripping the padding AND border
//   entirely still lost text (two pages); and adding that padding on top of
//   the `overflow-x: clip` variant made it strictly worse (49 characters lost
//   vs. 24 without it). Only moving the BREAK reaches zero.
//
// THE FIX: pull the break point back, by whole lines, until what remains on
// the page genuinely fits inside the layout bounds. `onOverflow`
// (chunker.js:107, triggered at layout.js:484 with the overflow Range, the
// rendered wrapper, and the layout bounds) is the sanctioned hook for exactly
// this: a handler may RETURN a replacement Range, and Paged.js then uses it
// for BOTH `createBreakToken` and `removeOverflow`, so the break token and the
// extracted content stay consistent by construction.
//
// Deliberately NOT scoped to `pre` by selector, even though `pre` is the only
// element measured to trip this. The guard is the measurement itself -- the
// handler returns immediately when the kept content already fits -- so it is
// inert on every page Paged.js already breaks correctly, which is every page
// of every other corpus file. Scoping by tag name would fix one symptom and
// leave the same bug live for any future element that grows a bottom border
// or padding (blockquote, a callout, a themed table).
//
// It only ever acts on a TEXT-node break, which also kept it away from
// `mermaid-diagrams.md`'s own, separate oversized-SVG content loss: that page
// overflowed by ~1092px from an ELEMENT-node break, which stepping back text
// lines could not have fixed anyway.
//
// CORRECTION: that second bug is no longer open. It used to be described here
// as "still-open, deliberately pinned in gate4", and it was — Gate 4 asserted
// the ABSENCE of the diagram's own node labels from the exported PDF. It is
// now fixed at its own layer, by resources/pagination-render/index.ts's
// fitSvgToPageBox scaling a too-tall diagram into the page content box so the
// split never happens, and Gate 4's assertions are inverted accordingly. The
// scoping statement above still holds and is still the reason this handler is
// safe; only its example is now historical.
const MAX_LINE_STEPS = 12

// Upper bound on how many text nodes a single retreat may walk backwards
// through before giving up. Only relevant for syntax-highlighted content,
// where one rendered line is spread across many `hljs-*` token nodes; a line
// of code is a handful of tokens, so this is generous, and it exists purely so
// a pathological document cannot turn a break decision into an unbounded walk
// of layout-forcing measurements.
const MAX_NODES_SCANNED = 64

// Slack when comparing a measured client-rect edge against the bounds. Both
// numbers are sub-pixel floats from real layout, so an exact `<=` would flip
// on rounding noise alone.
const FIT_TOLERANCE_PX = 0.5

// Minimum drop in the kept-content bottom that counts as "a whole line
// earlier". Guards the same sub-pixel noise as above from being mistaken for
// real progress in the binary search below.
const LINE_TOLERANCE_PX = 0.5

interface KeptContent {
  bottom: number
  height: number
}

function isTextNode(node: Node | null | undefined): node is Text {
  return !!node && node.nodeType === 3
}

// The bottom edge, and line height, of the LAST rendered line that would
// remain on this page if the break happened at `offset`.
//
// Measured with a real Range over [0, offset) rather than computed from line
// counts: the text may wrap (`white-space: pre-wrap`), may be interleaved with
// `rehype-highlight`'s `<span class="hljs-*">` tokens in sibling nodes, and
// may sit under any line-height the active document theme picked. Zero-width
// and zero-height rects are skipped on purpose -- Chromium emits a degenerate
// rect for a range that ends exactly at a line start (and for a blank line in
// a `pre`), and counting one would report the FOLLOWING line's bottom and make
// this function non-monotonic, which the binary search below depends on.
function keptContentBottom(node: Text, offset: number): KeptContent | null {
  if (offset <= 0) return null
  const range = document.createRange()
  range.setStart(node, 0)
  range.setEnd(node, offset)
  const rects = range.getClientRects()
  let found: KeptContent | null = null
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i]
    if (rect.width <= 0 || rect.height <= 0) continue
    if (!found || rect.bottom > found.bottom) {
      found = { bottom: rect.bottom, height: rect.height }
    }
  }
  return found
}

// The largest offset in [1, high] within `node` whose kept content ends on an
// EARLIER line than `currentBottom`, or 0 if this node has no such offset.
// Binary search is valid because keptContentBottom is monotonic non-decreasing
// in `offset` (later text is never higher on the page).
//
// Returning the LARGEST such offset (rather than the first one found) is what
// keeps the break at a natural boundary: for a `pre`, it lands immediately
// after the newline that ends the retained line, so the retained fragment
// keeps its trailing newline and the continuation fragment starts at the next
// line's own indentation -- no blank line injected at the top of the
// continuation, which a naive "step back to the previous line's start" would
// produce.
function lastOffsetAboveLine(node: Text, high: number, currentBottom: number): number {
  let low = 1
  let best = 0
  let hi = high
  while (low <= hi) {
    const mid = (low + hi) >> 1
    const measured = keptContentBottom(node, mid)
    if (!measured || measured.bottom < currentBottom - LINE_TOLERANCE_PX) {
      best = mid
      low = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

interface BreakPosition {
  node: Text
  offset: number
}

// The last break position anywhere in `block` that lands on an earlier line
// than `currentBottom`.
//
// Searching ACROSS text nodes (not just inside the one Paged.js picked) is
// what makes this work for a SYNTAX-HIGHLIGHTED code block, and it is a real,
// measured requirement rather than defensive generality: `rehype-highlight`
// splits the block into ~150 `<span class="hljs-*">` tokens, so the text node
// the break lands in is routinely a few characters long and contains no
// earlier line at all. Restricted to `block`'s own subtree so a retreat can
// never escape the element being split.
//
// `keptContentBottom` stays scoped to a single node throughout: its rects are
// absolute viewport coordinates, so the bottom it reports is the real line
// bottom regardless of how little of that line the node covers.
function previousBreakPosition(
  block: Element,
  node: Text,
  offset: number,
  currentBottom: number
): BreakPosition | null {
  const within = lastOffsetAboveLine(node, offset - 1, currentBottom)
  if (within > 0) return { node, offset: within }

  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  walker.currentNode = node
  for (let visited = 0; visited < MAX_NODES_SCANNED; visited++) {
    const previous = walker.previousNode()
    if (!previous) return null
    const text = previous as Text
    const found = lastOffsetAboveLine(text, text.length, currentBottom)
    if (found > 0) return { node: text, offset: found }
  }
  return null
}

export class OverflowFitHandler extends Handler {
  onOverflow(
    overflow: Range | undefined,
    rendered: Element | undefined,
    bounds: DOMRect | undefined
  ): Range | undefined {
    if (!overflow || !rendered || !bounds) return undefined
    const container = overflow.startContainer
    if (!isTextNode(container)) return undefined
    const parent = container.parentElement
    if (!parent || !rendered.contains(parent)) return undefined

    // Everything each ancestor box paints BELOW its own last line: bottom
    // padding and bottom border, summed up to (but excluding) the page
    // wrapper Paged.js renders into. This is the part `textBreak` is blind
    // to, and for a fenced code block it is the dominant term. The same walk
    // finds the outermost ancestor still inside the page wrapper -- the
    // element actually being split -- which bounds the cross-node retreat
    // below.
    let chrome = 0
    let block: Element = parent
    for (let element: Element | null = parent; element && element !== rendered;) {
      const style = window.getComputedStyle(element)
      chrome += parseFloat(style.paddingBottom) || 0
      chrome += parseFloat(style.borderBottomWidth) || 0
      block = element
      element = element.parentElement
    }

    let measured = keptContentBottom(container, overflow.startOffset)
    if (!measured) return undefined

    // A client rect covers the text's own box, not the full line box, so the
    // line's half-leading sits below the measured bottom and has to be
    // reserved too. Derived from the element's real used line-height rather
    // than assumed, since the document themes change it.
    const lineHeight = parseFloat(window.getComputedStyle(parent).lineHeight)
    const halfLeading = Number.isFinite(lineHeight)
      ? Math.max(0, (lineHeight - measured.height) / 2)
      : 0
    const limit = bounds.bottom - chrome - halfLeading

    // The overwhelmingly common case, and the reason this handler is safe to
    // register globally: Paged.js already broke this page correctly, so leave
    // its Range exactly as it is.
    if (measured.bottom <= limit + FIT_TOLERANCE_PX) return undefined

    let position: BreakPosition = { node: container, offset: overflow.startOffset }
    for (let step = 0; step < MAX_LINE_STEPS; step++) {
      // `null` means there is no earlier line anywhere in the element being
      // split -- retreating further is Paged.js's own "break before the whole
      // element" case, which it already handles, so hand the original Range
      // back untouched rather than emptying the fragment.
      const previous = previousBreakPosition(block, position.node, position.offset, measured.bottom)
      if (!previous) return undefined
      position = previous
      const next = keptContentBottom(position.node, position.offset)
      if (!next) return undefined
      measured = next
      if (measured.bottom <= limit + FIT_TOLERANCE_PX) {
        overflow.setStart(position.node, position.offset)
        return overflow
      }
    }
    return undefined
  }
}

// --- SignificantWhitespaceHandler --------------------------------------------
//
// Fixes a second, independent, also-measured content-loss bug in the same
// area: on a page that CONTINUES a split element, whitespace-only text nodes
// sitting between two inline elements are dropped outright. In a
// syntax-highlighted code block that means `def acquire(...)` renders and
// exports as `defacquire(...)` -- confirmed on the real fixture with a
// `python` info string, which produces 156 `hljs-*` spans: `defacquire`,
// `withself` and `defwrapped` all appear in the paginated output.
//
// ROOT CAUSE, read straight out of the pinned pagedjs@0.4.3 source:
// `Layout.renderTo` (layout.js:177-180) does `walker = walk(nodeAfter(node,
// source), source)` after appending any node it deep-cloned, and `isContainer`
// (utils/dom.js:408-476) reports FALSE for every inline tag -- `SPAN`,
// `STRONG`, `EM`, `CODE`, ... -- so every one of them is deep-cloned and
// triggers that jump. `nodeAfter` (dom.js:41-60) resolves through
// `nextSignificantNode`, which skips anything `isIgnorable` (dom.js:632-635)
// calls ignorable: a comment, or A TEXT NODE THAT IS ENTIRELY WHITESPACE. The
// skipped node is never appended to the page, so the space is simply gone.
//
// Why this only shows up on a split: the FIRST fragment of a `<pre>` is
// produced by one deep `cloneNode(true)` of the whole element, which copies
// its whitespace verbatim. Only a CONTINUATION fragment starts the walk at a
// text node INSIDE the element and therefore walks its inline children one by
// one, which is where the skip happens.
//
// THE FIX: make the whitespace non-ignorable before Paged.js ever walks it, by
// wrapping it in a `<span>`. `isIgnorable` tests node type, so an ELEMENT is
// never skipped, and `nodeAfter` then lands on the wrapper and renders it. A
// bare `<span>` around whitespace is layout-neutral on both surfaces (it
// matches no rule in document-typography.css and adds no box of its own), so
// this cannot move Gate 10's editor/paginator parity.
//
// `beforeParsed` (chunker.js:150) rather than `afterParsed`, and that ordering
// is load-bearing: `ContentParser.addRefs` (parser.js:43-66) stamps `data-ref`
// on every element it walks, and `validNode`/`prevValidNode`/`rebuildAncestors`
// all key off that attribute. Wrapping after the parse would inject elements
// Paged.js considers invalid. `ContentParser.add` mutates the node it is given
// in place (`return this.dom`, no clone), so the wrappers added here are the
// ones that get refs.
//
// Deliberately NARROW. Two conditions must hold, because the same skip is
// harmless nearly everywhere else:
//   - the previous sibling must be an ELEMENT. That is the only way the
//     `nodeAfter` jump above can reach (and skip) this node at all.
//   - the whitespace must be RENDERED: either it is inside a `<pre>`, where
//     `white-space` preserves it, or it separates two inline boxes, where
//     collapsing it away glues two words together. Whitespace between two
//     BLOCK elements is collapsible and invisible, so wrapping it would add
//     stray inline boxes for no benefit.
const INLINE_TAGS = new Set([
  'A',
  'ABBR',
  'B',
  'BDI',
  'BDO',
  'BIG',
  'CITE',
  'CODE',
  'DEL',
  'DFN',
  'EM',
  'I',
  'IMG',
  'INS',
  'KBD',
  'MARK',
  'Q',
  'S',
  'SAMP',
  'SMALL',
  'SPAN',
  'STRONG',
  'SUB',
  'SUP',
  'TIME',
  'U',
  'VAR'
])

// Same whitespace definition `isIgnorable`/`isAllWhitespace` use (dom.js:645),
// deliberately NOT `\s`: that would also match a non-breaking space, which
// Paged.js does not treat as ignorable and which must not be rewritten here.
const WHITESPACE_ONLY = /^[\t\n\r ]+$/

function isInlineElement(node: Node | null): boolean {
  return !!node && node.nodeType === 1 && INLINE_TAGS.has((node as Element).tagName)
}

export class SignificantWhitespaceHandler extends Handler {
  beforeParsed(content: ParentNode): void {
    const doc = content.ownerDocument ?? document
    const walker = doc.createTreeWalker(content as Node, NodeFilter.SHOW_TEXT)
    const targets: Text[] = []
    let node = walker.nextNode()
    while (node) {
      const text = node as Text
      if (WHITESPACE_ONLY.test(text.data) && shouldPreserveWhitespace(text)) {
        targets.push(text)
      }
      node = walker.nextNode()
    }
    // Collected first, rewritten second: moving a node while a TreeWalker is
    // positioned on it is exactly the case where its traversal state is
    // defined against a tree that no longer matches.
    for (const text of targets) {
      const wrapper = doc.createElement('span')
      wrapper.setAttribute('data-pagedown-space', 'true')
      text.replaceWith(wrapper)
      wrapper.appendChild(text)
    }
  }
}

function shouldPreserveWhitespace(text: Text): boolean {
  // Only a PRECEDING ELEMENT can trigger the `nodeAfter` jump that skips this
  // node; with a text node (or nothing) before it, the plain `walk` reaches it
  // normally and it is never at risk.
  const previous = text.previousSibling
  if (!previous || previous.nodeType !== 1) return false
  const parent = text.parentElement
  if (!parent) return false
  if (parent.closest('pre')) return true
  return isInlineElement(previous) && isInlineElement(text.nextSibling)
}

let registered = false

// Called once, at render-context module load (resources/pagination-render/
// index.ts), before the first `new Previewer()` — see this file's top
// comment for why registration is a one-time, module-level side effect
// rather than something scoped to a single Previewer instance. Guarded
// (rather than a bare top-level `registerHandlers(...)` call) so an
// accidental second call from a future caller fails safe instead of
// silently double-instantiating these handlers on every subsequent
// `preview()` call.
export function registerBreakHandlers(): void {
  if (registered) return
  registerHandlers(
    KeepWithNextHandler,
    TableContinuationHandler,
    OverflowFitHandler,
    SignificantWhitespaceHandler
  )
  registered = true
}
