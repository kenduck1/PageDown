import { randomBytes } from 'node:crypto'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkRehype from 'remark-rehype'
import rehypeHighlight from 'rehype-highlight'
import rehypeStringify from 'rehype-stringify'
import { raw } from 'hast-util-raw'
import { sanitize, defaultSchema } from 'hast-util-sanitize'
import type { Schema } from 'hast-util-sanitize'
import type { Root as HastRoot } from 'hast'
import type { Root } from 'mdast'
import { visit } from 'unist-util-visit'
import { annotateSourceOffsets, type SourceMap } from './source-map'
import { remarkPagebreak, PAGEBREAK_CLASS } from './pagebreak-plugin'
import { createPagebreakToHast } from './pagebreak-to-hast'

export type { SourceMap }

// A leading URL scheme (`http:`, `https:`, `data:`, `pagedown-render:`, ...)
// per RFC 3986's `scheme` production. Anything matching this is already an
// absolute reference and must be left untouched by rewriteLocalImageSrcs.
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i

// Passed explicitly to BOTH remark-rehype and the sanitize schema below
// (each of which defaults to this exact same value independently) so their
// agreement is a real, enforced coupling rather than two hardcoded library
// defaults that merely happen to currently match — see
// undoDoubleClobberPrefix's own comment for why this specific value being
// shared is load-bearing, not incidental.
const CLOBBER_PREFIX = 'user-content-'
const DOUBLED_CLOBBER_PREFIX = CLOBBER_PREFIX + CLOBBER_PREFIX

// mdast-util-to-hast pre-prefixes footnote-generated `id`/`href` pairs with
// its own `clobberPrefix` ahead of sanitize — but ONLY for the fn-N/fnref-N
// id<->href pairs a footnote reference and its target need to keep matching
// (confirmed by reading `footer.js`/`handlers/footnote-reference.js`, the
// only two places in mdast-util-to-hast that bake this prefix in early). The
// footnote label's own id/aria-describedby pair is deliberately left BARE by
// the same code, relying on a downstream sanitizer to prefix both sides
// identically. hast-util-sanitize's own, separate clobber-prefixing
// (`id`/`name`/`ariaDescribedBy`/`ariaLabelledBy` on every element,
// unconditionally — confirmed by reading `propertyValuePrimitive` in its own
// source, which has no "already prefixed" check) then reapplies the SAME
// prefix a second time to whichever of those values reach it already
// prefixed, but only to `id`/`ariaDescribedBy` — never to `href`, which
// isn't in its clobber list. Net effect: a footnote's `id` ends up doubled
// (`user-content-user-content-fn-1`) while the `href` referencing it stays
// single-prefixed (`#user-content-fn-1`), so the browser has no element
// matching the anchor — clicking a footnote reference, or its back-arrow,
// silently does nothing. Fixed by stripping exactly one duplicate prefix off
// any `id`/`aria-describedby`/`aria-labelledby` value that carries it
// twice, post-sanitize. Deliberately narrow: an id sanitize prefixed only
// ONCE — every id from a document author's own raw HTML, or the footnote
// label's own bare pair above — never matches the doubled pattern and is
// left untouched, so this does not weaken DOM-clobbering protection for
// anything else sanitize() already guards.
function undoDoubleClobberPrefix(value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith(DOUBLED_CLOBBER_PREFIX)) {
    return value.slice(CLOBBER_PREFIX.length)
  }
  if (Array.isArray(value)) {
    return value.map(undoDoubleClobberPrefix)
  }
  return value
}

// True only for a relative, document-local path — no leading `/` (an
// absolute filesystem path, denied by resolveAssetPath on the main-process
// side anyway, but never even worth routing through the __asset__ scheme)
// and no URL scheme prefix (http(s), data:, pagedown-render:, ...).
function isRelativeLocalPath(src: string): boolean {
  if (src.length === 0) return false
  if (src.startsWith('/')) return false
  if (URL_SCHEME_PATTERN.test(src)) return false
  return true
}

// mdast-util-to-hast (via micromark-util-sanitize-uri) already
// percent-encodes unsafe/reserved characters in a Markdown image's `src`
// before it ever lands in `properties.src` here — so a space becomes `%20`,
// a non-ASCII character becomes its UTF-8 percent-encoding, etc., well
// before this rewrite ever sees the value. encodeURIComponent-ing that
// already-encoded string a second time double-encodes it (`%20` becomes
// `%2520`), while src/main/pagination-window.ts's protocol handler decodes
// the path segment exactly once — so any src containing a space or
// non-ASCII character round-tripped to a literal, on-disk-nonexistent
// filename and silently 404'd. Decoding one layer first undoes mdast's own
// encoding, so it's the *original* filename characters that get
// encodeURIComponent'd, and the handler's one decode recovers them exactly.
// Raw-HTML `<img src>` values bypass mdast's normalization entirely and can
// contain a literal, undecodable `%` (e.g. `100%.png`, or `a%zz.png` where
// `%zz` isn't valid hex) — decodeURIComponent throws URIError on those, so
// this must not be unguarded, or a document containing one would crash
// markdownToHtml entirely. Falling back to the raw value on failure is safe:
// it's exactly what happened before this fix existed, for every src.
function urlToRelativePath(src: string): string {
  try {
    return decodeURIComponent(src)
  } catch {
    return src
  }
}

// Rewrites every relative local `img src` in the tree into the sandboxed
// pagination render context's asset scheme (src/main/pagination-window.ts's
// `pagedown-render://` protocol handler), so that handler can resolve it
// under a specific document's directory. Must be called on the
// already-*sanitized* tree — see the call site below for why.
//
// Known limitation, fails closed: a query or fragment on a local image
// (`![x](chart.png?v=2)`, `![x](#frag)`) is not stripped before the rewrite —
// it becomes part of the literal filename this function percent-encodes
// (`chart.png?v=2` -> segment `chart.png%3Fv%3D2`), so it 404s against the
// real on-disk file. This is a direct, accepted consequence of encoding the
// whole segment rather than parsing it as a URL with query/fragment parts —
// the same whole-segment encoding is exactly what prevents an attacker from
// injecting a query/fragment into the generated asset URL itself. Not worth
// "fixing" by stripping `?`/`#` before encoding: on Windows, `?` isn't even a
// legal filename character, so there's no real cache-busting use case this
// would recover.
//
// Known limitation, fails closed: `<source srcset>` inside a `<picture>`
// survives hast-util-sanitize with an unrewritten relative reference — this
// function only rewrites `img[src]`, not `source[srcset]` (a different
// attribute, on a different element, with a different micro-syntax: a
// comma-separated list of URL/width-descriptor pairs). A relative local path
// inside a `<picture>`'s `srcset` therefore silently 404s. Safe only because
// hast-util-sanitize's defaultSchema does NOT protocol-restrict `srcSet`
// (only `cite`/`href`/`longDesc`/`src` are in its `protocols` map), so an
// unrewritten relative srcset value survives sanitize unchanged rather than
// being stripped outright — the render context's own CSP (`img-src 'self'
// data:`) is what actually stops anything worse than a 404 here.
function rewriteLocalImageSrcs(tree: HastRoot, assetToken: string): void {
  visit(tree, 'element', (node) => {
    if (node.tagName !== 'img') return
    const src = node.properties.src
    if (typeof src !== 'string' || !isRelativeLocalPath(src)) return
    const relativePath = urlToRelativePath(src)
    node.properties.src = `pagedown-render://render/__asset__/${assetToken}/${encodeURIComponent(relativePath)}`
  })
}

export function markdownToHtml(
  source: string,
  options?: { assetToken?: string }
): { html: string; sourceMap: SourceMap } {
  // unified's `.parse()` only performs the parse phase — it does NOT run
  // attached transformers (remarkPagebreak's tree mutation only executes
  // during `.run()`/`.runSync()`). remarkGfm/remarkFrontmatter don't need
  // this because they work by registering micromark/mdast-util-from-markdown
  // syntax extensions that `.parse()` itself consults, not by mutating the
  // tree after the fact — but remarkPagebreak IS a post-parse tree mutation,
  // so it needs an explicit `.runSync()` on the same processor instance
  // (same instance matters: that's what carries the attached transformer).
  const parseProcessor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkPagebreak)

  const parsedTree = parseProcessor.parse(source) as Root
  const tree = parseProcessor.runSync(parsedTree) as Root

  const sourceMap = annotateSourceOffsets(tree, source)

  // Per-render random token: without this, the whole-tree sanitize() pass
  // below can't tell pagebreakToHast's own trusted output apart from
  // attacker-typed raw HTML carrying the same static class name, once both
  // flow through the same schema exception (a real gap found in this
  // pipeline's own review — see this task's "Round 2 finding" note above).
  // Generating the token fresh per call, after `source` is already fixed,
  // makes it impossible for document content authored in advance to predict
  // or embed — the schema exception below only ever allows THIS render's
  // token value, and the final replace swaps it back to the stable public
  // class name real consumers (e.g. a future pagination-preview task) key
  // off of.
  const pagebreakToken = randomBytes(16).toString('hex')
  const tokenClassName = `${PAGEBREAK_CLASS}-${pagebreakToken}`

  // allowDangerousHtml: true here does NOT mean unsafe output — it means
  // "don't drop raw HTML, turn it into `raw` hast nodes for `raw()` and
  // `sanitize()` below to resolve and clean up." `pagebreak`-typed nodes are
  // unaffected either way: remarkPagebreak already promoted every matching
  // marker away from `type: 'html'` before this stage ever runs, so they
  // reach the handler below via the `handlers` map exactly as before.
  const hastTree = unified()
    .use(remarkRehype, {
      allowDangerousHtml: true,
      clobberPrefix: CLOBBER_PREFIX,
      handlers: { pagebreak: createPagebreakToHast(tokenClassName) }
    })
    .runSync(tree) as HastRoot

  // hast-util-sanitize's default (GitHub-style) schema doesn't allow a plain
  // `class` on `div` at all — reasonable for arbitrary author-supplied raw
  // HTML, but the pagebreak div above deliberately carries this render's
  // own unguessable token class and must survive sanitization. This adds
  // one precise, per-render exception (the exact token value, not a general
  // className allowance) rather than loosening `class` generally — the same
  // pattern hast-util-sanitize's own defaultSchema uses for its GFM
  // `code`/task-list class exceptions (node_modules/hast-util-sanitize/lib/schema.js).
  const schema: Schema = {
    ...defaultSchema,
    clobberPrefix: CLOBBER_PREFIX,
    strip: [
      ...(defaultSchema.strip ?? []),
      'style',
      'textarea',
      'title',
      'iframe',
      'noembed',
      'noframes',
      'xmp',
      'plaintext'
    ],
    attributes: {
      ...defaultSchema.attributes,
      div: [...(defaultSchema.attributes?.div ?? []), ['className', tokenClassName]]
    }
  }

  // Re-serializes the whole tree (including the `raw` nodes above) to one
  // HTML string and re-parses it as a real document — this is what actually
  // fixes interleaved/split raw-HTML tags, since resolving them correctly
  // requires seeing the whole document at once, not one fragment at a time.
  const rawProcessed = raw(hastTree) as HastRoot
  const sanitized = sanitize(rawProcessed, schema) as HastRoot

  // See undoDoubleClobberPrefix's own comment above for the full mechanics:
  // this repairs footnote id/href pairs that the two clobber-prefixing
  // passes above (mdast-util-to-hast, then hast-util-sanitize) doubled up
  // on one side but not the other.
  visit(sanitized, 'element', (node) => {
    const properties = node.properties as Record<string, unknown>
    for (const key of ['id', 'ariaDescribedBy', 'ariaLabelledBy']) {
      if (key in properties) {
        properties[key] = undoDoubleClobberPrefix(properties[key])
      }
    }
  })

  // Must run AFTER sanitize(), not before it, and this is load-bearing, not
  // stylistic: hast-util-sanitize's defaultSchema pins `protocols.src` to
  // `['http', 'https']`, so a `pagedown-render://` src written before this
  // pass would simply be stripped back out by sanitize() itself, silently
  // producing zero rewritten images end to end. Running here also means only
  // already-sanitized `img` nodes are ever rewritten, and the original src is
  // percent-encoded into a single opaque path segment — nothing injectable
  // survives. Do NOT "fix" this by adding `pagedown-render` to the sanitize
  // schema's allowed protocols instead of moving this call — that would let
  // a document author's own raw HTML forge asset URLs directly, which is
  // exactly the class of bug the schema pin above exists to prevent.
  if (options?.assetToken) {
    rewriteLocalImageSrcs(sanitized, options.assetToken)
  }

  // Deliberately runs AFTER sanitize(), not before it — the same ordering
  // rewriteLocalImageSrcs uses above, for an analogous reason: the classes
  // rehype-highlight adds (`hljs`, `hljs-keyword`, ...) never need to
  // survive a sanitize pass, because none runs after this point. This also
  // means the sanitize schema above needed NO changes to allow highlighting
  // — a smaller, more conservative change than expanding its class
  // allowlist would have been. Only highlights a fenced code block that
  // already carries a `language-*` class (remark-rehype's own default `code`
  // handler adds that from the fence's info string, e.g. ```js) — plain,
  // unlabeled code blocks are deliberately left untouched (rehype-highlight's
  // own default: no `detect: true` here), matching how GitHub itself only
  // highlights when a language is given rather than guessing one. The
  // default 37-language "common" bundle (js/ts/python/css/html/json/bash/...)
  // is used as-is rather than the full ~190-grammar set, keeping the
  // sandboxed render context's bundle size down for a document-editor's
  // realistic language mix.
  const highlighted = unified().use(rehypeHighlight).runSync(sanitized) as HastRoot

  const html = unified()
    .use(rehypeStringify)
    .stringify(highlighted)
    .replaceAll(tokenClassName, PAGEBREAK_CLASS)

  return { html, sourceMap }
}
