import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PageSetupModal from './PageSetupModal'
import { DEFAULT_PAGE_CONFIG } from '../../../markdown/page-config'
import type { PageConfig } from '../../../markdown/page-config'

afterEach(() => {
  cleanup()
})

const CONFIG: PageConfig = {
  ...DEFAULT_PAGE_CONFIG,
  pageSize: 'A4',
  orientation: 'landscape',
  margins: { top: 0.5, bottom: 0.75, left: 1, right: 1.25 },
  showHeader: true,
  showFooter: true,
  footer: { left: 'Confidential', center: 'Page {n} of {total}', right: 'Acme Corp' },
  pageNumberFormat: 'roman',
  theme: 'report'
}

describe('PageSetupModal', () => {
  it('renders nothing when open is false', () => {
    render(
      <PageSetupModal open={false} initialConfig={CONFIG} onApply={vi.fn()} onClose={vi.fn()} />
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows a visible, persistent notice that these settings do not yet affect rendering', () => {
    render(
      <PageSetupModal open={true} initialConfig={CONFIG} onApply={vi.fn()} onClose={vi.fn()} />
    )
    expect(
      screen.getByText(/don.t change the page layout in the preview or exported PDF yet/i)
    ).toBeInTheDocument()
  })

  it("renders with initialConfig's values pre-filled", () => {
    render(
      <PageSetupModal open={true} initialConfig={CONFIG} onApply={vi.fn()} onClose={vi.fn()} />
    )

    // Page size / orientation pills reflect the selected values.
    expect(screen.getByRole('button', { name: 'A4' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Letter' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Landscape' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    // Margins.
    expect(screen.getByLabelText('Top (in)')).toHaveValue(0.5)
    expect(screen.getByLabelText('Bottom (in)')).toHaveValue(0.75)
    expect(screen.getByLabelText('Left (in)')).toHaveValue(1)
    expect(screen.getByLabelText('Right (in)')).toHaveValue(1.25)

    // Header/footer toggles.
    expect(screen.getByRole('switch', { name: 'Show header' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByRole('switch', { name: 'Show footer' })).toHaveAttribute(
      'aria-checked',
      'true'
    )

    // Footer text fields.
    expect(screen.getByLabelText('Left')).toHaveValue('Confidential')
    expect(screen.getByLabelText('Center')).toHaveValue('Page {n} of {total}')
    expect(screen.getByLabelText('Right')).toHaveValue('Acme Corp')

    // Page-number format + theme.
    expect(screen.getByRole('button', { name: 'i, ii, iii' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Theme: Report' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('changing a field updates the in-modal draft without calling onApply', async () => {
    const onApply = vi.fn()
    const user = userEvent.setup()
    render(
      <PageSetupModal open={true} initialConfig={CONFIG} onApply={onApply} onClose={vi.fn()} />
    )

    await user.click(screen.getByRole('button', { name: 'Letter' }))

    expect(screen.getByRole('button', { name: 'Letter' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'A4' })).toHaveAttribute('aria-pressed', 'false')
    expect(onApply).not.toHaveBeenCalled()
  })

  it('clicking Apply calls onApply with the full updated draft config', async () => {
    const onApply = vi.fn()
    const user = userEvent.setup()
    render(
      <PageSetupModal open={true} initialConfig={CONFIG} onApply={onApply} onClose={vi.fn()} />
    )

    await user.click(screen.getByRole('button', { name: 'Letter' }))
    await user.click(screen.getByRole('button', { name: 'Portrait' }))
    await user.click(screen.getByRole('switch', { name: 'Show header' }))

    const centerField = screen.getByLabelText('Center')
    await user.clear(centerField)
    await user.type(centerField, 'Custom footer text')

    await user.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith({
      ...CONFIG,
      pageSize: 'Letter',
      orientation: 'portrait',
      showHeader: false,
      footer: { ...CONFIG.footer, center: 'Custom footer text' }
    })
  })

  it('clicking Cancel calls onClose without calling onApply', async () => {
    const onApply = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <PageSetupModal open={true} initialConfig={CONFIG} onApply={onApply} onClose={onClose} />
    )

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onApply).not.toHaveBeenCalled()
  })

  it('clicking the close (x) button calls onClose without calling onApply', async () => {
    const onApply = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <PageSetupModal open={true} initialConfig={CONFIG} onApply={onApply} onClose={onClose} />
    )

    await user.click(screen.getByRole('button', { name: 'Close' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onApply).not.toHaveBeenCalled()
  })

  it('clicking the scrim calls onClose without calling onApply', async () => {
    const onApply = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <PageSetupModal open={true} initialConfig={CONFIG} onApply={onApply} onClose={onClose} />
    )

    await user.click(screen.getByTestId('page-setup-scrim'))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onApply).not.toHaveBeenCalled()
  })

  it('clicking inside the dialog body does not trigger the scrim close handler', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <PageSetupModal open={true} initialConfig={CONFIG} onApply={vi.fn()} onClose={onClose} />
    )

    await user.click(screen.getByRole('dialog'))
    await user.click(screen.getByText('Margins'))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('re-seeds the draft from initialConfig each time the modal opens', async () => {
    const onApply = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <PageSetupModal open={true} initialConfig={CONFIG} onApply={onApply} onClose={vi.fn()} />
    )

    await user.click(screen.getByRole('button', { name: 'Letter' }))

    rerender(
      <PageSetupModal open={false} initialConfig={CONFIG} onApply={onApply} onClose={vi.fn()} />
    )
    rerender(
      <PageSetupModal open={true} initialConfig={CONFIG} onApply={onApply} onClose={vi.fn()} />
    )

    expect(screen.getByRole('button', { name: 'A4' })).toHaveAttribute('aria-pressed', 'true')
  })
})
