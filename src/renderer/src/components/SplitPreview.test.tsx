import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import SplitPreview from './SplitPreview'

describe('SplitPreview', () => {
  beforeEach(() => {
    window.api = {
      ...window.api,
      setSplitPreviewBounds: vi.fn(),
      sendSplitPreviewDocument: vi.fn().mockResolvedValue({ pageCount: 1 }),
      destroySplitPreview: vi.fn(),
      scrollSplitPreviewToPage: vi.fn().mockResolvedValue({ currentPage: 1, pageCount: 3 }),
      getSplitPreviewPage: vi.fn().mockResolvedValue({ currentPage: 1, pageCount: 3 })
    } as typeof window.api
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders a placeholder div for the ResizeObserver/WebContentsView to target', () => {
    const { getByTestId } = render(
      <SplitPreview
        content="# Hi"
        filePath={null}
        pageSetupOpen={false}
        targetPage={1}
        onPageChange={vi.fn()}
      />
    )
    expect(getByTestId('split-preview-placeholder')).toBeInTheDocument()
  })

  it('reports bounds and sends the document on mount', async () => {
    render(
      <SplitPreview
        content="# Hi"
        filePath={null}
        pageSetupOpen={false}
        targetPage={1}
        onPageChange={vi.fn()}
      />
    )
    await waitFor(() => {
      expect(window.api.setSplitPreviewBounds).toHaveBeenCalled()
      expect(window.api.sendSplitPreviewDocument).toHaveBeenCalledWith('# Hi', null)
    })
  })

  it('calls destroySplitPreview on unmount', () => {
    const { unmount } = render(
      <SplitPreview
        content="# Hi"
        filePath={null}
        pageSetupOpen={false}
        targetPage={1}
        onPageChange={vi.fn()}
      />
    )
    unmount()
    expect(window.api.destroySplitPreview).toHaveBeenCalled()
  })

  it('debounces content updates -- rapid content changes send only the final value, after 500ms', async () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <SplitPreview
        content="a"
        filePath={null}
        pageSetupOpen={false}
        targetPage={1}
        onPageChange={vi.fn()}
      />
    )
    rerender(
      <SplitPreview
        content="ab"
        filePath={null}
        pageSetupOpen={false}
        targetPage={1}
        onPageChange={vi.fn()}
      />
    )
    rerender(
      <SplitPreview
        content="abc"
        filePath={null}
        pageSetupOpen={false}
        targetPage={1}
        onPageChange={vi.fn()}
      />
    )
    await vi.advanceTimersByTimeAsync(500)
    // Mount's own immediate send (content 'a') plus exactly one debounced
    // send for the settled final value -- not one call per rerender.
    expect(window.api.sendSplitPreviewDocument).toHaveBeenCalledTimes(2)
    expect(window.api.sendSplitPreviewDocument).toHaveBeenLastCalledWith('abc', null)
    vi.useRealTimers()
  })

  // Fix round 1 (review finding): a naive dedup guard that records
  // lastSentRef BEFORE the send promise settles would treat a FAILED mount
  // send as "delivered" -- so a user opening Split mode on an
  // already-written document, with no further edit, would see a
  // permanently blank preview for the rest of that mount (the debounced
  // effect would compare content equal to the falsely-recorded value and
  // never retry). This is real, not theoretical: the split-preview harness
  // genuinely rejects sendDocument on a 10s timeout, a pagination error, or
  // the post-destroy guard (src/main/split-preview-window.ts), and cold
  // start (harness process still spinning up) is a plausible time for that.
  it('retries the send after the mount attempt fails, rather than treating the failed attempt as delivered', async () => {
    vi.useFakeTimers()
    const sendDocument = vi
      .fn()
      .mockRejectedValueOnce(new Error('harness timed out'))
      .mockResolvedValue({ pageCount: 1 })
    window.api.sendSplitPreviewDocument = sendDocument

    const { rerender } = render(
      <SplitPreview
        content="# Hi"
        filePath={null}
        pageSetupOpen={false}
        targetPage={1}
        onPageChange={vi.fn()}
      />
    )
    // Let the mount effect's rejected promise (and its .catch()) settle
    // before doing anything else, so lastSentRef's post-fix "only stamp on
    // success" behavior has had its chance to run.
    await vi.advanceTimersByTimeAsync(0)

    // A same-content, same-filePath rerender -- ordinary React re-render
    // noise, not an edit -- must not itself count as, or block, a retry.
    rerender(
      <SplitPreview
        content="# Hi"
        filePath={null}
        pageSetupOpen={false}
        targetPage={1}
        onPageChange={vi.fn()}
      />
    )
    await vi.advanceTimersByTimeAsync(500)

    // Mount's failed attempt (call 1) plus the debounced effect's retry,
    // which only fires because lastSentRef was never stamped for content
    // that failed to send.
    expect(sendDocument).toHaveBeenCalledTimes(2)
    expect(sendDocument).toHaveBeenLastCalledWith('# Hi', null)
    vi.useRealTimers()
  })

  // Final whole-branch review finding, I2 (Important): a WebContentsView
  // composites above ALL DOM, so the native preview was painting over Page
  // Setup's modal, including its own Apply/Cancel buttons. No setVisible
  // primitive exists on the preload surface -- these tests cover the
  // zero-size-bounds mitigation instead (see the pageSetupOpen prop's own
  // doc comment in SplitPreview.tsx).
  it('reports zero-size bounds instead of the real rectangle while pageSetupOpen is true', async () => {
    render(
      <SplitPreview
        content="# Hi"
        filePath={null}
        pageSetupOpen={true}
        targetPage={1}
        onPageChange={vi.fn()}
      />
    )
    await waitFor(() => {
      expect(window.api.setSplitPreviewBounds).toHaveBeenCalledWith({
        x: 0,
        y: 0,
        width: 0,
        height: 0
      })
    })
  })

  it('restores the real bounds when pageSetupOpen transitions back to false, even with no resize', async () => {
    const setSplitPreviewBounds = vi.fn()
    window.api.setSplitPreviewBounds = setSplitPreviewBounds
    const { rerender } = render(
      <SplitPreview
        content="# Hi"
        filePath={null}
        pageSetupOpen={true}
        targetPage={1}
        onPageChange={vi.fn()}
      />
    )
    await waitFor(() => {
      expect(setSplitPreviewBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    })

    rerender(
      <SplitPreview
        content="# Hi"
        filePath={null}
        pageSetupOpen={false}
        targetPage={1}
        onPageChange={vi.fn()}
      />
    )

    // No ResizeObserver/'resize' event fires here -- jsdom gives every
    // element a 0x0 getBoundingClientRect() regardless, so this asserts the
    // real code path (reportBounds re-invoked because the bounds effect
    // depends on pageSetupOpen) rather than the specific non-zero numbers a
    // real layout engine would produce, which is exactly what this test is
    // for: proving the transition alone re-reports bounds, not that a resize
    // did.
    await waitFor(() => {
      expect(setSplitPreviewBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 })
      // The effect ran again for this transition (not just once at mount) --
      // distinguishes "reported zero because pageSetupOpen re-triggered it"
      // from "reported zero because that's jsdom's only value and the effect
      // never re-ran at all."
      expect(setSplitPreviewBounds.mock.calls.length).toBeGreaterThan(1)
    })
  })

  // Task 6 (Page Navigation): SplitPreview applies a requested page by
  // scrolling the native preview, and reports back what page it actually
  // settled on (both an immediate scroll result and a periodic poll for a
  // manual scroll the user performed inside the native view, which this
  // component has no other way to observe). Nested in the outer describe
  // block above rather than a second top-level one, so these tests reuse
  // its existing window.api/beforeEach/afterEach setup instead of
  // duplicating it.
  describe('page navigation', () => {
    function renderPreview(
      targetPage: number,
      onPageChange: (state: { currentPage: number; pageCount: number }) => void = vi.fn()
    ): ReturnType<typeof render> & { onPageChange: typeof onPageChange } {
      return {
        onPageChange,
        ...render(
          <SplitPreview
            content="# Hi"
            filePath={null}
            pageSetupOpen={false}
            targetPage={targetPage}
            onPageChange={onPageChange}
          />
        )
      }
    }

    it('does not scroll on mount for page 1 (nothing to move to)', async () => {
      renderPreview(1)
      await waitFor(() => expect(window.api.sendSplitPreviewDocument).toHaveBeenCalled())
      expect(window.api.scrollSplitPreviewToPage).not.toHaveBeenCalled()
    })

    it('scrolls on mount when it mounts already targeting a later page', async () => {
      // This is the format -> split path: EditorScreen sets currentPage AND
      // switches mode in one handler, so this component's very first render
      // already carries the requested page. A preview always starts at page
      // 1, so this must still issue a scroll -- lastAppliedPageRef has to be
      // seeded to 1, NOT to targetPage, for this to happen (see the ref's
      // own comment in SplitPreview.tsx).
      renderPreview(3)
      await waitFor(() => expect(window.api.scrollSplitPreviewToPage).toHaveBeenCalledWith(3))
    })

    it('scrolls when targetPage changes', async () => {
      const { rerender, onPageChange } = renderPreview(1)
      rerender(
        <SplitPreview
          content="# Hi"
          filePath={null}
          pageSetupOpen={false}
          targetPage={3}
          onPageChange={onPageChange}
        />
      )
      await waitFor(() => expect(window.api.scrollSplitPreviewToPage).toHaveBeenCalledWith(3))
    })

    it('reports the page the sandbox actually settled on, not the one requested', async () => {
      const scrollSplitPreviewToPage = vi.fn().mockResolvedValue({ currentPage: 2, pageCount: 2 })
      window.api.scrollSplitPreviewToPage = scrollSplitPreviewToPage
      const onPageChange = vi.fn()
      const { rerender } = renderPreview(1, onPageChange)
      rerender(
        <SplitPreview
          content="# Hi"
          filePath={null}
          pageSetupOpen={false}
          targetPage={9}
          onPageChange={onPageChange}
        />
      )
      await waitFor(() =>
        expect(onPageChange).toHaveBeenCalledWith({ currentPage: 2, pageCount: 2 })
      )
    })

    it('reports a manual scroll detected by the poll', async () => {
      vi.useFakeTimers()
      const getSplitPreviewPage = vi.fn().mockResolvedValue({ currentPage: 5, pageCount: 8 })
      window.api.getSplitPreviewPage = getSplitPreviewPage
      const { onPageChange } = renderPreview(1)
      await vi.advanceTimersByTimeAsync(1200)
      expect(onPageChange).toHaveBeenCalledWith({ currentPage: 5, pageCount: 8 })
      vi.useRealTimers()
    })

    it('does NOT scroll back to a page the poll just reported (no feedback loop)', async () => {
      vi.useFakeTimers()
      const getSplitPreviewPage = vi.fn().mockResolvedValue({ currentPage: 5, pageCount: 8 })
      window.api.getSplitPreviewPage = getSplitPreviewPage
      const onPageChange = vi.fn()
      const { rerender } = renderPreview(1, onPageChange)
      await vi.advanceTimersByTimeAsync(1200)
      expect(onPageChange).toHaveBeenCalledWith({ currentPage: 5, pageCount: 8 })

      // The parent owns currentPage and echoes the polled value back down as
      // the new target -- without the ref guard this would trigger a scroll
      // to 5, fighting the user's own scrolling on every poll tick.
      rerender(
        <SplitPreview
          content="# Hi"
          filePath={null}
          pageSetupOpen={false}
          targetPage={5}
          onPageChange={onPageChange}
        />
      )
      await vi.advanceTimersByTimeAsync(50)
      expect(window.api.scrollSplitPreviewToPage).not.toHaveBeenCalled()
      vi.useRealTimers()
    })
  })
})
