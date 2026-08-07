import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditorHistory from './EditorHistory'
import type { SnapshotMeta } from '../../../preload/index.d'

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
    clearPendingAutosave: vi.fn(),
    setSplitPreviewBounds: vi.fn(),
    sendSplitPreviewDocument: vi.fn(),
    destroySplitPreview: vi.fn()
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

  // The main-process handlers themselves never reject (each catches
  // internally), but `ipcRenderer.invoke` can on its own account -- an
  // unregistered channel, a structured-clone failure -- and a future refactor
  // of those handlers could too. Before the final whole-branch review, none
  // of this component's .then() chains had a .catch, so such a rejection
  // produced an unhandled promise rejection AND (for the mount fetch) left
  // `loading` stuck at true forever: "Loading history…" with no way out but
  // switching sidebar tabs.
  it('degrades to the empty state instead of hanging on "Loading history…" when the history fetch rejects', async () => {
    vi.mocked(window.api.getVersionHistory).mockRejectedValue(new Error('IPC channel gone'))
    render(<EditorHistory filePath="/a.md" onRestore={vi.fn()} />)

    expect(await screen.findByText('No saved versions yet.')).toBeInTheDocument()
    expect(screen.queryByText('Loading history…')).not.toBeInTheDocument()
  })

  it('survives a rejected restore without an unhandled rejection, leaving the displayed list intact', async () => {
    vi.mocked(window.api.getVersionHistory).mockResolvedValue([
      { id: 'a', timestamp: '2026-08-05T12:00:00.000Z', sizeBytes: 10 }
    ])
    vi.mocked(window.api.restoreVersionContent).mockRejectedValue(new Error('IPC channel gone'))
    const onRestore = vi.fn()
    const user = userEvent.setup()
    render(<EditorHistory filePath="/a.md" onRestore={onRestore} />)

    const row = await screen.findByRole('button', { name: /restore/i })
    await user.click(row)

    // handleRestore is invoked as `void handleRestore(...)` from onClick, so
    // without the catch this rejection has nowhere to go -- Vitest reports an
    // unhandled rejection and fails the run. The visible assertions below are
    // the secondary half: the panel must stay usable and keep showing the
    // list it already had.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onRestore).not.toHaveBeenCalled()
    expect(screen.getAllByRole('button', { name: /restore/i })).toHaveLength(1)
  })

  it('survives a rejected post-restore refetch, keeping the restore itself successful', async () => {
    // The restore genuinely happened (onRestore was called); only the
    // cosmetic list refresh afterwards failed. That must not turn into an
    // unhandled rejection either.
    vi.mocked(window.api.getVersionHistory)
      .mockResolvedValueOnce([{ id: 'a', timestamp: '2026-08-05T12:00:00.000Z', sizeBytes: 10 }])
      .mockRejectedValue(new Error('IPC channel gone'))
    vi.mocked(window.api.restoreVersionContent).mockResolvedValue('# Restored content')
    const onRestore = vi.fn()
    const user = userEvent.setup()
    render(<EditorHistory filePath="/a.md" onRestore={onRestore} />)

    const row = await screen.findByRole('button', { name: /restore/i })
    await user.click(row)

    await waitFor(() => {
      expect(onRestore).toHaveBeenCalledWith('# Restored content')
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.getAllByRole('button', { name: /restore/i })).toHaveLength(1)
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

  it('re-fetches the history list only after the (possibly async) onRestore callback completes, not before', async () => {
    vi.mocked(window.api.getVersionHistory).mockResolvedValue([
      { id: 'a', timestamp: '2026-08-05T12:00:00.000Z', sizeBytes: 10 }
    ])
    vi.mocked(window.api.restoreVersionContent).mockResolvedValue('# Restored content')
    // A pending promise standing in for EditorScreen's real async gap
    // (flush + Save, a real IPC round trip) -- if handleRestore refetched
    // without awaiting this, getVersionHistory's second call would fire
    // immediately, before onRestore's own work (here, before
    // resolveOnRestore is ever called) has finished.
    let resolveOnRestore: () => void = () => {}
    const onRestore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveOnRestore = resolve
        })
    )
    const user = userEvent.setup()
    render(<EditorHistory filePath="/a.md" onRestore={onRestore} />)

    const row = await screen.findByRole('button', { name: /restore/i })
    await user.click(row)

    await waitFor(() => {
      expect(onRestore).toHaveBeenCalledWith('# Restored content')
    })
    // onRestore's own promise is still pending -- the refetch must not
    // have happened yet.
    expect(window.api.getVersionHistory).toHaveBeenCalledTimes(1)

    resolveOnRestore()

    await waitFor(() => {
      expect(window.api.getVersionHistory).toHaveBeenCalledTimes(2)
    })
  })

  it('does not let a stale fetch for a previous filePath overwrite a newer one that resolves first', async () => {
    // Two overlapping fetches, deliberately resolved OUT OF ORDER: the
    // SECOND (newer, for "/b.md") resolves first, then the STALE first
    // one (for "/a.md") resolves after -- exactly the case a slow
    // response for a document the user has already navigated away from
    // would produce. Without the latestRequestRef guard, the stale
    // response arriving last would silently win and overwrite the correct
    // list.
    let resolveFirst: (value: SnapshotMeta[]) => void = () => {}
    let resolveSecond: (value: SnapshotMeta[]) => void = () => {}
    const firstPromise = new Promise<SnapshotMeta[]>((resolve) => {
      resolveFirst = resolve
    })
    const secondPromise = new Promise<SnapshotMeta[]>((resolve) => {
      resolveSecond = resolve
    })
    const getVersionHistory = vi.mocked(window.api.getVersionHistory)
    getVersionHistory.mockReturnValueOnce(firstPromise)
    getVersionHistory.mockReturnValueOnce(secondPromise)

    const { rerender } = render(<EditorHistory filePath="/a.md" onRestore={vi.fn()} />)
    rerender(<EditorHistory filePath="/b.md" onRestore={vi.fn()} />)

    // "/b.md" has two snapshots more than 10 minutes apart -- two separate
    // top-level groups, i.e. two restore buttons -- distinguishable by
    // COUNT from "/a.md"'s single snapshot, so the assertion below doesn't
    // depend on locale-formatted label text.
    resolveSecond([
      { id: 'b-snap-1', timestamp: '2026-08-01T12:00:00.000Z', sizeBytes: 10 },
      { id: 'b-snap-2', timestamp: '2026-08-05T12:00:00.000Z', sizeBytes: 10 }
    ])
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /restore/i })).toHaveLength(2)
    })

    resolveFirst([{ id: 'a-snap', timestamp: '2026-08-05T11:00:00.000Z', sizeBytes: 10 }])
    // Give the stale response's own microtask/state-update every chance to
    // run (if the guard were missing, it would silently replace the
    // correct list) before asserting nothing changed.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(screen.getAllByRole('button', { name: /restore/i })).toHaveLength(2)
  })

  it('does not let a stale post-restore refetch for the PREVIOUS document overwrite the list of the document now being displayed after a mid-restore tab switch', async () => {
    // The exact composed race the individual F1 (tab-switch-safe restore)
    // and F3 (requestId staleness guard) fixes don't cover on their own:
    // handleRestore captures `filePath` ("/a.md") in its closure at click
    // time. Its `await onRestore(content)` gap (standing in for
    // EditorScreen's real flush+Save round trip) can span a tab switch to
    // a DIFFERENT document ("/b.md") -- now an explicitly SAFE, supported
    // action per replaceContentForTab's own fix. EditorHistory is never
    // remounted on that switch (EditorSidebar renders it with no `key`),
    // so the SAME component instance re-renders with the new `filePath`
    // prop, its effect correctly fetches and displays "/b.md"'s list, and
    // only THEN does the original handleRestore call finally resume and
    // fire its OWN refetch -- still for "/a.md", dispatched LAST. A
    // requestId-only guard would wave that through (it genuinely is the
    // most recently dispatched request); only the currentFilePathRef
    // identity check catches it.
    const aList: SnapshotMeta[] = [
      { id: 'a-snap', timestamp: '2026-08-05T11:00:00.000Z', sizeBytes: 10 }
    ]
    const bList: SnapshotMeta[] = [
      { id: 'b-snap-1', timestamp: '2026-08-01T12:00:00.000Z', sizeBytes: 10 },
      { id: 'b-snap-2', timestamp: '2026-08-05T12:00:00.000Z', sizeBytes: 10 }
    ]
    vi.mocked(window.api.getVersionHistory).mockImplementation((path) =>
      Promise.resolve(path === '/a.md' ? aList : bList)
    )
    vi.mocked(window.api.restoreVersionContent).mockResolvedValue('# Restored content')

    // Stands in for EditorScreen's real flush+Save async gap -- controlled
    // so the test can switch documents WHILE handleRestore's own
    // `await onRestore(content)` is still pending, matching the real
    // sequence step by step.
    let resolveOnRestore: () => void = () => {}
    const onRestore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveOnRestore = resolve
        })
    )

    const user = userEvent.setup()
    const { rerender } = render(<EditorHistory filePath="/a.md" onRestore={onRestore} />)

    const row = await screen.findByRole('button', { name: /restore/i })
    await user.click(row)

    await waitFor(() => {
      expect(onRestore).toHaveBeenCalled()
    })

    // The tab switch: EditorHistory is never remounted (no `key` in
    // EditorSidebar), so this is exactly what a real one produces -- a new
    // `filePath` prop on the SAME component instance, while the original
    // restore's own async work (still keyed to "/a.md") is still in flight.
    rerender(<EditorHistory filePath="/b.md" onRestore={onRestore} />)

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /restore/i })).toHaveLength(2)
    })

    // Now let the original restore's flush+Save gap finish -- handleRestore
    // resumes and fires its own refetch, still for "/a.md".
    resolveOnRestore()

    // Give that stale "/a.md" refetch every chance to resolve and (if the
    // identity guard were missing) overwrite "/b.md"'s correctly-displayed
    // list.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(screen.getAllByRole('button', { name: /restore/i })).toHaveLength(2)
  })
})
