import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import HomeScreen from './HomeScreen'
import { useAppStore } from '../store/appStore'
import { useDocumentStore, initialDocumentState } from '../store/documentStore'
import { usePreferencesStore } from '../store/preferencesStore'

beforeEach(() => {
  useAppStore.setState({ screen: 'home' })
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
    // HomeScreen.tsx never calls these directly -- App.tsx's own
    // getPreferences() call feeds usePreferencesStore, which HomeScreen only
    // READS from. Bare mocks here satisfy FileApi's completeness, nothing
    // more; tests that need a real preferences value for the
    // default-page-config-on-new-document behavior set
    // usePreferencesStore.setState(...) directly instead.
    getPreferences: vi.fn(),
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
    setWindowState: vi.fn()
  }
  usePreferencesStore.setState({ preferences: null, loaded: false })
})

afterEach(() => {
  cleanup()
})

describe('HomeScreen', () => {
  it('creates a blank untitled document and navigates to Editor on "New document"', async () => {
    const user = userEvent.setup()
    render(<HomeScreen />)

    await user.click(screen.getByRole('button', { name: 'New document' }))

    expect(useDocumentStore.getState().filePath).toBeNull()
    expect(useDocumentStore.getState().content).toBe('')
    expect(useAppStore.getState().screen).toBe('editor')
  })

  it('loads the opened file and navigates to Editor when Open file succeeds', async () => {
    vi.mocked(window.api.openFile).mockResolvedValue({
      filePath: '/tmp/example.md',
      content: '# Hello',
      recoveredFromAutosave: false,
      mtimeMs: 1000
    })
    const user = userEvent.setup()
    render(<HomeScreen />)

    await user.click(screen.getByRole('button', { name: 'Open file…' }))

    expect(useDocumentStore.getState().filePath).toBe('/tmp/example.md')
    expect(useDocumentStore.getState().content).toBe('# Hello')
    expect(useAppStore.getState().screen).toBe('editor')
  })

  it('stays on Home and does not navigate when Open file is cancelled', async () => {
    vi.mocked(window.api.openFile).mockResolvedValue(null)
    const user = userEvent.setup()
    render(<HomeScreen />)

    await user.click(screen.getByRole('button', { name: 'Open file…' }))

    expect(useAppStore.getState().screen).toBe('home')
  })

  it('shows an inline error and stays on Home when Open file fails', async () => {
    vi.mocked(window.api.openFile).mockRejectedValue(new Error('Permission denied'))
    const user = userEvent.setup()
    render(<HomeScreen />)

    await user.click(screen.getByRole('button', { name: 'Open file…' }))

    expect(await screen.findByText('Permission denied')).toBeInTheDocument()
    expect(useAppStore.getState().screen).toBe('home')
  })

  it('clears the error when "Dismiss" is clicked', async () => {
    vi.mocked(window.api.openFile).mockRejectedValue(new Error('Permission denied'))
    const user = userEvent.setup()
    render(<HomeScreen />)

    await user.click(screen.getByRole('button', { name: 'Open file…' }))
    expect(await screen.findByText('Permission denied')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(useDocumentStore.getState().error).toBeNull()
    expect(screen.queryByText('Permission denied')).not.toBeInTheDocument()
  })

  it('renders all 8 template cards', () => {
    render(<HomeScreen />)
    expect(screen.getByText('Blank')).toBeInTheDocument()
    expect(screen.getByText('Résumé')).toBeInTheDocument()
    expect(screen.getByText('Letter')).toBeInTheDocument()
    expect(screen.getByText('Report')).toBeInTheDocument()
    expect(screen.getByText('Cover Letter')).toBeInTheDocument()
    expect(screen.getByText('Meeting Notes')).toBeInTheDocument()
    expect(screen.getByText('Invoice')).toBeInTheDocument()
    expect(screen.getByText('Newsletter')).toBeInTheDocument()
  })

  it('creates a document with the résumé starter content and navigates on Résumé card click', async () => {
    const user = userEvent.setup()
    render(<HomeScreen />)

    await user.click(screen.getByText('Résumé'))

    expect(useDocumentStore.getState().content).toContain('Jordan Rivera')
    expect(useAppStore.getState().screen).toBe('editor')
  })

  it('creates a document with the meeting notes starter content on Meeting Notes card click', async () => {
    const user = userEvent.setup()
    render(<HomeScreen />)

    await user.click(screen.getByText('Meeting Notes'))

    expect(useDocumentStore.getState().content).toContain('Action Items')
    expect(useAppStore.getState().screen).toBe('editor')
  })

  it('shows an empty state when there are no recent files', async () => {
    vi.mocked(window.api.getRecentFiles).mockResolvedValue([])
    render(<HomeScreen />)
    expect(await screen.findByText('No recent documents yet')).toBeInTheDocument()
  })

  it('renders recent files and opens one on click', async () => {
    vi.mocked(window.api.getRecentFiles).mockResolvedValue([
      { filePath: '/tmp/report.md', editedAt: new Date().toISOString() }
    ])
    vi.mocked(window.api.openPath).mockResolvedValue({
      filePath: '/tmp/report.md',
      content: '# Report',
      recoveredFromAutosave: false,
      mtimeMs: 1000
    })
    const user = userEvent.setup()
    render(<HomeScreen />)

    const row = await screen.findByText('report.md')
    await user.click(row)

    expect(useDocumentStore.getState().filePath).toBe('/tmp/report.md')
    expect(useAppStore.getState().screen).toBe('editor')
  })

  it('"Open in new window" calls window.api.openInNewWindow with the file path, without navigating this window at all', async () => {
    vi.mocked(window.api.getRecentFiles).mockResolvedValue([
      { filePath: '/tmp/report.md', editedAt: new Date().toISOString() }
    ])
    const user = userEvent.setup()
    render(<HomeScreen />)

    await screen.findByText('report.md')
    await user.click(screen.getByRole('button', { name: 'Open in new window' }))

    expect(window.api.openInNewWindow).toHaveBeenCalledWith('/tmp/report.md')
    // This window's own state is untouched -- opening a document in a new
    // window must not navigate away from Home or load anything here.
    expect(window.api.openPath).not.toHaveBeenCalled()
    expect(useAppStore.getState().screen).toBe('home')
    expect(useDocumentStore.getState().filePath).toBeNull()
  })

  it('filters recent documents by filename as the user types, and clearing the filter restores the full list', async () => {
    vi.mocked(window.api.getRecentFiles).mockResolvedValue([
      { filePath: '/tmp/report.md', editedAt: new Date().toISOString() },
      { filePath: '/tmp/letter.md', editedAt: new Date().toISOString() }
    ])
    const user = userEvent.setup()
    render(<HomeScreen />)

    await screen.findByText('report.md')
    expect(screen.getByText('letter.md')).toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: 'Filter recent documents' }), 'rep')

    expect(screen.getByText('report.md')).toBeInTheDocument()
    expect(screen.queryByText('letter.md')).not.toBeInTheDocument()

    await user.clear(screen.getByRole('textbox', { name: 'Filter recent documents' }))

    expect(screen.getByText('report.md')).toBeInTheDocument()
    expect(screen.getByText('letter.md')).toBeInTheDocument()
  })

  it('shows a real "no match" message when the filter matches nothing, instead of an empty list', async () => {
    vi.mocked(window.api.getRecentFiles).mockResolvedValue([
      { filePath: '/tmp/report.md', editedAt: new Date().toISOString() }
    ])
    const user = userEvent.setup()
    render(<HomeScreen />)

    await screen.findByText('report.md')
    await user.type(screen.getByRole('textbox', { name: 'Filter recent documents' }), 'nonexistent')

    expect(screen.queryByText('report.md')).not.toBeInTheDocument()
    expect(screen.getByText(/no recent documents match/i)).toBeInTheDocument()
  })

  it('does not render a filter input when there are no recent documents', async () => {
    vi.mocked(window.api.getRecentFiles).mockResolvedValue([])
    render(<HomeScreen />)

    await screen.findByText('No recent documents yet')
    expect(
      screen.queryByRole('textbox', { name: 'Filter recent documents' })
    ).not.toBeInTheDocument()
  })

  it('navigates to Settings when the Settings nav item is clicked', async () => {
    const user = userEvent.setup()
    render(<HomeScreen />)
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(useAppStore.getState().screen).toBe('settings')
  })

  it('scrolls to the Templates section when the Templates nav item is clicked', async () => {
    const user = userEvent.setup()
    render(<HomeScreen />)

    const scrollIntoViewSpy = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => {})

    await user.click(screen.getByRole('button', { name: 'Templates' }))

    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    expect(useAppStore.getState().homeActiveSection).toBe('templates')

    scrollIntoViewSpy.mockRestore()
  })
})
