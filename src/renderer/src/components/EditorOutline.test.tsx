import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditorOutline from './EditorOutline'
import { extractOutline } from '../lib/extractOutline'

const SOURCE = ['# Executive Summary', '', '## Key Findings', '', '# Market Risks', ''].join('\n')

afterEach(() => {
  cleanup()
})

describe('EditorOutline', () => {
  it('renders one row per heading, in document order, with correct text', () => {
    render(<EditorOutline content={SOURCE} onSelectHeading={vi.fn()} />)

    const rows = screen.getAllByRole('button')
    expect(rows.map((row) => row.textContent)).toEqual([
      'Executive Summary',
      'Key Findings',
      'Market Risks'
    ])
  })

  it('gives an H1 row the 12.5px size class and no extra indent', () => {
    render(<EditorOutline content={SOURCE} onSelectHeading={vi.fn()} />)

    const row = screen.getByRole('button', { name: 'Executive Summary' })
    expect(row.className).toContain('text-12-5')
    expect(row.className).not.toContain('pl-5')
  })

  it('gives a nested H2 row the 11.5px size class and the +12px indent', () => {
    render(<EditorOutline content={SOURCE} onSelectHeading={vi.fn()} />)

    const row = screen.getByRole('button', { name: 'Key Findings' })
    expect(row.className).toContain('text-11-5')
    expect(row.className).toContain('pl-5')
  })

  it('calls onSelectHeading with that heading’s exact source offset when a row is clicked', async () => {
    const user = userEvent.setup()
    const onSelectHeading = vi.fn()
    const headings = extractOutline(SOURCE)
    render(<EditorOutline content={SOURCE} onSelectHeading={onSelectHeading} />)

    await user.click(screen.getByRole('button', { name: 'Market Risks' }))

    expect(onSelectHeading).toHaveBeenCalledTimes(1)
    expect(onSelectHeading).toHaveBeenCalledWith(headings[2].sourceOffset)
  })

  it('highlights the heading whose range contains activeSourceOffset', () => {
    const headings = extractOutline(SOURCE)
    // A position inside the "Key Findings" section (after its own heading,
    // before the next one).
    const activeSourceOffset = headings[1].sourceOffset + 5

    render(
      <EditorOutline
        content={SOURCE}
        onSelectHeading={vi.fn()}
        activeSourceOffset={activeSourceOffset}
      />
    )

    const activeRow = screen.getByRole('button', { name: 'Key Findings' })
    const inactiveRow = screen.getByRole('button', { name: 'Executive Summary' })

    expect(activeRow.className).toContain('bg-accent/9')
    expect(activeRow.className).toContain('text-accent')
    expect(inactiveRow.className).not.toContain('bg-accent/9')
  })

  it('highlights nothing when activeSourceOffset is before every heading', () => {
    // Leading prose before the first heading, so offset 0 genuinely precedes
    // every heading (unlike SOURCE above, whose first heading starts at 0).
    const sourceWithIntro = `Intro line before any heading.\n\n${SOURCE}`

    render(
      <EditorOutline content={sourceWithIntro} onSelectHeading={vi.fn()} activeSourceOffset={0} />
    )

    for (const row of screen.getAllByRole('button')) {
      expect(row.className).not.toContain('bg-accent/9')
    }
  })

  it('renders an honest empty state, with no rows, for a document with no headings', () => {
    render(<EditorOutline content="Just a paragraph, no headings." onSelectHeading={vi.fn()} />)

    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByText(/no headings/i)).toBeInTheDocument()
  })
})
