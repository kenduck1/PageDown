import { useAppStore } from '../store/appStore'
import { useDocumentStore } from '../store/documentStore'

function EditorScreen(): React.JSX.Element {
  const goHome = useAppStore((state) => state.goHome)
  const viewMode = useAppStore((state) => state.viewMode)
  const filePath = useDocumentStore((state) => state.filePath)
  const content = useDocumentStore((state) => state.content)
  const error = useDocumentStore((state) => state.error)

  return (
    <div className="flex h-full flex-col bg-canvas font-sans text-text-primary">
      <div className="flex h-10 items-center gap-3 border-b border-border-chrome bg-chrome-dark px-3">
        <button onClick={goHome} className="text-12 text-text-secondary">
          ← Home
        </button>
        <span className="text-12 text-text-secondary">{filePath ?? 'Untitled'}</span>
      </div>
      {error ? (
        <div className="flex flex-1 items-center justify-center text-red-600">{error}</div>
      ) : (
        <div className="flex-1 overflow-auto p-4">
          <p className="mb-2 text-12 text-text-tertiary">
            View mode: {viewMode} -- full editor chrome built in sub-projects #3-7
          </p>
          <pre data-testid="document-content" className="whitespace-pre-wrap font-mono text-12-5">
            {content}
          </pre>
        </div>
      )}
    </div>
  )
}

export default EditorScreen
