import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

interface SourceEditorProps {
  content: string
  onChange: (value: string) => void
  // Same contract as MilkdownEditor's own onDropImage prop -- called once
  // per real image file found in a native OS drop, in drop order. Optional
  // (SourceEditor is also usable without it) so every existing render site
  // that predates this feature keeps compiling unchanged.
  onDropImage?: (file: File) => Promise<{ relativePath: string } | { error: string }>
  onError?: (message: string) => void
}

// Find & Replace drives this surface through the real DOM node rather than
// through React state: a textarea cannot render per-range decorations at all,
// so the CURRENT match is shown using the browser's own selection
// (setSelectionRange), which is exactly how Chromium's in-page find treats a
// textarea. getSelectedText backs Cmd/Ctrl+F seeding its query from whatever
// the user had selected.
export interface SourceEditorHandle {
  getTextarea: () => HTMLTextAreaElement | null
  getSelectedText: () => string
}

// The raw-Markdown editing surface for viewMode: 'source' -- see
// docs/superpowers/specs/2026-08-07-source-mode-design.md. Deliberately a
// plain, fully-controlled <textarea>, not CodeMirror: Format mode already
// provides the rich view, and Source mode's whole purpose is showing the
// EXACT underlying bytes as plain text, which a syntax-highlighting editor
// would visually editorialize. No page-card wrapper (no white sheet, no
// shadow, no fixed page width) -- pagination is a Format/Split-mode
// concept; this is a flat, unpaginated view of the raw file, same as
// opening a .md file in a plain text editor.
//
// Fully controlled with a direct string binding -- unlike MilkdownEditor,
// there is no internal document model to keep in sync via a debounce: the
// textarea's value IS the Markdown string. EditorScreen.tsx owns the
// mode-switch coordination (flushing Milkdown before entering this mode,
// forcing a Milkdown remount after leaving it) -- see that file's
// handleSetViewMode.
//
// `value={content}` MUST stay a real controlled binding, not
// `defaultValue`/an uncontrolled textarea keyed on something else (F3,
// final whole-branch review -- mutation-tested: swapping to `defaultValue`
// left every then-existing test green). A content change that originates
// OUTSIDE this component while Source mode is on screen -- a History
// restore, or Page Setup applying a frontmatter edit, both of which call
// documentStore's replaceContent/replaceContentForTab directly -- must land
// in the textarea immediately. Under `defaultValue`, the DOM node ignores
// that prop after first mount, so the textarea keeps showing the PRE-restore
// text; the user's very next keystroke then calls onChange with that stale
// value, silently clobbering the restore. `value={content}` is what
// makes that structurally impossible: React forces the DOM node's value to
// match the prop on every render.
//
// Now a forwardRef exposing SourceEditorHandle (Find & Replace) -- the ref
// only ever reaches into the real DOM node (see SourceEditorHandle's own
// comment above); it doesn't change anything about the controlled `value`
// binding above, which remains the only way content flows INTO this
// component.
const SourceEditor = forwardRef<SourceEditorHandle, SourceEditorProps>(function SourceEditor(
  { content, onChange, onDropImage, onError },
  ref
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Read by handleDrop's own async continuation, which fires after a real
  // IPC round trip -- by the time it resolves, `content`/`onChange` from the
  // render that started the drop may already be stale (another edit landed,
  // or the document itself changed). Refs, updated every render, keep the
  // eventual splice targeting the CURRENT content rather than a stale
  // snapshot. Assigned in an effect (not inline during render), matching
  // MilkdownEditor.tsx's own latest-ref convention and the same
  // react-hooks/refs rule it documents.
  const contentRef = useRef(content)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    contentRef.current = content
    onChangeRef.current = onChange
  })

  useImperativeHandle(ref, () => ({
    getTextarea: () => textareaRef.current,
    getSelectedText: () => {
      const textarea = textareaRef.current
      if (!textarea) return ''
      return textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)
    }
  }))

  // A real native OS file drop -- same feature MilkdownEditor.tsx's own
  // drop-image.ts plugin provides for Format mode, adapted to plain-text
  // insertion since a textarea has no node model to insert into. Only
  // intercepts (preventDefault) a drop that carries at least one real image
  // file; an ordinary text drag (selecting text elsewhere and dropping it
  // here) is left to the browser's own default textarea drop handling.
  //
  // Inserted at the CURRENT SELECTION/CURSOR position, not the drop
  // coordinates -- unlike MilkdownEditor's ProseMirror view, a <textarea>
  // exposes no coordinate-to-character-offset API (no equivalent of
  // `posAtCoords`), so there is no reliable way to compute "the character
  // offset under the cursor" for a plain textarea. A documented, honest
  // limitation, not a bug: the browser's own NATIVE drop-to-caret behavior
  // only exists for drops this handler does NOT intercept (plain text
  // drags), which is why those are deliberately left alone above.
  const handleDrop = (event: React.DragEvent<HTMLTextAreaElement>): void => {
    if (!onDropImage) return
    const files = Array.from(event.dataTransfer.files).filter((file) =>
      file.type.startsWith('image/')
    )
    if (files.length === 0) return

    event.preventDefault()
    const insertAt = textareaRef.current?.selectionStart ?? contentRef.current.length
    void insertDroppedImages(files, insertAt)
  }

  const insertDroppedImages = async (files: File[], insertAt: number): Promise<void> => {
    let insertText = ''
    for (const file of files) {
      const result = await onDropImage!(file)
      if ('error' in result) {
        onError?.(result.error)
        continue
      }
      // CommonMark requires wrapping a link/image destination containing
      // whitespace or `(`/`)`/`<`/`>` in angle brackets -- a bare
      // `![x](my file.png)` doesn't parse as a single destination.
      // pipeline.test.ts's own `<Screen Shot 2026.png>` fixture already
      // exercises the PARSING half of this convention; this is its
      // insertion-side counterpart.
      const needsAngleBrackets = /[\s()<>]/.test(result.relativePath)
      const destination = needsAngleBrackets ? `<${result.relativePath}>` : result.relativePath
      insertText += `![${file.name}](${destination})\n`
    }
    if (!insertText) return

    const current = contentRef.current
    onChangeRef.current(current.slice(0, insertAt) + insertText + current.slice(insertAt))
  }

  return (
    <textarea
      ref={textareaRef}
      value={content}
      onChange={(event) => onChange(event.target.value)}
      onDrop={handleDrop}
      spellCheck={false}
      aria-label="Markdown source"
      className="pagedown-source-editor h-full w-full resize-none bg-canvas p-8 font-mono text-13 text-text-primary outline-none"
    />
  )
})

export default SourceEditor
