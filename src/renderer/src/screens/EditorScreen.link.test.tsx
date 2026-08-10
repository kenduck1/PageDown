import { forwardRef, useImperativeHandle } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MilkdownEditorHandle } from '../milkdown/MilkdownEditor'

// End-to-end wiring coverage for Insert link: toolbar button -> LinkComposer
// row -> editorRef.insertLink(href). Same module-mock pattern
// EditorScreen.comments.test.tsx and EditorScreen.find.test.tsx already
// establish (see either file's own comment): EditorScreen owns editorRef
// internally, so there is no prop seam to inject a fake handle from outside,
// and what the real command DOES with an href is already covered directly
// against a real Milkdown instance by MilkdownEditor.test.tsx ('insertLink
// (href) wraps a real selection in a real <a href>', and the collapsed-cursor
// stored-mark case) -- what was broken, and what these tests cover, is
// everything BEFORE that call.
//
// The bug this file exists for: the toolbar button used to call
// `window.prompt('Link URL')`, which THROWS in Electron's renderer
// ("Error: prompt() is not supported." -- measured in the real built app: a
// pageerror fires, no dialog appears, the document is unchanged, and nothing
// at all surfaces in the UI). The throw happened on the line before
// insertLink was called, so the feature never worked once. The two tests that
// covered it mocked `window.prompt` itself, so they were green throughout --
// which is why the replacements here and in EditorToolbar.test.tsx assert
// against real rendered DOM and a real handle call instead.
const mockEditorHandle = vi.hoisted(() => ({
  flush: vi.fn(),
  toggleBold: vi.fn(),
  toggleItalic: vi.fn(),
  toggleInlineCode: vi.fn(),
  toggleHeading: vi.fn(),
  setParagraph: vi.fn(),
  toggleBulletList: vi.fn(),
  toggleOrderedList: vi.fn(),
  insertLink: vi.fn(),
  insertTable: vi.fn(),
  insertPageBreak: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  focusEnd: vi.fn(),
  setFindState: vi.fn(),
  replaceActiveMatch: vi.fn(),
  replaceAllMatches: vi.fn(),
  getSelectedText: vi.fn(() => ''),
  getSelectionRect: vi.fn(() => null),
  addComment: vi.fn(() => true),
  resolveComment: vi.fn(),
  runSlashItem: vi.fn(),
  closeSlashMenu: vi.fn(),
  getSlashItems: vi.fn(() => []),
  setActiveSlashIndex: vi.fn()
}))

vi.mock('../milkdown/MilkdownEditor', () => ({
  default: forwardRef<MilkdownEditorHandle, { content: string }>(
    function FakeMilkdownEditor(props, ref) {
      useImperativeHandle(ref, () => mockEditorHandle, [])
      return <div data-testid="fake-milkdown-editor">{props.content}</div>
    }
  )
}))

import EditorScreen from './EditorScreen'
import { useAppStore, initialAppState } from '../store/appStore'
import { useDocumentStore, initialDocumentState } from '../store/documentStore'

beforeEach(() => {
  useAppStore.setState(initialAppState)
  useDocumentStore.setState(initialDocumentState)
  Object.values(mockEditorHandle).forEach((fn) => fn.mockClear())
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
    print: vi.fn(),
    getPreferences: vi.fn(),
    setPreferences: vi.fn(),
    autosaveSnapshot: vi.fn(),
    getVersionHistory: vi.fn(),
    restoreVersionContent: vi.fn(),
    clearPendingAutosave: vi.fn(),
    setSplitPreviewBounds: vi.fn(),
    sendSplitPreviewDocument: vi.fn().mockResolvedValue({ pageCount: 1 }),
    destroySplitPreview: vi.fn(),
    scrollSplitPreviewToPage: vi.fn().mockResolvedValue({ currentPage: 1, pageCount: 0 }),
    getSplitPreviewPage: vi.fn().mockResolvedValue({ currentPage: 1, pageCount: 0 }),
    saveDroppedImage: vi.fn(),
    openInNewWindow: vi.fn()
  }
})

afterEach(() => {
  cleanup()
})

describe('EditorScreen insert link', () => {
  it('the toolbar Insert link button opens the composer row instead of a browser prompt', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    const promptSpy = vi.spyOn(window, 'prompt').mockImplementation(() => {
      throw new Error('prompt() is not supported.')
    })
    const user = userEvent.setup()
    render(<EditorScreen />)

    expect(screen.queryByRole('group', { name: 'Insert link' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Insert link' }))

    expect(screen.getByRole('group', { name: 'Insert link' })).toBeInTheDocument()
    expect(promptSpy).not.toHaveBeenCalled()
    promptSpy.mockRestore()
  })

  it('submitting the composer calls editorRef.insertLink with the typed URL and closes the row', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Insert link' }))
    await user.type(screen.getByRole('textbox', { name: 'Link URL' }), 'https://example.com')
    await user.click(screen.getByRole('button', { name: 'Insert' }))

    expect(mockEditorHandle.insertLink).toHaveBeenCalledWith('https://example.com')
    expect(screen.queryByRole('group', { name: 'Insert link' })).not.toBeInTheDocument()
  })

  it('Enter in the URL field inserts, same as clicking Insert', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Insert link' }))
    await user.type(screen.getByRole('textbox', { name: 'Link URL' }), 'https://a.example{Enter}')

    expect(mockEditorHandle.insertLink).toHaveBeenCalledWith('https://a.example')
  })

  it('Cancel closes the composer without inserting anything', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Insert link' }))
    await user.type(screen.getByRole('textbox', { name: 'Link URL' }), 'https://example.com')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(mockEditorHandle.insertLink).not.toHaveBeenCalled()
    expect(screen.queryByRole('group', { name: 'Insert link' })).not.toBeInTheDocument()
  })

  // The composer is a LAYOUT ROW, not a floating popover, and that is an
  // architectural requirement (a Split-mode WebContentsView composites above
  // ALL DOM -- see LinkComposer.tsx/FindBar.tsx). This pins the structural
  // property that enforces it: the row is a sibling in EditorScreen's own
  // top-level column, ABOVE the content row, so opening it shrinks the
  // content area (which is what makes SplitPreview's existing ResizeObserver
  // re-report bounds) rather than painting over it.
  it('renders the composer as a layout row above the content area, not as an overlay over it', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Insert link' }))

    const row = screen.getByRole('group', { name: 'Insert link' })
    const contentRow = screen.getByTestId('document-content')
    expect(row.contains(contentRow)).toBe(false)
    expect(contentRow.contains(row)).toBe(false)
    // Node.DOCUMENT_POSITION_FOLLOWING (4): the content area comes after the
    // composer row in document order.
    expect(row.compareDocumentPosition(contentRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(4)
    // No fixed/absolute positioning anywhere on the row itself -- an overlay
    // would need one of them, and would then need SplitPreview's zero-size
    // rectangle workaround the way both full-screen modals do.
    expect(row.className).not.toMatch(/\b(fixed|absolute)\b/)
  })
})
