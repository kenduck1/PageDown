import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditorScreen from './EditorScreen'
import { useAppStore, initialAppState } from '../store/appStore'
import { useDocumentStore, initialDocumentState } from '../store/documentStore'

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
    getPageCount: vi.fn().mockResolvedValue({ pageCount: 1 }),
    confirmDiscardChanges: vi.fn(),
    exportPdf: vi.fn(),
    autosaveSnapshot: vi.fn(),
    getVersionHistory: vi.fn(),
    restoreVersionContent: vi.fn(),
    clearPendingAutosave: vi.fn(),
    setSplitPreviewBounds: vi.fn(),
    // Resolved (not a bare vi.fn()) as of Task 5, which wires SplitPreview
    // into EditorScreen for real -- SplitPreview.tsx's own effects call
    // .then()/.catch() on this unconditionally, which throws synchronously
    // (Cannot read properties of undefined) against a bare mock the moment
    // any Split mode test actually mounts it.
    sendSplitPreviewDocument: vi.fn().mockResolvedValue({ pageCount: 1 }),
    destroySplitPreview: vi.fn()
  }
})

afterEach(() => {
  cleanup()
})

describe('EditorScreen', () => {
  it('shows "Untitled" for a new, unsaved document', () => {
    render(<EditorScreen />)
    // Two elements now legitimately show "Untitled" for an unsaved document
    // -- the title bar's filename readout AND the tab bar's active-tab
    // label (EditorTabBar) -- both fall back to the same "Untitled" label
    // independently, per each component's own design-handoff spec.
    expect(screen.getAllByText('Untitled').length).toBeGreaterThan(0)
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

  // The autosave TIMER's wiring into the app had no coverage at all before
  // the final whole-branch review: mutation-verified that deleting the
  // `useAutosave({ content, filePath, isDirty })` call and its import from
  // EditorScreen.tsx left all 469 tests passing with clean typecheck and
  // lint -- the one line that makes autosave exist could be removed with a
  // fully green suite. useAutosave.test.ts covers the hook in isolation; these
  // two cover that the real screen actually calls it, with the real store's
  // real fields. Also closes the design doc's own Testing-section ask for
  // proof that "autosave actually fires on the configured interval while
  // dirty and stops firing once clean," which the plan silently dropped.
  //
  // Fake timers are scoped to each test (not the file-level beforeEach) so
  // every other test here keeps its real-timer behavior -- several of them
  // depend on Milkdown's real 200ms debounce and on userEvent's own timing.
  it('fires an autosave snapshot after 45s while the document is dirty (real useAutosave wiring)', async () => {
    vi.useFakeTimers()
    try {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report', isDirty: true })
      render(<EditorScreen />)

      // Nothing yet -- proves the assertion below is about the interval
      // firing, not about a call made eagerly at mount.
      expect(window.api.autosaveSnapshot).not.toHaveBeenCalled()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(44_000)
      })
      expect(window.api.autosaveSnapshot).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(window.api.autosaveSnapshot).toHaveBeenCalledWith('# Report', '/tmp/report.md')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT fire an autosave snapshot while the document is clean', async () => {
    vi.useFakeTimers()
    try {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report', isDirty: false })
      render(<EditorScreen />)

      // Two full intervals' worth -- a free-running or isDirty-blind timer
      // would have fired twice by now.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000)
      })
      expect(window.api.autosaveSnapshot).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the error when "Dismiss" is clicked', async () => {
    useDocumentStore.setState({ error: 'File not found' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(useDocumentStore.getState().error).toBeNull()
    expect(screen.queryByText('File not found')).not.toBeInTheDocument()
  })

  it('prompts before navigating Home when the document is dirty, and stays if cancelled', async () => {
    // Real navigation state, not just "EditorScreen happens to be rendered
    // in a test" -- App.tsx only ever mounts EditorScreen while
    // screen === 'editor', so that's the realistic precondition for
    // "Home was clicked while viewing the editor."
    useAppStore.setState({ screen: 'editor' })
    useDocumentStore.setState({ content: '# Report', isDirty: true })
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('cancel')
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: '← Home' }))

    expect(window.api.confirmDiscardChanges).toHaveBeenCalled()
    expect(useAppStore.getState().screen).toBe('editor')
  })

  it('navigates Home without prompting when the document is not dirty', async () => {
    useAppStore.setState({ screen: 'editor' })
    useDocumentStore.setState({ content: '# Report', isDirty: false })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: '← Home' }))

    expect(window.api.confirmDiscardChanges).not.toHaveBeenCalled()
    expect(useAppStore.getState().screen).toBe('home')
  })

  it('discards and navigates Home when the user chooses "Don\'t Save"', async () => {
    useAppStore.setState({ screen: 'editor' })
    useDocumentStore.setState({ content: '# Report', isDirty: true })
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('discard')
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: '← Home' }))

    await waitFor(() => expect(useAppStore.getState().screen).toBe('home'))
  })

  it('clears pending autosave for the document when the user chooses "Don\'t Save", passing ONLY the file path', async () => {
    // "Don't Save" means exactly that -- a pending autosave snapshot must
    // never silently reappear on next open. Regression test for a real,
    // shipped Critical bug (caught in review): an earlier version called
    // this with a SECOND argument, `new Date().toISOString()`, as a
    // renderer-supplied cutoff -- but every snapshot that already exists
    // was written in the past relative to "now," so that cutoff matched
    // nothing and clearPendingAutosave silently deleted zero snapshots
    // every single time it ran. The fix removes the second argument
    // entirely: the main-process handler now computes the correct cutoff
    // itself from the validated path's real on-disk mtime (see
    // src/main/index.ts's own file:clearPendingAutosave handler and its
    // main-process-level test in src/main/version-history.test.ts for the
    // end-to-end semantics this unit test can't reach). This test's job is
    // narrower but still load-bearing: assert the renderer call site never
    // regresses back to passing a second argument the main process would
    // silently ignore (window.api's real signature no longer accepts one).
    useAppStore.setState({ screen: 'editor' })
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report', isDirty: true })
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('discard')
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: '← Home' }))

    await waitFor(() => {
      expect(window.api.clearPendingAutosave).toHaveBeenCalledWith('/tmp/report.md')
    })
    expect(window.api.clearPendingAutosave).toHaveBeenCalledTimes(1)
    expect(vi.mocked(window.api.clearPendingAutosave).mock.calls[0]).toHaveLength(1)
  })

  it('closes the discarded tab on "Don\'t Save", so its content cannot resurrect as a later autosave', async () => {
    // Regression test for the final whole-branch review's Important 3.
    // handleGoHome's discard branch cleared the on-disk snapshots but left
    // the tab itself in documentStore -- goHome() only sets screen: 'home'.
    // The discarded tab survived with isDirty: true and the discarded
    // content still in it, so returning to the editor later and clicking
    // that tab restored isDirty: true, useAutosave saw a clean->dirty
    // transition, and 45s later wrote the DISCARDED content back out as a
    // snapshot -- which the next open silently "recovers." Exactly the
    // reappearance this feature exists to prevent.
    //
    // Two tabs, not one, so the assertion is about the discarded tab being
    // GONE rather than about closeTab's replace-the-last-tab behavior (that
    // case gets its own test below).
    const discarded = {
      id: 'tab-discarded',
      filePath: '/tmp/report.md',
      content: '# Discarded edit',
      isDirty: true
    }
    const other = {
      id: 'tab-other',
      filePath: '/tmp/other.md',
      content: '# Other document',
      isDirty: false
    }
    useAppStore.setState({ screen: 'editor' })
    useDocumentStore.setState({
      tabs: [discarded, other],
      activeTabId: discarded.id,
      filePath: discarded.filePath,
      content: discarded.content,
      isDirty: true
    })
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('discard')
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: '← Home' }))

    await waitFor(() => expect(useAppStore.getState().screen).toBe('home'))
    // The snapshot clear must still have happened -- closing the tab is an
    // ADDITION to that half of "Don't Save", not a replacement for it.
    expect(window.api.clearPendingAutosave).toHaveBeenCalledWith('/tmp/report.md')

    // Let any late unmount flush() from the outgoing MilkdownEditor land
    // before asserting -- that path is precisely how the discarded content
    // used to get re-pushed into the store on the way out.
    await new Promise((resolve) => setTimeout(resolve, 250))

    const state = useDocumentStore.getState()
    expect(state.tabs.find((tab) => tab.id === discarded.id)).toBeUndefined()
    // Not just the id: the discarded CONTENT must be unreachable from any
    // tab, which is what actually makes a later autosave impossible.
    expect(state.tabs.some((tab) => tab.content.includes('Discarded edit'))).toBe(false)
    expect(state.content).not.toContain('Discarded edit')
    // The untouched sibling tab survives and becomes the active one.
    expect(state.tabs.map((tab) => tab.id)).toEqual([other.id])
    expect(state.activeTabId).toBe(other.id)
  })

  it('replaces the last tab with a fresh blank one when the discarded tab is the only tab', async () => {
    // closeTab never leaves zero tabs (see documentStore.closeTab) -- this
    // locks in that the discard path inherits that behavior rather than
    // leaving the app with no editing surface.
    useAppStore.setState({ screen: 'editor' })
    useDocumentStore.setState((state) => ({
      filePath: '/tmp/report.md',
      content: '# Discarded edit',
      isDirty: true,
      tabs: state.tabs.map((tab) =>
        tab.id === state.activeTabId
          ? { ...tab, filePath: '/tmp/report.md', content: '# Discarded edit', isDirty: true }
          : tab
      )
    }))
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('discard')
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: '← Home' }))

    await waitFor(() => expect(useAppStore.getState().screen).toBe('home'))
    await new Promise((resolve) => setTimeout(resolve, 250))

    const state = useDocumentStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]).toMatchObject({ filePath: null, content: '', isDirty: false })
    expect(state.activeTabId).toBe(state.tabs[0].id)
    expect(state.content).toBe('')
    expect(state.isDirty).toBe(false)
  })

  it('does NOT clear pending autosave when the user chooses to Save (not discard)', async () => {
    useAppStore.setState({ screen: 'editor' })
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report', isDirty: true })
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('save')
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/tmp/report.md' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: '← Home' }))

    await waitFor(() => {
      expect(useAppStore.getState().screen).toBe('home')
    })
    expect(window.api.clearPendingAutosave).not.toHaveBeenCalled()
  })

  it('does not navigate Home if Save was chosen but the user cancelled the Save-As dialog', async () => {
    // Real navigation state, matching the sibling dirty-check tests above --
    // without this, useAppStore's initial screen ('home') would make the
    // "stayed on editor" assertion below pass trivially even if the fix
    // were wrong, since it was never 'editor' to begin with.
    useAppStore.setState({ screen: 'editor' })
    useDocumentStore.setState({ filePath: null, content: '# New Doc', isDirty: true })
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('save')
    vi.mocked(window.api.saveFile).mockResolvedValue(null) // user cancelled Save-As
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: '← Home' }))

    await waitFor(() => {
      expect(window.api.saveFile).toHaveBeenCalled()
    })
    expect(useAppStore.getState().screen).toBe('editor')
    expect(useDocumentStore.getState().isDirty).toBe(true)
  })

  it('navigates Home after a successful Save from the discard-confirmation dialog', async () => {
    // Same reasoning as above: without an explicit non-'home' starting
    // screen, "ends up on home" would be trivially true from
    // initialAppState alone, proving nothing about navigation actually
    // happening.
    useAppStore.setState({ screen: 'editor' })
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report', isDirty: true })
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('save')
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/tmp/report.md' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: '← Home' }))

    await waitFor(() => {
      expect(useAppStore.getState().screen).toBe('home')
    })
  })

  it('restoring a version flushes and saves dirty edits first, then replaces content, when the pre-restore save succeeds', async () => {
    // Sets the `tabs` array entry, not just the top-level mirror fields --
    // handleRestoreVersion's post-save guard reads the ACTUAL tab entry
    // (by id), not the mirror, so a fixture that only fakes the mirror
    // while leaving the real tab entry at its stale initial values (e.g.
    // isDirty: false) would silently desync from what a real dirty-edit
    // action would have produced.
    useDocumentStore.setState((state) => ({
      filePath: '/tmp/report.md',
      content: '# Unsaved edits',
      isDirty: true,
      tabs: state.tabs.map((tab) =>
        tab.id === state.activeTabId
          ? { ...tab, filePath: '/tmp/report.md', content: '# Unsaved edits', isDirty: true }
          : tab
      )
    }))
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/tmp/report.md' })
    vi.mocked(window.api.getVersionHistory).mockResolvedValue([
      { id: 'snap-1', timestamp: '2026-08-05T12:00:00.000Z', sizeBytes: 10 }
    ])
    vi.mocked(window.api.restoreVersionContent).mockResolvedValue('# Restored Report')
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'History' }))
    const restoreButton = await screen.findByRole('button', { name: /restore/i })
    await user.click(restoreButton)

    await waitFor(() => {
      expect(window.api.saveFile).toHaveBeenCalledWith('/tmp/report.md', '# Unsaved edits')
    })
    await waitFor(() => {
      expect(useDocumentStore.getState().content).toBe('# Restored Report')
    })
  })

  it('restores correctly when the editor holds an unflushed edit the store has not seen yet (the 200ms debounce window)', async () => {
    // Regression test for the final whole-branch review's Important 2.
    // handleRestoreVersion used to read `isDirty` from the RENDER CLOSURE.
    // Milkdown's markdownUpdated is 200ms-debounced, so there is a real
    // window where the editor holds a genuine edit but documentStore.isDirty
    // is still false. Clicking a History row inside that window took the
    // "clean document, nothing to save" path, called replaceContentForTab
    // (bumping revision), and the resulting remount's unmount-flush then
    // pushed the unflushed edit straight back over the just-restored content
    // -- leaving the editor DISPLAYING the restored version while the store
    // HELD the pre-restore edit, which the next Save would write to disk.
    //
    // The document starts CLEAN here (isDirty: false everywhere, tab entry
    // included) -- that is the entire point. A dirty fixture would take the
    // already-covered flush+save path and prove nothing about this bug.
    useDocumentStore.setState((state) => ({
      filePath: '/tmp/report.md',
      content: '# Report',
      isDirty: false,
      tabs: state.tabs.map((tab) =>
        tab.id === state.activeTabId
          ? { ...tab, filePath: '/tmp/report.md', content: '# Report', isDirty: false }
          : tab
      )
    }))
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/tmp/report.md' })
    vi.mocked(window.api.getVersionHistory).mockResolvedValue([
      { id: 'snap-1', timestamp: '2026-08-05T12:00:00.000Z', sizeBytes: 10 }
    ])
    vi.mocked(window.api.restoreVersionContent).mockResolvedValue('# Restored Report')
    const user = userEvent.setup()
    render(<EditorScreen />)

    await waitFor(() => {
      expect(document.querySelector('.milkdown-mount .ProseMirror')).toBeInTheDocument()
    })
    // Open History and locate the restore row BEFORE making the edit, so the
    // only real time spent between the edit and the click is the click
    // itself -- the 200ms debounce must not fire in between, or the store
    // would learn about the edit on its own and the scenario evaporates.
    await user.click(screen.getByRole('button', { name: 'History' }))
    const restoreButton = await screen.findByRole('button', { name: /restore/i })

    // Same direct-DOM-mutation technique as the 'Save picks up the editor
    // current content' test above: a real ProseMirror edit the store has not
    // been told about, rather than an attempt to win a 200ms race by timing.
    const h1 = document.querySelector('.ProseMirror h1')
    if (!h1?.firstChild) throw new Error('expected a text node inside the mounted h1')
    h1.firstChild.textContent = `${h1.firstChild.textContent} Q3`
    const range = document.createRange()
    range.selectNodeContents(h1)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    // One tick for ProseMirror's MutationObserver to turn the DOM change into
    // a real transaction (which is what flips the editor's edited-since-mount
    // flag) -- but nowhere near the 200ms debounce.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(useDocumentStore.getState().isDirty).toBe(false)

    await user.click(restoreButton)

    // The unflushed edit must have been flushed and SAVED first...
    await waitFor(() => {
      expect(window.api.saveFile).toHaveBeenCalled()
    })
    expect(vi.mocked(window.api.saveFile).mock.calls.at(-1)?.[1]).toContain('Q3')

    // ...and the restored content must be what the store actually ends up
    // holding. Before the fix this settled on the pre-restore edit instead.
    await waitFor(() => {
      expect(useDocumentStore.getState().content).toBe('# Restored Report')
    })
    // Give the remount's own unmount-flush every chance to fire and (if the
    // bug regressed) clobber the restore, before asserting it stuck.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(useDocumentStore.getState().content).toBe('# Restored Report')
  })

  it('abandons the restore without touching content when the pre-restore save leaves the document dirty', async () => {
    // saveFile resolving null is this codebase's own established stand-in
    // for "the save didn't actually happen" (see the Save-As-cancelled
    // tests above) -- documentStore.save()'s `if (result)` branch never
    // runs, so isDirty stays true exactly as it would after a real
    // disk-write failure. Sets the `tabs` array entry too, not just the
    // top-level mirror -- see the sibling "succeeds" test's own comment on
    // why: handleRestoreVersion's guard reads the real tab entry.
    useDocumentStore.setState((state) => ({
      filePath: '/tmp/report.md',
      content: '# Unsaved edits',
      isDirty: true,
      tabs: state.tabs.map((tab) =>
        tab.id === state.activeTabId
          ? { ...tab, filePath: '/tmp/report.md', content: '# Unsaved edits', isDirty: true }
          : tab
      )
    }))
    vi.mocked(window.api.saveFile).mockResolvedValue(null)
    vi.mocked(window.api.getVersionHistory).mockResolvedValue([
      { id: 'snap-1', timestamp: '2026-08-05T12:00:00.000Z', sizeBytes: 10 }
    ])
    vi.mocked(window.api.restoreVersionContent).mockResolvedValue('# Restored Report')
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'History' }))
    const restoreButton = await screen.findByRole('button', { name: /restore/i })
    await user.click(restoreButton)

    await waitFor(() => {
      expect(window.api.saveFile).toHaveBeenCalledWith('/tmp/report.md', '# Unsaved edits')
    })
    // Give handleRestoreVersion's async flushAndRestore every chance to
    // reach (and wrongly act past) its guard before asserting nothing
    // changed -- there are no further awaits after saveFile resolves, so
    // this is generous, not load-bearing timing.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(useDocumentStore.getState().content).toBe('# Unsaved edits')
    expect(useDocumentStore.getState().isDirty).toBe(true)
  })

  it('lands a restore on the tab that was active at click time, not whichever tab is active when the pre-restore save resolves', async () => {
    // Tab A is the one being restored (dirty, so a pre-restore Save fires
    // and has a real async gap at `await save()`, an IPC round trip). Tab B
    // is a distinct, untouched tab the user switches to WHILE that save is
    // still in flight -- the always-visible EditorTabBar lets this happen
    // at any time, and it's exactly the race replaceContentForTab exists
    // to close.
    const tabA = { id: 'tab-a', filePath: '/tmp/a.md', content: '# A dirty edit', isDirty: true }
    const tabB = { id: 'tab-b', filePath: '/tmp/b.md', content: '# B untouched', isDirty: false }
    useDocumentStore.setState({
      tabs: [tabA, tabB],
      activeTabId: tabA.id,
      content: tabA.content,
      filePath: tabA.filePath,
      isDirty: tabA.isDirty
    })

    let resolveSave: (value: { filePath: string } | null) => void = () => {}
    vi.mocked(window.api.saveFile).mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve
      })
    )
    vi.mocked(window.api.getVersionHistory).mockResolvedValue([
      { id: 'snap-1', timestamp: '2026-08-05T12:00:00.000Z', sizeBytes: 10 }
    ])
    vi.mocked(window.api.restoreVersionContent).mockResolvedValue('# Restored A')

    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'History' }))
    const restoreButton = await screen.findByRole('button', { name: /restore/i })
    await user.click(restoreButton)

    // The pre-restore Save is now in flight (saveFile called, but its
    // promise deliberately not yet resolved) -- switch to tab B before it
    // resolves.
    await waitFor(() => {
      expect(window.api.saveFile).toHaveBeenCalledWith('/tmp/a.md', '# A dirty edit')
    })
    await act(async () => {
      useDocumentStore.getState().switchTab(tabB.id)
    })
    expect(useDocumentStore.getState().activeTabId).toBe(tabB.id)

    resolveSave({ filePath: '/tmp/a.md' })

    await waitFor(() => {
      expect(useDocumentStore.getState().tabs.find((tab) => tab.id === tabA.id)?.content).toBe(
        '# Restored A'
      )
    })
    // Tab B, active when the save resolved, must be completely untouched --
    // neither its content nor its dirty state was ever meant to change.
    const finalTabB = useDocumentStore.getState().tabs.find((tab) => tab.id === tabB.id)
    expect(finalTabB?.content).toBe('# B untouched')
    expect(finalTabB?.isDirty).toBe(false)
    // Tab B is still the active tab, so the top-level mirror must still
    // reflect it, not the restored tab A content that just landed in the
    // background.
    expect(useDocumentStore.getState().content).toBe('# B untouched')
  })

  // Tab-close-confirmation: EditorTabBar's "x" button on a dirty ACTIVE tab
  // now defers to handleCloseDirtyActiveTab instead of discarding directly.
  // These mirror the handleGoHome dirty-check tests above -- same
  // confirm/flush/save/clear-autosave sequence, applied to closing a tab
  // instead of navigating Home. A dirty BACKGROUND tab's close is NOT
  // covered here -- it's still a direct, unconfirmed closeTab (the
  // disclosed, deliberately-unfixed gap), and is covered at the
  // EditorTabBar level instead (EditorTabBar.test.tsx), since that's where
  // the discriminator actually lives.
  describe('closing a dirty active tab via its "x" button', () => {
    function setActiveTabDirty(filePath: string, content: string): void {
      useDocumentStore.setState((state) => ({
        filePath,
        content,
        isDirty: true,
        tabs: state.tabs.map((tab) =>
          tab.id === state.activeTabId ? { ...tab, filePath, content, isDirty: true } : tab
        )
      }))
    }

    it('prompts before closing, and closes after a successful Save', async () => {
      setActiveTabDirty('/tmp/report.md', '# Report')
      const activeId = useDocumentStore.getState().activeTabId
      vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('save')
      vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/tmp/report.md' })
      const user = userEvent.setup()
      render(<EditorScreen />)

      await user.click(screen.getByRole('button', { name: 'Close report.md' }))

      expect(window.api.confirmDiscardChanges).toHaveBeenCalled()
      await waitFor(() => {
        expect(window.api.saveFile).toHaveBeenCalledWith('/tmp/report.md', '# Report')
      })
      await waitFor(() => {
        expect(useDocumentStore.getState().tabs.some((tab) => tab.id === activeId)).toBe(false)
      })
    })

    it('discards and closes the tab, clearing pending autosave, when the user chooses "Don\'t Save"', async () => {
      setActiveTabDirty('/tmp/report.md', '# Report')
      const activeId = useDocumentStore.getState().activeTabId
      vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('discard')
      const user = userEvent.setup()
      render(<EditorScreen />)

      await user.click(screen.getByRole('button', { name: 'Close report.md' }))

      await waitFor(() => {
        expect(window.api.clearPendingAutosave).toHaveBeenCalledWith('/tmp/report.md')
      })
      await waitFor(() => {
        expect(useDocumentStore.getState().tabs.some((tab) => tab.id === activeId)).toBe(false)
      })
      expect(window.api.saveFile).not.toHaveBeenCalled()
    })

    it('does nothing when the user cancels -- the tab stays open, nothing is saved or discarded', async () => {
      setActiveTabDirty('/tmp/report.md', '# Report')
      const activeId = useDocumentStore.getState().activeTabId
      vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('cancel')
      const user = userEvent.setup()
      render(<EditorScreen />)

      await user.click(screen.getByRole('button', { name: 'Close report.md' }))

      await waitFor(() => {
        expect(window.api.confirmDiscardChanges).toHaveBeenCalled()
      })
      expect(window.api.saveFile).not.toHaveBeenCalled()
      expect(window.api.clearPendingAutosave).not.toHaveBeenCalled()
      expect(useDocumentStore.getState().tabs.some((tab) => tab.id === activeId)).toBe(true)
    })

    // Regression test for a real bug caught in review of the draft fix: the
    // draft's post-save re-check read the top-level `isDirty` MIRROR
    // (whichever tab is active right now), not the tab actually being
    // closed. save() itself is a plain async IPC round trip with no modal
    // dialog blocking the renderer (file-io.ts's saveFile writes directly
    // for an already-known path), so the always-visible EditorTabBar lets
    // the user switch tabs while it's in flight -- exactly the race
    // handleRestoreVersion's own post-save guard (tested above) already has
    // to defend against for restores. Tab A is the one being closed (its
    // save will fail); tab B is a distinct, CLEAN tab the user switches to
    // mid-save. A mirror-scoped check would read tab B's isDirty (false)
    // and wrongly conclude tab A's save succeeded, discarding tab A's real,
    // never-written content.
    it('does not close the tab if ITS OWN save failed, even when a different (clean) tab is active by the time save() resolves', async () => {
      const tabA = { id: 'tab-a', filePath: '/tmp/a.md', content: '# A dirty edit', isDirty: true }
      const tabB = { id: 'tab-b', filePath: '/tmp/b.md', content: '# B clean', isDirty: false }
      useDocumentStore.setState({
        tabs: [tabA, tabB],
        activeTabId: tabA.id,
        content: tabA.content,
        filePath: tabA.filePath,
        isDirty: tabA.isDirty
      })
      vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('save')
      let resolveSave: (value: { filePath: string } | null) => void = () => {}
      vi.mocked(window.api.saveFile).mockReturnValue(
        new Promise((resolve) => {
          resolveSave = resolve
        })
      )
      const user = userEvent.setup()
      render(<EditorScreen />)

      await user.click(screen.getByRole('button', { name: 'Close a.md' }))

      // The pre-close Save is now in flight (saveFile called, but its
      // promise deliberately not yet resolved) -- switch to the clean tab B
      // before it resolves.
      await waitFor(() => {
        expect(window.api.saveFile).toHaveBeenCalledWith('/tmp/a.md', '# A dirty edit')
      })
      await act(async () => {
        useDocumentStore.getState().switchTab(tabB.id)
      })
      expect(useDocumentStore.getState().activeTabId).toBe(tabB.id)

      // saveFile resolving null is this codebase's own established stand-in
      // for "the save didn't actually happen" (see the Save-As-cancelled
      // tests above) -- tab A's real isDirty stays true.
      resolveSave(null)

      // Give handleCloseDirtyActiveTab's continuation every chance to run
      // (and, if the bug regressed, wrongly close tab A) before asserting.
      await new Promise((resolve) => setTimeout(resolve, 50))

      const finalTabA = useDocumentStore.getState().tabs.find((tab) => tab.id === tabA.id)
      expect(finalTabA).toBeDefined()
      expect(finalTabA?.isDirty).toBe(true)
      expect(finalTabA?.content).toBe('# A dirty edit')
      // Tab B, switched to mid-save, must be completely untouched.
      const finalTabB = useDocumentStore.getState().tabs.find((tab) => tab.id === tabB.id)
      expect(finalTabB?.content).toBe('# B clean')
      expect(finalTabB?.isDirty).toBe(false)
    })
  })

  // Clicking the page card's own blank space (real padding around the
  // editor, added so the page looks like a real sheet of paper -- see this
  // div's own comment in EditorScreen.tsx) used to do nothing at all: no
  // cursor, no way to start typing there, even though it visually looks
  // like part of the editable page. handlePageCardClick fixes this by
  // moving the cursor to the end of the document (MilkdownEditorHandle.
  // focusEnd(), covered directly against a raw Editor in
  // MilkdownEditor.test.tsx) -- these tests cover the REAL click-routing
  // decision at the EditorScreen level: which clicks get redirected there,
  // and, just as importantly, which don't.
  describe('Source mode wiring', () => {
    it('renders SourceEditor, not the Milkdown page-card, when viewMode is source', async () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report\n\nBody text' })
      useAppStore.setState({ viewMode: 'source' })
      render(<EditorScreen />)

      expect(screen.getByRole('textbox', { name: 'Markdown source' })).toHaveValue(
        '# Report\n\nBody text'
      )
      expect(screen.queryByTestId('page-card')).not.toBeInTheDocument()
    })

    it('typing in Source mode updates documentStore content directly, no debounce wait needed', async () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: 'start' })
      useAppStore.setState({ viewMode: 'source' })
      const user = userEvent.setup()
      render(<EditorScreen />)

      const textarea = screen.getByRole('textbox', { name: 'Markdown source' })
      await user.clear(textarea)
      await user.type(textarea, 'changed')

      expect(useDocumentStore.getState().content).toBe('changed')
    })

    it('switching Format -> Source flushes the outgoing Milkdown editor before Source mode reads content', async () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
      useAppStore.setState({ viewMode: 'format' })
      const user = userEvent.setup()
      render(<EditorScreen />)

      await waitFor(() => {
        expect(screen.getByTestId('document-content')).toHaveTextContent('Report')
      })

      // Put the store into the exact state flush() exists to recover from: a
      // real ProseMirror edit the store has NOT seen yet, because the 200ms
      // markdownUpdated debounce hasn't fired. Same direct-DOM-mutation
      // technique as the 'Save picks up the editor current content' test
      // above -- a genuine unsynced edit, not an attempt to win a timing
      // race. If handleSetViewMode omitted the flush() call, Source mode
      // would read documentStore.content as it stood BEFORE this edit, and
      // the assertion below (checking for the just-typed text) would fail.
      const h1 = document.querySelector('.ProseMirror h1')
      if (!h1?.firstChild) throw new Error('expected a text node inside the mounted h1')
      h1.firstChild.textContent = `${h1.firstChild.textContent} Q3`
      const range = document.createRange()
      range.selectNodeContents(h1)
      range.collapse(false)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)

      // One tick for ProseMirror's MutationObserver to register the edit
      // into its own state, but nowhere near the 200ms onChange debounce --
      // acting well within that window is the whole point of this test.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(useDocumentStore.getState().content).toBe('# Report')

      await user.click(screen.getByRole('button', { name: 'Source' }))

      // The unflushed edit must have made it into the store, and Source
      // mode's textarea must display it -- proving handleSetViewMode
      // actually called flush() before switching, not just that Source mode
      // renders without throwing. Asserts CONTAINS rather than an exact
      // match: flush() re-serializes through Milkdown's real
      // remark-stringify pipeline (PINNED_STRINGIFY_OPTIONS), which adds a
      // trailing newline on the first real edit to a document (see
      // CLAUDE.md's Milkdown section) -- '# Report Q3\n', not '# Report Q3'.
      await waitFor(() => {
        const textarea = screen.getByRole('textbox', {
          name: 'Markdown source'
        }) as HTMLTextAreaElement
        expect(textarea.value).toContain('# Report Q3')
      })
      expect(useDocumentStore.getState().content).toContain('# Report Q3')
    })

    it('switching Source -> Format remounts Milkdown with the edited Source-mode content, not stale pre-edit content', async () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Original' })
      useAppStore.setState({ viewMode: 'source' })

      // Fix-round-1 finding: the outcome assertion below (the remounted
      // editor shows the edit) passes even with handleSetViewMode's own
      // `replaceContentForTab(activeTabId, content)` call deleted entirely
      // -- verified by mutation testing, not assumed. Root cause: the
      // Source/Format JSX conditional swaps MilkdownEditor's element type
      // in and out of the tree, which React reconciles as a full
      // unmount-then-mount regardless of whether key={revision} changed, so
      // a fresh MilkdownEditor instance reads the CURRENT `content` prop at
      // mount time either way -- the revision bump this call exists to
      // force is, right now, redundant with that unrelated mechanism. The
      // call is kept anyway (plan- and design-doc-mandated defense-in-depth
      // for when the JSX structure changes -- see handleSetViewMode's own
      // doc comment in EditorScreen.tsx), so this test needs a seam that
      // actually isolates it: the unmount/onChange path only ever calls
      // updateContentForTab, never replaceContentForTab, so a direct spy on
      // the latter genuinely discriminates. Wraps (not replaces) the real
      // action -- captured before the store swap, so the spy still performs
      // the real revision-bumping work and the outcome assertions below
      // remain genuine end-to-end coverage, not just a call-count check.
      const realReplaceContentForTab = useDocumentStore.getState().replaceContentForTab
      const replaceContentForTabSpy = vi.fn(realReplaceContentForTab)
      useDocumentStore.setState({ replaceContentForTab: replaceContentForTabSpy })
      const activeTabId = useDocumentStore.getState().activeTabId

      const user = userEvent.setup()
      render(<EditorScreen />)

      const textarea = screen.getByRole('textbox', { name: 'Markdown source' })
      await user.clear(textarea)
      await user.type(textarea, '# Edited In Source')

      await user.click(screen.getByRole('button', { name: 'Format' }))

      expect(replaceContentForTabSpy).toHaveBeenCalledWith(activeTabId, '# Edited In Source')

      // This is the test that would have caught the clobbering bug the
      // design doc warns about: if EditorScreen didn't force a revision
      // bump on the way out of Source mode, MilkdownEditor would remain
      // (or remount) showing the STALE pre-Source-mode content, silently
      // discarding the edit just made above.
      await waitFor(() => {
        expect(screen.getByTestId('document-content')).toHaveTextContent('Edited In Source')
      })
      expect(useDocumentStore.getState().content).toBe('# Edited In Source')
    })

    // F1 (final whole-branch review, CRITICAL): replaceContentForTab used to
    // set isDirty: true unconditionally, so handleSetViewMode's Source ->
    // Format same-value rewrite (see that function's own doc comment) had a
    // second, real effect beyond the revision bump it exists for -- it
    // manufactured a false "unsaved changes" state on a document nobody had
    // actually touched. Reviewer's empirical repro: a clean document, click
    // Source, click Format, zero edits in between -- isDirty went
    // false -> true. This test pins the fixed behavior end to end, through
    // the real handleSetViewMode/replaceContentForTab wiring (documentStore's
    // own unit tests pin the store-level guard in isolation; this is the
    // integration-level round trip the reviewer named explicitly).
    it('F1: a Format -> Source -> Format round trip with zero edits does not mark a clean document dirty', async () => {
      // loadDocument (via openTab) seeds BOTH the top-level mirror fields
      // AND the matching tabs-array entry consistently, unlike a bare
      // useDocumentStore.setState({ content, isDirty }) -- necessary here
      // since replaceContentForTab's same-value guard (F1) compares against
      // the target tab's OWN content, and openTab's default startDirty is
      // already false, so this is a genuinely clean document from the start.
      useDocumentStore.getState().loadDocument('/tmp/report.md', '# Report')
      useAppStore.setState({ viewMode: 'format' })
      const revisionBefore = useDocumentStore.getState().revision
      const user = userEvent.setup()
      render(<EditorScreen />)

      await waitFor(() => {
        expect(screen.getByTestId('document-content')).toHaveTextContent('Report')
      })
      expect(useDocumentStore.getState().isDirty).toBe(false)

      await user.click(screen.getByRole('button', { name: 'Source' }))
      await user.click(screen.getByRole('button', { name: 'Format' }))

      // The round trip must still bump revision (MilkdownEditor's own
      // remount-on-leaving-Source-mode contract, unrelated to F1) while
      // leaving isDirty exactly as it was.
      expect(useDocumentStore.getState().revision).toBeGreaterThan(revisionBefore)
      expect(useDocumentStore.getState().isDirty).toBe(false)
    })

    // F3 (final whole-branch review, IMPORTANT): mutation-proven gap -- the
    // reviewer changed SourceEditor's `value={content}` to `defaultValue={content}`
    // (making the textarea uncontrolled) and every then-existing test in this
    // suite still passed. The real failure that gap hides: handleRestoreVersion
    // and handleApplyPageConfig both call replaceContent/replaceContentForTab
    // directly on documentStore while Source mode may already be on screen --
    // with an uncontrolled textarea, that external content change would never
    // reach the DOM node, the textarea would keep showing the PRE-restore
    // text, and the user's next keystroke would push that stale text back
    // into the store, silently clobbering the restore. This test reproduces
    // exactly that call shape (replaceContent while Source mode is displayed)
    // and asserts the textarea actually reflects it.
    it('F3: an external content change (History restore / Page Setup) while Source mode is displayed lands in the textarea', () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Original' })
      useAppStore.setState({ viewMode: 'source' })
      render(<EditorScreen />)

      expect(screen.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Original')

      act(() => {
        useDocumentStore.getState().replaceContent('# Restored From History')
      })

      expect(screen.getByRole('textbox', { name: 'Markdown source' })).toHaveValue(
        '# Restored From History'
      )
    })
  })

  // Task 5 of the Split mode sub-project: viewMode 'split' finally renders a
  // real two-pane layout (SourceEditor or the Milkdown page-card on the
  // left, per splitLeftMode -- SplitPreview on the right) instead of Source
  // mode's own plan-era placeholder, which deliberately folded 'split' into
  // the plain Format branch. See docs/superpowers/sdd/2026-08-07-split-mode/
  // task-5-brief.md Step 3/5.
  //
  // Query note: the brief's own draft used
  // screen.getByRole('textbox', { name: '' }) for the left-pane textarea --
  // wrong for the real, shipped SourceEditor, which sets a real
  // aria-label="Markdown source" (see SourceEditor.tsx and this file's own
  // pre-existing 'Source mode wiring' tests above, which already query it
  // that way). Using the correct name here, not the brief's literal string.
  describe('Split mode wiring', () => {
    it('renders SourceEditor + SplitPreview side by side when viewMode is split and splitLeftMode is source', async () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
      useAppStore.setState({ viewMode: 'split', splitLeftMode: 'source' })
      render(<EditorScreen />)

      expect(screen.getByRole('textbox', { name: 'Markdown source' })).toBeInTheDocument()
      expect(screen.getByTestId('split-preview-placeholder')).toBeInTheDocument()
      expect(screen.queryByTestId('page-card')).not.toBeInTheDocument()
    })

    it('renders the Milkdown page-card + SplitPreview side by side when viewMode is split and splitLeftMode is format', async () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
      useAppStore.setState({ viewMode: 'split', splitLeftMode: 'format' })
      render(<EditorScreen />)

      await waitFor(() => {
        expect(screen.getByTestId('page-card')).toBeInTheDocument()
      })
      expect(screen.getByTestId('split-preview-placeholder')).toBeInTheDocument()
    })

    // Generalization of the pre-existing 'switching Source -> Format
    // remounts Milkdown with the edited Source-mode content' test above
    // (same file), covering the NEW transition Split mode introduces:
    // leaving a Source-mode-flavored Split left pane for plain Format mode.
    // Same discriminating-spy technique -- see that test's own comment for
    // why a spy (not just the outcome) is needed to tell
    // replaceContentForTab's revision bump apart from the JSX
    // type-swap/remount that ALSO carries the edit across, today.
    it('switching Split(source) -> Format remounts Milkdown with the edited Split-mode content, not stale pre-edit content', async () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Original' })
      useAppStore.setState({ viewMode: 'split', splitLeftMode: 'source' })

      const realReplaceContentForTab = useDocumentStore.getState().replaceContentForTab
      const replaceContentForTabSpy = vi.fn(realReplaceContentForTab)
      useDocumentStore.setState({ replaceContentForTab: replaceContentForTabSpy })
      const activeTabId = useDocumentStore.getState().activeTabId

      const user = userEvent.setup()
      render(<EditorScreen />)

      const textarea = screen.getByRole('textbox', { name: 'Markdown source' })
      await user.clear(textarea)
      await user.type(textarea, '# Edited In Split Source')

      await user.click(screen.getByRole('button', { name: 'Format' }))

      expect(replaceContentForTabSpy).toHaveBeenCalledWith(activeTabId, '# Edited In Split Source')

      await waitFor(() => {
        expect(screen.getByTestId('document-content')).toHaveTextContent('Edited In Split Source')
      })
      expect(useDocumentStore.getState().content).toBe('# Edited In Split Source')
    })

    // Fix round 1 (post-Task-5 review, Important 1): the reverse direction
    // of the ONE format<->source pair the initial Task 5 pass left
    // untested -- plain Source entered from Split(format), i.e. leaving
    // Source-editing and entering Format-editing. Mirrors the pre-existing
    // 'switching Source -> Format...' test's spy technique exactly, just
    // landing on Split(format) instead of plain Format as the destination.
    it('switching Source -> Split(format) remounts Milkdown with the edited Source-mode content, not stale pre-edit content', async () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Original' })
      useAppStore.setState({ viewMode: 'source', splitLeftMode: 'format' })

      const realReplaceContentForTab = useDocumentStore.getState().replaceContentForTab
      const replaceContentForTabSpy = vi.fn(realReplaceContentForTab)
      useDocumentStore.setState({ replaceContentForTab: replaceContentForTabSpy })
      const activeTabId = useDocumentStore.getState().activeTabId

      const user = userEvent.setup()
      render(<EditorScreen />)

      const textarea = screen.getByRole('textbox', { name: 'Markdown source' })
      await user.clear(textarea)
      await user.type(textarea, '# Edited Before Split')

      await user.click(screen.getByRole('button', { name: 'Split' }))

      expect(replaceContentForTabSpy).toHaveBeenCalledWith(activeTabId, '# Edited Before Split')

      await waitFor(() => {
        expect(screen.getByTestId('document-content')).toHaveTextContent('Edited Before Split')
      })
      expect(useDocumentStore.getState().content).toBe('# Edited Before Split')
    })

    // Fix round 1 (post-Task-5 review, Important 2): the splitLeftMode
    // toggle (EditorToolbar.tsx) deliberately bypasses handleSetViewMode
    // entirely -- it calls appStore's setSplitLeftMode directly, with no
    // flush()/replaceContentForTab coordination of its own. The task-5
    // report argued this is safe because Split's own left-pane ternary
    // (splitLeftMode === 'source' ? SourceEditor : the page-card) is a real
    // element-type swap: MilkdownEditor's own unmount cleanup flushes any
    // pending edit before destroy, and a fresh mount reads the CURRENT
    // store content regardless of key. That argument was prose-only before
    // this fix round -- these two tests exercise it directly, end to end,
    // through the REAL MilkdownEditor (not the module-mocked fake
    // EditorScreen.viewMode.test.tsx uses elsewhere in this suite), because
    // the unmount-flush side effect IS the mechanism under test here, not
    // something to be isolated away from.
    it('toggling splitLeftMode from format to source while in Split mode does not lose an in-flight Milkdown edit', async () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
      useAppStore.setState({ viewMode: 'split', splitLeftMode: 'format' })
      const user = userEvent.setup()
      render(<EditorScreen />)

      await waitFor(() => {
        expect(document.querySelector('.milkdown-mount .ProseMirror')).toBeInTheDocument()
      })

      // A real, unflushed edit the store has not seen yet -- same
      // direct-DOM-mutation technique used throughout this file for
      // exercising the 200ms markdownUpdated debounce window (see e.g.
      // 'switching Format -> Source flushes...' above).
      const h1 = document.querySelector('.ProseMirror h1')
      if (!h1?.firstChild) throw new Error('expected a text node inside the mounted h1')
      h1.firstChild.textContent = `${h1.firstChild.textContent} Q3`
      const range = document.createRange()
      range.selectNodeContents(h1)
      range.collapse(false)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)

      // One tick for ProseMirror's MutationObserver to register the edit,
      // nowhere near the 200ms onChange debounce -- the store must NOT know
      // about this edit yet when the toggle is clicked, or the scenario
      // (an edit that only survives via the unmount-flush safety net, not
      // because onChange already synced it) evaporates.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(useDocumentStore.getState().content).toBe('# Report')

      await user.click(screen.getByRole('button', { name: 'Split left pane: Source' }))

      await waitFor(() => {
        const textarea = screen.getByRole('textbox', {
          name: 'Markdown source'
        }) as HTMLTextAreaElement
        expect(textarea.value).toContain('# Report Q3')
      })
      expect(useDocumentStore.getState().content).toContain('# Report Q3')
    })

    it('toggling splitLeftMode from source to format while in Split mode does not lose an in-flight Source edit', async () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Original' })
      useAppStore.setState({ viewMode: 'split', splitLeftMode: 'source' })
      const user = userEvent.setup()
      render(<EditorScreen />)

      const textarea = screen.getByRole('textbox', { name: 'Markdown source' })
      await user.clear(textarea)
      await user.type(textarea, '# Edited In Split Source Pane')

      await user.click(screen.getByRole('button', { name: 'Split left pane: Format' }))

      await waitFor(() => {
        expect(screen.getByTestId('document-content')).toHaveTextContent(
          'Edited In Split Source Pane'
        )
      })
      expect(useDocumentStore.getState().content).toBe('# Edited In Split Source Pane')
    })

    // Final whole-branch review finding, C1 (Critical, blocked merge): unlike
    // the splitLeftMode toggle tests above, format<->split(format) goes
    // through handleSetViewMode's own flush/remount coordination -- and the
    // four-boolean model there originally classified this pair as NEITHER
    // entering NOR leaving Format editing (both sides ARE Format editing), so
    // neither flush() nor replaceContentForTab() fired for it. The JSX still
    // unmounts/remounts MilkdownEditor across this transition regardless (the
    // page-card lives at two different structural positions -- the
    // single-pane branch vs Split's left-pane branch), so the freshly-mounted
    // instance seeded itself from content captured one render tick BEFORE the
    // outgoing instance's own unmount-triggered flush could update the store
    // -- reverting the edit, and making it permanently lost the moment the
    // user typed again. These two tests reproduce both directions with a
    // real, unflushed Milkdown edit (same direct-DOM-mutation technique as
    // the splitLeftMode toggle tests above) and would have failed against the
    // pre-fix handleSetViewMode.
    it('switching Format -> Split(format) does not lose an in-flight, unflushed Milkdown edit', async () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
      useAppStore.setState({ viewMode: 'format', splitLeftMode: 'format' })
      const user = userEvent.setup()
      render(<EditorScreen />)

      await waitFor(() => {
        expect(document.querySelector('.milkdown-mount .ProseMirror')).toBeInTheDocument()
      })

      const h1 = document.querySelector('.ProseMirror h1')
      if (!h1?.firstChild) throw new Error('expected a text node inside the mounted h1')
      h1.firstChild.textContent = `${h1.firstChild.textContent} Q3`
      const range = document.createRange()
      range.selectNodeContents(h1)
      range.collapse(false)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)

      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(useDocumentStore.getState().content).toBe('# Report')

      await user.click(screen.getByRole('button', { name: 'Split' }))

      await waitFor(() => {
        expect(useDocumentStore.getState().content).toContain('# Report Q3')
      })
      // The edit must be visible in the newly-mounted split-left instance
      // too, not just in the store -- the store alone updating doesn't rule
      // out the mount having already captured a stale prop before this
      // assertion runs.
      await waitFor(() => {
        expect(document.querySelector('.ProseMirror h1')?.textContent).toContain('Report Q3')
      })

      // Proves the loss isn't merely deferred: a further edit must compose
      // with the flushed one, not silently drop it the way the pre-fix
      // report's own "STORE AFTER LATER EDIT" repro showed.
      const h1Again = document.querySelector('.ProseMirror h1')
      if (!h1Again?.firstChild) throw new Error('expected a text node inside the mounted h1')
      h1Again.firstChild.textContent = `${h1Again.firstChild.textContent} FY26`
      const range2 = document.createRange()
      range2.selectNodeContents(h1Again)
      range2.collapse(false)
      const selection2 = window.getSelection()
      selection2?.removeAllRanges()
      selection2?.addRange(range2)
      await waitFor(
        () => {
          expect(useDocumentStore.getState().content).toContain('Q3 FY26')
        },
        { timeout: 500 }
      )
    })

    it('switching Split(format) -> Format does not lose an in-flight, unflushed Milkdown edit', async () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
      useAppStore.setState({ viewMode: 'split', splitLeftMode: 'format' })
      const user = userEvent.setup()
      render(<EditorScreen />)

      await waitFor(() => {
        expect(document.querySelector('.milkdown-mount .ProseMirror')).toBeInTheDocument()
      })

      const h1 = document.querySelector('.ProseMirror h1')
      if (!h1?.firstChild) throw new Error('expected a text node inside the mounted h1')
      h1.firstChild.textContent = `${h1.firstChild.textContent} Q3`
      const range = document.createRange()
      range.selectNodeContents(h1)
      range.collapse(false)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)

      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(useDocumentStore.getState().content).toBe('# Report')

      await user.click(screen.getByRole('button', { name: 'Format' }))

      await waitFor(() => {
        expect(useDocumentStore.getState().content).toContain('# Report Q3')
      })
      await waitFor(() => {
        expect(document.querySelector('.ProseMirror h1')?.textContent).toContain('Report Q3')
      })
    })
  })

  describe('page-card blank-space click behavior (focusEnd)', () => {
    it("clicking the page card's own blank space (not on real content) focuses the real ProseMirror editor", async () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report\n\nBody text' })
      const user = userEvent.setup()
      render(<EditorScreen />)

      const proseMirror = await waitFor(() => {
        const el = document.querySelector('.ProseMirror')
        if (!el) throw new Error('not mounted yet')
        return el as HTMLElement
      })
      expect(document.activeElement).not.toBe(proseMirror)

      // jsdom has no real layout engine, so there's no pixel coordinate to
      // click "below the last line" at -- clicking the page-card div
      // itself (data-testid="page-card", added for this test) directly,
      // rather than any of its content descendants, is the DOM-structural
      // equivalent: its own onClick target is guaranteed to be the div
      // itself, which is definitely not inside .ProseMirror, the same as a
      // real click landing in its unoccupied padding would be.
      const pageCard = screen.getByTestId('page-card')
      await user.click(pageCard)

      expect(document.activeElement).toBe(proseMirror)
    })

    it('clicking on real text inside .ProseMirror does not redirect focus -- focusEnd is not what positions a normal in-content click', async () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report\n\nBody text' })
      render(<EditorScreen />)

      await waitFor(() => {
        expect(screen.getByTestId('document-content')).toHaveTextContent('Report')
      })
      const proseMirror = document.querySelector('.ProseMirror') as HTMLElement
      expect(document.activeElement).not.toBe(proseMirror)

      // fireEvent.click (a bare click, no preceding mousedown) rather than
      // userEvent.click here on purpose: ProseMirror's own real mousedown
      // handler unconditionally calls view.posAtCoords for cursor
      // placement, which throws in jsdom (document.elementFromPoint is not
      // implemented -- confirmed directly; the exact same gap
      // MilkdownEditor.test.tsx's own comments already document for
      // userEvent.type's click step). A bare click event alone doesn't
      // reach that handler (prosemirror-view registers no separate click
      // handler of its own), so this reaches handlePageCardClick's real
      // .closest('.ProseMirror') guard -- the thing under test -- without
      // depending on machinery jsdom cannot run.
      const heading = document.querySelector('.ProseMirror h1') as HTMLElement
      fireEvent.click(heading)

      // If the .closest('.ProseMirror') guard ever regressed (called
      // focusEnd() unconditionally), this WOULD become proseMirror -- see
      // the sibling "blank space" test above, which proves focusEnd()
      // genuinely does that when it's actually supposed to.
      expect(document.activeElement).not.toBe(proseMirror)
    })

    it('a drag-selection that starts on real text and releases in the blank page-card space does not clobber it (mousedown-origin tracking)', async () => {
      // Review-round finding (verified against the real UI Events spec and
      // real Chromium bug reports, not assumed): when a mousedown and the
      // following mouseup land on DIFFERENT elements -- exactly what a
      // click-drag text selection does when it starts on real text and
      // the mouse is released in the page card's own blank padding --
      // Chromium fires the resulting `click` event on their nearest common
      // ancestor, not on either original element. Here, that's the page
      // card div itself (an ancestor of the heading), which fails
      // handlePageCardClick's `.closest('.ProseMirror')` check even though
      // the user's whole gesture was a normal in-content selection --
      // without mousedown-origin tracking, focusEnd() would silently
      // collapse/discard the selection they just made.
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report\n\nBody text' })
      render(<EditorScreen />)

      await waitFor(() => {
        expect(screen.getByTestId('document-content')).toHaveTextContent('Report')
      })
      const proseMirror = document.querySelector('.ProseMirror') as HTMLElement
      const pageCard = screen.getByTestId('page-card')
      const heading = document.querySelector('.ProseMirror h1') as HTMLElement
      expect(document.activeElement).not.toBe(proseMirror)

      // jsdom cannot execute a real mousedown on an element inside
      // .ProseMirror at all (see the sibling test above's own comment), so
      // the mousedown is dispatched from the page card -- a safe ancestor
      // that never reaches .ProseMirror's own listener, since bubbling
      // only travels upward from the dispatch point -- with its `target`
      // property overridden to the heading. This simulates exactly what a
      // `target`-reading handler observes for a real cross-element
      // mousedown, without depending on ProseMirror's real (and here,
      // unavailable) handling to produce it.
      const mouseDownEvent = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      Object.defineProperty(mouseDownEvent, 'target', { value: heading, configurable: true })
      fireEvent(pageCard, mouseDownEvent)

      // The click itself genuinely lands on the common ancestor (the page
      // card div) -- a real, direct fireEvent.click, no override needed.
      fireEvent.click(pageCard)

      // Must NOT have redirected focus: the gesture's origin was real
      // content, so whatever selection ProseMirror's own drag-selection
      // handling would have produced must be left alone. Contrast with the
      // first test in this block, where BOTH mousedown and click target
      // the page card -- that case DOES focus.
      expect(document.activeElement).not.toBe(proseMirror)
    })
  })

  // Page Geometry Wiring (Task 5): the page card's on-screen size is derived
  // from the document's own PageConfig through computePageGeometry, instead
  // of the fixed Letter/1in values it used to hardcode as Tailwind classes
  // (`w-[816px] pl-24 pr-24`). Asserted as INLINE styles specifically
  // because that is the only form jsdom can observe -- no Tailwind
  // stylesheet is loaded in this environment, so a `w-[816px]` class reads
  // as no width at all here.
  describe('page-card geometry follows the document own PageConfig', () => {
    it("the page card's width and padding reflect the document's own PageConfig, not the fixed Letter default", async () => {
      useDocumentStore.setState({
        filePath: '/tmp/report.md',
        content:
          '---\npage: A4\nmargins:\n  top: 1\n  bottom: 1\n  left: 0.5\n  right: 0.5\n---\n\n# Report'
      })
      render(<EditorScreen />)

      // A4 at 96dpi is 8.2677in -> 794px wide (page-geometry.ts's own pinned
      // sheet dimensions, not CSS's rounded print defaults); 0.5in side
      // margins -> 48px each.
      const pageCard = await screen.findByTestId('page-card')
      expect(pageCard).toHaveStyle({ width: '794px', paddingLeft: '48px', paddingRight: '48px' })

      // Top/bottom padding stay the fixed cosmetic 22px/34px from the design
      // mock and are deliberately NOT marginTopPx/marginBottomPx -- this
      // fixture's own 1in top/bottom margins would be 96px if they ever
      // were, so this assertion fails loudly if someone "completes" the
      // wiring by hooking them up. See renderPageCard's comment for why.
      expect(pageCard).toHaveStyle({ paddingTop: '22px', paddingBottom: '34px' })

      // The editor mount inside the card gets the matching content width:
      // 794 - 48 - 48 = 698.
      const mount = document.querySelector('.milkdown-mount') as HTMLElement
      expect(mount).toHaveStyle({ maxWidth: '698px' })
    })

    it('a document with no frontmatter still gets the Letter/1in default geometry (816 - 96 - 96 = 624)', async () => {
      // The regression guard for the DEFAULT case: Gate 10
      // (phase0/gate10-editor-layout-parity.spec.ts) asserts this mount's
      // real content width is exactly CONTENT_WIDTH_PX (624) for its own
      // no-frontmatter fixture, so a change that made the default A4, or
      // that produced NaN geometry from a partial config, would break real
      // editor/preview layout parity. This test catches both without
      // needing a browser.
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report\n\nBody text' })
      render(<EditorScreen />)

      const pageCard = await screen.findByTestId('page-card')
      expect(pageCard).toHaveStyle({ width: '816px', paddingLeft: '96px', paddingRight: '96px' })

      const mount = document.querySelector('.milkdown-mount') as HTMLElement
      expect(mount).toHaveStyle({ maxWidth: '624px' })
    })
  })
})
