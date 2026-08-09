import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { useFindShortcuts } from './useFindShortcuts'
import { initialFindState, useFindStore } from '../store/findStore'

function press(
  key: string,
  modifiers: { meta?: boolean; ctrl?: boolean; alt?: boolean } = {}
): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      metaKey: modifiers.meta ?? false,
      ctrlKey: modifiers.ctrl ?? false,
      altKey: modifiers.alt ?? false,
      bubbles: true,
      cancelable: true
    })
  )
}

// NOT `useFindStore.setState(initialFindState, true)` -- per this project's
// own established gotcha (see FindBar.test.tsx's own comment on the exact
// same footgun): zustand's `replace: true` swaps the ENTIRE state object
// rather than merging, and `initialFindState` carries only plain values, none
// of the store's action methods -- `true` here wipes openFind/closeFind/etc.
// off the store before every test, which throws "openFind is not a function"
// the instant the first test's Cmd+F handler tries to call it.
beforeEach(() => {
  useFindStore.setState(initialFindState)
})

// This repo's vitest.config.ts does not set `test.globals: true`, so
// @testing-library/react's own auto-cleanup registration never fires (see
// FindBar.test.tsx's own comment on the same setup) -- and renderHook,
// underneath, still mounts a real component. Without an explicit cleanup()
// between tests, EVERY previous test's hook instance (and the window
// 'keydown' listener its effect registered) stays mounted and keeps
// responding to later tests' press() calls -- confirmed by removing this and
// watching 'leaves an existing query alone...' fail with the PRIOR test's
// 'beta' selection leaking in, because that prior test's still-attached
// listener fires (and calls setQuery) before this test's own does.
afterEach(() => {
  cleanup()
})

describe('useFindShortcuts', () => {
  it('opens the find bar on Cmd+F', () => {
    renderHook(() => useFindShortcuts({ getSelectedText: () => '', queryInputRef: createRef() }))
    press('f', { meta: true })
    expect(useFindStore.getState().isOpen).toBe(true)
    expect(useFindStore.getState().replaceExpanded).toBe(false)
  })

  it('opens the find bar on Ctrl+F', () => {
    renderHook(() => useFindShortcuts({ getSelectedText: () => '', queryInputRef: createRef() }))
    press('f', { ctrl: true })
    expect(useFindStore.getState().isOpen).toBe(true)
  })

  it('opens with replace expanded on Cmd+Alt+F', () => {
    renderHook(() => useFindShortcuts({ getSelectedText: () => '', queryInputRef: createRef() }))
    press('f', { meta: true, alt: true })
    expect(useFindStore.getState().isOpen).toBe(true)
    expect(useFindStore.getState().replaceExpanded).toBe(true)
  })

  it('seeds the query from the current selection', () => {
    renderHook(() =>
      useFindShortcuts({ getSelectedText: () => 'beta', queryInputRef: createRef() })
    )
    press('f', { meta: true })
    expect(useFindStore.getState().query).toBe('beta')
  })

  it('leaves an existing query alone when nothing is selected', () => {
    useFindStore.setState({ query: 'previous' })
    renderHook(() => useFindShortcuts({ getSelectedText: () => '', queryInputRef: createRef() }))
    press('f', { meta: true })
    expect(useFindStore.getState().query).toBe('previous')
  })

  it('does not seed a multi-line selection', () => {
    // A multi-line selection means "search inside this region" in most
    // editors, not "search for this literal text" -- seeding it would produce
    // a query that matches nothing, which is worse than not seeding.
    useFindStore.setState({ query: 'previous' })
    renderHook(() =>
      useFindShortcuts({ getSelectedText: () => 'two\nlines', queryInputRef: createRef() })
    )
    press('f', { meta: true })
    expect(useFindStore.getState().query).toBe('previous')
  })

  it('focuses and selects the query input', () => {
    const input = document.createElement('input')
    input.value = 'cat'
    document.body.appendChild(input)
    const ref = { current: input }
    const select = vi.spyOn(input, 'select')
    renderHook(() => useFindShortcuts({ getSelectedText: () => '', queryInputRef: ref }))
    press('f', { meta: true })
    expect(document.activeElement).toBe(input)
    expect(select).toHaveBeenCalled()
    input.remove()
  })

  it('closes the bar on Escape while it is open', () => {
    useFindStore.setState({ isOpen: true })
    renderHook(() => useFindShortcuts({ getSelectedText: () => '', queryInputRef: createRef() }))
    press('Escape')
    expect(useFindStore.getState().isOpen).toBe(false)
  })

  it('ignores Escape while the bar is closed', () => {
    const closeFind = vi.spyOn(useFindStore.getState(), 'closeFind')
    renderHook(() => useFindShortcuts({ getSelectedText: () => '', queryInputRef: createRef() }))
    press('Escape')
    expect(closeFind).not.toHaveBeenCalled()
  })

  it('ignores a bare f', () => {
    renderHook(() => useFindShortcuts({ getSelectedText: () => '', queryInputRef: createRef() }))
    press('f')
    expect(useFindStore.getState().isOpen).toBe(false)
  })

  it('removes its listener on unmount', () => {
    const { unmount } = renderHook(() =>
      useFindShortcuts({ getSelectedText: () => '', queryInputRef: createRef() })
    )
    unmount()
    press('f', { meta: true })
    expect(useFindStore.getState().isOpen).toBe(false)
  })
})
