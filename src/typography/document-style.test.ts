import { describe, it, expect } from 'vitest'
import {
  resolveDocumentStyle,
  buildRunningContentCss,
  escapeCssString,
  DEFAULT_DOCUMENT_STYLE
} from './document-style'
import { DEFAULT_PAGE_CONFIG } from '../markdown/page-config'

describe('escapeCssString', () => {
  it('escapes a double quote so it cannot terminate the CSS string', () => {
    expect(escapeCssString('a"b')).toBe('a\\"b')
  })

  it('escapes a backslash before anything else', () => {
    expect(escapeCssString('a\\b')).toBe('a\\\\b')
  })

  it('escapes a newline as a CSS newline escape', () => {
    expect(escapeCssString('a\nb')).toBe('a\\A b')
  })

  // CSS Syntax Module Level 3's input-stream preprocessing step normalizes a
  // lone CR, a lone FF, and a CRLF pair EACH independently to a single LF
  // before the CSS parser ever tokenizes the text -- so all three terminate
  // an unescaped quoted string exactly like the plain `\n` case above, via
  // the same <bad-string-token> mechanism. Reachable in practice: js-yaml
  // resolves an explicit double-quoted YAML escape (`"text\r..."`) into a JS
  // string containing a literal CR, which survives into this function
  // untouched (that's YAML's own escape *resolution*, not its plain/block-
  // scalar line-folding normalization).
  it('escapes a lone carriage return as a CSS newline escape', () => {
    expect(escapeCssString('a\rb')).toBe('a\\A b')
  })

  it('escapes a lone form feed as a CSS newline escape', () => {
    expect(escapeCssString('a\fb')).toBe('a\\A b')
  })

  it('escapes a CRLF pair as a single CSS newline escape', () => {
    expect(escapeCssString('a\r\nb')).toBe('a\\A b')
  })

  it('leaves ordinary text untouched', () => {
    expect(escapeCssString('Page 1 of 2')).toBe('Page 1 of 2')
  })
})

describe('resolveDocumentStyle', () => {
  it('nulls the header when showHeader is false', () => {
    const style = resolveDocumentStyle({
      ...DEFAULT_PAGE_CONFIG,
      showHeader: false,
      header: { left: 'x', center: '', right: '' }
    })
    expect(style.header).toBeNull()
  })

  it('keeps the header when showHeader is true', () => {
    const style = resolveDocumentStyle({
      ...DEFAULT_PAGE_CONFIG,
      showHeader: true,
      header: { left: 'x', center: '', right: '' }
    })
    expect(style.header).toEqual({ left: 'x', center: '', right: '' })
  })

  it('matches DEFAULT_DOCUMENT_STYLE for the default config', () => {
    expect(resolveDocumentStyle(DEFAULT_PAGE_CONFIG)).toEqual(DEFAULT_DOCUMENT_STYLE)
  })
})

describe('buildRunningContentCss', () => {
  it('emits nothing when both header and footer are null', () => {
    const css = buildRunningContentCss({ ...DEFAULT_DOCUMENT_STYLE, header: null, footer: null })
    expect(css.trim()).toBe('')
  })

  it('substitutes page-number tokens as real CSS counters', () => {
    const css = buildRunningContentCss({
      ...DEFAULT_DOCUMENT_STYLE,
      header: null,
      footer: { left: '', center: 'Page {n} of {total}', right: '' }
    })
    expect(css).toContain('@bottom-center')
    expect(css).toContain('content: "Page " counter(page) " of " counter(pages);')
  })

  it('uses lower-roman counters when the format is roman', () => {
    const css = buildRunningContentCss({
      ...DEFAULT_DOCUMENT_STYLE,
      pageNumberFormat: 'roman',
      header: null,
      footer: { left: '', center: '{n}', right: '' }
    })
    expect(css).toContain('counter(page, lower-roman)')
  })

  it('omits a side entirely when its text is empty, so the box stays hidden', () => {
    const css = buildRunningContentCss({
      ...DEFAULT_DOCUMENT_STYLE,
      header: null,
      footer: { left: '', center: 'Middle', right: '' }
    })
    expect(css).not.toContain('@bottom-left')
    expect(css).not.toContain('@bottom-right')
    expect(css).toContain('@bottom-center')
  })

  it('escapes a quote in user text rather than letting it inject CSS', () => {
    // NOTE: this payload's own literal text contains the substring
    // "display: none" -- escaping never removes or alters ordinary letters,
    // so a bare `.not.toContain('display: none')` check (as an earlier draft
    // of this test used) can never distinguish safe from vulnerable output:
    // it's present in the string either way. The real, structural proof is
    // that a break-out closes the CSS string immediately after zero
    // characters (the payload's own leading `"` terminating the string this
    // module opened), which always produces two adjacent, UNESCAPED quotes
    // right where the property's value starts -- `content: ""; } body {...`.
    // Correct escaping can never produce that. The second assertion below
    // pins the exact fully-escaped literal (hand-computed here, not derived
    // by calling escapeCssString again) so the test can't pass merely
    // because its own expectation is equally broken.
    const maliciousText = '"; } body { display: none } @page { @top-left { content: "x'
    const css = buildRunningContentCss({
      ...DEFAULT_DOCUMENT_STYLE,
      header: null,
      footer: { left: '', center: maliciousText, right: '' }
    })
    expect(css).not.toContain('""')
    expect(css).toContain(
      'content: "\\"; } body { display: none } @page { @top-left { content: \\"x";'
    )
  })

  it('handles two adjacent tokens with no literal text between them', () => {
    // Regression coverage for the `if (chunk === '') continue` guard in
    // buildContentValue: splitting '{n}{total}' on the token pattern
    // produces an empty-string chunk between the two matches, which must be
    // skipped rather than emitted as a stray `""`.
    const css = buildRunningContentCss({
      ...DEFAULT_DOCUMENT_STYLE,
      header: null,
      footer: { left: '', center: '{n}{total}', right: '' }
    })
    expect(css).toContain('content: counter(page) counter(pages);')
  })

  it('handles a token at the very start of the text', () => {
    const css = buildRunningContentCss({
      ...DEFAULT_DOCUMENT_STYLE,
      header: null,
      footer: { left: '', center: '{n} of many', right: '' }
    })
    expect(css).toContain('content: counter(page) " of many";')
  })

  it('handles a token at the very end of the text', () => {
    const css = buildRunningContentCss({
      ...DEFAULT_DOCUMENT_STYLE,
      header: null,
      footer: { left: '', center: 'Page {n}', right: '' }
    })
    expect(css).toContain('content: "Page " counter(page);')
  })

  it('leaves an unrecognized brace pattern as inert literal text', () => {
    const css = buildRunningContentCss({
      ...DEFAULT_DOCUMENT_STYLE,
      header: null,
      footer: { left: '', center: '{x} and {n}', right: '' }
    })
    expect(css).toContain('content: "{x} and " counter(page);')
  })

  it('emits header boxes in the top band and footer boxes in the bottom band', () => {
    const css = buildRunningContentCss({
      ...DEFAULT_DOCUMENT_STYLE,
      header: { left: 'HL', center: '', right: '' },
      footer: { left: '', center: '', right: 'FR' }
    })
    expect(css).toContain('@top-left')
    expect(css).toContain('@bottom-right')
  })
})
