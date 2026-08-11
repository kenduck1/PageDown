import { beforeEach, describe, expect, it } from 'vitest'
import { useDocumentStore, initialDocumentState } from './documentStore'

// A separate file from documentStore.test.ts, deliberately: `reorderTab` is
// the one tab action that touches no IPC at all, so these tests need none of
// that file's large `window.api` fixture -- and a test that needs no fixture
// should not be able to pass only because an unrelated fixture happened to be
// present.
beforeEach(() => {
  useDocumentStore.setState(initialDocumentState)
})

function openThree(): string[] {
  const store = useDocumentStore.getState()
  store.openTab('/tmp/a.md', '# A')
  store.openTab('/tmp/b.md', '# B')
  store.openTab('/tmp/c.md', '# C')
  return useDocumentStore.getState().tabs.map((tab) => tab.id)
}

function order(): (string | null)[] {
  return useDocumentStore.getState().tabs.map((tab) => tab.filePath)
}

describe('documentStore.reorderTab', () => {
  it('moves a tab to the requested FINAL index, rightward', () => {
    const ids = openThree()
    // [Untitled, a, b, c] -- move "a" (index 1) to index 3, i.e. the end.
    useDocumentStore.getState().reorderTab(ids[1], 3)

    expect(order()).toEqual([null, '/tmp/b.md', '/tmp/c.md', '/tmp/a.md'])
  })

  it('moves a tab to the requested FINAL index, leftward', () => {
    const ids = openThree()
    useDocumentStore.getState().reorderTab(ids[3], 0)

    expect(order()).toEqual(['/tmp/c.md', null, '/tmp/a.md', '/tmp/b.md'])
  })

  it('`toIndex` is the index the tab ENDS UP AT, not an insertion slot', () => {
    const ids = openThree()
    // The distinction only shows for a rightward move: asking for index 2 with
    // an insertion-slot reading would land "a" at index 1 (unchanged), because
    // removing it first shifts everything after it left.
    useDocumentStore.getState().reorderTab(ids[1], 2)

    expect(order()).toEqual([null, '/tmp/b.md', '/tmp/a.md', '/tmp/c.md'])
    expect(useDocumentStore.getState().tabs[2].id).toBe(ids[1])
  })

  it('clamps an out-of-range index instead of dropping or duplicating the tab', () => {
    const ids = openThree()
    useDocumentStore.getState().reorderTab(ids[0], 99)
    expect(order()).toEqual(['/tmp/a.md', '/tmp/b.md', '/tmp/c.md', null])

    useDocumentStore.getState().reorderTab(ids[0], -5)
    expect(order()).toEqual([null, '/tmp/a.md', '/tmp/b.md', '/tmp/c.md'])
    expect(useDocumentStore.getState().tabs).toHaveLength(4)
  })

  it('ignores an unknown tab id', () => {
    openThree()
    const before = order()
    useDocumentStore.getState().reorderTab('tab-does-not-exist', 0)
    expect(order()).toEqual(before)
  })

  // The four invariants reorderTab's own declaration comment commits to. Each
  // is a real failure mode, not a formality: switching tabs would swap the
  // canvas out mid-drag, a revision bump would remount MilkdownEditor (and
  // with it destroy the live editor's undo history) on every drag, and a
  // dirty flag would make tab ORDER -- which is not part of the .md file at
  // all -- look like unsaved document content.
  it('changes nothing but the array: not the active tab, mirror, revision, or dirtiness', () => {
    const ids = openThree()
    const before = useDocumentStore.getState()
    const activeBefore = before.activeTabId
    const revisionBefore = before.revision
    const contentBefore = before.content
    const pathBefore = before.filePath
    expect(before.isDirty).toBe(false)

    useDocumentStore.getState().reorderTab(ids[0], 3)

    const after = useDocumentStore.getState()
    expect(after.activeTabId).toBe(activeBefore)
    expect(after.revision).toBe(revisionBefore)
    expect(after.content).toBe(contentBefore)
    expect(after.filePath).toBe(pathBefore)
    expect(after.isDirty).toBe(false)
  })

  it('reordering a BACKGROUND tab does not make it active', () => {
    const ids = openThree()
    // "c" was opened last, so it is active; move the background "a".
    expect(useDocumentStore.getState().filePath).toBe('/tmp/c.md')

    useDocumentStore.getState().reorderTab(ids[1], 0)

    expect(useDocumentStore.getState().activeTabId).toBe(ids[3])
    expect(useDocumentStore.getState().filePath).toBe('/tmp/c.md')
  })

  it('a move to where the tab already is leaves the array object identical', () => {
    const ids = openThree()
    const tabsBefore = useDocumentStore.getState().tabs

    useDocumentStore.getState().reorderTab(ids[1], 1)

    // Identity, not just equality: the no-op path must not hand subscribers a
    // new array, which would re-render every consumer of `tabs` on each
    // dragover-then-drop-where-you-started.
    expect(useDocumentStore.getState().tabs).toBe(tabsBefore)
  })
})
