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
    getRecentFiles: vi.fn().mockResolvedValue([]),
    getThumbnail: vi.fn().mockResolvedValue({ dataUrl: 'data:image/png;base64,x', pageCount: 1 }),
    getTemplateThumbnail: vi
      .fn()
      .mockResolvedValue({ dataUrl: 'data:image/png;base64,x', pageCount: 1 })
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

  it('clears the error when "Dismiss" is clicked', async () => {
    vi.mocked(window.api.openFile).mockRejectedValue(new Error('Permission denied'))
    const user = userEvent.setup()
    render(<HomeScreen />)

    await user.click(screen.getByRole('button', { name: 'Open file…' }))
    expect(await screen.findByText('Permission denied')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(useDocumentStore.getState().error).toBeNull()
    expect(screen.queryByText('Permission denied')).not.toBeInTheDocument()
  })

  it('renders all 4 template cards', () => {
    render(<HomeScreen />)
    expect(screen.getByText('Blank')).toBeInTheDocument()
    expect(screen.getByText('Résumé')).toBeInTheDocument()
    expect(screen.getByText('Letter')).toBeInTheDocument()
    expect(screen.getByText('Report')).toBeInTheDocument()
  })

  it('creates a document with the résumé starter content and navigates on Résumé card click', async () => {
    const user = userEvent.setup()
    render(<HomeScreen />)

    await user.click(screen.getByText('Résumé'))

    expect(useDocumentStore.getState().content).toContain('Jordan Rivera')
    expect(useAppStore.getState().screen).toBe('editor')
  })

  it('shows an empty state when there are no recent files', async () => {
    vi.mocked(window.api.getRecentFiles).mockResolvedValue([])
    render(<HomeScreen />)
    expect(await screen.findByText('No recent documents yet')).toBeInTheDocument()
  })

  it('renders recent files and opens one on click', async () => {
    vi.mocked(window.api.getRecentFiles).mockResolvedValue([
      { filePath: '/tmp/report.md', editedAt: new Date().toISOString() }
    ])
    vi.mocked(window.api.openPath).mockResolvedValue({
      filePath: '/tmp/report.md',
      content: '# Report'
    })
    const user = userEvent.setup()
    render(<HomeScreen />)

    const row = await screen.findByText('report.md')
    await user.click(row)

    expect(useDocumentStore.getState().filePath).toBe('/tmp/report.md')
    expect(useAppStore.getState().screen).toBe('editor')
  })

  it('navigates to Settings when the Settings nav item is clicked', async () => {
    const user = userEvent.setup()
    render(<HomeScreen />)
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(useAppStore.getState().screen).toBe('settings')
  })
})
