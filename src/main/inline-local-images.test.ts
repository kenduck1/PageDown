import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// pagination-window.ts imports `WebContentsView`/`BaseWindow`/`session` from
// 'electron' at MODULE SCOPE (for its own harness-construction functions,
// none of which this test ever calls) -- none of that resolves outside a
// real Electron process, so a bare stub is needed just to let the module
// load at all. Deliberately NOT a wholesale `vi.mock('./pagination-window')`
// the way pdf-exporter.test.ts mocks it: THIS test's whole point is
// exercising the REAL resolveAssetPath/sniffImageContentType (the same
// symlink-resolving confinement check and magic-byte sniff the
// pagedown-render://__asset__ protocol handler relies on for its own
// security guarantee) together with this file's new regex-based tag
// scanning, against a real temp directory and real image bytes -- not a
// synthetic double-mock of the very thing being proven safe to reuse.
vi.mock('electron', () => ({
  WebContentsView: class {},
  BaseWindow: class {},
  session: { fromPartition: vi.fn() }
}))

import { inlineLocalImages } from './inline-local-images'

// Real PNG magic bytes (sniffImageContentType checks exactly these 8) plus
// arbitrary filler -- enough for a real, positive image/png sniff without
// needing a structurally valid PNG.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
function fakePngBytes(fillerByte = 0): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    Buffer.from([fillerByte, fillerByte, fillerByte, fillerByte])
  ])
}

describe('inlineLocalImages', () => {
  let documentDir: string

  beforeEach(async () => {
    documentDir = await mkdtemp(join(tmpdir(), 'pagedown-inline-images-test-'))
  })

  afterEach(async () => {
    await rm(documentDir, { recursive: true, force: true })
  })

  it('inlines a real local image as a data: URI', async () => {
    await writeFile(join(documentDir, 'photo.png'), fakePngBytes(1))
    const html = '<p>Look:</p><img src="photo.png" alt="a photo"><p>Done</p>'

    const result = await inlineLocalImages(html, documentDir)

    expect(result).not.toContain('src="photo.png"')
    expect(result).toMatch(/<img src="data:image\/png;base64,[^"]+" alt="a photo">/)
    expect(result).toContain('<p>Look:</p>')
    expect(result).toContain('<p>Done</p>')
  })

  it('leaves an alt attribute containing a literal ">" intact and still finds src correctly', async () => {
    // The real reason this module scans quote-aware rather than with a naive
    // `<img[^>]*>` -- see inline-local-images.ts's own header comment. An
    // `alt` text like "a > b" would otherwise truncate the match before src
    // is ever reached.
    await writeFile(join(documentDir, 'chart.png'), fakePngBytes(2))
    const html = '<img alt="a &gt; b" src="chart.png">'

    const result = await inlineLocalImages(html, documentDir)

    expect(result).toContain('alt="a &gt; b"')
    expect(result).toMatch(/src="data:image\/png;base64,[^"]+"/)
  })

  it('handles multiple distinct local images, each resolved independently', async () => {
    await writeFile(join(documentDir, 'a.png'), fakePngBytes(1))
    await writeFile(join(documentDir, 'b.png'), fakePngBytes(2))
    const html = '<img src="a.png"><img src="b.png">'

    const result = await inlineLocalImages(html, documentDir)
    const matches = [...result.matchAll(/src="(data:image\/png;base64,[^"]+)"/g)].map((m) => m[1])
    expect(matches).toHaveLength(2)
    expect(matches[0]).not.toEqual(matches[1])
  })

  it('inlines a repeated reference to the same image only once (cached by src)', async () => {
    await writeFile(join(documentDir, 'same.png'), fakePngBytes(3))
    const html = '<img src="same.png"><img src="same.png">'

    const result = await inlineLocalImages(html, documentDir)
    const matches = [...result.matchAll(/src="(data:image\/png;base64,[^"]+)"/g)].map((m) => m[1])
    expect(matches).toHaveLength(2)
    expect(matches[0]).toEqual(matches[1])
  })

  it('leaves a missing local image reference untouched rather than throwing', async () => {
    const html = '<img src="does-not-exist.png">'
    const result = await inlineLocalImages(html, documentDir)
    expect(result).toBe(html)
  })

  it('leaves a non-image file untouched -- real magic-byte sniffing, not extension trust', async () => {
    await writeFile(join(documentDir, 'fake.png'), Buffer.from('not actually a png'))
    const html = '<img src="fake.png">'
    const result = await inlineLocalImages(html, documentDir)
    expect(result).toBe(html)
  })

  it('denies a path-traversal escape out of the document directory', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'pagedown-inline-images-outside-'))
    try {
      await writeFile(join(outsideDir, 'secret.png'), fakePngBytes(9))
      const html = '<img src="../../../../etc-equivalent/secret.png">'
      const result = await inlineLocalImages(html, documentDir)
      expect(result).toBe(html)
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('denies a symlink that escapes the document directory (real symlink-resolving confinement)', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'pagedown-inline-images-symlink-target-'))
    try {
      await writeFile(join(outsideDir, 'real.png'), fakePngBytes(4))
      await symlink(join(outsideDir, 'real.png'), join(documentDir, 'link.png'))
      const html = '<img src="link.png">'
      const result = await inlineLocalImages(html, documentDir)
      expect(result).toBe(html)
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('leaves remote (http/https) image srcs untouched -- never treated as local', async () => {
    const html = '<img src="https://example.com/photo.png">'
    const result = await inlineLocalImages(html, documentDir)
    expect(result).toBe(html)
  })

  it('leaves an already-inline data: URI untouched', async () => {
    const html = '<img src="data:image/png;base64,AAAA">'
    const result = await inlineLocalImages(html, documentDir)
    expect(result).toBe(html)
  })

  it('is a no-op with no documentDir (unsaved document -- deny all local assets)', async () => {
    await writeFile(join(documentDir, 'photo.png'), fakePngBytes(5))
    const html = '<img src="photo.png">'
    const result = await inlineLocalImages(html, null)
    expect(result).toBe(html)
  })

  it('resolves a local image nested inside a subdirectory', async () => {
    await mkdir(join(documentDir, 'images'), { recursive: true })
    await writeFile(join(documentDir, 'images', 'nested.png'), fakePngBytes(6))
    const html = '<img src="images/nested.png">'
    const result = await inlineLocalImages(html, documentDir)
    expect(result).toMatch(/src="data:image\/png;base64,[^"]+"/)
  })

  it('is a no-op for HTML with no <img> tags at all', async () => {
    const html = '<p>No images here.</p>'
    const result = await inlineLocalImages(html, documentDir)
    expect(result).toBe(html)
  })
})
