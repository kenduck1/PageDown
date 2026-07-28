import { useAppStore } from './store/appStore'
import HomeScreen from './screens/HomeScreen'
import EditorScreen from './screens/EditorScreen'

function App(): React.JSX.Element {
  const screen = useAppStore((state) => state.screen)

  return screen === 'home' ? <HomeScreen /> : <EditorScreen />
}

export default App
