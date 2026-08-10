import { useDocumentStore } from '../store/documentStore'

// Catches the failures a React error boundary structurally cannot: anything
// thrown outside a render (an event handler, a `setTimeout`, an IPC
// continuation) and every unhandled promise rejection.
//
// This app had NEITHER before -- no boundary, no `window.onerror`, no
// `unhandledrejection` handler -- and that gap has already shipped a real bug
// once: `window.prompt` throws in Electron, so Insert-link was "completely
// dead: no dialog, no link, and nothing surfaced anywhere" (appStore.ts's own
// note). The point here is not recovery, which is impossible from this
// distance; it is that a failure can never again be completely invisible.
//
// Reported through documentStore.error -- the app's existing, dismissible
// error banner -- rather than a new UI, so this reuses the one error surface
// EditorScreen already renders. Deliberately does NOT clear a previous error:
// the first failure is usually the informative one.

function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  if (typeof reason === 'string') return reason
  try {
    return JSON.stringify(reason) ?? String(reason)
  } catch {
    // A reason with a circular structure or a throwing getter must not be able
    // to turn the error reporter itself into a second error.
    return String(reason)
  }
}

function report(kind: string, reason: unknown): void {
  console.error(`[PageDown] ${kind}`, reason)
  // Set directly rather than through an action: this can fire from anywhere,
  // including before/after React has anything mounted, and setState on the
  // store is safe in all of those.
  useDocumentStore.setState({
    error: `Something went wrong (${kind}): ${describe(reason)}`
  })
}

export function installGlobalErrorHandlers(target: Window = window): () => void {
  const onError = (event: ErrorEvent): void =>
    report('unexpected error', event.error ?? event.message)
  const onRejection = (event: PromiseRejectionEvent): void =>
    report('unhandled promise rejection', event.reason)

  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)

  // Returned so a test can uninstall; production (main.tsx) installs once for
  // the lifetime of the window and never removes them.
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
