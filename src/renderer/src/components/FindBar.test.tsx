import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FindBar from './FindBar'
import { initialFindState, useFindStore } from '../store/findStore'

function renderBar(overrides: Partial<typeof initialFindState> = {}): {
  onReplace: ReturnType<typeof vi.fn>
  onReplaceAll: ReturnType<typeof vi.fn>
} {
  const onReplace = vi.fn()
  const onReplaceAll = vi.fn()
  useFindStore.setState({ ...initialFindState, isOpen: true, ...overrides })
  render(<FindBar onReplace={onReplace} onReplaceAll={onReplaceAll} queryInputRef={createRef()} />)
  return { onReplace, onReplaceAll }
}

// NOTE: the second argument to setState must NOT be `true` here. Zustand's
// `replace: true` swaps the ENTIRE state object rather than merging, and
// `initialFindState` (typed as FindStateValues) carries only the plain
// values -- none of the store's action methods (setQuery, goToNext, ...).
// Passing `true` therefore wipes every action off the store before each
// test, and every subsequent `renderBar()` call's plain-merge `setState`
// cannot restore them (they're simply absent from the object being merged
// from). Confirmed by running this file with `true` still in place: every
// interactive test (typing, clicking Next/Previous/toggle/close) failed with
// "setQuery is not a function" / "goToNext is not a function" thrown from
// inside the real store, while every purely-read-only test (count readouts,
// disabled-state checks) still passed. src/renderer/src/store/findStore.ts's
// OWN test file (findStore.test.ts:5) already resets this exact store the
// correct way -- `useFindStore.setState(initialFindState)`, no `true` -- so
// this matches that established, working precedent.
beforeEach(() => {
  useFindStore.setState(initialFindState)
})

// This repo's vitest.config.ts does not set `test.globals: true`, so
// @testing-library/react's own auto-cleanup registration (which checks for a
// GLOBAL `afterEach`) never fires -- every sibling component test file here
// (EditorStatusBar.test.tsx, EditorOutline.test.tsx, etc.) explicitly imports
// `cleanup` and calls it itself for exactly this reason. Without this, each
// of the 14 `render()` calls below stacks another copy of the bar into
// `document.body`, and `getByLabelText`/`getByRole` queries that are unique
// per render start throwing "found multiple elements" -- not a flaw in any
// assertion, just a missing scaffolding statement the brief's test file
// omitted.
afterEach(() => {
  cleanup()
})

describe('FindBar', () => {
  it('renders nothing when closed', () => {
    useFindStore.setState({ ...initialFindState, isOpen: false })
    const { container } = render(
      <FindBar onReplace={vi.fn()} onReplaceAll={vi.fn()} queryInputRef={createRef()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('writes typed text into the store', async () => {
    const user = userEvent.setup()
    renderBar()
    await user.type(screen.getByLabelText('Find'), 'cat')
    expect(useFindStore.getState().query).toBe('cat')
  })

  it('shows the position within the match list', () => {
    renderBar({ query: 'cat', matchCount: 12, activeIndex: 2 })
    expect(screen.getByTestId('find-count')).toHaveTextContent('3 / 12')
  })

  it('shows a capped count as an open-ended total', () => {
    renderBar({ query: 'a', matchCount: 5000, activeIndex: 0, capped: true })
    expect(screen.getByTestId('find-count')).toHaveTextContent('1 / 5000+')
  })

  it('reports no results for a query that matches nothing', () => {
    renderBar({ query: 'zzz', matchCount: 0, activeIndex: -1 })
    expect(screen.getByTestId('find-count')).toHaveTextContent('No results')
  })

  it('shows no count readout for an empty query', () => {
    renderBar({ query: '' })
    expect(screen.getByTestId('find-count')).toBeEmptyDOMElement()
  })

  // Product-completeness audit Tier 3, B.1: the count readout used to have
  // no live region at all, so a screen-reader user editing the query never
  // heard "3 / 12"/"No results" change.
  it('marks the count readout as a polite, atomic live region -- not an assertive alert', () => {
    renderBar({ query: 'cat', matchCount: 12, activeIndex: 2 })
    const count = screen.getByTestId('find-count')
    expect(count).toHaveAttribute('aria-live', 'polite')
    expect(count).toHaveAttribute('aria-atomic', 'true')
    // Specifically NOT role="alert": this text changes on every keystroke
    // while the user is actively typing in the adjacent input, and an
    // assertive region would interrupt that on every change.
    expect(count).not.toHaveAttribute('role', 'alert')
  })

  it('navigates with the next and previous buttons', async () => {
    const user = userEvent.setup()
    renderBar({ query: 'cat', matchCount: 3, activeIndex: 0 })
    await user.click(screen.getByLabelText('Next match'))
    expect(useFindStore.getState().activeIndex).toBe(1)
    await user.click(screen.getByLabelText('Previous match'))
    expect(useFindStore.getState().activeIndex).toBe(0)
  })

  it('navigates with Enter and Shift+Enter in the query input', async () => {
    const user = userEvent.setup()
    renderBar({ query: 'cat', matchCount: 3, activeIndex: 0 })
    const input = screen.getByLabelText('Find')
    await user.click(input)
    await user.keyboard('{Enter}')
    expect(useFindStore.getState().activeIndex).toBe(1)
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(useFindStore.getState().activeIndex).toBe(0)
  })

  it('disables navigation when there is nothing to navigate', () => {
    renderBar({ query: 'zzz', matchCount: 0, activeIndex: -1 })
    expect(screen.getByLabelText('Next match')).toBeDisabled()
    expect(screen.getByLabelText('Previous match')).toBeDisabled()
  })

  it('toggles match case and whole word', async () => {
    const user = userEvent.setup()
    renderBar()
    await user.click(screen.getByLabelText('Match case'))
    expect(useFindStore.getState().options.caseSensitive).toBe(true)
    await user.click(screen.getByLabelText('Whole word'))
    expect(useFindStore.getState().options.wholeWord).toBe(true)
  })

  it('hides the replace row until it is expanded', async () => {
    const user = userEvent.setup()
    renderBar()
    expect(screen.queryByLabelText('Replace with')).not.toBeInTheDocument()
    await user.click(screen.getByLabelText('Toggle replace'))
    expect(screen.getByLabelText('Replace with')).toBeInTheDocument()
  })

  it('calls the replace callbacks', async () => {
    const user = userEvent.setup()
    const { onReplace, onReplaceAll } = renderBar({
      query: 'cat',
      matchCount: 2,
      activeIndex: 0,
      replaceExpanded: true
    })
    await user.click(screen.getByRole('button', { name: 'Replace' }))
    expect(onReplace).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Replace all' }))
    expect(onReplaceAll).toHaveBeenCalledTimes(1)
  })

  it('disables both replace buttons when there are no matches', () => {
    renderBar({ query: 'zzz', matchCount: 0, activeIndex: -1, replaceExpanded: true })
    expect(screen.getByRole('button', { name: 'Replace' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Replace all' })).toBeDisabled()
  })

  it('closes from its own close button', async () => {
    const user = userEvent.setup()
    renderBar()
    await user.click(screen.getByLabelText('Close find'))
    expect(useFindStore.getState().isOpen).toBe(false)
  })
})
