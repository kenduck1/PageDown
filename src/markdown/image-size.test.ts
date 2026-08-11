import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { visit } from 'unist-util-visit'
import type { Root, Image, Paragraph } from 'mdast'
import { remarkImageAttrs, parseAttributeBlock, formatAttributeBlock } from './image-size'

function parse(markdown: string): Root {
  const processor = unified().use(remarkParse).use(remarkImageAttrs)
  return processor.runSync(processor.parse(markdown) as Root)
}

function firstImage(tree: Root): Image {
  let found: Image | undefined
  visit(tree, 'image', (node: Image) => {
    found ??= node
  })
  if (!found) throw new Error('no image node')
  return found
}

function paragraphShape(tree: Root): string[] {
  return (tree.children[0] as Paragraph).children.map((child) => child.type)
}

describe('parseAttributeBlock', () => {
  it('keeps a percentage as a percentage', () => {
    expect(parseAttributeBlock('width=50%')).toBe('50%')
    expect(parseAttributeBlock('width=12.5%')).toBe('12.5%')
  })

  it("converts every absolute unit to whole pixels at the app's own 96dpi", () => {
    // Uses the SAME DPI constant page-geometry.ts gives the page box, so
    // `{width=3in}` on Letter really is a third of the 8.5in page.
    expect(parseAttributeBlock('width=200px')).toBe('200')
    expect(parseAttributeBlock('width=200')).toBe('200')
    expect(parseAttributeBlock('width=3in')).toBe('288')
    expect(parseAttributeBlock('width=2cm')).toBe('76')
    expect(parseAttributeBlock('width=25.4mm')).toBe('96')
    expect(parseAttributeBlock('width=144pt')).toBe('192')
  })

  it('clamps a percentage over 100 rather than letting the document claim a size it never gets', () => {
    // `max-width: 100%` on both surfaces already caps the painted result, so
    // an unclamped 400% would be a value that reads back differently than it
    // renders.
    expect(parseAttributeBlock('width=400%')).toBe('100%')
  })

  it('tolerates surrounding whitespace and quotes', () => {
    expect(parseAttributeBlock(' width=50% ')).toBe('50%')
    expect(parseAttributeBlock('width="50%"')).toBe('50%')
  })

  it('rejects anything it does not fully understand, including height', () => {
    // Rejection is the deliberate failure mode: the block stays in the
    // document as literal text, so a typo is visible rather than swallowed.
    // `height` specifically cannot work at all -- see this function's own doc
    // comment on the `height: auto` cascade on both surfaces.
    expect(parseAttributeBlock('height=200px')).toBeNull()
    expect(parseAttributeBlock('width=50% height=20px')).toBeNull()
    expect(parseAttributeBlock('hieght=200px')).toBeNull()
    expect(parseAttributeBlock('width=')).toBeNull()
    expect(parseAttributeBlock('width=auto')).toBeNull()
    expect(parseAttributeBlock('width=3em')).toBeNull()
    expect(parseAttributeBlock('width=-5px')).toBeNull()
    expect(parseAttributeBlock('width=0')).toBeNull()
    expect(parseAttributeBlock('.centered')).toBeNull()
    expect(parseAttributeBlock('')).toBeNull()
  })
})

describe('formatAttributeBlock', () => {
  it('round-trips a normalized width back into source syntax', () => {
    expect(formatAttributeBlock('50%')).toBe('{width=50%}')
    expect(formatAttributeBlock('288')).toBe('{width=288px}')
    expect(parseAttributeBlock(formatAttributeBlock('288').slice(1, -1))).toBe('288')
  })
})

describe('remarkImageAttrs', () => {
  it('moves the block off the text node and onto the image', () => {
    const tree = parse('![Logo](logo.png){width=50%}')
    expect(firstImage(tree).width).toBe('50%')
    // The now-empty text node is REMOVED, not left as an empty string -- an
    // empty text sibling would serialize back as nothing but shows up in every
    // node-shape assertion downstream.
    expect(paragraphShape(tree)).toEqual(['image'])
  })

  it('preserves prose that follows the block in the same text node', () => {
    const tree = parse('![Logo](logo.png){width=50%} and a caption')
    expect(firstImage(tree).width).toBe('50%')
    expect(paragraphShape(tree)).toEqual(['image', 'text'])
    expect((tree.children[0] as Paragraph).children[1]).toMatchObject({
      value: ' and a caption'
    })
  })

  it('only consumes a block written IMMEDIATELY after the image', () => {
    expect(firstImage(parse('![Logo](logo.png) {width=50%}')).width).toBeUndefined()
    expect(firstImage(parse('{width=50%} ![Logo](logo.png)')).width).toBeUndefined()
  })

  it('leaves an unrecognized block alone, in the document, as text', () => {
    const tree = parse('![Logo](logo.png){height=200px}')
    expect(firstImage(tree).width).toBeUndefined()
    expect(paragraphShape(tree)).toEqual(['image', 'text'])
  })

  it('handles reference-style images too', () => {
    const tree = parse('![Logo][ref]{width=200px}\n\n[ref]: logo.png')
    let width: string | undefined
    visit(tree, 'imageReference', (node) => {
      width = (node as { width?: string }).width
    })
    expect(width).toBe('200')
  })

  it('sets data.hProperties so mdast-util-to-hast emits the attribute with no custom handler', () => {
    // The reason this feature needed no hast handler, no sanitize schema
    // change and no new CSS: applyData merges hProperties, and `width` is
    // already in hast-util-sanitize's default '*' allowlist.
    const data = firstImage(parse('![Logo](logo.png){width=50%}')).data as {
      hProperties?: Record<string, unknown>
    }
    expect(data.hProperties).toEqual({ width: '50%' })
  })

  it('a plain text sibling carrying the block serializes UNESCAPED', () => {
    // The property the whole serialize direction rests on (see image-size.ts's
    // closing note): `{`, `}` and `%` are not in mdast-util-to-markdown's
    // unsafe set, and `=` is unsafe only at the start of a line. Asserted
    // directly rather than reasoned about, because if it ever stopped holding
    // the editor would start writing `\{width=50%\}` into people's files.
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'image', url: 'logo.png', alt: 'Logo', title: null },
            { type: 'text', value: '{width=50%}' }
          ]
        }
      ]
    }
    expect(unified().use(remarkStringify).stringify(tree)).toBe('![Logo](logo.png){width=50%}\n')
  })
})
