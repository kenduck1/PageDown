import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { useFindShortcuts } from './useFindShortcuts'
import { initialFindState, useFindStore } from '../store/findStore'

// `code` defaults to the physical key that normally produces `key`, but every
// caller can override it -- which matters, because the whole point of the
// macOS test below is that `key` and `code` DISAGREE there.
function press(
  key: string,
  modifiers: {
    meta?: boolean
    ctrl?: boolean
    alt?: boolean
    shift?: boolean
    code?: string
  } = {}
): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      code: modifiers.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key),
      metaKey: modifiers.meta ?? false,
      ctrlKey: modifiers.ctrl ?? false,
      altKey: modifiers.alt ?? false,
      shiftKey: modifiers.shift ?? false,
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

// This file's jsdom environment reports `navigator.platform === ''`
// (confirmed by direct inspection, not assumed) -- `''.toUpperCase().includes
// ('MAC')` is `false`, so isMacPlatform() already reads "not a Mac" with no
// override at all. The Ctrl+H tests below still set it explicitly (Win32 /
// MacIntel) rather than relying on that default, so the intent reads
// directly off the test rather than off an unstated environment fact, and so
// the macOS case is actually exercised at all (its assertion would trivially
// "pass" against the untouched default for the wrong reason). Restored after
// each test that touches it so this file's own platform doesn't leak into
// whichever test happens to run next in the same worker.
const ORIGINAL_PLATFORM = navigator.platform
function setPlatform(platform: string): void {
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true })
}
afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM)
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

  // Windows/Linux convention (Word, VS Code, Notepad++, Sublime, Chrome
  // DevTools) -- the whole reason this binding was added: Ctrl+Alt+F alone
  // (the pre-existing test above, which fires on every platform since
  // `event.altKey` is read unconditionally) is nobody's muscle memory there.
  it('opens with replace expanded on Ctrl+H on Windows/Linux', () => {
    setPlatform('Win32')
    renderHook(() => useFindShortcuts({ getSelectedText: () => '', queryInputRef: createRef() }))
    press('h', { ctrl: true })
    expect(useFindStore.getState().isOpen).toBe(true)
    expect(useFindStore.getState().replaceExpanded).toBe(true)
  })

  // The critical negative case: Cmd+H is macOS's own system-reserved Hide
  // Application shortcut. This test uses `ctrl: true` (a real, distinct
  // physical key from Cmd on any Mac keyboard) rather than `meta: true`,
  // because a real Cmd+H is intercepted by the OS before any renderer's
  // `window` listener would ever see it -- the interesting, actually
  // reachable case is a Mac user's bare Control+H, which must ALSO stay a
  // no-op rather than accidentally opening Find and Replace via a binding
  // this app never advertises on macOS at all.
  it('does NOT open on Ctrl+H on macOS', () => {
    setPlatform('MacIntel')
    renderHook(() => useFindShortcuts({ getSelectedText: () => '', queryInputRef: createRef() }))
    press('h', { ctrl: true })
    expect(useFindStore.getState().isOpen).toBe(false)
  })

  it('does not open on Ctrl+Shift+H, matching the existing Shift-excluded convention for F', () => {
    setPlatform('Win32')
    renderHook(() => useFindShortcuts({ getSelectedText: () => '', queryInputRef: createRef() }))
    press('H', { ctrl: true, shift: true, code: 'KeyH' })
    expect(useFindStore.getState().isOpen).toBe(false)
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

  // The regression test that matters, and the one the original Cmd+Alt+F test
  // could never have caught: it passed `key: 'f'` with `alt: true`, which is
  // not what a real macOS keyboard produces. Option+F emits the CHARACTER `ƒ`,
  // so a handler testing `event.key.toLowerCase() === 'f'` never fired and the
  // advertised ⌥⌘F was dead by construction -- while the synthetic test stayed
  // green, because it set `key` directly and bypassed the layout translation.
  it('opens with replace expanded on the REAL macOS Option+F, where key is "ƒ" and only code says KeyF', () => {
    renderHook(() => useFindShortcuts({ getSelectedText: () => '', queryInputRef: createRef() }))
    press('ƒ', { meta: true, alt: true, code: 'KeyF' })
    expect(useFindStore.getState().isOpen).toBe(true)
    expect(useFindStore.getState().replaceExpanded).toBe(true)
  })

  it('still opens plain Find on the real macOS Cmd+F, where key and code agree', () => {
    renderHook(() => useFindShortcuts({ getSelectedText: () => '', queryInputRef: createRef() }))
    press('f', { meta: true, code: 'KeyF' })
    expect(useFindStore.getState().isOpen).toBe(true)
    expect(useFindStore.getState().replaceExpanded).toBe(false)
  })

  // Shift is excluded deliberately. Under the old `key`-only test, Shift+F
  // produced 'F' and lowercased straight back to 'f', so ⇧⌘F quietly opened
  // plain Find -- undocumented, and easy to hit reaching for a find-in-files
  // binding this app does not have. Doing nothing is more honest.
  it('does NOT open on Cmd+Shift+F, which used to quietly open plain Find', () => {
    renderHook(() => useFindShortcuts({ getSelectedText: () => '', queryInputRef: createRef() }))
    press('F', { meta: true, shift: true, code: 'KeyF' })
    expect(useFindStore.getState().isOpen).toBe(false)
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
