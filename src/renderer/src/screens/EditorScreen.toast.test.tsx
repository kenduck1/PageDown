import { forwardRef, useImperativeHandle } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MilkdownEditorHandle } from '../milkdown/MilkdownEditor'

// Companion to EditorScreen.viewMode.test.tsx, covering the undo-barrier
// toast's trigger condition specifically -- see
// docs/superpowers/specs/2026-08-08-undo-barrier-notice-design.md for the
// exact scope (including the corrected finding that format<->split(format)
// DOES trigger this toast, contrary to an initial, disproven assumption).
const { mockEditorHandle } = vi.hoisted(() => ({
  mockEditorHandle: {
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
    // Find & Replace sub-project: these four are part of MilkdownEditorHandle
    // now, so this hand-built mock has to carry them to satisfy the interface.
    // Pure stubs -- nothing in this file's toast tests drives find/replace.
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
    insertImages: vi.fn(),
  removeLink: vi.fn(),
  toggleTaskList: vi.fn(),
  addRowBefore: vi.fn(),
  addRowAfter: vi.fn(),
  addColumnBefore: vi.fn(),
  addColumnAfter: vi.fn(),
  deleteRow: vi.fn(),
  deleteColumn: vi.fn(),
  deleteTable: vi.fn(),
  setColumnAlignment: vi.fn(),
  getTableRect: vi.fn(() => null),
  setActiveSlashIndex: vi.fn()
  }
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

const UNDO_BARRIER_MESSAGE = 'Undo history resets when switching between Format and Source.'

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

describe('EditorScreen undo-barrier toast', () => {
  it('shows the toast with the exact copy on Format -> Source', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    useAppStore.setState({ viewMode: 'format' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Source' }))

    expect(await screen.findByRole('status')).toHaveTextContent(UNDO_BARRIER_MESSAGE)
  })

  it('shows the toast on Source -> Format', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    useAppStore.setState({ viewMode: 'source' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Format' }))

    expect(await screen.findByRole('status')).toHaveTextContent(UNDO_BARRIER_MESSAGE)
  })

  // Corrected case (design doc finding): format<->split(format) is a real
  // structural remount of MilkdownEditor (same JSX-type-swap mechanism as a
  // genuine Format<->Source transition -- see EditorScreen.viewMode.test.tsx's
  // own 'Format -> Split(format) DOES call flush()' test), so it destroys
  // undo history exactly like the plain cases above and must show the toast.
  it('shows the toast on Format -> Split(format) -- a real remount, not just a reposition', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    useAppStore.setState({ viewMode: 'format', splitLeftMode: 'format' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Split' }))

    expect(await screen.findByRole('status')).toHaveTextContent(UNDO_BARRIER_MESSAGE)
  })

  it('shows the toast on Split(format) -> Format', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    useAppStore.setState({ viewMode: 'split', splitLeftMode: 'format' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Format' }))

    expect(await screen.findByRole('status')).toHaveTextContent(UNDO_BARRIER_MESSAGE)
  })

  // The one clean "genuinely nothing lost" case: neither side of this
  // transition is Format editing, so no MilkdownEditor instance exists on
  // either side and nothing about prosemirror-history is at stake.
  it('does NOT show the toast on Split(source) -> Source', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    useAppStore.setState({ viewMode: 'split', splitLeftMode: 'source' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Source' }))

    // Give any (incorrect) async toast a chance to appear before asserting
    // its absence.
    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
  })

  it('auto-dismisses the toast after 3 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    useAppStore.setState({ viewMode: 'format' })
    const user = userEvent.setup({ delay: null })
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Source' }))
    expect(await screen.findByRole('status')).toBeInTheDocument()

    vi.advanceTimersByTime(3000)
    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
    vi.useRealTimers()
  })
})
