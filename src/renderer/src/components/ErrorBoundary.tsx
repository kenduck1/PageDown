import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useDocumentStore } from '../store/documentStore'

// The app had no error boundary at all: any exception thrown during render
// unmounted React's entire tree, leaving a blank white window with every open
// tab's unsaved content still sitting in the (now unreachable) Zustand store.
//
// The most important thing this does is NOT "show a nicer screen" -- it is
// "let the user get their work onto disk before they reload". The document
// store survives a render crash untouched (it is plain module state, not React
// state), so "Save my work" below can still walk every dirty tab and write it,
// including opening a real Save dialog for a never-saved Untitled document.
//
// A class component because `getDerivedStateFromError`/`componentDidCatch`
// have no hooks equivalent -- React exposes error boundaries only this way.
// It deliberately subscribes to NOTHING: a boundary that re-rendered on store
// changes could be re-broken by the very state that broke it, so it reads the
// store imperatively (getState) inside its handlers instead.

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
  saveStatus: 'idle' | 'saving' | 'saved' | 'failed'
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, saveStatus: 'idle' }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Never swallowed. This is the only record of the component stack, which
    // `error.stack` alone does not carry.
    console.error('[PageDown] render error', error, info.componentStack)
  }

  // Saves EVERY dirty tab, not just the active one. save() writes whichever
  // tab is active (its own mirror fields), so reaching a background tab means
  // switching to it first -- safe here precisely because nothing is rendering:
  // switchTab's revision bump has no editor to remount.
  handleSaveWork = async (): Promise<void> => {
    this.setState({ saveStatus: 'saving' })
    try {
      // Bounded by the tab count rather than `while (some dirty)`: a tab whose
      // save fails stays dirty, and an unbounded loop would retry it forever,
      // reopening the same Save dialog on every pass.
      for (const tab of [...useDocumentStore.getState().tabs]) {
        if (!tab.isDirty) continue
        useDocumentStore.getState().switchTab(tab.id)
        await useDocumentStore.getState().save()
      }
      const stillDirty = useDocumentStore.getState().tabs.some((tab) => tab.isDirty)
      this.setState({ saveStatus: stillDirty ? 'failed' : 'saved' })
    } catch (err) {
      console.error('[PageDown] failed to save from the error screen', err)
      this.setState({ saveStatus: 'failed' })
    }
  }

  // Clears the boundary and re-renders the real app. Often enough the failure
  // was transient (a bad render for one particular state) that this is worth
  // offering before the destructive reload below.
  handleRetry = (): void => {
    this.setState({ error: null, saveStatus: 'idle' })
  }

  handleReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    const { error, saveStatus } = this.state
    if (!error) return this.props.children

    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-4 bg-canvas p-8 font-sans text-text-primary"
      >
        <div className="w-full max-w-[520px] rounded-md border border-border-chrome bg-page p-6 shadow-float-sm">
          <h1 className="text-16 font-semibold">PageDown hit an unexpected problem</h1>
          <p className="mt-2 text-13 text-text-secondary">
            Your open documents are still in memory. Save them before reloading.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void this.handleSaveWork()}
              disabled={saveStatus === 'saving'}
              className="rounded-sm bg-accent px-3 py-1.5 text-12-5 font-semibold text-white"
            >
              {saveStatus === 'saving' ? 'Saving…' : 'Save my work'}
            </button>
            <button
              type="button"
              onClick={this.handleRetry}
              className="rounded-sm border border-border-chrome px-3 py-1.5 text-12-5"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded-sm border border-border-chrome px-3 py-1.5 text-12-5"
            >
              Reload window
            </button>
          </div>

          {saveStatus === 'saved' && (
            <p className="mt-3 text-12-5 text-text-secondary">Saved. Reloading is safe now.</p>
          )}
          {saveStatus === 'failed' && (
            <p className="mt-3 text-12-5 text-red-600">
              Some documents could not be saved. Copy anything you cannot lose out of the details
              below before reloading.
            </p>
          )}

          {/* The error itself is shown, never silently swallowed -- collapsed
              so it does not dominate the screen, but present and selectable so
              it can be copied into a bug report. */}
          <details className="mt-4">
            <summary className="cursor-pointer text-12 text-text-secondary">
              Technical details
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-chrome-light p-2 text-11 text-text-secondary">
              {error.stack ?? error.message}
            </pre>
          </details>
        </div>
      </div>
    )
  }
}

export default ErrorBoundary
