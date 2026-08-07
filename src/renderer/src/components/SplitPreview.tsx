import { useEffect, useRef } from 'react'

interface SplitPreviewProps {
  content: string
  filePath: string | null
}

const DEBOUNCE_MS = 500

// The real preview surface is a native WebContentsView, positioned by the
// main process to sit exactly over this div's own on-screen rectangle --
// see docs/superpowers/specs/2026-08-07-split-mode-design.md. This
// component's only jobs: keep the main process informed of where that
// rectangle is (ResizeObserver -> setSplitPreviewBounds), and keep the
// preview's content in sync with the document (debounced
// sendSplitPreviewDocument, matching usePageCount's own 500ms debounce so
// this doesn't re-layout on every keystroke).
function SplitPreview({ content, filePath }: SplitPreviewProps): React.JSX.Element {
  const placeholderRef = useRef<HTMLDivElement>(null)
  // Tracks the last {content, filePath} pair the harness has CONFIRMED
  // receiving (stamped only inside the .then() below, never before the call)
  // so the 500ms-debounced effect can skip re-sending a value that's already
  // been successfully delivered -- without this, a plain mount with no
  // subsequent edit sends the SAME initial content twice (once immediately,
  // once again when the debounce timer fires with nothing having changed),
  // which is a wasted pagination-harness round trip for zero behavioral
  // benefit. Stamping this BEFORE the call resolves (or on rejection) would
  // be a real bug, not just a missed optimization: `sendDocument` genuinely
  // rejects (a 10s timeout, a pagination error, the post-destroy guard --
  // see src/main/split-preview-window.ts's sendDocument) and is quite
  // plausible on cold start while the harness process is still spinning up.
  // If a failed send were recorded as "sent" anyway, a user opening Split
  // mode on an already-written document with no further edit would see a
  // permanently blank preview for the rest of that mount: the debounced
  // effect would compare content equal to the (falsely) recorded value and
  // never retry.
  const lastSentRef = useRef<{ content: string; filePath: string | null } | null>(null)

  useEffect(() => {
    const el = placeholderRef.current
    if (!el) return
    const reportBounds = (): void => {
      const rect = el.getBoundingClientRect()
      // Plain CSS-pixel values -- do NOT multiply by devicePixelRatio. Task 3
      // settled this empirically: Electron's WebContentsView#setBounds takes
      // device-independent pixels, and multiplying here would render the
      // preview at 2x size on a Retina display.
      window.api.setSplitPreviewBounds({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      })
    }
    reportBounds()
    // Tracks resize only -- NOT scroll. getBoundingClientRect() shifts when
    // an ANCESTOR scrolls too, and neither ResizeObserver nor the window
    // 'resize' listener fires for that (the placeholder's own box hasn't
    // changed size, just position). Latent today only because no layout
    // wraps this component in a scrollable ancestor; a future layout that
    // does would silently break bounds tracking with no error, since the
    // native view would keep rendering at its last-reported position while
    // the DOM scrolls underneath it.
    const observer = new ResizeObserver(reportBounds)
    observer.observe(el)
    window.addEventListener('resize', reportBounds)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', reportBounds)
    }
  }, [])

  useEffect(() => {
    window.api
      .sendSplitPreviewDocument(content, filePath)
      .then(() => {
        lastSentRef.current = { content, filePath }
      })
      .catch(() => {
        // Split mode's preview is best-effort, same governing rule as the
        // rest of this app's fire-and-forget IPC calls (see
        // EditorHistory.tsx's own .catch() for the precedent this matches):
        // never let a rejection surface as an unhandled promise rejection,
        // and no dedicated error UI for this task. Deliberately does NOT
        // stamp lastSentRef on failure -- see that ref's own comment above
        // for why leaving it unset here is what lets the debounced effect
        // retry instead of believing this content was already delivered.
      })
    // Mount-only: sends the initial content immediately rather than waiting
    // out the debounce below for the very first paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      const last = lastSentRef.current
      if (last && last.content === content && last.filePath === filePath) return
      window.api
        .sendSplitPreviewDocument(content, filePath)
        .then(() => {
          lastSentRef.current = { content, filePath }
        })
        .catch(() => {
          // Same as the mount effect's catch above: swallow so this never
          // becomes an unhandled rejection, and leave lastSentRef unset for
          // this value so a later edit (or the next unrelated debounce
          // cycle) retries rather than getting stuck believing a failed
          // send succeeded.
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // Mount's own immediate send (the effect above, empty deps) already
    // covers the initial content -- this effect's cleanup cancels any
    // pending debounced send from a PRIOR content value whenever content
    // changes again before it fires, matching usePageCount's own
    // established debounce shape (see that hook's own comment for why:
    // "a fast typing burst triggers one round trip after typing settles").
  }, [content, filePath])

  useEffect(() => {
    return () => {
      void window.api.destroySplitPreview()
    }
  }, [])

  return (
    <div ref={placeholderRef} data-testid="split-preview-placeholder" className="h-full w-full" />
  )
}

export default SplitPreview
