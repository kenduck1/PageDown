import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
    // Resolved, not a bare `vi.fn()` (which returns `undefined`) -- this
    // file's own tests click the real "Open in new window" button, and
    // handleOpenInNewWindow now calls `.catch()` on the real return value
    // (product-completeness audit Tier 3, B.2), matching the real preload
    // API's actual `Promise<void>` contract. A bare `vi.fn()` here made even
    // the pre-existing success-path test throw `Cannot read properties of
    // undefined (reading 'catch')` -- caught by running this file's suite,
    // not assumed.
    openInNewWindow: vi.fn().mockResolvedValue(undefined),
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

  // Product-completeness audit Tier 3, B.1: this banner had no role at all,
  // so a failed open was invisible to a screen-reader user.
  it('announces the error banner via role="alert"', async () => {
    vi.mocked(window.api.openFile).mockRejectedValue(new Error('Permission denied'))
    const user = userEvent.setup()
    render(<HomeScreen />)

    await user.click(screen.getByRole('button', { name: 'Open file…' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied')
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

    // Keyed on a structural heading unique to the resume template, not on a
    // name: the templates were de-personalised (every plausible real person
    // replaced with a role-descriptive placeholder), and this assertion used
    // to pin the removed name, so it broke on that pass. A heading still
    // discriminates the resume from every other template's starter content
    // without re-coupling this test to prose that is meant to be edited.
    expect(useDocumentStore.getState().content).toContain('## Experience')
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
      { filePath: '/tmp/report.md', editedAt: new Date().toISOString(), exists: true }
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
      { filePath: '/tmp/report.md', editedAt: new Date().toISOString(), exists: true }
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

  // Product-completeness audit Tier 3, B.2: a rejected openInNewWindow() used
  // to vanish as an unhandled promise rejection -- the button looked dead,
  // with not even a console.error. Real regression test, not just a
  // `.catch()` existing: this asserts the observable failure surface.
  it('"Open in new window" surfaces a real error, and logs it, when the IPC call rejects', async () => {
    vi.mocked(window.api.getRecentFiles).mockResolvedValue([
      { filePath: '/tmp/report.md', editedAt: new Date().toISOString(), exists: true }
    ])
    vi.mocked(window.api.openInNewWindow).mockRejectedValue(new Error('window creation failed'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    render(<HomeScreen />)

    await screen.findByText('report.md')
    await user.click(screen.getByRole('button', { name: 'Open in new window' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not open this document in a new window.'
    )
    expect(consoleError).toHaveBeenCalledWith('Failed to open in new window', expect.any(Error))
    // Still hasn't navigated or loaded anything into THIS window.
    expect(useAppStore.getState().screen).toBe('home')
    expect(useDocumentStore.getState().filePath).toBeNull()
    consoleError.mockRestore()
  })

  // Product-completeness audit 0.6: "Remove from recents" / "Clear recents".
  it('"Remove from recents" removes just that row, without navigating or opening anything', async () => {
    vi.mocked(window.api.getRecentFiles).mockResolvedValue([
      { filePath: '/tmp/report.md', editedAt: new Date().toISOString(), exists: true },
      { filePath: '/tmp/letter.md', editedAt: new Date().toISOString(), exists: true }
    ])
    vi.mocked(window.api.removeRecentFile).mockResolvedValue([
      { filePath: '/tmp/letter.md', editedAt: new Date().toISOString(), exists: true }
    ])
    const user = userEvent.setup()
    render(<HomeScreen />)

    await screen.findByText('report.md')
    const removeButtons = screen.getAllByRole('button', { name: 'Remove from recents' })
    // Two rows -> two remove buttons; click the first (report.md, which
    // renders first per the recents-list order returned above).
    await user.click(removeButtons[0])

    expect(window.api.removeRecentFile).toHaveBeenCalledWith('/tmp/report.md')
    expect(await screen.findByText('letter.md')).toBeInTheDocument()
    expect(screen.queryByText('report.md')).not.toBeInTheDocument()
    // Removing a row is not opening it.
    expect(window.api.openPath).not.toHaveBeenCalled()
    expect(useAppStore.getState().screen).toBe('home')
  })

  it('"Clear all" clears every recent row and hides itself once the list is empty', async () => {
    vi.mocked(window.api.getRecentFiles).mockResolvedValue([
      { filePath: '/tmp/report.md', editedAt: new Date().toISOString(), exists: true },
      { filePath: '/tmp/letter.md', editedAt: new Date().toISOString(), exists: true }
    ])
    // Second-pass product-completeness audit: clearRecentFiles now resolves
    // the SURVIVING list (any path open in some window is preserved -- see
    // that IPC method's own comment), not void -- an empty array here is
    // the real "nothing was open anywhere" case, matching what the real
    // main-process handler returns. Asserting against this resolved value
    // (rather than the old bare `undefined`) is what proves HomeScreen sets
    // its state from the actual response instead of assuming an empty list.
    vi.mocked(window.api.clearRecentFiles).mockResolvedValue([])
    const user = userEvent.setup()
    render(<HomeScreen />)

    await screen.findByText('report.md')
    await user.click(screen.getByRole('button', { name: 'Clear all' }))

    expect(window.api.clearRecentFiles).toHaveBeenCalled()
    expect(await screen.findByText('No recent documents yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument()
  })

  // Second-pass product-completeness audit: proves HomeScreen genuinely sets
  // its list from clearRecentFiles' own response rather than hardcoding [].
  // The real preservation logic (which paths survive) lives entirely in main
  // (see recent-files.ts's clearRecentFiles and the file:clearRecents
  // handler in src/main/index.ts) -- this only has to prove the renderer
  // doesn't discard a non-empty response.
  it('"Clear all" keeps showing a row the main process reports as preserved (currently open elsewhere)', async () => {
    vi.mocked(window.api.getRecentFiles).mockResolvedValue([
      { filePath: '/tmp/report.md', editedAt: new Date().toISOString(), exists: true },
      { filePath: '/tmp/letter.md', editedAt: new Date().toISOString(), exists: true }
    ])
    vi.mocked(window.api.clearRecentFiles).mockResolvedValue([
      { filePath: '/tmp/report.md', editedAt: new Date().toISOString(), exists: true }
    ])
    const user = userEvent.setup()
    render(<HomeScreen />)

    await screen.findByText('report.md')
    await user.click(screen.getByRole('button', { name: 'Clear all' }))

    expect(window.api.clearRecentFiles).toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.queryByText('letter.md')).not.toBeInTheDocument()
    })
    expect(screen.getByText('report.md')).toBeInTheDocument()
  })

  it('does not render "Clear all" when there are no recent documents', async () => {
    vi.mocked(window.api.getRecentFiles).mockResolvedValue([])
    render(<HomeScreen />)

    await screen.findByText('No recent documents yet')
    expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument()
  })

  // Product-completeness audit 0.6: "mark rows whose file no longer exists."
  it('marks a row whose file no longer exists as "File not found" instead of a page count, and skips its thumbnail fetch', async () => {
    vi.mocked(window.api.getRecentFiles).mockResolvedValue([
      { filePath: '/tmp/gone.md', editedAt: new Date().toISOString(), exists: false }
    ])
    render(<HomeScreen />)

    expect(await screen.findByText('File not found')).toBeInTheDocument()
    // The whole point of the `exists` flag is to avoid a doomed IPC round
    // trip -- getThumbnail would only fail (ENOENT) for a row already known
    // to be missing.
    expect(window.api.getThumbnail).not.toHaveBeenCalled()
  })

  it('still shows the real page count for a row whose file exists', async () => {
    vi.mocked(window.api.getRecentFiles).mockResolvedValue([
      { filePath: '/tmp/report.md', editedAt: new Date().toISOString(), exists: true }
    ])
    vi.mocked(window.api.getThumbnail).mockResolvedValue({
      dataUrl: 'data:image/png;base64,x',
      pageCount: 3
    })
    render(<HomeScreen />)

    expect(await screen.findByText('3 pages')).toBeInTheDocument()
    expect(screen.queryByText('File not found')).not.toBeInTheDocument()
  })

  it('filters recent documents by filename as the user types, and clearing the filter restores the full list', async () => {
    vi.mocked(window.api.getRecentFiles).mockResolvedValue([
      { filePath: '/tmp/report.md', editedAt: new Date().toISOString(), exists: true },
      { filePath: '/tmp/letter.md', editedAt: new Date().toISOString(), exists: true }
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
      { filePath: '/tmp/report.md', editedAt: new Date().toISOString(), exists: true }
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

describe('HomeScreen navigation order matches content order', () => {
  // The reported defect: the nav listed Recent above Templates while `main`
  // rendered Templates above Recent, so the second scroll link scrolled UP.
  // Asserting the two orders against EACH OTHER rather than against a
  // hardcoded expectation is what makes this a real regression test -- it
  // fails if EITHER side is reordered on its own, in either direction.
  it('lists the section links in the same order the sections themselves render', async () => {
    vi.mocked(window.api.getRecentFiles).mockResolvedValue([])
    render(<HomeScreen />)

    const nav = document.querySelector('nav') as HTMLElement
    const navLabels = Array.from(nav.querySelectorAll('button'))
      .map((button) => button.textContent?.trim())
      .filter((label) => label === 'Templates' || label === 'Recent')

    const main = document.querySelector('main') as HTMLElement
    const sectionHeadings = Array.from(main.querySelectorAll('h2'))
      .map((heading) => heading.textContent?.trim())
      // The templates section's own heading is "Start new"; map it onto the
      // nav label that scrolls to it so the two lists are comparable.
      .map((text) => (text === 'Start new' ? 'Templates' : text))
      .filter((label) => label === 'Templates' || label === 'Recent')

    expect(navLabels).toEqual(['Templates', 'Recent'])
    expect(navLabels).toEqual(sectionHeadings)
  })

  // The third inconsistency in the same defect: the nav highlight claimed
  // "Recent" on first paint while the content was scrolled to the top of
  // Templates.
  it('highlights the section that is actually at the top of the content on first paint', async () => {
    vi.mocked(window.api.getRecentFiles).mockResolvedValue([])
    render(<HomeScreen />)

    const main = document.querySelector('main') as HTMLElement
    const firstHeading = main.querySelector('h2')?.textContent?.trim()

    expect(firstHeading).toBe('Start new')
    expect(useAppStore.getState().homeActiveSection).toBe('templates')
  })
})

// --- Launch-time recovery surface for NEVER-SAVED documents ---------------
//
// Home is where a crashed-but-never-saved document is offered back. These
// cover the surface itself; documentStore.test.ts covers what Recover then
// does to the store, and src/main/unsaved-drafts.test.ts covers the storage.
describe('HomeScreen: unsaved documents', () => {
  const draft = {
    draftId: 'a'.repeat(32),
    updatedAt: new Date().toISOString(),
    sizeBytes: 42,
    preview: 'Quarterly report'
  }

  it('renders nothing at all when there are no drafts', async () => {
    vi.mocked(window.api.listUnsavedDrafts).mockResolvedValue([])
    render(<HomeScreen />)

    await waitFor(() => expect(window.api.listUnsavedDrafts).toHaveBeenCalled())
    expect(screen.queryByText('Unsaved documents')).not.toBeInTheDocument()
  })

  it('offers a recovered draft by its own preview text', async () => {
    vi.mocked(window.api.listUnsavedDrafts).mockResolvedValue([draft])
    render(<HomeScreen />)

    expect(await screen.findByText('Unsaved documents')).toBeInTheDocument()
    expect(screen.getByText('Quarterly report')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Recover' })).toBeInTheDocument()
  })

  it('falls back to a real label rather than a blank line for a preview-less draft', async () => {
    vi.mocked(window.api.listUnsavedDrafts).mockResolvedValue([{ ...draft, preview: '' }])
    render(<HomeScreen />)

    expect(await screen.findByText('Untitled document')).toBeInTheDocument()
  })

  it('Recover loads the draft as a dirty untitled document and navigates to Editor', async () => {
    vi.mocked(window.api.listUnsavedDrafts).mockResolvedValue([draft])
    vi.mocked(window.api.readUnsavedDraft).mockResolvedValue('# Quarterly report\n\nBody.')
    const user = userEvent.setup()
    render(<HomeScreen />)

    await user.click(await screen.findByRole('button', { name: 'Recover' }))

    await waitFor(() => expect(useAppStore.getState().screen).toBe('editor'))
    expect(useDocumentStore.getState().content).toBe('# Quarterly report\n\nBody.')
    expect(useDocumentStore.getState().filePath).toBeNull()
    expect(useDocumentStore.getState().isDirty).toBe(true)
  })

  // The row's two-step confirm, and why it exists: "Remove from recents" one
  // section below deletes nothing and is undone by reopening the file, while
  // this destroys the only copy of real work in existence. A single stray
  // click must not be able to do that.
  it('does NOT discard on the first Discard click -- it asks first', async () => {
    vi.mocked(window.api.listUnsavedDrafts).mockResolvedValue([draft])
    const user = userEvent.setup()
    render(<HomeScreen />)

    await user.click(await screen.findByRole('button', { name: 'Discard' }))

    expect(window.api.discardUnsavedDraft).not.toHaveBeenCalled()
    expect(screen.getByText('Discard permanently?')).toBeInTheDocument()
    // And the work is still on screen, still offered.
    expect(screen.getByText('Quarterly report')).toBeInTheDocument()
  })

  it('Keep backs out of the confirm without discarding', async () => {
    vi.mocked(window.api.listUnsavedDrafts).mockResolvedValue([draft])
    const user = userEvent.setup()
    render(<HomeScreen />)

    await user.click(await screen.findByRole('button', { name: 'Discard' }))
    await user.click(screen.getByRole('button', { name: 'Keep' }))

    expect(window.api.discardUnsavedDraft).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Recover' })).toBeInTheDocument()
  })

  it('confirming Discard removes the row and really asks main to delete it', async () => {
    vi.mocked(window.api.listUnsavedDrafts).mockResolvedValue([draft])
    const user = userEvent.setup()
    render(<HomeScreen />)

    await user.click(await screen.findByRole('button', { name: 'Discard' }))
    await user.click(screen.getByRole('button', { name: 'Discard' }))

    expect(window.api.discardUnsavedDraft).toHaveBeenCalledWith('a'.repeat(32))
    await waitFor(() => expect(screen.queryByText('Quarterly report')).not.toBeInTheDocument())
  })

  it('survives a failed listing rather than breaking the whole screen', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(window.api.listUnsavedDrafts).mockRejectedValue(new Error('nope'))
    render(<HomeScreen />)

    // The rest of Home still renders.
    expect(await screen.findByRole('button', { name: 'New document' })).toBeInTheDocument()
    expect(screen.queryByText('Unsaved documents')).not.toBeInTheDocument()
  })
})
