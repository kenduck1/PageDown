import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditorStatusBar from './EditorStatusBar'

beforeEach(() => {
  window.api = {
    openFile: vi.fn(),
    openPath: vi.fn(),
    saveFile: vi.fn(),
    getRecentFiles: vi.fn(),
    removeRecentFile: vi.fn(),
    clearRecentFiles: vi.fn(),
    getThumbnail: vi.fn(),
    getTemplateThumbnail: vi.fn(),
    getPageCount: vi.fn().mockResolvedValue({ pageCount: 3 }),
    confirmDiscardChanges: vi.fn(),
    exportPdf: vi.fn(),
    exportHtml: vi.fn(),
    showItemInFolder: vi.fn(),
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
    getSplitPreviewPage: vi.fn(),
    saveDroppedImage: vi.fn(),
    openInNewWindow: vi.fn(),
    // The application menu's two channels. Both are stubbed in every
    // window.api fixture because window.api is a fully-typed FileApi here --
    // a missing method is a compile error, not just a runtime one.
    // onMenuCommand must return a real unsubscribe FUNCTION: App.tsx and
    // EditorScreen both call it from an effect cleanup, and a bare vi.fn()
    // returning undefined would throw on unmount.
    onMenuCommand: vi.fn().mockReturnValue(() => {}),
    setWindowState: vi.fn(),
    // Preferences broadcast (multi-window): a real unsubscribe function,
    // same contract as the other push channels here.
    onPreferencesChanged: vi.fn().mockReturnValue(() => {}),
    // The window-close guard's two channels. onWindowCloseRequest must
    // return a real unsubscribe FUNCTION -- App.tsx calls it from an effect
    // cleanup, same contract as onMenuCommand above.
    onWindowCloseRequest: vi.fn().mockReturnValue(() => {}),
    respondToWindowClose: vi.fn(),
    getStartupWarnings: vi.fn().mockResolvedValue([]),
    getAppVersion: vi.fn().mockResolvedValue('1.0.0'),
    resolveLocalImage: vi.fn()
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
        pageCountPending={false}
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
        pageCountPending={false}
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
        pageCountPending={false}
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
        pageCountPending={false}
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
        pageCountPending={false}
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
        pageCountPending={false}
        currentPage={1}
        onNavigateToPage={vi.fn()}
      />
    )
    expect(screen.getByLabelText('Zoom level')).toHaveValue('0.75')
  })

  it('disables the zoom dropdown, still showing the level, when zoom cannot apply', () => {
    // Split mode. The control used to stay live there and LIE: it accepted
    // 150%, reported 150%, and changed nothing on screen (Split's two-pane row
    // renders outside the zoom wrapper on purpose), then the document jumped
    // to 150% on switching back to Format.
    render(
      <EditorStatusBar
        content="Hi"
        isDirty={false}
        zoom={1.5}
        onZoomChange={vi.fn()}
        zoomEnabled={false}
        pageCount={3}
        pageCountPending={false}
        currentPage={1}
        onNavigateToPage={vi.fn()}
      />
    )

    const select = screen.getByLabelText('Zoom level')
    expect(select).toBeDisabled()
    // Disabled, not hidden or blanked -- the current level stays readable.
    expect(select).toHaveValue('1.5')
    // And it says why, rather than being an unexplained greyed control. The
    // wording now leads with what Split DOES do (fit the page to the pane),
    // because since fit-to-width landed the number beside it is that fit
    // scale rather than a level the user chose.
    expect(select).toHaveAttribute(
      'title',
      'Split view scales the page to fit the editor pane; zoom applies to Format and Source view'
    )
  })

  it('renders an off-list scale so a fit-to-width value is not a blank readout', () => {
    // Split mode reports EditorScreen's computed fit scale here, and those are
    // quantised to whole percents but otherwise arbitrary -- 71% is a
    // perfectly ordinary one and is not among the seven manual levels. A
    // controlled <select> whose value is not among its own options renders
    // BLANK (zoom-levels.ts's own module comment records that trap), so
    // without the appended option this readout would show nothing at all in
    // exactly the mode that now has something real to report.
    render(
      <EditorStatusBar
        content="Hi"
        isDirty={false}
        zoom={0.71}
        onZoomChange={vi.fn()}
        zoomEnabled={false}
        pageCount={3}
        pageCountPending={false}
        currentPage={1}
        onNavigateToPage={vi.fn()}
      />
    )

    const select = screen.getByLabelText('Zoom level')
    expect(select).toHaveValue('0.71')
    expect(screen.getByRole('option', { name: '71%' })).toBeInTheDocument()
    // The seven manual levels are untouched -- the extra entry is additive,
    // not a replacement, so nothing a user can actually pick has changed.
    expect(screen.getByRole('option', { name: '100%' })).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(8)
  })

  it('does not append a duplicate option for a scale already on the manual list', () => {
    render(
      <EditorStatusBar
        content="Hi"
        isDirty={false}
        zoom={0.75}
        onZoomChange={vi.fn()}
        zoomEnabled={false}
        pageCount={3}
        pageCountPending={false}
        currentPage={1}
        onNavigateToPage={vi.fn()}
      />
    )
    expect(screen.getAllByRole('option')).toHaveLength(7)
    expect(screen.getAllByRole('option', { name: '75%' })).toHaveLength(1)
  })

  it('leaves the zoom dropdown enabled by default', () => {
    render(
      <EditorStatusBar
        content="Hi"
        isDirty={false}
        zoom={1}
        onZoomChange={vi.fn()}
        pageCount={3}
        pageCountPending={false}
        currentPage={1}
        onNavigateToPage={vi.fn()}
      />
    )
    expect(screen.getByLabelText('Zoom level')).toBeEnabled()
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
      pageCountPending={false}
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

describe('EditorStatusBar page-count in-progress indicator', () => {
  it('shows no indicator when no count is in flight', () => {
    renderBar({ pageCountPending: false })
    expect(screen.queryByTestId('page-count-pending')).not.toBeInTheDocument()
  })

  it('shows a subtle indicator while a fresh count is in flight', () => {
    renderBar({ pageCountPending: true })
    expect(screen.getByTestId('page-count-pending')).toBeInTheDocument()
  })

  it('keeps showing the last known-good count, and keeps navigation live, while pending', () => {
    // The whole point of design:189's "last known-good value with a subtle
    // in-progress indicator, never blank or flickering": the reading must
    // NOT fall back to the em-dash and the chevrons must NOT flicker
    // disabled just because a refresh is in flight.
    renderBar({ pageCountPending: true })
    expect(screen.getByRole('button', { name: /page 3 of 12/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeEnabled()
  })
})

// Product-completeness audit §2.4: character count and reading time, the
// "other half" of the statistics surface -- word count used to be the whole
// thing.
describe('EditorStatusBar document statistics', () => {
  it('renders the real character count alongside the word count', () => {
    renderBar({ content: 'Hello world' })
    // "Hello world" -- no markdown syntax to strip -- is 11 characters.
    expect(screen.getByText('11 characters')).toBeInTheDocument()
  })

  it('uses singular "character" for a one-character document', () => {
    renderBar({ content: 'A' })
    expect(screen.getByText('1 character')).toBeInTheDocument()
  })

  it('shows "< 1 min read" for a short document', () => {
    renderBar({ content: 'Hello world' })
    expect(screen.getByText('< 1 min read')).toBeInTheDocument()
  })

  it('shows a rounded minute estimate for a longer document', () => {
    // 400 words at the documented 200 wpm estimate is exactly 2 minutes.
    renderBar({ content: Array(400).fill('word').join(' ') })
    expect(screen.getByText('2 min read')).toBeInTheDocument()
  })
})

// Product-completeness audit §2.4 perf fix: word/character count must come
// off the synchronous typing path via a debounce, matching usePageCount's
// own established pattern -- not recomputed on every single content change.
describe('EditorStatusBar statistics debounce', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not update the word count until the debounce window elapses', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <EditorStatusBar
        content="one two three"
        isDirty={false}
        zoom={1}
        onZoomChange={vi.fn()}
        pageCount={3}
        pageCountPending={false}
        currentPage={1}
        onNavigateToPage={vi.fn()}
      />
    )
    expect(screen.getByText('3 words')).toBeInTheDocument()

    rerender(
      <EditorStatusBar
        content="one two three four five"
        isDirty={false}
        zoom={1}
        onZoomChange={vi.fn()}
        pageCount={3}
        pageCountPending={false}
        currentPage={1}
        onNavigateToPage={vi.fn()}
      />
    )
    // Still the OLD count -- a real keystroke-by-keystroke edit must not
    // trigger a fresh parse before the debounce settles.
    expect(screen.getByText('3 words')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.getByText('5 words')).toBeInTheDocument()
  })

  it('a burst of rapid content changes only recomputes once, for the final value', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <EditorStatusBar
        content="a"
        isDirty={false}
        zoom={1}
        onZoomChange={vi.fn()}
        pageCount={3}
        pageCountPending={false}
        currentPage={1}
        onNavigateToPage={vi.fn()}
      />
    )

    for (const content of ['a b', 'a b c', 'a b c d']) {
      rerender(
        <EditorStatusBar
          content={content}
          isDirty={false}
          zoom={1}
          onZoomChange={vi.fn()}
          pageCount={3}
          pageCountPending={false}
          currentPage={1}
          onNavigateToPage={vi.fn()}
        />
      )
      act(() => {
        vi.advanceTimersByTime(50)
      })
    }
    // Still the very first render's count -- none of the intermediate
    // values ever had 200ms of quiet to settle.
    expect(screen.getByText('1 word')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.getByText('4 words')).toBeInTheDocument()
  })
})

// Product-completeness audit Tier 3, B.3: Split-mode preview render failures
// used to be console-only, with no on-screen indication anything was wrong.
describe('EditorStatusBar split-preview error', () => {
  it('renders nothing extra when there is no error', () => {
    renderBar({ splitPreviewError: null })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('surfaces a live-region status message when the preview failed to render', () => {
    renderBar({ splitPreviewError: 'Pagination harness timed out waiting for a result' })
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Preview may be out of date')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveAttribute('title', 'Pagination harness timed out waiting for a result')
  })
})
