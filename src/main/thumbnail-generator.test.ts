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
})
