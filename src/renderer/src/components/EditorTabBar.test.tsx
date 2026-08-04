import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
})
