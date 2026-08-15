import { describe, it, expect } from 'vitest'
import {
  computeEditorRunningBands,
  computeSeamRunningContent,
  resolveRunningContentText,
  toLowerRoman
} from './editor-running-content'
import { computePageGeometry } from './page-geometry'
import { DEFAULT_PAGE_CONFIG } from '../markdown/page-config'
import { resolveDocumentStyle } from './document-style'
import { PAGE_SEAM_GAP_PX } from './page-seam'

const geometry = computePageGeometry(DEFAULT_PAGE_CONFIG)

const styleWith = (
  overrides: Partial<Parameters<typeof resolveDocumentStyle>[0]>
): ReturnType<typeof resolveDocumentStyle> =>
  resolveDocumentStyle({ ...DEFAULT_PAGE_CONFIG, ...overrides })

describe('toLowerRoman', () => {
  it('matches CSS lower-roman for the values a page counter produces', () => {
    expect([1, 2, 3, 4, 5, 9, 10, 14, 40, 90, 400, 1990].map(toLowerRoman)).toEqual([
      'i',
      'ii',
      'iii',
      'iv',
      'v',
      'ix',
      'x',
      'xiv',
      'xl',
      'xc',
      'cd',
      'mcmxc'
    ])
  })

  it('falls back to decimal outside the range roman numerals are defined for', () => {
    // Matches the CSS `lower-roman` counter style, which is defined only for
    // positive integers and falls back to `decimal` elsewhere. A page counter
    // should never reach here, but a malformed page count must not render an
    // empty header.
    expect(toLowerRoman(0)).toBe('0')
    expect(toLowerRoman(-3)).toBe('-3')
  })
})

describe('resolveRunningContentText', () => {
  it('substitutes both tokens, including repeats', () => {
    expect(resolveRunningContentText('Page {n} of {total}', 2, 7, 'decimal')).toBe('Page 2 of 7')
    expect(resolveRunningContentText('{n}/{n}', 3, 9, 'decimal')).toBe('3/3')
  })

  it('honours roman numbering on both tokens', () => {
    expect(resolveRunningContentText('{n} of {total}', 4, 9, 'roman')).toBe('iv of ix')
  })

  it('leaves text with no tokens untouched', () => {
    expect(resolveRunningContentText('Northwind Analytics', 1, 3, 'decimal')).toBe(
      'Northwind Analytics'
    )
  })
})

describe('computeEditorRunningBands', () => {
  it('returns nothing when the document has neither band', () => {
    const style = styleWith({ showHeader: false, showFooter: false })
    expect(computeEditorRunningBands(geometry, style, 5)).toEqual([])
  })

  it('owns ONLY the first header and the last footer', () => {
    // The middle bands are drawn by the seams instead -- a seam sits where its
    // page's last BLOCK ends, which drifts above the geometric boundary and
    // accumulates, so anchoring them here would put them progressively below
    // the sheet they belong to.
    const style = styleWith({
      showHeader: true,
      header: { left: '', center: 'HDR', right: '' },
      showFooter: true,
      footer: { left: '', center: 'Page {n} of {total}', right: '' }
    })
    const bands = computeEditorRunningBands(geometry, style, 4)
    expect(bands.map((b) => `${b.band}:${b.pageNumber}`)).toEqual(['header:1', 'footer:4'])
    expect(bands[1].center).toBe('Page 4 of 4')
  })

  it('places the first header at the very top and the last footer at the card bottom', () => {
    const style = styleWith({
      showHeader: true,
      header: { left: '', center: 'HDR', right: '' },
      showFooter: true,
      footer: { left: '', center: 'F', right: '' }
    })
    const pages = 3
    const bands = computeEditorRunningBands(geometry, style, pages)
    const header = bands.find((b) => b.band === 'header')!
    const footer = bands.find((b) => b.band === 'footer')!

    expect(header.topPx).toBe(0)
    expect(header.heightPx).toBe(geometry.marginTopPx)

    // The card's own height, from the same identity computePageCardMinHeightPx
    // uses -- so the last footer ends exactly on the card's bottom edge.
    const cardHeight = pages * geometry.pageHeightPx + (pages - 1) * PAGE_SEAM_GAP_PX
    expect(footer.topPx + footer.heightPx).toBe(cardHeight)
    expect(footer.heightPx).toBe(geometry.marginBottomPx)
  })

  it('aligns bands to the content column, not the sheet edge', () => {
    const style = styleWith({ showHeader: true, header: { left: 'L', center: '', right: '' } })
    const [band] = computeEditorRunningBands(geometry, style, 1)
    expect(band.leftPx).toBe(geometry.marginLeftPx)
    expect(band.widthPx).toBe(geometry.contentWidthPx)
  })

  it('emits no band when every side of it is empty', () => {
    // Mirrors buildBand's own rule on the paginated side: an all-empty band
    // would be a real element claiming a header exists where the PDF has none.
    const style = styleWith({
      showHeader: true,
      header: { left: '', center: '', right: '' },
      showFooter: false
    })
    expect(computeEditorRunningBands(geometry, style, 2)).toEqual([])
  })
})

describe('computeSeamRunningContent', () => {
  it('pairs the ENDING page footer with the NEXT page header', () => {
    const style = styleWith({
      showHeader: true,
      header: { left: '', center: 'p{n}', right: '' },
      showFooter: true,
      footer: { left: '', center: 'Page {n} of {total}', right: '' }
    })
    const content = computeSeamRunningContent(style, 2, 5)
    expect(content.footer?.center).toBe('Page 2 of 5')
    // The seam after page 2 begins page 3.
    expect(content.header?.center).toBe('p3')
  })

  it('returns nulls for a document with neither band', () => {
    const style = styleWith({ showHeader: false, showFooter: false })
    expect(computeSeamRunningContent(style, 1, 2)).toEqual({ footer: null, header: null })
  })
})
