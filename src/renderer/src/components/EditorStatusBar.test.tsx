import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditorStatusBar from './EditorStatusBar'

beforeEach(() => {
  window.api = {
    openFile: vi.fn(),
    openPath: vi.fn(),
    saveFile: vi.fn(),
    getRecentFiles: vi.fn(),
    getThumbnail: vi.fn(),
    getTemplateThumbnail: vi.fn(),
    getPageCount: vi.fn().mockResolvedValue({ pageCount: 3 }),
    confirmDiscardChanges: vi.fn(),
    exportPdf: vi.fn(),
    print: vi.fn(),
    getPreferences: vi.fn(),
    setPreferences: vi.fn(),
    autosaveSnapshot: vi.fn(),
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
  cleanup()
})

describe('EditorStatusBar', () => {
  it('renders the real word count for the given content', () => {
    render(
      <EditorStatusBar
        content={'# Heading\n\nOne two three four.'}
        isDirty={false}
        zoom={1}
        onZoomChange={vi.fn()}
        pageCount={3}
        currentPage={1}
        onNavigateToPage={vi.fn()}
      />
    )
    // "Heading" + "One two three four." = 5 words.
    expect(screen.getByText('5 words')).toBeInTheDocument()
  })

  it('uses singular "word" for a one-word document', () => {
    render(
      <EditorStatusBar
        content="Hi"
        isDirty={false}
        zoom={1}
        onZoomChange={vi.fn()}
        pageCount={3}
        currentPage={1}
        onNavigateToPage={vi.fn()}
      />
    )
    expect(screen.getByText('1 word')).toBeInTheDocument()
  })

  it('shows "Saved" (not "Unsaved changes") when isDirty is false', () => {
    render(
      <EditorStatusBar
        content="Hi"
        isDirty={false}
        zoom={1}
        onZoomChange={vi.fn()}
        pageCount={3}
        currentPage={1}
        onNavigateToPage={vi.fn()}
      />
    )
    expect(screen.getByText('Saved')).toBeInTheDocument()
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
  })

  it('shows "Unsaved changes" (not "Saved") when isDirty is true', () => {
    render(
      <EditorStatusBar
        content="Hi"
        isDirty={true}
        zoom={1}
        onZoomChange={vi.fn()}
        pageCount={3}
        currentPage={1}
        onNavigateToPage={vi.fn()}
      />
    )
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })

  it('calls onZoomChange with the selected numeric scale value when the dropdown changes', async () => {
    const user = userEvent.setup()
    const onZoomChange = vi.fn()
    render(
      <EditorStatusBar
        content="Hi"
        isDirty={false}
        zoom={1}
        onZoomChange={onZoomChange}
        pageCount={3}
        currentPage={1}
        onNavigateToPage={vi.fn()}
      />
    )

    await user.selectOptions(screen.getByLabelText('Zoom level'), '150%')

    expect(onZoomChange).toHaveBeenCalledWith(1.5)
  })

  it('reflects the current zoom prop as the dropdown selection', () => {
    render(
      <EditorStatusBar
        content="Hi"
        isDirty={false}
        zoom={0.75}
        onZoomChange={vi.fn()}
        pageCount={3}
        currentPage={1}
        onNavigateToPage={vi.fn()}
      />
    )
    expect(screen.getByLabelText('Zoom level')).toHaveValue('0.75')
  })
})

function renderBar(overrides: Partial<React.ComponentProps<typeof EditorStatusBar>> = {}): {
  onNavigateToPage: ReturnType<typeof vi.fn>
} {
  const onNavigateToPage = vi.fn()
  render(
    <EditorStatusBar
      content="one two three"
      isDirty={false}
      zoom={1}
      onZoomChange={vi.fn()}
      pageCount={12}
      currentPage={3}
      onNavigateToPage={onNavigateToPage}
      {...overrides}
    />
  )
  return { onNavigateToPage }
}

describe('EditorStatusBar page navigation', () => {
  it('shows the real current page and total', () => {
    renderBar()
    expect(screen.getByRole('button', { name: /page 3 of 12/i })).toBeInTheDocument()
  })

  it('navigates forward and back', async () => {
    const user = userEvent.setup()
    const { onNavigateToPage } = renderBar()
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    expect(onNavigateToPage).toHaveBeenCalledWith(4)
    await user.click(screen.getByRole('button', { name: 'Previous page' }))
    expect(onNavigateToPage).toHaveBeenCalledWith(2)
  })

  it('disables Previous on the first page', () => {
    renderBar({ currentPage: 1 })
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled()
  })

  it('disables Next on the last page', () => {
    renderBar({ currentPage: 12 })
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
  })

  it('disables both when the page count is unknown', () => {
    renderBar({ pageCount: null })
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
    const jumpButton = screen.getByRole('button', { name: /page 3 of/i })
    expect(jumpButton).toBeDisabled()
    expect(jumpButton).toHaveTextContent('Page 3 of —')
  })

  it('jumps to a typed page on Enter', async () => {
    const user = userEvent.setup()
    const { onNavigateToPage } = renderBar()
    await user.click(screen.getByRole('button', { name: /page 3 of 12/i }))
    const input = screen.getByRole('spinbutton', { name: /jump to page/i })
    await user.clear(input)
    await user.type(input, '7{Enter}')
    expect(onNavigateToPage).toHaveBeenCalledWith(7)
  })

  it('clamps a jump value above pageCount down to the last page', async () => {
    const user = userEvent.setup()
    const { onNavigateToPage } = renderBar()
    await user.click(screen.getByRole('button', { name: /page 3 of 12/i }))
    const input = screen.getByRole('spinbutton', { name: /jump to page/i })
    await user.clear(input)
    await user.type(input, '99{Enter}')
    expect(onNavigateToPage).toHaveBeenCalledWith(12)
  })

  it('clamps a jump value below 1 up to the first page', async () => {
    const user = userEvent.setup()
    const { onNavigateToPage } = renderBar()
    await user.click(screen.getByRole('button', { name: /page 3 of 12/i }))
    const input = screen.getByRole('spinbutton', { name: /jump to page/i })
    await user.clear(input)
    await user.type(input, '0{Enter}')
    expect(onNavigateToPage).toHaveBeenCalledWith(1)
  })

  it('treats an emptied jump input as a cancel, not a jump to page 1', async () => {
    // `Number('')` is 0, which is finite -- so without an explicit
    // empty-string check, clearing the field and pressing Enter silently
    // navigated to page 1.
    const user = userEvent.setup()
    const { onNavigateToPage } = renderBar()
    await user.click(screen.getByRole('button', { name: /page 3 of 12/i }))
    const input = screen.getByRole('spinbutton', { name: /jump to page/i })
    await user.clear(input)
    await user.type(input, '{Enter}')
    expect(onNavigateToPage).not.toHaveBeenCalled()
  })

  it('cancels the jump input on Escape without navigating', async () => {
    const user = userEvent.setup()
    const { onNavigateToPage } = renderBar()
    await user.click(screen.getByRole('button', { name: /page 3 of 12/i }))
    await user.type(screen.getByRole('spinbutton', { name: /jump to page/i }), '7{Escape}')
    expect(onNavigateToPage).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /page 3 of 12/i })).toBeInTheDocument()
  })

  it('still shows the word count', () => {
    renderBar()
    expect(screen.getByText('3 words')).toBeInTheDocument()
  })
})
