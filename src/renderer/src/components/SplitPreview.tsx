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
  // Tracks the last {content, filePath} pair actually sent to the harness so
  // the 500ms-debounced effect below can skip re-sending a value that's
  // identical to what the mount effect (or a prior debounced send) already
  // dispatched -- without this, a plain mount with no subsequent edit sends
  // the SAME initial content twice (once immediately, once again when the
  // debounce timer fires with nothing having changed), which is a wasted
  // pagination-harness round trip for zero behavioral benefit.
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
    const observer = new ResizeObserver(reportBounds)
    observer.observe(el)
    window.addEventListener('resize', reportBounds)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', reportBounds)
    }
  }, [])

  useEffect(() => {
    lastSentRef.current = { content, filePath }
    void window.api.sendSplitPreviewDocument(content, filePath)
    // Mount-only: sends the initial content immediately rather than waiting
    // out the debounce below for the very first paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      const last = lastSentRef.current
      if (last && last.content === content && last.filePath === filePath) return
      lastSentRef.current = { content, filePath }
      void window.api.sendSplitPreviewDocument(content, filePath)
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
