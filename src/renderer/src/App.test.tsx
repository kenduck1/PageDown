import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { useAppStore, initialAppState } from './store/appStore'
import { useDocumentStore, initialDocumentState } from './store/documentStore'
import { usePreferencesStore } from './store/preferencesStore'
import type { MenuCommand } from '../../menu/commands'

// Delivers an application-menu command through whatever callbacks are
// currently registered -- exactly what preload does after validating the
// command against MENU_COMMANDS.
function emitMenuCommand(command: MenuCommand, payload?: string): void {
  const calls = vi.mocked(window.api.onMenuCommand).mock.calls
  act(() => {
    for (const [callback] of calls) callback(command, payload)
  })
}

beforeEach(() => {
  useAppStore.setState(initialAppState)
  useDocumentStore.setState(initialDocumentState)
  window.api = {
    openFile: vi.fn(),
    openPath: vi.fn(),
    saveFile: vi.fn(),
    getRecentFiles: vi.fn().mockResolvedValue([]),
    removeRecentFile: vi.fn(),
    clearRecentFiles: vi.fn(),
    getThumbnail: vi.fn().mockResolvedValue({ dataUrl: 'data:image/png;base64,x', pageCount: 1 }),
    getTemplateThumbnail: vi
      .fn()
      .mockResolvedValue({ dataUrl: 'data:image/png;base64,x', pageCount: 1 }),
    getPageCount: vi.fn().mockResolvedValue({ pageCount: 1 }),
    confirmDiscardChanges: vi.fn(),
    exportPdf: vi.fn(),
    exportHtml: vi.fn(),
    exportDocx: vi.fn(),
    showItemInFolder: vi.fn(),
    print: vi.fn(),
    getPreferences: vi.fn().mockResolvedValue({
      spellcheckEnabled: true,
      autosaveIntervalMs: 45_000,
      defaultPageConfig: {
        pageSize: 'Letter',
        orientation: 'portrait',
        theme: 'default',
        fontFamily: 'source-serif-4'
      },
      colorScheme: 'system',
      authorName: ''
    }),
    setPreferences: vi.fn(),
    autosaveSnapshot: vi.fn(),
    getVersionHistory: vi.fn(),
    restoreVersionContent: vi.fn(),
    clearPendingAutosave: vi.fn(),
    // Crash protection for never-saved documents. Required (not optional) on
    // FileApi, so a missing entry here is a compile error rather than a
    // runtime surprise -- see index.d.ts for why that tradeoff was taken.
    autosaveUnsavedDraft: vi.fn().mockResolvedValue(null),
    listUnsavedDrafts: vi.fn().mockResolvedValue([]),
    readUnsavedDraft: vi.fn().mockResolvedValue(null),
    discardUnsavedDraft: vi.fn().mockResolvedValue(undefined),
    setSplitPreviewBounds: vi.fn(),
    sendSplitPreviewDocument: vi.fn(),
    destroySplitPreview: vi.fn(),
    scrollSplitPreviewToPage: vi.fn(),
    getSplitPreviewPage: vi.fn(),
    saveDroppedImage: vi.fn(),
    openInNewWindow: vi.fn(),
    // The application menu's two channels. Both are stubbed in every
    // window.api fixture because window.api is a fully-typed FileApi here --
    // a missing method is a compile error, not just a runtime one.
    // onMenuCommand must return a real unsubscribe FUNCTION: App.tsx and
    // EditorScreen both call it from an effect cleanup, and a bare vi.fn()
    // returning undefined would throw on unmount.
    onMenuCommand: vi.fn().mockReturnValue(() => {}),
    setWindowState: vi.fn(),
    // Preferences broadcast (multi-window): a real unsubscribe function,
    // same contract as the other push channels here.
    onPreferencesChanged: vi.fn().mockReturnValue(() => {}),
    // The window-close guard's two channels. onWindowCloseRequest must
    // return a real unsubscribe FUNCTION -- App.tsx calls it from an effect
    // cleanup, same contract as onMenuCommand above.
    onWindowCloseRequest: vi.fn().mockReturnValue(() => {}),
    respondToWindowClose: vi.fn(),
    getStartupWarnings: vi.fn().mockResolvedValue([]),
    getAppVersion: vi.fn().mockResolvedValue('1.0.0'),
    resolveLocalImage: vi.fn()
  }
})

afterEach(() => {
  cleanup()
})

describe('App', () => {
  it('renders the Home screen by default', () => {
    render(<App />)
    expect(screen.getByText('PageDown')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New document' })).toBeInTheDocument()
  })

  it('navigates to the Editor screen and back via user interaction', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'New document' }))
    // Two elements legitimately show "Untitled" on the editor screen -- the
    // title bar's filename readout and the tab bar's active-tab label
    // (EditorTabBar) -- both fall back to it independently.
    expect(screen.getAllByText('Untitled').length).toBeGreaterThan(0)
    expect(screen.queryByText('PageDown')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '← Home' }))
    expect(screen.getByText('PageDown')).toBeInTheDocument()
    expect(screen.queryAllByText('Untitled')).toHaveLength(0)
  })

  // Product-completeness audit 2.4: zoom is a genuine per-WINDOW preference
  // (it describes how big the paper looks on this screen; nothing about it
  // reaches the document, the paginator or the PDF), so carrying it across
  // tabs is correct -- but it was held in EditorScreen's own useState, and
  // this component unmounts that screen entirely on Home. A round trip
  // therefore silently threw the level away. This test has to live at App
  // level, because the unmount is App's doing: an EditorScreen-only test
  // cannot see it.
  it('keeps the canvas zoom level across a Home round trip', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'New document' }))
    await user.selectOptions(screen.getByLabelText('Zoom level'), '1.5')
    expect(screen.getByLabelText('Zoom level')).toHaveValue('1.5')

    await user.click(screen.getByRole('button', { name: '← Home' }))
    await user.click(screen.getByRole('button', { name: 'New document' }))

    expect(screen.getByLabelText('Zoom level')).toHaveValue('1.5')
  })

  describe('opening a document via ?openPath= (Multi-window support)', () => {
    afterEach(() => {
      window.history.replaceState(null, '', '/')
    })

    it('opens the document named by ?openPath= and navigates straight to Editor', async () => {
      window.history.replaceState(null, '', '/?openPath=%2Ftmp%2Freport.md')
      vi.mocked(window.api.openPath).mockResolvedValue({
        filePath: '/tmp/report.md',
        content: '# Report',
        recoveredFromAutosave: false,
        mtimeMs: 1000
      })

      render(<App />)

      expect(await screen.findAllByText(/report\.md|Report/)).not.toHaveLength(0)
      expect(window.api.openPath).toHaveBeenCalledWith('/tmp/report.md')
      expect(useAppStore.getState().screen).toBe('editor')
    })

    it('stays on Home and shows no error when ?openPath= points at an unknown path', async () => {
      window.history.replaceState(null, '', '/?openPath=%2Ftmp%2Funknown.md')
      vi.mocked(window.api.openPath).mockRejectedValue(
        new Error('Requested path is not a known recent file')
      )

      render(<App />)

      await screen.findByText('PageDown')
      expect(window.api.openPath).toHaveBeenCalledWith('/tmp/unknown.md')
      expect(useAppStore.getState().screen).toBe('home')
    })

    it('does nothing when there is no ?openPath= at all (ordinary launch)', async () => {
      render(<App />)
      await screen.findByText('PageDown')

      expect(window.api.openPath).not.toHaveBeenCalled()
      expect(useAppStore.getState().screen).toBe('home')
    })
  })

  describe('app-level color scheme', () => {
    it('applies an explicit "dark" preference to <html data-theme>', async () => {
      vi.mocked(window.api.getPreferences).mockResolvedValue({
        spellcheckEnabled: true,
        autosaveIntervalMs: 45_000,
        defaultPageConfig: {
          pageSize: 'Letter',
          orientation: 'portrait',
          theme: 'default',
          fontFamily: 'source-serif-4'
        },
        colorScheme: 'dark',
        authorName: ''
      })
      render(<App />)
      await screen.findByText('PageDown')

      expect(document.documentElement.dataset.theme).toBe('dark')
    })

    it('applies an explicit "light" preference to <html data-theme>', async () => {
      vi.mocked(window.api.getPreferences).mockResolvedValue({
        spellcheckEnabled: true,
        autosaveIntervalMs: 45_000,
        defaultPageConfig: {
          pageSize: 'Letter',
          orientation: 'portrait',
          theme: 'default',
          fontFamily: 'source-serif-4'
        },
        colorScheme: 'light',
        authorName: ''
      })
      render(<App />)
      await screen.findByText('PageDown')

      expect(document.documentElement.dataset.theme).toBe('light')
    })

    it('resolves "system" against the current OS prefers-color-scheme', async () => {
      const realMatchMedia = window.matchMedia
      window.matchMedia = (query) => {
        const mql = realMatchMedia(query)
        Object.defineProperty(mql, 'matches', { value: true })
        return mql
      }
      try {
        // colorScheme: 'system' is already the beforeEach mock's default.
        render(<App />)
        await screen.findByText('PageDown')

        expect(document.documentElement.dataset.theme).toBe('dark')
      } finally {
        window.matchMedia = realMatchMedia
      }
    })

    it('reacts live to an OS theme change while colorScheme is "system"', async () => {
      let capturedMql: MediaQueryList | undefined
      const realMatchMedia = window.matchMedia
      window.matchMedia = (query) => {
        const mql = realMatchMedia(query)
        capturedMql = mql
        return mql
      }
      try {
        render(<App />)
        await screen.findByText('PageDown')
        expect(document.documentElement.dataset.theme).toBe('light')

        Object.defineProperty(capturedMql!, 'matches', { value: true })
        capturedMql!.dispatchEvent(new Event('change'))

        expect(document.documentElement.dataset.theme).toBe('dark')
      } finally {
        window.matchMedia = realMatchMedia
      }
    })
  })

  describe('application-menu commands and window state', () => {
    it("reports this window's state so main can title the window and enable menu items", async () => {
      render(<App />)
      await screen.findByText('PageDown')

      // Home: no document, so main renders a bare "PageDown" title and
      // disables every document-scoped File/View item.
      expect(window.api.setWindowState).toHaveBeenCalledWith({
        documentOpen: false,
        viewMode: 'format',
        // Reported since the single-row-toolbar pass moved the Split
        // left-pane pills and the Follow pill into the View menu -- main
        // renders those as a radio pair and a checkbox, so it needs their
        // live state, and this window-state report is its only source.
        splitLeftMode: 'format',
        splitFollowEnabled: true,
        fileName: null,
        isDirty: false,
        // The store's own always-present blank tab has no path, so there is
        // nothing to route an OS file-open request to yet.
        openFilePaths: []
      })

      act(() => {
        useDocumentStore.setState({ filePath: '/tmp/docs/report.md', isDirty: true })
        // 'source', not 'split' -- Split mode would mount a real
        // SplitPreview, whose own effects call into IPC this fixture stubs
        // bare. The field under test is just the reported viewMode.
        useAppStore.setState({ screen: 'editor', viewMode: 'source' })
      })

      // The BASENAME, not the full path -- the renderer already splits paths
      // this way for the tab bar, which keeps the main process out of the
      // business of guessing POSIX vs Windows separators.
      expect(window.api.setWindowState).toHaveBeenLastCalledWith({
        documentOpen: true,
        viewMode: 'source',
        splitLeftMode: 'format',
        splitFollowEnabled: true,
        fileName: 'report.md',
        isDirty: true,
        // The mirror fields alone were set above, not a real tab, so the tab
        // list is still pathless -- openFilePaths is reported from `tabs`, not
        // from the active-tab mirror, which is exactly what makes it cover
        // BACKGROUND tabs too. See the dedicated test below.
        openFilePaths: []
      })
    })

    it('reports every saved document open in this window, not just the active one', async () => {
      // This is what lets the main process route an OS file-open request (a
      // Finder double-click, "Open With") to the window already showing that
      // document. A background tab counts: raising that window and pushing
      // file:openRecent focuses the existing tab rather than opening a third
      // window on the same file.
      render(<App />)
      await screen.findByText('PageDown')

      act(() => {
        useDocumentStore.getState().openTab('/tmp/docs/report.md', '# Report')
        useDocumentStore.getState().openTab('/tmp/docs/letter.md', '# Letter')
      })

      const reported = vi.mocked(window.api.setWindowState).mock.calls.at(-1)![0]
      expect(reported.openFilePaths).toEqual(['/tmp/docs/report.md', '/tmp/docs/letter.md'])
    })

    it('does NOT re-report on every keystroke', async () => {
      // The reported list is derived through a NUL-joined string selector
      // precisely so that editing -- which rebuilds documentStore's tab array
      // on every change -- cannot re-fire this effect. Selecting `state.tabs`
      // directly would send one IPC message per character typed, and main
      // would set the OS window title on each.
      render(<App />)
      await screen.findByText('PageDown')

      act(() => {
        useDocumentStore.getState().openTab('/tmp/docs/report.md', '# Report')
        // The FIRST edit legitimately re-reports: it flips isDirty, which the
        // window title genuinely shows. Get past it before measuring.
        useDocumentStore.getState().updateContent('# Report edited')
      })
      const callsAfterFirstEdit = vi.mocked(window.api.setWindowState).mock.calls.length

      act(() => {
        useDocumentStore.getState().updateContent('# Report edited more')
        useDocumentStore.getState().updateContent('# Report edited even more')
      })
      expect(vi.mocked(window.api.setWindowState).mock.calls.length).toBe(callsAfterFirstEdit)
    })

    it('adopts preferences changed in ANOTHER window', async () => {
      // preferences.json is one shared file but this store is per renderer
      // process, so without the broadcast a colour-scheme change made in
      // window 2 left window 1 light until relaunch -- while the spellcheck
      // half of the very same change applied to both windows immediately.
      render(<App />)
      await screen.findByText('PageDown')

      const push = vi.mocked(window.api.onPreferencesChanged).mock.calls[0][0]
      act(() => {
        push({
          spellcheckEnabled: false,
          autosaveIntervalMs: 45_000,
          defaultPageConfig: {
            pageSize: 'A4',
            orientation: 'portrait',
            theme: 'default',
            fontFamily: 'source-serif-4'
          },
          colorScheme: 'dark',
          authorName: ''
        })
      })

      expect(usePreferencesStore.getState().preferences?.colorScheme).toBe('dark')
      expect(document.documentElement.dataset.theme).toBe('dark')
    })

    it('file:new creates a document and shows the editor', async () => {
      render(<App />)
      await screen.findByText('PageDown')

      emitMenuCommand('file:new')

      expect(useAppStore.getState().screen).toBe('editor')
      // EXACTLY one tab, not two. This used to assert 2 -- the store's own
      // seeded blank tab plus the newly created document -- which is precisely
      // the stray-"Untitled" defect documentStore's pristine-tab reuse fixes:
      // one File > New on a fresh launch left two identical Untitled tabs
      // behind. See isPristineBlankTab.
      expect(useDocumentStore.getState().tabs).toHaveLength(1)
    })

    it("file:new applies the user's own default page config, like the Home button does", async () => {
      // The reason File > New shares useCreateDocument with HomeScreen rather
      // than calling newDocument() directly: a menu New that quietly ignored
      // the configured default page size would be a silent divergence.
      vi.mocked(window.api.getPreferences).mockResolvedValue({
        spellcheckEnabled: true,
        autosaveIntervalMs: 45_000,
        defaultPageConfig: {
          pageSize: 'A4',
          orientation: 'landscape',
          theme: 'report',
          fontFamily: 'inter'
        },
        colorScheme: 'system',
        authorName: ''
      })
      render(<App />)
      await screen.findByText('PageDown')
      // Wait for App's own getPreferences() effect to resolve -- before it
      // does, useCreateDocument correctly degrades to plain empty content.
      await vi.waitFor(() => expect(window.api.getPreferences).toHaveBeenCalled())

      emitMenuCommand('file:new')

      await vi.waitFor(() => {
        expect(useDocumentStore.getState().content).toContain('page: A4')
      })
    })

    it('writes NO frontmatter when the default page config is the built-in one', async () => {
      // The complement of the test above, and the common case by far: a user
      // who has never opened Settings. Writing their defaults out explicitly
      // produced a document whose bytes said exactly what the app would have
      // done anyway. (This originally also avoided a visible
      // `Frontmatter (N lines)` box at the top of the canvas; that box no
      // longer exists -- see milkdown/nodes/frontmatter.ts -- so what remains
      // is simply not writing inert keys into the user's own file.)
      //
      // Asserted as "completely empty", not merely "no `page:` key": the
      // failure this guards against is a frontmatter block existing at all,
      // whatever it happens to contain.
      vi.mocked(window.api.getPreferences).mockResolvedValue({
        spellcheckEnabled: true,
        autosaveIntervalMs: 45_000,
        defaultPageConfig: {
          pageSize: 'Letter',
          orientation: 'portrait',
          theme: 'default',
          fontFamily: 'source-serif-4'
        },
        colorScheme: 'system',
        authorName: ''
      })
      render(<App />)
      await screen.findByText('PageDown')
      await vi.waitFor(() => expect(window.api.getPreferences).toHaveBeenCalled())

      emitMenuCommand('file:new')

      await vi.waitFor(() => expect(useAppStore.getState().screen).toBe('editor'))
      expect(useDocumentStore.getState().content).toBe('')
    })

    it('file:open opens the native dialog and navigates on success', async () => {
      vi.mocked(window.api.openFile).mockResolvedValue({
        filePath: '/tmp/opened.md',
        content: '# Opened',
        recoveredFromAutosave: false,
        mtimeMs: 1000
      })
      render(<App />)
      await screen.findByText('PageDown')

      emitMenuCommand('file:open')

      await vi.waitFor(() => expect(useAppStore.getState().screen).toBe('editor'))
      expect(useDocumentStore.getState().filePath).toBe('/tmp/opened.md')
    })

    it('file:openRecent re-validates the path through the ordinary openPath action', async () => {
      // Security-relevant: the path comes from main's own recent-files.json,
      // but it still goes through documentStore.openPath -> file:openPath ->
      // isKnownPath, exactly like clicking a Home-screen recent row. The menu
      // grants no disk access of its own.
      vi.mocked(window.api.openPath).mockResolvedValue({
        filePath: '/tmp/recent.md',
        content: '# Recent',
        recoveredFromAutosave: false,
        mtimeMs: 1000
      })
      render(<App />)
      await screen.findByText('PageDown')

      emitMenuCommand('file:openRecent', '/tmp/recent.md')

      await vi.waitFor(() => {
        expect(window.api.openPath).toHaveBeenCalledWith('/tmp/recent.md')
        expect(useAppStore.getState().screen).toBe('editor')
      })
    })

    it('file:openRecent with no payload does nothing at all', () => {
      render(<App />)
      emitMenuCommand('file:openRecent')
      expect(window.api.openPath).not.toHaveBeenCalled()
    })

    it('app:preferences navigates to Settings from any screen', async () => {
      render(<App />)
      await screen.findByText('PageDown')

      emitMenuCommand('app:preferences')

      expect(useAppStore.getState().screen).toBe('settings')
    })

    it('unsubscribes from menu commands on unmount', () => {
      const unsubscribe = vi.fn()
      vi.mocked(window.api.onMenuCommand).mockReturnValue(unsubscribe)
      const { unmount } = render(<App />)

      unmount()

      expect(unsubscribe).toHaveBeenCalled()
    })
  })

  // The renderer half of the window-close / app-quit guard. Subscribed HERE,
  // not in EditorScreen, because a close request can arrive while the user is
  // on Home or Settings -- where EditorScreen is unmounted but documentStore
  // still holds every dirty tab.
  describe('window-close guard', () => {
    function emitCloseRequest(): void {
      const calls = vi.mocked(window.api.onWindowCloseRequest).mock.calls
      act(() => {
        for (const [callback] of calls) callback()
      })
    }

    it('answers "close me" when nothing is dirty', async () => {
      render(<App />)
      await screen.findByText('PageDown')

      emitCloseRequest()

      await waitFor(() => {
        expect(window.api.respondToWindowClose).toHaveBeenCalledWith(true)
      })
      expect(window.api.confirmDiscardChanges).not.toHaveBeenCalled()
    })

    it('prompts, and answers "stay open", when the user cancels with unsaved work', async () => {
      vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('cancel')
      render(<App />)
      await screen.findByText('PageDown')
      act(() => {
        useDocumentStore.setState((state) => ({
          filePath: '/tmp/report.md',
          isDirty: true,
          tabs: state.tabs.map((tab) =>
            tab.id === state.activeTabId
              ? { ...tab, filePath: '/tmp/report.md', isDirty: true }
              : tab
          )
        }))
      })

      emitCloseRequest()

      await waitFor(() => {
        expect(window.api.respondToWindowClose).toHaveBeenCalledWith(false)
      })
      expect(window.api.confirmDiscardChanges).toHaveBeenCalledWith('report.md')
    })

    it('answers "stay open" if the check itself fails, rather than closing', async () => {
      // Refusing to close is recoverable (fix, save, close again); closing on
      // an error is exactly the silent loss this guard exists to prevent.
      vi.mocked(window.api.confirmDiscardChanges).mockRejectedValue(new Error('IPC exploded'))
      vi.spyOn(console, 'error').mockImplementation(() => {})
      render(<App />)
      await screen.findByText('PageDown')
      act(() => {
        useDocumentStore.setState((state) => ({
          isDirty: true,
          tabs: state.tabs.map((tab) =>
            tab.id === state.activeTabId ? { ...tab, isDirty: true } : tab
          )
        }))
      })

      emitCloseRequest()

      await waitFor(() => {
        expect(window.api.respondToWindowClose).toHaveBeenCalledWith(false)
      })
      expect(useDocumentStore.getState().error).not.toBeNull()
    })

    it('unsubscribes on unmount', () => {
      const unsubscribe = vi.fn()
      vi.mocked(window.api.onWindowCloseRequest).mockReturnValue(unsubscribe)
      const { unmount } = render(<App />)

      unmount()

      expect(unsubscribe).toHaveBeenCalled()
    })
  })

  // Corrupt preferences / recent-files notices (src/main/config-warnings.ts).
  // A silently-emptied recents allowlist makes previously-openable documents
  // start failing with "Requested path is not a known recent file", which is
  // inexplicable without this.
  describe('startup warnings', () => {
    it('shows a drained startup warning to the user', async () => {
      vi.mocked(window.api.getStartupWarnings).mockResolvedValue([
        'Your list of recent documents could not be read and has been reset.'
      ])
      render(<App />)

      expect(await screen.findByRole('status')).toHaveTextContent(
        'Your list of recent documents could not be read and has been reset.'
      )
    })

    it('shows nothing when there is nothing to report', async () => {
      render(<App />)
      await screen.findByText('PageDown')

      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
  })

  // Product-completeness audit Tier 3, C: ShortcutsHelpModal (and its Mod-/
  // shortcut) used to be owned entirely by EditorScreen -- unreachable from
  // Home or Settings, where "there is no way to see the keyboard reference"
  // and "nothing on Home says what this app is or that Split/Source modes
  // exist" (the audit's own framing). Hoisted here so it works from every
  // screen; these tests are the proof, one per screen, not just "it works
  // somewhere."
  describe('keyboard shortcuts reference modal (works from every screen)', () => {
    it('Mod-/ opens it from the Home screen', async () => {
      render(<App />)
      await screen.findByText('PageDown')
      expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument()

      fireEvent.keyDown(window, { key: '/', metaKey: true })

      expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
      expect(useAppStore.getState().shortcutsHelpOpen).toBe(true)
    })

    it('Ctrl-/ (non-Mac convention) also opens it from Home', async () => {
      render(<App />)
      await screen.findByText('PageDown')

      fireEvent.keyDown(window, { key: '/', ctrlKey: true })

      expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    })

    it('a bare "/" with no modifier does not open it', async () => {
      render(<App />)
      await screen.findByText('PageDown')

      fireEvent.keyDown(window, { key: '/' })

      expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument()
    })

    it('Mod-/ opens it from the Settings screen', async () => {
      render(<App />)
      await screen.findByText('PageDown')
      act(() => {
        useAppStore.setState({ screen: 'settings' })
      })

      fireEvent.keyDown(window, { key: '/', metaKey: true })

      expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    })

    it('Mod-/ still opens it from the Editor screen', async () => {
      render(<App />)
      await screen.findByText('PageDown')
      act(() => {
        useAppStore.setState({ screen: 'editor' })
      })

      fireEvent.keyDown(window, { key: '/', metaKey: true })

      expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    })

    it('the app:shortcuts menu command opens it from Home, not just the keyboard shortcut', async () => {
      render(<App />)
      await screen.findByText('PageDown')

      emitMenuCommand('app:shortcuts')

      expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    })

    it('closing it (Close button) restores focus and leaves the underlying screen usable', async () => {
      const user = userEvent.setup()
      render(<App />)
      await screen.findByText('PageDown')

      fireEvent.keyDown(window, { key: '/', metaKey: true })
      expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Close' }))

      expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument()
      expect(useAppStore.getState().shortcutsHelpOpen).toBe(false)
    })

    // Rendered exactly ONCE, at App level -- EditorScreen used to render its
    // own copy too. Two simultaneous instances would mean two independent
    // useModalDialog focus traps fighting over the same Escape keystroke and
    // the same focus-restore target.
    it('renders only ONE instance of the modal while a document is open', async () => {
      render(<App />)
      await screen.findByText('PageDown')
      act(() => {
        useAppStore.setState({ screen: 'editor' })
      })

      fireEvent.keyDown(window, { key: '/', metaKey: true })

      expect(screen.getAllByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveLength(1)
    })
  })
})
