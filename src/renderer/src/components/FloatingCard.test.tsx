import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import FloatingCard from './FloatingCard'
import { FLOATING_EDGE_PAD, type Rect } from '../lib/floating-position'

// The positioning shell shared by LinkComposer and CommentComposer once both
// became popovers anchored at the selection.
//
// WHAT THESE TESTS CAN AND CANNOT PROVE, stated up front because getting this
// wrong is how a green suite ends up proving nothing here: jsdom has no layout
// engine, so every real `getBoundingClientRect()` is all-zero (see
// selection-plugin.ts's own JSDOM HAZARD note -- `coordsAtPos` does not even
// throw, it silently returns zeros). So the card's OWN measured size is always
// {0,0} here, and any assertion about "the popover sits above the selection"
// would be measuring the origin against the origin. What IS provable, and what
// is asserted below, is that the rects `measure()` hands back are the ones fed
// into the clamp, that the fallbacks fire when they should, and that the
// Escape/remeasure wiring runs. The real pixels are Gate 34's job.
const SAFE: Rect = { left: 216, top: 123, right: 561, bottom: 606 }

afterEach(() => {
  cleanup()
})

function renderCard(
  overrides: Partial<{
    open: boolean
    measure: () => { anchor: Rect | null; safe: Rect | null }
    onClose: () => void
  }> = {}
): HTMLElement | null {
  const paneRef = createRef<HTMLElement>()
  render(
    <FloatingCard
      open={overrides.open ?? true}
      measure={overrides.measure ?? (() => ({ anchor: null, safe: SAFE }))}
      paneRef={paneRef}
      onClose={overrides.onClose ?? vi.fn()}
      label="Insert link"
      widthPx={320}
    >
      <input aria-label="Link URL" />
    </FloatingCard>
  )
  return screen.queryByRole('group', { name: 'Insert link' })
}

describe('FloatingCard', () => {
  it('renders nothing while closed', () => {
    expect(renderCard({ open: false })).toBeNull()
  })

  it('renders a labelled group carrying its children when open', () => {
    const card = renderCard()
    expect(card).not.toBeNull()
    expect(screen.getByRole('textbox', { name: 'Link URL' })).toBeInTheDocument()
  })

  // The pre-measurement frame is hidden with opacity, NOT visibility: hidden
  // (which would strip the node from the accessibility tree) and NOT
  // pointer-events: none (which would make every click test literally
  // unperformable under jsdom, where the unmeasured state is permanent). Both
  // choices are inherited verbatim from SelectionBubble, and this test is what
  // stops the "obvious companion" pointer-events line being added back.
  it('is hidden but still queryable and still clickable before it has measured itself', () => {
    const card = renderCard()
    expect(card).toHaveStyle({ opacity: '0' })
    expect(card?.style.pointerEvents).toBe('')
    expect(screen.getByRole('textbox', { name: 'Link URL' })).toBeInTheDocument()
  })

  it('anchors on the rect measure() reports, centred horizontally', () => {
    // Card size is {0,0} under jsdom, so a centred placement puts its left
    // edge exactly on the anchor's centre -- which is what makes this a real
    // assertion about the anchor rather than about the card's own width.
    const anchor: Rect = { left: 380, top: 300, right: 420, bottom: 318 }
    const card = renderCard({ measure: () => ({ anchor, safe: SAFE }) })
    expect(card?.style.left).toBe('400px')
    expect(card?.style.top).toBe(`${300 - 8}px`)
  })

  // The occlusion guarantee, restated at this component's own boundary. The
  // arithmetic is proven exhaustively in lib/floating-position.test.ts; what
  // this pins is that FloatingCard genuinely routes through it rather than
  // writing the anchor's coordinates straight into `style`.
  it('clamps a right-edge anchor inside the safe rect', () => {
    const anchor: Rect = { left: 540, top: 300, right: 556, bottom: 318 }
    const card = renderCard({ measure: () => ({ anchor, safe: SAFE }) })
    expect(parseFloat(card!.style.left)).toBeLessThanOrEqual(SAFE.right - FLOATING_EDGE_PAD)
    expect(card?.style.maxWidth).toBe(`${SAFE.right - SAFE.left - FLOATING_EDGE_PAD * 2}px`)
  })

  // Source mode has no Milkdown instance, so getSelectionRect() returns null --
  // and a composer opened from the toolbar or Mod-Shift-M there must still
  // appear, unlike the bubble, which correctly renders nothing when it cannot
  // locate a selection. topCenterAnchor puts it where the layout row used to
  // be: the top of the editing area.
  it('falls back to the top of the safe rect when there is no selection to anchor to', () => {
    const card = renderCard({ measure: () => ({ anchor: null, safe: SAFE }) })
    expect(card?.style.top).toBe(`${SAFE.top + FLOATING_EDGE_PAD}px`)
    expect(card?.style.left).toBe(`${(SAFE.left + SAFE.right) / 2}px`)
  })

  // Unreachable in the real app (canvas and pane are both mounted in every
  // view mode), but it is the state jsdom is permanently in, and rendering
  // nothing there would make a composer a dead control rather than a
  // mispositioned one. See viewportRect's own doc comment.
  it('still renders when there is no measurable safe rect at all', () => {
    const card = renderCard({ measure: () => ({ anchor: null, safe: null }) })
    expect(card).not.toBeNull()
    expect(card?.style.left).toBe(`${window.innerWidth / 2}px`)
  })

  // The listener is registered unconditionally on mount, so this must work
  // regardless of where focus is -- the composer's own field-level Escape
  // handler cannot see a keypress that never reaches the field.
  it('closes on Escape pressed outside the card', () => {
    const onClose = vi.fn()
    renderCard({ onClose })
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores Escape while closed, even though the listener is always registered', () => {
    const onClose = vi.fn()
    renderCard({ open: false, onClose })
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  // A popover that stayed put while the document scrolled under it would point
  // at the wrong words -- the failure a layout row could not have. capture:
  // true matters here: the editor pane is overflow-auto, and element scroll
  // events reach a window listener only in the capture phase.
  it('re-measures on scroll and follows the selection', () => {
    let anchor: Rect = { left: 380, top: 300, right: 420, bottom: 318 }
    const card = renderCard({ measure: () => ({ anchor, safe: SAFE }) })
    expect(card?.style.top).toBe('292px')

    anchor = { left: 380, top: 240, right: 420, bottom: 258 }
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    expect(card?.style.top).toBe('232px')
  })
})
