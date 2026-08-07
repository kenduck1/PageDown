interface SourceEditorProps {
  content: string
  onChange: (value: string) => void
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
function SourceEditor({ content, onChange }: SourceEditorProps): React.JSX.Element {
  return (
    <textarea
      value={content}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={false}
      aria-label="Markdown source"
      className="h-full w-full resize-none bg-canvas p-8 font-mono text-13 text-text-primary outline-none"
    />
  )
}

export default SourceEditor
