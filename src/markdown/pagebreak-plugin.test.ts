import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { visit } from 'unist-util-visit'
import type { Root } from 'mdast'
import { remarkPagebreak, remarkPagebreakToMarkdown } from './pagebreak-plugin'

function parse(markdown: string): Root {
  const processor = unified().use(remarkParse).use(remarkPagebreak)
  const tree = processor.parse(markdown) as Root
  return processor.runSync(tree)
}

function countNodesOfType(tree: Root, type: string): number {
  let count = 0
  visit(tree, type, () => {
    count += 1
  })
  return count
}

describe('remarkPagebreak', () => {
  it('promotes a blank-line-surrounded pagebreak comment to a pagebreak node', () => {
    const tree = parse('Paragraph one.\n\n<!-- pagebreak -->\n\nParagraph two.')
    expect(countNodesOfType(tree, 'pagebreak')).toBe(1)
    expect(countNodesOfType(tree, 'html')).toBe(0)
  })

  it('leaves an ordinary block HTML comment as an html node', () => {
    const tree = parse('Paragraph one.\n\n<!-- not a pagebreak -->\n\nParagraph two.')
    expect(countNodesOfType(tree, 'pagebreak')).toBe(0)
    expect(countNodesOfType(tree, 'html')).toBe(1)
  })

  it('does not promote a mid-paragraph inline occurrence', () => {
    const tree = parse('Some text with an <!-- pagebreak --> inline occurrence.')
    expect(countNodesOfType(tree, 'pagebreak')).toBe(0)
    expect(countNodesOfType(tree, 'html')).toBe(1)
  })

  it('handles multiple pagebreaks in one document', () => {
    const tree = parse('One.\n\n<!-- pagebreak -->\n\nTwo.\n\n<!-- pagebreak -->\n\nThree.')
    expect(countNodesOfType(tree, 'pagebreak')).toBe(2)
  })

  it('does not promote an occurrence embedded in a heading', () => {
    const tree = parse('# Heading <!-- pagebreak -->\n\nBody text.')
    expect(countNodesOfType(tree, 'pagebreak')).toBe(0)
    expect(countNodesOfType(tree, 'html')).toBe(1)
  })

  it('does not promote an occurrence embedded in emphasis/strong text', () => {
    const tree = parse('This is **bold <!-- pagebreak --> text** here.')
    expect(countNodesOfType(tree, 'pagebreak')).toBe(0)
    expect(countNodesOfType(tree, 'html')).toBe(1)
  })

  it('does not promote an occurrence inside a list item (unsupported in v1)', () => {
    const tree = parse('- Item one\n\n  <!-- pagebreak -->\n\n- Item two')
    expect(countNodesOfType(tree, 'pagebreak')).toBe(0)
    expect(countNodesOfType(tree, 'html')).toBe(1)
  })

  it('promotes an occurrence inside a blockquote', () => {
    const tree = parse('> Quoted text.\n>\n> <!-- pagebreak -->\n>\n> More quoted text.')
    expect(countNodesOfType(tree, 'pagebreak')).toBe(1)
  })

  it('promotes a marker even after being reparented into a paragraph (the shape preset-commonmark produces before this plugin runs, inside Milkdown)', () => {
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'html', value: '<!-- pagebreak -->' }]
        }
      ]
    }
    remarkPagebreak()(tree)
    expect(tree.children[0].type).toBe('pagebreak')
  })

  it('does not promote a paragraph with the marker plus other content', () => {
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'html', value: '<!-- pagebreak -->' },
            { type: 'text', value: ' and more text' }
          ]
        }
      ]
    }
    remarkPagebreak()(tree)
    expect(tree.children[0].type).toBe('paragraph')
  })

  it('does not promote a reparented marker inside a list item (unsupported in v1, same rule as the direct-html case)', () => {
    // Simulates the exact shape preset-commonmark's remarkHtmlTransformer
    // produces for a marker inside a list item — it reparents into
    // paragraph{[html]} for listItem too, not just root/blockquote, so this
    // regression can't be caught by the direct-html list-item test above.
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'list',
          ordered: false,
          spread: true,
          children: [
            {
              type: 'listItem',
              spread: true,
              children: [
                {
                  type: 'paragraph',
                  children: [{ type: 'html', value: '<!-- pagebreak -->' }]
                }
              ]
            }
          ]
        }
      ]
    }
    remarkPagebreak()(tree)
    const listItem = (tree.children[0] as { children: Root['children'] }).children[0] as {
      children: Root['children']
    }
    expect(listItem.children[0].type).toBe('paragraph')
  })
})

describe('alternate page-break syntax: \\newpage', () => {
  it('promotes a standalone \\newpage to a pagebreak node', () => {
    const tree = parse('Paragraph one.\n\n\\newpage\n\nParagraph two.')
    expect(countNodesOfType(tree, 'pagebreak')).toBe(1)
  })

  it('does not promote \\newpage embedded mid-sentence', () => {
    const tree = parse('Some text mentioning \\newpage inline.')
    expect(countNodesOfType(tree, 'pagebreak')).toBe(0)
  })

  it('does not promote \\newpage inside a list item (unsupported in v1)', () => {
    const tree = parse('- Item one\n\n  \\newpage\n\n- Item two')
    expect(countNodesOfType(tree, 'pagebreak')).toBe(0)
  })

  it('is case-sensitive and does not promote a differently-cased variant', () => {
    const tree = parse('Paragraph one.\n\n\\Newpage\n\nParagraph two.')
    expect(countNodesOfType(tree, 'pagebreak')).toBe(0)
  })

  it('promotes \\newpage inside a blockquote', () => {
    const tree = parse('> Quoted text.\n>\n> \\newpage\n>\n> More quoted text.')
    expect(countNodesOfType(tree, 'pagebreak')).toBe(1)
  })
})

describe('alternate page-break syntax: \\pagebreak', () => {
  it('promotes a standalone \\pagebreak to a pagebreak node', () => {
    const tree = parse('Paragraph one.\n\n\\pagebreak\n\nParagraph two.')
    expect(countNodesOfType(tree, 'pagebreak')).toBe(1)
  })

  it('promotes \\pagebreak inside a blockquote', () => {
    const tree = parse('> Quoted text.\n>\n> \\pagebreak\n>\n> More quoted text.')
    expect(countNodesOfType(tree, 'pagebreak')).toBe(1)
  })
})

describe('alternate page-break syntax: page-break-after div', () => {
  it('promotes the exact documented div convention', () => {
    const tree = parse(
      'Paragraph one.\n\n<div style="page-break-after: always;"></div>\n\nParagraph two.'
    )
    expect(countNodesOfType(tree, 'pagebreak')).toBe(1)
    expect(countNodesOfType(tree, 'html')).toBe(0)
  })

  it('tolerates single quotes and no trailing semicolon', () => {
    const tree = parse(
      "Paragraph one.\n\n<div style='page-break-after: always'></div>\n\nParagraph two."
    )
    expect(countNodesOfType(tree, 'pagebreak')).toBe(1)
  })

  it('does not promote a div with extra attributes or content', () => {
    const tree = parse(
      'Paragraph one.\n\n<div class="x" style="page-break-after: always;"></div>\n\nParagraph two.'
    )
    expect(countNodesOfType(tree, 'pagebreak')).toBe(0)
    expect(countNodesOfType(tree, 'html')).toBe(1)
  })

  it('does not promote a div inside a list item (unsupported in v1)', () => {
    const tree = parse(
      '- Item one\n\n  <div style="page-break-after: always;"></div>\n\n- Item two'
    )
    expect(countNodesOfType(tree, 'pagebreak')).toBe(0)
    expect(countNodesOfType(tree, 'html')).toBe(1)
  })

  it('promotes the div convention inside a blockquote', () => {
    const tree = parse(
      '> Quoted text.\n>\n> <div style="page-break-after: always;"></div>\n>\n> More quoted text.'
    )
    expect(countNodesOfType(tree, 'pagebreak')).toBe(1)
  })
})

// DELIBERATE INVERSION of what this block used to assert. It previously
// pinned "an alternate syntax NORMALIZES to the canonical marker on
// serialize", and the surrounding CLAUDE.md note recorded the resulting
// prose rewrite (a Pandoc/LaTeX tutorial whose bare `\newpage` paragraph
// documents the command rather than invoking it) as an accepted false
// positive. It is no longer accepted: `Pagebreak#raw` records the matched
// literal and the serializer emits it back, so an alternate marker survives
// a save as itself. Normalization was the only change this app made to a
// document that altered what it SAYS rather than how it is formatted --
// everything else the serializer rewrites (bullet char, emphasis char, fence
// style) is pure presentation. The 2026-08-09 gap audit's B2 follow-up
// recommends exactly this inversion, and names this test file and
// round-trip.test.ts:56-62 as the assertions that should flip. This is the
// correct signal, not a regression.
describe('alternate syntaxes are PRESERVED verbatim on serialize, not normalized', () => {
  it.each([
    ['\\newpage', 'Paragraph one.\n\n\\newpage\n\nParagraph two.\n'],
    ['\\pagebreak', 'Paragraph one.\n\n\\pagebreak\n\nParagraph two.\n'],
    [
      'the page-break-after div',
      'Paragraph one.\n\n<div style="page-break-after: always;"></div>\n\nParagraph two.\n'
    ],
    ['the canonical marker', 'Paragraph one.\n\n<!-- pagebreak -->\n\nParagraph two.\n']
  ])('%s round-trips byte-identically', (_name, source) => {
    const processor = unified()
      .use(remarkParse)
      .use(remarkPagebreak)
      .use(remarkPagebreakToMarkdown)
      .use(remarkStringify)
    const tree = processor.parse(source)
    const transformed = processor.runSync(tree)
    expect(countNodesOfType(transformed as Root, 'pagebreak')).toBe(1)
    expect(processor.stringify(transformed)).toBe(source)
  })

  // The fallback half of `node.raw ?? PAGEBREAK_MARKER`: a pagebreak node
  // that never came from source text at all (what the toolbar/slash "Page
  // break" command builds, and what a ProseMirror pagebreak node with its
  // default empty `raw` attr serializes to) still emits the canonical
  // marker. Without this the preservation change would silently turn an
  // INSERTED page break into an empty node.
  it('emits the canonical marker for a pagebreak node carrying no raw literal', () => {
    const processor = unified().use(remarkParse).use(remarkPagebreakToMarkdown).use(remarkStringify)
    const tree: Root = {
      type: 'root',
      children: [{ type: 'pagebreak' } as never]
    }
    expect(processor.stringify(tree)).toBe('<!-- pagebreak -->\n')
  })
})

describe('non-matching occurrences survive a full round trip unchanged', () => {
  // Confirmed empirically (per the design brief) rather than assumed: the
  // third fixture uses a `*` bullet marker, not `-`, because this suite's
  // processor -- unlike pipeline.ts's pinned remark-stringify options --
  // stringifies with remark-stringify's own default bullet, which is `*`.
  // A `-` source would fail this round-trip on that unrelated normalization,
  // not on anything pagebreak-related.
  it.each([
    'Some text mentioning \\newpage inline.\n',
    'Use `\\newpage` to break a page.\n',
    '* Item one\n\n  \\newpage\n\n* Item two\n'
  ])('round-trips %s byte-identically', (source) => {
    const processor = unified()
      .use(remarkParse)
      .use(remarkPagebreak)
      .use(remarkPagebreakToMarkdown)
      .use(remarkStringify)
    const tree = processor.parse(source)
    const transformed = processor.runSync(tree)
    const output = processor.stringify(transformed)
    expect(output).toBe(source)
  })
})
