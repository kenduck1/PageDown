import { memo, type RefObject } from 'react'
import { buildHighlightNodes } from '../lib/source-highlight-nodes'

interface SourceHighlightLayerProps {
  content: string
  preRef: RefObject<HTMLPreElement | null>
}

// The syntax-coloured mirror that sits UNDER Source mode's real textarea. It
// paints; the textarea above it owns the caret, the selection and every hit
// test. See SourceEditor.tsx for why the textarea was kept, and
// source-editor.css for the single shared rule that keeps the two boxes laying
// text out identically.
//
// aria-hidden, because the textarea directly above already exposes exactly this
// text to assistive technology as the value of a real form control -- without
// it every screen reader would read the document twice.
//
// memo() because SourceEditor re-renders for reasons that have nothing to do
// with the text (a ref handle refresh, a parent re-render, an IME composition
// starting); `preRef` is a stable ref object, so the only prop that ever
// changes is `content`.
const SourceHighlightLayer = memo(function SourceHighlightLayer({
  content,
  preRef
}: SourceHighlightLayerProps) {
  return (
    <pre ref={preRef} className="pagedown-source-highlight" aria-hidden="true">
      {buildHighlightNodes(content)}
    </pre>
  )
})

export default SourceHighlightLayer
