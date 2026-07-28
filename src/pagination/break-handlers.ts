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
// This harness's `sendDocument` path (resources/pagination-render/index.ts)
// deliberately calls `previewer.preview(container, [], root)` with an
// EXPLICITLY EMPTY stylesheet array (see that file's own comment on why),
// so `Breaks`' CSS-declaration-parsing path (`onDeclaration`, which only
// fires while the `Polisher` parses a real stylesheet) never runs for any
// document this harness paginates — a `break-after: avoid` CSS rule placed
// in a `<style>` tag would never reach it. Rather than route CSS text
// through `Polisher.add()` just to get these two attributes stamped, this
// handler stamps them directly, driven by heading-matching logic instead
// of parsed CSS — reusing the EXACT SAME `data-break-after`/
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
// (phase0/gate4-export.spec.ts) found exactly 4 `<th>`-tagged struct
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
// overflow measurement. For a table that splits across exactly 2 pages this
// was harmless in practice (verified: the second/last page of a 2-page
// split always has slack, since it's whatever remainder didn't fit on page
// 1, not a page packed to the boundary). But for a table spanning 3+ pages,
// inserting a per-row-content `<thead>` on a MIDDLE continuation page (one
// packed tight to the page boundary, per Paged.js's own overflow packing)
// reproducibly broke Chromium's table layout: the LAST `<tr>` on that page
// rendered visually overlapping the newly-inserted `<thead>` instead of
// after the preceding rows — content present and correct in the DOM (all
// cells intact, right text), just catastrophically mispositioned on
// screen/in the PDF. Isolated directly (phase0/gate6-break-quality.spec.ts
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
  registerHandlers(KeepWithNextHandler, TableContinuationHandler)
  registered = true
}
