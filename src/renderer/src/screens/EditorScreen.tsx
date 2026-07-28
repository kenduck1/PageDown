import { useAppStore } from '../store/appStore'

function EditorScreen(): React.JSX.Element {
  const goHome = useAppStore((state) => state.goHome)
  const viewMode = useAppStore((state) => state.viewMode)

  return (
    <div className="flex h-full flex-col bg-canvas font-sans text-text-primary">
      <div className="flex h-10 items-center gap-3 border-b border-border-chrome bg-chrome-dark px-3">
        <button onClick={goHome} className="text-12 text-text-secondary">
          ← Home
        </button>
        <span className="text-12 text-text-secondary">Editor placeholder</span>
      </div>
      <div className="flex flex-1 items-center justify-center text-text-tertiary">
        View mode: {viewMode} -- full editor chrome built in sub-projects #3-7
      </div>
    </div>
  )
}

export default EditorScreen
