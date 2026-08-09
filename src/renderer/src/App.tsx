import { useEffect } from 'react'
import { useAppStore } from './store/appStore'
import { usePreferencesStore } from './store/preferencesStore'
import HomeScreen from './screens/HomeScreen'
import EditorScreen from './screens/EditorScreen'
import SettingsScreen from './screens/SettingsScreen'

function App(): React.JSX.Element {
  const screen = useAppStore((state) => state.screen)
  const setPreferences = usePreferencesStore((state) => state.setPreferences)

  // Fetched once, here, rather than lazily by whichever screen first needs
  // them -- HomeScreen's own new-blank-document flow (Home Screen
  // improvements sub-project) and useAutosave's interval (EditorScreen) both
  // need the CURRENT preferences synchronously available by the time a user
  // could plausibly trigger either, and a real app session visits Home
  // before Editor on every cold start, so this is never later than the
  // earliest real consumer.
  useEffect(() => {
    window.api.getPreferences().then(setPreferences)
  }, [setPreferences])

  if (screen === 'editor') return <EditorScreen />
  if (screen === 'settings') return <SettingsScreen />
  return <HomeScreen />
}

export default App
