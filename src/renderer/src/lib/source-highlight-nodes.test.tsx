import { describe, expect, it } from 'vitest'
import { isValidElement, type ReactNode } from 'react'
import { buildHighlightNodes } from './source-highlight-nodes'
import {
  MAX_HIGHLIGHTED_SOURCE_LENGTH,
  MAX_HIGHLIGHTED_SOURCE_TOKENS
} from './markdown-source-tokens'

// Flattens the node list back to the characters it will paint. `props.children`
// of a token span is always a plain string by construction (see
// buildHighlightNodes), so this is total over what that function can emit.
function paintedText(nodes: ReactNode[]): string {
  return nodes
    .map((node) => {
      if (typeof node === 'string') return node
      if (isValidElement<{ children: string }>(node)) return node.props.children
      throw new Error(`unexpected node: ${String(node)}`)
    })
    .join('')
}

describe('buildHighlightNodes', () => {
  // THE load-bearing assertion of this whole feature. The mirror sits under a
  // transparent textarea, so if it ever paints text that is not exactly the
  // textarea's own value, the two go out of register and every character after
  // the divergence sits over the wrong glyph. Dropping, duplicating or
  // reordering a single character would be invisible in a screenshot and
  // catastrophic for the caret.
  it('paints exactly the source text, plus one trailing newline, for every construct', () => {
    const source = [
      '---',
      'title: Demo',
      '---',
      '# Heading with **stars**',
      '',
      'Prose with `code`, [a link](https://example.com), ![img](x.png), $$m^2$$.',
      '> quoted',
      '- [ ] task with _em_',
      '| a | b |',
      '```ts',
      'const x = 1',
      '```',
      '<!-- pagebreak -->',
      'trailing prose'
    ].join('\n')
    expect(paintedText(buildHighlightNodes(source))).toBe(source + '\n')
  })

  it('paints exactly the source for an empty document and for one ending in a newline', () => {
    expect(paintedText(buildHighlightNodes(''))).toBe('\n')
    expect(paintedText(buildHighlightNodes('a\n'))).toBe('a\n\n')
  })

  // The reason there is no per-line wrapper element: real prose is mostly
  // untokenized, so buffering plain runs ACROSS line boundaries makes the array
  // length track token count rather than line count. Without it a 500-line
  // document would put 500+ entries on the page before a single token existed,
  // on every keystroke.
  it('coalesces untokenized runs across line boundaries into single text nodes', () => {
    const nodes = buildHighlightNodes('plain one\nplain two\nplain three')
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toBe('plain one\nplain two\nplain three\n')
  })

  it('emits a class-bearing span per token and plain strings for the gaps', () => {
    const nodes = buildHighlightNodes('a **b** c')
    expect(nodes.map((n) => (typeof n === 'string' ? 'text' : 'span'))).toEqual([
      'text',
      'span',
      'text'
    ])
    expect(isValidElement<{ className: string }>(nodes[1]) && nodes[1].props.className).toBe(
      'pagedown-src-strong'
    )
  })

  describe('degrading past the caps', () => {
    // Degrading to plain text is safe here precisely because plain text in this
    // same box has identical metrics -- alignment, wrapping and scrolling are
    // unaffected, so the only observable difference is colour. Both caps are
    // asserted to produce EXACTLY the untokenized fallback rather than merely
    // "fewer" tokens.
    it('renders plain text above the character cap', () => {
      const huge = '# heading\n'.repeat(Math.ceil(MAX_HIGHLIGHTED_SOURCE_LENGTH / 10) + 1)
      expect(huge.length).toBeGreaterThan(MAX_HIGHLIGHTED_SOURCE_LENGTH)
      const nodes = buildHighlightNodes(huge)
      expect(nodes).toEqual([huge + '\n'])
    })

    it('renders plain text above the token cap even when the character count is fine', () => {
      const dense = Array.from({ length: 4000 }, () => '- **a** _b_ `c` [d](e) ~~f~~ $$g$$').join(
        '\n'
      )
      expect(dense.length).toBeLessThan(MAX_HIGHLIGHTED_SOURCE_LENGTH)
      const nodes = buildHighlightNodes(dense)
      expect(nodes).toEqual([dense + '\n'])
      expect(paintedText(nodes)).toBe(dense + '\n')
    })

    it('still highlights a document with many lines but ordinary token density', () => {
      const wordy = Array.from(
        { length: 3000 },
        (_, i) => `Paragraph ${i} of ordinary prose with no markup at all.`
      ).join('\n')
      expect(wordy.length).toBeLessThan(MAX_HIGHLIGHTED_SOURCE_LENGTH)
      // One coalesced run: proof the size guard did not fire AND that a long
      // plain document costs a single node.
      expect(buildHighlightNodes(wordy)).toHaveLength(1)
      const withMarkup = `# Title\n${wordy}`
      expect(buildHighlightNodes(withMarkup).length).toBeGreaterThan(1)
    })
  })
})

describe('cap calibration', () => {
  // A sanity floor on the caps themselves. A document of the size and density
  // this app is actually FOR -- long-form reports, letters, resumes -- must
  // never fall through to the plain-text path; if a future palette or scanner
  // change made real prose that much denser, the cliff would move under
  // ordinary users and this is what would say so.
  it('leaves a realistic long-form document comfortably inside both caps', () => {
    const realistic = Array.from(
      { length: 400 },
      (_, i) => `## Section ${i}\n\nSome **bold** prose and a [link](https://example.com/${i}).\n`
    ).join('\n')
    expect(realistic.length).toBeLessThan(MAX_HIGHLIGHTED_SOURCE_LENGTH)
    const nodes = buildHighlightNodes(realistic)
    expect(nodes.filter((node) => typeof node !== 'string').length).toBeLessThan(
      MAX_HIGHLIGHTED_SOURCE_TOKENS
    )
    expect(paintedText(nodes)).toBe(realistic + '\n')
  })
})
