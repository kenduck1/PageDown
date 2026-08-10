import { act } from 'react'
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

  // The next three tests cover onRequestCloseTab, which replaced the older
  // onCloseDirtyActiveTab. That prop only fired when the tab was BOTH dirty
  // AND active, so a dirty BACKGROUND tab was discarded with no confirmation
  // at all -- and unrecoverably, since useAutosave only ever snapshots the
  // ACTIVE tab. This component also cannot decide dirtiness for itself (the
  // 200ms onChange debounce means a just-edited tab still reads isDirty:
  // false), so the whole decision moved to the parent, which can flush first.
  it('clicking "x" routes EVERY close through onRequestCloseTab, including a DIRTY BACKGROUND tab', async () => {
    useDocumentStore.getState().openTab('/tmp/a.md', '# A', true)
    const backgroundId = useDocumentStore.getState().activeTabId
    // Opening b.md makes it active, leaving a.md dirty but in the background.
    useDocumentStore.getState().openTab('/tmp/b.md', '# B')
    const onRequestCloseTab = vi.fn()
    const user = userEvent.setup()
    render(<EditorTabBar onRequestCloseTab={onRequestCloseTab} />)

    await user.click(screen.getByRole('button', { name: 'Close a.md' }))

    expect(onRequestCloseTab).toHaveBeenCalledWith(backgroundId)
    expect(onRequestCloseTab).toHaveBeenCalledTimes(1)
    // The tab must still be open -- EditorTabBar defers the ENTIRE close
    // decision to the callback; it must not also call the store's closeTab
    // itself (that would close the tab twice-over: once for real here, and
    // again whenever the callback eventually decides to).
    expect(useDocumentStore.getState().tabs.some((tab) => tab.id === backgroundId)).toBe(true)
  })

  it('routes a CLEAN tab close through onRequestCloseTab too, rather than closing it directly', async () => {
    // A clean tab looks safe to close here, but only the parent can know that
    // for sure -- see this component's own prop comment on the debounce.
    useDocumentStore.getState().openTab('/tmp/a.md', '# A')
    const cleanId = useDocumentStore.getState().activeTabId
    const onRequestCloseTab = vi.fn()
    const user = userEvent.setup()
    render(<EditorTabBar onRequestCloseTab={onRequestCloseTab} />)

    await user.click(screen.getByRole('button', { name: 'Close a.md' }))

    expect(onRequestCloseTab).toHaveBeenCalledWith(cleanId)
    expect(useDocumentStore.getState().tabs.some((tab) => tab.id === cleanId)).toBe(true)
  })

  it('closes directly, with no callback, when no onRequestCloseTab prop is given at all', async () => {
    // Every pre-existing test in this file renders <EditorTabBar /> with no
    // props -- this locks in that the fallback degrades to the exact old
    // store-level behavior when the prop is simply absent.
    useDocumentStore.getState().openTab('/tmp/a.md', '# A', true)
    const activeId = useDocumentStore.getState().activeTabId
    const user = userEvent.setup()
    render(<EditorTabBar />)

    await user.click(screen.getByRole('button', { name: 'Close a.md' }))

    expect(useDocumentStore.getState().tabs.some((tab) => tab.id === activeId)).toBe(false)
  })

  // The unsaved-changes marker. It used to render unconditionally (a
  // decorative "kind tag" square), so it conveyed nothing -- isDirty reached
  // the UI in exactly one place, the status bar, for the active tab only.
  describe('unsaved-changes marker', () => {
    it('shows a named marker on exactly the dirty tabs', () => {
      useDocumentStore.getState().openTab('/tmp/dirty.md', '# D', true)
      useDocumentStore.getState().openTab('/tmp/clean.md', '# C')
      render(<EditorTabBar />)

      // Exactly one marker, for the one dirty tab -- not one per tab, which
      // is what the unconditional version rendered.
      const markers = screen.getAllByRole('img', { name: 'Unsaved changes' })
      expect(markers).toHaveLength(1)
      // Inside the dirty tab, not merely somewhere on screen.
      expect(screen.getByRole('tab', { name: 'dirty.md' })).toContainElement(markers[0])
      // Not conveyed by colour alone: a real title tooltip as well as the
      // accessible name.
      expect(markers[0]).toHaveAttribute('title', 'Unsaved changes')
    })

    it('drops the marker once the tab is saved', () => {
      useDocumentStore.getState().openTab('/tmp/dirty.md', '# D', true)
      const { rerender } = render(<EditorTabBar />)
      expect(screen.getAllByRole('img', { name: 'Unsaved changes' })).toHaveLength(1)

      act(() => {
        useDocumentStore.setState((state) => ({
          isDirty: false,
          tabs: state.tabs.map((tab) => ({ ...tab, isDirty: false }))
        }))
      })
      rerender(<EditorTabBar />)

      expect(screen.queryByRole('img', { name: 'Unsaved changes' })).not.toBeInTheDocument()
    })
  })
})
