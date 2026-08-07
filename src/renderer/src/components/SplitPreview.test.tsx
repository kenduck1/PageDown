import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import SplitPreview from './SplitPreview'

describe('SplitPreview', () => {
  beforeEach(() => {
    window.api = {
      ...window.api,
      setSplitPreviewBounds: vi.fn(),
      sendSplitPreviewDocument: vi.fn().mockResolvedValue({ pageCount: 1 }),
      destroySplitPreview: vi.fn()
    } as typeof window.api
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders a placeholder div for the ResizeObserver/WebContentsView to target', () => {
    const { getByTestId } = render(<SplitPreview content="# Hi" filePath={null} />)
    expect(getByTestId('split-preview-placeholder')).toBeInTheDocument()
  })

  it('reports bounds and sends the document on mount', async () => {
    render(<SplitPreview content="# Hi" filePath={null} />)
    await waitFor(() => {
      expect(window.api.setSplitPreviewBounds).toHaveBeenCalled()
      expect(window.api.sendSplitPreviewDocument).toHaveBeenCalledWith('# Hi', null)
    })
  })

  it('calls destroySplitPreview on unmount', () => {
    const { unmount } = render(<SplitPreview content="# Hi" filePath={null} />)
    unmount()
    expect(window.api.destroySplitPreview).toHaveBeenCalled()
  })

  it('debounces content updates -- rapid content changes send only the final value, after 500ms', async () => {
    vi.useFakeTimers()
    const { rerender } = render(<SplitPreview content="a" filePath={null} />)
    rerender(<SplitPreview content="ab" filePath={null} />)
    rerender(<SplitPreview content="abc" filePath={null} />)
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

    const { rerender } = render(<SplitPreview content="# Hi" filePath={null} />)
    // Let the mount effect's rejected promise (and its .catch()) settle
    // before doing anything else, so lastSentRef's post-fix "only stamp on
    // success" behavior has had its chance to run.
    await vi.advanceTimersByTimeAsync(0)

    // A same-content, same-filePath rerender -- ordinary React re-render
    // noise, not an edit -- must not itself count as, or block, a retry.
    rerender(<SplitPreview content="# Hi" filePath={null} />)
    await vi.advanceTimersByTimeAsync(500)

    // Mount's failed attempt (call 1) plus the debounced effect's retry,
    // which only fires because lastSentRef was never stamped for content
    // that failed to send.
    expect(sendDocument).toHaveBeenCalledTimes(2)
    expect(sendDocument).toHaveBeenLastCalledWith('# Hi', null)
    vi.useRealTimers()
  })
})
