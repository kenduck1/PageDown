import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { useAppStore, initialAppState } from './store/appStore'

beforeEach(() => {
  useAppStore.setState(initialAppState)
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
    openInNewWindow: vi.fn()
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
})
