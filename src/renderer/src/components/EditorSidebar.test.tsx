import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditorSidebar from './EditorSidebar'
import { useAppStore, initialAppState } from '../store/appStore'

const SOURCE = '# Executive Summary\n\n## Key Findings\n\nBody text.'

beforeEach(() => {
  useAppStore.setState(initialAppState)
})

afterEach(() => {
  cleanup()
})

describe('EditorSidebar', () => {
  it('starts on the Pages tab by default, matching initialAppState', () => {
    render(<EditorSidebar content={SOURCE} onSelectHeading={vi.fn()} />)

    expect(useAppStore.getState().sidebarTab).toBe('pages')
    expect(screen.getByRole('button', { name: 'Pages' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Outline' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('clicking the Outline pill switches sidebarTab in the store and renders outline content', async () => {
    const user = userEvent.setup()
    render(<EditorSidebar content={SOURCE} onSelectHeading={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Outline' }))

    expect(useAppStore.getState().sidebarTab).toBe('outline')
    expect(screen.getByRole('button', { name: 'Executive Summary' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Key Findings' })).toBeInTheDocument()
  })

  it('clicking back to the Pages pill switches sidebarTab back and hides outline content', async () => {
    const user = userEvent.setup()
    useAppStore.setState({ sidebarTab: 'outline' })
    render(<EditorSidebar content={SOURCE} onSelectHeading={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Pages' }))

    expect(useAppStore.getState().sidebarTab).toBe('pages')
    expect(screen.queryByRole('button', { name: 'Executive Summary' })).not.toBeInTheDocument()
  })

  it('forwards onSelectHeading and activeSourceOffset through to the Outline tab', async () => {
    const user = userEvent.setup()
    const onSelectHeading = vi.fn()
    useAppStore.setState({ sidebarTab: 'outline' })
    render(
      <EditorSidebar content={SOURCE} onSelectHeading={onSelectHeading} activeSourceOffset={0} />
    )

    await user.click(screen.getByRole('button', { name: 'Key Findings' }))

    expect(onSelectHeading).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Executive Summary' }).className).toContain(
      'bg-accent/9'
    )
  })

  it('shows an honest "not available" note on the Pages tab when pageCount is not supplied', () => {
    render(<EditorSidebar content={SOURCE} onSelectHeading={vi.fn()} />)

    expect(screen.getByText(/page count is not available yet/i)).toBeInTheDocument()
  })

  it('shows the real page count on the Pages tab when pageCount is supplied, without inventing a number', () => {
    render(<EditorSidebar content={SOURCE} onSelectHeading={vi.fn()} pageCount={6} />)

    expect(screen.getByText('6 pages')).toBeInTheDocument()
    expect(screen.getByText(/thumbnails are not built yet/i)).toBeInTheDocument()
  })

  it('uses singular "page" for a pageCount of exactly 1', () => {
    render(<EditorSidebar content={SOURCE} onSelectHeading={vi.fn()} pageCount={1} />)

    expect(screen.getByText('1 page')).toBeInTheDocument()
  })
})
