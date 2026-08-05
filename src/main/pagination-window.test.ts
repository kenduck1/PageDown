import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import {
  resolveAssetPath,
  registerAssetRoot,
  unregisterAssetRoot,
  sniffImageContentType
} from './pagination-window'

describe('resolveAssetPath', () => {
  let documentDir: string

  beforeEach(async () => {
    // realpath() the freshly-created temp dir immediately: on macOS,
    // os.tmpdir() returns a path under /var/folders/..., which is itself a
    // symlink to /private/var/folders/... -- so the raw mkdtemp() result is
    // NOT its own realpath. resolveAssetPath() returns the symlink-resolved
    // realpath (that's the whole point of the confinement check), so
    // asserting the exact-path equalities below against the raw mkdtemp
    // path would fail on macOS for a reason that has nothing to do with the
    // security property under test. realpath-ing here keeps every assertion
    // below a genuine, byte-for-byte "did confinement return the right
    // path" check.
    documentDir = await realpath(await mkdtemp(join(tmpdir(), 'pagedown-asset-test-')))
    await mkdir(join(documentDir, 'figures'), { recursive: true })
    await writeFile(join(documentDir, 'figures', 'chart.png'), 'fake-png-bytes')
    await writeFile(join(documentDir, 'top-level.png'), 'fake-png-bytes')
  })

  afterEach(async () => {
    await rm(documentDir, { recursive: true, force: true })
  })

  it('resolves a real relative path inside the document directory', async () => {
    const resolved = await resolveAssetPath(documentDir, 'figures/chart.png')
    expect(resolved).toBe(join(documentDir, 'figures', 'chart.png'))
  })

  it('resolves a top-level relative path', async () => {
    const resolved = await resolveAssetPath(documentDir, 'top-level.png')
    expect(resolved).toBe(join(documentDir, 'top-level.png'))
  })

  it('denies a path that does not exist', async () => {
    expect(await resolveAssetPath(documentDir, 'figures/missing.png')).toBeNull()
  })

  it('denies an absolute path', async () => {
    expect(await resolveAssetPath(documentDir, '/etc/passwd')).toBeNull()
  })

  it('denies a ../ traversal that escapes the document directory', async () => {
    // Simplest, unambiguous traversal case: documentDir and `outside` are
    // both direct children of the same tmpdir, so one `../<outside-basename>`
    // walks out of documentDir and back down into the sibling.
    // Same macOS /var -> /private/var reasoning as above: realpath() this
    // one too, so `basename(outside)` and any later comparison are stable.
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'pagedown-asset-outside-')))
    try {
      await writeFile(join(outside, 'secret.png'), 'fake-png-bytes')
      const escaping = `../${basename(outside)}/secret.png`
      expect(await resolveAssetPath(documentDir, escaping)).toBeNull()
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('denies a symlink inside the document directory that points outside it', async () => {
    // Same macOS /var -> /private/var reasoning as above.
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'pagedown-asset-symlink-target-')))
    try {
      await writeFile(join(outside, 'secret.png'), 'fake-png-bytes')
      await symlink(join(outside, 'secret.png'), join(documentDir, 'evil-link.png'))
      expect(await resolveAssetPath(documentDir, 'evil-link.png')).toBeNull()
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('allows a symlink inside the document directory that points to another file still inside it', async () => {
    await symlink(join(documentDir, 'top-level.png'), join(documentDir, 'internal-link.png'))
    const resolved = await resolveAssetPath(documentDir, 'internal-link.png')
    expect(resolved).toBe(join(documentDir, 'top-level.png'))
  })
})

describe('registerAssetRoot / unregisterAssetRoot', () => {
  it('unregisterAssetRoot on an unknown token is a harmless no-op', () => {
    expect(() => unregisterAssetRoot('does-not-exist')).not.toThrow()
  })

  it('registerAssetRoot returns a 32-character hex token (randomBytes(16).toString("hex"))', () => {
    const token = registerAssetRoot('/some/document/dir')
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    unregisterAssetRoot(token)
  })

  it('registerAssetRoot generates a distinct token on every call, even for the same documentDir', () => {
    const tokenA = registerAssetRoot('/some/document/dir')
    const tokenB = registerAssetRoot('/some/document/dir')
    expect(tokenA).not.toBe(tokenB)
    unregisterAssetRoot(tokenA)
    unregisterAssetRoot(tokenB)
  })
})

describe('sniffImageContentType', () => {
  it('accepts real PNG magic bytes', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
    expect(sniffImageContentType(png)).toBe('image/png')
  })

  it('rejects a plain-text buffer with no image magic bytes', () => {
    expect(sniffImageContentType(Buffer.from('just some text, not an image'))).toBeNull()
  })

  // The specific attack this guards against: extension-based acceptance
  // would defeat the whole point of sniffing. A file literally named
  // "fake.png" on disk, containing ordinary text, must still be rejected
  // once its real bytes are inspected -- resolveAssetPath (which only
  // checks path confinement, not content) happily resolves it, so
  // sniffImageContentType is the only thing standing between this file and
  // being served as image/png.
  it('rejects a real file named .png on disk whose content is not actually an image', async () => {
    const documentDir = await realpath(await mkdtemp(join(tmpdir(), 'pagedown-asset-sniff-')))
    try {
      const fakePath = join(documentDir, 'fake.png')
      await writeFile(fakePath, 'this is not a real image, just text pretending to be one')

      const resolved = await resolveAssetPath(documentDir, 'fake.png')
      expect(resolved).toBe(fakePath) // path confinement alone lets this through

      const bytes = await readFile(resolved!)
      expect(sniffImageContentType(bytes)).toBeNull() // content sniffing is what actually rejects it
    } finally {
      await rm(documentDir, { recursive: true, force: true })
    }
  })
})
