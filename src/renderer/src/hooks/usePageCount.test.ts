import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { usePageCount } from './usePageCount'

beforeEach(() => {
  window.api = {
    openFile: vi.fn(),
    openPath: vi.fn(),
    saveFile: vi.fn(),
    getRecentFiles: vi.fn(),
    removeRecentFile: vi.fn(),
    clearRecentFiles: vi.fn(),
    getThumbnail: vi.fn(),
    getTemplateThumbnail: vi.fn(),
    getPageCount: vi.fn(),
    confirmDiscardChanges: vi.fn(),
    exportPdf: vi.fn(),
    print: vi.fn(),
    getPreferences: vi.fn(),
    setPreferences: vi.fn(),
    autosaveSnapshot: vi.fn(),
    getVersionHistory: vi.fn(),
    restoreVersionContent: vi.fn(),
    clearPendingAutosave: vi.fn(),
    setSplitPreviewBounds: vi.fn(),
    sendSplitPreviewDocument: vi.fn(),
    destroySplitPreview: vi.fn(),
    scrollSplitPreviewToPage: vi.fn(),
    getSplitPreviewPage: vi.fn(),
    saveDroppedImage: vi.fn(),
    openInNewWindow: vi.fn(),
    // The application menu's two channels. Both are stubbed in every
    // window.api fixture because window.api is a fully-typed FileApi here --
    // a missing method is a compile error, not just a runtime one.
    // onMenuCommand must return a real unsubscribe FUNCTION: App.tsx and
    // EditorScreen both call it from an effect cleanup, and a bare vi.fn()
    // returning undefined would throw on unmount.
    onMenuCommand: vi.fn().mockReturnValue(() => {}),
    setWindowState: vi.fn(),
    // The window-close guard's two channels. onWindowCloseRequest must
    // return a real unsubscribe FUNCTION -- App.tsx calls it from an effect
    // cleanup, same contract as onMenuCommand above.
    onWindowCloseRequest: vi.fn().mockReturnValue(() => {}),
    respondToWindowClose: vi.fn(),
    getStartupWarnings: vi.fn().mockResolvedValue([]),
    getAppVersion: vi.fn().mockResolvedValue('1.0.0')
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('usePageCount', () => {
  it('starts loading, then resolves with the fetched page count', async () => {
    vi.mocked(window.api.getPageCount).mockResolvedValue({ pageCount: 4 })
    const { result } = renderHook(() => usePageCount('# Doc', null, 0))

    expect(result.current.loading).toBe(true)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.pageCount).toBe(4)
    expect(result.current.error).toBeNull()
  })

  it('surfaces a rejected call as an error, not a thrown exception', async () => {
    vi.mocked(window.api.getPageCount).mockRejectedValue(new Error('harness timed out'))
    const { result } = renderHook(() => usePageCount('# Doc', null, 0))

    await waitFor(() => expect(result.current.loading).toBe(false))
    // Null HERE is correct and is the one meaning `null` carries: this
    // document's count was never successfully computed at all, so there is
    // no last known-good value to fall back to. Contrast the retention test
    // below, where there is one.
    expect(result.current.pageCount).toBeNull()
    expect(result.current.error).toBe('harness timed out')
  })

  it('retains the last known-good page count when a later fetch fails', async () => {
    // design:189 -- the page count "shows the last known-good value with a
    // subtle in-progress indicator, never blank or flickering." Before this,
    // the catch below set `pageCount: null`, so a single transient harness
    // failure (its 10s timeout, or one render throwing) dropped the status
    // bar to a literal em-dash for a document whose length had not changed
    // and was already known.
    vi.mocked(window.api.getPageCount)
      .mockResolvedValueOnce({ pageCount: 12 })
      .mockRejectedValueOnce(new Error('Pagination harness timed out waiting for a result'))

    const { result, rerender } = renderHook(({ content }) => usePageCount(content, null, 0), {
      initialProps: { content: 'first' }
    })
    await waitFor(() => expect(result.current.pageCount).toBe(12))

    rerender({ content: 'second' })
    await waitFor(() =>
      expect(result.current.error).toBe('Pagination harness timed out waiting for a result')
    )

    expect(result.current.pageCount).toBe(12)
    expect(result.current.loading).toBe(false)
  })

  it('recovers to the fresh count once a fetch succeeds again after a failure', async () => {
    // The other half of retention: holding the stale value must not be
    // sticky. A retained count that never updated again would be a worse bug
    // than the blank it replaced.
    vi.mocked(window.api.getPageCount)
      .mockResolvedValueOnce({ pageCount: 12 })
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ pageCount: 3 })

    const { result, rerender } = renderHook(({ content }) => usePageCount(content, null, 0), {
      initialProps: { content: 'first' }
    })
    await waitFor(() => expect(result.current.pageCount).toBe(12))

    rerender({ content: 'second' })
    await waitFor(() => expect(result.current.error).toBe('transient'))
    expect(result.current.pageCount).toBe(12)

    rerender({ content: 'third' })
    await waitFor(() => expect(result.current.pageCount).toBe(3))
    expect(result.current.error).toBeNull()
  })

  it('debounces: does not call getPageCount before the debounce window elapses', () => {
    vi.useFakeTimers()
    vi.mocked(window.api.getPageCount).mockResolvedValue({ pageCount: 1 })

    renderHook(() => usePageCount('# Doc', null, 500))
    expect(window.api.getPageCount).not.toHaveBeenCalled()

    vi.advanceTimersByTime(499)
    expect(window.api.getPageCount).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(window.api.getPageCount).toHaveBeenCalledTimes(1)
  })

  it('debounces across rapid content changes: only fetches once, for the latest content', async () => {
    vi.useFakeTimers()
    vi.mocked(window.api.getPageCount).mockResolvedValue({ pageCount: 7 })

    const { rerender } = renderHook(({ content }) => usePageCount(content, null, 500), {
      initialProps: { content: 'a' }
    })
    vi.advanceTimersByTime(100)
    rerender({ content: 'ab' })
    vi.advanceTimersByTime(100)
    rerender({ content: 'abc' })

    // Only 200ms have elapsed since the last (3rd) content change at any
    // point so far -- well under the 500ms debounce window, so nothing
    // should have fired yet for any of the three content values.
    expect(window.api.getPageCount).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(500)

    expect(window.api.getPageCount).toHaveBeenCalledTimes(1)
    expect(window.api.getPageCount).toHaveBeenCalledWith('abc', null, false)
  })

  it("forwards the document's file path, so local asset references can resolve", async () => {
    vi.mocked(window.api.getPageCount).mockResolvedValue({ pageCount: 2 })

    const { result } = renderHook(() => usePageCount('# Doc', '/docs/report.md', 0))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(window.api.getPageCount).toHaveBeenCalledWith('# Doc', '/docs/report.md', false)
  })

  it('re-fetches when only the file path changes', async () => {
    // Identical content in two different directories genuinely paginates
    // differently once local images load (`./figures/chart.png` resolves to a
    // different file, of a different size, per directory) -- so the path has
    // to be part of what this hook re-fetches on, not a value it captures
    // once and ignores.
    vi.mocked(window.api.getPageCount)
      .mockResolvedValueOnce({ pageCount: 1 })
      .mockResolvedValueOnce({ pageCount: 9 })

    const { result, rerender } = renderHook(({ path }) => usePageCount('same', path, 0), {
      initialProps: { path: '/a/doc.md' }
    })
    await waitFor(() => expect(result.current.pageCount).toBe(1))

    rerender({ path: '/b/doc.md' })
    await waitFor(() => expect(result.current.pageCount).toBe(9))

    expect(window.api.getPageCount).toHaveBeenNthCalledWith(1, 'same', '/a/doc.md', false)
    expect(window.api.getPageCount).toHaveBeenNthCalledWith(2, 'same', '/b/doc.md', false)
  })

  it('re-fetches when only the remote-image consent decision changes', async () => {
    // The same class of bug the path case above guards, on a second axis: a
    // document with remote images genuinely paginates differently once those
    // images actually load, and clicking "Load" in the consent banner moves
    // neither `content` nor `filePath`. Without `allowRemoteImages` in this
    // hook's own dependency array the status bar would keep showing the
    // pre-consent count until some unrelated edit happened to invalidate it
    // -- and the main process's own cache (page-count-generator.ts's
    // `lastAllowRemoteImages`) would return the stale value even then.
    vi.mocked(window.api.getPageCount)
      .mockResolvedValueOnce({ pageCount: 1 })
      .mockResolvedValueOnce({ pageCount: 4 })

    const { result, rerender } = renderHook(
      ({ allow }) => usePageCount('same', '/a/doc.md', 0, allow),
      { initialProps: { allow: false } }
    )
    await waitFor(() => expect(result.current.pageCount).toBe(1))

    rerender({ allow: true })
    await waitFor(() => expect(result.current.pageCount).toBe(4))

    expect(window.api.getPageCount).toHaveBeenNthCalledWith(1, 'same', '/a/doc.md', false)
    expect(window.api.getPageCount).toHaveBeenNthCalledWith(2, 'same', '/a/doc.md', true)
  })

  it('re-fetches when content changes after the debounce settles', async () => {
    vi.mocked(window.api.getPageCount)
      .mockResolvedValueOnce({ pageCount: 1 })
      .mockResolvedValueOnce({ pageCount: 2 })

    const { result, rerender } = renderHook(({ content }) => usePageCount(content, null, 0), {
      initialProps: { content: 'first' }
    })
    await waitFor(() => expect(result.current.pageCount).toBe(1))

    rerender({ content: 'second' })
    await waitFor(() => expect(result.current.pageCount).toBe(2))

    expect(window.api.getPageCount).toHaveBeenCalledTimes(2)
  })

  it('keeps the last known page count visible (not null) while a new fetch is in flight', async () => {
    let resolveSecond: ((value: { pageCount: number }) => void) | undefined
    const secondCall = new Promise<{ pageCount: number }>((resolve) => {
      resolveSecond = resolve
    })
    vi.mocked(window.api.getPageCount)
      .mockResolvedValueOnce({ pageCount: 5 })
      .mockReturnValueOnce(secondCall)

    const { result, rerender } = renderHook(({ content }) => usePageCount(content, null, 0), {
      initialProps: { content: 'first' }
    })
    await waitFor(() => expect(result.current.pageCount).toBe(5))
    expect(result.current.loading).toBe(false)

    rerender({ content: 'second' })
    // The new fetch hasn't resolved yet -- loading flips true, but the
    // previously-known count must stay visible rather than flashing back
    // to null (this is what a status bar re-fetching on every debounce
    // cycle during active typing would otherwise do constantly).
    await waitFor(() => expect(result.current.loading).toBe(true))
    expect(result.current.pageCount).toBe(5)

    resolveSecond?.({ pageCount: 6 })
    await waitFor(() => expect(result.current.pageCount).toBe(6))
    expect(result.current.loading).toBe(false)
  })

  it('ignores a stale in-flight response that resolves after a newer request', async () => {
    let resolveFirst: ((value: { pageCount: number }) => void) | undefined
    const firstCall = new Promise<{ pageCount: number }>((resolve) => {
      resolveFirst = resolve
    })
    vi.mocked(window.api.getPageCount)
      .mockReturnValueOnce(firstCall)
      .mockResolvedValueOnce({ pageCount: 99 })

    const { result, rerender } = renderHook(({ content }) => usePageCount(content, null, 0), {
      initialProps: { content: 'first' }
    })
    await waitFor(() => expect(window.api.getPageCount).toHaveBeenCalledTimes(1))

    rerender({ content: 'second' })
    await waitFor(() => expect(result.current.pageCount).toBe(99))

    // The first call's slow response arrives AFTER the second (newer) one
    // already resolved and was applied -- it must not overwrite state with
    // the stale value.
    resolveFirst?.({ pageCount: 1 })
    await new Promise((r) => setTimeout(r, 10))
    expect(result.current.pageCount).toBe(99)
  })
})
