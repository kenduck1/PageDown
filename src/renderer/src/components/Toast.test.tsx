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
})
