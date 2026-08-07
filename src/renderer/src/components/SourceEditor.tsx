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
function SourceEditor({ content, onChange }: SourceEditorProps): React.JSX.Element {
  return (
    <textarea
      key={content}
      defaultValue={content}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={false}
      className="h-full w-full flex-1 resize-none bg-canvas p-8 font-mono text-13 text-text-primary outline-none"
    />
  )
}

export default SourceEditor
