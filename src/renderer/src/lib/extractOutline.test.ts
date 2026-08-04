import { describe, it, expect } from 'vitest'
import { extractOutline } from './extractOutline'

describe('extractOutline', () => {
  it('returns an empty array for an empty document', () => {
    expect(extractOutline('')).toEqual([])
  })

  it('returns an empty array for a document with no headings at all', () => {
    expect(
      extractOutline('Just a paragraph of text.\n\nAnother paragraph, still no headings.')
    ).toEqual([])
  })

  it('extracts headings of every level (1-6) in document order with correct depth and text', () => {
    const source = [
      '# Title',
      '',
      '## Section',
      '',
      '### Subsection',
      '',
      '#### Sub-sub',
      '',
      '##### Deep',
      '',
      '###### Deepest'
    ].join('\n')

    const headings = extractOutline(source)

    expect(headings.map((h) => [h.depth, h.text])).toEqual([
      [1, 'Title'],
      [2, 'Section'],
      [3, 'Subsection'],
      [4, 'Sub-sub'],
      [5, 'Deep'],
      [6, 'Deepest']
    ])
  })

  it('reports a source offset pointing at the heading’s own marker', () => {
    const source = 'Intro paragraph.\n\n## Second Heading\n\nBody text.'
    const [heading] = extractOutline(source)

    expect(heading.sourceOffset).toBe(source.indexOf('## Second Heading'))
  })

  it('finds a heading nested inside a blockquote', () => {
    const source = '> # Quoted heading\n>\n> Some quoted body text.'
    const headings = extractOutline(source)

    expect(headings).toHaveLength(1)
    expect(headings[0]).toMatchObject({ depth: 1, text: 'Quoted heading' })
    expect(headings[0].sourceOffset).toBe(source.indexOf('# Quoted heading'))
  })

  it('finds multiple headings at different depths nested inside a blockquote', () => {
    const source = '> # Quoted H1\n>\n> ## Quoted H2\n>\n> body text'
    const headings = extractOutline(source)

    expect(headings.map((h) => [h.depth, h.text])).toEqual([
      [1, 'Quoted H1'],
      [2, 'Quoted H2']
    ])
  })

  it('does not treat a bold paragraph that merely looks like a heading as a real heading', () => {
    const source = '**This looks like a heading**\n\nBut it is only a bold paragraph.'
    expect(extractOutline(source)).toEqual([])
  })

  it('does not treat a paragraph starting with a literal "#" mid-sentence as a heading', () => {
    // No space after "#" -- CommonMark does not promote this to an ATX heading.
    const source = '#nofollow is a common rel attribute value.'
    expect(extractOutline(source)).toEqual([])
  })

  it('flattens inline formatting inside a heading down to plain text', () => {
    const source = '## Hello **world**, this is *emphasized* and `code`'
    const [heading] = extractOutline(source)
    expect(heading.text).toBe('Hello world, this is emphasized and code')
  })

  it('finds a heading after a YAML frontmatter block at its correct offset', () => {
    const source = [
      '---',
      'title: Doc',
      'author: Someone',
      '---',
      '',
      '# Real Heading',
      '',
      'Body.'
    ].join('\n')

    const headings = extractOutline(source)

    expect(headings).toHaveLength(1)
    expect(headings[0]).toMatchObject({ depth: 1, text: 'Real Heading' })
    expect(headings[0].sourceOffset).toBe(source.indexOf('# Real Heading'))
  })

  it('does not mistake frontmatter key: value lines for headings', () => {
    const source = [
      '---',
      'title: "# Not a heading"',
      '---',
      '',
      'Body only, no real heading.'
    ].join('\n')
    expect(extractOutline(source)).toEqual([])
  })

  it('preserves document order and strictly increasing offsets across mixed content', () => {
    const source = [
      '# First',
      '',
      'Some paragraph.',
      '',
      '## Second',
      '',
      '- a list',
      '- item',
      '',
      '### Third'
    ].join('\n')

    const headings = extractOutline(source)

    expect(headings.map((h) => h.text)).toEqual(['First', 'Second', 'Third'])
    for (let i = 1; i < headings.length; i++) {
      expect(headings[i].sourceOffset).toBeGreaterThan(headings[i - 1].sourceOffset)
    }
  })

  it('finds a Setext-style (underlined) H1 and H2', () => {
    const source = 'Title\n=====\n\nSubtitle\n--------\n\nBody.'
    const headings = extractOutline(source)

    expect(headings.map((h) => [h.depth, h.text])).toEqual([
      [1, 'Title'],
      [2, 'Subtitle']
    ])
  })
})
