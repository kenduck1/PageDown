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
})
