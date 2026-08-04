import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditorScreen from './EditorScreen'
import { useDocumentStore, initialDocumentState } from '../store/documentStore'

beforeEach(() => {
  useDocumentStore.setState(initialDocumentState)
  window.api = {
    openFile: vi.fn(),
    openPath: vi.fn(),
    saveFile: vi.fn(),
    getRecentFiles: vi.fn(),
    getThumbnail: vi.fn(),
    getTemplateThumbnail: vi.fn()
  }
})

afterEach(() => {
  cleanup()
})

describe('EditorScreen', () => {
  it('shows "Untitled" for a new, unsaved document', () => {
    render(<EditorScreen />)
    expect(screen.getByText('Untitled')).toBeInTheDocument()
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
})
