import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditorTabBar from './EditorTabBar'
import { useDocumentStore, initialDocumentState } from '../store/documentStore'

beforeEach(() => {
  useDocumentStore.setState(initialDocumentState)
})

afterEach(() => {
  cleanup()
})

describe('EditorTabBar', () => {
  it('renders one tab per open document', () => {
    useDocumentStore.getState().openTab('/tmp/a.md', '# A')
    useDocumentStore.getState().openTab('/tmp/b.md', '# B')
    render(<EditorTabBar />)

    // The initial blank tab plus the two opened above.
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(screen.getByRole('tab', { name: 'Untitled' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'a.md' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'b.md' })).toBeInTheDocument()
  })

  it('marks exactly the active tab as selected', () => {
    useDocumentStore.getState().openTab('/tmp/a.md', '# A')
    render(<EditorTabBar />)

    expect(screen.getByRole('tab', { name: 'a.md' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Untitled' })).toHaveAttribute('aria-selected', 'false')
  })

  it('clicking a tab switches the active one', async () => {
    useDocumentStore.getState().openTab('/tmp/a.md', '# A')
    const tabAId = useDocumentStore.getState().activeTabId
    useDocumentStore.getState().openTab('/tmp/b.md', '# B')
    const user = userEvent.setup()
    render(<EditorTabBar />)

    // "b.md" is currently active; clicking "a.md" should switch to it.
    await user.click(screen.getByRole('tab', { name: 'a.md' }))

    expect(useDocumentStore.getState().activeTabId).toBe(tabAId)
    expect(useDocumentStore.getState()).toMatchObject({ content: '# A', filePath: '/tmp/a.md' })
    expect(screen.getByRole('tab', { name: 'a.md' })).toHaveAttribute('aria-selected', 'true')
  })

  it('clicking "+" opens a new blank tab and makes it active', async () => {
    const before = useDocumentStore.getState().tabs.length
    const user = userEvent.setup()
    render(<EditorTabBar />)

    await user.click(screen.getByRole('button', { name: 'New tab' }))

    const state = useDocumentStore.getState()
    expect(state.tabs).toHaveLength(before + 1)
    expect(state).toMatchObject({ content: '', filePath: null })
    expect(screen.getAllByRole('tab')).toHaveLength(before + 1)
  })

  it('clicking "x" closes that tab', async () => {
    useDocumentStore.getState().openTab('/tmp/a.md', '# A')
    useDocumentStore.getState().openTab('/tmp/b.md', '# B')
    const user = userEvent.setup()
    render(<EditorTabBar />)

    await user.click(screen.getByRole('button', { name: 'Close a.md' }))

    expect(screen.queryByRole('tab', { name: 'a.md' })).not.toBeInTheDocument()
    expect(useDocumentStore.getState().tabs.some((tab) => tab.filePath === '/tmp/a.md')).toBe(false)
    // Closing a background tab must not switch the active one away from b.md.
    expect(useDocumentStore.getState().filePath).toBe('/tmp/b.md')
  })

  it('closing the active tab switches the displayed tab without leaving zero tabs', async () => {
    useDocumentStore.getState().openTab('/tmp/a.md', '# A')
    const user = userEvent.setup()
    render(<EditorTabBar />)

    // "a.md" is active; close it via its own close button.
    await user.click(screen.getByRole('button', { name: 'Close a.md' }))

    expect(screen.queryByRole('tab', { name: 'a.md' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(useDocumentStore.getState().tabs).toHaveLength(1)
  })

  // The next four tests cover the onCloseDirtyActiveTab discriminator added
  // for the dirty-tab-close-confirmation fix: it must defer to the callback
  // in exactly one case (dirty AND active AND a callback is provided) and
  // fall through to the store's own closeTab, unchanged, in every other
  // case -- a clean tab (active or background), a dirty background tab, or
  // a dirty active tab when no callback prop was given at all (so every
  // pre-existing test above, which renders <EditorTabBar /> with no props,
  // keeps working unmodified).
  it('clicking "x" on a DIRTY ACTIVE tab calls onCloseDirtyActiveTab instead of closing it directly', async () => {
    useDocumentStore.getState().openTab('/tmp/a.md', '# A', true)
    const activeId = useDocumentStore.getState().activeTabId
    const onCloseDirtyActiveTab = vi.fn()
    const user = userEvent.setup()
    render(<EditorTabBar onCloseDirtyActiveTab={onCloseDirtyActiveTab} />)

    await user.click(screen.getByRole('button', { name: 'Close a.md' }))

    expect(onCloseDirtyActiveTab).toHaveBeenCalledWith(activeId)
    expect(onCloseDirtyActiveTab).toHaveBeenCalledTimes(1)
    // The tab must still be open -- EditorTabBar defers the ENTIRE close
    // decision to the callback in this case; it must not also call the
    // store's closeTab itself (that would close the tab twice-over: once
    // for real here, and again whenever the callback eventually decides to).
    expect(useDocumentStore.getState().tabs.some((tab) => tab.id === activeId)).toBe(true)
  })

  it('clicking "x" on a DIRTY BACKGROUND tab still closes it immediately, without invoking onCloseDirtyActiveTab', async () => {
    useDocumentStore.getState().openTab('/tmp/a.md', '# A', true)
    // Opening b.md makes it active, leaving a.md dirty but in the background
    // -- the disclosed, deliberately-unfixed gap this test locks in.
    useDocumentStore.getState().openTab('/tmp/b.md', '# B')
    const onCloseDirtyActiveTab = vi.fn()
    const user = userEvent.setup()
    render(<EditorTabBar onCloseDirtyActiveTab={onCloseDirtyActiveTab} />)

    await user.click(screen.getByRole('button', { name: 'Close a.md' }))

    expect(onCloseDirtyActiveTab).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().tabs.some((tab) => tab.filePath === '/tmp/a.md')).toBe(false)
  })

  it('clicking "x" on a CLEAN active tab still closes it immediately, without invoking onCloseDirtyActiveTab', async () => {
    useDocumentStore.getState().openTab('/tmp/a.md', '# A')
    const onCloseDirtyActiveTab = vi.fn()
    const user = userEvent.setup()
    render(<EditorTabBar onCloseDirtyActiveTab={onCloseDirtyActiveTab} />)

    await user.click(screen.getByRole('button', { name: 'Close a.md' }))

    expect(onCloseDirtyActiveTab).not.toHaveBeenCalled()
    expect(screen.queryByRole('tab', { name: 'a.md' })).not.toBeInTheDocument()
  })

  it('clicking "x" on a CLEAN background tab still closes it immediately, without invoking onCloseDirtyActiveTab', async () => {
    useDocumentStore.getState().openTab('/tmp/a.md', '# A')
    useDocumentStore.getState().openTab('/tmp/b.md', '# B')
    const onCloseDirtyActiveTab = vi.fn()
    const user = userEvent.setup()
    render(<EditorTabBar onCloseDirtyActiveTab={onCloseDirtyActiveTab} />)

    await user.click(screen.getByRole('button', { name: 'Close a.md' }))

    expect(onCloseDirtyActiveTab).not.toHaveBeenCalled()
    expect(screen.queryByRole('tab', { name: 'a.md' })).not.toBeInTheDocument()
  })

  it('closes a dirty active tab directly, with no callback, when no onCloseDirtyActiveTab prop is given at all', async () => {
    // Every pre-existing test in this file renders <EditorTabBar /> with no
    // props -- this locks in that the "not dirty" fast path this diff adds
    // (`isDirty && tabId === activeTabId && onCloseDirtyActiveTab`) degrades
    // to the exact old behavior when the prop is simply absent, not just
    // when the tab happens to be clean.
    useDocumentStore.getState().openTab('/tmp/a.md', '# A', true)
    const activeId = useDocumentStore.getState().activeTabId
    const user = userEvent.setup()
    render(<EditorTabBar />)

    await user.click(screen.getByRole('button', { name: 'Close a.md' }))

    expect(useDocumentStore.getState().tabs.some((tab) => tab.id === activeId)).toBe(false)
  })
})
