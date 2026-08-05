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

  // --- Regression: Bug 1 (critical, fix-wave review) ------------------
  // An indented YAML comment immediately following an owned key's own
  // line was previously swallowed as if it were part of that key's value
  // block (the original bug: "any indented line continues the block"),
  // silently deleting the comment on the very next unrelated write.

  it('regression (Bug 1): preserves an indented comment directly beneath a scalar key being rewritten', () => {
    const raw = [
      'title: X',
      'theme: default',
      '  # this indented note describes something else entirely',
      'tags:',
      '  - a',
      'draft: true'
    ].join('\n')

    const result = applyPageConfig(raw, { theme: 'resume' })

    expect(result).toBe(
      [
        'title: X',
        'theme: resume',
        '  # this indented note describes something else entirely',
        'tags:',
        '  - a',
        'draft: true'
      ].join('\n')
    )
  })

  it('regression (Bug 1): preserves an indented comment directly beneath the legacy bare-scalar margins shorthand', () => {
    const raw = ['title: X', 'margins: 1in', '  # a note about margins', 'draft: true'].join('\n')

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
        '  # a note about margins',
        'draft: true'
      ].join('\n')
    )
  })

  it('regression (Bug 1): a comment genuinely interior to a nested block is not left as an orphaned duplicate', () => {
    // A comment *inside* margins' own 4-line block (between two of its
    // sub-lines, not after the whole block) is bounded together with the
    // block per findBlockEnd's documented interior-comment rule -- the
    // important guarantee here is no corruption (no leftover orphaned
    // `bottom:`/`left:`/`right:` lines causing a duplicate-key parse
    // failure), not preservation of that specific interior comment.
    const raw = [
      'margins:',
      '  top: 1',
      '  # a comment about the bottom margin',
      '  bottom: 1',
      '  left: 1',
      '  right: 1',
      'draft: true'
    ].join('\n')

    const result = applyPageConfig(raw, {
      margins: { top: 2, bottom: 2, left: 2, right: 2 }
    })

    expect(() => extractPageConfig(result)).not.toThrow()
    expect(extractPageConfig(result)).toEqual({
      margins: { top: 2, bottom: 2, left: 2, right: 2 }
    })
    // No orphaned/duplicate margin sub-lines left behind.
    expect(result.match(/^\s*(top|bottom|left|right):/gm)).toHaveLength(4)
  })

  // --- Regression: Bug 2 (critical, fix-wave review) -------------------
  // js-yaml accepts `key : value` (whitespace before the colon) as an
  // ordinary key. The original matcher regex required an unspaced `key:`,
  // so an existing `page : Letter` key was never found -- a *second*
  // `page: ...` line got appended instead, producing a duplicate mapping
  // key that js-yaml then refuses to parse at all.

  it('regression (Bug 2): finds and replaces an existing key written with whitespace before the colon, instead of duplicating it', () => {
    const raw = 'page : Letter\ndraft: true'
    const result = applyPageConfig(raw, { pageSize: 'A4' })

    expect(result).toBe('page: A4\ndraft: true')
    // Exactly one `page` mapping key in the output.
    expect(result.match(/^page\s*:/gm)).toHaveLength(1)

    // The previous bug corrupted the block so badly that js-yaml threw on
    // the very next parse (duplicate mapping key), silently reverting
    // every owned key to defaults. Confirm that no longer happens.
    expect(() => extractPageConfig(result)).not.toThrow()
    expect(extractPageConfig(result)).toEqual({ pageSize: 'A4' })
  })

  it('regression (Bug 2): whitespace-before-colon also works for the margins block anchor line', () => {
    const raw = 'margins :\n  top: 1\n  bottom: 1\n  left: 1\n  right: 1\ndraft: true'
    const result = applyPageConfig(raw, {
      margins: { top: 2, bottom: 2, left: 2, right: 2 }
    })

    expect(result).toBe(
      ['margins:', '  top: 2', '  bottom: 2', '  left: 2', '  right: 2', 'draft: true'].join('\n')
    )
    expect(extractPageConfig(result)).toEqual({
      margins: { top: 2, bottom: 2, left: 2, right: 2 }
    })
  })

  // --- Optional (lower priority): multi-line flow-style margins --------

  it('optional: replaces a multi-line flow-style margins value (closing brace on its own unindented line) without leaving an orphaned bracket', () => {
    const raw = [
      'margins: {',
      '  top: 1,',
      '  bottom: 1,',
      '  left: 1,',
      '  right: 1',
      '}',
      'draft: true'
    ].join('\n')

    const result = applyPageConfig(raw, {
      margins: { top: 2, bottom: 2, left: 1.5, right: 1.5 }
    })

    expect(result).toBe(
      ['margins:', '  top: 2', '  bottom: 2', '  left: 1.5', '  right: 1.5', 'draft: true'].join(
        '\n'
      )
    )
    expect(() => extractPageConfig(result)).not.toThrow()
    expect(extractPageConfig(result)).toEqual({
      margins: { top: 2, bottom: 2, left: 1.5, right: 1.5 }
    })
  })

  it('optional: replaces a single-line flow-style margins value in place', () => {
    const raw = 'margins: { top: 1, bottom: 1, left: 1, right: 1 }\ndraft: true'
    const result = applyPageConfig(raw, {
      margins: { top: 2, bottom: 2, left: 2, right: 2 }
    })
    expect(result).toBe(
      ['margins:', '  top: 2', '  bottom: 2', '  left: 2', '  right: 2', 'draft: true'].join('\n')
    )
  })

  // --- Regression: round-3 review (critical) ---------------------------
  // The Bug 1 fix (structural-continuation check) over-corrected: it
  // stopped recognizing a block-scalar's or plain-wrapped scalar's own
  // content lines as part of the preceding key's block (neither looks
  // like `key:` or `- item`), orphaning them on the next write -- a real,
  // reviewer-confirmed corruption bug distinct from Bug 1/Bug 2.

  it('regression (round 3): isolated single-key case -- a block-scalar value is replaced in place with no orphaned lines and no append-vs-replace ambiguity', () => {
    // Using `theme` (which would never legitimately hold a block-scalar
    // value in a real document) specifically to isolate findBlockEnd's
    // block-detection mechanism from the footer-object append-vs-replace
    // behavior exercised by the other round-3 tests below -- a single
    // owned key here, already present, so a correct fix must leave
    // *exactly* one line in that position and nothing orphaned around it.
    const raw = ['title: X', 'theme: |', '  block', '  scalar', '  content', 'draft: true'].join(
      '\n'
    )
    const result = applyPageConfig(raw, { theme: 'resume' })
    expect(result).toBe(['title: X', 'theme: resume', 'draft: true'].join('\n'))
  })

  it('regression (round 3): preserves a block-scalar (`|`) value by replacing its own content lines, not orphaning them', () => {
    const raw = [
      'footerCenter: |',
      '  Some text',
      '  that spans',
      '  multiple lines',
      'draft: true'
    ].join('\n')

    const result = applyPageConfig(raw, {
      footer: { left: '', center: 'new value', right: '' }
    })

    // `footerCenter` already existed (as the block-scalar key), so it's
    // replaced in place, keeping its original position -- `footerLeft`/
    // `footerRight` didn't exist yet, so they're appended at the end, same
    // append-vs-replace-in-place rule already established in round 1. The
    // key assertion for THIS bug is that the block scalar's 3 content
    // lines are fully swallowed (no orphaned `  Some text` etc. lines
    // left dangling before `draft: true`).
    expect(result).toBe(
      ['footerCenter: "new value"', 'draft: true', 'footerLeft: ""', 'footerRight: ""'].join('\n')
    )
    expect(() => extractPageConfig(result)).not.toThrow()
    expect(extractPageConfig(result)).toEqual({
      footer: { left: '', center: 'new value', right: '' }
    })
  })

  it('regression (round 3): preserves a plain multi-line-wrapped scalar value (no `|`/`>` indicator) by replacing its own continuation line, not orphaning it', () => {
    const raw = [
      'footerCenter: this is a long value',
      '  that wraps onto a second physical line',
      'draft: true'
    ].join('\n')

    const result = applyPageConfig(raw, {
      footer: { left: '', center: 'new value', right: '' }
    })

    expect(result).toBe(
      ['footerCenter: "new value"', 'draft: true', 'footerLeft: ""', 'footerRight: ""'].join('\n')
    )
    expect(() => extractPageConfig(result)).not.toThrow()
    expect(extractPageConfig(result)).toEqual({
      footer: { left: '', center: 'new value', right: '' }
    })
  })

  it('regression (round 3): a `>` folded block-scalar value round-trips the same way as `|`', () => {
    const raw = ['footerCenter: >', '  folded', '  text', 'draft: true'].join('\n')
    const result = applyPageConfig(raw, {
      footer: { left: '', center: 'new value', right: '' }
    })
    expect(extractPageConfig(result)).toEqual({
      footer: { left: '', center: 'new value', right: '' }
    })
    expect(result.split('\n')).toEqual([
      'footerCenter: "new value"',
      'draft: true',
      'footerLeft: ""',
      'footerRight: ""'
    ])
  })

  it('regression (round 3): re-confirms Bug 1 is still fixed after the block-scalar/plain-wrap widening (indented comment with nothing structural after it is still preserved)', () => {
    const raw = [
      'title: X',
      'theme: default',
      '  # this indented note describes something else entirely',
      'tags:',
      '  - a',
      'draft: true'
    ].join('\n')

    const result = applyPageConfig(raw, { theme: 'resume' })

    expect(result).toBe(
      [
        'title: X',
        'theme: resume',
        '  # this indented note describes something else entirely',
        'tags:',
        '  - a',
        'draft: true'
      ].join('\n')
    )
  })

  it('regression (round 3): re-confirms Bug 2 is still fixed after the block-scalar/plain-wrap widening (space before colon still found and replaced, not duplicated)', () => {
    const raw = 'page : Letter\ndraft: true'
    const result = applyPageConfig(raw, { pageSize: 'A4' })
    expect(result).toBe('page: A4\ndraft: true')
    expect(() => extractPageConfig(result)).not.toThrow()
    expect(extractPageConfig(result)).toEqual({ pageSize: 'A4' })
  })
})
