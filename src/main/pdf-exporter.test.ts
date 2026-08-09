import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

// pdf-exporter.ts imports `dialog`/`BaseWindow` from 'electron', builds a real
// sandboxed pagination harness, and calls printToPDF -- none of which resolve
// outside a running Electron process, so all three are mocked here, following
// file-io.test.ts's established `vi.mock('electron', ...)` precedent. The path
// actually under test (raw document -> frontmatter -> PageConfig ->
// PageGeometry, and where that geometry then lands) runs for real.
const mocks = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  setBounds: vi.fn(),
  sendDocument: vi.fn(async () => ({
    pageCount: 4,
    ready: true,
    layoutMs: 1,
    diagramBoxes: [],
    imageBoxes: []
  }))
}))

vi.mock('electron', () => ({
  dialog: { showSaveDialog: mocks.showSaveDialog },
  BaseWindow: class {
    isDestroyed = (): boolean => false
    destroy = vi.fn()
  }
}))

vi.mock('./pagination-window', () => ({
  createPaginationHarness: vi.fn(async () => ({
    view: { setBounds: mocks.setBounds, webContents: { once: vi.fn() } },
    sendDocument: mocks.sendDocument
  })),
  registerAssetRoot: vi.fn(() => 'test-token'),
  unregisterAssetRoot: vi.fn()
}))

vi.mock('../export/export-pdf', () => ({
  exportToPdf: vi.fn(async () => Buffer.from('%PDF-1.7 fake'))
}))

import { exportDocumentToPdf } from './pdf-exporter'

// `win` is only ever used for the Save dialog's modality in this module, so a
// bare object is a faithful stand-in -- nothing under test reads it.
const fakeWindow = {} as BrowserWindow

describe('exportDocumentToPdf page geometry', () => {
  let outputDir: string

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'pagedown-pdf-export-test-'))
    mocks.sendDocument.mockClear()
    mocks.setBounds.mockClear()
    mocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(outputDir, 'out.pdf')
    })
  })

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true })
  })

  it('passes real A4 geometry to sendDocument, keeping the export timeout fourth', async () => {
    await exportDocumentToPdf(fakeWindow, '---\npage: A4\n---\n\n# A4 report')

    // Argument POSITION is load-bearing here, not incidental: the export
    // timeout used to be sendDocument's second argument, then its third once
    // geometry was widened in, and Task 5's own documentStyle parameter now
    // sits between them -- so this pins geometry second, documentStyle
    // third, and the 30s export allowance fourth rather than silently
    // letting the timeout land in either preceding slot.
    expect(mocks.sendDocument).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ pageWidthPx: 794, pageHeightPx: 1123 }),
      expect.any(Object),
      30_000
    )
  })

  // A DISTINCT failure mode from the @page rule above, which is why it gets
  // its own assertion: exporting a real A4 document inside a Letter-sized
  // WebContentsView paginates it at the wrong viewport width no matter what
  // the @page rule says.
  it('sizes the harness view to the document geometry, not a fixed Letter box', async () => {
    await exportDocumentToPdf(fakeWindow, '---\npage: A4\n---\n\n# A4 report')

    expect(mocks.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 794, height: 1123 })
  })

  it('falls back to Letter geometry for a document with no frontmatter', async () => {
    await exportDocumentToPdf(fakeWindow, '# Plain document, no frontmatter')

    expect(mocks.sendDocument).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ pageWidthPx: 816, pageHeightPx: 1056 }),
      expect.any(Object),
      30_000
    )
    expect(mocks.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 816, height: 1056 })
  })

  it('keeps the view bounds and the @page geometry in agreement for landscape', async () => {
    await exportDocumentToPdf(fakeWindow, '---\npage: A4\norientation: landscape\n---\n\n# Wide')

    expect(mocks.sendDocument).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ pageWidthPx: 1123, pageHeightPx: 794 }),
      expect.any(Object),
      30_000
    )
    expect(mocks.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1123, height: 794 })
  })
})
