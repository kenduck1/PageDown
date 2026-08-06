import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditorScreen from './EditorScreen'
import { useAppStore, initialAppState } from '../store/appStore'
import { useDocumentStore, initialDocumentState } from '../store/documentStore'

beforeEach(() => {
  useAppStore.setState(initialAppState)
  useDocumentStore.setState(initialDocumentState)
  window.api = {
    openFile: vi.fn(),
    openPath: vi.fn(),
    saveFile: vi.fn(),
    getRecentFiles: vi.fn(),
    getThumbnail: vi.fn(),
    getTemplateThumbnail: vi.fn(),
    getPageCount: vi.fn().mockResolvedValue({ pageCount: 1 }),
    confirmDiscardChanges: vi.fn(),
    exportPdf: vi.fn(),
    autosaveSnapshot: vi.fn(),
    getVersionHistory: vi.fn(),
    restoreVersionContent: vi.fn(),
    clearPendingAutosave: vi.fn()
  }
})

afterEach(() => {
  cleanup()
})

describe('EditorScreen', () => {
  it('shows "Untitled" for a new, unsaved document', () => {
    render(<EditorScreen />)
    // Two elements now legitimately show "Untitled" for an unsaved document
    // -- the title bar's filename readout AND the tab bar's active-tab
    // label (EditorTabBar) -- both fall back to the same "Untitled" label
    // independently, per each component's own design-handoff spec.
    expect(screen.getAllByText('Untitled').length).toBeGreaterThan(0)
  })

  it('shows the real file path and content for a loaded document', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report\n\nBody text' })
    render(<EditorScreen />)
    expect(screen.getByText('/tmp/report.md')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('document-content')).toHaveTextContent('Report')
      expect(screen.getByTestId('document-content')).toHaveTextContent('Body text')
    })
  })

  it('shows the error message alongside content when the store has an error', async () => {
    useDocumentStore.setState({ error: 'File not found', content: '# Report' })
    render(<EditorScreen />)
    expect(screen.getByText('File not found')).toBeInTheDocument()
    // The error is a banner above the content, not a replacement for it: a
    // failed *save* says nothing about whether the loaded content is valid.
    await waitFor(() => {
      expect(screen.getByTestId('document-content')).toHaveTextContent('Report')
    })
  })

  it('saves the current document through window.api when "Save" is clicked', async () => {
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/tmp/report.md' })
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report', isDirty: true })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Save' }))

    // Task 8 finding, later closed by a Task 8 review-round fix (see
    // task-8-report.md): in this test environment, userEvent.click's own
    // microtask/act flushing gives Milkdown's async Editor.create() enough
    // time to resolve before the click fires, so editorRef.current is
    // non-null by the time handleSave runs. Without a real-edit gate,
    // handleSave's getMarkdown() would re-serialize through Milkdown's
    // pinned remark-stringify options even with zero edits, which is NOT
    // byte-identical to this '# Report' fixture (remark-stringify always
    // emits a trailing newline the fixture lacks) -- silently rewriting an
    // untouched document's saved bytes on every Save click. MilkdownEditor's
    // getMarkdown() now returns null unless a real ProseMirror transaction
    // (docChanged/storedMarksSet, excluding Milkdown's own internal
    // addToHistory:false synthetic transactions -- see MilkdownEditor.tsx's
    // editedSinceMountRef comment) has landed since mount, so handleSave's
    // `latest !== null` guard correctly skips updateContent here and the
    // original, unmodified content is what actually gets saved. See
    // 'does not touch the saved content when Save is clicked with zero
    // edits' below for the test written specifically to lock this in.
    expect(window.api.saveFile).toHaveBeenCalledWith('/tmp/report.md', '# Report')
    expect(useDocumentStore.getState().isDirty).toBe(false)
  })

  it('does not touch the saved content when Save is clicked with zero edits, even if the editor has mounted', async () => {
    // Deliberately uses non-canonical markdown that Milkdown's PINNED_STRINGIFY_OPTIONS
    // (stringify-options.ts: '-' bullets, '_' emphasis, '`' fences) would
    // silently rewrite if handleSave ever re-serialized it: '*'-bullets,
    // single-asterisk emphasis, and a '~~~' fence are all common, valid
    // Markdown that Milkdown's canonical form does not preserve verbatim.
    // If this fix regresses (i.e. handleSave syncs live editor content on
    // every Save regardless of whether an edit occurred), this exact
    // content would come back rewritten to '-' bullets / '_' emphasis /
    // '`' fences -- not byte-identical -- and this assertion would catch it.
    const ORIGINAL = '# Report\n\n* one\n* two\n\n*italic*\n\n~~~\ncode\n~~~\n'
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/tmp/report.md' })
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: ORIGINAL, isDirty: true })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await waitFor(() => {
      expect(screen.getByTestId('document-content')).toHaveTextContent('one')
    })
    // Give the editor's async Editor.create() every chance to have resolved
    // by click time -- the whole point of this test is proving that even a
    // fully-mounted, idle editor doesn't cause Save to rewrite the file.
    await waitFor(() => {
      expect(document.querySelector('.milkdown-mount .ProseMirror')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(window.api.saveFile).toHaveBeenCalled()
    })
    expect(window.api.saveFile).toHaveBeenCalledWith('/tmp/report.md', ORIGINAL)
  })

  it('adopts the fallback path when Save-As returns a different path than requested', async () => {
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/tmp/chosen.md' })
    useDocumentStore.setState({ filePath: '/tmp/unknown.md', content: '# Report' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('/tmp/chosen.md')).toBeInTheDocument()
    expect(useDocumentStore.getState().filePath).toBe('/tmp/chosen.md')
  })

  it('Save picks up the editor current content even if onChange has not fired yet (debounce race)', async () => {
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/tmp/report.md' })
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report', isDirty: true })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await waitFor(() => {
      expect(screen.getByTestId('document-content')).toHaveTextContent('Report')
    })

    // Simulate the race directly rather than trying to win a real 200ms
    // timing window in a test: content the STORE doesn't know about yet,
    // as if onChange's debounce simply hasn't fired. This is exactly the
    // state handleSave must recover from.
    const proseMirror = document.querySelector('.ProseMirror')
    const h1 = proseMirror?.querySelector('h1')
    if (!h1?.firstChild) throw new Error('expected a text node inside the mounted h1')
    h1.firstChild.textContent = `${h1.firstChild.textContent} Q3`
    const range = document.createRange()
    range.selectNodeContents(h1)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    // Give ProseMirror's MutationObserver one tick to register the edit into
    // its own state (so editorRef.current.action(getMarkdown()) reflects it),
    // but click Save before waiting anywhere near the 200ms onChange debounce
    // -- the whole scenario under test.
    await new Promise((resolve) => setTimeout(resolve, 20))

    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(window.api.saveFile).toHaveBeenCalled()
    })
    const savedContent = vi.mocked(window.api.saveFile).mock.calls.at(-1)?.[1]
    expect(savedContent).toContain('Q3')
  })

  it('clears the error when "Dismiss" is clicked', async () => {
    useDocumentStore.setState({ error: 'File not found' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(useDocumentStore.getState().error).toBeNull()
    expect(screen.queryByText('File not found')).not.toBeInTheDocument()
  })

  it('prompts before navigating Home when the document is dirty, and stays if cancelled', async () => {
    // Real navigation state, not just "EditorScreen happens to be rendered
    // in a test" -- App.tsx only ever mounts EditorScreen while
    // screen === 'editor', so that's the realistic precondition for
    // "Home was clicked while viewing the editor."
    useAppStore.setState({ screen: 'editor' })
    useDocumentStore.setState({ content: '# Report', isDirty: true })
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('cancel')
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: '← Home' }))

    expect(window.api.confirmDiscardChanges).toHaveBeenCalled()
    expect(useAppStore.getState().screen).toBe('editor')
  })

  it('navigates Home without prompting when the document is not dirty', async () => {
    useAppStore.setState({ screen: 'editor' })
    useDocumentStore.setState({ content: '# Report', isDirty: false })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: '← Home' }))

    expect(window.api.confirmDiscardChanges).not.toHaveBeenCalled()
    expect(useAppStore.getState().screen).toBe('home')
  })

  it('discards and navigates Home when the user chooses "Don\'t Save"', async () => {
    useAppStore.setState({ screen: 'editor' })
    useDocumentStore.setState({ content: '# Report', isDirty: true })
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('discard')
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: '← Home' }))

    await waitFor(() => expect(useAppStore.getState().screen).toBe('home'))
  })

  it('clears pending autosave for the document when the user chooses "Don\'t Save"', async () => {
    // "Don't Save" means exactly that -- a pending autosave snapshot must
    // never silently reappear on next open.
    useAppStore.setState({ screen: 'editor' })
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report', isDirty: true })
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('discard')
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: '← Home' }))

    await waitFor(() => {
      expect(window.api.clearPendingAutosave).toHaveBeenCalledWith(
        '/tmp/report.md',
        expect.any(String)
      )
    })
  })

  it('does NOT clear pending autosave when the user chooses to Save (not discard)', async () => {
    useAppStore.setState({ screen: 'editor' })
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report', isDirty: true })
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('save')
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/tmp/report.md' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: '← Home' }))

    await waitFor(() => {
      expect(useAppStore.getState().screen).toBe('home')
    })
    expect(window.api.clearPendingAutosave).not.toHaveBeenCalled()
  })

  it('does not navigate Home if Save was chosen but the user cancelled the Save-As dialog', async () => {
    // Real navigation state, matching the sibling dirty-check tests above --
    // without this, useAppStore's initial screen ('home') would make the
    // "stayed on editor" assertion below pass trivially even if the fix
    // were wrong, since it was never 'editor' to begin with.
    useAppStore.setState({ screen: 'editor' })
    useDocumentStore.setState({ filePath: null, content: '# New Doc', isDirty: true })
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('save')
    vi.mocked(window.api.saveFile).mockResolvedValue(null) // user cancelled Save-As
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: '← Home' }))

    await waitFor(() => {
      expect(window.api.saveFile).toHaveBeenCalled()
    })
    expect(useAppStore.getState().screen).toBe('editor')
    expect(useDocumentStore.getState().isDirty).toBe(true)
  })

  it('navigates Home after a successful Save from the discard-confirmation dialog', async () => {
    // Same reasoning as above: without an explicit non-'home' starting
    // screen, "ends up on home" would be trivially true from
    // initialAppState alone, proving nothing about navigation actually
    // happening.
    useAppStore.setState({ screen: 'editor' })
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report', isDirty: true })
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('save')
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/tmp/report.md' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: '← Home' }))

    await waitFor(() => {
      expect(useAppStore.getState().screen).toBe('home')
    })
  })
})
