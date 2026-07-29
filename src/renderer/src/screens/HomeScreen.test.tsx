import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import HomeScreen from './HomeScreen'
import { useAppStore } from '../store/appStore'
import { useDocumentStore, initialDocumentState } from '../store/documentStore'

beforeEach(() => {
  useAppStore.setState({ screen: 'home' })
  useDocumentStore.setState(initialDocumentState)
  window.api = {
    openFile: vi.fn(),
    openPath: vi.fn(),
    saveFile: vi.fn(),
    getRecentFiles: vi.fn()
  }
})

afterEach(() => {
  cleanup()
})

describe('HomeScreen', () => {
  it('creates a blank untitled document and navigates to Editor on "New document"', async () => {
    const user = userEvent.setup()
    render(<HomeScreen />)

    await user.click(screen.getByRole('button', { name: 'New document' }))

    expect(useDocumentStore.getState().filePath).toBeNull()
    expect(useDocumentStore.getState().content).toBe('')
    expect(useAppStore.getState().screen).toBe('editor')
  })

  it('loads the opened file and navigates to Editor when Open file succeeds', async () => {
    vi.mocked(window.api.openFile).mockResolvedValue({
      filePath: '/tmp/example.md',
      content: '# Hello'
    })
    const user = userEvent.setup()
    render(<HomeScreen />)

    await user.click(screen.getByRole('button', { name: 'Open file…' }))

    expect(useDocumentStore.getState().filePath).toBe('/tmp/example.md')
    expect(useDocumentStore.getState().content).toBe('# Hello')
    expect(useAppStore.getState().screen).toBe('editor')
  })

  it('stays on Home and does not navigate when Open file is cancelled', async () => {
    vi.mocked(window.api.openFile).mockResolvedValue(null)
    const user = userEvent.setup()
    render(<HomeScreen />)

    await user.click(screen.getByRole('button', { name: 'Open file…' }))

    expect(useAppStore.getState().screen).toBe('home')
  })

  it('shows an inline error and stays on Home when Open file fails', async () => {
    vi.mocked(window.api.openFile).mockRejectedValue(new Error('Permission denied'))
    const user = userEvent.setup()
    render(<HomeScreen />)

    await user.click(screen.getByRole('button', { name: 'Open file…' }))

    expect(await screen.findByText('Permission denied')).toBeInTheDocument()
    expect(useAppStore.getState().screen).toBe('home')
  })
})
