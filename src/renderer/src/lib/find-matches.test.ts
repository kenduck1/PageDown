import { describe, expect, it } from 'vitest'
import { findMatches, MAX_MATCHES, type FindOptions } from './find-matches'

const PLAIN: FindOptions = { caseSensitive: false, wholeWord: false }
const CASED: FindOptions = { caseSensitive: true, wholeWord: false }
const WORDS: FindOptions = { caseSensitive: false, wholeWord: true }

describe('findMatches', () => {
  it('returns no matches for an empty query', () => {
    expect(findMatches('hello world', '', PLAIN)).toEqual([])
  })

  it('finds every occurrence with correct offsets', () => {
    expect(findMatches('cat scat cat', 'cat', PLAIN)).toEqual([
      { from: 0, to: 3 },
      { from: 5, to: 8 },
      { from: 9, to: 12 }
    ])
  })

  it('does not return overlapping matches', () => {
    expect(findMatches('aaaa', 'aa', PLAIN)).toEqual([
      { from: 0, to: 2 },
      { from: 2, to: 4 }
    ])
  })

  it('is case-insensitive by default and case-sensitive when asked', () => {
    expect(findMatches('Cat cat', 'cat', PLAIN)).toHaveLength(2)
    expect(findMatches('Cat cat', 'cat', CASED)).toEqual([{ from: 4, to: 7 }])
  })

  // The reason this engine uses RegExp rather than
  // haystack.toLowerCase().indexOf(needle.toLowerCase()): 'İ' (U+0130)
  // lowercases to TWO UTF-16 units, so a lowercase-both implementation
  // reports every subsequent match at an offset shifted by one, and the
  // highlight/replace lands on the wrong text. Matching against the ORIGINAL
  // string keeps all offsets in the original coordinate space.
  it('keeps offsets in the original string when case-folding changes length', () => {
    const text = 'İstanbul cat'
    expect(findMatches(text, 'cat', PLAIN)).toEqual([{ from: 9, to: 12 }])
    expect(text.slice(9, 12)).toBe('cat')
  })

  it('treats regex metacharacters in the query as literals', () => {
    expect(findMatches('axb a.b', 'a.b', PLAIN)).toEqual([{ from: 4, to: 7 }])
    expect(findMatches('aaa', 'a*', PLAIN)).toEqual([])
    expect(findMatches('a[b]c', '[b]', PLAIN)).toEqual([{ from: 1, to: 4 }])
  })

  it('respects whole-word boundaries', () => {
    expect(findMatches('cat cats concat cat.', 'cat', WORDS)).toEqual([
      { from: 0, to: 3 },
      { from: 16, to: 19 }
    ])
  })

  // \b is defined over [A-Za-z0-9_] only, so a \b-based implementation would
  // wrongly report the 'café' inside 'cafés' as a whole word. The boundary
  // check is Unicode-aware instead.
  it('treats accented letters as word characters for whole-word matching', () => {
    expect(findMatches('café cafés', 'café', WORDS)).toEqual([{ from: 0, to: 4 }])
  })

  it('caps the number of matches returned', () => {
    const text = 'a'.repeat(MAX_MATCHES + 500)
    expect(findMatches(text, 'a', PLAIN)).toHaveLength(MAX_MATCHES)
  })
})
