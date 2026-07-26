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

interface IncomingMessage {
  type: 'render'
  html: string
  requestId: string
}

interface OutgoingResult {
  type: 'result'
  requestId: string
  pageCount: number
  ready: true
  // Wall-clock time (performance.now() delta), measured entirely inside
  // this render context, for `new Previewer().preview()` alone — i.e. real
  // Paged.js layout work, with none of the main-process round-trip
  // (executeJavaScript dispatch, the sendDocument poll loop's up-to-50ms
  // detection granularity) folded in. Not consumed by Task 6's own
  // `paginateAndTime` main-process stage split, but surfaced here so a
  // reader of the timing results can sanity-check how much of the
  // main-process-measured "sendAndPaginate" stage is genuine layout time
  // versus harness/poll overhead. See paginate.ts and the Gate 2 findings
  // notes for how this is used.
  layoutMs: number
}

// Marks this file as a module (rather than a global script) so the
// `declare global` augmentation below is valid — nothing else here needs
// to be imported/exported.
export {}

declare global {
  interface Window {
    __pagedownResult?: OutgoingResult
  }
}

window.addEventListener('message', async (event: MessageEvent<IncomingMessage>) => {
  if (event.data?.type !== 'render') return
  const root = document.getElementById('content-root')
  if (!root) return

  // Clear any previous run's rendered pages before starting a fresh one —
  // Previewer.preview() appends a new `.pagedjs_pages` container into
  // `renderTo` rather than replacing it, so without this, repeated
  // sendDocument() calls against the same harness would accumulate stale
  // page trees underneath the new one instead of replacing them.
  root.innerHTML = ''

  const t0 = performance.now()
  const previewer = new Previewer()
  // Passing `[]` for stylesheets: markdownToHtml's output never contains
  // <style>/<link> tags of its own (remark-rehype's allowDangerousHtml:
  // false drops raw HTML nodes entirely — see src/markdown/pipeline.ts), so
  // there is nothing for Previewer.wrapContent()/removeStyles() to harvest
  // from the document; passing the injected HTML directly as `content` and
  // an explicit empty stylesheet list matches the brief's sample and avoids
  // Previewer trying to reinterpret the whole render-context <body> as the
  // source document.
  const flow = await previewer.preview(event.data.html, [], root)
  const t1 = performance.now()

  const result: OutgoingResult = {
    type: 'result',
    requestId: event.data.requestId,
    pageCount: flow.total,
    ready: true,
    layoutMs: t1 - t0
  }
  window.__pagedownResult = result
})
