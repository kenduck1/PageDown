import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { renderHook } from '@testing-library/react'
import { useDebouncedValue } from './useDebouncedValue'

afterEach(() => {
  vi.useRealTimers()
})

describe('useDebouncedValue', () => {
  it('reflects the initial value immediately, with no delay', () => {
    const { result } = renderHook(() => useDebouncedValue('first', 200))
    expect(result.current).toBe('first')
  })

  it('does not advance to a new value before delayMs has elapsed', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 200), {
      initialProps: { value: 'a' }
    })

    rerender({ value: 'b' })
    act(() => {
      vi.advanceTimersByTime(199)
    })

    expect(result.current).toBe('a')
  })

  it('advances to the new value once delayMs has elapsed', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 200), {
      initialProps: { value: 'a' }
    })

    rerender({ value: 'b' })
    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(result.current).toBe('b')
  })

  it('collapses a fast burst of changes into just the final settled value', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 200), {
      initialProps: { value: 'a' }
    })

    // Each rerender arrives before the previous timer fires -- exactly a
    // fast typing burst -- so only the LAST one should ever be observed.
    rerender({ value: 'ab' })
    act(() => {
      vi.advanceTimersByTime(50)
    })
    rerender({ value: 'abc' })
    act(() => {
      vi.advanceTimersByTime(50)
    })
    rerender({ value: 'abcd' })
    expect(result.current).toBe('a')

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(result.current).toBe('abcd')
  })

  it('cancels the pending timer on unmount (no late setState-after-unmount)', () => {
    vi.useFakeTimers()
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')
    const { rerender, unmount } = renderHook(({ value }) => useDebouncedValue(value, 200), {
      initialProps: { value: 'a' }
    })

    rerender({ value: 'b' })
    unmount()

    expect(clearTimeoutSpy).toHaveBeenCalled()
    // Advancing after unmount must not throw (React would warn/error on a
    // setState call against an unmounted component if the timer weren't
    // actually cleared).
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(500)
      })
    }).not.toThrow()
  })
})
