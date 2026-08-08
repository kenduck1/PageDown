import { describe, it, expect } from 'vitest'
import { extractRawFrontmatter, replaceRawFrontmatter } from './frontmatter-splice'

describe('extractRawFrontmatter', () => {
  it('returns the raw YAML text between the fences', () => {
    const source = '---\ntitle: Hello\npage: Letter\n---\n\n# Body\n'
    expect(extractRawFrontmatter(source)).toBe('title: Hello\npage: Letter')
  })

  it('returns an empty string for a document with no frontmatter block', () => {
    expect(extractRawFrontmatter('# Just a doc\n\nNo frontmatter here.\n')).toBe('')
  })

  it('returns an empty string for an empty document', () => {
    expect(extractRawFrontmatter('')).toBe('')
  })
})

describe('replaceRawFrontmatter', () => {
  it('replaces an existing frontmatter block in place, leaving the rest of the document untouched', () => {
    const source = '---\ntitle: Hello\npage: Letter\n---\n\n# Body\n\nSome text.\n'
    const result = replaceRawFrontmatter(source, 'title: Hello\npage: A4')
    expect(result).toBe('---\ntitle: Hello\npage: A4\n---\n\n# Body\n\nSome text.\n')
  })

  it('inserts a fresh frontmatter block at the top when the document has none', () => {
    const source = '# Body\n\nSome text.\n'
    const result = replaceRawFrontmatter(source, 'page: Letter')
    expect(result).toBe('---\npage: Letter\n---\n\n# Body\n\nSome text.\n')
  })

  it('leaves the document byte-identical when there is no existing block and nothing to add', () => {
    const source = '# Body\n\nSome text.\n'
    expect(replaceRawFrontmatter(source, '')).toBe(source)
  })

  it('preserves content before the frontmatter-relative position exactly (no leading content case)', () => {
    const source = '---\nkey: old\n---\n'
    const result = replaceRawFrontmatter(source, 'key: new')
    expect(result).toBe('---\nkey: new\n---\n')
  })
})
