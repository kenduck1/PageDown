import { describe, it, expect, vi, beforeEach } from 'vitest'

// print-exporter.ts imports withFreshHarness/enqueueExport (real, unmocked)
// from pdf-exporter.ts, which itself imports `dialog`/`BaseWindow` from
// 'electron' and createPaginationHarness/registerAssetRoot/unregisterAssetRoot
// from './pagination-window' -- so this file needs the exact same mocks
// pdf-exporter.test.ts already establishes for those, since they're loaded
// transitively through print-exporter.ts's own real import of pdf-exporter.ts.
const mocks = vi.hoisted(() => ({
  setBounds: vi.fn(),
  sendDocument: vi.fn(async () => ({
    pageCount: 4,
    ready: true,
    layoutMs: 1,
    diagramBoxes: [],
    imageBoxes: []
  })),
  print: vi.fn((_options: unknown, callback: (success: boolean, failureReason: string) => void) =>
    callback(true, '')
  )
}))

vi.mock('electron', () => ({
  dialog: { showSaveDialog: vi.fn() },
  BaseWindow: class {
    isDestroyed = (): boolean => false
    destroy = vi.fn()
  }
}))

vi.mock('./pagination-window', () => ({
  createPaginationHarness: vi.fn(async () => ({
    view: {
      setBounds: mocks.setBounds,
      webContents: { once: vi.fn(), print: mocks.print }
    },
    sendDocument: mocks.sendDocument
  })),
  registerAssetRoot: vi.fn(() => 'test-token'),
  unregisterAssetRoot: vi.fn()
}))

import { printDocument } from './print-exporter'

describe('printDocument', () => {
  beforeEach(() => {
    mocks.sendDocument.mockClear()
    mocks.setBounds.mockClear()
    mocks.print.mockClear()
    mocks.print.mockImplementation((_options, callback) => callback(true, ''))
  })

  it('passes real A4 geometry to sendDocument, keeping the print timeout fourth', async () => {
    await printDocument('---\npage: A4\n---\n\n# A4 report')

    expect(mocks.sendDocument).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ pageWidthPx: 794, pageHeightPx: 1123 }),
      expect.any(Object),
      30_000
    )
  })

  it('sizes the harness view to the document geometry, not a fixed Letter box', async () => {
    await printDocument('---\npage: A4\n---\n\n# A4 report')

    expect(mocks.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 794, height: 1123 })
  })

  it('falls back to Letter geometry for a document with no frontmatter', async () => {
    await printDocument('# Plain document, no frontmatter')

    expect(mocks.sendDocument).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ pageWidthPx: 816, pageHeightPx: 1056 }),
      expect.any(Object),
      30_000
    )
  })

  it('calls webContents.print with printBackground and color enabled, not silent', async () => {
    await printDocument('# Report')

    expect(mocks.print).toHaveBeenCalledWith(
      expect.objectContaining({ silent: false, printBackground: true, color: true }),
      expect.any(Function)
    )
  })

  it('resolves { cancelled: false } on a successful print', async () => {
    const result = await printDocument('# Report')
    expect(result).toEqual({ cancelled: false })
  })

  it('resolves { cancelled: true } (not a rejection) when the user cancels the OS print dialog', async () => {
    // Electron's own documented failureReason string for this case
    // (electron.d.ts's own doc comment on WebContents.print) -- a cancelled
    // dialog is the user's own choice, not a failure this app should surface
    // as an error.
    mocks.print.mockImplementation((_options, callback) => callback(false, 'Print job canceled'))

    const result = await printDocument('# Report')
    expect(result).toEqual({ cancelled: true })
  })

  it('rejects with a real error message for a genuine print failure', async () => {
    mocks.print.mockImplementation((_options, callback) => callback(false, 'Print job failed'))

    await expect(printDocument('# Report')).rejects.toThrow('Print job failed')
  })
})
