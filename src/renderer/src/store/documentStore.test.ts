import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDocumentStore, initialDocumentState } from './documentStore'

beforeEach(() => {
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
    exportPdf: vi.fn(),
    print: vi.fn(),
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
    setWindowState: vi.fn()
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useDocumentStore', () => {
  it('newDocument resets to a blank untitled document', () => {
    useDocumentStore.setState({ content: 'old', filePath: '/old.md', isDirty: true, error: 'x' })
    useDocumentStore.getState().newDocument()
    expect(useDocumentStore.getState()).toMatchObject({
      content: '',
      filePath: null,
      isDirty: false,
      error: null
    })
  })

  it('newDocument seeds the given starter content', () => {
    useDocumentStore.getState().newDocument('# Résumé template')
    expect(useDocumentStore.getState().content).toBe('# Résumé template')
    expect(useDocumentStore.getState().filePath).toBeNull()
  })

  it('loadDocument sets filePath and content and clears dirty/error', () => {
    useDocumentStore.setState({ isDirty: true, error: 'x' })
    useDocumentStore.getState().loadDocument('/a.md', '# A')
    expect(useDocumentStore.getState()).toMatchObject({
      filePath: '/a.md',
      content: '# A',
      isDirty: false,
      error: null
    })
  })

  it('openFile loads the result and returns true on success', async () => {
    vi.mocked(window.api.openFile).mockResolvedValue({
      filePath: '/a.md',
      content: '# A',
      recoveredFromAutosave: false,
      mtimeMs: 1000
    })
    const loaded = await useDocumentStore.getState().openFile()
    expect(loaded).toBe(true)
    expect(useDocumentStore.getState().filePath).toBe('/a.md')
  })

  it('openFile returns false and makes no changes when cancelled', async () => {
    vi.mocked(window.api.openFile).mockResolvedValue(null)
    const loaded = await useDocumentStore.getState().openFile()
    expect(loaded).toBe(false)
    expect(useDocumentStore.getState().filePath).toBeNull()
    expect(useDocumentStore.getState().error).toBeNull()
  })

  it('openFile returns false and sets error on failure', async () => {
    vi.mocked(window.api.openFile).mockRejectedValue(new Error('Permission denied'))
    const loaded = await useDocumentStore.getState().openFile()
    expect(loaded).toBe(false)
    expect(useDocumentStore.getState().error).toBe('Permission denied')
  })

  it('openFile lands the document dirty when the result is recoveredFromAutosave', async () => {
    vi.mocked(window.api.openFile).mockResolvedValue({
      filePath: '/a.md',
      content: '# Recovered content',
      recoveredFromAutosave: true,
      mtimeMs: 1000
    })
    await useDocumentStore.getState().openFile()
    expect(useDocumentStore.getState()).toMatchObject({
      content: '# Recovered content',
      isDirty: true
    })
  })

  it('openFile leaves the document clean when the result is NOT recoveredFromAutosave', async () => {
    vi.mocked(window.api.openFile).mockResolvedValue({
      filePath: '/a.md',
      content: '# Normal content',
      recoveredFromAutosave: false,
      mtimeMs: 1000
    })
    await useDocumentStore.getState().openFile()
    expect(useDocumentStore.getState().isDirty).toBe(false)
  })

  it('openPath loads the result and returns true on success', async () => {
    vi.mocked(window.api.openPath).mockResolvedValue({
      filePath: '/b.md',
      content: '# B',
      recoveredFromAutosave: false,
      mtimeMs: 1000
    })
    const loaded = await useDocumentStore.getState().openPath('/b.md')
    expect(loaded).toBe(true)
    expect(useDocumentStore.getState().content).toBe('# B')
  })

  it('save updates filePath and clears isDirty on success', async () => {
    useDocumentStore.setState({ content: '# A', filePath: null, isDirty: true })
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/saved.md', mtimeMs: 2000 })
    await useDocumentStore.getState().save()
    expect(useDocumentStore.getState()).toMatchObject({ filePath: '/saved.md', isDirty: false })
  })

  it('save sets error on failure without touching filePath', async () => {
    useDocumentStore.setState({ filePath: '/a.md' })
    vi.mocked(window.api.saveFile).mockRejectedValue(new Error('Disk full'))
    await useDocumentStore.getState().save()
    expect(useDocumentStore.getState()).toMatchObject({ filePath: '/a.md', error: 'Disk full' })
  })

  it('save writes a version-history snapshot of the saved content after a successful save', async () => {
    useDocumentStore.setState({ content: '# Saved content', filePath: '/a.md', isDirty: true })
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/a.md', mtimeMs: 2000 })
    await useDocumentStore.getState().save()
    expect(window.api.autosaveSnapshot).toHaveBeenCalledWith('# Saved content', '/a.md')
  })

  it('save does NOT call autosaveSnapshot when the save itself fails', async () => {
    useDocumentStore.setState({ content: '# X', filePath: '/a.md', isDirty: true })
    vi.mocked(window.api.saveFile).mockRejectedValue(new Error('disk full'))
    await useDocumentStore.getState().save()
    expect(window.api.autosaveSnapshot).not.toHaveBeenCalled()
  })

  it('save does NOT call autosaveSnapshot when the user cancels Save-As (result is null)', async () => {
    useDocumentStore.setState({ content: '# X', filePath: null, isDirty: true })
    vi.mocked(window.api.saveFile).mockResolvedValue(null)
    await useDocumentStore.getState().save()
    expect(window.api.autosaveSnapshot).not.toHaveBeenCalled()
  })

  it('save sends the active tab own mtimeMs baseline to window.api.saveFile', async () => {
    const tab = useDocumentStore.getState().tabs[0]
    useDocumentStore.setState({
      content: '# A',
      filePath: '/a.md',
      isDirty: true,
      mtimeMs: 5000,
      tabs: [{ ...tab, filePath: '/a.md', content: '# A', isDirty: true, mtimeMs: 5000 }]
    })
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/a.md', mtimeMs: 6000 })
    await useDocumentStore.getState().save()
    expect(window.api.saveFile).toHaveBeenCalledWith('/a.md', '# A', 5000)
    expect(useDocumentStore.getState().mtimeMs).toBe(6000)
  })

  it('a successful save records the new mtimeMs returned by window.api.saveFile', async () => {
    useDocumentStore.setState({ content: '# A', filePath: '/a.md', isDirty: true, mtimeMs: 1000 })
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/a.md', mtimeMs: 9999 })
    await useDocumentStore.getState().save()
    const active = useDocumentStore.getState()
    expect(active.mtimeMs).toBe(9999)
    const tab = active.tabs.find((t) => t.id === active.activeTabId)
    expect(tab?.mtimeMs).toBe(9999)
  })

  it('save adopts reloadedContent, clears isDirty, and does NOT autosave when the user chooses Reload on an external-change conflict', async () => {
    useDocumentStore.setState({
      content: '# My unsaved edit',
      filePath: '/a.md',
      isDirty: true,
      mtimeMs: 1000
    })
    vi.mocked(window.api.saveFile).mockResolvedValue({
      filePath: '/a.md',
      mtimeMs: 7000,
      reloadedContent: '# What is actually on disk now'
    })
    const revisionBefore = useDocumentStore.getState().revision

    await useDocumentStore.getState().save()

    const state = useDocumentStore.getState()
    expect(state.content).toBe('# What is actually on disk now')
    expect(state.isDirty).toBe(false)
    expect(state.mtimeMs).toBe(7000)
    // A Reload discards the user's own edit rather than saving it -- it must
    // never be mistaken for a successful save of that edit.
    expect(window.api.autosaveSnapshot).not.toHaveBeenCalled()
    // MilkdownEditor is uncontrolled after mount, so picking up content that
    // changed outside its own onChange path needs a fresh key -- same
    // mechanism replaceContentForTab already relies on.
    expect(state.revision).toBe(revisionBefore + 1)
    const tab = state.tabs.find((t) => t.id === state.activeTabId)
    expect(tab).toMatchObject({
      content: '# What is actually on disk now',
      isDirty: false,
      mtimeMs: 7000
    })
  })

  it("saveDroppedImage reads the file as base64 and calls window.api.saveDroppedImage with the active tab's filePath", async () => {
    useDocumentStore.setState({ filePath: '/doc.md' })
    vi.mocked(window.api.saveDroppedImage).mockResolvedValue({ relativePath: 'photo.png' })
    const file = new File(['fake-bytes'], 'photo.png', { type: 'image/png' })

    const result = await useDocumentStore.getState().saveDroppedImage(file)

    expect(result).toEqual({ relativePath: 'photo.png' })
    expect(window.api.saveDroppedImage).toHaveBeenCalledWith(
      '/doc.md',
      expect.any(String),
      'photo.png'
    )
    // The base64 payload must be the pure encoding (no `data:...;base64,`
    // prefix) -- Buffer.from(data, 'base64') on the main-process side
    // expects exactly that.
    const [, base64Arg] = vi.mocked(window.api.saveDroppedImage).mock.calls[0]
    expect(base64Arg).not.toContain('data:')
    expect(base64Arg).not.toContain(',')
  })

  it('saveDroppedImage passes null filePath through for an unsaved document, letting the main process refuse it', async () => {
    useDocumentStore.setState({ filePath: null })
    vi.mocked(window.api.saveDroppedImage).mockResolvedValue({
      error: 'Save the document before adding images.'
    })
    const file = new File(['fake-bytes'], 'photo.png', { type: 'image/png' })

    const result = await useDocumentStore.getState().saveDroppedImage(file)

    expect(result).toEqual({ error: 'Save the document before adding images.' })
    expect(window.api.saveDroppedImage).toHaveBeenCalledWith(null, expect.any(String), 'photo.png')
  })

  it('saveDroppedImage returns an error object (not a throw) when the IPC call itself rejects', async () => {
    useDocumentStore.setState({ filePath: '/doc.md' })
    vi.mocked(window.api.saveDroppedImage).mockRejectedValue(new Error('IPC failed'))
    const file = new File(['fake-bytes'], 'photo.png', { type: 'image/png' })

    const result = await useDocumentStore.getState().saveDroppedImage(file)

    expect(result).toEqual({ error: 'IPC failed' })
  })

  it('clearError resets error to null', () => {
    useDocumentStore.setState({ error: 'x' })
    useDocumentStore.getState().clearError()
    expect(useDocumentStore.getState().error).toBeNull()
  })

  it('newDocument increments revision', () => {
    const before = useDocumentStore.getState().revision
    useDocumentStore.getState().newDocument()
    expect(useDocumentStore.getState().revision).toBe(before + 1)
  })

  it('loadDocument increments revision', () => {
    const before = useDocumentStore.getState().revision
    useDocumentStore.getState().loadDocument('/a.md', '# A')
    expect(useDocumentStore.getState().revision).toBe(before + 1)
  })

  it('updateContent sets content and marks the document dirty without touching revision', () => {
    useDocumentStore.setState({ content: 'old', isDirty: false })
    const before = useDocumentStore.getState().revision
    useDocumentStore.getState().updateContent('new content')
    expect(useDocumentStore.getState()).toMatchObject({
      content: 'new content',
      isDirty: true,
      revision: before
    })
  })

  it('replaceContent sets content, marks the document dirty, AND bumps revision', () => {
    useDocumentStore.setState({ content: 'old', isDirty: false })
    const before = useDocumentStore.getState().revision
    useDocumentStore.getState().replaceContent('new content')
    expect(useDocumentStore.getState()).toMatchObject({
      content: 'new content',
      isDirty: true,
      revision: before + 1
    })
  })

  it('replaceContent updates the active tab in the tabs array too', () => {
    const tabId = useDocumentStore.getState().activeTabId
    useDocumentStore.getState().replaceContent('new content')
    const tab = useDocumentStore.getState().tabs.find((t) => t.id === tabId)
    expect(tab).toMatchObject({ content: 'new content', isDirty: true })
  })

  // F1 (final whole-branch review): replaceContentForTab used to set
  // isDirty: true unconditionally, even when the "new" content was
  // byte-identical to what the tab already held -- a same-value rewrite
  // (e.g. EditorScreen's handleSetViewMode calling this purely to force a
  // revision bump when leaving Source mode) therefore manufactured a false
  // "unsaved changes" state on a genuinely clean, untouched document. These
  // three tests pin the guard: unchanged content leaves isDirty exactly as
  // it was (both directions), changed content still marks dirty, and the
  // revision bump always happens regardless.
  //
  // seedTab below sets BOTH the top-level mirror fields AND the matching
  // entry in the `tabs` array -- the guard under test compares the new
  // content against the TARGET TAB's own content (not the mirror), so a
  // setup that only patches the mirror (plain `useDocumentStore.setState({
  // content, isDirty })`, which leaves the tabs array's own entry at its
  // stale initial '' content) would make every call look like a genuine
  // change regardless of what's actually being tested here -- silently
  // testing nothing. Real production callers never hit this inconsistency:
  // every store action that changes `content` always keeps `tabs` and the
  // mirror in sync together (see activeMirror's own doc comment).
  function seedTab(tabId: string, content: string, isDirty: boolean): void {
    useDocumentStore.setState((state) => ({
      content,
      isDirty,
      tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, content, isDirty } : tab))
    }))
  }

  it('replaceContentForTab leaves a clean tab clean when the new content is byte-identical to the current content', () => {
    const tabId = useDocumentStore.getState().activeTabId
    seedTab(tabId, '# Report', false)
    const before = useDocumentStore.getState().revision
    useDocumentStore.getState().replaceContentForTab(tabId, '# Report')
    const state = useDocumentStore.getState()
    expect(state).toMatchObject({
      content: '# Report',
      isDirty: false,
      revision: before + 1
    })
    // The per-tab half of the guard, not just the top-level mirror --
    // switchTab restores isDirty from this entry, so a regression here
    // (the map branch losing the guard while the mirror keeps it) would
    // resurrect the false-dirty state the instant the user switches away
    // from and back to this tab, even though the mirror-only assertion
    // above stays green throughout.
    expect(state.tabs.find((tab) => tab.id === tabId)).toMatchObject({
      content: '# Report',
      isDirty: false
    })
  })

  it('replaceContentForTab leaves an already-dirty tab dirty when the new content is byte-identical to the current content', () => {
    const tabId = useDocumentStore.getState().activeTabId
    seedTab(tabId, '# Report', true)
    useDocumentStore.getState().replaceContentForTab(tabId, '# Report')
    expect(useDocumentStore.getState().isDirty).toBe(true)
  })

  it('replaceContentForTab still marks the document dirty when the new content genuinely differs', () => {
    const tabId = useDocumentStore.getState().activeTabId
    seedTab(tabId, '# Report', false)
    useDocumentStore.getState().replaceContentForTab(tabId, '# Report v2')
    expect(useDocumentStore.getState().isDirty).toBe(true)
  })

  it('updateContentForTab targeting the active tab behaves exactly like updateContent', () => {
    const tabId = useDocumentStore.getState().activeTabId
    useDocumentStore.getState().updateContentForTab(tabId, 'new content')
    expect(useDocumentStore.getState()).toMatchObject({ content: 'new content', isDirty: true })
  })

  it('updateContentForTab targeting a tab that is NO LONGER active updates only that tab, not the on-screen mirror fields -- the exact race a late MilkdownEditor flush() can hit after a tab switch', () => {
    const tabA = useDocumentStore.getState().activeTabId
    useDocumentStore.getState().openTab('/b.md', '# B')
    const tabB = useDocumentStore.getState().activeTabId
    expect(tabB).not.toBe(tabA)

    // Simulates the outgoing MilkdownEditor instance's unmount-triggered
    // flush() landing AFTER the tab switch already moved activeTabId to
    // tabB -- exactly what a real tab switch produces, since switchTab's
    // revision bump and the resulting remount/flush aren't the same tick.
    useDocumentStore.getState().updateContentForTab(tabA, 'edited after switching away')

    const state = useDocumentStore.getState()
    // The on-screen mirror fields must still reflect tabB, completely
    // unaffected by tabA's late update.
    expect(state).toMatchObject({ activeTabId: tabB, content: '# B', isDirty: false })
    // But tabA's own entry in the tabs array DID pick up the edit -- it's
    // not lost, just correctly filed under the tab that was actually
    // edited rather than the tab that happened to be active when the
    // update was flushed.
    const tabAEntry = state.tabs.find((tab) => tab.id === tabA)
    expect(tabAEntry).toMatchObject({ content: 'edited after switching away', isDirty: true })
  })
})

describe('useDocumentStore tabs', () => {
  it('starts with exactly one tab, matching the top-level mirror fields', () => {
    const state = useDocumentStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].id).toBe(state.activeTabId)
    expect(state.tabs[0]).toMatchObject({
      content: state.content,
      filePath: state.filePath,
      isDirty: state.isDirty
    })
  })

  it('openTab appends a new tab, makes it active, and clears error -- without removing the old tab', () => {
    useDocumentStore.setState({ error: 'stale error' })
    const originalTabId = useDocumentStore.getState().activeTabId
    useDocumentStore.getState().openTab('/new.md', '# New')

    const state = useDocumentStore.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.tabs.some((tab) => tab.id === originalTabId)).toBe(true)
    expect(state.activeTabId).not.toBe(originalTabId)
    expect(state).toMatchObject({
      content: '# New',
      filePath: '/new.md',
      isDirty: false,
      error: null
    })
  })

  it('newDocument and loadDocument open a NEW tab rather than replacing the active one in place', () => {
    useDocumentStore.getState().openTab('/a.md', '# A')
    const countAfterFirstOpen = useDocumentStore.getState().tabs.length

    useDocumentStore.getState().newDocument('# B')
    expect(useDocumentStore.getState().tabs).toHaveLength(countAfterFirstOpen + 1)

    useDocumentStore.getState().loadDocument('/c.md', '# C')
    expect(useDocumentStore.getState().tabs).toHaveLength(countAfterFirstOpen + 2)
  })

  it('switchTab makes the given tab active and mirrors its fields to the top level', () => {
    useDocumentStore.getState().openTab('/a.md', '# A')
    const tabA = useDocumentStore.getState().activeTabId
    useDocumentStore.getState().openTab('/b.md', '# B')
    const before = useDocumentStore.getState().revision

    useDocumentStore.getState().switchTab(tabA)

    const state = useDocumentStore.getState()
    expect(state.activeTabId).toBe(tabA)
    expect(state).toMatchObject({ content: '# A', filePath: '/a.md', isDirty: false })
    expect(state.revision).toBe(before + 1)
  })

  it('switchTab to the already-active tab is a no-op (no unnecessary remount)', () => {
    const activeTabId = useDocumentStore.getState().activeTabId
    const before = useDocumentStore.getState().revision

    useDocumentStore.getState().switchTab(activeTabId)

    expect(useDocumentStore.getState().revision).toBe(before)
  })

  it('switchTab to an unknown id is a no-op', () => {
    const before = useDocumentStore.getState()
    useDocumentStore.getState().switchTab('does-not-exist')
    expect(useDocumentStore.getState()).toMatchObject({
      activeTabId: before.activeTabId,
      revision: before.revision
    })
  })

  it('closeTab on a background tab removes it without touching the active tab or mirror fields', () => {
    const tabA = useDocumentStore.getState().activeTabId
    useDocumentStore.setState({ content: '# A', filePath: '/a.md' })
    useDocumentStore.getState().openTab('/b.md', '# B')
    const before = useDocumentStore.getState()

    useDocumentStore.getState().closeTab(tabA)

    const state = useDocumentStore.getState()
    expect(state.tabs.some((tab) => tab.id === tabA)).toBe(false)
    expect(state.tabs).toHaveLength(1)
    expect(state.activeTabId).toBe(before.activeTabId)
    expect(state).toMatchObject({ content: '# B', filePath: '/b.md' })
  })

  it('closeTab on the active tab activates a neighbor and mirrors its fields', () => {
    useDocumentStore.getState().openTab('/a.md', '# A')
    const tabA = useDocumentStore.getState().activeTabId
    useDocumentStore.getState().openTab('/b.md', '# B')
    const tabB = useDocumentStore.getState().activeTabId

    useDocumentStore.getState().closeTab(tabB)

    const state = useDocumentStore.getState()
    expect(state.activeTabId).toBe(tabA)
    expect(state).toMatchObject({ content: '# A', filePath: '/a.md' })
  })

  it('closeTab on the last remaining tab leaves exactly one fresh blank "Untitled" tab, never zero', () => {
    const onlyTabId = useDocumentStore.getState().activeTabId
    useDocumentStore.setState({ content: '# only', filePath: '/only.md', isDirty: true })

    useDocumentStore.getState().closeTab(onlyTabId)

    const state = useDocumentStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].id).not.toBe(onlyTabId)
    expect(state).toMatchObject({ content: '', filePath: null, isDirty: false, error: null })
  })

  it('closeTab with an unknown id is a no-op', () => {
    const before = useDocumentStore.getState()
    useDocumentStore.getState().closeTab('does-not-exist')
    expect(useDocumentStore.getState().tabs).toEqual(before.tabs)
  })

  it('updateContent on the active tab is preserved in the tabs array across a tab switch', () => {
    const tabA = useDocumentStore.getState().activeTabId
    useDocumentStore.getState().openTab('/b.md', '# B')

    useDocumentStore.getState().switchTab(tabA)
    useDocumentStore.getState().updateContent('# A edited')

    useDocumentStore.getState().openTab('/c.md', '# C')
    useDocumentStore.getState().switchTab(tabA)

    expect(useDocumentStore.getState().content).toBe('# A edited')
    expect(useDocumentStore.getState().isDirty).toBe(true)
  })

  it('save persists the resolved filePath into the tabs array, surviving a switch away and back', async () => {
    useDocumentStore.setState({ content: '# untitled', filePath: null, isDirty: true })
    const tabA = useDocumentStore.getState().activeTabId
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/saved.md', mtimeMs: 2000 })
    await useDocumentStore.getState().save()

    useDocumentStore.getState().openTab('/b.md', '# B')
    useDocumentStore.getState().switchTab(tabA)

    const state = useDocumentStore.getState()
    expect(state).toMatchObject({ filePath: '/saved.md', isDirty: false })
  })

  it('save targets the tab that was active when save() was CALLED, not whichever tab is active when the write resolves', async () => {
    // window.api.saveFile is a real async IPC round trip -- the user can
    // switch tabs (via the always-visible EditorTabBar) while it's still
    // in flight. Captures activeTabId synchronously via a deferred
    // saveFile promise, switches tabs mid-flight, then resolves it -- the
    // exact race replaceContentForTab was introduced to close for restore,
    // reopened here through save()'s own separate `set()` callback (which
    // used to read state.activeTabId at RESOLVE time instead).
    useDocumentStore.setState({ content: '# A dirty', filePath: '/a.md', isDirty: true })
    const tabA = useDocumentStore.getState().activeTabId
    let resolveSave: (value: { filePath: string; mtimeMs: number } | null) => void = () => {}
    vi.mocked(window.api.saveFile).mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve
      })
    )

    const savePromise = useDocumentStore.getState().save()
    useDocumentStore.getState().openTab('/b.md', '# B')
    const tabB = useDocumentStore.getState().activeTabId
    expect(tabB).not.toBe(tabA)

    resolveSave({ filePath: '/saved-a.md', mtimeMs: 2000 })
    await savePromise

    const state = useDocumentStore.getState()
    // Tab A -- the one actually saved -- picked up the resolved filePath
    // and cleared isDirty, even though it's no longer the active tab.
    const tabAEntry = state.tabs.find((tab) => tab.id === tabA)
    expect(tabAEntry).toMatchObject({ filePath: '/saved-a.md', isDirty: false })
    // Tab B, active when the write resolved, must be completely untouched
    // by a save that was never about it.
    const tabBEntry = state.tabs.find((tab) => tab.id === tabB)
    expect(tabBEntry).toMatchObject({ filePath: '/b.md', content: '# B', isDirty: false })
    // Tab B is still the active tab, so the top-level mirror must still
    // reflect it, not tab A's just-saved state.
    expect(state).toMatchObject({ activeTabId: tabB, filePath: '/b.md' })
  })

  it('the single-document API contract (content/filePath/isDirty/revision/error) still holds with multiple tabs open', async () => {
    useDocumentStore.getState().openTab('/a.md', '# A')
    useDocumentStore.getState().openTab('/b.md', '# B')
    useDocumentStore.getState().openTab('/c.md', '# C')
    expect(useDocumentStore.getState().tabs).toHaveLength(4)

    // updateContent still reads/writes the flat `content` field exactly like
    // the single-document API contract, even though 3 other tabs exist.
    useDocumentStore.getState().updateContent('# C edited')
    expect(useDocumentStore.getState().content).toBe('# C edited')
    expect(useDocumentStore.getState().isDirty).toBe(true)

    // save still reads flat `content`/`filePath` and writes them back flatly.
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/c.md', mtimeMs: 2000 })
    await useDocumentStore.getState().save()
    expect(useDocumentStore.getState()).toMatchObject({ filePath: '/c.md', isDirty: false })

    // clearError/error still a single flat field.
    useDocumentStore.setState({ error: 'x' })
    useDocumentStore.getState().clearError()
    expect(useDocumentStore.getState().error).toBeNull()
  })
})

describe('useDocumentStore saveAs', () => {
  it('passes a null path and a null mtime baseline, which is what opens the Save dialog', async () => {
    // Both nulls matter. The null PATH is what makes file-io.ts's saveFile
    // show a native Save dialog rather than writing to the current file. The
    // null BASELINE is not merely convenient: the external-change check asks
    // "has the file this document came from changed under us," and a Save-As
    // target is a path the user has not chosen yet -- comparing the OLD
    // file's mtime against a DIFFERENT file's would be meaningless.
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/tmp/copy.md', mtimeMs: 42 })
    useDocumentStore.setState({ filePath: '/tmp/original.md', content: '# Doc', mtimeMs: 1000 })

    await useDocumentStore.getState().saveAs()

    expect(window.api.saveFile).toHaveBeenCalledWith(null, '# Doc', null)
  })

  it('adopts the newly chosen path and clears the dirty flag', async () => {
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/tmp/copy.md', mtimeMs: 42 })
    useDocumentStore.setState({ filePath: '/tmp/original.md', content: '# Doc', isDirty: true })

    await useDocumentStore.getState().saveAs()

    expect(useDocumentStore.getState().filePath).toBe('/tmp/copy.md')
    expect(useDocumentStore.getState().isDirty).toBe(false)
    expect(useDocumentStore.getState().mtimeMs).toBe(42)
  })

  it('changes nothing when the user cancels the dialog', async () => {
    vi.mocked(window.api.saveFile).mockResolvedValue(null)
    useDocumentStore.setState({ filePath: '/tmp/original.md', content: '# Doc', isDirty: true })

    await useDocumentStore.getState().saveAs()

    expect(useDocumentStore.getState().filePath).toBe('/tmp/original.md')
    expect(useDocumentStore.getState().isDirty).toBe(true)
  })
})

describe('useDocumentStore exportPdf/print', () => {
  it('forwards content, path and the remote-image consent decision', async () => {
    useDocumentStore.setState({
      filePath: '/tmp/report.md',
      content: '# Report',
      remoteImagesAllowed: true
    })

    await useDocumentStore.getState().exportPdf()
    await useDocumentStore.getState().print()

    expect(window.api.exportPdf).toHaveBeenCalledWith('# Report', '/tmp/report.md', true)
    expect(window.api.print).toHaveBeenCalledWith('# Report', '/tmp/report.md', true)
  })

  it('defaults an undecided consent to blocked', async () => {
    // remoteImagesAllowed is `null` (undecided) for every freshly opened
    // document, and undecided must be treated exactly like blocked.
    useDocumentStore.setState({ filePath: null, content: '# Doc', remoteImagesAllowed: null })

    await useDocumentStore.getState().exportPdf()

    expect(window.api.exportPdf).toHaveBeenCalledWith('# Doc', null, false)
  })

  it('holds an in-flight guard IN THE STORE, so a second trigger cannot double-run it', async () => {
    // The reason this moved out of EditorToolbar's own useState: Export now
    // has two independent triggers (the toolbar button and File > Export as
    // PDF), and a guard owned by one of them cannot see the other.
    let resolveExport: (() => void) | undefined
    vi.mocked(window.api.exportPdf).mockReturnValue(
      new Promise((resolve) => {
        resolveExport = () => resolve({ filePath: '/tmp/report.pdf' })
      })
    )
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })

    const first = useDocumentStore.getState().exportPdf()
    expect(useDocumentStore.getState().isExporting).toBe(true)
    await useDocumentStore.getState().exportPdf()

    expect(window.api.exportPdf).toHaveBeenCalledTimes(1)
    resolveExport?.()
    await first
    expect(useDocumentStore.getState().isExporting).toBe(false)
  })

  it('surfaces a friendly message rather than the raw IPC error string', async () => {
    // Electron wraps a thrown main-process error as `Error invoking remote
    // method 'file:exportPdf': Error: <original>`, which is not something a
    // user should have to parse.
    vi.mocked(window.api.exportPdf).mockRejectedValue(
      new Error("Error invoking remote method 'file:exportPdf': Error: disk full")
    )
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })

    await useDocumentStore.getState().exportPdf()

    expect(useDocumentStore.getState().error).toBe('Failed to export PDF. Please try again.')
    expect(useDocumentStore.getState().isExporting).toBe(false)
  })

  it('a successful export does NOT clear an unrelated pre-existing error', async () => {
    useDocumentStore.setState({ content: '# Report', error: 'Failed to save. Disk full.' })

    await useDocumentStore.getState().exportPdf()

    expect(useDocumentStore.getState().error).toBe('Failed to save. Disk full.')
  })

  it('a cancelled print dialog is not an error', async () => {
    vi.mocked(window.api.print).mockResolvedValue({ cancelled: true })
    useDocumentStore.setState({ content: '# Report' })

    await useDocumentStore.getState().print()

    expect(useDocumentStore.getState().error).toBeNull()
  })
})
