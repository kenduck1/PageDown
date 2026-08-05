import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
    exportPdf: vi.fn()
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
      />
    )
    // "Heading" + "One two three four." = 5 words.
    expect(screen.getByText('5 words')).toBeInTheDocument()
  })

  it('uses singular "word" for a one-word document', () => {
    render(<EditorStatusBar content="Hi" isDirty={false} zoom={1} onZoomChange={vi.fn()} />)
    expect(screen.getByText('1 word')).toBeInTheDocument()
  })

  it('shows "Saved" (not "Unsaved changes") when isDirty is false', () => {
    render(<EditorStatusBar content="Hi" isDirty={false} zoom={1} onZoomChange={vi.fn()} />)
    expect(screen.getByText('Saved')).toBeInTheDocument()
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
  })

  it('shows "Unsaved changes" (not "Saved") when isDirty is true', () => {
    render(<EditorStatusBar content="Hi" isDirty={true} zoom={1} onZoomChange={vi.fn()} />)
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })

  it('calls onZoomChange with the selected numeric scale value when the dropdown changes', async () => {
    const user = userEvent.setup()
    const onZoomChange = vi.fn()
    render(<EditorStatusBar content="Hi" isDirty={false} zoom={1} onZoomChange={onZoomChange} />)

    await user.selectOptions(screen.getByLabelText('Zoom level'), '150%')

    expect(onZoomChange).toHaveBeenCalledWith(1.5)
  })

  it('reflects the current zoom prop as the dropdown selection', () => {
    render(<EditorStatusBar content="Hi" isDirty={false} zoom={0.75} onZoomChange={vi.fn()} />)
    expect(screen.getByLabelText('Zoom level')).toHaveValue('0.75')
  })

  it('fetches and displays the real page count via window.api.getPageCount', async () => {
    render(<EditorStatusBar content="# Doc" isDirty={false} zoom={1} onZoomChange={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Page 1 of 3')).toBeInTheDocument(), {
      timeout: 2000
    })
    expect(window.api.getPageCount).toHaveBeenCalledWith('# Doc')
  })

  it('shows a placeholder page count while the real count is still loading', () => {
    // Never resolves within this test, so the initial "—" placeholder is
    // what's on screen throughout.
    vi.mocked(window.api.getPageCount).mockReturnValue(new Promise(() => {}))
    render(<EditorStatusBar content="# Doc" isDirty={false} zoom={1} onZoomChange={vi.fn()} />)
    expect(screen.getByText('Page 1 of —')).toBeInTheDocument()
  })

  it('page-nav chevrons and the jump-to-page text are present but inert', async () => {
    // Never resolves, so the page count stays at its initial placeholder for
    // the lifetime of this test regardless of real wall-clock time elapsed
    // during the two clicks below -- avoids a race against usePageCount's
    // real 500ms debounce.
    vi.mocked(window.api.getPageCount).mockReturnValue(new Promise(() => {}))
    const user = userEvent.setup()
    render(<EditorStatusBar content="# Doc" isDirty={false} zoom={1} onZoomChange={vi.fn()} />)

    const prevButton = screen.getByRole('button', { name: 'Previous page' })
    const nextButton = screen.getByRole('button', { name: 'Next page' })
    const jumpButton = screen.getByRole('button', { name: 'Page 1 of —' })

    // Clicking must not throw and must not change the displayed page text --
    // proving these are genuine no-ops, not just "didn't crash."
    await user.click(prevButton)
    await user.click(nextButton)
    await user.click(jumpButton)

    expect(screen.getByText('Page 1 of —')).toBeInTheDocument()
  })
})
