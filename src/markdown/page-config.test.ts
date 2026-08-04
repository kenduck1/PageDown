import { describe, it, expect } from 'vitest'
import {
  extractPageConfig,
  applyPageConfig,
  DEFAULT_PAGE_CONFIG,
  type PageConfig
} from './page-config'

const FULL_CONFIG: PageConfig = {
  pageSize: 'A4',
  orientation: 'landscape',
  margins: { top: 0.5, bottom: 0.75, left: 1, right: 1.25 },
  showHeader: true,
  showFooter: true,
  footer: { left: 'Confidential', center: 'Page {n} of {total}', right: 'Acme Corp' },
  pageNumberFormat: 'roman',
  theme: 'report'
}

const FULL_RAW = [
  'page: A4',
  'orientation: landscape',
  'margins:',
  '  top: 0.5',
  '  bottom: 0.75',
  '  left: 1',
  '  right: 1.25',
  'header: true',
  'footer: true',
  'footerLeft: "Confidential"',
  'footerCenter: "Page {n} of {total}"',
  'footerRight: "Acme Corp"',
  'pageNumberFormat: roman',
  'theme: report'
].join('\n')

describe('extractPageConfig', () => {
  it('returns {} for an empty string', () => {
    expect(extractPageConfig('')).toEqual({})
  })

  it('returns {} when only unrelated (non-owned) keys are present', () => {
    const raw = ['title: My Doc', 'tags:', '  - a', '  - b', 'draft: true'].join('\n')
    expect(extractPageConfig(raw)).toEqual({})
  })

  it('extracts a fully populated, well-formed block exactly', () => {
    expect(extractPageConfig(FULL_RAW)).toEqual(FULL_CONFIG)
  })

  it('ignores unrelated keys mixed in alongside owned ones', () => {
    const raw = ['title: My Doc', 'page: Letter', 'tags:', '  - x', 'draft: true'].join('\n')
    expect(extractPageConfig(raw)).toEqual({ pageSize: 'Letter' })
  })

  it('falls back to {} (never throws) on syntactically malformed YAML', () => {
    const raw = 'page: Letter\n  - this is not valid: [unclosed'
    expect(() => extractPageConfig(raw)).not.toThrow()
    expect(extractPageConfig(raw)).toEqual({})
  })

  it('omits a key whose value is present but not a recognized enum member', () => {
    const raw = ['page: Tabloid', 'theme: default'].join('\n')
    expect(extractPageConfig(raw)).toEqual({ theme: 'default' })
  })

  it('omits a key whose value has the wrong type entirely', () => {
    const raw = ['page: 42', 'orientation: true', 'theme: default'].join('\n')
    expect(extractPageConfig(raw)).toEqual({ theme: 'default' })
  })

  it('omits header/footer booleans given as non-boolean values', () => {
    const raw = ['header: "yes"', 'footer: 1'].join('\n')
    expect(extractPageConfig(raw)).toEqual({})
  })

  it('omits margins entirely if the object is missing a side', () => {
    const raw = ['margins:', '  top: 1', '  bottom: 1', '  left: 1'].join('\n')
    expect(extractPageConfig(raw)).toEqual({})
  })

  it('omits margins entirely if a side is non-numeric', () => {
    const raw = ['margins:', '  top: 1', '  bottom: 1', '  left: 1', '  right: wide'].join('\n')
    expect(extractPageConfig(raw)).toEqual({})
  })

  it('tolerates the legacy bare-scalar "margins: 1in" shorthand as a uniform margin', () => {
    expect(extractPageConfig('margins: 1in')).toEqual({
      margins: { top: 1, bottom: 1, left: 1, right: 1 }
    })
  })

  it('tolerates a legacy bare-scalar margins value with a fraction and no unit', () => {
    expect(extractPageConfig('margins: 0.5')).toEqual({
      margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
    })
  })

  it('merges partial footer keys with defaults for the missing ones', () => {
    const raw = 'footerCenter: "Custom center"'
    expect(extractPageConfig(raw)).toEqual({
      footer: {
        left: DEFAULT_PAGE_CONFIG.footer.left,
        center: 'Custom center',
        right: DEFAULT_PAGE_CONFIG.footer.right
      }
    })
  })

  it('does not populate footer at all when none of the three footer text keys are present', () => {
    const raw = 'footer: true'
    const result = extractPageConfig(raw)
    expect(result.showFooter).toBe(true)
    expect(result.footer).toBeUndefined()
  })

  it('adversarial: correctly extracts a quoted string value containing a colon and a literal "---"', () => {
    const raw = 'footerCenter: "Confidential: Draft --- v2"'
    expect(extractPageConfig(raw)).toEqual({
      footer: {
        left: DEFAULT_PAGE_CONFIG.footer.left,
        center: 'Confidential: Draft --- v2',
        right: DEFAULT_PAGE_CONFIG.footer.right
      }
    })
  })

  it("does not confuse a foreign tool's nested key of the same name with an owned top-level key", () => {
    // `page:` here is indented under someone else's `customField:` mapping,
    // not a top-level key PageDown owns.
    const raw = ['customField:', '  page: NotOurs', 'theme: default'].join('\n')
    expect(extractPageConfig(raw)).toEqual({ theme: 'default' })
  })
})

describe('applyPageConfig', () => {
  it('is a no-op (returns input unchanged) when updates is empty', () => {
    const raw = 'title: X\npage: Letter'
    expect(applyPageConfig(raw, {})).toBe(raw)
  })

  it('round-trips a full config written into an empty (no-frontmatter) document', () => {
    const written = applyPageConfig('', FULL_CONFIG)
    expect(extractPageConfig(written)).toEqual(FULL_CONFIG)
  })

  it('produces the documented canonical format for a brand-new frontmatter block', () => {
    expect(applyPageConfig('', FULL_CONFIG)).toBe(FULL_RAW)
  })

  it('replaces an existing scalar key in place without disturbing surrounding lines', () => {
    const raw = ['title: My Document', 'page: A4', 'draft: true'].join('\n')
    const result = applyPageConfig(raw, { pageSize: 'Letter' })
    expect(result).toBe(['title: My Document', 'page: Letter', 'draft: true'].join('\n'))
  })

  it('preserves unrelated keys, comments, and key order exactly while updating owned keys', () => {
    const raw = [
      'title: My Document',
      '# a comment about tags',
      'tags:',
      '  - foo',
      '  - bar',
      'page: A4',
      'draft: true'
    ].join('\n')

    const result = applyPageConfig(raw, { pageSize: 'Letter', showFooter: false })

    expect(result).toBe(
      [
        'title: My Document',
        '# a comment about tags',
        'tags:',
        '  - foo',
        '  - bar',
        'page: Letter',
        'draft: true',
        'footer: false'
      ].join('\n')
    )
  })

  it('replaces an existing nested margins block in place', () => {
    const raw = [
      'title: X',
      'margins:',
      '  top: 1',
      '  bottom: 1',
      '  left: 1',
      '  right: 1',
      'draft: false'
    ].join('\n')
    const result = applyPageConfig(raw, {
      margins: { top: 2, bottom: 2, left: 1.5, right: 1.5 }
    })
    expect(result).toBe(
      [
        'title: X',
        'margins:',
        '  top: 2',
        '  bottom: 2',
        '  left: 1.5',
        '  right: 1.5',
        'draft: false'
      ].join('\n')
    )
  })

  it('upgrades the legacy bare-scalar margins shorthand into the structured block in place', () => {
    const raw = ['title: X', 'margins: 1in', 'draft: false'].join('\n')
    const result = applyPageConfig(raw, {
      margins: { top: 1, bottom: 1, left: 1, right: 1 }
    })
    expect(result).toBe(
      [
        'title: X',
        'margins:',
        '  top: 1',
        '  bottom: 1',
        '  left: 1',
        '  right: 1',
        'draft: false'
      ].join('\n')
    )
  })

  it('appends missing keys at the end in canonical field order', () => {
    const raw = 'title: X'
    const result = applyPageConfig(raw, { theme: 'resume', pageSize: 'Legal' })
    expect(result).toBe(['title: X', 'page: Legal', 'theme: resume'].join('\n'))
  })

  it('preserves a trailing newline if the input had one', () => {
    const raw = 'page: A4\n'
    const result = applyPageConfig(raw, { pageSize: 'Letter' })
    expect(result).toBe('page: Letter\n')
  })

  it('does not introduce a trailing newline if the input had none', () => {
    const raw = 'page: A4'
    const result = applyPageConfig(raw, { pageSize: 'Letter' })
    expect(result).toBe('page: Letter')
    expect(result.endsWith('\n')).toBe(false)
  })

  it('applying a partial update only touches the keys included in the update (round trip)', () => {
    const raw = applyPageConfig('', DEFAULT_PAGE_CONFIG)
    const updated = applyPageConfig(raw, { theme: 'letter' })
    const extracted = extractPageConfig(updated)
    expect(extracted).toEqual({ ...DEFAULT_PAGE_CONFIG, theme: 'letter' })
  })

  it('does not touch a foreign nested key of the same name as an owned key', () => {
    const raw = ['customField:', '  page: NotOurs', 'draft: true'].join('\n')
    const result = applyPageConfig(raw, { pageSize: 'Letter' })
    expect(result).toBe(
      ['customField:', '  page: NotOurs', 'draft: true', 'page: Letter'].join('\n')
    )
  })

  it('adversarial: writes a footer value containing a colon and a literal "---" as a properly quoted scalar, and round-trips it exactly', () => {
    const trickyValue = 'Section: Notes --- Draft --- v2'
    const raw = applyPageConfig('', {
      footer: { left: '', center: trickyValue, right: '' }
    })

    // Must be quoted -- an unquoted `footerCenter: Section: Notes --- ...`
    // would be invalid/ambiguous YAML (an unescaped colon inside a plain
    // scalar). `footer` is one PageConfig field, so all three footer
    // sub-keys are written together.
    expect(raw).toBe(
      ['footerLeft: ""', `footerCenter: ${JSON.stringify(trickyValue)}`, 'footerRight: ""'].join(
        '\n'
      )
    )

    // And it must parse back out to the exact original string, not get
    // split into a second YAML document or truncated at the embedded
    // colon/dashes.
    expect(extractPageConfig(raw)).toEqual({
      footer: { left: '', center: trickyValue, right: '' }
    })
  })

  it('adversarial: a value containing a literal double quote round-trips correctly', () => {
    const trickyValue = 'She said "hello" to me'
    const raw = applyPageConfig('', { footer: { left: trickyValue, center: '', right: '' } })
    expect(extractPageConfig(raw)).toEqual({
      footer: { left: trickyValue, center: '', right: '' }
    })
  })
})
