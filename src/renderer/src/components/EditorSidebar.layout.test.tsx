import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import EditorSidebar from './EditorSidebar'
import { useAppStore, initialAppState } from '../store/appStore'

// A separate file from EditorSidebar.test.tsx purely to keep these layout
// assertions from needing that file's large window.api fixture (the History
// tab's own tests are what require it) -- these render the default Pages tab
// and touch no IPC at all.
beforeEach(() => {
  useAppStore.setState(initialAppState)
})

afterEach(() => {
  cleanup()
})

const TAB_LABELS = ['Pages', 'Outline', 'History', 'Comments']

function renderSidebar(): void {
  render(
    <EditorSidebar
      content="# Heading"
      onSelectHeading={vi.fn()}
      currentPage={1}
      onSelectPage={vi.fn()}
      filePath={null}
      onRestoreVersion={vi.fn()}
      onSelectComment={vi.fn()}
      onResolveComment={vi.fn()}
    />
  )
}

// The reported bug: four pills in a single row inside a 216px rail were
// squished with their text clipped. Measured in the real built app (phase0
// probe, identical at the 1000px default window and at the 760px
// MIN_WINDOW_WIDTH, because the rail is `w-[216px] shrink-0`): the track's
// content box is 182px, and the four labels alone measure 35.94 + 42.59 +
// 43.17 + 63.74 = 185.44px, so with three 2px gaps the row needed 191.44px and
// overflowed by ~9px with zero horizontal padding inside any pill.
//
// jsdom has no layout engine and no CSS pipeline, so it structurally cannot
// re-measure any of that -- the numbers above come from the real app and are
// reported with the change. What jsdom CAN pin is the structural decision
// those numbers drove, which is what these tests do: two columns, and pills
// that can shrink and truncate rather than force the track wider.
describe('EditorSidebar tab pills', () => {
  it('lays the four pills out in two columns, not one row', () => {
    renderSidebar()
    const track = screen.getByRole('button', { name: 'Pages' }).parentElement

    expect(track?.className).toContain('grid-cols-2')
    // The specific failure mode being ruled out: a flex row cannot shrink
    // these below their min-content width (a flex item's min-width defaults to
    // auto), so it overflows instead of fitting.
    expect(track?.className).not.toContain('flex')
  })

  it('keeps all four labels as real text, in one click each', () => {
    renderSidebar()
    for (const label of TAB_LABELS) {
      expect(screen.getByRole('button', { name: label })).toHaveTextContent(label)
    }
  })

  it('lets a pill shrink and truncate rather than burst the track', () => {
    renderSidebar()
    for (const label of TAB_LABELS) {
      const pill = screen.getByRole('button', { name: label })
      // min-w-0 is the load-bearing half: without it a grid item's own
      // `min-width: auto` floors it at its min-content width, which is exactly
      // how the previous single-row layout came to overflow.
      expect(pill.className).toContain('min-w-0')
      expect(pill.className).toContain('truncate')
      // The room the two-column layout buys, spent where the user sees it.
      expect(pill.className).toContain('px-1.5')
    }
  })

  it('gives a truncated label a tooltip carrying its full text', () => {
    renderSidebar()
    expect(screen.getByRole('button', { name: 'Comments' })).toHaveAttribute('title', 'Comments')
  })

  it('still switches tabs on a single click, for every pill', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    renderSidebar()

    await user.click(screen.getByRole('button', { name: 'Comments' }))
    expect(useAppStore.getState().sidebarTab).toBe('comments')

    await user.click(screen.getByRole('button', { name: 'Outline' }))
    expect(useAppStore.getState().sidebarTab).toBe('outline')
  })
})
