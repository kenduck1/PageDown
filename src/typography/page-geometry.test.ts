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

  it('falls back Custom page size to Letter, same as malformed/missing frontmatter elsewhere', () => {
    const config: PageConfig = { ...DEFAULT_PAGE_CONFIG, pageSize: 'Custom' }
    const geometry = computePageGeometry(config)
    expect(geometry.pageWidthPx).toBe(PAGE_WIDTH_PX)
    expect(geometry.pageHeightPx).toBe(PAGE_HEIGHT_PX)
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
