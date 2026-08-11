import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { visit } from 'unist-util-visit'
import type { Root, Heading } from 'mdast'
import {
  remarkToc,
  remarkTocToMarkdown,
  collectTocWarnings,
  headingPlainText,
  HEADING_ANCHOR_PREFIX,
  DEFAULT_TOC_DEPTH,
  type Toc
} from './toc-plugin'

function parse(markdown: string): Root {
  const processor = unified().use(remarkParse).use(remarkToc)
  return processor.runSync(processor.parse(markdown) as Root)
}

function tocNodes(tree: Root): Toc[] {
  const found: Toc[] = []
  visit(tree, 'toc', (node) => {
    found.push(node as Toc)
  })
  return found
}

function headingIds(tree: Root): (string | undefined)[] {
  const ids: (string | undefined)[] = []
  visit(tree, 'heading', (node: Heading) => {
    const data = node.data as { hProperties?: { id?: unknown } } | undefined
    const id = data?.hProperties?.id
    ids.push(typeof id === 'string' ? id : undefined)
  })
  return ids
}

function serialize(markdown: string): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkToc)
    .use(remarkTocToMarkdown)
    .use(remarkStringify)
  return processor.stringify(processor.runSync(processor.parse(markdown) as Root) as Root)
}

describe('remarkToc: promotion', () => {
  it('promotes a block-level <!-- toc --> marker to a real toc node', () => {
    const tree = parse('# A\n\n<!-- toc -->\n\n## B\n')
    const tocs = tocNodes(tree)

    expect(tocs).toHaveLength(1)
    expect(tocs[0].maxDepth).toBe(DEFAULT_TOC_DEPTH)
    expect(tocs[0].raw).toBe('<!-- toc -->')
    // The marker REPLACES its own root child rather than being appended
    // alongside it -- which is what keeps mdast root-children indices in step
    // with the ProseMirror doc's top-level nodes (block-correspondence.test.ts).
    expect(tree.children.map((child) => child.type)).toEqual(['heading', 'toc', 'heading'])
  })

  it('promotes the paragraph-WRAPPED shape too -- the shape Milkdown, and only Milkdown, produces', () => {
    // @milkdown/preset-commonmark reparents a block-level raw-HTML node into a
    // wrapping paragraph before this transform runs, so its pipeline never
    // sees the bare-html shape above. Hand-building that shape here is the
    // only way to exercise the second branch without a whole Milkdown editor;
    // nodes/toc.test.ts covers it end to end against the real preset.
    const tree: Root = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'html', value: '<!-- toc -->' }] },
        { type: 'heading', depth: 1, children: [{ type: 'text', value: 'A' }] }
      ]
    }
    remarkToc()(tree)

    expect(tree.children[0].type).toBe('toc')
    expect(tocNodes(tree)[0].entries.map((entry) => entry.text)).toEqual(['A'])
  })

  it('reads an explicit depth in any of the three quoting styles', () => {
    expect(tocNodes(parse('<!-- toc depth="2" -->\n'))[0].maxDepth).toBe(2)
    expect(tocNodes(parse("<!-- toc depth='5' -->\n"))[0].maxDepth).toBe(5)
    expect(tocNodes(parse('<!-- toc depth=1 -->\n'))[0].maxDepth).toBe(1)
  })

  it('is case-insensitive on the canonical marker', () => {
    expect(tocNodes(parse('<!-- TOC -->\n'))).toHaveLength(1)
    expect(tocNodes(parse('<!--Toc-->\n'))).toHaveLength(1)
  })

  it('does not match a mismatched quote pair, an out-of-range depth, or a near-miss word', () => {
    // The three explicit quote branches exist precisely so `depth="3'` cannot
    // match, which a `(["'])?...\1?` backreference would have allowed.
    expect(tocNodes(parse('<!-- toc depth="3\' -->\n'))).toHaveLength(0)
    expect(tocNodes(parse('<!-- toc depth="9" -->\n'))).toHaveLength(0)
    expect(tocNodes(parse('<!-- tocs -->\n'))).toHaveLength(0)
    expect(tocNodes(parse('<!-- table of contents -->\n'))).toHaveLength(0)
  })
})

describe('remarkToc: alternate spellings, and the one deliberately NOT supported', () => {
  it('recognizes [TOC] and [[TOC]] as their own paragraph, case-insensitively', () => {
    expect(tocNodes(parse('# A\n\n[TOC]\n'))).toHaveLength(1)
    expect(tocNodes(parse('# A\n\n[[TOC]]\n'))).toHaveLength(1)
    expect(tocNodes(parse('# A\n\n[toc]\n'))).toHaveLength(1)
  })

  it('records the literal the author wrote, so serializing cannot rewrite their prose', () => {
    expect(tocNodes(parse('[TOC]\n'))[0].raw).toBe('[TOC]')
    expect(tocNodes(parse('[[TOC]]\n'))[0].raw).toBe('[[TOC]]')
  })

  it('does NOT match a bracket spelling used inside a sentence', () => {
    // The sole-child requirement is the entire safety property: a TOC marker
    // inserts a whole generated heading list, so a false positive here is far
    // more disruptive than the \newpage prose-mention case pagebreak-plugin.ts
    // documents.
    expect(tocNodes(parse('See [TOC] below.\n'))).toHaveLength(0)
    expect(tocNodes(parse('Write `[TOC]` to insert one.\n'))).toHaveLength(0)
  })

  it("does NOT match GitLab's [[_TOC_]], and the reason is a tokenizer fact", () => {
    // `_TOC_` is a valid emphasis span, so CommonMark parses this into THREE
    // phrasing children -- never the single text leaf the matcher requires.
    // Asserted directly rather than left as a comment, so that if a future
    // remark upgrade changed the tokenization the surprise surfaces here.
    const paragraph = parse('[[_TOC_]]\n').children[0]
    expect(paragraph.type).toBe('paragraph')
    expect((paragraph as { children: { type: string }[] }).children.map((c) => c.type)).toEqual([
      'text',
      'emphasis',
      'text'
    ])
    expect(tocNodes(parse('[[_TOC_]]\n'))).toHaveLength(0)
  })
})

describe('remarkToc: entries and heading anchors', () => {
  it('lists every heading within depth, in document order, with a matching anchor id', () => {
    const tree = parse('<!-- toc -->\n\n# One\n\n## Two\n\n### Three\n\n#### Four\n')
    const entries = tocNodes(tree)[0].entries

    expect(entries.map((entry) => [entry.depth, entry.text])).toEqual([
      [1, 'One'],
      [2, 'Two'],
      [3, 'Three']
    ])
    expect(entries.map((entry) => entry.anchorId)).toEqual([
      `${HEADING_ANCHOR_PREFIX}0`,
      `${HEADING_ANCHOR_PREFIX}1`,
      `${HEADING_ANCHOR_PREFIX}2`
    ])
    // h4 is out of depth, so it is neither listed nor stamped -- the anchor
    // ids are indices into ALL headings, so a skipped one leaves a gap rather
    // than renumbering the ones after it.
    expect(headingIds(tree)).toEqual([
      `${HEADING_ANCHOR_PREFIX}0`,
      `${HEADING_ANCHOR_PREFIX}1`,
      `${HEADING_ANCHOR_PREFIX}2`,
      undefined
    ])
  })

  it('flattens inline formatting in a heading exactly as the Outline sidebar does', () => {
    const tree = parse('<!-- toc -->\n\n## A **bold** `code` [link](x)\n')
    expect(tocNodes(tree)[0].entries[0].text).toBe('A bold code link')
  })

  it('stamps NO heading id at all when the document has no TOC marker', () => {
    // Load-bearing: a document without a TOC must render byte-identically to
    // how it rendered before this feature existed. pipeline.test.ts asserts
    // the same thing on the emitted HTML.
    expect(headingIds(parse('# One\n\n## Two\n'))).toEqual([undefined, undefined])
  })

  it("never overwrites an id the document's own author already set", () => {
    const tree = parse('<!-- toc -->\n\n# One\n')
    // Simulate an author-supplied id by pre-stamping, then re-running: the
    // transform must adopt it for the link target rather than clobbering it.
    const heading = tree.children.find((child) => child.type === 'heading') as Heading
    heading.data = { hProperties: { id: 'authors-own' } }
    remarkToc()(tree)
    expect((heading.data as { hProperties: { id: string } }).hProperties.id).toBe('authors-own')
  })

  it('gives two markers with different depths two correctly-filtered entry lists', () => {
    const tree = parse('<!-- toc depth="1" -->\n\n<!-- toc -->\n\n# One\n\n## Two\n')
    const [shallow, deep] = tocNodes(tree)
    expect(shallow.entries.map((entry) => entry.text)).toEqual(['One'])
    expect(deep.entries.map((entry) => entry.text)).toEqual(['One', 'Two'])
  })
})

describe('collectTocWarnings', () => {
  it('says so when the document has no headings at all', () => {
    const warnings = collectTocWarnings(parse('<!-- toc -->\n\nJust prose.\n'))
    expect(warnings.map((warning) => warning.id)).toEqual(['empty-toc'])
    expect(warnings[0].message).toContain('no headings')
  })

  it('names a workable depth when every heading is deeper than the marker asked for', () => {
    const warnings = collectTocWarnings(parse('<!-- toc depth="1" -->\n\n### Deep\n'))
    expect(warnings[0].message).toContain('depth="3"')
  })

  it('is silent for a TOC that has entries, and for a document with no marker', () => {
    expect(collectTocWarnings(parse('<!-- toc -->\n\n# A\n'))).toEqual([])
    expect(collectTocWarnings(parse('# A\n\n## B\n'))).toEqual([])
  })

  it('aggregates rather than emitting one warning per empty marker', () => {
    expect(collectTocWarnings(parse('<!-- toc -->\n\n<!-- toc -->\n\nProse.\n'))).toHaveLength(1)
  })
})

describe('remarkTocToMarkdown', () => {
  it('round-trips each recognized spelling as itself, never normalized', () => {
    expect(serialize('Before.\n\n<!-- toc -->\n\nAfter.\n')).toBe(
      'Before.\n\n<!-- toc -->\n\nAfter.\n'
    )
    expect(serialize('[TOC]\n')).toBe('[TOC]\n')
    expect(serialize('[[TOC]]\n')).toBe('[[TOC]]\n')
    expect(serialize('<!-- toc depth="2" -->\n')).toBe('<!-- toc depth="2" -->\n')
    expect(serialize('<!-- TOC -->\n')).toBe('<!-- TOC -->\n')
  })

  it('synthesizes a canonical marker for a node with no source literal (one created in the editor)', () => {
    const processor = unified().use(remarkTocToMarkdown).use(remarkStringify)
    const withDefault: Root = {
      type: 'root',
      children: [{ type: 'toc', maxDepth: DEFAULT_TOC_DEPTH, entries: [] } as Toc]
    }
    const withDepth: Root = {
      type: 'root',
      children: [{ type: 'toc', maxDepth: 2, entries: [] } as Toc]
    }
    expect(processor.stringify(withDefault)).toBe('<!-- toc -->\n')
    expect(processor.stringify(withDepth)).toBe('<!-- toc depth="2" -->\n')
  })
})

describe('headingPlainText (shared with extractOutline.ts)', () => {
  it('concatenates text and inlineCode leaves in document order', () => {
    const heading = parse('# a *b* `c`\n').children[0] as Heading
    expect(headingPlainText(heading)).toBe('a b c')
  })
})
