import { describe, it, expect } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import {
  markdownToDocx,
  parseDocxTree,
  collectLocalImageSrcs,
  resolveDocxTypography,
  type DocxImageAsset
} from './markdown-to-docx'
import { listDocxEntries, readDocxEntry, readDocxDocumentXml } from './docx-zip'
import { readImageDimensions } from './docx-image'
import { DEFAULT_DOCUMENT_STYLE } from '../typography/document-style'

// Every assertion here reads the REAL generated file back -- unzipped by
// docx-zip.ts's own independent central-directory parser, not by the zip
// implementation `docx` used to write it -- and asserts on the actual OOXML.
// Asserting on the in-memory Document object instead would prove only that
// this module called a constructor, which is the least interesting thing that
// could go wrong.

async function documentXml(
  content: string,
  options: Parameters<typeof markdownToDocx>[0] = { content }
): Promise<string> {
  return readDocxDocumentXml(await markdownToDocx({ ...options, content }))
}

// A genuine 2x3 PNG, built here rather than committed as a binary fixture so
// its declared dimensions are visible in the test that depends on them.
function tinyPng(width: number, height: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (bytes: Uint8Array): number => {
    let c = 0xffffffff
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const typeBytes = new TextEncoder().encode(type)
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    out.set(typeBytes, 4)
    out.set(data, 8)
    view.setUint32(8 + data.length, crc32(new Uint8Array([...typeBytes, ...data])))
    return out
  }
  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width)
  ihdrView.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  // One filter byte plus 3 bytes per pixel, per scanline.
  const rawScanlines = new Uint8Array(height * (1 + width * 3))
  const idat = deflateRawSync(Buffer.from(rawScanlines))
  // zlib wrapper (0x78 0x01) around the raw deflate stream, which is what a
  // PNG IDAT actually carries.
  const idatData = new Uint8Array([0x78, 0x01, ...idat, 0, 0, 0, 0])
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', idatData),
    ...chunk('IEND', new Uint8Array(0))
  ])
}

describe('markdownToDocx: the file itself', () => {
  it('produces a real OOXML package with the parts Word requires', async () => {
    const buffer = await markdownToDocx({ content: '# Hello\n\nWorld.\n' })
    // "PK": if this is not a zip, nothing else here means anything.
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK')
    const entries = listDocxEntries(buffer)
    expect(entries).toContain('[Content_Types].xml')
    expect(entries).toContain('word/document.xml')
    expect(entries).toContain('word/styles.xml')
    expect(readDocxDocumentXml(buffer)).toContain('<w:body>')
  })

  it('never emits an empty body, which some readers report as a damaged file', async () => {
    const xml = await documentXml('')
    expect(xml).toContain('<w:body>')
    expect(xml).toMatch(/<w:p\/?>/)
  })
})

describe('markdownToDocx: structure', () => {
  it('maps heading depth to real Word heading styles', async () => {
    const xml = await documentXml('# One\n\n## Two\n\n### Three\n\n###### Six\n')
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>')
    expect(xml).toContain('<w:pStyle w:val="Heading2"/>')
    expect(xml).toContain('<w:pStyle w:val="Heading3"/>')
    expect(xml).toContain('<w:pStyle w:val="Heading6"/>')
  })

  it('turns <!-- pagebreak --> into a real Word hard page break', async () => {
    const xml = await documentXml('Before.\n\n<!-- pagebreak -->\n\nAfter.\n')
    expect(xml).toContain('<w:br w:type="page"/>')
    // One marker, one break -- not one per paragraph.
    expect(xml.match(/<w:br w:type="page"\/>/g)).toHaveLength(1)
  })

  it('recognises the alternate page-break spellings the app already accepts', async () => {
    // \newpage and \pagebreak reach the same `pagebreak` mdast node via the
    // shared remarkPagebreak plugin, so the exporter gets them for free -- but
    // "for free" is exactly the kind of claim that quietly stops being true.
    for (const marker of ['\\newpage', '\\pagebreak']) {
      expect(await documentXml(`A\n\n${marker}\n\nB\n`)).toContain('<w:br w:type="page"/>')
    }
  })

  it('renders bold, italic, strikethrough and inline code as real run properties', async () => {
    const xml = await documentXml('**b** _i_ ~~s~~ `c`\n')
    expect(xml).toContain('<w:b/>')
    expect(xml).toContain('<w:i/>')
    expect(xml).toContain('<w:strike/>')
    expect(xml).toContain('w:ascii="Courier New"')
  })

  it('renders links as real hyperlink relationships, not plain text', async () => {
    const buffer = await markdownToDocx({ content: '[site](https://example.com/x)\n' })
    expect(readDocxDocumentXml(buffer)).toContain('<w:hyperlink')
    const rels = readDocxEntry(buffer, 'word/_rels/document.xml.rels')?.toString('utf8') ?? ''
    expect(rels).toContain('https://example.com/x')
    expect(rels).toContain('TargetMode="External"')
  })

  it('resolves reference-style links against definitions that appear later', async () => {
    const buffer = await markdownToDocx({
      content: 'See [the site][ref].\n\n[ref]: https://ref.example\n'
    })
    const rels = readDocxEntry(buffer, 'word/_rels/document.xml.rels')?.toString('utf8') ?? ''
    expect(rels).toContain('https://ref.example')
    // The definition line itself is configuration, not body text.
    expect(readDocxDocumentXml(buffer)).not.toContain('[ref]:')
  })

  it('numbers each ordered list independently instead of continuing the previous one', async () => {
    const xml = await documentXml('1. a\n2. b\n\ntext\n\n1. c\n2. d\n')
    const numIds = [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1])
    // Two lists, two distinct numbering instances -- sharing one would make
    // the second list start at 3.
    expect(new Set(numIds).size).toBe(2)
  })

  it('honours an ordered list that starts at something other than 1', async () => {
    const buffer = await markdownToDocx({ content: '7. seven\n8. eight\n' })
    const numbering = readDocxEntry(buffer, 'word/numbering.xml')?.toString('utf8') ?? ''
    expect(numbering).toContain('<w:start w:val="7"/>')
  })

  it('gives nested list items deeper indent levels', async () => {
    const xml = await documentXml('- a\n  - b\n    - c\n')
    expect(xml).toContain('<w:ilvl w:val="0"/>')
    expect(xml).toContain('<w:ilvl w:val="1"/>')
    expect(xml).toContain('<w:ilvl w:val="2"/>')
  })

  it('renders task list items with a checkbox glyph and no competing bullet', async () => {
    const xml = await documentXml('- [ ] todo\n- [x] done\n')
    expect(xml).toContain('☐ ')
    expect(xml).toContain('☒ ')
    // A bullet AND a checkbox would be two markers for one item.
    expect(xml).not.toContain('<w:numPr>')
  })

  it('keeps a fenced code block inside a blockquote (a real regression)', async () => {
    // The first implementation rebuilt each quoted paragraph from the original
    // mdast node's `children` -- which a `code` node does not have -- so the
    // code silently vanished while the quote still rendered.
    const xml = await documentXml('> quoted\n>\n> ```js\n> const x = 1\n> ```\n')
    expect(xml).toContain('const x = 1')
    expect(xml).toContain('quoted')
    // Both carry the quote indent.
    expect(xml.match(/<w:ind w:left="360"\/>/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('does not duplicate a list nested inside a blockquote', async () => {
    const xml = await documentXml('> - one\n> - two\n')
    expect(xml.match(/>one</g)).toHaveLength(1)
    expect(xml.match(/>two</g)).toHaveLength(1)
  })

  it('renders a GFM table with a repeating header row and per-column alignment', async () => {
    const xml = await documentXml('| L | C | R |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n')
    expect(xml).toContain('<w:tbl>')
    expect(xml).toContain('<w:tblHeader/>')
    expect(xml).toContain('<w:jc w:val="left"/>')
    expect(xml).toContain('<w:jc w:val="center"/>')
    expect(xml).toContain('<w:jc w:val="right"/>')
  })

  it('renders a horizontal rule as a bordered paragraph', async () => {
    const xml = await documentXml('a\n\n---\n\nb\n')
    expect(xml).toContain('<w:pBdr>')
    expect(xml).toContain('w:color="BFBFBF"')
  })

  it('renders footnotes as real Word footnotes numbered by first reference', async () => {
    const buffer = await markdownToDocx({
      content: 'Alpha[^b] then beta[^a].\n\n[^a]: Note A.\n[^b]: Note B.\n'
    })
    expect(readDocxDocumentXml(buffer)).toContain('<w:footnoteReference w:id="1"/>')
    const footnotes = readDocxEntry(buffer, 'word/footnotes.xml')?.toString('utf8') ?? ''
    // [^b] is referenced first, so it must be footnote 1.
    expect(footnotes).toMatch(/<w:footnote w:id="1">[\s\S]*?Note B\./)
    expect(footnotes).toMatch(/<w:footnote w:id="2">[\s\S]*?Note A\./)
    // The definition lines never appear in the body.
    expect(readDocxDocumentXml(buffer)).not.toContain('Note A.')
  })

  it('keeps a hard line break', async () => {
    const xml = await documentXml('one  \ntwo\n')
    expect(xml).toContain('<w:br/>')
  })
})

describe('markdownToDocx: what must NOT appear', () => {
  it('never renders YAML frontmatter as body text', async () => {
    const xml = await documentXml('---\npage: A4\nfooterCenter: "x"\n---\n\nBody.\n')
    expect(xml).toContain('Body.')
    expect(xml).not.toContain('page: A4')
    expect(xml).not.toContain('footerCenter')
  })

  it('keeps a commented span’s text but leaks no comment metadata', async () => {
    const content =
      'Start <!--comment id="c1" data="eyJhdXRob3IiOiJLYWkiLCJ0ZXh0IjoiZml4IHRoaXMiLCJjcmVhdGVkQXQiOiIyMDI2LTA4LTExIn0="-->marked text<!--/comment id="c1"--> end.\n'
    const xml = await documentXml(content)
    expect(xml).toContain('marked text')
    expect(xml).not.toContain('c1')
    expect(xml).not.toContain('data=')
    expect(xml).not.toContain('comment')
  })

  it('strips raw HTML tags while keeping the prose between them', async () => {
    const xml = await documentXml('a <span>kept</span> b\n')
    expect(xml).toContain('kept')
    expect(xml).not.toContain('<span>')
  })
})

describe('markdownToDocx: page configuration', () => {
  it('applies the document’s own page size and margins', async () => {
    const xml = await documentXml(
      '---\npage: A4\nmargins:\n  top: 0.5\n  bottom: 1\n  left: 2\n  right: 1\n---\n\nHi\n'
    )
    // A4 at 96dpi is 794x1123 px; x15 twips per px.
    expect(xml).toContain('<w:pgSz w:w="11910" w:h="16845" w:orient="portrait"/>')
    expect(xml).toContain('w:top="720"')
    expect(xml).toContain('w:left="2880"')
  })

  it('emits landscape with width and height the right way round', async () => {
    // computePageGeometry already swaps for orientation AND docx swaps again
    // for a LANDSCAPE w:orient -- the export has to survive both.
    const xml = await documentXml('---\npage: Letter\norientation: landscape\n---\n\nHi\n')
    expect(xml).toContain('<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>')
  })

  it('clamps absurd margins the same way every other surface does', async () => {
    // The documented 6-vs-0.6 typo case: computePageGeometry scales the pair
    // down rather than producing a negative content box, and the export must
    // inherit that rather than emitting margins that overflow the page.
    const xml = await documentXml(
      '---\nmargins:\n  top: 6\n  bottom: 6\n  left: 1\n  right: 1\n---\n\nHi\n'
    )
    const top = Number(/w:top="(\d+)"/.exec(xml)?.[1])
    const bottom = Number(/w:bottom="(\d+)"/.exec(xml)?.[1])
    expect(top + bottom).toBeLessThanOrEqual(11 * 1440 - 1440)
  })

  it('renders a footer with live PAGE and NUMPAGES fields', async () => {
    // DEFAULT_PAGE_CONFIG carries `Page {n} of {total}`, so this is what every
    // document gets by default.
    const buffer = await markdownToDocx({ content: 'Hi\n' })
    const footer = readDocxEntry(buffer, 'word/footer1.xml')?.toString('utf8') ?? ''
    expect(footer).toContain('PAGE')
    expect(footer).toContain('NUMPAGES')
    expect(footer).toContain('Page ')
    expect(readDocxDocumentXml(buffer)).toContain('<w:footerReference')
  })

  it('renders a header when the document asks for one, and omits it otherwise', async () => {
    const withHeader = await markdownToDocx({
      content: '---\nheader: true\nheaderLeft: "Q3 Report"\n---\n\nHi\n'
    })
    expect(readDocxEntry(withHeader, 'word/header1.xml')?.toString('utf8')).toContain('Q3 Report')
    const withoutHeader = await markdownToDocx({ content: 'Hi\n' })
    expect(listDocxEntries(withoutHeader)).not.toContain('word/header1.xml')
  })

  it('carries roman page numbering into the section properties', async () => {
    const xml = await documentXml('---\npageNumberFormat: roman\n---\n\nHi\n')
    expect(xml).toContain('<w:pgNumType w:fmt="lowerRoman"/>')
  })

  it('marks paragraphs bidirectional only for an rtl document', async () => {
    expect(await documentXml('---\ndirection: rtl\n---\n\nHi\n')).toContain('<w:bidi/>')
    // An ltr document must not carry `w:bidi w:val="false"` on every paragraph.
    expect(await documentXml('Hi\n')).not.toContain('w:bidi')
  })

  it('does not let header text break out of the XML it is written into', async () => {
    // Header/footer text is hand-editable frontmatter, i.e. untrusted.
    const buffer = await markdownToDocx({
      content: '---\nheader: true\nheaderCenter: "</w:t></w:r><w:r><w:t>injected"\n---\n\nHi\n'
    })
    const header = readDocxEntry(buffer, 'word/header1.xml')?.toString('utf8') ?? ''
    expect(header).toContain('&lt;/w:t&gt;')
    expect(header).not.toContain('<w:t>injected')
  })
})

describe('resolveDocxTypography', () => {
  it('keeps the default 14px ramp for a default document', () => {
    const typography = resolveDocxTypography(DEFAULT_DOCUMENT_STYLE)
    expect(typography.bodyPx).toBe(14)
    expect(typography.headingPx[1]).toBe(26)
    expect(typography.bodyFont).toBe('Georgia')
  })

  it('scales the whole heading ramp proportionally for an explicit body size', () => {
    // The stylesheet's own calc(26 / 14 * 1em) behaviour: without it an 18px
    // body renders an h3 (fixed 16px) SMALLER than its own paragraphs.
    const typography = resolveDocxTypography({ ...DEFAULT_DOCUMENT_STYLE, fontSize: 18 })
    expect(typography.bodyPx).toBe(18)
    expect(typography.headingPx[3]).toBeGreaterThan(18)
    expect(typography.headingPx[1]).toBeCloseTo((26 / 14) * 18)
  })

  it('applies a theme’s own heading design when no explicit size is set', () => {
    expect(resolveDocxTypography({ ...DEFAULT_DOCUMENT_STYLE, theme: 'report' }).headingPx[1]).toBe(
      32
    )
    expect(resolveDocxTypography({ ...DEFAULT_DOCUMENT_STYLE, theme: 'resume' }).bodyPx).toBe(13)
  })

  it('switches to the sans substitute for the inter family', () => {
    expect(resolveDocxTypography({ ...DEFAULT_DOCUMENT_STYLE, fontFamily: 'inter' }).bodyFont).toBe(
      'Arial'
    )
  })
})

describe('images', () => {
  it('collects local image srcs, including reference-style ones, and excludes remote', () => {
    const tree = parseDocxTree(
      '![a](pics/one.png)\n\n![b][ref]\n\n![c](https://cdn.example/x.png)\n\n[ref]: sub/two.jpg\n'
    )
    expect(collectLocalImageSrcs(tree).sort()).toEqual(['pics/one.png', 'sub/two.jpg'])
  })

  it('embeds a supplied local image as a real media part, scaled to the content box', async () => {
    const png = tinyPng(1200, 600)
    const dimensions = readImageDimensions(png)
    expect(dimensions).toEqual({ type: 'png', widthPx: 1200, heightPx: 600 })
    const asset: DocxImageAsset = { data: png, type: 'png', widthPx: 1200, heightPx: 600 }
    const buffer = await markdownToDocx({
      content: '![a photo](wide.png)\n',
      images: new Map([['wide.png', asset]])
    })
    expect(listDocxEntries(buffer).some((name) => name.startsWith('word/media/'))).toBe(true)
    const xml = readDocxDocumentXml(buffer)
    expect(xml).toContain('<w:drawing>')
    // 1200px scaled to the 624px Letter content box is 624x312, in EMU
    // (914400 per inch / 96 px per inch = 9525 EMU per px).
    expect(xml).toContain(`cx="${624 * 9525}"`)
    expect(xml).toContain(`cy="${312 * 9525}"`)
    expect(xml).toContain('a photo')
  })

  it('never scales an image UP to fill the content box', async () => {
    const png = tinyPng(100, 50)
    const buffer = await markdownToDocx({
      content: '![small](s.png)\n',
      images: new Map([['s.png', { data: png, type: 'png', widthPx: 100, heightPx: 50 }]])
    })
    expect(readDocxDocumentXml(buffer)).toContain(`cx="${100 * 9525}"`)
  })

  it('degrades an unresolvable local image to its alt text without failing the export', async () => {
    const xml = await documentXml('![the alt text](missing.png)\n')
    expect(xml).toContain('the alt text')
    expect(xml).not.toContain('<w:drawing>')
  })

  it('never fetches a remote image: inert alt text without consent, a link with it', async () => {
    const blocked = await markdownToDocx({ content: '![chart](https://cdn.example/c.png)\n' })
    expect(readDocxDocumentXml(blocked)).toContain('chart')
    expect(readDocxDocumentXml(blocked)).not.toContain('<w:hyperlink')
    expect(listDocxEntries(blocked).some((name) => name.startsWith('word/media/'))).toBe(false)

    const allowed = await markdownToDocx({
      content: '![chart](https://cdn.example/c.png)\n',
      allowRemoteImages: true
    })
    expect(readDocxDocumentXml(allowed)).toContain('<w:hyperlink')
    // Consent makes it a link the reader can follow, never embedded bytes.
    expect(listDocxEntries(allowed).some((name) => name.startsWith('word/media/'))).toBe(false)
  })
})

describe('math and diagrams (disclosed limitations)', () => {
  it('keeps a block equation as inert source text rather than dropping it', async () => {
    const xml = await documentXml('$$\nE = mc^2\n$$\n')
    expect(xml).toContain('E = mc^2')
  })

  it('keeps a mermaid diagram as its own source text', async () => {
    const xml = await documentXml('```mermaid\ngraph TD;\n  A-->B;\n```\n')
    expect(xml).toContain('graph TD;')
  })
})
