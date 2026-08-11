import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

// Only `dialog` is mocked. The REAL local-image read path
// (inline-local-images.ts -> pagination-window.ts's resolveAssetPath /
// sniffImageContentType) runs against a real temp directory with real image
// bytes, deliberately -- following inline-local-images.test.ts's own precedent
// and for the same reason: the security claim this exporter makes is "it reuses
// the vetted read path rather than adding a second one", and mocking that path
// away would test everything except the claim. pagination-window.ts's own
// module-scope electron imports still need a bare stub to let it load outside
// a real Electron process.
vi.mock('electron', () => ({
  dialog: { showSaveDialog: vi.fn() },
  WebContentsView: class {},
  BaseWindow: class {},
  session: { fromPartition: vi.fn() }
}))

import { dialog, type BrowserWindow } from 'electron'
import { exportDocumentToDocx } from './docx-exporter'
import { listDocxEntries, readDocxEntry, readDocxDocumentXml } from '../export/docx-zip'

const showSaveDialog = vi.mocked(dialog.showSaveDialog)
// The exporter only ever passes this straight to dialog.showSaveDialog, which
// is mocked -- nothing here dereferences it.
const fakeWindow = {} as BrowserWindow

// A real, structurally valid PNG of a stated size. Built rather than committed
// so the dimensions the assertions depend on are visible next to them.
function realPng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (bytes: Buffer): number => {
    let c = 0xffffffff
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const idat = Buffer.concat([
    Buffer.from([0x78, 0x01]),
    deflateRawSync(Buffer.alloc(height * (1 + width * 3))),
    Buffer.alloc(4)
  ])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ])
}

describe('exportDocumentToDocx', () => {
  let workDir: string
  let outPath: string

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'pagedown-docx-export-test-'))
    outPath = join(workDir, 'out.docx')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: outPath })
  })

  afterEach(async () => {
    vi.clearAllMocks()
    await rm(workDir, { recursive: true, force: true })
  })

  it('writes a real .docx to the path the Save dialog returned', async () => {
    const result = await exportDocumentToDocx(fakeWindow, '# Title\n\nBody.\n')

    expect(result).toEqual({ filePath: outPath })
    const written = await readFile(outPath)
    expect(written.subarray(0, 2).toString('latin1')).toBe('PK')
    expect(listDocxEntries(written)).toContain('word/document.xml')
    expect(readDocxDocumentXml(written)).toContain('Title')
  })

  it('offers a .docx filter and a sensible default filename', async () => {
    await exportDocumentToDocx(fakeWindow, 'Hi\n')
    expect(showSaveDialog).toHaveBeenCalledWith(
      fakeWindow,
      expect.objectContaining({
        defaultPath: 'document.docx',
        filters: [{ name: 'Word Document', extensions: ['docx'] }]
      })
    )
  })

  it('writes nothing and resolves null when the dialog is cancelled', async () => {
    // Electron's own SaveDialogReturnValue types `filePath` as a plain string,
    // so a cancel is expressed by the flag plus an empty path -- which is also
    // exactly what the exporter's `result.canceled || !result.filePath` guard
    // reads.
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' })
    expect(await exportDocumentToDocx(fakeWindow, '# Title\n')).toBeNull()
    await expect(readFile(outPath)).rejects.toThrow()
  })

  it('embeds a local image that sits beside the document', async () => {
    const documentPath = join(workDir, 'doc.md')
    await writeFile(documentPath, '')
    await writeFile(join(workDir, 'shot.png'), realPng(300, 150))

    await exportDocumentToDocx(fakeWindow, '![a shot](shot.png)\n', documentPath)

    const written = await readFile(outPath)
    expect(listDocxEntries(written).some((name) => name.startsWith('word/media/'))).toBe(true)
    // 300x150 fits inside the 624px Letter content box, so it stays at its
    // natural size -- 9525 EMU per CSS pixel.
    expect(readDocxDocumentXml(written)).toContain(`cx="${300 * 9525}"`)
  })

  it('resolves images relative to the DOCUMENT, not the process working directory', async () => {
    const nested = join(workDir, 'chapters')
    await mkdir(nested)
    await writeFile(join(nested, 'doc.md'), '')
    await writeFile(join(nested, 'fig.png'), realPng(80, 40))

    await exportDocumentToDocx(fakeWindow, '![fig](fig.png)\n', join(nested, 'doc.md'))

    expect(listDocxEntries(await readFile(outPath)).some((n) => n.startsWith('word/media/'))).toBe(
      true
    )
  })

  it('refuses an image that escapes the document directory via ..', async () => {
    // resolveAssetPath's own confinement check, reached through this exporter
    // rather than re-implemented by it. The target genuinely EXISTS and is a
    // genuinely valid PNG -- so the only reason it does not get embedded is the
    // confinement check itself, not a failed read that would have failed
    // anyway. The reference degrades to alt text.
    await writeFile(join(workDir, 'secret.png'), realPng(10, 10))
    const documentDir = join(workDir, 'sub')
    await mkdir(documentDir)
    const documentPath = join(documentDir, 'doc.md')
    await writeFile(documentPath, '')

    await exportDocumentToDocx(fakeWindow, '![leak](../secret.png)\n', documentPath)

    const written = await readFile(outPath)
    expect(listDocxEntries(written).some((name) => name.startsWith('word/media/'))).toBe(false)
    expect(readDocxDocumentXml(written)).toContain('leak')
  })

  it('refuses a symlink pointing outside the document directory', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'pagedown-docx-symlink-'))
    try {
      const realTarget = join(outsideDir, 'private.png')
      await writeFile(realTarget, realPng(10, 10))
      const documentPath = join(workDir, 'doc.md')
      await writeFile(documentPath, '')
      await symlink(realTarget, join(workDir, 'looks-local.png'))

      await exportDocumentToDocx(fakeWindow, '![x](looks-local.png)\n', documentPath)

      expect(
        listDocxEntries(await readFile(outPath)).some((name) => name.startsWith('word/media/'))
      ).toBe(false)
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('embeds no local image at all for a document with no validated path', async () => {
    // "Deny all local assets until saved" -- the same posture every other
    // surface takes for an unsaved document.
    await writeFile(join(workDir, 'shot.png'), realPng(300, 150))
    await exportDocumentToDocx(fakeWindow, '![a shot](shot.png)\n')

    const written = await readFile(outPath)
    expect(listDocxEntries(written).some((name) => name.startsWith('word/media/'))).toBe(false)
    expect(readDocxDocumentXml(written)).toContain('a shot')
  })

  it('skips a format docx cannot embed without failing the export', async () => {
    // A real WebP passes sniffImageContentType (every other surface renders it
    // fine) but has no ImageRun representation, so it must degrade to alt text
    // rather than being written as bytes Word would reject.
    const documentPath = join(workDir, 'doc.md')
    await writeFile(documentPath, '')
    await writeFile(
      join(workDir, 'pic.webp'),
      Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
        0x4c
      ])
    )

    const result = await exportDocumentToDocx(fakeWindow, '![webp alt](pic.webp)\n', documentPath)

    expect(result).toEqual({ filePath: outPath })
    const written = await readFile(outPath)
    expect(listDocxEntries(written).some((name) => name.startsWith('word/media/'))).toBe(false)
    expect(readDocxDocumentXml(written)).toContain('webp alt')
  })

  it('never fetches a remote image, with or without consent', async () => {
    const withConsent = '![remote](https://cdn.example/x.png)\n'
    await exportDocumentToDocx(fakeWindow, withConsent, undefined, true)
    const written = await readFile(outPath)
    expect(listDocxEntries(written).some((name) => name.startsWith('word/media/'))).toBe(false)
    // With consent it becomes a link the reader can follow deliberately.
    expect(readDocxDocumentXml(written)).toContain('<w:hyperlink')
  })

  it('titles the document from its own filename, extension stripped', async () => {
    const documentPath = join(workDir, 'Quarterly Report.md')
    await writeFile(documentPath, '')
    await exportDocumentToDocx(fakeWindow, 'Hi\n', documentPath)

    const core = readDocxEntry(await readFile(outPath), 'docProps/core.xml')?.toString('utf8') ?? ''
    expect(core).toContain('<dc:title>Quarterly Report</dc:title>')
  })
})
