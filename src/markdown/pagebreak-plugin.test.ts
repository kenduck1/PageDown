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
})

describe('alternate page-break syntax: \\pagebreak', () => {
  it('promotes a standalone \\pagebreak to a pagebreak node', () => {
    const tree = parse('Paragraph one.\n\n\\pagebreak\n\nParagraph two.')
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
  })
})

describe('alternate syntaxes normalize to the canonical marker on serialize', () => {
  it('remarkPagebreakToMarkdown emits the canonical marker regardless of which syntax matched', () => {
    for (const source of [
      'Paragraph one.\n\n\\newpage\n\nParagraph two.\n',
      'Paragraph one.\n\n\\pagebreak\n\nParagraph two.\n',
      'Paragraph one.\n\n<div style="page-break-after: always;"></div>\n\nParagraph two.\n'
    ]) {
      const processor = unified()
        .use(remarkParse)
        .use(remarkPagebreak)
        .use(remarkPagebreakToMarkdown)
        .use(remarkStringify)
      const tree = processor.parse(source)
      const transformed = processor.runSync(tree)
      const output = processor.stringify(transformed)
      expect(output).toContain('<!-- pagebreak -->')
      expect(output).not.toContain('\\newpage')
      expect(output).not.toContain('\\pagebreak')
      expect(output).not.toContain('page-break-after')
    }
  })
})
