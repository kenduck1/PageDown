import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computePageGeometry } from './page-geometry'
import { DEFAULT_PAGE_CONFIG } from '../markdown/page-config'
import {
  PAGE_SEAM_GAP_PX,
  PAGE_SEAM_CSS_VARIABLES,
  computePageSeamMetrics,
  computePageCardMinHeightPx,
  computeEditorPagePitchPx,
  pageSeamCssVariables
} from './page-seam'

const BASE_CSS = join(__dirname, '..', 'renderer', 'src', 'assets', 'base.css')

const LETTER = computePageGeometry(DEFAULT_PAGE_CONFIG)

describe('computePageSeamMetrics', () => {
  it('splits a Letter/1in boundary into ending-page paper, gutter, and starting-page paper', () => {
    expect(computePageSeamMetrics(LETTER)).toEqual({
      paperAbovePx: 96,
      gapPx: PAGE_SEAM_GAP_PX,
      paperBelowPx: 96,
      heightPx: 96 + PAGE_SEAM_GAP_PX + 96
    })
  })

  it("follows the DOCUMENT's own margins, not a fixed constant", () => {
    // The whole reason this takes a PageGeometry rather than being three
    // constants: a tight-margin document's page boundary is visibly tighter,
    // exactly as its printed output is.
    const tight = computePageGeometry({
      ...DEFAULT_PAGE_CONFIG,
      margins: { top: 0.5, bottom: 0.25, left: 1, right: 1 }
    })
    const metrics = computePageSeamMetrics(tight)
    expect(metrics.paperAbovePx).toBe(24)
    expect(metrics.paperBelowPx).toBe(48)
    expect(metrics.heightPx).toBe(24 + PAGE_SEAM_GAP_PX + 48)
  })

  it('is exactly the space one page boundary costs, so page pitch is pageHeight + gap', () => {
    // The identity the Split-mode Follow estimate now divides by, and the one
    // Gate 37's displacement assertion is written against. Stated as a test
    // rather than a comment because both of those depend on it holding.
    const seam = computePageSeamMetrics(LETTER)
    expect(LETTER.contentHeightPx + seam.heightPx).toBe(LETTER.pageHeightPx + PAGE_SEAM_GAP_PX)
  })
})

describe('computePageCardMinHeightPx', () => {
  it('is exactly one whole sheet when nothing has broken yet', () => {
    expect(computePageCardMinHeightPx(LETTER, 0)).toBe(1056)
  })

  it('adds a whole sheet plus one gutter per seam', () => {
    expect(computePageCardMinHeightPx(LETTER, 1)).toBe(1056 * 2 + PAGE_SEAM_GAP_PX)
    expect(computePageCardMinHeightPx(LETTER, 4)).toBe(1056 * 5 + PAGE_SEAM_GAP_PX * 4)
  })

  it('never goes below one sheet for a nonsense seam count', () => {
    // Defensive: seamCount is reported up from a ProseMirror plugin view, and
    // a card shorter than a page would be the "strip" defect coming back.
    expect(computePageCardMinHeightPx(LETTER, -3)).toBe(1056)
    expect(computePageCardMinHeightPx(LETTER, 0.7)).toBe(1056)
  })

  it('always binds: the natural height of n full content pages can never exceed it', () => {
    // The proof written out as an executable check -- see the function's own
    // doc comment. Worst case is every page filled to the very last pixel.
    for (const seamCount of [0, 1, 2, 7]) {
      const pages = seamCount + 1
      const naturalWorstCase =
        LETTER.marginTopPx +
        pages * LETTER.contentHeightPx +
        seamCount * computePageSeamMetrics(LETTER).heightPx +
        LETTER.marginBottomPx
      expect(computePageCardMinHeightPx(LETTER, seamCount)).toBeGreaterThanOrEqual(naturalWorstCase)
    }
  })
})

describe('computeEditorPagePitchPx', () => {
  it('is a whole sheet plus one gutter', () => {
    expect(computeEditorPagePitchPx(LETTER)).toBe(1056 + PAGE_SEAM_GAP_PX)
  })

  it('is strictly greater than the contentHeightPx divisor it replaced', () => {
    // The whole reason Split-mode Follow had to change: the canvas advances by
    // more than a content box per page now, and the old divisor would have
    // under-reported the page further and further into a document rather than
    // failing loudly.
    expect(computeEditorPagePitchPx(LETTER)).toBeGreaterThan(LETTER.contentHeightPx)
  })
})

describe('pageSeamCssVariables', () => {
  it('publishes px strings for every declared variable name', () => {
    const vars = pageSeamCssVariables(LETTER)
    expect(vars).toEqual({
      '--pagedown-seam-paper-above': '96px',
      '--pagedown-seam-gap': `${PAGE_SEAM_GAP_PX}px`,
      '--pagedown-seam-paper-below': '96px',
      '--pagedown-seam-bleed-left': '96px',
      '--pagedown-seam-bleed-right': '96px'
    })
  })

  it('bleeds by exactly the side margins, so a seam reaches the sheet edges', () => {
    // computePageGeometry's defining identity restated at the one place that
    // depends on it for a REASON other than text width: the seam is pulled out
    // of a contentWidthPx-wide box and must land on pageWidthPx exactly.
    const a4 = computePageGeometry({
      ...DEFAULT_PAGE_CONFIG,
      pageSize: 'A4',
      margins: { top: 1, bottom: 1, left: 0.5, right: 0.75 }
    })
    const vars = pageSeamCssVariables(a4)
    expect(vars['--pagedown-seam-bleed-left']).toBe(`${a4.marginLeftPx}px`)
    expect(vars['--pagedown-seam-bleed-right']).toBe(`${a4.marginRightPx}px`)
    expect(a4.contentWidthPx + a4.marginLeftPx + a4.marginRightPx).toBe(a4.pageWidthPx)
  })
})

describe('the TS <-> CSS variable contract', () => {
  // An unresolved var() is invalid-at-computed-value-time and fails SILENTLY,
  // which is exactly how h5/h6 once shipped at the wrong size on one surface.
  // The names live in TS and are consumed in CSS, and CSS cannot import a
  // constant, so this is the only place the pair can actually be checked.
  it('base.css reads every variable page-seam.ts publishes', () => {
    const baseCss = readFileSync(BASE_CSS, 'utf8')
    for (const name of Object.values(PAGE_SEAM_CSS_VARIABLES)) {
      expect(baseCss, `base.css never reads var(${name})`).toContain(`var(${name})`)
    }
  })

  it('base.css declares no fallback default for them, so a missing publisher is loud', () => {
    // `var(--x, 96px)` would let the seam render plausibly-but-wrongly if the
    // mount ever stopped publishing the real geometry. Better that it collapse.
    const baseCss = readFileSync(BASE_CSS, 'utf8')
    for (const name of Object.values(PAGE_SEAM_CSS_VARIABLES)) {
      expect(baseCss).not.toContain(`var(${name},`)
    }
  })
})
