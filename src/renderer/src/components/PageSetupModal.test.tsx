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

  it('no longer claims these settings do not affect the rendered output', () => {
    // The inverse of the assertion this test used to make. Every control in
    // this dialog now reaches the paginated preview, thumbnails and exported
    // PDF (Page Geometry Wiring made size/orientation/margins real; Page
    // Setup Completeness did header/footer content, custom size, theme and
    // font), so the old notice would now actively mislead.
    render(
      <PageSetupModal open={true} initialConfig={CONFIG} onApply={vi.fn()} onClose={vi.fn()} />
    )
    expect(screen.queryByText(/don.t change the page layout/i)).not.toBeInTheDocument()
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
    expect(screen.getByLabelText('Footer left')).toHaveValue('Confidential')
    expect(screen.getByLabelText('Footer center')).toHaveValue('Page {n} of {total}')
    expect(screen.getByLabelText('Footer right')).toHaveValue('Acme Corp')

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

    const centerField = screen.getByLabelText('Footer center')
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

  // Product-completeness audit, Tier 1 section 1.4 -- same gap, same fix
  // (useModalDialog, shared with ShortcutsHelpModal), described at length in
  // that other test file's own comment. This modal is the one the audit's
  // concrete repro actually used (Page Setup was reachable with no keyboard
  // escape at all before this fix).
  it('pressing Escape calls onClose', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <PageSetupModal open={true} initialConfig={CONFIG} onApply={vi.fn()} onClose={onClose} />
    )

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('moves focus into the dialog when it opens, rather than leaving it in the background', async () => {
    render(
      <PageSetupModal open={true} initialConfig={CONFIG} onApply={vi.fn()} onClose={vi.fn()} />
    )

    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement)
    expect(document.activeElement).not.toBe(document.body)
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

  describe('header content fields', () => {
    it('renders a Left/Center/Right row for the header, pre-filled from initialConfig', () => {
      render(
        <PageSetupModal
          open={true}
          initialConfig={{ ...CONFIG, header: { left: 'Acme', center: '', right: 'Draft' } }}
          onApply={vi.fn()}
          onClose={vi.fn()}
        />
      )
      expect(screen.getByLabelText('Header left')).toHaveValue('Acme')
      expect(screen.getByLabelText('Header center')).toHaveValue('')
      expect(screen.getByLabelText('Header right')).toHaveValue('Draft')
    })

    it('applies an edited header value through onApply', async () => {
      const onApply = vi.fn()
      const user = userEvent.setup()
      render(
        <PageSetupModal open={true} initialConfig={CONFIG} onApply={onApply} onClose={vi.fn()} />
      )

      await user.type(screen.getByLabelText('Header center'), 'Quarterly Report')
      await user.click(screen.getByRole('button', { name: 'Apply' }))

      expect(onApply).toHaveBeenCalledWith(
        expect.objectContaining({
          header: expect.objectContaining({ center: 'Quarterly Report' })
        })
      )
    })
  })

  describe('custom page size fields', () => {
    it('hides the width/height inputs unless the Custom page size is selected', async () => {
      const user = userEvent.setup()
      render(
        <PageSetupModal
          open={true}
          initialConfig={{ ...CONFIG, pageSize: 'Letter' }}
          onApply={vi.fn()}
          onClose={vi.fn()}
        />
      )

      expect(screen.queryByLabelText('Width (in)')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Height (in)')).not.toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Custom' }))

      expect(screen.getByLabelText('Width (in)')).toBeInTheDocument()
      expect(screen.getByLabelText('Height (in)')).toBeInTheDocument()
    })

    it('applies edited custom dimensions through onApply', async () => {
      const onApply = vi.fn()
      const user = userEvent.setup()
      render(
        <PageSetupModal
          open={true}
          initialConfig={{ ...CONFIG, pageSize: 'Custom' }}
          onApply={onApply}
          onClose={vi.fn()}
        />
      )

      const width = screen.getByLabelText('Width (in)')
      await user.clear(width)
      await user.type(width, '5.5')
      await user.click(screen.getByRole('button', { name: 'Apply' }))

      expect(onApply).toHaveBeenCalledWith(
        expect.objectContaining({ pageSize: 'Custom', customWidth: 5.5 })
      )
    })
  })

  // Font family and font size moved here from EditorToolbar in the
  // single-row-toolbar pass. The move is not only about the 208px they cost
  // that toolbar: neither was ever selection formatting -- both write
  // PageConfig fields into the document's own frontmatter, changing every
  // page at once, which is precisely what this dialog is for. These four
  // tests are the toolbar suite's own font tests, brought across with the
  // controls rather than dropped.
  describe('Typography', () => {
    it('shows the config’s real font family and applies a change', async () => {
      const onApply = vi.fn()
      const user = userEvent.setup()
      render(
        <PageSetupModal
          open={true}
          initialConfig={{ ...CONFIG, fontFamily: 'source-serif-4' }}
          onApply={onApply}
          onClose={vi.fn()}
        />
      )

      const select = screen.getByLabelText('Font family')
      expect(select).toHaveValue('source-serif-4')

      await user.selectOptions(select, 'inter')
      await user.click(screen.getByRole('button', { name: 'Apply' }))

      expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ fontFamily: 'inter' }))
    })

    it('shows the config’s real font size and applies a change', async () => {
      // The assertion the ORIGINAL toolbar control could never have passed:
      // it shipped with a hardcoded `defaultValue="11"` and no onChange at
      // all, so it reported a size the document did not have and discarded
      // every change made to it.
      const onApply = vi.fn()
      const user = userEvent.setup()
      render(
        <PageSetupModal
          open={true}
          initialConfig={{ ...CONFIG, fontSize: 12 }}
          onApply={onApply}
          onClose={vi.fn()}
        />
      )

      const select = screen.getByLabelText('Font size')
      expect(select).toHaveValue('12')

      await user.selectOptions(select, '16')
      await user.click(screen.getByRole('button', { name: 'Apply' }))

      expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 16 }))
    })

    it('round-trips the Default size as the STRING, not a number', async () => {
      // 'default' is a real PageFontSize meaning "whatever the theme says",
      // and it emits no size class at all. Coercing it through Number() would
      // produce NaN and silently drop the field.
      const onApply = vi.fn()
      const user = userEvent.setup()
      render(
        <PageSetupModal
          open={true}
          initialConfig={{ ...CONFIG, fontSize: 12 }}
          onApply={onApply}
          onClose={vi.fn()}
        />
      )

      await user.selectOptions(screen.getByLabelText('Font size'), 'default')
      await user.click(screen.getByRole('button', { name: 'Apply' }))

      expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 'default' }))
    })

    it('falls back to Default for a config that sets no size', () => {
      render(
        <PageSetupModal
          open={true}
          initialConfig={{ ...CONFIG, fontSize: 'default' }}
          onApply={vi.fn()}
          onClose={vi.fn()}
        />
      )
      expect(screen.getByLabelText('Font size')).toHaveValue('default')
    })
  })
})
