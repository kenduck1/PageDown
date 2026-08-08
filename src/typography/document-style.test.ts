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
