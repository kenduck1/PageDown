import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditorPages from './EditorPages'

afterEach(cleanup)

describe('EditorPages', () => {
  it('renders one row per page', () => {
    render(<EditorPages pageCount={3} currentPage={1} onSelectPage={vi.fn()} />)
    expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Page 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Page 3' })).toBeInTheDocument()
  })

  it('marks the current page as selected', () => {
    render(<EditorPages pageCount={3} currentPage={2} onSelectPage={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: 'Page 1' })).not.toHaveAttribute('aria-current')
  })

  it('calls back with the clicked page', async () => {
    const user = userEvent.setup()
    const onSelectPage = vi.fn()
    render(<EditorPages pageCount={5} currentPage={1} onSelectPage={onSelectPage} />)
    await user.click(screen.getByRole('button', { name: 'Page 4' }))
    expect(onSelectPage).toHaveBeenCalledWith(4)
  })

  it('shows an empty state when the count is unknown', () => {
    render(<EditorPages currentPage={1} onSelectPage={vi.fn()} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByText(/page count is not available/i)).toBeInTheDocument()
  })

  it('shows an empty state for a zero-page document', () => {
    render(<EditorPages pageCount={0} currentPage={1} onSelectPage={vi.fn()} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})
