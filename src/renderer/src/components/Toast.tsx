import { useEffect } from 'react'

export interface ToastProps {
  message: string | null
  onDismiss: () => void
  durationMs?: number
}

// Minimal, reusable, auto-dismissing notification primitive -- deliberately
// generic (no undo-barrier-specific copy or logic here; see EditorScreen.tsx
// for the one call site that currently uses it). role="status" +
// aria-live="polite" so it's announced without stealing focus, matching
// this app's existing preference for real behavior over decorative UI.
//
// Positioned fixed, pinned to the top-center of the viewport, deliberately
// NOT nested inside EditorScreen's `document-content` wrapper: Split mode's
// live preview pane is a real native WebContentsView that composites above
// ALL DOM unconditionally (see CLAUDE.md's Split mode section -- this is
// the same reason PageSetupModal had to special-case its own visibility).
// The two-pane row lives in the lower/main area of the screen, below the
// toolbar and tab bar, so anchoring here keeps this toast entirely outside
// the region that view's bounds can ever cover, regardless of viewMode.
function Toast({ message, onDismiss, durationMs = 3000 }: ToastProps): React.JSX.Element | null {
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(onDismiss, durationMs)
    return () => clearTimeout(timer)
  }, [message, durationMs, onDismiss])

  if (!message) return null

  return (
    <div className="pointer-events-none fixed left-1/2 top-3 z-50 -translate-x-1/2">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto rounded-md bg-chrome-dark px-4 py-2 text-12 text-text-primary shadow-float-sm"
      >
        {message}
      </div>
    </div>
  )
}

export default Toast
