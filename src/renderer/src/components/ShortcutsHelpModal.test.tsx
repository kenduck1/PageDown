import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ShortcutsHelpModal from './ShortcutsHelpModal'

afterEach(() => {
  cleanup()
})

describe('ShortcutsHelpModal', () => {
  it('renders nothing when open is false', () => {
    render(<ShortcutsHelpModal open={false} onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders a real, non-empty list of shortcuts when open', () => {
    render(<ShortcutsHelpModal open={true} onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(dialog).toBeInTheDocument()
    // Spot-check real, load-bearing entries -- Find (the app's own
    // pre-existing shortcut) and Undo (the one this same push added a real
    // keyboard binding for) -- rather than asserting the full list, which
    // would just re-encode this file's own CATEGORIES constant.
    expect(screen.getByText('Find')).toBeInTheDocument()
    expect(screen.getByText('Undo')).toBeInTheDocument()
    expect(screen.getByText('Bold')).toBeInTheDocument()
  })

  it('lists the tab-reorder chord, which is otherwise unreachable without a pointer', () => {
    // Deliberately NOT a general "the list is complete" assertion (there is
    // no way to write one, and the spot-check above says why). This entry gets
    // its own test because of what it is: EditorTabBar's keyboard reordering
    // exists precisely so the feature is not drag-only, so its whole audience
    // is people who will never discover it by trying the mouse -- and it was
    // missing from the app's only in-product reference.
    render(<ShortcutsHelpModal open={true} onClose={vi.fn()} />)
    expect(
      screen.getByText('Move the focused tab left or right (with a tab focused)')
    ).toBeInTheDocument()
  })

  it('clicking the close button calls onClose', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ShortcutsHelpModal open={true} onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: 'Close' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking the scrim (outside the dialog) calls onClose', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ShortcutsHelpModal open={true} onClose={onClose} />)

    await user.click(screen.getByTestId('shortcuts-help-scrim'))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking inside the dialog itself does not call onClose', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ShortcutsHelpModal open={true} onClose={onClose} />)

    await user.click(screen.getByRole('dialog'))

    expect(onClose).not.toHaveBeenCalled()
  })

  // Product-completeness audit, Tier 1 section 1.4: this modal had NO Escape
  // handler and NO focus management at all -- aria-modal="true" was a false
  // claim, and pressing Mod-/ left focus in the document behind the scrim,
  // so every keystroke (including Escape itself) went into the user's file.
  // Both real behaviours now come from the shared useModalDialog hook (see
  // useModalDialog.test.tsx for the hook's own dedicated, thorough coverage
  // of focus-trap/focus-restore); these two tests are the wiring-level proof
  // that THIS component actually uses it, matching this file's existing
  // "click calls onClose" tests' level of integration rather than duplicating
  // the hook's own unit tests here.
  it('pressing Escape calls onClose', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ShortcutsHelpModal open={true} onClose={onClose} />)

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('moves focus into the dialog when it opens, rather than leaving it in the background', async () => {
    render(<ShortcutsHelpModal open={true} onClose={vi.fn()} />)

    // No render-triggered wait needed: useModalDialog's focus-in runs inside
    // a useEffect, and Testing Library's render() already flushes effects
    // synchronously (wrapped in its own act()) before returning.
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement)
    expect(document.activeElement).not.toBe(document.body)
  })
})
