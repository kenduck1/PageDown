import { useRef } from 'react'
import { useAppStore } from '../store/appStore'
import { useDocumentStore } from '../store/documentStore'
import MilkdownEditor, { type MilkdownEditorHandle } from '../milkdown/MilkdownEditor'

function EditorScreen(): React.JSX.Element {
  const goHome = useAppStore((state) => state.goHome)
  const filePath = useDocumentStore((state) => state.filePath)
  const content = useDocumentStore((state) => state.content)
  const revision = useDocumentStore((state) => state.revision)
  const updateContent = useDocumentStore((state) => state.updateContent)
  const isDirty = useDocumentStore((state) => state.isDirty)
  const error = useDocumentStore((state) => state.error)
  const clearError = useDocumentStore((state) => state.clearError)
  const save = useDocumentStore((state) => state.save)
  const editorRef = useRef<MilkdownEditorHandle>(null)

  const handleSave = async (): Promise<void> => {
    // @milkdown/plugin-listener's onChange fires through an internal 200ms
    // debounce (see CLAUDE.md) -- if the user clicks Save within that
    // window of their last keystroke, documentStore.content can still hold
    // the PRE-edit value. flush() reads the editor's true current markdown
    // and pushes it through onChange (= updateContent) synchronously, IF
    // AND ONLY IF a real edit happened since mount -- a no-op otherwise, so
    // it's always safe to call defensively here.
    editorRef.current?.flush()
    await save()
  }

  const handleGoHome = async (): Promise<void> => {
    if (!isDirty) {
      goHome()
      return
    }
    const choice = await window.api.confirmDiscardChanges()
    if (choice === 'cancel') return
    if (choice === 'save') {
      editorRef.current?.flush()
      await save()
      // documentStore.save() only ever clears isDirty on a genuine
      // successful save -- checking isDirty (not error) here also catches
      // the case a thrown error wouldn't: the user cancelling the native
      // Save-As dialog for a never-saved document, which resolves save()
      // with no error at all and leaves isDirty untouched. Either way,
      // don't navigate away from a document that wasn't actually written.
      if (useDocumentStore.getState().isDirty) return
    }
    goHome()
  }

  return (
    <div className="flex h-full flex-col bg-canvas font-sans text-text-primary">
      <div className="flex h-10 items-center gap-3 border-b border-border-chrome bg-chrome-dark px-3">
        <button onClick={() => void handleGoHome()} className="text-12 text-text-secondary">
          ← Home
        </button>
        <span className="text-12 text-text-secondary">{filePath ?? 'Untitled'}</span>
        <button
          onClick={() => void handleSave()}
          className="ml-auto text-12 font-semibold text-accent"
        >
          Save
        </button>
      </div>
      {error && (
        <div className="flex items-center gap-3 border-b border-border-chrome bg-red-50 px-3 py-2 text-13 text-red-600">
          <span className="flex-1">{error}</span>
          <button onClick={clearError} className="text-12 font-semibold text-red-600">
            Dismiss
          </button>
        </div>
      )}
      <div data-testid="document-content" className="flex-1 overflow-auto">
        <MilkdownEditor
          ref={editorRef}
          key={revision}
          content={content}
          onChange={updateContent}
          onError={(message) => useDocumentStore.setState({ error: message })}
        />
      </div>
    </div>
  )
}

export default EditorScreen
