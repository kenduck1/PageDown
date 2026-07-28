import { useAppStore } from '../store/appStore'

function HomeScreen(): React.JSX.Element {
  const goEditor = useAppStore((state) => state.goEditor)

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-chrome-light font-sans text-text-primary">
      <span className="text-21 font-bold">PageDown</span>
      <p className="text-text-secondary text-13">
        Home screen placeholder -- full build in sub-project #2
      </p>
      <button
        onClick={goEditor}
        className="rounded-md bg-accent px-4 py-2 text-13 font-semibold text-on-accent"
      >
        New document
      </button>
    </div>
  )
}

export default HomeScreen
