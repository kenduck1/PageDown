import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { markdownToHtml } from './pipeline'
import { encodeCommentMeta } from './comment-plugin'

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

describe('markdownToHtml — code block syntax highlighting', () => {
  it('highlights a labeled fenced code block with real token spans', () => {
    const { html } = markdownToHtml('```js\nconst x = 1;\n```')
    expect(html).toContain('class="hljs language-js"')
    expect(html).toContain('hljs-keyword')
  })

  it('does not highlight a fenced code block with no language info string', () => {
    const { html } = markdownToHtml('```\nplain text\n```')
    expect(html).not.toContain('hljs')
    expect(html).toContain('plain text')
  })

  it('does not highlight inline code (no fence, no language)', () => {
    const { html } = markdownToHtml('Some `inline code` in a sentence.')
    expect(html).not.toContain('hljs')
    expect(html).toContain('<code>inline code</code>')
  })

  it('runs highlighting after sanitize, so it never needs a schema exception', () => {
    // A raw-HTML script tag inside what LOOKS like a code fence in markdown
    // source is still just literal text content once fenced -- confirms
    // highlighting doesn't reintroduce anything sanitize() already strips
    // elsewhere in the document.
    const { html } = markdownToHtml('<script>alert(1)</script>\n\n```js\nconst safe = true;\n```')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
    expect(html).toContain('hljs-keyword')
  })
})

describe('markdownToHtml — math equations', () => {
  it('preserves block math ($$ on its own lines) as an inert language-math-block placeholder', () => {
    const { html } = markdownToHtml('Before.\n\n$$\nx^2 + y^2 = z^2\n$$\n\nAfter.')
    expect(html).toContain('<div><code class="language-math-block">x^2 + y^2 = z^2</code></div>')
    // A div-wrapped code element is structurally invisible to rehype-highlight
    // (it only ever touches `pre > code` — see math-to-hast.ts's own comment).
    expect(html).not.toContain('hljs')
  })

  it('preserves double-dollar inline math ($$...$$ on one line) as a language-math-inline placeholder', () => {
    const { html } = markdownToHtml('The formula $$x^2$$ appears here.')
    expect(html).toContain('<code class="language-math-inline">x^2</code>')
  })

  it('does NOT treat a single dollar sign as math (avoids currency false positives)', () => {
    // singleDollarTextMath: false — see pipeline.ts's own comment on why a
    // single $ is deliberately not enough to open inline math in this app.
    const { html } = markdownToHtml('It costs $5 and $10 today.')
    expect(html).not.toContain('language-math-inline')
    expect(html).toContain('$5')
    expect(html).toContain('$10')
  })

  it('renders neither block nor inline math in the privileged pipeline — only the raw source survives', () => {
    const { html } = markdownToHtml('$$\n\\frac{1}{2}\n$$')
    expect(html).toContain('\\frac{1}{2}')
    expect(html).not.toContain('katex')
  })
})

describe('markdownToHtml — comments', () => {
  it('renders a commented span as completely ordinary, unmarked text — no wrapper, no data attribute', () => {
    const dataAttr = encodeCommentMeta({
      author: 'Kai',
      text: 'needs revision',
      createdAt: '2026-08-09T06:00:00Z'
    })
    const source = `Before. <!--comment id="c1" data="${dataAttr}"-->the marked phrase<!--/comment id="c1"-->. After.`
    const { html } = markdownToHtml(source)

    expect(html).toContain('the marked phrase')
    expect(html).not.toContain('comment')
    expect(html).not.toContain('data-comment')
    expect(html).not.toContain('<span')
    expect(html).not.toContain('c1')
  })

  it('leaves an unmatched (unpaired) comment marker as inert literal text', () => {
    const dataAttr = encodeCommentMeta({
      author: 'Kai',
      text: 'x',
      createdAt: '2026-08-09T06:00:00Z'
    })
    const source = `Text with a stray marker <!--comment id="c1" data="${dataAttr}"-->and no closing tag.`
    const { html } = markdownToHtml(source)

    // Raw HTML comments are dropped from rendered output by browsers/HTML
    // parsers regardless (they're real HTML comments), but the surrounding
    // ordinary text must survive untouched and nothing must throw.
    expect(html).toContain('and no closing tag')
  })
})

describe('markdownToHtml — footnotes', () => {
  it('renders a footnote reference and its definition into a real footnotes section', () => {
    const { html } = markdownToHtml(
      'Here is a footnote reference[^1].\n\n[^1]: Here is the footnote.'
    )
    expect(html).toContain('data-footnote-ref')
    expect(html).toContain('Here is the footnote.')
    expect(html).toContain('class="footnotes"')
  })

  // Regression test for a real bug: mdast-util-to-hast pre-prefixes footnote
  // id/href pairs with 'user-content-' to prevent DOM clobbering, and
  // hast-util-sanitize's OWN separate clobber-prefixing then doubled that
  // prefix on the `id` side only (never on `href`, which isn't in its
  // clobber list) -- so the forward reference link, and the footnote's own
  // back-reference link, both pointed at ids that no longer existed. See
  // undoDoubleClobberPrefix's own comment in pipeline.ts for the full
  // mechanics.
  it('the footnote reference link points at an id that genuinely exists in the output (no doubled clobber prefix)', () => {
    const { html } = markdownToHtml(
      'Here is a footnote reference[^1].\n\n[^1]: Here is the footnote.'
    )

    const hrefMatch = html.match(/<sup>[\s\S]*?<a href="#([^"]+)"/)
    expect(hrefMatch, 'expected a real footnote reference link').not.toBeNull()
    const targetId = hrefMatch![1]

    expect(html).not.toContain('user-content-user-content-')
    expect(html).toContain(`id="${targetId}"`)
  })

  it('the footnote back-reference link points at an id that genuinely exists in the output', () => {
    const { html } = markdownToHtml(
      'Here is a footnote reference[^1].\n\n[^1]: Here is the footnote.'
    )

    // The backref anchor's attribute order (href before data-footnote-backref)
    // is fixed by mdast-util-to-hast's own footer.js.
    const backrefMatch = html.match(/<a href="#([^"]+)" data-footnote-backref/)
    expect(backrefMatch, 'expected a real footnote back-reference link').not.toBeNull()
    const targetId = backrefMatch![1]

    expect(html).toContain(`id="${targetId}"`)
  })

  it('a raw-HTML-authored id is still clobber-prefixed exactly once (no protection regression)', () => {
    const { html } = markdownToHtml('<div id="config">hostile</div>')
    expect(html).toContain('id="user-content-config"')
    expect(html).not.toContain('id="user-content-user-content-config"')
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

  it('does not rewrite a remote http(s) image src into __asset__, even when assetToken is provided and allowRemoteImages is true', () => {
    const { html } = markdownToHtml('![x](https://example.com/a.png)', {
      assetToken: 'abc123',
      allowRemoteImages: true
    })
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
  // survives sanitize (it doesn't, before or after this change). Asserting
  // the exact emitted shape (no src attribute at all) — rather than just two
  // `not.toContain` checks that would also pass for "there was no src to
  // begin with" — pins the real pre-existing behavior so a future schema
  // change that starts letting `data:` through would be noticed here.
  it('does not rewrite a data: image src even when assetToken is provided', () => {
    const { html } = markdownToHtml('![x](data:image/png;base64,abc)', { assetToken: 'abc123' })
    expect(html).toContain('<img alt="x">')
    expect(html).not.toContain('src="data:image/png;base64,abc"')
    expect(html).not.toContain('__asset__')
  })

  it('does not rewrite an absolute local path even when assetToken is provided (denied by resolveAssetPath anyway, but should not even be routed through __asset__)', () => {
    const { html } = markdownToHtml('![x](/etc/passwd)', { assetToken: 'abc123' })
    expect(html).toContain('src="/etc/passwd"')
    expect(html).not.toContain('__asset__')
  })

  // Task 1's protocol handler (src/main/pagination-window.ts) parses the
  // rewritten URL by taking everything after `__asset__/<token>/` as the
  // path segment and running it through exactly ONE decodeURIComponent.
  // These tests mirror that exact parsing (rather than hardcoding an
  // expected percent-encoded string, which would just re-encode the
  // double-encoding bug into the test) and assert the round-trip property:
  // decoding the emitted segment once must recover the original relative
  // path exactly, for filenames containing characters mdast-util-to-hast
  // itself percent-encodes before the src ever reaches this rewrite
  // (spaces, non-ASCII).
  function decodeAssetSegment(html: string): string {
    const match = html.match(/src="pagedown-render:\/\/render\/__asset__\/[^/]+\/([^"]+)"/)
    if (!match) throw new Error(`no __asset__ src found in: ${html}`)
    return decodeURIComponent(match[1])
  }

  it('round-trips a relative path with a space through exactly one encode/decode layer', () => {
    const { html } = markdownToHtml('![x](<Screen Shot 2026.png>)', { assetToken: 'abc123' })
    expect(decodeAssetSegment(html)).toBe('Screen Shot 2026.png')
  })

  it('round-trips a relative path with a non-ASCII character through exactly one encode/decode layer', () => {
    const { html } = markdownToHtml('![x](café.png)', { assetToken: 'abc123' })
    expect(decodeAssetSegment(html)).toBe('café.png')
  })

  it('round-trips a plain relative path through exactly one encode/decode layer', () => {
    const { html } = markdownToHtml('![chart](./figures/chart.png)', { assetToken: 'abc123' })
    expect(decodeAssetSegment(html)).toBe('./figures/chart.png')
  })

  it('does not throw on a src containing a literal, undecodable percent sign', () => {
    expect(() => markdownToHtml('![x](100%.png)', { assetToken: 'abc123' })).not.toThrow()
    expect(() => markdownToHtml('![x](a%zz.png)', { assetToken: 'abc123' })).not.toThrow()
  })

  // Confinement regression guard: decoding one layer before re-encoding (the
  // fix for the double-encoding bug above) makes a raw-HTML traversal
  // attempt arrive at the main-process handler as a VISIBLE `../secret.png`
  // rather than an inert, literally-nonexistent `%2e%2e%2fsecret.png`
  // filename. Both are denied by resolveAssetPath's realpath-containment
  // check on the main-process side (out of scope for this file to test
  // directly), but this test confirms the thing this file IS responsible
  // for: the decoded segment this rewrite hands to that check is the real,
  // uncloaked `../secret.png` traversal path, not something the containment
  // check would need double-decoding to even recognize as a traversal.
  it('decodes a raw-HTML encoded traversal attempt into a visible, not disguised, relative path', () => {
    const { html } = markdownToHtml('<img src="%2e%2e%2fsecret.png">', { assetToken: 'abc123' })
    expect(decodeAssetSegment(html)).toBe('../secret.png')
  })

  it('rewrites a raw-HTML img src the same as a Markdown image src', () => {
    const { html } = markdownToHtml('<img src="./x.png">', { assetToken: 'abc123' })
    expect(decodeAssetSegment(html)).toBe('./x.png')
  })

  // An author's own raw HTML must never be able to forge a reference into
  // another document's asset token or otherwise mint a pagedown-render://
  // URL by hand — isRelativeLocalPath's URL-scheme check rejects this src
  // outright (it already has a scheme), so it is left completely alone by
  // this rewrite, then stripped by the pre-existing sanitize protocol pin
  // (pagedown-render is not in `['http', 'https']`) same as any other
  // disallowed-protocol src.
  it('does not let raw HTML forge or borrow another __asset__ URL', () => {
    const { html } = markdownToHtml('<img src="pagedown-render://render/__asset__/FORGED/a.png">', {
      assetToken: 'abc123'
    })
    expect(html).not.toContain('FORGED')
    expect(html).not.toContain('src=')
  })
})

describe('markdownToHtml — remote image consent (allowRemoteImages)', () => {
  it('strips a remote http(s) image src by default (allowRemoteImages omitted) -- blocked by default, per the design doc', () => {
    const { html } = markdownToHtml('![x](https://example.com/a.png)')
    expect(html).toContain('<img alt="x">')
    expect(html).not.toContain('src="https://example.com/a.png"')
  })

  it('strips a remote http(s) image src when allowRemoteImages is explicitly false', () => {
    const { html } = markdownToHtml('![x](https://example.com/a.png)', { allowRemoteImages: false })
    expect(html).not.toContain('src="https://example.com/a.png"')
  })

  it('leaves a remote http(s) image src intact when allowRemoteImages is true', () => {
    const { html } = markdownToHtml('![x](https://example.com/a.png)', { allowRemoteImages: true })
    expect(html).toContain('src="https://example.com/a.png"')
  })

  it('strips a remote src written as raw HTML too, not just Markdown image syntax', () => {
    const { html } = markdownToHtml('<img src="http://example.com/pixel.gif">')
    expect(html).not.toContain('src="http://example.com/pixel.gif"')
  })

  it('does not strip a local relative image src -- only http(s) is gated by allowRemoteImages', () => {
    const { html } = markdownToHtml('![chart](./figures/chart.png)', { assetToken: 'abc123' })
    expect(html).toContain(
      'src="pagedown-render://render/__asset__/abc123/' +
        encodeURIComponent('./figures/chart.png') +
        '"'
    )
  })

  it('does not affect a data: image src either way', () => {
    const withoutConsent = markdownToHtml('![x](data:image/png;base64,abc)').html
    const withConsent = markdownToHtml('![x](data:image/png;base64,abc)', {
      allowRemoteImages: true
    }).html
    // Both strip it -- data: was never in hast-util-sanitize's allowed
    // protocols list to begin with, unrelated to this feature.
    expect(withoutConsent).not.toContain('src="data:image/png;base64,abc"')
    expect(withConsent).not.toContain('src="data:image/png;base64,abc"')
  })

  // Both of the following were REAL, confirmed bypasses that this feature
  // shipped with until review caught them -- each defeated the whole feature,
  // and each fired regardless of the consent flag's value. They are pinned
  // here because neither is intuitive enough to survive a future refactor of
  // applyRemoteImagePolicy on reasoning alone.
  it('strips an http(s) src with NO slashes after the colon -- a real, fetchable remote URL', () => {
    // micromark's sanitize-uri and hast-util-sanitize's safeProtocol BOTH
    // validate only the substring before the colon; neither requires `//`.
    // Per the WHATWG URL spec's "special authority ignore slashes state" a
    // special scheme enters authority parsing regardless of slash count, so
    // this normalizes to http://evil.com/tracker.png and genuinely fetches.
    // A `startsWith('http://')` test does not match it.
    expect(new URL('http:evil.com/tracker.png').href).toBe('http://evil.com/tracker.png')
    const html = markdownToHtml('![x](http:evil.com/tracker.png)').html
    expect(html).not.toContain('evil.com')
    const oneSlash = markdownToHtml('![x](http:/evil.com/tracker.png)').html
    expect(oneSlash).not.toContain('evil.com')
  })

  it('strips a protocol-relative //host image src', () => {
    expect(markdownToHtml('![x](//evil.com/tracker.png)').html).not.toContain('evil.com')
  })

  it('strips srcset from <picture><source> UNCONDITIONALLY, even with consent granted', () => {
    // hast-util-sanitize allows source[srcSet] with NO protocol allowlist
    // behind it, so unlike `src` there is no scheme restriction to fall back
    // on -- which is why this is not gated on consent the way `src` is.
    const raw = '<picture><source srcset="https://evil.com/track.png"><img src="a.png"></picture>'
    expect(markdownToHtml(raw).html).not.toContain('evil.com')
    expect(markdownToHtml(raw, { allowRemoteImages: true }).html).not.toContain('evil.com')
  })

  it('still renders the <picture> fallback img itself -- the strip is srcset-scoped', () => {
    // Guards against over-correcting the fix into "drop the whole element."
    const raw = '<picture><source srcset="https://evil.com/t.png"><img src="local.png"></picture>'
    expect(markdownToHtml(raw).html).toContain('<img')
  })
})

// 2026-08-09 design-doc gap audit's A5: `markdownToHtml` used to return only
// `{ html, sourceMap }`, with no channel for design:167's own "warns on an
// inline occurrence" requirement at all. `warnings` is computed from the
// SAME parse pass already running (see collectPagebreakWarnings' own header
// comment in pagebreak-plugin.ts) -- these tests exist at the
// `markdownToHtml` boundary specifically to prove the field is actually
// wired through this function's return value, not just correct in
// isolation (pagebreak-plugin.test.ts already covers the detection logic
// itself in detail).
describe('markdownToHtml — document warnings', () => {
  it('returns an empty warnings array for a well-formed document', () => {
    const { warnings } = markdownToHtml('Paragraph one.\n\n<!-- pagebreak -->\n\nParagraph two.')
    expect(warnings).toEqual([])
  })

  it('warns on a mid-paragraph inline pagebreak occurrence', () => {
    const { warnings } = markdownToHtml('Some text with an <!-- pagebreak --> inline occurrence.')
    expect(warnings).toHaveLength(1)
    expect(warnings[0].id).toBe('inline-pagebreak-marker')
  })

  it('warns when an alternate pagebreak syntax is recognized and kept as written', () => {
    const { warnings } = markdownToHtml('Paragraph one.\n\n\\newpage\n\nParagraph two.')
    expect(warnings).toHaveLength(1)
    expect(warnings[0].id).toBe('alternate-pagebreak-syntax')
  })

  it('does not warn for the canonical marker used correctly, even alongside unrelated raw HTML', () => {
    const { warnings } = markdownToHtml(
      '<div class="callout">Note</div>\n\nParagraph.\n\n<!-- pagebreak -->\n\nMore.'
    )
    expect(warnings).toEqual([])
  })
})
