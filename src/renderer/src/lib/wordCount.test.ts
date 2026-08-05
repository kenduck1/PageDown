import { describe, it, expect } from 'vitest'
import { countWords } from './wordCount'

describe('countWords', () => {
  it('counts plain prose as whitespace-delimited words', () => {
    expect(countWords('Hello there, world.')).toBe(3)
  })

  it('returns 0 for an empty document', () => {
    expect(countWords('')).toBe(0)
  })

  it('returns 0 for a whitespace-only document', () => {
    expect(countWords('   \n\n  \t ')).toBe(0)
  })

  it('strips heading markers and counts only the heading text', () => {
    expect(countWords('# Hello World')).toBe(2)
  })

  it('strips list markers and counts only the item text', () => {
    const markdown = '- Item one\n- Item two\n- Item three'
    // "Item one" (2) + "Item two" (2) + "Item three" (2) = 6
    expect(countWords(markdown)).toBe(6)
  })

  it('strips ordered-list numbering and counts only the item text', () => {
    const markdown = '1. First item\n2. Second item'
    expect(countWords(markdown)).toBe(4)
  })

  it('strips emphasis/strong markers and counts only the wrapped text', () => {
    expect(countWords('This is *emphasized* and **bold** text.')).toBe(6)
  })

  it('excludes fenced code block content from the count', () => {
    const markdown = [
      '# Heading',
      '',
      '```js',
      'const x = 1',
      'function foo() {}',
      '```',
      '',
      'Body paragraph after.'
    ].join('\n')
    // "Heading" (1) + "Body paragraph after." (3) = 4. None of the code
    // block's tokens (const, x, =, 1, function, foo, (), {}) count.
    expect(countWords(markdown)).toBe(4)
  })

  it('excludes indented code block content from the count', () => {
    const markdown = 'Intro line.\n\n    var codeToken = 42\n\nOutro line.'
    expect(countWords(markdown)).toBe(4)
  })

  it('includes inline code content, since it sits inside real prose', () => {
    expect(countWords('Run `npm install` first.')).toBe(4)
  })

  it('excludes YAML frontmatter content from the count', () => {
    const markdown = [
      '---',
      'title: My Document',
      'author: Someone Important',
      '---',
      '',
      '# Heading',
      '',
      'Body text here.'
    ].join('\n')
    // Frontmatter's "title", "My", "Document", "author", "Someone",
    // "Important" must NOT count. Only "Heading" (1) + "Body text here." (3)
    // = 4.
    expect(countWords(markdown)).toBe(4)
  })

  it('counts link text but not the URL or bracket/paren syntax', () => {
    expect(countWords('See [the docs](https://example.com/very/long/path) for more.')).toBe(5)
  })

  it('counts table cell text', () => {
    const markdown = ['| Name | Role |', '| --- | --- |', '| Ada Lovelace | Engineer |'].join('\n')
    // "Name" + "Role" (header) + "Ada Lovelace" + "Engineer" = 5
    expect(countWords(markdown)).toBe(5)
  })

  it('does not count a raw <!-- pagebreak --> marker as a word', () => {
    expect(countWords('One.\n\n<!-- pagebreak -->\n\nTwo.')).toBe(2)
  })

  // Regression tests: an inline element (link/bold/inline-code/emphasis)
  // directly adjacent to surrounding text with NO whitespace between them
  // used to split one reader-visible word into extra spurious tokens (or,
  // for a mid-word split, undercount) because words were counted per
  // mdast text/inlineCode node independently instead of per concatenated
  // block. All four of these previously returned the wrong count despite
  // every other test above passing, because every other fixture happened
  // to place whitespace after the inline element.
  it('counts a link immediately followed by punctuation as ending one word, not two', () => {
    // "See", "the", "docs." -- the trailing "." must attach to "docs", not
    // become its own one-character token.
    expect(countWords('See [the docs](https://example.com).')).toBe(3)
  })

  it('counts bold text immediately followed by punctuation as ending one word, not two', () => {
    // "This", "is", "bold."
    expect(countWords('This is **bold**.')).toBe(3)
  })

  it('counts inline code immediately followed by punctuation as one word, not two', () => {
    // "Use", "npm,", "then", "stop." -- the comma right after the
    // backtick-closed inline code must attach to "npm", not stand alone.
    expect(countWords('Use `npm`, then stop.')).toBe(4)
  })

  it('merges a word split mid-token by emphasis with no surrounding whitespace', () => {
    // "un" + "bel" (emphasized) + "ievable" are one continuous word with
    // zero whitespace anywhere between them -- "unbelievable word", 2
    // words, not 4 from three independently-split fragments.
    expect(countWords('un*bel*ievable word')).toBe(2)
  })

  it('matches manual expectation for a realistic mixed fixture', () => {
    const markdown = [
      '---',
      'title: Report',
      '---',
      '',
      '# Quarterly Report',
      '',
      'This report covers *three* areas: sales, support, and engineering.',
      '',
      '## Sales',
      '',
      '- Revenue grew by 12 percent.',
      '- New accounts: 8.',
      '',
      '```js',
      'const total = revenue.reduce((a, b) => a + b, 0)',
      '```',
      '',
      'See the `total` variable above for the raw figure.'
    ].join('\n')
    // "Quarterly Report" (2)
    // "This report covers three areas: sales, support, and engineering." (9)
    // "Sales" (1)
    // "Revenue grew by 12 percent." (5)
    // "New accounts: 8." (3)
    // (code block excluded)
    // "See the total variable above for the raw figure." (9, "total" from inlineCode)
    // Total: 2 + 9 + 1 + 5 + 3 + 9 = 29
    expect(countWords(markdown)).toBe(29)
  })
})
