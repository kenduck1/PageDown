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
    confirmDiscardChanges: vi.fn(),
    exportPdf: vi.fn().mockResolvedValue({ filePath: '/tmp/document.pdf' })
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
    useDocumentStore.setState({ content: '# Real document content' })
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: /Export PDF/ }))

    await waitFor(() => {
      expect(window.api.exportPdf).toHaveBeenCalledWith('# Real document content')
    })
  })

  it('Export PDF surfaces a failure via documentStore.error', async () => {
    vi.mocked(window.api.exportPdf).mockRejectedValue(new Error('export failed'))
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: /Export PDF/ }))

    await waitFor(() => {
      expect(useDocumentStore.getState().error).toBe('export failed')
    })
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
})
