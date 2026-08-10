import { forwardRef, useImperativeHandle } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MilkdownEditorHandle } from '../milkdown/MilkdownEditor'

// Same module-mock pattern EditorScreen.find.test.tsx already establishes
// (see that file's own comment for the full rationale): EditorScreen owns
// editorRef internally, so there is no prop seam to inject a fake handle
// from outside, and asserting real ProseMirror-computed comment marks under
// jsdom is neither reliable nor necessary to prove the WIRING (as opposed to
// the mark schema/commands themselves, already covered directly by
// commands.test.ts and round-trip.test.ts) is correct.
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
import { usePreferencesStore } from '../store/preferencesStore'

beforeEach(() => {
  useAppStore.setState(initialAppState)
  useDocumentStore.setState(initialDocumentState)
  usePreferencesStore.setState({ preferences: null, loaded: false })
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

describe('EditorScreen comments', () => {
  it('the toolbar Add Comment button opens the composer row', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    useAppStore.setState({ viewMode: 'format' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    expect(screen.queryByRole('group', { name: 'Add comment' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add comment' }))

    expect(screen.getByRole('group', { name: 'Add comment' })).toBeInTheDocument()
  })

  it('submitting the composer calls editorRef.addComment with the typed text and the preferred author name', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    useAppStore.setState({ viewMode: 'format' })
    usePreferencesStore.setState({
      preferences: {
        spellcheckEnabled: true,
        autosaveIntervalMs: 45_000,
        defaultPageConfig: {
          pageSize: 'Letter',
          orientation: 'portrait',
          theme: 'default',
          fontFamily: 'source-serif-4'
        },
        colorScheme: 'system',
        authorName: 'Kai'
      },
      loaded: true
    })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Add comment' }))
    await user.type(screen.getByRole('textbox', { name: 'Comment text' }), 'needs revision')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(mockEditorHandle.addComment).toHaveBeenCalledWith('Kai', 'needs revision')
    // A successful add closes the composer and clears its own state.
    expect(screen.queryByRole('group', { name: 'Add comment' })).not.toBeInTheDocument()
  })

  it('falls back to "You" when no author name preference is set', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    useAppStore.setState({ viewMode: 'format' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Add comment' }))
    await user.type(screen.getByRole('textbox', { name: 'Comment text' }), 'note')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(mockEditorHandle.addComment).toHaveBeenCalledWith('You', 'note')
  })

  it('shows a real inline error and stays open when the selection is invalid, instead of silently closing', async () => {
    mockEditorHandle.addComment.mockReturnValueOnce(false)
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    useAppStore.setState({ viewMode: 'format' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Add comment' }))
    await user.type(screen.getByRole('textbox', { name: 'Comment text' }), 'note')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(screen.getByRole('group', { name: 'Add comment' })).toBeInTheDocument()
    expect(
      screen.getByText('Select some text within a single paragraph first.')
    ).toBeInTheDocument()
  })

  it('Cancel closes the composer without calling addComment', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    useAppStore.setState({ viewMode: 'format' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Add comment' }))
    await user.type(screen.getByRole('textbox', { name: 'Comment text' }), 'note')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(mockEditorHandle.addComment).not.toHaveBeenCalled()
    expect(screen.queryByRole('group', { name: 'Add comment' })).not.toBeInTheDocument()
  })

  it('the Comments sidebar tab lists a real extracted comment and Resolve calls editorRef.resolveComment', async () => {
    const dataAttr = Buffer.from(
      JSON.stringify({ author: 'Kai', text: 'needs revision', createdAt: '2026-08-09T06:00:00Z' }),
      'utf8'
    ).toString('base64')
    const content = `Some text. <!--comment id="c1" data="${dataAttr}"-->marked span<!--/comment id="c1"-->. More text.`
    useDocumentStore.setState({ filePath: '/tmp/report.md', content })
    useAppStore.setState({ viewMode: 'format' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Comments' }))

    expect(screen.getByText('needs revision')).toBeInTheDocument()
    expect(screen.getByText('"marked span"')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Resolve' }))

    expect(mockEditorHandle.resolveComment).toHaveBeenCalledWith('c1')
  })

  it('Escape closes the composer, matching Cancel', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    useAppStore.setState({ viewMode: 'format' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Add comment' }))
    await user.type(screen.getByRole('textbox', { name: 'Comment text' }), '{Escape}')

    expect(screen.queryByRole('group', { name: 'Add comment' })).not.toBeInTheDocument()
  })
})
