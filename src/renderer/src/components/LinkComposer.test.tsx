import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RealLinkComposer, { type LinkComposerProps } from './LinkComposer'
import { initialAppState, useAppStore } from '../store/appStore'

// The composer is a selection-anchored POPOVER (FloatingCard) rather than the
// layout row it used to be, so it now takes two positioning props. Neither
// carries any behaviour these tests are about, and jsdom would report all-zero
// rects for them regardless (see FloatingCard.test.tsx's own header), so they
// are supplied once here rather than repeated at eighteen call sites --
// keeping every assertion below byte-identical to what it asserted when this
// was a row, which is the point: the MOVE must not have changed the contract.
const paneRef = createRef<HTMLElement>()
function LinkComposer(props: Omit<LinkComposerProps, 'measure' | 'paneRef'>): React.ReactElement {
  return (
    <RealLinkComposer {...props} measure={() => ({ anchor: null, safe: null })} paneRef={paneRef} />
  )
}

// The replacement for EditorToolbar's dead `window.prompt('Link URL')` call
// (which THREW in Electron -- see LinkComposer.tsx's own module comment).
// These tests are written so that regressing to a prompt-style flow cannot
// keep them green: every assertion here is about a real, rendered DOM row
// (queried by role/accessible name) and a real callback, none of it stubbable
// by mocking a browser dialog API the way the two tests this feature's fix
// deleted were.
beforeEach(() => {
  useAppStore.setState(initialAppState)
})

afterEach(() => {
  cleanup()
})

describe('LinkComposer', () => {
  it('renders nothing when linkComposerOpen is false', () => {
    render(<LinkComposer initialHref="" onRemoveLink={vi.fn()} onInsertLink={vi.fn()} />)
    expect(screen.queryByRole('group', { name: 'Insert link' })).not.toBeInTheDocument()
  })

  it('renders the composer row when linkComposerOpen is true', () => {
    useAppStore.setState({ linkComposerOpen: true })
    render(<LinkComposer initialHref="" onRemoveLink={vi.fn()} onInsertLink={vi.fn()} />)
    expect(screen.getByRole('group', { name: 'Insert link' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Link URL' })).toBeInTheDocument()
  })

  it('the Insert button is disabled until a real URL is typed', async () => {
    useAppStore.setState({ linkComposerOpen: true })
    const user = userEvent.setup()
    render(<LinkComposer initialHref="" onRemoveLink={vi.fn()} onInsertLink={vi.fn()} />)

    const insertButton = screen.getByRole('button', { name: 'Insert' })
    expect(insertButton).toBeDisabled()

    await user.type(screen.getByRole('textbox', { name: 'Link URL' }), '   ')
    expect(insertButton).toBeDisabled()

    await user.type(screen.getByRole('textbox', { name: 'Link URL' }), 'https://example.com')
    expect(insertButton).not.toBeDisabled()
  })

  it('Enter inserts the URL and closes, same as clicking Insert', async () => {
    useAppStore.setState({ linkComposerOpen: true })
    const onInsertLink = vi.fn()
    const user = userEvent.setup()
    render(<LinkComposer initialHref="" onRemoveLink={vi.fn()} onInsertLink={onInsertLink} />)

    await user.type(screen.getByRole('textbox', { name: 'Link URL' }), 'https://example.com{Enter}')

    expect(onInsertLink).toHaveBeenCalledWith('https://example.com')
    expect(useAppStore.getState().linkComposerOpen).toBe(false)
  })

  it('clicking Insert inserts the URL and closes', async () => {
    useAppStore.setState({ linkComposerOpen: true })
    const onInsertLink = vi.fn()
    const user = userEvent.setup()
    render(<LinkComposer initialHref="" onRemoveLink={vi.fn()} onInsertLink={onInsertLink} />)

    await user.type(screen.getByRole('textbox', { name: 'Link URL' }), 'https://example.com')
    await user.click(screen.getByRole('button', { name: 'Insert' }))

    expect(onInsertLink).toHaveBeenCalledWith('https://example.com')
    expect(useAppStore.getState().linkComposerOpen).toBe(false)
  })

  // The old prompt-based code's `if (href)` guard let a whitespace-only
  // string through, which would have produced a link with a blank href.
  it('trims surrounding whitespace, and a whitespace-only URL inserts nothing', async () => {
    useAppStore.setState({ linkComposerOpen: true })
    const onInsertLink = vi.fn()
    const user = userEvent.setup()
    render(<LinkComposer initialHref="" onRemoveLink={vi.fn()} onInsertLink={onInsertLink} />)

    const input = screen.getByRole('textbox', { name: 'Link URL' })
    await user.type(input, '   {Enter}')
    expect(onInsertLink).not.toHaveBeenCalled()
    expect(useAppStore.getState().linkComposerOpen).toBe(true)

    await user.clear(input)
    await user.type(input, '  https://example.com  {Enter}')
    expect(onInsertLink).toHaveBeenCalledWith('https://example.com')
  })

  it('Cancel closes without inserting and clears the typed URL', async () => {
    useAppStore.setState({ linkComposerOpen: true })
    const onInsertLink = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <LinkComposer initialHref="" onRemoveLink={vi.fn()} onInsertLink={onInsertLink} />
    )

    await user.type(screen.getByRole('textbox', { name: 'Link URL' }), 'https://example.com')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onInsertLink).not.toHaveBeenCalled()
    expect(useAppStore.getState().linkComposerOpen).toBe(false)

    useAppStore.setState({ linkComposerOpen: true })
    rerender(<LinkComposer initialHref="" onRemoveLink={vi.fn()} onInsertLink={onInsertLink} />)
    expect(screen.getByRole('textbox', { name: 'Link URL' })).toHaveValue('')
  })

  it('Escape closes without inserting', async () => {
    useAppStore.setState({ linkComposerOpen: true })
    const onInsertLink = vi.fn()
    const user = userEvent.setup()
    render(<LinkComposer initialHref="" onRemoveLink={vi.fn()} onInsertLink={onInsertLink} />)

    await user.type(
      screen.getByRole('textbox', { name: 'Link URL' }),
      'https://example.com{Escape}'
    )

    expect(onInsertLink).not.toHaveBeenCalled()
    expect(useAppStore.getState().linkComposerOpen).toBe(false)
  })
})

// Editing an EXISTING link -- the capability-gap pass. Before it, this row's
// URL field seeded from `useState('')` and never looked at the document, so
// there was no way to see (let alone correct) the URL of a link you already
// had; and submitting a "correction" over already-linked text ran toggleMark's
// REMOVE branch and destroyed the link outright.
describe('LinkComposer editing an existing link', () => {
  it('prefills the field with the existing href', () => {
    useAppStore.setState({ linkComposerOpen: true })
    render(
      <LinkComposer
        initialHref="https://old.example.com"
        onRemoveLink={vi.fn()}
        onInsertLink={vi.fn()}
      />
    )
    expect(screen.getByRole('textbox', { name: 'Link URL' })).toHaveValue('https://old.example.com')
  })

  // The component never unmounts (EditorScreen renders it unconditionally and
  // it returns null while closed), so a `useState(initialHref)` initialiser
  // would run exactly once, for the very first document, forever. Reopening
  // with a different href is the case that proves the open-time sync works.
  it('re-seeds on every open, not only on first mount', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <LinkComposer initialHref="" onRemoveLink={vi.fn()} onInsertLink={vi.fn()} />
    )

    useAppStore.setState({ linkComposerOpen: true })
    rerender(
      <LinkComposer
        initialHref="https://one.example.com"
        onRemoveLink={vi.fn()}
        onInsertLink={vi.fn()}
      />
    )
    expect(screen.getByRole('textbox', { name: 'Link URL' })).toHaveValue('https://one.example.com')

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    useAppStore.setState({ linkComposerOpen: true })
    rerender(
      <LinkComposer
        initialHref="https://two.example.com"
        onRemoveLink={vi.fn()}
        onInsertLink={vi.fn()}
      />
    )
    expect(screen.getByRole('textbox', { name: 'Link URL' })).toHaveValue('https://two.example.com')
  })

  it('reads Update rather than Insert, and offers Remove link', async () => {
    useAppStore.setState({ linkComposerOpen: true })
    const onRemoveLink = vi.fn()
    const user = userEvent.setup()
    render(
      <LinkComposer
        initialHref="https://old.example.com"
        onRemoveLink={onRemoveLink}
        onInsertLink={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove link' }))
    expect(onRemoveLink).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().linkComposerOpen).toBe(false)
  })

  it('offers no Remove link when there is no link to remove', () => {
    useAppStore.setState({ linkComposerOpen: true })
    render(<LinkComposer initialHref="" onRemoveLink={vi.fn()} onInsertLink={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Remove link' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Insert' })).toBeInTheDocument()
  })
})
