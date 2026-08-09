import { describe, it, expect, vi, beforeEach } from 'vitest'

// page-count-generator.ts imports `BaseWindow` from 'electron' and builds a
// real sandboxed pagination harness -- neither resolves outside a running
// Electron process, so both are mocked here, following file-io.test.ts's
// established `vi.mock('electron', ...)` precedent for this codebase's
// Electron-dependent main-process tests. Note what is NOT mocked: the entire
// path actually under test (raw document -> extractRawFrontmatter ->
// extractPageConfig -> merge over DEFAULT_PAGE_CONFIG -> computePageGeometry)
// runs for real, against real `resolvePageConfig`/`computePageGeometry`. Only
// the Electron/harness boundary these tests can't cross is faked.
const mocks = vi.hoisted(() => ({
  sendDocument: vi.fn(async () => ({
    pageCount: 3,
    ready: true,
    layoutMs: 1,
    diagramBoxes: [],
    imageBoxes: []
  }))
}))

vi.mock('electron', () => ({
  BaseWindow: class {
    isDestroyed = (): boolean => false
    destroy = vi.fn()
  }
}))

vi.mock('./pagination-window', () => ({
  createPaginationHarness: vi.fn(async () => ({
    view: { webContents: { once: vi.fn() } },
    sendDocument: mocks.sendDocument
  })),
  registerAssetRoot: vi.fn(() => 'test-token'),
  unregisterAssetRoot: vi.fn()
}))

import { getPageCount } from './page-count-generator'

// The sendDocument mock takes no declared parameters (it ignores them and
// returns a fixed result), so Vitest types its recorded call tuple as empty
// and indexing it directly is a compile error. One contained cast here beats
// repeating it at every assertion site.
function geometryFromCall(call: unknown): Record<string, number> {
  return (call as unknown[])[1] as Record<string, number>
}

// Every test uses a DISTINCT content string on purpose: getPageCount keeps a
// single-entry module-level cache keyed on the exact content, so reusing one
// document across two tests would serve the first test's cached result and
// never reach sendDocument at all.
describe('getPageCount page geometry', () => {
  beforeEach(() => {
    mocks.sendDocument.mockClear()
  })

  it('passes real A4 geometry to sendDocument for a `page: A4` document', async () => {
    await getPageCount('---\npage: A4\n---\n\n# A4 report')

    expect(mocks.sendDocument).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ pageWidthPx: 794, pageHeightPx: 1123 }),
      expect.any(Object)
    )
  })

  it('passes Letter geometry for a document with no frontmatter at all', async () => {
    await getPageCount('# Plain document, no frontmatter')

    expect(mocks.sendDocument).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ pageWidthPx: 816, pageHeightPx: 1056 }),
      expect.any(Object)
    )
  })

  // The specific trap `resolvePageConfig` exists to close: `extractPageConfig`
  // returns only the keys the document actually specified, so a document that
  // sets `page:` and nothing else has NO `margins` key. Handing that Partial
  // straight to computePageGeometry would read `.top` off `undefined` and
  // produce NaN geometry -- which the render context turns into a silent
  // `margin: NaNin` @page rule rather than a visible failure.
  it('fills unspecified keys from DEFAULT_PAGE_CONFIG rather than emitting NaN', async () => {
    await getPageCount('---\npage: A4\n---\n\n# Partial frontmatter only')

    const geometry = geometryFromCall(mocks.sendDocument.mock.calls[0])
    expect(geometry).toMatchObject({
      pageWidthPx: 794,
      pageHeightPx: 1123,
      marginTopPx: 96,
      marginBottomPx: 96,
      marginLeftPx: 96,
      marginRightPx: 96
    })
    for (const value of Object.values(geometry)) {
      expect(Number.isNaN(value)).toBe(false)
    }
  })

  it('honours landscape orientation from frontmatter', async () => {
    await getPageCount('---\npage: A4\norientation: landscape\n---\n\n# Wide')

    expect(mocks.sendDocument).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ pageWidthPx: 1123, pageHeightPx: 794 }),
      expect.any(Object)
    )
  })
})
