import { useEffect } from 'react'
import { useAppStore } from './store/appStore'
import { usePreferencesStore } from './store/preferencesStore'
import HomeScreen from './screens/HomeScreen'
import EditorScreen from './screens/EditorScreen'
import SettingsScreen from './screens/SettingsScreen'

function App(): React.JSX.Element {
  const screen = useAppStore((state) => state.screen)
  const preferences = usePreferencesStore((state) => state.preferences)
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

  // Applies the app-shell CHROME theme by setting data-theme on <html> --
  // base.css's :root[data-theme='dark'] block is what actually overrides
  // every --color-* token for that. Runs here (App's own top level, not
  // inside a screen) so the theme applies before ANY screen renders, and
  // survives navigating between Home/Editor/Settings without re-deriving.
  // Defaults to 'system' when preferences hasn't loaded yet (App.tsx's own
  // getPreferences() call above may not have resolved), matching
  // DEFAULT_PREFERENCES.colorScheme exactly -- so there's no flash of an
  // arbitrarily-chosen theme before the real preference is known.
  useEffect(() => {
    const colorScheme = preferences?.colorScheme ?? 'system'
    const media = window.matchMedia('(prefers-color-scheme: dark)')

    const applyEffectiveTheme = (): void => {
      const effective = colorScheme === 'system' ? (media.matches ? 'dark' : 'light') : colorScheme
      document.documentElement.dataset.theme = effective
    }
    applyEffectiveTheme()

    // Only 'system' needs to react to a LIVE OS theme change -- 'light'/
    // 'dark' are pinned regardless of what the OS is currently doing, so
    // there's nothing to listen for.
    if (colorScheme !== 'system') return
    media.addEventListener('change', applyEffectiveTheme)
    return () => media.removeEventListener('change', applyEffectiveTheme)
  }, [preferences?.colorScheme])

  if (screen === 'editor') return <EditorScreen />
  if (screen === 'settings') return <SettingsScreen />
  return <HomeScreen />
}

export default App
