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
    getSelectedText: vi.fn(() => '')
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
    autosaveSnapshot: vi.fn(),
    getVersionHistory: vi.fn(),
    restoreVersionContent: vi.fn(),
    clearPendingAutosave: vi.fn(),
    setSplitPreviewBounds: vi.fn(),
    sendSplitPreviewDocument: vi.fn(),
    destroySplitPreview: vi.fn(),
    scrollSplitPreviewToPage: vi.fn(),
    getSplitPreviewPage: vi.fn()
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
