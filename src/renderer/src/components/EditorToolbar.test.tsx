import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditorToolbar from './EditorToolbar'
import { useAppStore, initialAppState } from '../store/appStore'
import { useDocumentStore, initialDocumentState } from '../store/documentStore'
import type { MilkdownEditorHandle } from '../milkdown/MilkdownEditor'

// A fake ref standing in for the real mounted MilkdownEditor -- per this
// sub-project's own scope (EditorToolbar is built and tested here, but a
// separate future integration step wires `editorRef` to the real editor;
// see EditorToolbar.tsx's own module comment). Every method is a plain
// vi.fn() so each test can assert exactly which one a given button calls,
// with what arguments.
function createFakeEditorHandle(): MilkdownEditorHandle {
  return {
    flush: vi.fn(),
    toggleBold: vi.fn(),
    toggleItalic: vi.fn(),
    toggleHeading: vi.fn(),
    setParagraph: vi.fn(),
    toggleBulletList: vi.fn(),
    toggleOrderedList: vi.fn(),
    insertLink: vi.fn(),
    insertTable: vi.fn(),
    insertPageBreak: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn()
  }
}

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
    getPageCount: vi.fn(),
    confirmDiscardChanges: vi.fn(),
    exportPdf: vi.fn().mockResolvedValue({ filePath: '/tmp/document.pdf' }),
    autosaveSnapshot: vi.fn(),
    getVersionHistory: vi.fn(),
    restoreVersionContent: vi.fn(),
    clearPendingAutosave: vi.fn()
  }
})

afterEach(() => {
  cleanup()
})

describe('EditorToolbar', () => {
  it('Bold calls editorRef.current.toggleBold()', async () => {
    const handle = createFakeEditorHandle()
    const ref = createRef<MilkdownEditorHandle>()
    ref.current = handle
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: 'Bold' }))

    expect(handle.toggleBold).toHaveBeenCalledTimes(1)
  })

  it('Italic calls editorRef.current.toggleItalic()', async () => {
    const handle = createFakeEditorHandle()
    const ref = createRef<MilkdownEditorHandle>()
    ref.current = handle
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: 'Italic' }))

    expect(handle.toggleItalic).toHaveBeenCalledTimes(1)
  })

  it('Bulleted list calls editorRef.current.toggleBulletList()', async () => {
    const handle = createFakeEditorHandle()
    const ref = createRef<MilkdownEditorHandle>()
    ref.current = handle
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: 'Bulleted list' }))

    expect(handle.toggleBulletList).toHaveBeenCalledTimes(1)
  })

  it('Numbered list calls editorRef.current.toggleOrderedList()', async () => {
    const handle = createFakeEditorHandle()
    const ref = createRef<MilkdownEditorHandle>()
    ref.current = handle
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: 'Numbered list' }))

    expect(handle.toggleOrderedList).toHaveBeenCalledTimes(1)
  })

  it('Undo/Redo call editorRef.current.undo()/redo()', async () => {
    const handle = createFakeEditorHandle()
    const ref = createRef<MilkdownEditorHandle>()
    ref.current = handle
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(handle.undo).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Redo' }))
    expect(handle.redo).toHaveBeenCalledTimes(1)
  })

  it('Insert table calls editorRef.current.insertTable()', async () => {
    const handle = createFakeEditorHandle()
    const ref = createRef<MilkdownEditorHandle>()
    ref.current = handle
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: 'Insert table' }))

    expect(handle.insertTable).toHaveBeenCalledTimes(1)
  })

  it('Insert page break calls editorRef.current.insertPageBreak()', async () => {
    const handle = createFakeEditorHandle()
    const ref = createRef<MilkdownEditorHandle>()
    ref.current = handle
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: 'Insert page break' }))

    expect(handle.insertPageBreak).toHaveBeenCalledTimes(1)
  })

  it('Insert link prompts for a URL and calls editorRef.current.insertLink(href) when one is given', async () => {
    const handle = createFakeEditorHandle()
    const ref = createRef<MilkdownEditorHandle>()
    ref.current = handle
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('https://example.com')
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: 'Insert link' }))

    expect(promptSpy).toHaveBeenCalled()
    expect(handle.insertLink).toHaveBeenCalledWith('https://example.com')
  })

  it('Insert link does not call insertLink if the URL prompt is cancelled', async () => {
    const handle = createFakeEditorHandle()
    const ref = createRef<MilkdownEditorHandle>()
    ref.current = handle
    vi.spyOn(window, 'prompt').mockReturnValue(null)
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: 'Insert link' }))

    expect(handle.insertLink).not.toHaveBeenCalled()
  })

  it('The paragraph-style dropdown calls editorRef.current.toggleHeading(level) for H1/H2/H3', async () => {
    const handle = createFakeEditorHandle()
    const ref = createRef<MilkdownEditorHandle>()
    ref.current = handle
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.selectOptions(screen.getByLabelText('Paragraph style'), 'Heading 2')

    expect(handle.toggleHeading).toHaveBeenCalledWith(2)
  })

  it('Selecting "Normal text" in the paragraph-style dropdown calls editorRef.current.setParagraph()', async () => {
    const handle = createFakeEditorHandle()
    const ref = createRef<MilkdownEditorHandle>()
    ref.current = handle
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    // First switch away from "Normal text" (so the select's displayed
    // value differs from it), then back -- selecting the currently
    // displayed default option directly wouldn't be a real value change to
    // assert against.
    await user.selectOptions(screen.getByLabelText('Paragraph style'), 'Heading 2')
    await user.selectOptions(screen.getByLabelText('Paragraph style'), 'Normal text')

    expect(handle.setParagraph).toHaveBeenCalledTimes(1)
    expect(handle.toggleHeading).toHaveBeenCalledTimes(1)
  })

  it('Fix-round: the paragraph-style dropdown resets to its default display after each selection, so re-selecting the same heading level fires again', async () => {
    const handle = createFakeEditorHandle()
    const ref = createRef<MilkdownEditorHandle>()
    ref.current = handle
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    const select = screen.getByLabelText('Paragraph style') as HTMLSelectElement
    expect(select.value).toBe('paragraph')

    await user.selectOptions(select, 'Heading 2')
    expect(handle.toggleHeading).toHaveBeenCalledTimes(1)
    expect(handle.toggleHeading).toHaveBeenNthCalledWith(1, 2)

    // Real bug this fixes (verified by the reviewer, not reproducible via
    // this environment's own userEvent.selectOptions -- see this
    // component's own handleHeadingChange comment): a real browser fires
    // no `change` event when the same option is re-selected with no other
    // selection in between, because the <select>'s displayed value hasn't
    // changed from the browser's point of view. Forcing a remount (fresh
    // DOM node, back to the uncontrolled default) after every use is what
    // makes the NEXT selection of "Heading 2" -- even on a different block
    // -- a genuine value change again. Asserting the value actually reset
    // is the part of this fix this test environment CAN verify directly.
    const selectAfter = screen.getByLabelText('Paragraph style') as HTMLSelectElement
    expect(selectAfter.value).toBe('paragraph')

    await user.selectOptions(selectAfter, 'Heading 2')
    expect(handle.toggleHeading).toHaveBeenCalledTimes(2)
    expect(handle.toggleHeading).toHaveBeenNthCalledWith(2, 2)
  })

  it('The view-mode segmented control calls useAppStore.setViewMode with the clicked mode', async () => {
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    expect(useAppStore.getState().viewMode).toBe('format')

    await user.click(screen.getByRole('button', { name: 'Split' }))
    expect(useAppStore.getState().viewMode).toBe('split')

    await user.click(screen.getByRole('button', { name: 'Source' }))
    expect(useAppStore.getState().viewMode).toBe('source')

    await user.click(screen.getByRole('button', { name: 'Format' }))
    expect(useAppStore.getState().viewMode).toBe('format')
  })

  it('The page-setup button calls useAppStore.openPageSetup', async () => {
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    expect(useAppStore.getState().pageSetupOpen).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Page setup' }))

    expect(useAppStore.getState().pageSetupOpen).toBe(true)
  })

  it('Export PDF calls window.api.exportPdf with the current document content', async () => {
    useDocumentStore.setState({ content: '# Real document content', filePath: null })
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: /Export PDF/ }))

    await waitFor(() => {
      expect(window.api.exportPdf).toHaveBeenCalledWith('# Real document content', null)
    })
  })

  it("Export PDF forwards the document's own file path, so local image references can resolve", async () => {
    // filePath is what src/main/pdf-exporter.ts uses to resolve the
    // document's local image references against its own directory --
    // without it, every local image in the exported PDF resolves to
    // nothing, matching usePageCount's own filePath forwarding.
    useDocumentStore.setState({
      content: '# Doc',
      filePath: '/Users/someone/notes/report.md'
    })
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: /Export PDF/ }))

    await waitFor(() => {
      expect(window.api.exportPdf).toHaveBeenCalledWith('# Doc', '/Users/someone/notes/report.md')
    })
  })

  it('Export PDF surfaces a failure as a friendly message, not the raw IPC error string', async () => {
    // Fix-round finding: showing the raw error (e.g. Electron's own "Error
    // invoking remote method 'file:exportPdf': Error: ...") directly to the
    // user is not a message they should have to parse. The real detail is
    // still logged (asserted below) for diagnosis.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(window.api.exportPdf).mockRejectedValue(
      new Error("Error invoking remote method 'file:exportPdf': Error: disk full")
    )
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: /Export PDF/ }))

    await waitFor(() => {
      expect(useDocumentStore.getState().error).toBe('Failed to export PDF. Please try again.')
    })
    expect(consoleErrorSpy).toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })

  it('Export PDF success does NOT clear an unrelated, pre-existing error message', async () => {
    // Fix-round finding: an earlier version unconditionally cleared
    // documentStore.error on a successful export, which silently discarded
    // any unrelated error (e.g. a failed Save moments earlier) that had
    // nothing to do with this export.
    useDocumentStore.setState({ error: 'Unrelated pre-existing error from a failed Save' })
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: /Export PDF/ }))

    await waitFor(() => {
      expect(window.api.exportPdf).toHaveBeenCalled()
    })
    expect(useDocumentStore.getState().error).toBe(
      'Unrelated pre-existing error from a failed Save'
    )
  })

  it('is safe to click every wired button when editorRef.current is null (no throw)', async () => {
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: 'Bold' }))
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await user.click(screen.getByRole('button', { name: 'Insert table' }))
    // Reaching here without throwing is the assertion.
  })

  it('One-shot action buttons omit aria-pressed entirely; genuine toggle buttons render it', () => {
    // Fix-round finding: every icon button previously rendered
    // aria-pressed="false" regardless of whether it represented a toggle
    // state at all -- a screen reader announces that as "this is a toggle
    // button, currently off," which is misleading for a one-shot action
    // button like Undo or Insert table.
    const ref = createRef<MilkdownEditorHandle>()
    render(<EditorToolbar editorRef={ref} />)

    expect(screen.getByRole('button', { name: 'Undo' })).not.toHaveAttribute('aria-pressed')
    expect(screen.getByRole('button', { name: 'Redo' })).not.toHaveAttribute('aria-pressed')
    expect(screen.getByRole('button', { name: 'Insert table' })).not.toHaveAttribute('aria-pressed')
    expect(screen.getByRole('button', { name: 'Insert page break' })).not.toHaveAttribute(
      'aria-pressed'
    )
    expect(screen.getByRole('button', { name: 'Find' })).not.toHaveAttribute('aria-pressed')

    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Italic' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Bulleted list' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.getByRole('button', { name: 'Numbered list' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })
})
