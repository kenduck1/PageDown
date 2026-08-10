import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditorToolbar from './EditorToolbar'
import { useAppStore, initialAppState } from '../store/appStore'
import { useDocumentStore, initialDocumentState } from '../store/documentStore'
import { useFindStore, initialFindState } from '../store/findStore'
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
  }
}

beforeEach(() => {
  useAppStore.setState(initialAppState)
  useDocumentStore.setState(initialDocumentState)
  // NOT `useFindStore.setState(initialFindState, true)` -- see
  // useFindShortcuts.test.ts's own comment on this exact footgun: zustand's
  // `replace: true` wipes the store's action methods (openFind/closeFind/...)
  // off the store, not just its plain values.
  useFindStore.setState(initialFindState)
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
    print: vi.fn().mockResolvedValue({ cancelled: false }),
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
    setWindowState: vi.fn(),
    // The window-close guard's two channels. onWindowCloseRequest must
    // return a real unsubscribe FUNCTION -- App.tsx calls it from an effect
    // cleanup, same contract as onMenuCommand above.
    onWindowCloseRequest: vi.fn().mockReturnValue(() => {}),
    respondToWindowClose: vi.fn(),
    getStartupWarnings: vi.fn().mockResolvedValue([]),
    getAppVersion: vi.fn().mockResolvedValue('1.0.0')
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

  // These two tests REPLACE a pair that mocked `window.prompt` -- i.e. that
  // stubbed out the exact call that was broken, and therefore stayed green
  // for the entire time Insert link did nothing at all. In Electron's
  // renderer `window.prompt()` THROWS ("Error: prompt() is not supported.",
  // measured directly against the real built app: a pageerror fires, no
  // dialog appears, the document is unchanged, and NOTHING surfaces in the UI
  // because this renderer has no global error handler, no ErrorBoundary, and
  // documentStore.error is never touched). jsdom's own `prompt` neither
  // throws nor opens anything, so a jsdom test can never reproduce the crash
  // directly -- what it CAN do, and what these tests do, is assert the real
  // observable contract: the button opens the in-app composer row, and
  // `window.prompt` is never reached at all. Reintroducing any
  // prompt/alert/confirm-based flow fails the spy assertion below
  // deterministically, rather than depending on whether a thrown error
  // happens to fail the test run.
  it('Insert link opens the in-app link composer (and never calls window.prompt, which throws in Electron)', async () => {
    const handle = createFakeEditorHandle()
    const ref = createRef<MilkdownEditorHandle>()
    ref.current = handle
    // Made to throw exactly the way Electron's own implementation does, so
    // this spy is a genuine stand-in for the real environment rather than
    // jsdom's forgiving no-op -- if the implementation regresses to calling
    // it, the call is both recorded AND fatal to the handler, the same as in
    // the shipped app.
    const promptSpy = vi.spyOn(window, 'prompt').mockImplementation(() => {
      throw new Error('prompt() is not supported.')
    })
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: 'Insert link' }))

    expect(promptSpy).not.toHaveBeenCalled()
    expect(useAppStore.getState().linkComposerOpen).toBe(true)
  })

  // The toolbar deliberately does NOT call insertLink itself -- it only opens
  // the composer, which is rendered by EditorScreen and owns the URL the user
  // actually types (see EditorScreen.test.tsx's 'link composer' block for the
  // end-to-end wiring, and LinkComposer.test.tsx for the row's own behavior).
  it('Insert link does not insert anything by itself -- the composer collects the URL first', async () => {
    const handle = createFakeEditorHandle()
    const ref = createRef<MilkdownEditorHandle>()
    ref.current = handle
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

  it('calls the onSetViewMode prop instead of the store action directly, when provided', async () => {
    const handle = createFakeEditorHandle()
    const ref = { current: handle }
    const onSetViewMode = vi.fn()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} onSetViewMode={onSetViewMode} />)

    // Exact string, not /split/i -- the toolbar also has a "Split cell"
    // table-editing button whose accessible name matches that regex, making
    // it ambiguous (getByRole throws on multiple matches). 'Split' exactly
    // matches only the view-mode segmented-control button, same convention
    // already used by the sibling 'view-mode segmented control' test below.
    await user.click(screen.getByRole('button', { name: 'Split' }))

    expect(onSetViewMode).toHaveBeenCalledWith('split')
    // The prop path does NOT also call the store action directly -- the
    // caller (EditorScreen) is responsible for calling setViewMode itself,
    // after its own flush/remount coordination. Asserting this distinguishes
    // "delegated to the prop" from "did both," which would silently double
    // the mode change.
    expect(useAppStore.getState().viewMode).toBe('format')
  })

  // F2 (final whole-branch review): every control bound to
  // editorRef.current?.X() silently no-oped in Source mode (MilkdownEditor
  // is unmounted there, so editorRef.current is null) while still rendering
  // fully enabled -- clicking Bold, a list button, etc. looked like it
  // should do something and did nothing. This pins that the editorRef-bound
  // cluster is disabled whenever viewMode is 'source', and re-enabled the
  // instant it isn't -- and that everything NOT bound to editorRef (a
  // still-unwired placeholder button, in this case) is left alone.
  it('disables exactly the editorRef-bound controls in Source mode, and re-enables them in Format mode', () => {
    const handle = createFakeEditorHandle()
    const ref = { current: handle }
    useAppStore.setState({ viewMode: 'source' })
    const { rerender } = render(<EditorToolbar editorRef={ref} />)

    const editorRefBoundButtonNames = [
      'Undo',
      'Redo',
      'Bold',
      'Italic',
      'Bulleted list',
      'Numbered list',
      'Insert link',
      'Insert table',
      'Insert page break'
    ]
    editorRefBoundButtonNames.forEach((name) => {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    })
    expect(screen.getByRole('combobox', { name: 'Paragraph style' })).toBeDisabled()

    // Controls that do NOT touch editorRef -- an unwired placeholder button,
    // and the view-mode switcher itself -- must stay enabled even in Source
    // mode; only the editorRef-bound cluster is in scope for F2.
    expect(screen.getByRole('button', { name: 'Underline' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Source' })).not.toBeDisabled()

    useAppStore.setState({ viewMode: 'format' })
    rerender(<EditorToolbar editorRef={ref} />)

    editorRefBoundButtonNames.forEach((name) => {
      expect(screen.getByRole('button', { name })).not.toBeDisabled()
    })
    expect(screen.getByRole('combobox', { name: 'Paragraph style' })).not.toBeDisabled()
  })

  // Regression test for a real bug the test above could not catch, because it
  // only ever varied `viewMode`. Split mode's LEFT PANE is Format or Source
  // editing per `splitLeftMode`, so viewMode 'split' + splitLeftMode 'source'
  // is a genuine Source-editing surface with the MilkdownEditor unmounted and
  // `editorRef.current` null -- yet the whole editorRef-bound cluster rendered
  // ENABLED and silently did nothing on click, because the predicate was a
  // bare `viewMode === 'source'`. Fixed by using the shared `isSourceEditing`,
  // which is exactly the "you cannot answer this from viewMode alone"
  // predicate lib/editing-surface.ts already exists to provide.
  it('disables the editorRef-bound controls in Split mode with a Source left pane too', () => {
    const handle = createFakeEditorHandle()
    const ref = { current: handle }
    useAppStore.setState({ viewMode: 'split', splitLeftMode: 'source' })
    const { rerender } = render(<EditorToolbar editorRef={ref} />)

    const editorRefBoundButtonNames = [
      'Undo',
      'Redo',
      'Bold',
      'Italic',
      'Bulleted list',
      'Numbered list',
      'Insert link',
      'Insert table',
      'Insert page break'
    ]
    editorRefBoundButtonNames.forEach((name) => {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    })
    expect(screen.getByRole('combobox', { name: 'Paragraph style' })).toBeDisabled()

    // ...and the SAME Split mode with a Format left pane must leave them
    // enabled -- otherwise this test would also pass against a naive
    // `viewMode === 'split'` check, which would be a different bug.
    useAppStore.setState({ viewMode: 'split', splitLeftMode: 'format' })
    rerender(<EditorToolbar editorRef={ref} />)

    editorRefBoundButtonNames.forEach((name) => {
      expect(screen.getByRole('button', { name })).not.toBeDisabled()
    })
    expect(screen.getByRole('combobox', { name: 'Paragraph style' })).not.toBeDisabled()
  })

  // Task 5 of the Split mode sub-project: a small Format/Source toggle for
  // splitLeftMode, visible only in Split mode. Design-handoff placement
  // check (task-5-brief.md Step 7): PageDown.dc.html DOES show Split-mode
  // chrome for this exact choice, but as a pill pair inside the LEFT PANE's
  // own header bar (a 34px strip above the split editing surface), not in
  // this toolbar -- a different structural location than the file this
  // task names as the modification target (EditorToolbar.tsx) and than
  // EditorScreen's own Split layout (task-5-brief.md Step 5, no per-pane
  // header bar). Building that separate header bar is real scope beyond
  // this task's brief, so per Step 7's own "use judgment, don't block"
  // instruction, this uses the brief's own explicitly-sanctioned fallback
  // instead: a small two-button toggle next to the existing mode-switcher
  // segmented control, styled the same way (rounded-md bg-chrome-dark
  // segmented pill).
  //
  // aria-label overrides ("Split left pane: Format" / "... Source") rather
  // than the plain "Format"/"Source" visible text, on purpose -- the
  // segmented control's OWN Format/Source buttons are simultaneously
  // visible whenever this toggle is (both are only reachable from Split
  // mode, since the toggle's whole precondition is viewMode === 'split').
  // A same-string accessible name would make screen.getByRole('button',
  // { name: 'Format' }) ambiguous (two matches) the instant Split mode is
  // active -- which would have broken the pre-existing 'view-mode segmented
  // control' test above (it clicks 'Split' then immediately queries
  // 'Source' by exact name). Verified this really would collide before
  // choosing distinct labels, not assumed.
  describe('splitLeftMode toggle', () => {
    it('is absent when viewMode is format or source', () => {
      const ref = createRef<MilkdownEditorHandle>()
      useAppStore.setState({ viewMode: 'format' })
      const { rerender } = render(<EditorToolbar editorRef={ref} />)
      expect(
        screen.queryByRole('button', { name: 'Split left pane: Format' })
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Split left pane: Source' })
      ).not.toBeInTheDocument()

      useAppStore.setState({ viewMode: 'source' })
      rerender(<EditorToolbar editorRef={ref} />)
      expect(
        screen.queryByRole('button', { name: 'Split left pane: Format' })
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Split left pane: Source' })
      ).not.toBeInTheDocument()
    })

    it('is present and reflects splitLeftMode when viewMode is split', () => {
      const ref = createRef<MilkdownEditorHandle>()
      useAppStore.setState({ viewMode: 'split', splitLeftMode: 'format' })
      render(<EditorToolbar editorRef={ref} />)

      expect(screen.getByRole('button', { name: 'Split left pane: Format' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      expect(screen.getByRole('button', { name: 'Split left pane: Source' })).toHaveAttribute(
        'aria-pressed',
        'false'
      )
    })

    it('clicking the toggle calls setSplitLeftMode with the clicked mode', async () => {
      const ref = createRef<MilkdownEditorHandle>()
      useAppStore.setState({ viewMode: 'split', splitLeftMode: 'format' })
      const user = userEvent.setup()
      render(<EditorToolbar editorRef={ref} />)

      await user.click(screen.getByRole('button', { name: 'Split left pane: Source' }))

      expect(useAppStore.getState().splitLeftMode).toBe('source')
    })
  })

  it('The page-setup button calls useAppStore.openPageSetup', async () => {
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    expect(useAppStore.getState().pageSetupOpen).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Page setup' }))

    expect(useAppStore.getState().pageSetupOpen).toBe(true)
  })

  it('The keyboard-shortcuts button calls useAppStore.openShortcutsHelp', async () => {
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    expect(useAppStore.getState().shortcutsHelpOpen).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }))

    expect(useAppStore.getState().shortcutsHelpOpen).toBe(true)
  })

  it('Export PDF calls window.api.exportPdf with the current document content', async () => {
    useDocumentStore.setState({ content: '# Real document content', filePath: null })
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: /Export PDF/ }))

    await waitFor(() => {
      expect(window.api.exportPdf).toHaveBeenCalledWith('# Real document content', null, false)
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
      expect(window.api.exportPdf).toHaveBeenCalledWith(
        '# Doc',
        '/Users/someone/notes/report.md',
        false
      )
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

  it('Print calls window.api.print with the current document content and file path', async () => {
    useDocumentStore.setState({
      content: '# Real document content',
      filePath: '/Users/someone/notes/report.md'
    })
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: 'Print' }))

    await waitFor(() => {
      expect(window.api.print).toHaveBeenCalledWith(
        '# Real document content',
        '/Users/someone/notes/report.md',
        false
      )
    })
  })

  it('Print surfaces a failure as a friendly message, not the raw IPC error string', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(window.api.print).mockRejectedValue(
      new Error("Error invoking remote method 'file:print': Error: Print job failed")
    )
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: 'Print' }))

    await waitFor(() => {
      expect(useDocumentStore.getState().error).toBe('Failed to print. Please try again.')
    })
    expect(consoleErrorSpy).toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })

  it('a cancelled print dialog does not surface as an error', async () => {
    // print-exporter.ts resolves { cancelled: true } for a user-cancelled OS
    // print dialog rather than rejecting -- cancelling is the user's own
    // choice, not a failure.
    vi.mocked(window.api.print).mockResolvedValue({ cancelled: true })
    useDocumentStore.setState({ error: null })
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: 'Print' }))

    await waitFor(() => {
      expect(window.api.print).toHaveBeenCalled()
    })
    expect(useDocumentStore.getState().error).toBeNull()
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
    // Find moved OUT of the one-shot group as of the Find & Replace
    // sub-project (Task 8) -- it now genuinely toggles a panel (see its own
    // wiring comment in EditorToolbar.tsx), so it belongs with Bold/Italic/
    // the list buttons above, not with Undo/Insert table.
    expect(screen.getByRole('button', { name: 'Find' })).toHaveAttribute('aria-pressed', 'false')
  })

  // The `selection` prop (bubble menu sub-project) is what finally makes these
  // four buttons' pressed state REAL. They carried a hardcoded
  // `active={false}` from the design handoff until then, which meant the
  // toolbar announced aria-pressed="false" while the cursor sat squarely
  // inside bold text -- worse than saying nothing. Rendering with no prop (as
  // every other test in this file does) still yields false, which is the
  // honest reading of "no live editor to ask".
  it('Bold/Italic and the list buttons report REAL pressed state from the live selection snapshot', () => {
    const ref = createRef<MilkdownEditorHandle>()
    const { rerender } = render(
      <EditorToolbar
        editorRef={ref}
        selection={{
          from: 1,
          to: 5,
          empty: false,
          hasFocus: true,
          nodeSelection: false,
          marks: { bold: true, italic: false, inlineCode: false, link: false },
          headingLevel: null,
          listType: 'ordered_list',
          linkHref: null,
          taskList: false,
          table: null
        }}
      />
    )
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Italic' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Numbered list' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    // The list buttons read the SAME ancestor-list walk the toggle commands
    // branch on (findAncestorListType, selection-plugin.ts), so "pressed" and
    // "what the click does" cannot disagree -- which also means bullet must be
    // false while ordered is true, not merely "some list is active".
    expect(screen.getByRole('button', { name: 'Bulleted list' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )

    rerender(<EditorToolbar editorRef={ref} selection={null} />)
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Numbered list' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })

  // Task 8 of the Find & Replace sub-project: the Find button was previously
  // a design-handoff placeholder with no onClick (see the file's own comment
  // at its call site). It's now a real toggle over findStore's own isOpen.
  describe('Find button', () => {
    it('the Find button opens and closes the find bar', async () => {
      const user = userEvent.setup()
      const ref = createRef<MilkdownEditorHandle>()
      render(<EditorToolbar editorRef={ref} />)

      await user.click(screen.getByLabelText('Find'))
      expect(useFindStore.getState().isOpen).toBe(true)
      await user.click(screen.getByLabelText('Find'))
      expect(useFindStore.getState().isOpen).toBe(false)
    })

    it('the Find button reports its pressed state', async () => {
      const user = userEvent.setup()
      const ref = createRef<MilkdownEditorHandle>()
      render(<EditorToolbar editorRef={ref} />)

      expect(screen.getByLabelText('Find')).toHaveAttribute('aria-pressed', 'false')
      await user.click(screen.getByLabelText('Find'))
      expect(screen.getByLabelText('Find')).toHaveAttribute('aria-pressed', 'true')
    })

    it('the Find button stays enabled in Source mode', () => {
      useAppStore.setState({ viewMode: 'source' })
      const ref = createRef<MilkdownEditorHandle>()
      render(<EditorToolbar editorRef={ref} />)

      expect(screen.getByLabelText('Find')).toBeEnabled()
    })
  })
})
