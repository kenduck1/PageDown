import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import SourceHighlightLayer from './SourceHighlightLayer'

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
// EXACT underlying bytes as plain text. No page-card wrapper (no white sheet,
// no shadow, no fixed page width) -- pagination is a Format/Split-mode
// concept; this is a flat, unpaginated view of the raw file, same as
// opening a .md file in a plain text editor.
//
// SYNTAX HIGHLIGHTING, and why it did not change any of that
// ----------------------------------------------------------
// The original decision recorded here read "not CodeMirror or any
// syntax-highlighting editor, since the point is showing the file as it
// actually is". That argument defends showing the real BYTES; it never
// required showing them unstyled -- colour is a rendering of the same bytes,
// not a transformation of them, and every Markdown editor a user has met
// colours its source. So the bytes stayed and the colour arrived, via the
// classic mirrored-overlay: this real <textarea> is rendered with transparent
// text over a <pre> (SourceHighlightLayer) painting the same characters in
// colour, both laid out by ONE shared rule in source-editor.css.
//
// CodeMirror 6 was the alternative and was rejected on what it would have
// COST rather than on weight. Five properties of this component are load-
// bearing and documented elsewhere in the codebase against THIS element:
// `value={content}` being a genuinely controlled binding (the mutation-tested
// F3 finding below); Find & Replace driving the browser's own selection via
// setSelectionRange on the real DOM node, which tests/gates/gate17 reads back as
// selectionStart/selectionEnd; drag-and-drop image insertion at
// selectionStart; base.css's ::selection rule existing because Chromium mutes
// an unfocused selection; and gate17/gate21 asserting exact document bytes by
// reading this textarea's `value`. Every one of those is a statement about a
// real <textarea>, and CodeMirror has no textarea to make them about -- each
// would have had to be rebuilt against a different API and re-proven. The
// overlay keeps all five by construction, because the textarea is still
// literally here. What it gives up in exchange is the alignment guarantee: a
// real editor component cannot get its own text out of register with its own
// caret, whereas this can, which is why the metrics live in one shared rule
// and why tests/gates/gate38 measures a real painted token's box against the real
// character under it rather than trusting the CSS.
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
  const highlightRef = useRef<HTMLPreElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const [composing, setComposing] = useState(false)

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

  // The two things the highlight layer cannot derive from `content` alone, and
  // the only JS this feature needs at all: where the textarea is scrolled to,
  // and how much width its own scrollbar is taking away from it.
  //
  // The textarea deliberately remains the ONE scroll container. Making the
  // wrapper scroll instead (with the textarea sized to its content) would have
  // removed this sync entirely -- but useFindController reveals a Source-mode
  // match by assigning `textarea.scrollTop` directly, which is a no-op on an
  // element that does not scroll, so Find would have kept selecting the right
  // range and silently stopped bringing it on screen. Keeping the scroll where
  // it already was is what makes this feature invisible to every existing
  // consumer of this element.
  //
  // The gutter half is why this cannot be pure CSS. `scrollbar-gutter: stable`
  // reserves space on a scroll container, but the mirror is `overflow: hidden`
  // and reserves nothing, so there is no CSS expression for "however wide the
  // other element's scrollbar currently is". It is genuinely variable: zero
  // under macOS overlay scrollbars, ~15px with classic ones, and it appears
  // and disappears as the document crosses one screen in length. Left
  // unmatched, the mirror's lines are that much wider than the textarea's and
  // every WRAPPED line drifts -- the exact "breaks silently on resize" failure
  // this approach is warned about, closed by measuring instead of assuming.
  //
  // Every write below is guarded by an equality check, and those guards are
  // not micro-optimization: this runs on EVERY render, i.e. every keystroke,
  // and an unconditional `setProperty` re-declares a custom property the
  // mirror's own `padding-right` depends on, which invalidates style for the
  // whole mirror subtree even when the value did not change. Reading first and
  // writing only on a real change keeps the common keystroke (scroll unmoved,
  // scrollbar unchanged) down to reads that the browser has to do anyway.
  const syncMirror = useCallback((): void => {
    const textarea = textareaRef.current
    const highlight = highlightRef.current
    const shell = shellRef.current
    if (!textarea || !highlight || !shell) return
    if (highlight.scrollTop !== textarea.scrollTop) highlight.scrollTop = textarea.scrollTop
    if (highlight.scrollLeft !== textarea.scrollLeft) highlight.scrollLeft = textarea.scrollLeft
    // `border: 0` is pinned on this element in source-editor.css, so this
    // difference is exactly the scrollbar's width and nothing else.
    const gutter = `${textarea.offsetWidth - textarea.clientWidth}px`
    if (shell.style.getPropertyValue('--pagedown-source-gutter') !== gutter) {
      shell.style.setProperty('--pagedown-source-gutter', gutter)
    }
  }, [])

  // Deliberately unconditional (no dependency array) and a LAYOUT effect. Every
  // render is a render whose content may have changed the scrollable extent --
  // deleting a page's worth of text clamps scrollTop, which must be mirrored --
  // and running before paint is what stops a freshly mounted or freshly
  // resized surface showing one frame with the mirror wrapped at the wrong
  // column.
  useLayoutEffect(syncMirror)

  // Catches the two size changes that do not come with a React render: the
  // window resizing, and -- the one that matters -- the textarea's own
  // scrollbar appearing or disappearing, which changes its CONTENT box while
  // leaving its border box alone. ResizeObserver's default box is the content
  // box, so it observes exactly that.
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const observer = new ResizeObserver(syncMirror)
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [syncMirror])

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

  // The textarea carries NO Tailwind utility classes any more, and that is
  // required rather than tidier: Tailwind emits utilities into @layer
  // utilities, which beats @layer base where source-editor.css lives, so a
  // leftover `p-8`/`font-mono`/`text-13` here would silently win over the
  // shared metrics rule for the textarea only -- i.e. it would break alignment
  // with the mirror in precisely the way that rule exists to prevent.
  //
  // The mirror is rendered BEFORE the textarea so the textarea, a positioned
  // later sibling, paints above it: the mirror shows through the textarea's
  // transparent text, while the textarea keeps every hit test, the caret and
  // the selection.
  return (
    <div
      ref={shellRef}
      className={
        composing ? 'pagedown-source-shell pagedown-source-composing' : 'pagedown-source-shell'
      }
    >
      <SourceHighlightLayer content={content} preRef={highlightRef} />
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(event) => onChange(event.target.value)}
        onScroll={syncMirror}
        onDrop={handleDrop}
        // An IME composition paints uncommitted text inside the textarea
        // itself, where the mirror cannot see it -- see source-editor.css's
        // .pagedown-source-composing rules for why that would otherwise make
        // every CJK composition invisible until it committed.
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        spellCheck={false}
        aria-label="Markdown source"
        className="pagedown-source-editor"
      />
    </div>
  )
})

export default SourceEditor
