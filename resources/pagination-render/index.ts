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
// against pagedjs's own source). Content this context injects from
// untrusted Markdown-derived HTML can only ever introduce a <style> element
// via HTML PARSING (assigning into innerHTML / Previewer's own content
// handling), never via a `document.createElement` call made on attacker
// data, so attacker-controlled <style> tags never receive this nonce and
// stay blocked by CSP exactly as before. This is deliberately narrower than
// a blanket `style-src 'unsafe-inline'`: only scripts running on this page
// can mint a nonced <style> element at all, and only Paged.js's own code
// does so today.
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
  fullEditedMs: number
  totalPagesEdited: number
  controlPagesText: string[]
}

interface Gate7Error {
  type: 'gate7-error'
  requestId: string
  ok: false
  error: string
}

type Gate7Result = Gate7Phase1Success | Gate7Phase2Success | Gate7Error

// Marks this file as a module (rather than a global script) so the
// `declare global` augmentation below is valid — nothing else here needs
// to be imported/exported.
export {}

declare global {
  interface Window {
    __pagedownResult?: OutgoingMessage
    __pagedownGate7Result?: Gate7Result
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
        layoutMs: 0
      }
      if (currentRequestId === requestId) window.__pagedownResult = result
      return
    }

    const t0 = performance.now()
    const previewer = new Previewer()
    activePreviewer = previewer
    // Passing `[]` for stylesheets: markdownToHtml's output never contains
    // <style>/<link> tags of its own (remark-rehype's allowDangerousHtml:
    // false drops raw HTML nodes entirely — see src/markdown/pipeline.ts),
    // so there is nothing for Previewer.wrapContent()/removeStyles() to
    // harvest from the document; passing the injected HTML directly as
    // `content` and an explicit empty stylesheet list matches the brief's
    // sample and avoids Previewer trying to reinterpret the whole
    // render-context <body> as the source document.
    const flow = await previewer.preview(html, [], root)
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
      layoutMs: t1 - t0
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
//   internally: `addPage()`'s `onOverflow` handler (chunker.js, inside
//   `addPage`) reacts to a page overflowing by calling
//   `this.removePages(index)` then `this.render(this.source, this.breakToken)`
//   to redo layout from that point forward, all within the SAME Chunker
//   instance and the SAME parsed content tree.
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
// behavior) that aren't part of any stable contract. See
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

        // The resume-no-edit sanity check: exactly the sequence Paged.js's
        // own onOverflow handler uses internally (see the block comment
        // above), called from outside instead of from that internal
        // callback, on UNCHANGED content — the simplest possible test of
        // whether bypassing flow() this way produces correct output at all.
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
        // against the resumed run above.
        const controlRoot = makeOffscreenRoot()
        const controlPreviewer = new Previewer()
        const t2 = performance.now()
        const controlFlow = await controlPreviewer.preview(editedHtml, [], controlRoot)
        const t3 = performance.now()
        const controlPagesText: string[] = controlPreviewer.chunker.pages
          .slice(targetPageIndex)
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
          fullEditedMs: t3 - t2,
          totalPagesEdited: controlFlow.total,
          controlPagesText
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
