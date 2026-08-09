import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import Toast from './Toast'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Toast', () => {
  it('renders nothing when message is null', () => {
    const { container } = render(<Toast message={null} onDismiss={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the message with role="status" when message is set', () => {
    render(<Toast message="Hello there" onDismiss={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Hello there')
  })

  it('calls onDismiss once after durationMs elapses', () => {
    const onDismiss = vi.fn()
    render(<Toast message="Hello there" onDismiss={onDismiss} durationMs={3000} />)
    expect(onDismiss).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2999)
    expect(onDismiss).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('does not call onDismiss if unmounted before durationMs elapses', () => {
    const onDismiss = vi.fn()
    const { unmount } = render(
      <Toast message="Hello there" onDismiss={onDismiss} durationMs={3000} />
    )
    unmount()
    vi.advanceTimersByTime(5000)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('defaults durationMs to 3000 when not provided', () => {
    const onDismiss = vi.fn()
    render(<Toast message="Hello there" onDismiss={onDismiss} />)
    vi.advanceTimersByTime(2999)
    expect(onDismiss).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('does not restart the timer when onDismiss is a new function reference on rerender (regression test for the caller-inline-closure bug)', () => {
    const onDismiss1 = vi.fn()
    const onDismiss2 = vi.fn()
    const { rerender } = render(
      <Toast message="Hello there" onDismiss={onDismiss1} durationMs={3000} />
    )
    vi.advanceTimersByTime(1500)
    // Re-render with a BRAND NEW function reference and the SAME message --
    // this is what EditorScreen's inline `onDismiss={() => setToast(null)}`
    // does on every unrelated re-render (e.g. the user typing).
    rerender(<Toast message="Hello there" onDismiss={onDismiss2} durationMs={3000} />)
    vi.advanceTimersByTime(1500)
    // Total elapsed: 3000ms. The LATEST onDismiss should have fired -- and
    // the timer must not have restarted at the rerender.
    expect(onDismiss2).toHaveBeenCalledTimes(1)
    expect(onDismiss1).not.toHaveBeenCalled()
  })
})
