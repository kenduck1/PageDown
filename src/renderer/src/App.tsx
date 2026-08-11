import { useEffect, useState } from 'react'
import { useAppStore } from './store/appStore'
import { useDocumentStore } from './store/documentStore'
import { usePreferencesStore } from './store/preferencesStore'
import { useMenuCommands } from './hooks/useMenuCommands'
import { useCreateDocument } from './hooks/useCreateDocument'
import { confirmWindowClose } from './lib/close-guard'
import Toast from './components/Toast'
import ShortcutsHelpModal from './components/ShortcutsHelpModal'
import HomeScreen from './screens/HomeScreen'
import EditorScreen from './screens/EditorScreen'
import SettingsScreen from './screens/SettingsScreen'

function App(): React.JSX.Element {
  const screen = useAppStore((state) => state.screen)
  const goEditor = useAppStore((state) => state.goEditor)
  const goSettings = useAppStore((state) => state.goSettings)
  const viewMode = useAppStore((state) => state.viewMode)
  // Reported alongside viewMode below, and only since the single-row-toolbar
  // pass moved both of these controls out of EditorToolbar and into the View
  // menu -- a menu radio/checkbox that cannot show its own state would be a
  // downgrade on the pills it replaced, and main can only know the state a
  // renderer tells it.
  const splitLeftMode = useAppStore((state) => state.splitLeftMode)
  const splitFollowEnabled = useAppStore((state) => state.splitFollowEnabled)
  const shortcutsHelpOpen = useAppStore((state) => state.shortcutsHelpOpen)
  const openShortcutsHelp = useAppStore((state) => state.openShortcutsHelp)
  const closeShortcutsHelp = useAppStore((state) => state.closeShortcutsHelp)
  const filePath = useDocumentStore((state) => state.filePath)
  const isDirty = useDocumentStore((state) => state.isDirty)
  // Every saved document open in THIS window, as one NUL-joined string rather
  // than an array -- deliberately, and it is what keeps the report below
  // cheap. Selecting `state.tabs` directly would hand back a new array
  // identity on every keystroke (updateContent rebuilds the tab list), so the
  // reporting effect would re-fire, and re-send over IPC, per character typed.
  // A joined string is a primitive: Zustand's default Object.is comparison
  // sees no change until a tab is genuinely opened, closed, or saved to a new
  // path. NUL is the separator because it is the one byte that cannot appear
  // in a path on any platform this app runs on.
  const openFilePathsKey = useDocumentStore((state) =>
    state.tabs
      .map((tab) => tab.filePath)
      .filter((path): path is string => path !== null)
      .join('\0')
  )
  const openFile = useDocumentStore((state) => state.openFile)
  const openPath = useDocumentStore((state) => state.openPath)
  const preferences = usePreferencesStore((state) => state.preferences)
  const setPreferences = usePreferencesStore((state) => state.setPreferences)
  const createDocument = useCreateDocument()
  const [startupWarning, setStartupWarning] = useState<string | null>(null)

  // The renderer half of the window-close / app-quit guard. Subscribed HERE,
  // not in EditorScreen, because a close request can arrive on any screen --
  // Home and Settings both leave documentStore's dirty tabs fully intact while
  // EditorScreen is unmounted, and an effect inside EditorScreen cannot fire
  // once EditorScreen is gone.
  //
  // The response is mandatory in every branch: until it is sent, the main
  // process keeps this window's close cancelled. A thrown error therefore
  // answers `false` (stay open) rather than `true` -- refusing to close is
  // recoverable (the user can fix the problem, save, and close again), while
  // closing on an error is the exact silent data loss this guard exists to
  // prevent.
  useEffect(() => {
    return window.api.onWindowCloseRequest(() => {
      confirmWindowClose().then(
        (allow) => window.api.respondToWindowClose(allow),
        (err) => {
          console.error('Failed to confirm window close', err)
          useDocumentStore.setState({
            error: 'Could not check for unsaved changes, so this window was kept open.'
          })
          window.api.respondToWindowClose(false)
        }
      )
    })
  }, [])

  // "Your preferences / recent documents could not be read" (see
  // src/main/config-warnings.ts). Drained, so whichever window asks first is
  // the one that shows them, once per app run -- a corrupt recents file
  // silently empties the isKnownPath allowlist, which then makes previously
  // openable documents fail with "Requested path is not a known recent file"
  // and no explanation anywhere.
  useEffect(() => {
    window.api.getStartupWarnings().then((warnings) => {
      if (warnings.length > 0) setStartupWarning(warnings.join(' '))
    })
  }, [])

  // Reports this window's own state to the main process, which is the only
  // place that can act on it: the real OS window title (plus macOS's
  // "document edited" close-button dot) and the application menu's
  // enablement/checkmarks. Lives HERE rather than in EditorScreen because
  // half of it is about screens EditorScreen isn't mounted on -- navigating
  // to Home has to clear the title back to a bare "PageDown" and disable the
  // File menu's document items, and an effect inside EditorScreen cannot fire
  // after EditorScreen unmounts.
  //
  // Per-window by construction: every window runs its own renderer, so each
  // one reports only about itself, and the main process keys what it receives
  // on `BrowserWindow.fromWebContents(event.sender)`.
  //
  // The basename is computed here, not in main, because this renderer already
  // splits paths the same way for the tab bar and the Home screen's recent
  // rows -- and doing it once here keeps the main process out of the business
  // of guessing whether a path is POSIX or Windows.
  // `openFilePaths` is the third thing only main can act on (see
  // src/menu/window-state.ts): it is what lets an OS-delivered file-open
  // request -- a Finder double-click, "Open With", a Windows/Linux
  // file-association relaunch -- land in the window that already has that
  // document open instead of opening a second window on the same file.
  // documentStore is the only place that knows what is open right now, and it
  // is per renderer process, so this report is the only way that fact reaches
  // main at all.
  useEffect(() => {
    window.api.setWindowState({
      documentOpen: screen === 'editor',
      viewMode,
      splitLeftMode,
      splitFollowEnabled,
      fileName: filePath ? (filePath.split(/[/\\]/).pop() ?? filePath) : null,
      isDirty,
      openFilePaths: openFilePathsKey ? openFilePathsKey.split('\0') : []
    })
  }, [screen, viewMode, splitLeftMode, splitFollowEnabled, filePath, isDirty, openFilePathsKey])

  // Product-completeness audit Tier 3, C: the shortcuts reference used to be
  // reachable ONLY from inside EditorScreen -- both its `Mod-/` keydown
  // listener and its own `<ShortcutsHelpModal>` render lived there, so a user
  // on Home or Settings had no way to see it at all, and nothing on Home even
  // says what this app is or that Split/Source modes exist. Hoisted here so
  // it works from every screen. `ShortcutsHelpModal` itself is unchanged
  // (still built on `useModalDialog`'s real focus-trap/Escape/focus-restore
  // behavior, see that hook's own header comment) -- only WHERE it mounts and
  // WHAT can open it moved.
  //
  // EditorScreen keeps its OWN, narrower `Mod-/` listener too (see that
  // file), rather than this one being the sole trigger -- deliberately, not
  // redundantly: that listener's real job is calling `editorRef.current
  // ?.closeSlashMenu()` synchronously, in the same tick as the keystroke,
  // so an open slash-command session doesn't stay visibly rendered
  // underneath the freshly-opened modal for a render or more (see that
  // file's own comment on why `useModalDialog`'s blur-driven close alone
  // isn't fast enough). This listener firing too, whenever EditorScreen also
  // happens to be mounted, is harmless: `openShortcutsHelp()` is a plain
  // "set true" store action, idempotent no matter how many times it's
  // called in the same tick.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === '/') {
        event.preventDefault()
        openShortcutsHelp()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [openShortcutsHelp])

  // The application-menu commands that are meaningful on EVERY screen, and
  // therefore cannot live in EditorScreen (which is unmounted on Home and
  // Settings). Everything document-scoped -- Save, Export, Find, view modes,
  // zoom -- is handled by EditorScreen's own subscription instead; see
  // useMenuCommands' own comment on why a partial handler map per call site
  // beats one central switch. `app:shortcuts` is the one command handled at
  // BOTH levels (this one, and EditorScreen's own) for the identical reason
  // the keydown listener above is duplicated -- EditorScreen's copy also
  // closes any open slash-command session, which only means something while
  // EditorScreen is mounted at all.
  useMenuCommands({
    // The SAME shared implementation the Home screen's own "New document"
    // button uses, so File > New honours the user's default page config
    // rather than quietly producing a Letter document.
    'file:new': () => createDocument(),
    'file:open': () => {
      void openFile().then((loaded) => {
        if (loaded) goEditor()
      })
    },
    // The path comes from the main process's own recent-files.json, and
    // openPath re-validates it through the real file:openPath/isKnownPath
    // check regardless -- exactly the same round trip clicking a Home-screen
    // recent row performs, so this grants no additional disk access.
    'file:openRecent': (payload) => {
      if (!payload) return
      void openPath(payload).then((loaded) => {
        if (loaded) goEditor()
      })
    },
    'app:preferences': () => goSettings(),
    'app:shortcuts': () => openShortcutsHelp()
  })

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

  // ...and kept current when ANOTHER window changes them. preferences.json is
  // one shared file, but this store is per renderer process, so without this a
  // change made in window 2 left window 1 on stale values indefinitely --
  // visibly incoherent, because the spellcheck half of the very same change
  // applies to every window at once (it is a session-level Electron toggle).
  // The main process excludes the window that made the change, so this never
  // echoes back into the Settings screen the user is currently typing in.
  useEffect(() => {
    return window.api.onPreferencesChanged(setPreferences)
  }, [setPreferences])

  // "Open in New Window" (Multi-window support): a fresh window's own
  // main-process createWindow() rides the target document's path along as
  // a `?openPath=...` query param (src/main/index.ts) rather than pushing
  // it over some new dedicated IPC channel -- this reads it back the same
  // way any web app reads its own launch URL. Goes through the EXACT SAME
  // documentStore.openPath() action a user clicking a recent-file row
  // already calls, so it re-validates through the real file:openPath
  // IPC/isKnownPath check independently of whatever the opening window
  // claimed -- the query param carries no elevated trust. `window.location.search`
  // itself never changes after this window's initial load, so `goEditor`
  // (a stable Zustand action reference, like setPreferences above) is the
  // only real dependency.
  useEffect(() => {
    const openPath = new URLSearchParams(window.location.search).get('openPath')
    if (!openPath) return
    useDocumentStore
      .getState()
      .openPath(openPath)
      .then((loaded) => {
        if (loaded) goEditor()
      })
  }, [goEditor])

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

  return (
    <>
      {screen === 'editor' ? <EditorScreen /> : null}
      {screen === 'settings' ? <SettingsScreen /> : null}
      {screen === 'home' ? <HomeScreen /> : null}
      {/* Rendered at App level rather than inside a screen: a config-read
          failure happens at startup, before the user has navigated anywhere,
          and the notice must not disappear the moment they open a document.
          Longer than Toast's 3s default -- this one names an action the user
          may have to take (reopen a document via File > Open). */}
      <Toast
        message={startupWarning}
        onDismiss={() => setStartupWarning(null)}
        durationMs={12_000}
      />
      {/* Product-completeness audit Tier 3, C: moved here from EditorScreen so
      it works from Home and Settings too, not just while a document is open
      -- see the effect/useMenuCommands entry above for the full reasoning.
      EditorScreen no longer renders its own copy (rendering both here AND
      there would mount two independent instances racing each other's own
      focus trap the moment a document happens to be open) -- it still reads
      `shortcutsHelpOpen` from the same store for its own, unrelated needs
      (Split-mode preview occlusion, the selection bubble's suppression list),
      just not to render the modal itself anymore. */}
      <ShortcutsHelpModal open={shortcutsHelpOpen} onClose={closeShortcutsHelp} />
    </>
  )
}

export default App
