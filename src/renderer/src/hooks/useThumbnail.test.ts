import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useThumbnail } from './useThumbnail'

describe('useThumbnail', () => {
  it('starts loading, then resolves with the fetched thumbnail', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ dataUrl: 'data:image/png;base64,abc', pageCount: 3 })
    const { result } = renderHook(() => useThumbnail('key-1', fetcher))

    expect(result.current.loading).toBe(true)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.dataUrl).toBe('data:image/png;base64,abc')
    expect(result.current.pageCount).toBe(3)
  })

  it('re-fetches when key changes', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ dataUrl: 'data:image/png;base64,first', pageCount: 1 })
      .mockResolvedValueOnce({ dataUrl: 'data:image/png;base64,second', pageCount: 2 })

    const { result, rerender } = renderHook(({ key }) => useThumbnail(key, fetcher), {
      initialProps: { key: 'key-1' }
    })
    await waitFor(() => expect(result.current.dataUrl).toBe('data:image/png;base64,first'))

    rerender({ key: 'key-2' })
    await waitFor(() => expect(result.current.dataUrl).toBe('data:image/png;base64,second'))

    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
