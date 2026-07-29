import { useAppStore } from '../store/appStore'
import { useDocumentStore } from '../store/documentStore'

function HomeScreen(): React.JSX.Element {
  const goEditor = useAppStore((state) => state.goEditor)
  const newDocument = useDocumentStore((state) => state.newDocument)
  const openFile = useDocumentStore((state) => state.openFile)
  const error = useDocumentStore((state) => state.error)
  const clearError = useDocumentStore((state) => state.clearError)

  const handleNewDocument = (): void => {
    newDocument()
    goEditor()
  }

  const handleOpenFile = async (): Promise<void> => {
    const loaded = await openFile()
    if (loaded) goEditor()
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-chrome-light font-sans text-text-primary">
      <span className="text-21 font-bold">PageDown</span>
      <p className="text-text-secondary text-13">
        Home screen placeholder -- full build in sub-project #2
      </p>
      <div className="flex gap-3">
        <button
          onClick={handleNewDocument}
          className="rounded-md bg-accent px-4 py-2 text-13 font-semibold text-on-accent"
        >
          New document
        </button>
        <button
          onClick={handleOpenFile}
          className="rounded-md border border-border-subtle px-4 py-2 text-13 font-semibold text-text-primary"
        >
          Open file…
        </button>
      </div>
      {error && (
        <div className="flex items-center gap-3 text-13 text-red-600">
          <span>{error}</span>
          <button onClick={clearError} className="font-semibold">
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}

export default HomeScreen
