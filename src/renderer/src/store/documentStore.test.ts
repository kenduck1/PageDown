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
    confirmDiscardChanges: vi.fn()
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
    vi.mocked(window.api.openFile).mockResolvedValue({ filePath: '/a.md', content: '# A' })
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

  it('openPath loads the result and returns true on success', async () => {
    vi.mocked(window.api.openPath).mockResolvedValue({ filePath: '/b.md', content: '# B' })
    const loaded = await useDocumentStore.getState().openPath('/b.md')
    expect(loaded).toBe(true)
    expect(useDocumentStore.getState().content).toBe('# B')
  })

  it('save updates filePath and clears isDirty on success', async () => {
    useDocumentStore.setState({ content: '# A', filePath: null, isDirty: true })
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/saved.md' })
    await useDocumentStore.getState().save()
    expect(useDocumentStore.getState()).toMatchObject({ filePath: '/saved.md', isDirty: false })
  })

  it('save sets error on failure without touching filePath', async () => {
    useDocumentStore.setState({ filePath: '/a.md' })
    vi.mocked(window.api.saveFile).mockRejectedValue(new Error('Disk full'))
    await useDocumentStore.getState().save()
    expect(useDocumentStore.getState()).toMatchObject({ filePath: '/a.md', error: 'Disk full' })
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
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/saved.md' })
    await useDocumentStore.getState().save()

    useDocumentStore.getState().openTab('/b.md', '# B')
    useDocumentStore.getState().switchTab(tabA)

    const state = useDocumentStore.getState()
    expect(state).toMatchObject({ filePath: '/saved.md', isDirty: false })
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
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/c.md' })
    await useDocumentStore.getState().save()
    expect(useDocumentStore.getState()).toMatchObject({ filePath: '/c.md', isDirty: false })

    // clearError/error still a single flat field.
    useDocumentStore.setState({ error: 'x' })
    useDocumentStore.getState().clearError()
    expect(useDocumentStore.getState().error).toBeNull()
  })
})
