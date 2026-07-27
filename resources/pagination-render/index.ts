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

// Marks this file as a module (rather than a global script) so the
// `declare global` augmentation below is valid — nothing else here needs
// to be imported/exported.
export {}

declare global {
  interface Window {
    __pagedownResult?: OutgoingMessage
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
