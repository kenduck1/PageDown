// Runs inside the sandboxed pagedown-render:// context. This script has no
// Node.js or Electron API access (sandbox: true, no preload script) and is
// built as a fully self-contained bundle independent of the main app's
// renderer — see scripts/build-pagination-render.ts.
//
// Communication with the main process is one-directional-in / poll-out:
//   in:  window.postMessage(...) from view.webContents.executeJavaScript
//   out: main polls `window.__pagedownResult` via executeJavaScript
// This avoids any IPC/preload surface on this context.

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

window.addEventListener('message', (event: MessageEvent<IncomingMessage>) => {
  if (event.data?.type !== 'render') return
  const root = document.getElementById('content-root')
  if (!root) return
  root.innerHTML = event.data.html
  // Paged.js integration lands in Task 4+; for this task, just echo back
  // a synthetic result so the data channel itself can be verified end to end.
  const result: OutgoingResult = {
    type: 'result',
    requestId: event.data.requestId,
    pageCount: 1,
    ready: true
  }
  window.__pagedownResult = result
})
