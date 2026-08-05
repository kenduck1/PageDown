import { describe, it, expect } from 'vitest'
import { hashContent } from './thumbnail-generator'

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
