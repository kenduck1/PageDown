import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

import { useAutosave } from './useAutosave'

beforeEach(() => {
  vi.useFakeTimers()
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
    autosaveSnapshot: vi.fn().mockResolvedValue(undefined),
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
  vi.useRealTimers()
})

describe('useAutosave', () => {
  it('does not call autosaveSnapshot before 45 seconds have elapsed', () => {
    renderHook(() => useAutosave({ content: '# Doc', filePath: '/a.md', isDirty: true }))
    vi.advanceTimersByTime(44_000)
    expect(window.api.autosaveSnapshot).not.toHaveBeenCalled()
  })

  it('calls autosaveSnapshot with content and filePath after 45 seconds while dirty', () => {
    renderHook(() => useAutosave({ content: '# Doc', filePath: '/a.md', isDirty: true }))
    vi.advanceTimersByTime(45_000)
    expect(window.api.autosaveSnapshot).toHaveBeenCalledWith('# Doc', '/a.md')
  })

  it('does not call autosaveSnapshot when isDirty is false', () => {
    renderHook(() => useAutosave({ content: '# Doc', filePath: '/a.md', isDirty: false }))
    vi.advanceTimersByTime(90_000)
    expect(window.api.autosaveSnapshot).not.toHaveBeenCalled()
  })

  it('does not call autosaveSnapshot when filePath is null (unsaved document)', () => {
    renderHook(() => useAutosave({ content: '# Doc', filePath: null, isDirty: true }))
    vi.advanceTimersByTime(90_000)
    expect(window.api.autosaveSnapshot).not.toHaveBeenCalled()
  })

  it('keeps ticking on the same interval across multiple 45s windows', () => {
    renderHook(() => useAutosave({ content: '# Doc', filePath: '/a.md', isDirty: true }))
    vi.advanceTimersByTime(45_000)
    vi.advanceTimersByTime(45_000)
    expect(window.api.autosaveSnapshot).toHaveBeenCalledTimes(2)
  })

  // Controller-resolved decision: the 45s countdown must start when the
  // document BECOMES DIRTY, not free-run from mount. A free-running timer
  // that happened to land within 2 seconds after a real Save writes its own
  // snapshot would tick again inside the window Task 2's recovery check
  // ignores (it requires a snapshot to be more than 2s newer than the
  // file's on-disk mtime) -- so a crash before the NEXT tick would lose an
  // edit with zero protection. Driving the effect off isDirty, so it resets
  // on every clean->dirty transition, rules this out structurally: the
  // countdown only ever starts fresh on the user's next real edit.
  it('restarts the 45s countdown on a clean-to-dirty transition rather than continuing a timer started at mount', () => {
    const { rerender } = renderHook(
      ({ isDirty }) => useAutosave({ content: '# Doc', filePath: '/a.md', isDirty }),
      { initialProps: { isDirty: false } }
    )

    // Advance most of a 45s window while still clean -- proves no timer is
    // silently running in the background from mount time.
    vi.advanceTimersByTime(40_000)
    expect(window.api.autosaveSnapshot).not.toHaveBeenCalled()

    // Transition to dirty: the countdown should start fresh from here, not
    // from wherever a mount-time timer would already be.
    rerender({ isDirty: true })

    // 40s (clean) + 10s (dirty) = 50s since mount, which is already past
    // 45s -- if the timer had free-run from mount rather than resetting on
    // the transition, it would have fired by now. It must not have.
    vi.advanceTimersByTime(10_000)
    expect(window.api.autosaveSnapshot).not.toHaveBeenCalled()

    // The remaining 35s since the dirty transition (10s + 35s = 45s) should
    // now fire it exactly once.
    vi.advanceTimersByTime(35_000)
    expect(window.api.autosaveSnapshot).toHaveBeenCalledTimes(1)
  })

  // Regression guard for the diff's highest-risk behavior: the effect's
  // dependency array must stay `[isDirty]`, NOT grow to include `content`
  // (or `filePath`). A reader who notices the effect closes over `content`/
  // `filePath` via `latestRef` might reasonably assume exhaustive-deps wants
  // them listed -- but adding them would restart the interval on every
  // keystroke, meaning autosave would NEVER fire during continuous typing
  // (a silent, total defeat of the feature) with an otherwise fully green
  // test suite, since every other test here holds `content` static. This
  // test interleaves content changes with sub-45s timer advances while
  // `isDirty` stays continuously `true`, and asserts the snapshot still
  // fires exactly once at the cumulative 45s mark -- which only holds if
  // content changes do NOT reset the timer -- AND that it fires with the
  // LATEST content, proving the latestRef pattern (not a stale closure) is
  // what's actually feeding the eventual call.
  it('does not restart the countdown on content changes while continuously dirty, and fires with the LATEST content at the 45s mark', () => {
    const { rerender } = renderHook(
      ({ content }) => useAutosave({ content, filePath: '/a.md', isDirty: true }),
      { initialProps: { content: '# v1' } }
    )

    vi.advanceTimersByTime(10_000)
    rerender({ content: '# v2' })
    vi.advanceTimersByTime(10_000)
    rerender({ content: '# v3' })
    vi.advanceTimersByTime(10_000)
    rerender({ content: '# v4 latest' })
    vi.advanceTimersByTime(10_000)

    // 40s cumulative since mount -- not yet at the 45s mark.
    expect(window.api.autosaveSnapshot).not.toHaveBeenCalled()

    // The remaining 5s (40s + 5s = 45s since MOUNT, not since the last
    // content change) should now fire it -- proving the single mount-time
    // interval survived every intervening content change untouched.
    vi.advanceTimersByTime(5_000)
    expect(window.api.autosaveSnapshot).toHaveBeenCalledTimes(1)
    expect(window.api.autosaveSnapshot).toHaveBeenCalledWith('# v4 latest', '/a.md')
  })

  it('stops the countdown when the document transitions from dirty back to clean before the interval fires', () => {
    const { rerender } = renderHook(
      ({ isDirty }) => useAutosave({ content: '# Doc', filePath: '/a.md', isDirty }),
      { initialProps: { isDirty: true } }
    )

    vi.advanceTimersByTime(30_000)
    rerender({ isDirty: false })
    // If the original timer had kept running regardless of the clean
    // transition, this would tip it over the 45s mark (30s + 30s = 60s).
    vi.advanceTimersByTime(30_000)
    expect(window.api.autosaveSnapshot).not.toHaveBeenCalled()
  })
})
