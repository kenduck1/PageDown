import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// thumbnail-generator.ts imports `BaseWindow` from 'electron' and builds a
// real sandboxed pagination harness -- neither resolves outside a running
// Electron process, so both are mocked here, following file-io.test.ts's
// established `vi.mock('electron', ...)` precedent. The path actually under
// test (raw document -> frontmatter -> PageConfig -> PageGeometry) runs for
// real; only the Electron/harness/image-capture boundary is faked. The
// on-disk PNG/JSON cache is NOT faked -- these tests write into a real temp
// userData directory, since the cache read/write is what decides whether the
// harness is reached at all.
const mocks = vi.hoisted(() => ({
  setBounds: vi.fn(),
  sendDocument: vi.fn(async () => ({
    pageCount: 2,
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
    view: {
      setBounds: mocks.setBounds,
      webContents: {
        once: vi.fn(),
        // The two-rAF paint wait inside getThumbnail.
        executeJavaScript: vi.fn(async () => undefined),
        capturePage: vi.fn(async () => ({
          isEmpty: (): boolean => false,
          resize: () => ({
            toPNG: (): Buffer => Buffer.from('fake-png-bytes'),
            toDataURL: (): string => 'data:image/png;base64,ZmFrZQ=='
          })
        }))
      }
    },
    sendDocument: mocks.sendDocument
  })),
  registerAssetRoot: vi.fn(() => 'test-token'),
  unregisterAssetRoot: vi.fn()
}))

import { hashContent, getThumbnail } from './thumbnail-generator'

// The sendDocument mock takes no declared parameters (it ignores them and
// returns a fixed result), so Vitest types its recorded call tuple as empty
// and indexing it directly is a compile error. One contained cast here beats
// repeating it at every assertion site.
function geometryFromCall(call: unknown): Record<string, number> {
  return (call as unknown[])[1] as Record<string, number>
}

describe('hashContent', () => {
  it('is deterministic for identical content', () => {
    expect(hashContent('# Hello')).toBe(hashContent('# Hello'))
  })

  it('differs for different content', () => {
    expect(hashContent('# Hello')).not.toBe(hashContent('# Goodbye'))
  })

  it('produces a 64-character lowercase hex string (SHA-256)', () => {
    const hash = hashContent('# Hello')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  // Local-asset loading: identical content in two different directories
  // renders differently (`![x](./figures/chart.png)` resolves to a different
  // image per directory), so the directory has to be part of the cache key or
  // directory B gets served directory A's thumbnail.
  it('differs for identical content in different document directories', () => {
    expect(hashContent('# Hello', '/docs/a')).not.toBe(hashContent('# Hello', '/docs/b'))
  })

  it('is deterministic for identical content in the same document directory', () => {
    expect(hashContent('# Hello', '/docs/a')).toBe(hashContent('# Hello', '/docs/a'))
  })

  it('leaves the no-directory key byte-identical to the content-only hash', () => {
    // Templates and unsaved documents pass no directory -- their existing
    // cached PNGs must keep resolving to the same filename, not silently
    // regenerate.
    expect(hashContent('# Hello', null)).toBe(hashContent('# Hello'))
    expect(hashContent('# Hello', undefined)).toBe(hashContent('# Hello'))
  })

  it('cannot confuse a directory/content pair with a different one by concatenation', () => {
    // The NUL separator is what makes this true -- without it, ('/a', 'b/c')
    // and ('/a/b', 'c') could collide.
    expect(hashContent('b', '/a')).not.toBe(hashContent('', '/ab'))
  })
})

describe('getThumbnail page geometry', () => {
  let userDataDir: string

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'pagedown-thumbnail-test-'))
    mocks.sendDocument.mockClear()
    mocks.setBounds.mockClear()
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('passes real A4 geometry to sendDocument for a `page: A4` document', async () => {
    await getThumbnail('---\npage: A4\n---\n\n# A4 report', userDataDir)

    expect(mocks.sendDocument).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ pageWidthPx: 794, pageHeightPx: 1123 }),
      expect.any(Object)
    )
  })

  it('passes Letter geometry for a document with no frontmatter at all', async () => {
    await getThumbnail('# Plain document, no frontmatter', userDataDir)

    expect(mocks.sendDocument).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ pageWidthPx: 816, pageHeightPx: 1056 }),
      expect.any(Object)
    )
  })

  // A DISTINCT failure mode from the @page rule: capturePage() captures the
  // view's own bounds rectangle, which createPaginationHarness fixes at
  // Letter (816x1056). Without a per-request resize, an A4 page laid out at
  // 794x1123 has its bottom ~67px cropped out of the captured thumbnail even
  // though the @page rule was correct.
  it('sizes the harness view to the document page box before capturing', async () => {
    await getThumbnail('---\npage: A4\n---\n\n# A4 report', userDataDir)

    expect(mocks.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 794, height: 1123 })
  })

  it('sizes the harness view for a landscape document too', async () => {
    await getThumbnail('---\npage: A4\norientation: landscape\n---\n\n# Wide report', userDataDir)

    expect(mocks.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1123, height: 794 })
  })

  // Same NaN trap `resolvePageConfig` closes for every other caller: a
  // document specifying only `page:` has no `margins` key of its own, and an
  // unmerged Partial would read `.top` off `undefined`.
  it('fills unspecified keys from DEFAULT_PAGE_CONFIG rather than emitting NaN', async () => {
    await getThumbnail('---\npage: Legal\n---\n\n# Partial frontmatter only', userDataDir)

    const geometry = geometryFromCall(mocks.sendDocument.mock.calls[0])
    expect(geometry).toMatchObject({
      pageWidthPx: 816,
      pageHeightPx: 1344,
      marginTopPx: 96,
      marginLeftPx: 96
    })
    for (const value of Object.values(geometry)) {
      expect(Number.isNaN(value)).toBe(false)
    }
  })
})
