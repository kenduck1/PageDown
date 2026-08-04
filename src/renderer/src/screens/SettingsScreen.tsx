import { useAppStore } from '../store/appStore'

function SettingsScreen(): React.JSX.Element {
  const goHome = useAppStore((state) => state.goHome)

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-chrome-light font-sans text-text-primary">
      <span className="text-21 font-bold">Settings</span>
      <p className="text-13 text-text-secondary">Coming soon.</p>
      <button onClick={goHome} className="text-12 text-text-secondary">
        ← Home
      </button>
    </div>
  )
}

export default SettingsScreen
