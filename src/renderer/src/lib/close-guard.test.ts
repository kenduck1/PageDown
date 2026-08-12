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
    draftId: null,
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
    clearPendingAutosave: vi.fn(),
    // Crash protection for never-saved documents. Required (not optional) on
    // FileApi, so a missing entry here is a compile error rather than a
    // runtime surprise -- see index.d.ts for why that tradeoff was taken.
    autosaveUnsavedDraft: vi.fn().mockResolvedValue(null),
    listUnsavedDrafts: vi.fn().mockResolvedValue([]),
    readUnsavedDraft: vi.fn().mockResolvedValue(null),
    discardUnsavedDraft: vi.fn().mockResolvedValue(undefined)
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
    // edited moments before a window close (the red button, Cmd+Shift+W --
    // NOT Cmd+W, which closes the active tab instead and never reaches this
    // guard) still reads isDirty: false. Without this flush the guard waves
    // a genuinely unsaved document straight through.
    setTabs([tab({ id: 'a', filePath: '/tmp/a.md', content: '# stale', isDirty: false })])
    setCloseGuardFlush(() => {
      useDocumentStore.getState().updateContentForTab('a', '# the edit the debounce swallowed')
    })
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('cancel')

    await expect(confirmWindowClose()).resolves.toBe(false)
    expect(window.api.confirmDiscardChanges).toHaveBeenCalledTimes(1)
  })

  it('destroys NOTHING when a later tab is cancelled, after an earlier one was discarded', async () => {
    // BUG 1. The guard used to clear the autosave and close each tab AS IT WAS
    // ANSWERED, then return false on a later Cancel -- so "Cancel" did not
    // cancel: tab `a` was already gone, and its version-history snapshots
    // already cleared, by the time tab `b`'s prompt was even shown. This is
    // the document-level twin of the window-level bug main/index.ts's
    // `before-quit` handler already fixed, and states the principle for:
    // nothing may be destroyed until the whole decision is known.
    setTabs([
      tab({ id: 'a', filePath: '/tmp/a.md', isDirty: true }),
      tab({ id: 'b', filePath: '/tmp/b.md', isDirty: true })
    ])
    vi.mocked(window.api.confirmDiscardChanges).mockImplementation(async (label) =>
      label === 'a.md' ? 'discard' : 'cancel'
    )

    await expect(confirmWindowClose()).resolves.toBe(false)
    expect(window.api.clearPendingAutosave).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().tabs.map((t) => t.id)).toEqual(['a', 'b'])
    expect(useDocumentStore.getState().tabs.every((t) => t.isDirty)).toBe(true)
  })

  it('writes NOTHING when a later tab is cancelled, after an earlier one chose Save', async () => {
    // The same two-phase property from the write side. Saving is not
    // destructive, but deferring every action until the whole sequence has
    // been answered is what makes "Cancel" mean "put everything back" rather
    // than "stop here, keep whatever already happened".
    setTabs([
      tab({ id: 'a', filePath: '/tmp/a.md', content: '# A', isDirty: true }),
      tab({ id: 'b', filePath: '/tmp/b.md', isDirty: true })
    ])
    vi.mocked(window.api.confirmDiscardChanges).mockImplementation(async (label) =>
      label === 'a.md' ? 'save' : 'cancel'
    )

    await expect(confirmWindowClose()).resolves.toBe(false)
    expect(window.api.saveFile).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().tabs.every((t) => t.isDirty)).toBe(true)
  })

  it('applies every decision once the whole sequence is answered', async () => {
    // The other half of the two-phase split: a run that reaches the end must
    // still genuinely save what was answered "Save" and discard what was
    // answered "Don't Save".
    setTabs([
      tab({ id: 'a', filePath: '/tmp/a.md', content: '# A', isDirty: true }),
      tab({ id: 'b', filePath: '/tmp/b.md', isDirty: true })
    ])
    vi.mocked(window.api.confirmDiscardChanges).mockImplementation(async (label) =>
      label === 'a.md' ? 'save' : 'discard'
    )
    vi.mocked(window.api.saveFile).mockResolvedValue({ filePath: '/tmp/a.md', mtimeMs: 1 })

    await expect(confirmWindowClose()).resolves.toBe(true)
    expect(window.api.saveFile).toHaveBeenCalledWith('/tmp/a.md', '# A', null)
    expect(window.api.clearPendingAutosave).toHaveBeenCalledWith('/tmp/b.md')
    expect(useDocumentStore.getState().tabs.map((t) => t.id)).toEqual(['a'])
  })

  it('discards nothing when a deferred Save fails', async () => {
    // Every save runs before any discard, so a save that turns out to have
    // failed -- which is only discoverable in phase two, after every prompt
    // has been answered -- still leaves the other tab's work intact.
    //
    // The DISCARDED tab is deliberately first in the list: that is the order
    // in which the old close-as-you-go loop reached it before ever attempting
    // the save that fails, so this reproduces a real discard-then-fail rather
    // than passing on the strength of the failing save simply coming first.
    setTabs([
      tab({ id: 'b', filePath: '/tmp/b.md', isDirty: true }),
      tab({ id: 'a', filePath: null, content: '# Untitled work', isDirty: true })
    ])
    vi.mocked(window.api.confirmDiscardChanges).mockImplementation(async (label) =>
      label === 'Untitled' ? 'save' : 'discard'
    )
    // A cancelled Save-As dialog: this codebase's own "the write didn't happen".
    vi.mocked(window.api.saveFile).mockResolvedValue(null)

    await expect(confirmWindowClose()).resolves.toBe(false)
    expect(window.api.clearPendingAutosave).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().tabs.map((t) => t.id)).toEqual(['b', 'a'])
  })

  it('refuses to close when Save was answered "Reload" at the external-change dialog', async () => {
    // BUG 2. Reload writes nothing and deliberately records no version-history
    // snapshot (the content captured before the await is the user's now-
    // DISCARDED edit -- snapshotting it would make the very next open silently
    // "recover" the edit the user just chose to throw away). Correct for a
    // save; catastrophic during a close, because the guard then saw a clean
    // tab and closed the window: the edits were gone with no recovery path,
    // and the user never even got to look at the disk content they had just
    // asked to load.
    //
    // So Reload aborts the close. It is a request to SEE something, not an
    // answer to "save before closing?", and honouring it means leaving the
    // window open on what was loaded.
    setTabs([tab({ id: 'a', filePath: '/tmp/a.md', content: '# my edit', isDirty: true })])
    vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('save')
    vi.mocked(window.api.saveFile).mockResolvedValue({
      filePath: '/tmp/a.md',
      mtimeMs: 7000,
      reloadedContent: '# what is on disk now'
    })

    await expect(confirmWindowClose()).resolves.toBe(false)
    // The tab survives, showing what was loaded rather than what was lost.
    const tabs = useDocumentStore.getState().tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0].content).toBe('# what is on disk now')
  })

  it('discards nothing when a deferred Save is answered "Reload"', async () => {
    // The Reload abort has to land in the same place a failed save does --
    // before ANY discard runs -- or the two-phase guarantee holds for one kind
    // of unsuccessful save and not the other.
    setTabs([
      tab({ id: 'b', filePath: '/tmp/b.md', isDirty: true }),
      tab({ id: 'a', filePath: '/tmp/a.md', content: '# my edit', isDirty: true })
    ])
    vi.mocked(window.api.confirmDiscardChanges).mockImplementation(async (label) =>
      label === 'a.md' ? 'save' : 'discard'
    )
    vi.mocked(window.api.saveFile).mockResolvedValue({
      filePath: '/tmp/a.md',
      mtimeMs: 7000,
      reloadedContent: '# what is on disk now'
    })

    await expect(confirmWindowClose()).resolves.toBe(false)
    expect(window.api.clearPendingAutosave).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().tabs.map((t) => t.id)).toEqual(['b', 'a'])
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
