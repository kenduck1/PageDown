import { describe, expect, it } from 'vitest'
import {
  MAX_HIGHLIGHTED_SOURCE_TOKENS,
  tokenizeMarkdownSource,
  type SourceToken,
  type SourceTokenKind
} from './markdown-source-tokens'

// Renders one line's tokens as `kind:"text"` pairs -- asserting on the SLICED
// text rather than on raw offsets, because an off-by-one in a start/end pair is
// the whole class of bug here and a bare number pins it far less legibly than
// the characters it selects.
function describeLine(source: string, index = 0): string[] {
  const line = tokenizeMarkdownSource(source)[index]
  return line.tokens.map((t) => `${t.kind}:${JSON.stringify(line.text.slice(t.start, t.end))}`)
}

function kindsOf(source: string, index = 0): SourceTokenKind[] {
  return tokenizeMarkdownSource(source)[index].tokens.map((t) => t.kind)
}

describe('tokenizeMarkdownSource', () => {
  it('emits one entry per line, including the empty last line after a trailing newline', () => {
    const lines = tokenizeMarkdownSource('a\nb\n')
    expect(lines.map((l) => l.text)).toEqual(['a', 'b', ''])
  })

  // The single invariant the whole rendering layer stands on: tokens never
  // overlap and never run backwards, so the renderer can walk them once and
  // emit the gaps as plain text. A violation would slice the source into
  // duplicated or dropped characters -- i.e. the mirror would show text the
  // textarea does not contain.
  it('emits non-overlapping, ascending, in-bounds tokens for a document using every construct', () => {
    const source = [
      '---',
      'title: Demo',
      '---',
      '# Heading',
      'Some **bold** _em_ `code` ~~gone~~ $$x^2$$ text.',
      '> quote with **bold**',
      '- [ ] task',
      '1. numbered',
      '[link](https://example.com) ![alt](img.png) [ref][a] <https://auto.link>',
      '[a]: https://example.com/def',
      '| a | b |',
      '```ts',
      'const x = 1',
      '```',
      '<!-- pagebreak -->',
      '<div class="x">raw</div>',
      '***',
      'Escaped \\*not emphasis\\* and snake_case_name.'
    ].join('\n')

    for (const line of tokenizeMarkdownSource(source)) {
      let previousEnd = 0
      for (const token of line.tokens) {
        expect(token.start).toBeGreaterThanOrEqual(previousEnd)
        expect(token.end).toBeGreaterThan(token.start)
        expect(token.end).toBeLessThanOrEqual(line.text.length)
        previousEnd = token.end
      }
    }
  })

  describe('block constructs', () => {
    it('treats a leading --- as frontmatter and closes it on the next fence', () => {
      const lines = tokenizeMarkdownSource('---\ntitle: x\n---\nbody')
      expect(lines.map((l) => l.context)).toEqual(['start', 'frontmatter', 'frontmatter', 'normal'])
      expect(lines[2].tokens.map((t) => t.kind)).toEqual(['frontmatter'])
      expect(lines[3].tokens).toEqual([])
    })

    // A --- anywhere but line 0 is a thematic break. Getting this wrong would
    // tint the entire rest of a document as metadata, which is exactly why
    // `context` carries a distinct 'start' value for the first line only.
    it('reads --- below the first line as a thematic break, not frontmatter', () => {
      const lines = tokenizeMarkdownSource('body\n\n---\nmore')
      expect(lines[2].tokens.map((t) => t.kind)).toEqual(['rule'])
      expect(lines[3].context).toBe('normal')
    })

    it('holds fenced-code state across lines and does not tokenize markdown inside it', () => {
      expect(describeLine('```js\n**not bold**\n```', 1)).toEqual(['code:"**not bold**"'])
      expect(describeLine('```js\n**not bold**\n```', 2)).toEqual(['marker:"```"'])
    })

    it('labels a fence info string separately from the fence itself', () => {
      expect(describeLine('```ts')).toEqual(['marker:"```"', 'code-info:"ts"'])
      expect(describeLine('```')).toEqual(['marker:"```"'])
    })

    // A shorter run cannot close a longer fence, which is why `context` carries
    // the opening run rather than a bare 'code'.
    it('does not let a shorter backtick run close a longer fence', () => {
      const lines = tokenizeMarkdownSource('````\n```\nstill code\n````')
      expect(lines[1].tokens.map((t) => t.kind)).toEqual(['code'])
      expect(lines[2].context).toBe('code:````')
      expect(lines[3].tokens.map((t) => t.kind)).toEqual(['marker'])
    })

    it('tints an unterminated HTML comment from its opener to the end of the block', () => {
      const source = 'before <!--\nhidden prose\n--> after'
      const lines = tokenizeMarkdownSource(source)
      // The OPENING line is the half the inline scanner alone cannot see: its
      // `<!--` never closes on that line, so without the dedicated lookahead a
      // user who commented out a block would watch the comment start one line
      // below the line that started it.
      expect(describeLine(source, 0)).toEqual(['html:"<!--"'])
      expect(lines[1].context).toBe('comment')
      expect(lines[1].tokens.map((t) => t.kind)).toEqual(['html'])
      expect(lines[2].tokens.map((t) => t.kind)).toEqual(['html'])
    })

    it('marks headings, rules, lists, task boxes and blockquote prefixes', () => {
      expect(describeLine('## Sub *heading* here')).toEqual([
        'marker:"##"',
        'heading:" Sub *heading* here"'
      ])
      expect(describeLine('***')).toEqual(['rule:"***"'])
      expect(describeLine('- item')).toEqual(['list:"-"'])
      expect(describeLine('1. item')).toEqual(['list:"1."'])
      expect(describeLine('- [x] done')).toEqual(['list:"-"', 'marker:"[x]"'])
      expect(describeLine('> quoted **bold**')).toEqual(['quote:"> "', 'strong:"**bold**"'])
    })

    it('marks table pipes only on a real table row, never on prose containing a pipe', () => {
      expect(kindsOf('| a | b |')).toEqual(['marker', 'marker', 'marker'])
      expect(kindsOf('cost | benefit analysis')).toEqual([])
    })

    it('separates a link definition label from its destination', () => {
      expect(describeLine('[a]: https://example.com/def "t"')).toEqual([
        'link-text:"[a]:"',
        'link-url:"https://example.com/def"'
      ])
    })
  })

  describe('inline constructs', () => {
    it('splits a link into brackets, label, parens and destination', () => {
      expect(describeLine('see [text](https://x.dev) now')).toEqual([
        'marker:"["',
        'link-text:"text"',
        'marker:"]"',
        'marker:"("',
        'link-url:"https://x.dev"',
        'marker:")"'
      ])
    })

    it('handles an image, a reference link and an autolink', () => {
      expect(describeLine('![alt](i.png)')).toEqual([
        'marker:"!["',
        'link-text:"alt"',
        'marker:"]"',
        'marker:"("',
        'link-url:"i.png"',
        'marker:")"'
      ])
      expect(kindsOf('[ref][a]')).toEqual([
        'marker',
        'link-text',
        'marker',
        'marker',
        'link-url',
        'marker'
      ])
      expect(describeLine('<https://auto.link>')).toEqual(['link-url:"<https://auto.link>"'])
    })

    it('prefers a code span over anything inside it', () => {
      expect(describeLine('a `**x**` b')).toEqual(['code:"`**x**`"'])
    })

    it('prefers the doubled delimiter over the single one', () => {
      expect(describeLine('**bold**')).toEqual(['strong:"**bold**"'])
      expect(describeLine('__bold__')).toEqual(['strong:"__bold__"'])
      expect(describeLine('*em*')).toEqual(['emphasis:"*em*"'])
    })

    it('does not read an escaped delimiter as emphasis', () => {
      expect(describeLine('\\*not emphasis\\*')).toEqual(['marker:"\\\\*"', 'marker:"\\\\*"'])
    })

    // Intraword `_` is not emphasis per CommonMark, and treating it as such
    // would tint half of every identifier in a technical document.
    it('leaves snake_case identifiers alone', () => {
      expect(kindsOf('call snake_case_name here')).toEqual([])
      expect(kindsOf('a _real emphasis_ here')).toEqual(['emphasis'])
    })

    // Mirrors pipeline.ts's own `singleDollarTextMath: false` pin. A single-$
    // reading would swallow "50K to " in the sentence below and tint an
    // ordinary prose sentence as an equation.
    it('reads only DOUBLED dollars as math, leaving currency in prose alone', () => {
      expect(describeLine('grew from $50K to $120K')).toEqual([])
      expect(describeLine('the value $$x^2$$ here')).toEqual(['math:"$$x^2$$"'])
    })

    it('recognises this app own comment and pagebreak markers as HTML', () => {
      expect(describeLine('<!-- pagebreak -->')).toEqual(['html:"<!-- pagebreak -->"'])
      expect(kindsOf('<!--comment id="c1" data="AA"-->x<!--/comment id="c1"-->')).toEqual([
        'html',
        'html'
      ])
    })
  })

  describe('cache-key soundness', () => {
    // SourceHighlightLayer and every future consumer are entitled to treat
    // (context, text) as a complete identity for a line's tokens. If a line's
    // output ever depended on anything else -- its index, a neighbour -- that
    // contract would break silently.
    it('produces identical tokens for identical (context, text) pairs in different documents', () => {
      const a = tokenizeMarkdownSource('# H\n- one\n- two')
      const b = tokenizeMarkdownSource('intro\n\n# H\n- one\n- two')
      const find = (lines: typeof a, text: string): SourceToken[] =>
        lines.find((l) => l.text === text)!.tokens
      expect(find(a, '# H')).toEqual(find(b, '# H'))
      expect(find(a, '- one')).toEqual(find(b, '- one'))
    })
  })

  it('stays well inside a frame on the largest corpus-scale input', () => {
    // Not a benchmark assertion so much as a tripwire: this runs on every
    // keystroke, so an accidentally quadratic edit to the scanner needs to fail
    // a test rather than be discovered as lag. The real measured figure on the
    // 536KB corpus fixture is ~1.8ms; the bound is loose enough not to flake on
    // a loaded CI host but tight enough to catch an order-of-magnitude
    // regression.
    const source = Array.from(
      { length: 4000 },
      (_, i) => `paragraph ${i} with **bold** and \`code\` and [a](https://x/${i}).`
    ).join('\n\n')
    const started = performance.now()
    const lines = tokenizeMarkdownSource(source)
    const elapsed = performance.now() - started
    expect(lines.length).toBe(7999)
    expect(elapsed).toBeLessThan(200)
  })

  it('exports a token budget large enough for real prose but below a pathological document', () => {
    const realistic = Array.from(
      { length: 2000 },
      (_, i) => `Some **bold ${i}** prose with a [link](https://example.com/${i}).`
    ).join('\n')
    const pathological = Array.from(
      { length: 4000 },
      () => '- **a** _b_ `c` [d](e) ~~f~~ $$g$$'
    ).join('\n')
    const count = (src: string): number =>
      tokenizeMarkdownSource(src).reduce((n, l) => n + l.tokens.length, 0)
    expect(count(realistic)).toBeLessThan(MAX_HIGHLIGHTED_SOURCE_TOKENS)
    expect(count(pathological)).toBeGreaterThan(MAX_HIGHLIGHTED_SOURCE_TOKENS)
  })
})
