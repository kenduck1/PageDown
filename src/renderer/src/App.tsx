import { useAppStore } from './store/appStore'
import HomeScreen from './screens/HomeScreen'
import EditorScreen from './screens/EditorScreen'
import SettingsScreen from './screens/SettingsScreen'

function App(): React.JSX.Element {
  const screen = useAppStore((state) => state.screen)

  if (screen === 'editor') return <EditorScreen />
  if (screen === 'settings') return <SettingsScreen />
  return <HomeScreen />
}

export default App
