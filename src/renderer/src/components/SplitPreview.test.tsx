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
})
