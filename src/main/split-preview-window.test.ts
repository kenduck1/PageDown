import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'

// split-preview-window.ts constructs a real `WebContentsView` and reuses the
// render context's real session/CSP/protocol registration -- neither resolves
// outside a running Electron process, so both are mocked here, following
// file-io.test.ts's established `vi.mock('electron', ...)` precedent.
//
// What this leaves genuinely under test is the one thing this module does
// that its caller in src/main/index.ts cannot cover: unlike every other
// harness consumer, this file does NOT delegate to
// PaginationHarness.sendDocument -- it takes raw Markdown and builds and
// posts its own `RenderRequestMessage` payload inline. So the payload it puts
// on the wire is a real seam with a real assertion available: that the
// geometry in it is computed from the DOCUMENT's own frontmatter rather than
// a fixed Letter default. The shared RenderRequestMessage type makes a
// MISSING `geometry` field a compile error, but nothing static can tell a
// correctly-computed geometry from a hardcoded one -- that's what these
// tests pin.
const mocks = vi.hoisted(() => ({
  executeJavaScript: vi.fn(async (script: string) => {
    // The poll loop's own result probe, as opposed to the postMessage
    // dispatch -- answering it immediately keeps sendDocument from spinning
    // to its timeout.
    if (script.includes('__pagedownResult')) {
      return { type: 'result', pageCount: 2, ready: true, layoutMs: 1 }
    }
    return undefined
  })
}))

vi.mock('electron', () => ({
  WebContentsView: class {
    setBounds = vi.fn()
    webContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(async () => undefined),
      executeJavaScript: mocks.executeJavaScript,
      isDestroyed: (): boolean => false,
      close: vi.fn()
    }
  }
}))

vi.mock('./pagination-window', () => ({
  ensureRenderInfraRegistered: vi.fn(() => ({})),
  registerAssetRoot: vi.fn(() => 'test-token'),
  unregisterAssetRoot: vi.fn()
}))

import { createSplitPreviewHarness } from './split-preview-window'

const fakeMainWindow = {
  contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  isDestroyed: (): boolean => false
} as unknown as BrowserWindow

// Pulls the real RenderRequestMessage back out of the
// `window.postMessage(<json>, '*')` script the harness evaluated, so these
// assertions run against the actual payload rather than a substring match.
function capturedRenderMessage(): Record<string, unknown> {
  const script = mocks.executeJavaScript.mock.calls
    .map((call) => call[0])
    .find((candidate) => candidate.startsWith('window.postMessage('))
  if (!script) throw new Error('No postMessage dispatch was captured')
  const json = /^window\.postMessage\((.*), '\*'\)$/s.exec(script)?.[1]
  if (!json) throw new Error(`Could not parse the dispatched script: ${script}`)
  return JSON.parse(json) as Record<string, unknown>
}

describe('createSplitPreviewHarness sendDocument page geometry', () => {
  beforeEach(() => {
    mocks.executeJavaScript.mockClear()
  })

  it('posts real A4 geometry for a `page: A4` document', async () => {
    const harness = await createSplitPreviewHarness(fakeMainWindow)
    await harness.sendDocument('---\npage: A4\n---\n\n# A4 report', null)

    expect(capturedRenderMessage()).toMatchObject({
      type: 'render',
      geometry: { pageWidthPx: 794, pageHeightPx: 1123 }
    })
  })

  it('posts Letter geometry for a document with no frontmatter at all', async () => {
    const harness = await createSplitPreviewHarness(fakeMainWindow)
    await harness.sendDocument('# Plain document, no frontmatter', null)

    expect(capturedRenderMessage()).toMatchObject({
      geometry: { pageWidthPx: 816, pageHeightPx: 1056 }
    })
  })

  // Same NaN trap `resolvePageConfig` closes for every other caller: a
  // document specifying only `page:` has no `margins` key of its own, and an
  // unmerged Partial would read `.top` off `undefined` -- which surfaces here
  // as a literal `margin: NaNin` @page rule in the live preview.
  it('fills unspecified keys from DEFAULT_PAGE_CONFIG rather than posting NaN', async () => {
    const harness = await createSplitPreviewHarness(fakeMainWindow)
    await harness.sendDocument('---\npage: A4\n---\n\n# Partial frontmatter only', null)

    const geometry = capturedRenderMessage().geometry as Record<string, number>
    expect(geometry).toMatchObject({
      marginTopPx: 96,
      marginBottomPx: 96,
      marginLeftPx: 96,
      marginRightPx: 96
    })
    // Checked as "still a finite number after the JSON round trip", NOT as
    // `Number.isNaN(value)`: this harness serializes its payload through
    // `JSON.stringify`, which maps NaN to `null` -- so a NaN-checking loop
    // here would be testing `Number.isNaN(null)`, which is false for every
    // value and can never fail. (The equivalent loop in
    // page-count-generator.test.ts IS a real NaN check, because that path has
    // no JSON round trip.) `null` fails both assertions below.
    for (const [key, value] of Object.entries(geometry)) {
      expect(typeof value, `${key} must survive JSON.stringify as a number`).toBe('number')
      expect(Number.isFinite(value), `${key} must be finite`).toBe(true)
    }
  })
})
