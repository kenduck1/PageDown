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
    removeRecentFile: vi.fn(),
    clearRecentFiles: vi.fn(),
    getThumbnail: vi.fn(),
    getTemplateThumbnail: vi.fn(),
    getPageCount: vi.fn(),
    confirmDiscardChanges: vi.fn(),
    exportPdf: vi.fn().mockResolvedValue({ filePath: '/tmp/document.pdf' }),
    exportHtml: vi.fn(),
    // Defaults to a successful reveal -- handleShowExportInFolder now awaits
    // this call's own resolved boolean (second-pass product-completeness
    // audit: a moved/deleted export must surface a real failure, see that
    // handler's own comment), so a bare `vi.fn()` with no resolved value
    // would make `.then()` throw on `undefined` the moment any test clicks
    // "Show in Folder." Tests covering the failure path override this
    // per-test with `.mockResolvedValue(false)`.
    showItemInFolder: vi.fn().mockResolvedValue(true),
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

describe('EditorToolbar', () => {
  // jsdom has no layout engine -- every width here is 0 -- so it structurally
  // cannot verify either of the two properties that actually matter: that the
  // formatting controls are REACHABLE, and that the toolbar is ONE ROW.
  // phase0/gate33-toolbar-reachability.spec.ts proves both in the real app.
  // What this test can do is pin the two declarations the single-row layout
  // rests on, both of which read as incidental styling and are not.
  //
  // `flex-wrap` was here briefly (it fixed reachability by dropping the
  // right-hand cluster onto a second line) and is now forbidden: it cost 36px
  // of permanent vertical chrome at the shipped default. `basis-[content]`
  // went with it -- it existed only to make flex line-breaking see this
  // region's full natural width, which is what made the wrap fire at all.
  // With `flex-1` (basis 0%) the region simply absorbs whatever the flex-none
  // cluster leaves, and `min-w-0` is what lets it shrink far enough for
  // `overflow-x-auto` to engage at the app's 760px minimum instead of pushing
  // its own tail past the window edge.
  it('lays the toolbar out as a single non-wrapping row with a shrinkable formatting region', () => {
    const ref = createRef<MilkdownEditorHandle>()
    render(<EditorToolbar editorRef={ref} />)

    const toolbar = screen.getByRole('toolbar', { name: 'Formatting toolbar' })
    expect(toolbar.className).not.toContain('flex-wrap')

    const formattingRegion = toolbar.firstElementChild as HTMLElement
    expect(formattingRegion.className).not.toContain('basis-[content]')
    expect(formattingRegion.className).toContain('flex-1')
    expect(formattingRegion.className).toContain('min-w-0')
  })

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

    // Exact string, not /split/i -- this toolbar used to also carry a "Split
    // cell" table-editing button whose accessible name matched that regex,
    // which would have made a case-insensitive lookup ambiguous (getByRole
    // throws on multiple matches). That button is gone now (GFM pipe tables
    // can't express merged cells, so "split cell" never meant anything --
    // see the 'EditorToolbar formerly-dead controls' describe block below),
    // so 'Split' exactly only ever had one match here, but the exact string
    // still costs nothing and stays correct if a future control ever
    // reintroduces an ambiguous name. Same convention already used by the
    // sibling 'view-mode segmented control' test above.
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
  // instant it isn't -- and that everything NOT bound to editorRef (Find,
  // which works on both editing surfaces, and the view-mode switcher itself)
  // is left alone. See the inline comment further down for why this used to
  // assert on Underline instead -- a genuinely-unwired placeholder control
  // at the time this test was written, since removed.
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
      'Insert image',
      'Insert table',
      'Insert page break',
      'Checklist'
    ]
    editorRefBoundButtonNames.forEach((name) => {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    })
    expect(screen.getByRole('combobox', { name: 'Paragraph style' })).toBeDisabled()

    // Controls that do NOT touch editorRef -- Find (which works on BOTH
    // editing surfaces) and the view-mode switcher itself -- must stay enabled
    // even in Source mode; only the editorRef-bound cluster is in scope.
    //
    // This used to assert on 'Underline', as an example of "a still-unwired
    // placeholder button." Underline was REMOVED in the capability-gap pass
    // (Markdown cannot express it and the sanitize schema strips the only HTML
    // that could -- see EditorToolbar.tsx's own block comment), so the example
    // is now a genuinely-wired control that is genuinely surface-independent,
    // which is a better thing for this assertion to be pinning anyway.
    expect(screen.getByRole('button', { name: 'Find' })).not.toBeDisabled()
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
      'Insert image',
      'Insert table',
      'Insert page break',
      'Checklist'
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

  // THE SINGLE-ROW INVARIANT, expressed as the only thing jsdom can actually
  // check about it. jsdom has no layout engine (every width is 0), so the real
  // "is this one row at 1000px" proof lives in phase0/gate33 -- but the CAUSE
  // of the two-row toolbar is checkable here, and it is the one that would
  // come back by accident: a control being re-added to the right-hand cluster.
  //
  // Six controls left this toolbar so it could fit on one line. Each is listed
  // with where it lives now, because that is the rule for removing one at all
  // (EditorToolbar.tsx's header): a control whose only home is this toolbar
  // must stay. If any of these reappears here, the toolbar wraps again at the
  // shipped default window size and the user gets 36px of permanent vertical
  // chrome back.
  describe('controls that moved off the toolbar (single-row invariant)', () => {
    const RELOCATED = [
      // 208px. PageSetupModal's Typography section -- and they were never
      // selection formatting: both write PageConfig fields into the
      // document's own frontmatter.
      { role: 'combobox' as const, name: 'Font family' },
      { role: 'combobox' as const, name: 'Font size' },
      // 132px. File > Print… (Cmd+P), File > Export as HTML… (Cmd+Alt+E),
      // Help > Keyboard Shortcuts (Cmd+/).
      { role: 'button' as const, name: 'Print' },
      { role: 'button' as const, name: 'Export as HTML' },
      { role: 'button' as const, name: 'Keyboard shortcuts' }
    ]

    it.each(RELOCATED)('$name is not rendered in the toolbar', ({ role, name }) => {
      const ref = createRef<MilkdownEditorHandle>()
      useAppStore.setState({ viewMode: 'format' })
      render(<EditorToolbar editorRef={ref} />)
      expect(screen.queryByRole(role, { name })).not.toBeInTheDocument()
    })

    // 218px, and the pair that mattered most: they rendered ONLY in Split
    // mode, i.e. they loaded their whole cost onto the mode with the least
    // room. Checked in Split specifically -- checking in Format would pass
    // even against the old code, which is exactly the vacuous-assertion trap
    // this suite avoids elsewhere.
    it('the split-left-pane pills and the Follow pill are gone from Split mode too', () => {
      const ref = createRef<MilkdownEditorHandle>()
      useAppStore.setState({ viewMode: 'split', splitLeftMode: 'format' })
      render(<EditorToolbar editorRef={ref} />)

      expect(
        screen.queryByRole('button', { name: 'Split left pane: Format' })
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Split left pane: Source' })
      ).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Follow' })).not.toBeInTheDocument()
    })

    // The right-hand cluster is now MODE-INDEPENDENT, which is the structural
    // reason Format and Split measure identically in gate33. Asserted on the
    // rendered control set rather than on a width, since jsdom has no widths.
    it('renders the same right-hand cluster controls in Format and in Split', () => {
      const ref = createRef<MilkdownEditorHandle>()
      const clusterNames = (): string[] => {
        const toolbar = screen.getByRole('toolbar', { name: 'Formatting toolbar' })
        const cluster = toolbar.lastElementChild as HTMLElement
        return Array.from(cluster.querySelectorAll('button')).map(
          (button) => button.getAttribute('aria-label') ?? (button.textContent || '')
        )
      }

      useAppStore.setState({ viewMode: 'format' })
      const { rerender } = render(<EditorToolbar editorRef={ref} />)
      const inFormat = clusterNames()

      useAppStore.setState({ viewMode: 'split', splitLeftMode: 'format' })
      rerender(<EditorToolbar editorRef={ref} />)

      expect(clusterNames()).toEqual(inFormat)
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

  // The keyboard-shortcuts BUTTON test that used to sit here is gone with the
  // button (single-row toolbar). Its replacement is not a weaker version of
  // itself: `app:shortcuts` is dispatched by Help > Keyboard Shortcuts, which
  // app-menu-template.test.ts covers, and App.tsx owns both the modal and that
  // command's handler -- so the same openShortcutsHelp path is still asserted,
  // from the surface that now triggers it.

  it('Export PDF calls window.api.exportPdf with the current document content', async () => {
    useDocumentStore.setState({ content: '# Real document content', filePath: null })
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: 'Export as PDF' }))

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

    await user.click(screen.getByRole('button', { name: 'Export as PDF' }))

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

    await user.click(screen.getByRole('button', { name: 'Export as PDF' }))

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

    await user.click(screen.getByRole('button', { name: 'Export as PDF' }))

    await waitFor(() => {
      expect(window.api.exportPdf).toHaveBeenCalled()
    })
    expect(useDocumentStore.getState().error).toBe(
      'Unrelated pre-existing error from a failed Save'
    )
  })

  // HTML export and Print lost their toolbar buttons in the single-row pass
  // and are now driven only from the File menu (Cmd+Alt+E / Cmd+P), whose
  // handlers in EditorScreen call these exact store actions. The four tests
  // below therefore invoke the action rather than clicking a button -- the
  // code under test (documentStore.exportHtml / .print, and the Toast this
  // component renders from the store's exportNotice) is unchanged, only the
  // trigger moved. EditorScreen.menu.test.tsx separately proves the menu
  // command reaches these actions at all.
  it('exportHtml calls window.api.exportHtml with content/path/consent, matching Export PDF', async () => {
    useDocumentStore.setState({
      content: '# Real document content',
      filePath: '/Users/someone/notes/report.md'
    })
    const ref = createRef<MilkdownEditorHandle>()
    render(<EditorToolbar editorRef={ref} />)

    await useDocumentStore.getState().exportHtml()

    await waitFor(() => {
      expect(window.api.exportHtml).toHaveBeenCalledWith(
        '# Real document content',
        '/Users/someone/notes/report.md',
        false
      )
    })
  })

  // Product-completeness audit 2.3: "Export gives no feedback." A successful
  // export (either format) now shows a real Toast naming the written file,
  // with a real "Show in Folder" action -- previously the button just
  // stopped saying "Exporting..." with no further signal at all.
  it('shows a Toast naming the exported file after a successful PDF export', async () => {
    vi.mocked(window.api.exportPdf).mockResolvedValue({ filePath: '/tmp/reports/q3.pdf' })
    useDocumentStore.setState({ content: '# Doc' })
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: 'Export as PDF' }))

    const toast = await screen.findByRole('status')
    expect(toast).toHaveTextContent('Exported PDF: q3.pdf')
    expect(screen.getByRole('button', { name: 'Show in Folder' })).toBeInTheDocument()
  })

  it('clicking "Show in Folder" reveals the real exported path and dismisses the toast', async () => {
    vi.mocked(window.api.exportHtml).mockResolvedValue({ filePath: '/tmp/report.html' })
    useDocumentStore.setState({ content: '# Doc' })
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await useDocumentStore.getState().exportHtml()
    await screen.findByRole('status')

    await user.click(screen.getByRole('button', { name: 'Show in Folder' }))

    expect(window.api.showItemInFolder).toHaveBeenCalledWith('/tmp/report.html')
    // The toast has nothing left to offer once its one action was taken --
    // see Toast.tsx/EditorToolbar's handleShowExportInFolder.
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  // Second-pass product-completeness audit Tier 3: a moved/deleted export
  // used to dismiss the toast and reveal nothing, with ZERO feedback --
  // shell.showItemInFolder is a silent no-op on a vanished path. The
  // main-process handler now resolves `false` for that case (existence
  // checked via `stat` before revealing); this proves the renderer surfaces
  // that failure through the real error banner rather than swallowing it.
  it('clicking "Show in Folder" surfaces a real error when the export no longer exists on disk', async () => {
    vi.mocked(window.api.exportHtml).mockResolvedValue({ filePath: '/tmp/report.html' })
    vi.mocked(window.api.showItemInFolder).mockResolvedValue(false)
    useDocumentStore.setState({ content: '# Doc' })
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await useDocumentStore.getState().exportHtml()
    await screen.findByRole('status')

    await user.click(screen.getByRole('button', { name: 'Show in Folder' }))

    expect(window.api.showItemInFolder).toHaveBeenCalledWith('/tmp/report.html')
    // The toast is dismissed regardless (its one action was taken either
    // way -- see handleShowExportInFolder's own comment)...
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    // ...but the failure is now visible somewhere: documentStore's `error`,
    // the same field EditorScreen's real error banner renders.
    await waitFor(() => {
      expect(useDocumentStore.getState().error).toBe(
        'Could not locate the exported file. It may have been moved or deleted.'
      )
    })
  })

  it('a cancelled Export PDF Save dialog shows no toast (the user chose to cancel, not a completed export)', async () => {
    vi.mocked(window.api.exportPdf).mockResolvedValue(null)
    useDocumentStore.setState({ content: '# Doc' })
    const ref = createRef<MilkdownEditorHandle>()
    const user = userEvent.setup()
    render(<EditorToolbar editorRef={ref} />)

    await user.click(screen.getByRole('button', { name: 'Export as PDF' }))

    await waitFor(() => {
      expect(window.api.exportPdf).toHaveBeenCalled()
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('print calls window.api.print with the current document content and file path', async () => {
    useDocumentStore.setState({
      content: '# Real document content',
      filePath: '/Users/someone/notes/report.md'
    })
    const ref = createRef<MilkdownEditorHandle>()
    render(<EditorToolbar editorRef={ref} />)

    await useDocumentStore.getState().print()

    await waitFor(() => {
      expect(window.api.print).toHaveBeenCalledWith(
        '# Real document content',
        '/Users/someone/notes/report.md',
        false
      )
    })
  })

  it('print surfaces a failure as a friendly message, not the raw IPC error string', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(window.api.print).mockRejectedValue(
      new Error("Error invoking remote method 'file:print': Error: Print job failed")
    )
    const ref = createRef<MilkdownEditorHandle>()
    render(<EditorToolbar editorRef={ref} />)

    await useDocumentStore.getState().print()

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
    render(<EditorToolbar editorRef={ref} />)

    await useDocumentStore.getState().print()

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

  // The capability-gap pass, part C: six controls in this toolbar rendered at
  // full opacity, took hover styling and keyboard focus, and did nothing at all
  // when clicked. Three are now wired; three were removed because Markdown
  // genuinely cannot express them (see EditorToolbar.tsx's own block comments).
  describe('EditorToolbar formerly-dead controls', () => {
    it('has no Underline, Text color or Split cell button any more', () => {
      // Removing a control is better than shipping a dead one: a button that
      // acknowledges a click and does nothing reads as BROKEN, not as unbuilt.
      // Underline and text colour have no Markdown syntax and the pipeline's
      // sanitize schema strips the only HTML that could carry them; split cell
      // only means anything against merged cells, which GFM pipe tables cannot
      // express at all.
      const ref = createRef<MilkdownEditorHandle>()
      render(<EditorToolbar editorRef={ref} />)
      expect(screen.queryByRole('button', { name: 'Underline' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Text color' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Split cell' })).toBeNull()
    })

    it('Checklist dispatches toggleTaskList', async () => {
      const user = userEvent.setup()
      const handle = createFakeEditorHandle()
      const ref = { current: handle }
      render(<EditorToolbar editorRef={ref} />)

      await user.click(screen.getByRole('button', { name: 'Checklist' }))
      expect(handle.toggleTaskList).toHaveBeenCalledTimes(1)
    })

    it('Checklist reports its pressed state from taskList, not from bullet-list membership', () => {
      const ref = createRef<MilkdownEditorHandle>()
      const base = {
        from: 1,
        to: 1,
        empty: true,
        hasFocus: true,
        nodeSelection: false,
        marks: { bold: false, italic: false, inlineCode: false, link: false },
        linkHref: null,
        headingLevel: null,
        table: null
      }
      // A plain bullet: Bulleted list pressed, Checklist NOT -- the distinction
      // that makes `taskList` a separate snapshot field at all, since every task
      // item is also a bullet_list item.
      const { rerender } = render(
        <EditorToolbar
          editorRef={ref}
          selection={{ ...base, listType: 'bullet_list', taskList: false }}
        />
      )
      expect(screen.getByRole('button', { name: 'Checklist' })).toHaveAttribute(
        'aria-pressed',
        'false'
      )
      expect(screen.getByRole('button', { name: 'Bulleted list' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )

      rerender(
        <EditorToolbar
          editorRef={ref}
          selection={{ ...base, listType: 'bullet_list', taskList: true }}
        />
      )
      expect(screen.getByRole('button', { name: 'Checklist' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    })

    it('Insert image opens a real file input and forwards the picked files', async () => {
      const handle = createFakeEditorHandle()
      const ref = { current: handle }
      const { container } = render(<EditorToolbar editorRef={ref} />)

      const input = container.querySelector('input[type="file"]') as HTMLInputElement
      expect(input).not.toBeNull()
      // A real OS picker cannot be driven from jsdom, so the click-through is
      // asserted structurally (the button calls .click() on this input) and the
      // forwarding is asserted by firing the input's own change event with real
      // File objects -- which is exactly what Chromium delivers after a pick.
      const clickSpy = vi.spyOn(input, 'click')
      await userEvent.click(screen.getByRole('button', { name: 'Insert image' }))
      expect(clickSpy).toHaveBeenCalledTimes(1)

      const file = new File(['x'], 'photo.png', { type: 'image/png' })
      await userEvent.upload(input, file)
      expect(handle.insertImages).toHaveBeenCalledTimes(1)
      expect(
        (handle.insertImages as unknown as { mock: { calls: File[][][] } }).mock.calls[0][0][0].name
      ).toBe('photo.png')
      // Cleared so picking the SAME file twice still fires a change event.
      expect(input.value).toBe('')
    })

    // The three Font size tests that used to close this block moved WITH the
    // control, into PageSetupModal.test.tsx's Typography describe -- including
    // the one that matters most (a document declaring `fontSize: 12` shows 12,
    // which the original hardcoded-`defaultValue="11"` control could never
    // have passed). Nothing is dropped; see EditorToolbar.tsx's header for why
    // a document-wide PageConfig field does not belong on a
    // selection-formatting toolbar in the first place.
  })
})
