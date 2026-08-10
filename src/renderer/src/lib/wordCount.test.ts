import { describe, it, expect } from 'vitest'
import { countWords, countCharacters, analyzeText } from './wordCount'

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

  // Product-completeness audit, §2.4: raw HTML blocks previously rendered
  // (pipeline.ts) but counted zero words, since a bare `html` mdast node
  // contributed nothing to concatenateInlineText/computeTextStats.
  describe('raw HTML text (fix for the disclosed "counts zero words" gap)', () => {
    it('counts visible text inside a block-level raw HTML element, excluding its tags', () => {
      const markdown = 'Intro.\n\n<div>\nSome real text here.\n</div>\n\nOutro.'
      // "Intro." (1) + "Some real text here." (4) + "Outro." (1) = 6.
      // Confirmed against the real parsed tree: the <div>...</div> block is
      // ONE root-level `html` node, a sibling of the two paragraphs, not
      // nested inside either.
      expect(countWords(markdown)).toBe(6)
    })

    it('still counts zero words for a bare HTML comment (e.g. <!-- pagebreak -->)', () => {
      // Regression guard for the pre-existing pagebreak test above: comment
      // CONTENT must never count as prose just because tag-stripping alone
      // would otherwise expose it.
      expect(countWords('One.\n\n<!-- a note to self, not for readers -->\n\nTwo.')).toBe(2)
    })

    it('counts the real text inside a comment-marker pair that CommonMark folds into one html node', () => {
      // Mirrors the Comments feature's own marker shape (CLAUDE.md's
      // "Comments" section): when a `<!--comment...-->marked text<!--/comment...-->`
      // run OPENS a paragraph, CommonMark's HTML-block-type-2 rule folds
      // the whole line -- both comments AND the real text between them --
      // into a single `html` node. Both comments must disappear and
      // "marked text" must still count, i.e. this must NOT collapse to 0
      // words the way it did before this fix.
      const markdown =
        '<!--comment id="c1" data="eyJ4IjoxfQ=="-->marked text<!--/comment id="c1"-->'
      expect(countWords(markdown)).toBe(2)
    })

    it('is a no-op for an inline tag delimiter that already sits beside real text nodes', () => {
      // "Before <span>text **bold** more</span> after." -- remark-parse
      // already splits this into real text/strong nodes for "text"/"bold"/
      // "more"/"after." plus two BARE-tag `html` nodes ("<span>", "</span>")
      // that contribute nothing themselves; this proves the fix doesn't
      // double-count anything already being counted correctly.
      const markdown = 'Before <span>text **bold** more</span> after.'
      // "Before" "text" "bold" "more" "after." = 5.
      expect(countWords(markdown)).toBe(5)
    })
  })

  describe('countCharacters / analyzeText', () => {
    it('counts characters of the same rendered text words counts, not markdown.length', () => {
      // "Hello" (5 chars) -- **not** "**Hello**".length (9).
      expect(countCharacters('**Hello**')).toBe(5)
    })

    it('excludes frontmatter/code from the character count exactly like countWords excludes them', () => {
      const markdown = ['---', 'title: X', '---', '', 'Hi.'].join('\n')
      expect(countCharacters(markdown)).toBe(3)
    })

    it('analyzeText returns the same numbers as the separate word/character functions, from one parse', () => {
      const markdown = 'This is *emphasized* and **bold** text.'
      expect(analyzeText(markdown)).toEqual({
        words: countWords(markdown),
        characters: countCharacters(markdown)
      })
    })
  })
})
