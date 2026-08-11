import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { confirmWindowClose, setCloseGuardFlush } from './close-guard'
import { useAppStore, initialAppState } from '../store/appStore'
import { useDocumentStore, initialDocumentState, type DocumentTab } from '../store/documentStore'

// The renderer half of the window-close / app-quit guard. Before it existed,
// closing a window or quitting discarded every unsaved document with no prompt
// at all -- and for a never-saved "Untitled" tab that loss was TOTAL, since
// useAutosave only snapshots a document that already has a file path.
//
// No end-to-end gate covers this: the confirmation is a real
// dialog.showMessageBox, a native modal no automated test can dismiss (the
// same reason Print and the mtime-conflict feature deliberately have no gate
// either). So this file tests the real decision function directly, against a
// mocked dialog -- which is also what makes the guard mutation-verifiable.

function tab(overrides: Partial<DocumentTab> & { id: string }): DocumentTab {
  return {
    filePath: null,
    content: '',
    isDirty: false,
    mtimeMs: null,
    remoteImagesAllowed: null,
    currentPage: 1,
    ...overrides
  }
}

function setTabs(tabs: DocumentTab[], activeTabId = tabs[0].id): void {
  const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0]
  useDocumentStore.setState({
    tabs,
    activeTabId: active.id,
    content: active.content,
    filePath: active.filePath,
    isDirty: active.isDirty,
    mtimeMs: active.mtimeMs,
    remoteImagesAllowed: active.remoteImagesAllowed
  })
}

beforeEach(() => {
  useAppStore.setState({ ...initialAppState, screen: 'editor' })
  useDocumentStore.setState(initialDocumentState)
  setCloseGuardFlush(null)
  window.api = {
    ...window.api,
    confirmDiscardChanges: vi.fn(),
    saveFile: vi.fn(),
    clearPendingAutosave: vi.fn()
  } as typeof window.api
})

afterEach(() => {
  setCloseGuardFlush(null)
  vi.restoreAllMocks()
})

describe('confirmWindowClose', () => {
  it('closes immediately, with no prompt, when nothing is dirty', async () => {
    setTabs([tab({ id: 'a', filePath: '/tmp/a.md' })])

    await expect(confirmWindowClose()).resolves.toBe(true)
    expect(window.api.confirmDiscardChanges).not.toHaveBeenCalled()
  })

  it('refuses to close when the user cancels', async () => {
    setTabs([tab({ id: 'a', filePath: '/tmp/a.md', isDirty: true })])
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('cancel')

    await expect(confirmWindowClose()).resolves.toBe(false)
    // Nothing may be written or discarded on a cancel.
    expect(window.api.saveFile).not.toHaveBeenCalled()
    expect(window.api.clearPendingAutosave).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().tabs).toHaveLength(1)
  })

  it('saves and then closes when the user chooses Save', async () => {
    setTabs([tab({ id: 'a', filePath: '/tmp/a.md', content: '# A', isDirty: true })])
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('save')
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/tmp/a.md', mtimeMs: 1 })

    await expect(confirmWindowClose()).resolves.toBe(true)
    expect(window.api.saveFile).toHaveBeenCalledWith('/tmp/a.md', '# A', null)
  })

  it('refuses to close when the Save did not actually happen', async () => {
    // saveFile resolving null is this codebase's own stand-in for "the write
    // didn't happen" (a cancelled Save-As for a never-saved document). A
    // failed save must never fall through into closing the window.
    setTabs([tab({ id: 'a', filePath: null, content: '# Untitled work', isDirty: true })])
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('save')
    vi.mocked(window.api.saveFile).mockResolvedValue(null)

    await expect(confirmWindowClose()).resolves.toBe(false)
    expect(useDocumentStore.getState().tabs[0].isDirty).toBe(true)
  })

  it('clears the pending autosave and closes the tab on "Don\'t Save"', async () => {
    setTabs([tab({ id: 'a', filePath: '/tmp/a.md', isDirty: true })])
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('discard')

    await expect(confirmWindowClose()).resolves.toBe(true)
    // Otherwise the discarded edit reappears as a "recovered" document on the
    // very next open -- the exact failure the discard path exists to prevent.
    expect(window.api.clearPendingAutosave).toHaveBeenCalledWith('/tmp/a.md')
    expect(window.api.saveFile).not.toHaveBeenCalled()
  })

  it('prompts once per dirty tab, including BACKGROUND tabs', async () => {
    // The whole reason this is not just "does the active tab need saving?":
    // useAutosave only ever sees the ACTIVE tab, so a dirty background tab has
    // no version-history snapshot to fall back on either.
    setTabs(
      [
        tab({ id: 'a', filePath: '/tmp/a.md', isDirty: true }),
        tab({ id: 'b', filePath: '/tmp/b.md', isDirty: true }),
        tab({ id: 'c', filePath: '/tmp/c.md' })
      ],
      'c'
    )
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('discard')

    await expect(confirmWindowClose()).resolves.toBe(true)
    expect(window.api.confirmDiscardChanges).toHaveBeenCalledTimes(2)
    // Each prompt names the document it is about, so three near-identical
    // dialogs in a row can be told apart.
    expect(window.api.confirmDiscardChanges).toHaveBeenCalledWith('a.md')
    expect(window.api.confirmDiscardChanges).toHaveBeenCalledWith('b.md')
  })

  it('makes the tab it is asking about the active one first', async () => {
    // Both because a dialog about an invisible document is unanswerable, and
    // because documentStore.save() only ever writes the ACTIVE tab -- "Save"
    // for a background tab is only reachable by switching to it.
    setTabs(
      [tab({ id: 'a', filePath: '/tmp/a.md', content: '# A', isDirty: true }), tab({ id: 'b' })],
      'b'
    )
    vi.mocked(window.api.confirmDiscardChanges).mockImplementation(async () => {
      expect(useDocumentStore.getState().activeTabId).toBe('a')
      return 'cancel'
    })

    await expect(confirmWindowClose()).resolves.toBe(false)
    expect(window.api.confirmDiscardChanges).toHaveBeenCalled()
  })

  it('navigates to the editor so the document being asked about is on screen', async () => {
    useAppStore.setState({ screen: 'home' })
    setTabs([tab({ id: 'a', filePath: '/tmp/a.md', isDirty: true })])
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('cancel')

    await confirmWindowClose()

    expect(useAppStore.getState().screen).toBe('editor')
  })

  it('flushes the live editor BEFORE reading any dirty flag', async () => {
    // @milkdown/plugin-listener's onChange is 200ms-debounced, so a document
    // edited moments before Cmd+W still reads isDirty: false. Without this
    // flush the guard waves a genuinely unsaved document straight through.
    setTabs([tab({ id: 'a', filePath: '/tmp/a.md', content: '# stale', isDirty: false })])
    setCloseGuardFlush(() => {
      useDocumentStore.getState().updateContentForTab('a', '# the edit the debounce swallowed')
    })
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('cancel')

    await expect(confirmWindowClose()).resolves.toBe(false)
    expect(window.api.confirmDiscardChanges).toHaveBeenCalledTimes(1)
  })

  it('terminates rather than looping when the last dirty tab is discarded', async () => {
    // closeTab never leaves zero tabs -- it replaces a discarded last tab with
    // a fresh blank one. That replacement is CLEAN, which is what stops the
    // per-dirty-tab loop cycling on it forever.
    setTabs([tab({ id: 'a', filePath: '/tmp/a.md', isDirty: true })])
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('discard')

    await expect(confirmWindowClose()).resolves.toBe(true)
    expect(window.api.confirmDiscardChanges).toHaveBeenCalledTimes(1)
    expect(useDocumentStore.getState().tabs).toHaveLength(1)
    expect(useDocumentStore.getState().tabs[0].isDirty).toBe(false)
  })
})
