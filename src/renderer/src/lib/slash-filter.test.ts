import { describe, expect, it } from 'vitest'
import { filterSlashItems, type SlashFilterable } from './slash-filter'

interface Item extends SlashFilterable {
  id: string
}

function item(id: string, label: string, keywords: string[] = []): Item {
  return { id, label, keywords }
}

const ITEMS: Item[] = [
  item('h1', 'Heading 1', ['title', 'h1']),
  item('h2', 'Heading 2', ['subtitle', 'h2']),
  item('quote', 'Quote', ['blockquote', 'citation']),
  item('table', 'Table', ['grid', 'spreadsheet']),
  item('bullet', 'Bullet List', ['ul', 'unordered'])
]

describe('filterSlashItems', () => {
  it('returns every item, unchanged in order, for an empty query', () => {
    expect(filterSlashItems(ITEMS, '')).toEqual(ITEMS)
  })

  it('returns a fresh array for an empty query, not the same reference', () => {
    // "Unchanged" describes the CONTENT/order, not object identity -- the
    // caller should be free to treat the result like any other filter
    // output without worrying it aliases the source array.
    expect(filterSlashItems(ITEMS, '')).not.toBe(ITEMS)
  })

  it('ranks a label prefix match above a label substring match', () => {
    // Deliberately a fresh two-item fixture, not ITEMS: this isolates the
    // prefix-vs-substring distinction from keyword matching entirely, so a
    // stray keyword collision elsewhere can't make this test pass for the
    // wrong reason (this happened for real with 'ta' against ITEMS --
    // Quote's own 'citation' keyword also contains 'ta' and would sneak
    // into the result at the keyword rank, one rank below where this test
    // means to draw the line).
    const items = [item('substring-only', 'Rotation'), item('prefix', 'Table')]
    const result = filterSlashItems(items, 'ta')
    expect(result.map((i) => i.id)).toEqual(['prefix', 'substring-only'])
  })

  it('ranks label substring matches above keyword matches', () => {
    const items = [item('keyword-only', 'Zzz', ['uo']), item('substring', 'Quote')]
    // "Quote" contains "uo" as a label substring; the other item matches
    // only via its keyword -- the label substring match must rank first.
    const result = filterSlashItems(items, 'uo')
    expect(result.map((i) => i.id)).toEqual(['substring', 'keyword-only'])
  })

  it('places a label-prefix item before a label-substring item before a keyword-only item', () => {
    const items: Item[] = [
      item('keyword-only', 'Zzz', ['catalog']),
      item('substring', 'Concatenate', []),
      item('prefix', 'Catalog Page', [])
    ]
    // Query "cat": "Catalog Page" is a label PREFIX match; "Concatenate"
    // contains "cat" but doesn't start with it, a label SUBSTRING match;
    // "Zzz" has no label match at all but its own keyword "catalog"
    // contains "cat", a KEYWORD match. All three must appear, in that rank
    // order, regardless of their original array position (the keyword-only
    // item is listed FIRST in `items` above, on purpose).
    const result = filterSlashItems(items, 'cat')
    expect(result.map((i) => i.id)).toEqual(['prefix', 'substring', 'keyword-only'])
  })

  it('matches case-insensitively on both label and keywords', () => {
    expect(filterSlashItems(ITEMS, 'HEAD').map((i) => i.id)).toEqual(['h1', 'h2'])
    expect(filterSlashItems(ITEMS, 'GRID').map((i) => i.id)).toEqual(['table'])
  })

  it('preserves original relative order among items tied at the same rank', () => {
    // "Heading 1" and "Heading 2" both label-prefix-match "heading" -- the
    // one that appeared first in `items` (h1) must still appear first in
    // the result, not reordered by some other criterion (e.g. alphabetical
    // by id, which would put h1 first anyway -- use a deliberately
    // reversed-from-alphabetical fixture to rule that out).
    const items = [item('b', 'Heading B'), item('a', 'Heading A')]
    expect(filterSlashItems(items, 'heading').map((i) => i.id)).toEqual(['b', 'a'])
  })

  it('drops an item that matches neither the label nor any keyword', () => {
    expect(filterSlashItems(ITEMS, 'xyz')).toEqual([])
  })

  it('matches a keyword by substring, not only by prefix', () => {
    // "ordered" is a substring of the "unordered" keyword on Bullet List,
    // not a prefix of it -- keyword matching must use the same
    // substring rule label matching falls back to, not a stricter one.
    expect(filterSlashItems(ITEMS, 'ordered').map((i) => i.id)).toEqual(['bullet'])
  })

  it('returns an empty array, not all items, when the item list itself is empty', () => {
    expect(filterSlashItems([], 'anything')).toEqual([])
  })
})
