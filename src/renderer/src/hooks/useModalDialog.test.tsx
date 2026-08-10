import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useModalDialog } from './useModalDialog'

afterEach(() => {
  cleanup()
})

// A minimal stand-in dialog -- deliberately not PageSetupModal/
// ShortcutsHelpModal themselves, so these tests exercise the HOOK's own
// contract in isolation rather than re-testing either component's unrelated
// content. Both real modals wire up the exact same three props (ref, role,
// tabIndex={-1}) this fixture does -- see their own "Escape-to-close..."
// comments.
function TestDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const dialogRef = useModalDialog(open, onClose)
  if (!open) return null
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Test dialog" tabIndex={-1}>
      <button type="button">First</button>
      <input aria-label="Middle field" />
      <button type="button">Last</button>
    </div>
  )
}

// Wraps TestDialog with a real trigger button so focus-restore has something
// genuine to restore TO -- matching the real bug report (Mod-/ pressed while
// focus was somewhere in the document, not nowhere).
function Harness(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <TestDialog open={open} onClose={() => setOpen(false)} />
    </div>
  )
}

describe('useModalDialog', () => {
  it('moves focus into the dialog (its first focusable element) as soon as it opens', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Open dialog' }))

    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus()
  })

  it('restores focus to whatever was focused before the dialog opened, once it closes', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open dialog' })

    await user.click(opener)
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus()

    // Escape is the real close path a keyboard user actually takes -- see
    // the dedicated Escape test below for the direct assertion; here it's
    // just how this test gets from open to closed.
    await user.keyboard('{Escape}')

    expect(opener).toHaveFocus()
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    function Wired(): React.JSX.Element {
      return <TestDialog open={true} onClose={onClose} />
    }
    const user = userEvent.setup()
    render(<Wired />)

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('traps Tab: tabbing from the LAST focusable element wraps to the FIRST', async () => {
    const user = userEvent.setup()
    render(<TestDialog open={true} onClose={vi.fn()} />)

    screen.getByRole('button', { name: 'Last' }).focus()
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus()

    await user.tab()

    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus()
  })

  it('traps Shift+Tab: tabbing backward from the FIRST focusable element wraps to the LAST', async () => {
    const user = userEvent.setup()
    render(<TestDialog open={true} onClose={vi.fn()} />)

    screen.getByRole('button', { name: 'First' }).focus()
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus()

    await user.tab({ shift: true })

    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus()
  })

  it('does not trap Tab when a middle element already has focus (only the ends wrap)', async () => {
    const user = userEvent.setup()
    render(<TestDialog open={true} onClose={vi.fn()} />)

    screen.getByLabelText('Middle field').focus()
    await user.tab()

    // Ordinary forward Tab from the middle -- browser default, unimpeded.
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus()
  })
})
