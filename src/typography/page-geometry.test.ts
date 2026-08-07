import { describe, it, expect } from 'vitest'
import { PAGE_WIDTH_PX, PAGE_HEIGHT_PX, PAGE_MARGIN_PX, CONTENT_WIDTH_PX } from './page-geometry'

describe('page-geometry', () => {
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
