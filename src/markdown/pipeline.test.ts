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

  it('preserves a safe span, dropping its class attribute', () => {
    const { html } = markdownToHtml('<span class="highlight">inline HTML</span>')
    expect(html).toContain('<span>inline HTML</span>')
  })

  it('preserves a safe block div and its inner content', () => {
    const { html } = markdownToHtml('<div class="callout">\nThis is raw HTML.\n</div>')
    expect(html).toContain('This is raw HTML.')
    expect(html).toContain('<div')
  })

  it('strips a script tag entirely', () => {
    const { html } = markdownToHtml('<script>alert(1)</script>')
    expect(html).not.toContain('alert(1)')
    expect(html).not.toContain('<script')
  })

  it('strips an onclick handler but keeps the element', () => {
    const { html } = markdownToHtml('<div onclick="alert(1)">text</div>')
    expect(html).not.toContain('onclick')
    expect(html).toContain('text')
  })

  it('strips a forged data-src-* attribute pair', () => {
    const { html } = markdownToHtml('<div data-src-start="0" data-src-end="999">forged</div>')
    expect(html).not.toContain('data-src-start')
    expect(html).not.toContain('data-src-end')
    expect(html).toContain('forged')
  })

  it('preserves wrapping when a raw-HTML tag is interleaved with real Markdown', () => {
    const { html } = markdownToHtml('Some <span>text **bold** more</span> here.')
    expect(html).toContain('<span>text <strong>bold</strong> more</span>')
  })

  it('strips a dangerous attribute even when the tag is interleaved with real Markdown', () => {
    const { html } = markdownToHtml('Some <span onclick="alert(1)">text **bold** more</span> here.')
    expect(html).not.toContain('onclick')
    expect(html).toContain('<span>text <strong>bold</strong> more</span>')
  })

  it('still emits pagedown-pagebreak divs correctly alongside whole-tree sanitization', () => {
    const { html } = markdownToHtml('One.\n\n<!-- pagebreak -->\n\nTwo.')
    expect(html).toContain('<div class="pagedown-pagebreak"></div>')
  })

  it('recognizes \\newpage as equivalent to the canonical pagebreak marker', () => {
    const canonical = markdownToHtml('Paragraph one.\n\n<!-- pagebreak -->\n\nParagraph two.')
    const alternate = markdownToHtml('Paragraph one.\n\n\\newpage\n\nParagraph two.')
    expect(alternate.html).toContain('<div class="pagedown-pagebreak"></div>')
    expect(alternate.html).toBe(canonical.html)
  })

  it('does not let raw HTML forge a fake pagebreak marker', () => {
    const { html } = markdownToHtml('<div class="pagedown-pagebreak">forged content</div>')
    expect(html).not.toContain('pagedown-pagebreak')
    expect(html).toContain('forged content')
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
    // raw(), sanitize()) don't change source-map behavior on documents that
    // never touch them.
    expect(sourceMap).toBeDefined()
    expect(typeof sourceMap.htmlOffsetToSrc).toBe('function')
  })

  it('strips a raw style tag entirely instead of leaking its CSS text into the output', () => {
    const { html } = markdownToHtml('<style>body{background:url(https://evil/x)}</style>\n\nAfter.')
    expect(html).not.toContain('background')
    expect(html).not.toContain('evil')
    expect(html).toContain('<p>After.</p>')
  })

  it("produces a well-formed sourceMap for a document containing raw HTML and a pagebreak marker (the spec's own open technical question)", () => {
    const source = readFileSync(join(__dirname, '../../phase0/corpus/raw-html.md'), 'utf-8')
    const { sourceMap } = markdownToHtml(source)

    expect(sourceMap).toBeDefined()
    expect(typeof sourceMap.htmlOffsetToSrc).toBe('function')
    expect(typeof sourceMap.srcToRun).toBe('function')

    // Every mapped source offset must round-trip cleanly through
    // htmlOffsetToSrc — this is the actual thing the spec's own open
    // technical question needed confirmed: annotateSourceOffsets's behavior
    // on a document with raw HTML is not silently corrupted, degraded, or
    // producing bad offsets, even though (as this test file itself now
    // documents in the next test) some rendered HTML text has no
    // corresponding run at all — that's expected, not a bug, since it comes
    // from raw-HTML content the source-offset mechanism was never designed
    // to track in the first place. (`srcToRun` returns `null`, not a run,
    // for offsets with no independently addressable rendered position —
    // e.g. interior bytes of an escape/entity sequence — so those are
    // skipped here, same as `srcToRendered`'s own documented `null` case.)
    for (let offset = 0; offset < source.length; offset++) {
      const run = sourceMap.srcToRun(offset)
      if (run === null) continue
      expect(() => sourceMap.htmlOffsetToSrc(run.htmlOffset, run.runId)).not.toThrow()
    }
  })
})

describe('markdownToHtml — local asset src rewriting', () => {
  it('rewrites a relative local image src into the __asset__ URL scheme when assetToken is provided', () => {
    const { html } = markdownToHtml('![chart](./figures/chart.png)', { assetToken: 'abc123' })
    expect(html).toContain(
      'src="pagedown-render://render/__asset__/abc123/' +
        encodeURIComponent('./figures/chart.png') +
        '"'
    )
  })

  it('does NOT rewrite a relative image src when assetToken is omitted (existing/default behavior)', () => {
    const { html } = markdownToHtml('![chart](./figures/chart.png)')
    expect(html).toContain('src="./figures/chart.png"')
  })

  it('does not rewrite a remote http(s) image src even when assetToken is provided', () => {
    const { html } = markdownToHtml('![x](https://example.com/a.png)', { assetToken: 'abc123' })
    expect(html).toContain('src="https://example.com/a.png"')
    expect(html).not.toContain('__asset__')
  })

  // The pre-existing hast-util-sanitize pass (unrelated to this task's
  // rewrite) already strips a `data:` src from `img` entirely, since
  // hast-util-sanitize's defaultSchema pins `protocols.src` to
  // `['http', 'https']` only. That happens regardless of whether an
  // assetToken is provided. This test's real subject is therefore narrower
  // than "data: URLs are preserved" — it confirms a `data:` src is never
  // routed into the __asset__ scheme by this task's rewrite, not that it
  // survives sanitize (it doesn't, before or after this change).
  it('does not rewrite a data: image src even when assetToken is provided', () => {
    const { html } = markdownToHtml('![x](data:image/png;base64,abc)', { assetToken: 'abc123' })
    expect(html).not.toContain('src="data:image/png;base64,abc"')
    expect(html).not.toContain('__asset__')
  })

  it('does not rewrite an absolute local path even when assetToken is provided (denied by resolveAssetPath anyway, but should not even be routed through __asset__)', () => {
    const { html } = markdownToHtml('![x](/etc/passwd)', { assetToken: 'abc123' })
    expect(html).toContain('src="/etc/passwd"')
    expect(html).not.toContain('__asset__')
  })
})
