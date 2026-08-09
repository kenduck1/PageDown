import { useEffect, useRef } from 'react'

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
  // Latest-ref treatment for onDismiss, same pattern as onChangeRef/onErrorRef
  // in MilkdownEditor.tsx: updated via its own no-deps effect (never assigned
  // during render -- react-hooks/refs forbids that) so the scheduling effect
  // below can read the CURRENT onDismiss without depending on it.
  const onDismissRef = useRef(onDismiss)
  useEffect(() => {
    onDismissRef.current = onDismiss
  })

  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => onDismissRef.current(), durationMs)
    return () => clearTimeout(timer)
    // onDismiss is deliberately excluded from this dependency array -- it's
    // read through onDismissRef instead, precisely so a new function identity
    // from the caller on every render does NOT restart this timer; only a
    // real message/durationMs change should. See the final-review fix wave
    // that added this: EditorScreen's inline `onDismiss={() => setToast(null)}`
    // was silently resetting the countdown on every unrelated parent re-render
    // (e.g. the user typing after switching to Source mode).
  }, [message, durationMs])

  if (!message) return null

  return (
    <div className="pointer-events-none fixed left-1/2 top-3 z-60 -translate-x-1/2">
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
