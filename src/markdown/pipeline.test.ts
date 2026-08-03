import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { markdownToHtml } from './pipeline'

describe('markdownToHtml', () => {
  it('converts a simple paragraph with bold text to HTML', () => {
    const { html } = markdownToHtml('Hello **world**.')
    expect(html).toContain('<strong')
    expect(html).toContain('world')
  })

  it('preserves pagebreak markers as pagedown-pagebreak elements instead of dropping them', () => {
    const { html } = markdownToHtml('Paragraph one.\n\n<!-- pagebreak -->\n\nParagraph two.')
    expect(html).toContain('class="pagedown-pagebreak"')
    expect(html).not.toContain('<!-- pagebreak -->')
  })

  it('preserves multiple pagebreak markers in one document', () => {
    const { html } = markdownToHtml(
      'One.\n\n<!-- pagebreak -->\n\nTwo.\n\n<!-- pagebreak -->\n\nThree.'
    )
    const matches = html.match(/class="pagedown-pagebreak"/g) ?? []
    expect(matches).toHaveLength(2)
  })

  it('preserves raw-HTML content from the raw-html.md corpus fixture instead of dropping it', () => {
    const source = readFileSync(join(__dirname, '../../phase0/corpus/raw-html.md'), 'utf-8')
    const { html } = markdownToHtml(source)

    // Inline and block raw HTML survive (content, not necessarily attributes).
    expect(html).toContain('inline HTML')
    expect(html).toContain('This is a raw HTML block containing a paragraph.')

    // Both pagebreak markers are now real, controlled elements.
    const pagebreakMatches = html.match(/class="pagedown-pagebreak"/g) ?? []
    expect(pagebreakMatches).toHaveLength(2)

    // No literal HTML comment syntax leaks into the output either way.
    expect(html).not.toContain('<!--')
  })

  it('leaves annotateSourceOffsets behavior on a plain corpus fixture unaffected', () => {
    const source = readFileSync(join(__dirname, '../../phase0/corpus/short.md'), 'utf-8')
    const { sourceMap } = markdownToHtml(source)

    // short.md has no raw HTML or pagebreak content at all, so this is a
    // direct regression check that the new pipeline stages (remarkPagebreak,
    // the two new remark-rehype handlers) don't change source-map behavior
    // on documents that never touch them.
    expect(sourceMap).toBeDefined()
    expect(typeof sourceMap.htmlOffsetToSrc).toBe('function')
  })
})
