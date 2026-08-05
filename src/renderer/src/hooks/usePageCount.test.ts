import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { usePageCount } from './usePageCount'

beforeEach(() => {
  window.api = {
    openFile: vi.fn(),
    openPath: vi.fn(),
    saveFile: vi.fn(),
    getRecentFiles: vi.fn(),
    getThumbnail: vi.fn(),
    getTemplateThumbnail: vi.fn(),
    getPageCount: vi.fn(),
    confirmDiscardChanges: vi.fn()
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('usePageCount', () => {
  it('starts loading, then resolves with the fetched page count', async () => {
    vi.mocked(window.api.getPageCount).mockResolvedValue({ pageCount: 4 })
    const { result } = renderHook(() => usePageCount('# Doc', 0))

    expect(result.current.loading).toBe(true)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.pageCount).toBe(4)
    expect(result.current.error).toBeNull()
  })

  it('surfaces a rejected call as an error, not a thrown exception', async () => {
    vi.mocked(window.api.getPageCount).mockRejectedValue(new Error('harness timed out'))
    const { result } = renderHook(() => usePageCount('# Doc', 0))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.pageCount).toBeNull()
    expect(result.current.error).toBe('harness timed out')
  })

  it('debounces: does not call getPageCount before the debounce window elapses', () => {
    vi.useFakeTimers()
    vi.mocked(window.api.getPageCount).mockResolvedValue({ pageCount: 1 })

    renderHook(() => usePageCount('# Doc', 500))
    expect(window.api.getPageCount).not.toHaveBeenCalled()

    vi.advanceTimersByTime(499)
    expect(window.api.getPageCount).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(window.api.getPageCount).toHaveBeenCalledTimes(1)
  })

  it('debounces across rapid content changes: only fetches once, for the latest content', async () => {
    vi.useFakeTimers()
    vi.mocked(window.api.getPageCount).mockResolvedValue({ pageCount: 7 })

    const { rerender } = renderHook(({ content }) => usePageCount(content, 500), {
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
    expect(window.api.getPageCount).toHaveBeenCalledWith('abc')
  })

  it('re-fetches when content changes after the debounce settles', async () => {
    vi.mocked(window.api.getPageCount)
      .mockResolvedValueOnce({ pageCount: 1 })
      .mockResolvedValueOnce({ pageCount: 2 })

    const { result, rerender } = renderHook(({ content }) => usePageCount(content, 0), {
      initialProps: { content: 'first' }
    })
    await waitFor(() => expect(result.current.pageCount).toBe(1))

    rerender({ content: 'second' })
    await waitFor(() => expect(result.current.pageCount).toBe(2))

    expect(window.api.getPageCount).toHaveBeenCalledTimes(2)
  })

  it('ignores a stale in-flight response that resolves after a newer request', async () => {
    let resolveFirst: ((value: { pageCount: number }) => void) | undefined
    const firstCall = new Promise<{ pageCount: number }>((resolve) => {
      resolveFirst = resolve
    })
    vi.mocked(window.api.getPageCount)
      .mockReturnValueOnce(firstCall)
      .mockResolvedValueOnce({ pageCount: 99 })

    const { result, rerender } = renderHook(({ content }) => usePageCount(content, 0), {
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
