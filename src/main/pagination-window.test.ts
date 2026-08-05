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

  // Pins the path.isAbsolute guard specifically, as distinct from the
  // realpath-confinement check below it. path.join does NOT discard its
  // first argument when a later one is absolute (that's path.resolve's
  // behavior) -- it literally concatenates them and normalizes, so
  // path.join(documentDir, '/figures/chart.png') collapses to the exact
  // same real, in-confinement path as join(documentDir, 'figures',
  // 'chart.png'). That means an absolute relativePath of '/figures/chart.png'
  // would resolve successfully through the realpath-confinement check alone
  // -- the isAbsolute guard is the ONLY thing that denies it. (Verified by
  // deleting the isAbsolute guard and watching this exact test fail -- see
  // the fix report for the RED output. The plain "denies an absolute path"
  // test above does NOT catch the guard's removal: '/etc/passwd' doesn't
  // exist inside documentDir, so realpath denies it either way, guard or
  // not -- this test specifically picks an absolute path that DOES land on
  // a real in-directory file once merged, closing that gap.)
  it('denies an absolute path even when it points inside the document directory', async () => {
    expect(await resolveAssetPath(documentDir, '/figures/chart.png')).toBeNull()
  })

  // "Decode-derived" cases: the protocol handler decodeURIComponent()s the
  // path segment before calling resolveAssetPath, so these embedded-`../`
  // shapes (as opposed to the single leading `../` case above) are real
  // inputs this function sees in practice, not just synthetic test shapes.
  it('denies an embedded ../ traversal that escapes the document directory', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'pagedown-asset-embedded-')))
    try {
      await writeFile(join(outside, 'secret.png'), 'fake-png-bytes')
      // figures/../../<outside-basename>/secret.png: the first `..` cancels
      // `figures/`, landing back at documentDir; the second `..` is the
      // actual escape. This is deliberately NOT the same shape as the
      // single-`../` test above -- it proves the traversal is resolved via
      // real path/realpath semantics rather than special-cased for a
      // leading `../` only.
      const escaping = `figures/../../${basename(outside)}/secret.png`
      expect(await resolveAssetPath(documentDir, escaping)).toBeNull()
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  // The other half of the same proof: an embedded `../` that traverses but
  // stays inside documentDir must still RESOLVE, not be denied. This is
  // what distinguishes real realpath-based confinement from a naive
  // "reject anything containing .." textual ban -- a blanket ban would
  // wrongly deny this legitimate case.
  it('resolves an embedded ../ traversal that stays inside the document directory', async () => {
    const resolved = await resolveAssetPath(documentDir, 'figures/../top-level.png')
    expect(resolved).toBe(join(documentDir, 'top-level.png'))
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

  // Structural guard: a relative documentDir would silently confine assets
  // to wherever the main process's cwd happens to be, not to any real
  // document directory. This is a programming-error guard (the correct
  // behavior for an unsaved/untitled document with no real path is for the
  // caller to never call registerAssetRoot at all), so it throws rather
  // than returning a token that can never resolve.
  it('throws on a relative documentDir', () => {
    expect(() => registerAssetRoot('relative/dir')).toThrow()
  })

  it('throws on an empty documentDir', () => {
    expect(() => registerAssetRoot('')).toThrow()
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
