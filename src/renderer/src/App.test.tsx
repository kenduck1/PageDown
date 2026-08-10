import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { useAppStore, initialAppState } from './store/appStore'
import { useDocumentStore, initialDocumentState } from './store/documentStore'
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
    getThumbnail: vi.fn().mockResolvedValue({ dataUrl: 'data:image/png;base64,x', pageCount: 1 }),
    getTemplateThumbnail: vi
      .fn()
      .mockResolvedValue({ dataUrl: 'data:image/png;base64,x', pageCount: 1 }),
    getPageCount: vi.fn().mockResolvedValue({ pageCount: 1 }),
    confirmDiscardChanges: vi.fn(),
    exportPdf: vi.fn(),
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
    // The window-close guard's two channels. onWindowCloseRequest must
    // return a real unsubscribe FUNCTION -- App.tsx calls it from an effect
    // cleanup, same contract as onMenuCommand above.
    onWindowCloseRequest: vi.fn().mockReturnValue(() => {}),
    respondToWindowClose: vi.fn(),
    getStartupWarnings: vi.fn().mockResolvedValue([])
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
        fileName: null,
        isDirty: false
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
        fileName: 'report.md',
        isDirty: true
      })
    })

    it('file:new creates a document and shows the editor', async () => {
      render(<App />)
      await screen.findByText('PageDown')

      emitMenuCommand('file:new')

      expect(useAppStore.getState().screen).toBe('editor')
      expect(useDocumentStore.getState().tabs).toHaveLength(2)
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
})
