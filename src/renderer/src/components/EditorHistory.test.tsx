import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditorHistory from './EditorHistory'

beforeEach(() => {
  window.api = {
    openFile: vi.fn(),
    openPath: vi.fn(),
    saveFile: vi.fn(),
    getRecentFiles: vi.fn(),
    getThumbnail: vi.fn(),
    getTemplateThumbnail: vi.fn(),
    getPageCount: vi.fn(),
    confirmDiscardChanges: vi.fn(),
    exportPdf: vi.fn(),
    autosaveSnapshot: vi.fn(),
    getVersionHistory: vi.fn().mockResolvedValue([]),
    restoreVersionContent: vi.fn(),
    clearPendingAutosave: vi.fn()
  }
})

afterEach(() => {
  cleanup()
})

describe('EditorHistory', () => {
  it('shows an honest empty state when the document has no history yet', async () => {
    render(<EditorHistory filePath="/a.md" onRestore={vi.fn()} />)
    expect(await screen.findByText('No saved versions yet.')).toBeInTheDocument()
  })

  it('shows nothing to fetch when filePath is null (unsaved document)', () => {
    render(<EditorHistory filePath={null} onRestore={vi.fn()} />)
    expect(window.api.getVersionHistory).not.toHaveBeenCalled()
    expect(screen.getByText(/save this document first/i)).toBeInTheDocument()
  })

  it('renders a grouped snapshot list and calls onRestore with fetched content when a snapshot is clicked', async () => {
    vi.mocked(window.api.getVersionHistory).mockResolvedValue([
      { id: 'a', timestamp: '2026-08-05T12:00:00.000Z', sizeBytes: 10 }
    ])
    vi.mocked(window.api.restoreVersionContent).mockResolvedValue('# Restored content')
    const onRestore = vi.fn()
    const user = userEvent.setup()
    render(<EditorHistory filePath="/a.md" onRestore={onRestore} />)

    const row = await screen.findByRole('button', { name: /restore/i })
    await user.click(row)

    await waitFor(() => {
      expect(window.api.restoreVersionContent).toHaveBeenCalledWith('/a.md', 'a')
    })
    expect(onRestore).toHaveBeenCalledWith('# Restored content')
  })

  it('does not render an expand toggle for a single-entry group', async () => {
    vi.mocked(window.api.getVersionHistory).mockResolvedValue([
      { id: 'a', timestamp: '2026-08-05T12:00:00.000Z', sizeBytes: 10 }
    ])
    render(<EditorHistory filePath="/a.md" onRestore={vi.fn()} />)

    await screen.findByRole('button', { name: /restore/i })
    expect(screen.queryByRole('button', { name: /show.*version/i })).not.toBeInTheDocument()
  })

  it('expands a multi-entry group to reveal its individual entries, and collapses it again', async () => {
    vi.mocked(window.api.getVersionHistory).mockResolvedValue([
      // newest-last, matching real storage order -- these three are all
      // within 10 minutes of each other, so groupSnapshots collapses them
      // into a single 3-entry group.
      { id: 'a', timestamp: '2026-08-05T12:00:00.000Z', sizeBytes: 10 },
      { id: 'b', timestamp: '2026-08-05T12:05:00.000Z', sizeBytes: 10 },
      { id: 'c', timestamp: '2026-08-05T12:09:00.000Z', sizeBytes: 10 }
    ])
    const user = userEvent.setup()
    render(<EditorHistory filePath="/a.md" onRestore={vi.fn()} />)

    const toggle = await screen.findByRole('button', { name: /show 3 versions in this group/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // The expand toggle's accessible name deliberately excludes the word
    // "restore" so it can never collide with the /restore/i query the
    // brief's own test (above) uses to find the restore control.
    expect(toggle.getAttribute('aria-label')).not.toMatch(/restore/i)

    // Collapsed: only the group's own top-level restore row is present --
    // no per-entry rows yet.
    expect(screen.getAllByRole('button', { name: /restore/i })).toHaveLength(1)

    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(
      screen.getByRole('button', { name: /hide 3 versions in this group/i })
    ).toBeInTheDocument()
    // Now the top-level row plus all three individual entries are
    // independently restorable.
    expect(screen.getAllByRole('button', { name: /restore/i })).toHaveLength(4)

    await user.click(screen.getByRole('button', { name: /hide 3 versions in this group/i }))

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getAllByRole('button', { name: /restore/i })).toHaveLength(1)
  })

  it('restores an individual entry from inside an expanded group, not just the group newest', async () => {
    vi.mocked(window.api.getVersionHistory).mockResolvedValue([
      { id: 'older', timestamp: '2026-08-05T12:00:00.000Z', sizeBytes: 10 },
      { id: 'newer', timestamp: '2026-08-05T12:05:00.000Z', sizeBytes: 10 }
    ])
    vi.mocked(window.api.restoreVersionContent).mockImplementation((_path, id) =>
      Promise.resolve(`content-for-${id}`)
    )
    const onRestore = vi.fn()
    const user = userEvent.setup()
    render(<EditorHistory filePath="/a.md" onRestore={onRestore} />)

    const toggle = await screen.findByRole('button', { name: /show 2 versions in this group/i })
    await user.click(toggle)

    const entryButtons = screen.getAllByRole('button', { name: /restore/i })
    // First entry is the group's own top-level row (the newest); the
    // individually-listed entries follow. Click the last one, which
    // corresponds to the oldest entry in the expanded list.
    await user.click(entryButtons[entryButtons.length - 1])

    await waitFor(() => {
      expect(window.api.restoreVersionContent).toHaveBeenCalledWith('/a.md', 'older')
    })
    expect(onRestore).toHaveBeenCalledWith('content-for-older')
  })

  it('re-fetches the history list after a restore completes', async () => {
    vi.mocked(window.api.getVersionHistory).mockResolvedValue([
      { id: 'a', timestamp: '2026-08-05T12:00:00.000Z', sizeBytes: 10 }
    ])
    vi.mocked(window.api.restoreVersionContent).mockResolvedValue('# Restored content')
    const user = userEvent.setup()
    render(<EditorHistory filePath="/a.md" onRestore={vi.fn()} />)

    const row = await screen.findByRole('button', { name: /restore/i })
    await user.click(row)

    await waitFor(() => {
      expect(window.api.getVersionHistory).toHaveBeenCalledTimes(2)
    })
  })
})
