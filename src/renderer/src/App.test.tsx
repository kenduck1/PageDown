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
    getPageCount: vi.fn().mockResolvedValue({ pageCount: 1 }),
    confirmDiscardChanges: vi.fn(),
    exportPdf: vi.fn(),
    print: vi.fn(),
    autosaveSnapshot: vi.fn(),
    getVersionHistory: vi.fn(),
    restoreVersionContent: vi.fn(),
    clearPendingAutosave: vi.fn(),
    setSplitPreviewBounds: vi.fn(),
    sendSplitPreviewDocument: vi.fn(),
    destroySplitPreview: vi.fn(),
    scrollSplitPreviewToPage: vi.fn(),
    getSplitPreviewPage: vi.fn()
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
    // Two elements legitimately show "Untitled" on the editor screen -- the
    // title bar's filename readout and the tab bar's active-tab label
    // (EditorTabBar) -- both fall back to it independently.
    expect(screen.getAllByText('Untitled').length).toBeGreaterThan(0)
    expect(screen.queryByText('PageDown')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '← Home' }))
    expect(screen.getByText('PageDown')).toBeInTheDocument()
    expect(screen.queryAllByText('Untitled')).toHaveLength(0)
  })
})
