import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react'
import { useSlashMenu } from './useSlashMenu'
import type { MilkdownEditorHandle } from '../milkdown/MilkdownEditor'
import type { SlashItem } from '../milkdown/slash-items'
import type { SlashSession } from '../milkdown/slash-plugin'

// This repo's vitest.config.ts does not set `test.globals: true`, so
// @testing-library/react's own auto-cleanup registration never fires (see
// useFindShortcuts.test.ts's own comment on the identical footgun) --
// without this, every previous test's hook instance (and the window
// 'scroll'/'resize' listeners its effect registers while open) stays
// mounted and keeps firing for later tests.
afterEach(() => {
  cleanup()
})

// Used for the two getBoundingClientRect mocks below, matching what a real
// DOM element genuinely returns.
function fakeDomRect(overrides: Partial<DOMRect>): DOMRect {
  return {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...overrides
  } as DOMRect
}

// getSelectionRect's own return type is lib/floating-position.ts's plain
// `Rect` (left/top/right/bottom only) -- deliberately NOT a DOMRect, and
// this must be a plain object literal here rather than fakeDomRect's wider
// shape: toEqual requires an EXACT own-property match, so asserting against
// a real Rect with fakeDomRect's extra width/height/x/y fields mixed in
// would fail regardless of whether the four fields that matter are correct.
function fakeRect(overrides: { left: number; top: number; right: number; bottom: number }): {
  left: number
  top: number
  right: number
  bottom: number
} {
  return { ...overrides }
}

function fakeItem(id: string): SlashItem {
  return {
    id,
    group: 'Text',
    label: id,
    description: '',
    keywords: [],
    run: () => {},
    isEnabled: () => true
  }
}

function fakeSession(overrides: Partial<SlashSession> = {}): SlashSession {
  return { anchorPos: 1, query: '', queryEnd: 2, activeIndex: 0, itemCount: 2, ...overrides }
}

// A minimal fake editor handle -- only the four methods this hook actually
// calls (getSelectionRect/getSlashItems/runSlashItem/setActiveSlashIndex),
// matching MilkdownEditorHandle's real shape closely enough for this hook's
// own contract, not the full interface (every other test file that needs a
// full fake -- EditorToolbar.test.tsx, the EditorScreen.*.test.tsx family --
// already owns its own complete version; duplicating that here would be a
// second copy of an interface this hook doesn't otherwise depend on).
function setup(): {
  editorRef: { current: MilkdownEditorHandle | null }
  canvasRef: { current: HTMLElement | null }
  editorPaneRef: { current: HTMLElement | null }
  handle: {
    getSelectionRect: Mock
    getSlashItems: Mock
    runSlashItem: Mock
    setActiveSlashIndex: Mock
  }
} {
  const handle = {
    getSelectionRect: vi.fn(() => fakeRect({ left: 10, top: 10, right: 30, bottom: 30 })),
    getSlashItems: vi.fn(() => [fakeItem('a'), fakeItem('b')]),
    runSlashItem: vi.fn(),
    insertImages: vi.fn(),
  removeLink: vi.fn(),
  toggleTaskList: vi.fn(),
  addRowBefore: vi.fn(),
  addRowAfter: vi.fn(),
  addColumnBefore: vi.fn(),
  addColumnAfter: vi.fn(),
  deleteRow: vi.fn(),
  deleteColumn: vi.fn(),
  deleteTable: vi.fn(),
  setColumnAlignment: vi.fn(),
  getTableRect: vi.fn(() => null),
  setActiveSlashIndex: vi.fn()
  }
  const canvas = document.createElement('div')
  const pane = document.createElement('div')
  canvas.getBoundingClientRect = vi.fn(() =>
    fakeDomRect({ left: 0, top: 0, right: 1000, bottom: 1000 })
  )
  pane.getBoundingClientRect = vi.fn(() =>
    fakeDomRect({ left: 0, top: 0, right: 500, bottom: 500 })
  )
  return {
    editorRef: { current: handle as unknown as MilkdownEditorHandle },
    canvasRef: { current: canvas },
    editorPaneRef: { current: pane },
    handle
  }
}

describe('useSlashMenu', () => {
  it('starts with no open session', () => {
    const { editorRef, canvasRef, editorPaneRef } = setup()
    const { result } = renderHook(() => useSlashMenu({ editorRef, canvasRef, editorPaneRef }))
    expect(result.current.state).toBeNull()
  })

  it('opening a session pulls items via getSlashItems(session.query) and measures anchor/safe rects', () => {
    const { editorRef, canvasRef, editorPaneRef, handle } = setup()
    const { result } = renderHook(() => useSlashMenu({ editorRef, canvasRef, editorPaneRef }))
    act(() => {
      result.current.handleSlashStateChanged(fakeSession({ query: 'ta', activeIndex: 1 }))
    })
    expect(handle.getSlashItems).toHaveBeenCalledWith('ta')
    expect(result.current.state?.items.map((item) => item.id)).toEqual(['a', 'b'])
    expect(result.current.state?.activeIndex).toBe(1)
    expect(result.current.state?.rects.anchor).toEqual({ left: 10, top: 10, right: 30, bottom: 30 })
    // canvas (0,0,1000,1000) intersect pane (0,0,500,500) -> (0,0,500,500),
    // a real non-null box -- proving the safe rect actually gets computed
    // from the two refs, not left null by construction.
    expect(result.current.state?.rects.safe).toEqual({ left: 0, top: 0, right: 500, bottom: 500 })
  })

  it('a null session report clears state back to null', () => {
    const { editorRef, canvasRef, editorPaneRef } = setup()
    const { result } = renderHook(() => useSlashMenu({ editorRef, canvasRef, editorPaneRef }))
    act(() => result.current.handleSlashStateChanged(fakeSession()))
    expect(result.current.state).not.toBeNull()
    act(() => result.current.handleSlashStateChanged(null))
    expect(result.current.state).toBeNull()
  })

  it('onChoose delegates to editorRef.current.runSlashItem(item.id)', () => {
    const { editorRef, canvasRef, editorPaneRef, handle } = setup()
    const { result } = renderHook(() => useSlashMenu({ editorRef, canvasRef, editorPaneRef }))
    act(() => result.current.onChoose(fakeItem('math-block')))
    expect(handle.runSlashItem).toHaveBeenCalledWith('math-block')
  })

  it('onHover delegates to editorRef.current.setActiveSlashIndex(index)', () => {
    const { editorRef, canvasRef, editorPaneRef, handle } = setup()
    const { result } = renderHook(() => useSlashMenu({ editorRef, canvasRef, editorPaneRef }))
    act(() => result.current.onHover(4))
    expect(handle.setActiveSlashIndex).toHaveBeenCalledWith(4)
  })

  describe('re-measurement while open', () => {
    it('registers a scroll listener with capture: true -- element scroll events do not bubble', () => {
      // Same reasoning, and the same assertion shape, as
      // SelectionBubble.test.tsx's own identical scroll-listener test: the
      // editor pane is overflow-auto in every branch this palette can be
      // mounted in, so a plain bubble-phase window listener would silently
      // never fire for a scroll originating inside it.
      const addSpy = vi.spyOn(window, 'addEventListener')
      const { editorRef, canvasRef, editorPaneRef } = setup()
      const { result } = renderHook(() => useSlashMenu({ editorRef, canvasRef, editorPaneRef }))
      act(() => result.current.handleSlashStateChanged(fakeSession()))
      const scrollCall = addSpy.mock.calls.find(([type]) => type === 'scroll')
      expect(scrollCall).toBeDefined()
      expect(scrollCall?.[2]).toBe(true)
    })

    it('re-measures rects (not items/activeIndex) on scroll while open, and stops once closed', () => {
      const { editorRef, canvasRef, editorPaneRef, handle } = setup()
      const { result } = renderHook(() => useSlashMenu({ editorRef, canvasRef, editorPaneRef }))
      act(() => result.current.handleSlashStateChanged(fakeSession({ activeIndex: 1 })))
      handle.getSlashItems.mockClear()
      handle.getSelectionRect.mockReturnValue(
        fakeRect({ left: 50, top: 50, right: 70, bottom: 70 })
      )
      act(() => {
        fireEvent.scroll(window)
      })
      expect(result.current.state?.rects.anchor).toEqual({
        left: 50,
        top: 50,
        right: 70,
        bottom: 70
      })
      // activeIndex/items are untouched by a scroll -- only geometry moves.
      expect(result.current.state?.activeIndex).toBe(1)
      expect(handle.getSlashItems).not.toHaveBeenCalled()

      act(() => result.current.handleSlashStateChanged(null))
      handle.getSelectionRect.mockReturnValue(
        fakeRect({ left: 99, top: 99, right: 120, bottom: 120 })
      )
      act(() => {
        fireEvent.scroll(window)
      })
      // Still null -- the listener was torn down when the session closed,
      // not left dangling to resurrect state out from under a closed palette.
      expect(result.current.state).toBeNull()
    })

    it('skips the setState entirely when nothing actually moved (sameRect dedupe)', () => {
      const { editorRef, canvasRef, editorPaneRef } = setup()
      const { result } = renderHook(() => useSlashMenu({ editorRef, canvasRef, editorPaneRef }))
      act(() => result.current.handleSlashStateChanged(fakeSession()))
      const stateAfterOpen = result.current.state
      act(() => {
        fireEvent.scroll(window)
      })
      // Same object reference -- the effect's own `prev` early-return fired,
      // not merely an equal-by-value replacement.
      expect(result.current.state).toBe(stateAfterOpen)
    })
  })
})
