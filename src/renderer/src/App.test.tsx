import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { useAppStore, initialAppState } from './store/appStore'

beforeEach(() => {
  useAppStore.setState(initialAppState)
  window.api = {
    openFile: vi.fn(),
    openPath: vi.fn(),
    saveFile: vi.fn(),
    getRecentFiles: vi.fn().mockResolvedValue([]),
    getThumbnail: vi.fn().mockResolvedValue({ dataUrl: 'data:image/png;base64,x', pageCount: 1 }),
    getTemplateThumbnail: vi
      .fn()
      .mockResolvedValue({ dataUrl: 'data:image/png;base64,x', pageCount: 1 }),
    confirmDiscardChanges: vi.fn(),
    exportPdf: vi.fn()
  }
})

afterEach(() => {
  cleanup()
})

describe('App', () => {
  it('renders the Home screen by default', () => {
    render(<App />)
    expect(screen.getByText('PageDown')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New document' })).toBeInTheDocument()
  })

  it('navigates to the Editor screen and back via user interaction', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'New document' }))
    expect(screen.getByText('Untitled')).toBeInTheDocument()
    expect(screen.queryByText('PageDown')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '← Home' }))
    expect(screen.getByText('PageDown')).toBeInTheDocument()
    expect(screen.queryByText('Untitled')).not.toBeInTheDocument()
  })
})
