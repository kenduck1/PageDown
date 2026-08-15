import { forwardRef, useImperativeHandle } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MilkdownEditorHandle } from '../milkdown/MilkdownEditor'
import type { SelectionSnapshot } from '../milkdown/selection-plugin'

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

// Captures EditorScreen's own onSelectionChanged so a test can push a real
// SelectionSnapshot through the same path the selection plugin uses -- jsdom's
// Selection API does not drive ProseMirror at all, and the composer's prefill
// is derived from that snapshot.
const { selectionListener } = vi.hoisted(() => ({
  selectionListener: { current: null as ((s: SelectionSnapshot | null) => void) | null }
}))

vi.mock('../milkdown/MilkdownEditor', () => ({
  default: forwardRef<
    MilkdownEditorHandle,
    { content: string; onSelectionChanged?: (s: SelectionSnapshot | null) => void }
  >(function FakeMilkdownEditor(props, ref) {
    useImperativeHandle(ref, () => mockEditorHandle, [])
    selectionListener.current = props.onSelectionChanged ?? null
    return <div data-testid="fake-milkdown-editor">{props.content}</div>
  })
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
    removeRecentFile: vi.fn(),
    clearRecentFiles: vi.fn(),
    getThumbnail: vi.fn(),
    getTemplateThumbnail: vi.fn(),
    getPageCount: vi.fn().mockResolvedValue({ pageCount: 1 }),
    confirmDiscardChanges: vi.fn(),
    exportPdf: vi.fn(),
    exportHtml: vi.fn(),
    exportDocx: vi.fn(),
    showItemInFolder: vi.fn(),
    print: vi.fn(),
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

  // THIS ASSERTION IS DELIBERATELY INVERTED FROM WHAT IT USED TO CLAIM, and
  // the inversion is the change rather than a casualty of it. It previously
  // read "renders the composer as a layout row above the content area, not as
  // an overlay over it", and pinned the row being a sibling ABOVE
  // `document-content` with no fixed/absolute positioning -- because a
  // WebContentsView (Split mode's live preview) composites above ALL DOM
  // unconditionally, so a floating panel is silently painted over.
  //
  // That threat is real and unchanged; what changed is that it is now SOLVED
  // rather than dodged. SelectionBubble already floats safely by clamping into
  // `intersect(canvasRect, editorPaneRect)`, a rect the editor pane and the
  // native view are disjoint halves of, and lib/floating-position.ts was
  // written generic on purpose so more callers could reuse it. FindBar stays a
  // row (a find bar is conventionally full-width, and being a row is what lets
  // it RESIZE the preview instead of covering it); a URL field belongs at the
  // cursor. See FloatingCard.tsx's header.
  //
  // So the two structural properties worth pinning flipped, and both are
  // pinned here: the popover is `position: fixed`, and it is rendered OUTSIDE
  // `document-content` -- the latter being the one that is easy to regress and
  // impossible to see, since both the single-pane branch and Split's left pane
  // wrap their content in CSS `zoom`, which multiplies a fixed descendant's
  // OFFSETS as well as its size (measured: left:400 top:300 renders at x=240
  // y=180 under `zoom: 0.6`). Nesting it there would mis-anchor it and shrink
  // its hit targets, with nothing failing anywhere.
  it('renders the composer as a fixed popover at the screen root, outside the zoom wrapper', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Insert link' }))

    const popover = screen.getByRole('group', { name: 'Insert link' })
    const contentRow = screen.getByTestId('document-content')
    expect(popover.contains(contentRow)).toBe(false)
    // The load-bearing half: NOT a descendant of the zoom-wrapped canvas.
    expect(contentRow.contains(popover)).toBe(false)
    expect(popover.style.position).toBe('fixed')
    // Placed by real arithmetic rather than parked -- jsdom reports all-zero
    // rects, so this cannot assert a meaningful pixel, but it can assert that
    // a `left`/`top` were written at all (an unpositioned fixed element would
    // leave both empty and land wherever it happened to flow).
    expect(popover.style.left).not.toBe('')
    expect(popover.style.top).not.toBe('')
  })

  // Capability-gap pass: the composer is prefilled from the LIVE selection
  // snapshot's `linkHref`, which is what makes an existing link editable at
  // all. Previously the field opened blank every time, so a user could not
  // even see the URL they were about to (destructively) replace.
  it('prefills the URL field from the selection’s existing link, and offers Remove link', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    // Fire a selection carrying a link, exactly as milkdown/selection-plugin
    // reports one, then open the composer.
    act(() => {
      selectionListener.current?.({
        from: 1,
        to: 5,
        empty: false,
        hasFocus: true,
        nodeSelection: false,
        marks: { bold: false, italic: false, inlineCode: false, link: true },
        linkHref: 'https://old.example.com',
        headingLevel: null,
        listType: null,
        taskList: false,
        table: null
      })
    })
    await user.click(screen.getByRole('button', { name: 'Insert link' }))

    expect(screen.getByRole('textbox', { name: 'Link URL' })).toHaveValue('https://old.example.com')
    await user.click(screen.getByRole('button', { name: 'Remove link' }))
    expect(mockEditorHandle.removeLink).toHaveBeenCalledTimes(1)
  })

  // Product-completeness audit 2.5. The composer is a LAYOUT ROW, which is
  // exactly why it leaves the tab bar live and clickable -- so it was possible
  // to select text in tab A, open Insert link, click tab B, press Insert, and
  // have the link land in tab B, because handleInsertLink dispatches through
  // `editorRef`, which always points at whichever editor is mounted right now.
  describe('a composer belongs to the document it was opened against', () => {
    function seedTwoTabs(): { first: string; second: string } {
      useDocumentStore.setState({
        ...initialDocumentState,
        tabs: [
          {
            id: 'tab-a',
            filePath: '/tmp/a.md',
            content: '# A',
            isDirty: false,
            mtimeMs: null,
            remoteImagesAllowed: null,
            currentPage: 1,
            draftId: null
          },
          {
            id: 'tab-b',
            filePath: '/tmp/b.md',
            content: '# B',
            isDirty: false,
            mtimeMs: null,
            remoteImagesAllowed: null,
            currentPage: 1,
            draftId: null
          }
        ],
        activeTabId: 'tab-a',
        filePath: '/tmp/a.md',
        content: '# A'
      })
      return { first: 'tab-a', second: 'tab-b' }
    }

    it('closes the row when the user switches to another tab', async () => {
      const { second } = seedTwoTabs()
      const user = userEvent.setup()
      render(<EditorScreen />)

      await user.click(screen.getByRole('button', { name: 'Insert link' }))
      expect(screen.getByRole('group', { name: 'Insert link' })).toBeInTheDocument()

      act(() => {
        useDocumentStore.getState().switchTab(second)
      })

      // The selection it was opened over is gone with the document, so the
      // row goes too -- rather than sitting there looking usable and then
      // refusing, or (the shipped bug) applying to the wrong document.
      expect(screen.queryByRole('group', { name: 'Insert link' })).not.toBeInTheDocument()
      expect(mockEditorHandle.insertLink).not.toHaveBeenCalled()
    })

    // The same-tab case a tab-id-only check would miss: openDocumentState
    // REUSES a pristine blank tab's id, so File > Open Recent from an
    // untouched Untitled tab puts a completely different document on screen
    // under the same id. `revision` is what catches it.
    it('closes the row when a different document is loaded into the SAME tab', async () => {
      const user = userEvent.setup()
      render(<EditorScreen />)
      const tabId = useDocumentStore.getState().activeTabId

      await user.click(screen.getByRole('button', { name: 'Insert link' }))
      expect(screen.getByRole('group', { name: 'Insert link' })).toBeInTheDocument()

      act(() => {
        useDocumentStore.getState().loadDocument('/tmp/other.md', '# Other')
      })

      expect(useDocumentStore.getState().activeTabId).toBe(tabId)
      expect(screen.queryByRole('group', { name: 'Insert link' })).not.toBeInTheDocument()
    })

    // The submit-time guard, on its own. The close above is the reachable
    // path, so this constructs the state it protects against DELIBERATELY:
    // activeTabId is moved without bumping `revision`, which is the one thing
    // the close effect keys on. That is artificial by design -- the point is
    // that the guard does not depend on the close having run, so a future
    // restructuring of the rows cannot silently reopen a write to the wrong
    // document.
    it('refuses to insert into a document it was not opened against', async () => {
      const { second } = seedTwoTabs()
      const user = userEvent.setup()
      render(<EditorScreen />)

      await user.click(screen.getByRole('button', { name: 'Insert link' }))
      await user.type(screen.getByRole('textbox', { name: 'Link URL' }), 'https://example.com')

      act(() => {
        useDocumentStore.setState({ activeTabId: second, filePath: '/tmp/b.md', content: '# B' })
      })

      await user.click(screen.getByRole('button', { name: 'Insert' }))

      // Nothing reached the editor -- and the row is gone rather than left
      // open pretending it will work next time.
      expect(mockEditorHandle.insertLink).not.toHaveBeenCalled()
      expect(screen.queryByRole('group', { name: 'Insert link' })).not.toBeInTheDocument()
    })

    it('refuses Remove link into a document it was not opened against', async () => {
      const { second } = seedTwoTabs()
      const user = userEvent.setup()
      render(<EditorScreen />)

      act(() => {
        selectionListener.current?.({
          from: 1,
          to: 5,
          empty: false,
          hasFocus: true,
          nodeSelection: false,
          marks: { bold: false, italic: false, inlineCode: false, link: true },
          linkHref: 'https://old.example.com',
          headingLevel: null,
          listType: null,
          taskList: false,
          table: null
        })
      })
      await user.click(screen.getByRole('button', { name: 'Insert link' }))

      act(() => {
        useDocumentStore.setState({ activeTabId: second, filePath: '/tmp/b.md', content: '# B' })
      })

      await user.click(screen.getByRole('button', { name: 'Remove link' }))

      expect(mockEditorHandle.removeLink).not.toHaveBeenCalled()
    })

    // The other half of the audit's 2.5 note ("the prefill is stale too"): a
    // selection snapshot outlives the editor that produced it, so without
    // scoping it to the mounted instance the row could open with the PREVIOUS
    // document's URL already typed into it.
    it('does not prefill from a selection reported by a previous editor instance', async () => {
      const { second } = seedTwoTabs()
      const user = userEvent.setup()
      render(<EditorScreen />)

      act(() => {
        selectionListener.current?.({
          from: 1,
          to: 5,
          empty: false,
          hasFocus: true,
          nodeSelection: false,
          marks: { bold: false, italic: false, inlineCode: false, link: true },
          linkHref: 'https://tab-a-only.example.com',
          headingLevel: null,
          listType: null,
          taskList: false,
          table: null
        })
      })
      act(() => {
        useDocumentStore.getState().switchTab(second)
      })

      await user.click(screen.getByRole('button', { name: 'Insert link' }))

      expect(screen.getByRole('textbox', { name: 'Link URL' })).toHaveValue('')
      // ...and with no link on the (fresh) selection there is nothing to
      // remove, so that button is correctly absent too.
      expect(screen.queryByRole('button', { name: 'Remove link' })).not.toBeInTheDocument()
    })
  })
})
