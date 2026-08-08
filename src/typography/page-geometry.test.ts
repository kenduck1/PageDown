import { describe, it, expect } from 'vitest'
import {
  DPI,
  PAGE_WIDTH_PX,
  PAGE_HEIGHT_PX,
  PAGE_MARGIN_PX,
  CONTENT_WIDTH_PX,
  computePageGeometry
} from './page-geometry'
import { DEFAULT_PAGE_CONFIG, type PageConfig } from '../markdown/page-config'

describe('page-geometry', () => {
  it('exports the CSS reference pixel density its px constants are derived at', () => {
    // DPI is public surface, not an implementation detail: the pagination
    // render context divides the px constants below back out by it to build
    // an inch-denominated `@page` rule. Pinned so that a change to it can't
    // silently desynchronize the two representations of the same geometry.
    expect(DPI).toBe(96)
    expect(PAGE_WIDTH_PX / DPI).toBe(8.5)
    expect(PAGE_HEIGHT_PX / DPI).toBe(11)
    expect(PAGE_MARGIN_PX / DPI).toBe(1)
  })

  it('matches the existing, already-shipped Letter-at-96dpi pixel geometry', () => {
    // These are not new values -- they're the literals already hardcoded in
    // three places (pagination-window.ts, main/index.ts, pdf-exporter.ts)
    // before this task, and DEFAULT_PAGE_CONFIG's 1in margins at 96dpi.
    // Pinning them here is what makes a future accidental change to any one
    // of them a visible test failure instead of a silent drift.
    expect(PAGE_WIDTH_PX).toBe(816)
    expect(PAGE_HEIGHT_PX).toBe(1056)
    expect(PAGE_MARGIN_PX).toBe(96)
  })

  it('derives content width from page width minus margins on both sides, not a separately-chosen number', () => {
    expect(CONTENT_WIDTH_PX).toBe(PAGE_WIDTH_PX - PAGE_MARGIN_PX * 2)
    expect(CONTENT_WIDTH_PX).toBe(624)
  })
})

describe('computePageGeometry', () => {
  it('matches the existing fixed Letter/portrait/1in constants for DEFAULT_PAGE_CONFIG', () => {
    const geometry = computePageGeometry(DEFAULT_PAGE_CONFIG)
    expect(geometry.pageWidthPx).toBe(PAGE_WIDTH_PX)
    expect(geometry.pageHeightPx).toBe(PAGE_HEIGHT_PX)
    expect(geometry.marginTopPx).toBe(PAGE_MARGIN_PX)
    expect(geometry.marginLeftPx).toBe(PAGE_MARGIN_PX)
  })

  it('computes real A4 dimensions (210mm x 297mm), not Letter', () => {
    const config: PageConfig = { ...DEFAULT_PAGE_CONFIG, pageSize: 'A4' }
    const geometry = computePageGeometry(config)
    // 210mm / 25.4 * 96 = 793.7... -> 794; 297mm / 25.4 * 96 = 1122.5... -> 1123
    expect(geometry.pageWidthPx).toBe(794)
    expect(geometry.pageHeightPx).toBe(1123)
  })

  it('computes real Legal dimensions (8.5in x 14in)', () => {
    const config: PageConfig = { ...DEFAULT_PAGE_CONFIG, pageSize: 'Legal' }
    const geometry = computePageGeometry(config)
    expect(geometry.pageWidthPx).toBe(816)
    expect(geometry.pageHeightPx).toBe(1344)
  })

  it('swaps width and height for landscape orientation', () => {
    const config: PageConfig = { ...DEFAULT_PAGE_CONFIG, orientation: 'landscape' }
    const geometry = computePageGeometry(config)
    expect(geometry.pageWidthPx).toBe(PAGE_HEIGHT_PX)
    expect(geometry.pageHeightPx).toBe(PAGE_WIDTH_PX)
  })

  it('uses the document own custom dimensions', () => {
    const geometry = computePageGeometry({
      ...DEFAULT_PAGE_CONFIG,
      pageSize: 'Custom',
      customWidth: 5,
      customHeight: 7
    })
    expect(geometry.pageWidthPx).toBe(480)
    expect(geometry.pageHeightPx).toBe(672)
  })

  it('falls back to Letter dimensions when a custom dimension is not finite', () => {
    const geometry = computePageGeometry({
      ...DEFAULT_PAGE_CONFIG,
      pageSize: 'Custom',
      customWidth: Number.NaN,
      customHeight: 7
    })
    expect(geometry.pageWidthPx).toBe(816)
    expect(geometry.pageHeightPx).toBe(672)
  })

  it('clamps an absurdly small custom page up to the 2in floor', () => {
    const geometry = computePageGeometry({
      ...DEFAULT_PAGE_CONFIG,
      pageSize: 'Custom',
      customWidth: 0.1,
      customHeight: 0
    })
    expect(geometry.pageWidthPx).toBe(192)
    expect(geometry.pageHeightPx).toBe(192)
  })

  it('clamps an absurdly large custom page down to the 200in ceiling', () => {
    const geometry = computePageGeometry({
      ...DEFAULT_PAGE_CONFIG,
      pageSize: 'Custom',
      customWidth: 100000,
      customHeight: 100000
    })
    expect(geometry.pageWidthPx).toBe(19200)
    expect(geometry.pageHeightPx).toBe(19200)
  })

  it('still leaves at least 1in of content on a minimum-size custom page', () => {
    const geometry = computePageGeometry({
      ...DEFAULT_PAGE_CONFIG,
      pageSize: 'Custom',
      customWidth: 2,
      customHeight: 2,
      margins: { top: 1, bottom: 1, left: 1, right: 1 }
    })
    expect(geometry.contentWidthPx).toBeGreaterThanOrEqual(96)
    expect(geometry.contentHeightPx).toBeGreaterThanOrEqual(96)
  })

  it('leaves every named page size bit-for-bit unchanged', () => {
    expect(computePageGeometry(DEFAULT_PAGE_CONFIG)).toEqual({
      pageWidthPx: 816,
      pageHeightPx: 1056,
      marginTopPx: 96,
      marginBottomPx: 96,
      marginLeftPx: 96,
      marginRightPx: 96,
      contentWidthPx: 624,
      contentHeightPx: 864
    })
  })

  it('computes contentWidthPx/contentHeightPx from EACH side independently, not a doubled uniform value', () => {
    const config: PageConfig = {
      ...DEFAULT_PAGE_CONFIG,
      margins: { top: 0.5, bottom: 1.5, left: 1, right: 2 }
    }
    const geometry = computePageGeometry(config)
    expect(geometry.marginTopPx).toBe(48) // 0.5in * 96
    expect(geometry.marginBottomPx).toBe(144) // 1.5in * 96
    expect(geometry.marginLeftPx).toBe(96) // 1in * 96
    expect(geometry.marginRightPx).toBe(192) // 2in * 96
    // 816 - 96 - 192 = 528; 1056 - 48 - 144 = 864
    expect(geometry.contentWidthPx).toBe(528)
    expect(geometry.contentHeightPx).toBe(864)
  })
})

// The safety clamp. Margins are the one free-form, attacker-reachable input
// into this function (page size is a 3-entry allowlist lookup), and a
// plausible typo -- `6` for `0.6` -- previously produced a NEGATIVE content
// extent that was interpolated straight into the sandboxed `@page` rule. See
// computePageGeometry's own comment for what pagedjs@0.4.3 actually does with
// that (a duplicated-content page explosion, not a hang, verified rather than
// assumed).
describe('computePageGeometry margin clamping', () => {
  it('leaves a NORMAL config bit-for-bit unchanged (regression net for the clamp)', () => {
    // The whole risk of adding a clamp is that it silently perturbs ordinary
    // documents. Deep-equality on the WHOLE geometry object, for both the
    // default config and the asymmetric one the test above pins field by
    // field, is the direct statement that it does not. On Letter the clamp's
    // own thresholds are nowhere near: 816 - 96 = 720 available horizontally
    // against 192 requested, 1056 - 96 = 960 vertically against 192.
    expect(computePageGeometry(DEFAULT_PAGE_CONFIG)).toEqual({
      pageWidthPx: 816,
      pageHeightPx: 1056,
      marginTopPx: 96,
      marginBottomPx: 96,
      marginLeftPx: 96,
      marginRightPx: 96,
      contentWidthPx: 624,
      contentHeightPx: 864
    })
    const asymmetric: PageConfig = {
      ...DEFAULT_PAGE_CONFIG,
      margins: { top: 0.5, bottom: 1.5, left: 1, right: 2 }
    }
    expect(computePageGeometry(asymmetric)).toEqual({
      pageWidthPx: 816,
      pageHeightPx: 1056,
      marginTopPx: 48,
      marginBottomPx: 144,
      marginLeftPx: 96,
      marginRightPx: 192,
      contentWidthPx: 528,
      contentHeightPx: 864
    })
  })

  it('scales an over-large VERTICAL margin pair proportionally, leaving 1in of content', () => {
    // 6in top + 6in bottom on an 11in page: 1056 - 576 - 576 = -96px content
    // height before the clamp. Available total is 1056 - 96 = 960, so each
    // side scales to 480.
    const config: PageConfig = {
      ...DEFAULT_PAGE_CONFIG,
      margins: { ...DEFAULT_PAGE_CONFIG.margins, top: 6, bottom: 6 }
    }
    const geometry = computePageGeometry(config)
    expect(geometry.marginTopPx).toBe(480)
    expect(geometry.marginBottomPx).toBe(480)
    expect(geometry.contentHeightPx).toBe(96)
    // The horizontal axis is clamped INDEPENDENTLY and was never over-large,
    // so it must be untouched by the vertical axis's rescaling.
    expect(geometry.marginLeftPx).toBe(96)
    expect(geometry.marginRightPx).toBe(96)
    expect(geometry.contentWidthPx).toBe(624)
  })

  it('preserves the requested RATIO between the two sides when it scales them', () => {
    // 3in top : 9in bottom is 1:3. Available total is 960, so the clamped
    // pair must be 240:720 -- still 1:3 -- not an equal split and not a
    // truncation of one side alone.
    const config: PageConfig = {
      ...DEFAULT_PAGE_CONFIG,
      margins: { ...DEFAULT_PAGE_CONFIG.margins, top: 3, bottom: 9 }
    }
    const geometry = computePageGeometry(config)
    expect(geometry.marginTopPx).toBe(240)
    expect(geometry.marginBottomPx).toBe(720)
    expect(geometry.marginBottomPx / geometry.marginTopPx).toBe(3)
    expect(geometry.contentHeightPx).toBe(96)
  })

  it('scales an over-large HORIZONTAL margin pair, leaving 1in of content', () => {
    // 5in + 5in on an 8.5in page: 816 - 480 - 480 = -144px before the clamp.
    // Available total is 816 - 96 = 720, so each side scales to 360.
    const config: PageConfig = {
      ...DEFAULT_PAGE_CONFIG,
      margins: { ...DEFAULT_PAGE_CONFIG.margins, left: 5, right: 5 }
    }
    const geometry = computePageGeometry(config)
    expect(geometry.marginLeftPx).toBe(360)
    expect(geometry.marginRightPx).toBe(360)
    expect(geometry.contentWidthPx).toBe(96)
    expect(geometry.contentHeightPx).toBe(864)
  })

  it('never emits a zero or negative content extent, on either axis, for any margin pair', () => {
    // The property the clamp exists to guarantee, stated directly against the
    // failure mode: zero available height is what makes Paged.js emit one
    // duplicated page per source node.
    for (const margin of [3, 6, 20, 1000]) {
      const config: PageConfig = {
        ...DEFAULT_PAGE_CONFIG,
        margins: { top: margin, bottom: margin, left: margin, right: margin }
      }
      const geometry = computePageGeometry(config)
      expect(geometry.contentWidthPx).toBeGreaterThanOrEqual(DPI)
      expect(geometry.contentHeightPx).toBeGreaterThanOrEqual(DPI)
    }
  })

  it('clamps a NEGATIVE margin to zero rather than inflating the content box past the page', () => {
    // parseMargins accepts any finite number, so a negative side is reachable
    // from frontmatter. Unclamped, -1in left would give a 912px content width
    // on an 816px page.
    const config: PageConfig = {
      ...DEFAULT_PAGE_CONFIG,
      margins: { top: -1, bottom: 1, left: -0.5, right: 1 }
    }
    const geometry = computePageGeometry(config)
    expect(geometry.marginTopPx).toBe(0)
    expect(geometry.marginLeftPx).toBe(0)
    expect(geometry.marginBottomPx).toBe(96)
    expect(geometry.marginRightPx).toBe(96)
    expect(geometry.contentWidthPx).toBe(720)
    expect(geometry.contentHeightPx).toBe(960)
  })

  it('clamps against the ROTATED extent for landscape, not the portrait one', () => {
    // Landscape Letter is 1056 x 816, so the horizontal axis now has 960
    // available and the vertical only 720 -- the opposite of portrait. 5in
    // per side horizontally (960px total) therefore fits exactly and is NOT
    // scaled, while the same 5in per side vertically is.
    const config: PageConfig = {
      ...DEFAULT_PAGE_CONFIG,
      orientation: 'landscape',
      margins: { top: 5, bottom: 5, left: 5, right: 5 }
    }
    const geometry = computePageGeometry(config)
    expect(geometry.marginLeftPx).toBe(480)
    expect(geometry.marginRightPx).toBe(480)
    expect(geometry.contentWidthPx).toBe(96)
    expect(geometry.marginTopPx).toBe(360)
    expect(geometry.marginBottomPx).toBe(360)
    expect(geometry.contentHeightPx).toBe(96)
  })
})
