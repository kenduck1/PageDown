import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSplitFollowScroll } from './useSplitFollowScroll'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// A plain scrollTop-bearing stand-in -- jsdom has no real layout engine
// (CLAUDE.md: "do not assert real scroll positions there"), so this hook is
// tested purely as arithmetic-plus-timing against a fake element with a
// writable `scrollTop`, never against anything a real browser would compute.
function makeScrollRef(initialScrollTop = 0): { current: HTMLDivElement } {
  return { current: { scrollTop: initialScrollTop } as HTMLDivElement }
}

const CONTENT_HEIGHT_PX = 864 // matches page-nav.test.ts's own fixture value
const FOLLOW_INTERVAL_MS = 500
const IN_FLIGHT_TIMEOUT_MS = 3000

describe('useSplitFollowScroll', () => {
  it('does nothing while disabled, however far the pane has scrolled', () => {
    const scrollElementRef = makeScrollRef(5000)
    const onNavigate = vi.fn()
    renderHook(() =>
      useSplitFollowScroll({
        enabled: false,
        scrollElementRef,
        contentHeightPx: CONTENT_HEIGHT_PX,
        pageCount: 20,
        onNavigate
      })
    )
    vi.advanceTimersByTime(FOLLOW_INTERVAL_MS * 5)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('does not dispatch on activation for the position the pane already sits at', () => {
    // The load-bearing regression this hook's own module comment documents:
    // a freshly-mounted Split(format) page card always starts at scrollTop 0
    // regardless of what page was just requested (e.g. via "Next page").
    // Seeding from that position, rather than from null, must NOT produce an
    // immediate onNavigate(1) call that would snap the preview back to page
    // 1 and undo the navigation that just happened.
    const scrollElementRef = makeScrollRef(0)
    const onNavigate = vi.fn()
    renderHook(() =>
      useSplitFollowScroll({
        enabled: true,
        scrollElementRef,
        contentHeightPx: CONTENT_HEIGHT_PX,
        pageCount: 20,
        onNavigate
      })
    )
    vi.advanceTimersByTime(FOLLOW_INTERVAL_MS * 3)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('dispatches an estimated page once the pane scrolls to a new position', () => {
    const scrollElementRef = makeScrollRef(0)
    const onNavigate = vi.fn()
    renderHook(() =>
      useSplitFollowScroll({
        enabled: true,
        scrollElementRef,
        contentHeightPx: CONTENT_HEIGHT_PX,
        pageCount: 20,
        onNavigate
      })
    )
    // Scroll past two content-heights -- page 3.
    scrollElementRef.current.scrollTop = CONTENT_HEIGHT_PX * 2 + 10
    vi.advanceTimersByTime(FOLLOW_INTERVAL_MS)
    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledWith(3)
  })

  it('does not re-dispatch the same estimate on every tick (loop does not re-trigger)', () => {
    const scrollElementRef = makeScrollRef(0)
    const onNavigate = vi.fn()
    const { result } = renderHook(() =>
      useSplitFollowScroll({
        enabled: true,
        scrollElementRef,
        contentHeightPx: CONTENT_HEIGHT_PX,
        pageCount: 20,
        onNavigate
      })
    )
    scrollElementRef.current.scrollTop = CONTENT_HEIGHT_PX * 2
    vi.advanceTimersByTime(FOLLOW_INTERVAL_MS)
    expect(onNavigate).toHaveBeenCalledTimes(1)
    // Simulate the confirmation that would normally arrive via
    // SplitPreview's own onPageChange -- without it the in-flight guard
    // itself would already suppress a second call, which would make this
    // test indistinguishable from the in-flight guard test below. Settling
    // it isolates the claim this test makes: an UNCHANGED scroll position
    // does not re-trigger, independent of the in-flight guard.
    result.current.notifySettled()
    // Many more ticks pass with the pane sitting at the exact same spot.
    vi.advanceTimersByTime(FOLLOW_INTERVAL_MS * 10)
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('the in-flight guard suppresses a burst of distinct estimates until settled', () => {
    // This is the risk CLAUDE.md documents at length for the 400ms poll:
    // SplitPreview's own targetPage effect has no cancellation, so each
    // DISTINCT dispatched value independently queues a real IPC call onto
    // the shared, serialized harness queue. Without the in-flight guard, a
    // continuous scroll through several pages across several ticks would
    // queue one call per tick; this test proves only the FIRST of a burst
    // goes out while nothing has confirmed the previous one settled yet.
    const scrollElementRef = makeScrollRef(0)
    const onNavigate = vi.fn()
    renderHook(() =>
      useSplitFollowScroll({
        enabled: true,
        scrollElementRef,
        contentHeightPx: CONTENT_HEIGHT_PX,
        pageCount: 20,
        onNavigate
      })
    )
    scrollElementRef.current.scrollTop = CONTENT_HEIGHT_PX * 1 // page 2
    vi.advanceTimersByTime(FOLLOW_INTERVAL_MS)
    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenLastCalledWith(2)

    // Keep scrolling further WITHOUT ever confirming settlement -- three
    // more ticks, three more distinct positions.
    scrollElementRef.current.scrollTop = CONTENT_HEIGHT_PX * 2
    vi.advanceTimersByTime(FOLLOW_INTERVAL_MS)
    scrollElementRef.current.scrollTop = CONTENT_HEIGHT_PX * 3
    vi.advanceTimersByTime(FOLLOW_INTERVAL_MS)
    scrollElementRef.current.scrollTop = CONTENT_HEIGHT_PX * 4
    vi.advanceTimersByTime(FOLLOW_INTERVAL_MS)

    // Still just the one call from before -- every later tick was skipped
    // because the guard was never cleared.
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('a real settle (notifySettled) lets the very next tick dispatch again', () => {
    const scrollElementRef = makeScrollRef(0)
    const onNavigate = vi.fn()
    const { result } = renderHook(() =>
      useSplitFollowScroll({
        enabled: true,
        scrollElementRef,
        contentHeightPx: CONTENT_HEIGHT_PX,
        pageCount: 20,
        onNavigate
      })
    )
    scrollElementRef.current.scrollTop = CONTENT_HEIGHT_PX * 1
    vi.advanceTimersByTime(FOLLOW_INTERVAL_MS)
    expect(onNavigate).toHaveBeenCalledTimes(1)

    result.current.notifySettled()
    scrollElementRef.current.scrollTop = CONTENT_HEIGHT_PX * 5
    vi.advanceTimersByTime(FOLLOW_INTERVAL_MS)
    expect(onNavigate).toHaveBeenCalledTimes(2)
    expect(onNavigate).toHaveBeenLastCalledWith(6)
  })

  it('the safety timeout self-clears the guard even with no settle signal at all', () => {
    const scrollElementRef = makeScrollRef(0)
    const onNavigate = vi.fn()
    renderHook(() =>
      useSplitFollowScroll({
        enabled: true,
        scrollElementRef,
        contentHeightPx: CONTENT_HEIGHT_PX,
        pageCount: 20,
        onNavigate
      })
    )
    scrollElementRef.current.scrollTop = CONTENT_HEIGHT_PX * 1
    vi.advanceTimersByTime(FOLLOW_INTERVAL_MS)
    expect(onNavigate).toHaveBeenCalledTimes(1)

    // No notifySettled() call anywhere -- a genuinely failed/sentinel
    // response that never reaches onPageChange. The pane keeps moving.
    // Advanced one tick PAST the safety timeout's own deadline, rather than
    // to it exactly, so this doesn't depend on how the fake-timer engine
    // breaks a tie between a setInterval tick and a setTimeout landing at
    // the exact same virtual millisecond (both are scheduled from this
    // hook, and that ordering is an implementation detail of neither this
    // hook nor this test).
    scrollElementRef.current.scrollTop = CONTENT_HEIGHT_PX * 8
    vi.advanceTimersByTime(IN_FLIGHT_TIMEOUT_MS + FOLLOW_INTERVAL_MS)
    expect(onNavigate).toHaveBeenCalledTimes(2)
    expect(onNavigate).toHaveBeenLastCalledWith(9)
  })

  it('ignores pageCount === null and pageCount <= 0 -- nothing to follow to yet', () => {
    const scrollElementRef = makeScrollRef(CONTENT_HEIGHT_PX * 3)
    const onNavigate = vi.fn()
    const { rerender } = renderHook(
      ({ pageCount }: { pageCount: number | null }) =>
        useSplitFollowScroll({
          enabled: true,
          scrollElementRef,
          contentHeightPx: CONTENT_HEIGHT_PX,
          pageCount,
          onNavigate
        }),
      { initialProps: { pageCount: null as number | null } }
    )
    vi.advanceTimersByTime(FOLLOW_INTERVAL_MS * 2)
    expect(onNavigate).not.toHaveBeenCalled()

    rerender({ pageCount: 0 })
    vi.advanceTimersByTime(FOLLOW_INTERVAL_MS * 2)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('stops sampling once unmounted', () => {
    const scrollElementRef = makeScrollRef(0)
    const onNavigate = vi.fn()
    const { unmount } = renderHook(() =>
      useSplitFollowScroll({
        enabled: true,
        scrollElementRef,
        contentHeightPx: CONTENT_HEIGHT_PX,
        pageCount: 20,
        onNavigate
      })
    )
    unmount()
    scrollElementRef.current.scrollTop = CONTENT_HEIGHT_PX * 4
    vi.advanceTimersByTime(FOLLOW_INTERVAL_MS * 5)
    expect(onNavigate).not.toHaveBeenCalled()
  })
})
