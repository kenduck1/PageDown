import { randomBytes } from 'node:crypto'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMath from 'remark-math'
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
import { remarkPagebreak, PAGEBREAK_CLASS, collectPagebreakWarnings } from './pagebreak-plugin'
import { createPagebreakToHast } from './pagebreak-to-hast'
import type { DocumentWarning } from './document-warnings'
import { createMathBlockToHast, createMathInlineToHast } from './math-to-hast'
import { remarkComment } from './comment-plugin'
import { createCommentToHast } from './comment-to-hast'
import { isRelativeLocalPath, isRemoteImageSrc, urlToRelativePath } from './local-image-src'

export type { SourceMap }

// Both moved to ./local-image-src (a dependency-free module) and re-exported
// here unchanged, so every pre-existing `import { isRelativeLocalPath } from
// './pipeline'` keeps working. The move exists so the privileged RENDERER
// can ask the same question without importing this module's own
// unified/remark/rehype dependency graph -- see that file's header for the
// full reasoning.
export { isRelativeLocalPath, urlToRelativePath }

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

// Design doc Security section: "Remote images blocked by default per
// document, with an explicit ... Load / Keep blocked prompt." `http(s)` is
// already in hast-util-sanitize's OWN default `protocols.src` allowlist
// (confirmed by reading its schema directly), so a remote `img src` survives
// sanitize() completely untouched with no rewrite needed at all -- this
// function is the actual per-document enforcement point, not the sandboxed
// context's CSP. The CSP (see pagination-window.ts's CSP_POLICY_TEMPLATE) is
// widened to permit `https:`/`http:` `img-src` ONCE, for every document,
// because it cannot vary per-document within one long-lived harness's
// lifetime (Split mode's harness renders many different documents across its
// one lifetime with one CSP fixed at creation) -- so it is deliberately a
// coarse backstop, not the enforcement mechanism. The real, per-document
// decision is made here: a caller that hasn't been granted consent for THIS
// specific render never gets a live remote `src` in its HTML at all, so
// nothing for the (permanently widened) CSP to even allow.
//
// **The scheme test is anchored at the COLON, not at `http://`, and that is a
// real bypass this function shipped with before review caught it — do not
// "simplify" it back to `startsWith('http://')`.** `micromark-util-sanitize-uri`
// and `hast-util-sanitize`'s own `safeProtocol` BOTH validate only the substring
// before the colon (confirmed by reading each directly); neither requires the
// `//` that normally follows. So `![x](http:evil.com/tracker.png)` reaches this
// function with `src` intact, and a `startsWith('http://')` test does not match
// it. That URL is not malformed: per the WHATWG URL spec's "special authority
// ignore slashes state", a SPECIAL scheme (`http`/`https`) enters authority
// parsing regardless of how many slashes follow the colon, so every conformant
// parser — Chromium's included — normalizes it to `http://evil.com/tracker.png`
// and genuinely issues the request. Verified directly: `new URL('http:evil.com/
// x.png').href` is `http://evil.com/x.png`. The leading-`//` alternative is
// matched too (protocol-relative): it resolves against whatever scheme the
// consuming context uses, which is architecture-dependent rather than reliably
// inert, so it is cheaper to strip than to reason about per surface.
//
// The pattern itself now lives in ./local-image-src as `isRemoteImageSrc`,
// so this ENFORCEMENT copy and detectRemoteImages.ts's banner-deciding copy
// are literally the same code rather than two regexes a comment asks a
// future reader to keep in sync -- see that function's own comment. The
// reasoning above is unchanged and is why the shared pattern looks the way
// it does.

function applyRemoteImagePolicy(tree: HastRoot, allowRemoteImages: boolean): void {
  visit(tree, 'element', (node) => {
    // `srcSet` is stripped from EVERY element, UNCONDITIONALLY — not gated on
    // consent the way `src` is, and not limited to `img`. Two independent
    // reasons, both verified rather than assumed. (1) `hast-util-sanitize`'s
    // default schema allows `source[srcSet]` with NO entry in its `protocols`
    // map at all (its `protocols` covers only `cite`/`href`/`longDesc`/`src`),
    // so unlike `src` there is no scheme allowlist behind it — a `<picture>
    // <source srcset="https://evil.com/x.png">` written as raw HTML survived
    // sanitize AND this function completely untouched, confirmed empirically.
    // (2) Nothing in this app's Markdown pipeline ever PRODUCES a `srcSet` or a
    // `<picture>`/`<source>`; they can only come from raw HTML in a document
    // this codebase treats as untrusted, so there is no legitimate authoring
    // use case to preserve. Honoring it even WITH consent would mean honoring
    // an attribute carrying no protocol restriction whatsoever, which is why
    // this is not merely `if (!allowRemoteImages)`. Note `img[srcSet]` is
    // already dropped by sanitize's own attribute allowlist today; including it
    // here is deliberate defense against a future schema change, not
    // redundancy that can be trimmed.
    delete node.properties.srcSet
    if (allowRemoteImages) return
    if (node.tagName !== 'img') return
    const src = node.properties.src
    if (typeof src !== 'string') return
    if (isRemoteImageSrc(src)) {
      delete node.properties.src
    }
  })
}

export function markdownToHtml(
  source: string,
  options?: { assetToken?: string; allowRemoteImages?: boolean }
): { html: string; sourceMap: SourceMap; warnings: DocumentWarning[] } {
  // unified's `.parse()` only performs the parse phase — it does NOT run
  // attached transformers (remarkPagebreak's tree mutation only executes
  // during `.run()`/`.runSync()`). remarkGfm/remarkFrontmatter don't need
  // this because they work by registering micromark/mdast-util-from-markdown
  // syntax extensions that `.parse()` itself consults, not by mutating the
  // tree after the fact — but remarkPagebreak IS a post-parse tree mutation,
  // so it needs an explicit `.runSync()` on the same processor instance
  // (same instance matters: that's what carries the attached transformer).
  // singleDollarTextMath: false is a deliberate deviation from remark-math's
  // own default (true). With the default on, `$...$` alone is enough to open
  // inline math -- and micromark-extension-math's mathText tokenizer (read
  // directly, not assumed) has NO Pandoc-style "closing $ must not be
  // followed by a digit" guard the way Pandoc's own tex_math_dollars
  // convention does: it only requires a LATER, matching single `$` anywhere
  // ahead on the same run of lines. Concretely, "grew from $50K to $120K"
  // parses as inline math spanning "50K to " (opening `$` before "50K",
  // closing `$` right before "120K"), silently swallowing a real, extremely
  // common construct in THIS app's own stated primary use case -- reports,
  // résumés, letters routinely quote dollar figures in running prose. That
  // is a much higher base-rate collision than the \newpage/\pagebreak
  // prose-mention edge case pagebreak-plugin.ts describes (which used to be
  // an accepted loss and is now lossless -- see `Pagebreak#raw` there),
  // so this too is prevented rather than accepted, by a different means:
  // there is nothing to "preserve" for a mis-tokenized currency figure the
  // way there is for a recognized page-break literal, so the tokenizer has
  // to be narrowed instead.
  // Requiring a DOUBLED delimiter for inline math (`$$x^2$$` inline, on one
  // line, distinct from a `$$` block fence alone on its own line -- the two
  // are different tokenizer constructs and don't collide) costs a little
  // typing friction but makes an accidental match require two consecutive,
  // adjacent, unescaped `$$` on both sides -- not a pattern that occurs by
  // accident in ordinary currency prose.
  const parseProcessor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkMath, { singleDollarTextMath: false })
    .use(remarkPagebreak)
    .use(remarkComment)

  const parsedTree = parseProcessor.parse(source) as Root
  const tree = parseProcessor.runSync(parsedTree) as Root

  const sourceMap = annotateSourceOffsets(tree, source)

  // A second `visit()` over the tree `remarkPagebreak` just promoted --
  // NOT a second markdown parse (see collectPagebreakWarnings' own header
  // comment in pagebreak-plugin.ts). Computed here, alongside sourceMap
  // above, and actually threaded out through this function's return value
  // -- unlike sourceMap itself, which the 2026-08-09 design-doc gap audit's
  // B1 finding flags as computed-and-discarded by every production call
  // site. Don't repeat that mistake for warnings: every call site below
  // that only destructures `{ html }` is fine (a DocumentWarning with no
  // consumer is harmless), but at least one real consumer must exist, and
  // does -- see page-count-generator.ts's `getPageCount`.
  const warnings = collectPagebreakWarnings(tree)

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
      handlers: {
        pagebreak: createPagebreakToHast(tokenClassName),
        math: createMathBlockToHast(),
        inlineMath: createMathInlineToHast(),
        comment: createCommentToHast()
      }
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

  // Same "after sanitize" ordering requirement as rewriteLocalImageSrcs
  // above, for the same reason: nothing about this needs to run before
  // sanitize(), and running after means it also catches a remote `<img>`
  // written directly as raw HTML in the document's own source, not just one
  // produced from `![]()` syntax -- by this point in the pipeline both have
  // already been merged into the same flat hast tree with no way (or need)
  // to tell them apart.
  // Called UNCONDITIONALLY, with consent passed in rather than gating the call
  // -- the `srcSet` half of this policy applies even when remote images ARE
  // allowed (see the function's own comment for why an attribute with no
  // protocol allowlist behind it can never be safely honored).
  applyRemoteImagePolicy(sanitized, options?.allowRemoteImages === true)

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

  return { html, sourceMap, warnings }
}
