import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

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

import { inlineLocalImages, resolveDocumentLocalImage } from './inline-local-images'
import { writeRecentFiles } from './recent-files'

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

// ---------------------------------------------------------------------------
// The editor canvas's own local-image path (file:resolveLocalImage).
//
// These are deliberately in THIS file, against the same real temp
// directories, real symlinks and real magic bytes the export path above is
// tested with -- because they exercise the same three guards, and the whole
// architectural argument for the feature is that it REUSES that already-vetted
// read path rather than adding a second one. Testing it against mocks would
// prove the wiring and none of the security.
//
// Each guard below has a test that fails, by name, if that guard alone is
// removed -- mutation-checked, not assumed:
//   * remove the `isKnownPath` line          -> "refuses a document path that is not in the recents allowlist" fails
//   * neuter resolveAssetPath's `..` denial  -> "refuses a `..` traversal out of the document directory" fails
//   * remove the `isRelativeLocalPath` line  -> "refuses an absolute image path" / "...a file: URL" fail
describe('resolveDocumentLocalImage', () => {
  let userDataDir: string
  let documentDir: string
  let documentPath: string

  // Puts `filePath` into the real recent-files.json allowlist the same way a
  // real native Open dialog would -- through the real writeRecentFiles, not a
  // hand-written file -- so "known" here means exactly what isKnownPath means
  // everywhere else in the app.
  async function makeKnown(filePath: string): Promise<void> {
    await writeRecentFiles(userDataDir, [{ filePath, editedAt: new Date().toISOString() }])
  }

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'pagedown-resolve-image-userdata-'))
    documentDir = await mkdtemp(join(tmpdir(), 'pagedown-resolve-image-doc-'))
    documentPath = join(documentDir, 'note.md')
    await writeFile(documentPath, '# note\n')
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
    await rm(documentDir, { recursive: true, force: true })
  })

  it('resolves a real local image next to a known document as a data: URI', async () => {
    await writeFile(join(documentDir, 'photo.png'), fakePngBytes(1))
    await makeKnown(documentPath)

    const result = await resolveDocumentLocalImage(userDataDir, documentPath, 'photo.png')

    expect(result).toMatch(/^data:image\/png;base64,/)
  })

  it('resolves an image in a subdirectory of the document directory', async () => {
    await mkdir(join(documentDir, 'figures'), { recursive: true })
    await writeFile(join(documentDir, 'figures', 'chart.png'), fakePngBytes(2))
    await makeKnown(documentPath)

    const result = await resolveDocumentLocalImage(userDataDir, documentPath, 'figures/chart.png')

    expect(result).toMatch(/^data:image\/png;base64,/)
  })

  it('decodes one layer of percent-encoding so a filename with a space resolves', async () => {
    await writeFile(join(documentDir, 'my photo.png'), fakePngBytes(3))
    await makeKnown(documentPath)

    const result = await resolveDocumentLocalImage(userDataDir, documentPath, 'my%20photo.png')

    expect(result).toMatch(/^data:image\/png;base64,/)
  })

  // GUARD 2 (isKnownPath). The file genuinely exists and is a genuine PNG --
  // the ONLY thing standing between the caller and its bytes is the allowlist
  // check, so this fails the moment that line is removed.
  it('refuses a document path that is not in the recents allowlist', async () => {
    await writeFile(join(documentDir, 'photo.png'), fakePngBytes(4))
    // Deliberately NOT calling makeKnown.

    const result = await resolveDocumentLocalImage(userDataDir, documentPath, 'photo.png')

    expect(result).toBeNull()
  })

  it('refuses once a previously-known document path is removed from the allowlist', async () => {
    await writeFile(join(documentDir, 'photo.png'), fakePngBytes(5))
    await makeKnown(documentPath)
    expect(await resolveDocumentLocalImage(userDataDir, documentPath, 'photo.png')).toMatch(
      /^data:image\/png;base64,/
    )

    // Proves the check is live per call rather than a one-time gate: a path
    // that ages out of the 10-entry recents list stops resolving images.
    await writeRecentFiles(userDataDir, [])

    expect(await resolveDocumentLocalImage(userDataDir, documentPath, 'photo.png')).toBeNull()
  })

  // GUARD 3 (resolveAssetPath's symlink-resolved confinement). Same shape as
  // the export path's own traversal test above, driven through the editor
  // canvas's entry point instead.
  it('refuses a `..` traversal out of the document directory', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'pagedown-resolve-image-outside-'))
    try {
      await writeFile(join(outsideDir, 'secret.png'), fakePngBytes(6))
      await makeKnown(documentPath)

      // A genuinely-resolvable relative path to a genuinely-existing, genuine
      // PNG -- everything except being inside the document's own directory.
      const escape = `../${basename(outsideDir)}/secret.png`
      const result = await resolveDocumentLocalImage(userDataDir, documentPath, escape)

      expect(result).toBeNull()
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('refuses a SYMLINK inside the document directory that points outside it', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'pagedown-resolve-image-symlink-'))
    try {
      await writeFile(join(outsideDir, 'secret.png'), fakePngBytes(7))
      // The case a raw string-prefix confinement check would miss entirely:
      // the unresolved path IS inside documentDir. Only realpath-ing both
      // sides catches it.
      await symlink(join(outsideDir, 'secret.png'), join(documentDir, 'innocent.png'))
      await makeKnown(documentPath)

      const result = await resolveDocumentLocalImage(userDataDir, documentPath, 'innocent.png')

      expect(result).toBeNull()
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  // GUARD 1 (isRelativeLocalPath).
  it('refuses an absolute image path', async () => {
    await writeFile(join(documentDir, 'photo.png'), fakePngBytes(8))
    await makeKnown(documentPath)

    const result = await resolveDocumentLocalImage(
      userDataDir,
      documentPath,
      join(documentDir, 'photo.png')
    )

    expect(result).toBeNull()
  })

  it('refuses a file: URL', async () => {
    await makeKnown(documentPath)
    const result = await resolveDocumentLocalImage(userDataDir, documentPath, 'file:///etc/hosts')
    expect(result).toBeNull()
  })

  // The remote-image consent flag is enforced in pipeline.ts, for every
  // rendering surface. This asserts the editor canvas's own resolver cannot
  // become a way around it: it refuses a remote src outright, so there is no
  // "with consent" branch for it to be missing.
  it('refuses a remote http(s) src, so remote images can never render via this path', async () => {
    await makeKnown(documentPath)
    expect(
      await resolveDocumentLocalImage(userDataDir, documentPath, 'https://example.com/x.png')
    ).toBeNull()
    expect(
      await resolveDocumentLocalImage(userDataDir, documentPath, 'http://example.com/x.png')
    ).toBeNull()
    // Colon-anchored, not `://`-anchored -- `http:evil.com/x.png` is a real,
    // fetchable URL every WHATWG-conformant parser normalizes to
    // `http://evil.com/x.png`. See isRemoteImageSrc's own comment.
    expect(
      await resolveDocumentLocalImage(userDataDir, documentPath, 'http:evil.com/x.png')
    ).toBeNull()
    // Protocol-relative.
    expect(
      await resolveDocumentLocalImage(userDataDir, documentPath, '//evil.com/x.png')
    ).toBeNull()
  })

  it('refuses a null document path (unsaved document -- deny all local assets)', async () => {
    await writeFile(join(documentDir, 'photo.png'), fakePngBytes(9))
    expect(await resolveDocumentLocalImage(userDataDir, null, 'photo.png')).toBeNull()
    expect(await resolveDocumentLocalImage(userDataDir, '', 'photo.png')).toBeNull()
  })

  it('returns null for a missing file rather than throwing', async () => {
    await makeKnown(documentPath)
    await expect(
      resolveDocumentLocalImage(userDataDir, documentPath, 'nope.png')
    ).resolves.toBeNull()
  })

  // Magic-byte sniffing, not extension matching: a text file renamed .png is
  // a real way to try to smuggle non-image bytes into an <img> in the
  // privileged renderer.
  it('returns null for a non-image file wearing a .png extension', async () => {
    await writeFile(join(documentDir, 'fake.png'), 'this is not a png at all')
    await makeKnown(documentPath)

    const result = await resolveDocumentLocalImage(userDataDir, documentPath, 'fake.png')

    expect(result).toBeNull()
  })

  it('returns null for a directory that happens to match the reference', async () => {
    await mkdir(join(documentDir, 'photo.png'), { recursive: true })
    await makeKnown(documentPath)

    const result = await resolveDocumentLocalImage(userDataDir, documentPath, 'photo.png')

    expect(result).toBeNull()
  })
})
