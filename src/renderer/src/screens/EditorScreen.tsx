import { useAppStore } from '../store/appStore'
import { useDocumentStore } from '../store/documentStore'

function EditorScreen(): React.JSX.Element {
  const goHome = useAppStore((state) => state.goHome)
  const viewMode = useAppStore((state) => state.viewMode)
  const filePath = useDocumentStore((state) => state.filePath)
  const content = useDocumentStore((state) => state.content)
  const error = useDocumentStore((state) => state.error)
  const clearError = useDocumentStore((state) => state.clearError)
  const save = useDocumentStore((state) => state.save)

  return (
    <div className="flex h-full flex-col bg-canvas font-sans text-text-primary">
      <div className="flex h-10 items-center gap-3 border-b border-border-chrome bg-chrome-dark px-3">
        <button onClick={goHome} className="text-12 text-text-secondary">
          ← Home
        </button>
        <span className="text-12 text-text-secondary">{filePath ?? 'Untitled'}</span>
        <button onClick={() => void save()} className="ml-auto text-12 font-semibold text-accent">
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
      <div className="flex-1 overflow-auto p-4">
        <p className="mb-2 text-12 text-text-tertiary">
          View mode: {viewMode} -- full editor chrome built in sub-projects #3-7
        </p>
        <pre data-testid="document-content" className="whitespace-pre-wrap font-mono text-12-5">
          {content}
        </pre>
      </div>
    </div>
  )
}

export default EditorScreen
