// The two pure predicates/normalizers that answer "is this `<img src>` a
// document-relative local reference, and what real relative filesystem path
// does it correspond to?" -- extracted verbatim out of `pipeline.ts` (which
// still re-exports both, so every pre-existing import site is unchanged)
// for exactly one reason: a THIRD consumer now needs them, and that consumer
// runs in the privileged app-shell RENDERER.
//
// `src/renderer/src/milkdown/image-security.ts` has to decide, per image
// node, whether a src is a local reference worth asking the main process to
// resolve. Importing `pipeline.ts` to get that answer would drag the entire
// Markdown pipeline -- `unified`, every `remark-*`/`rehype-*` plugin, and
// `rehype-highlight`'s 37-grammar "common" bundle -- into the renderer's own
// bundle, which today imports none of it (confirmed by grep: no renderer
// source file outside a test imports `markdown/pipeline`). Re-implementing
// the test in the renderer instead was the other option and is worse: this
// exact "is this a local image reference" question is now asked in three
// places (rewrite-to-asset-scheme in `pipeline.ts`, inline-to-data-URI in
// `main/inline-local-images.ts`, and resolve-for-the-canvas in the
// renderer), and CLAUDE.md already records the two-consumer version of that
// coupling as something to keep from drifting. Three copies would drift
// three ways.
//
// Deliberately dependency-free (no `unified`, no `node:*`, no `electron`) so
// it can be imported from the main process, the renderer, and a plain
// Vitest test alike -- the same constraint `src/typography/page-geometry.ts`
// and `src/pagination/page-nav.ts` already carry for the sandboxed bundle.

// A leading URL scheme (`http:`, `https:`, `data:`, `pagedown-render:`, ...)
// per RFC 3986's `scheme` production. Anything matching this is already an
// absolute reference and must be left untouched by rewriteLocalImageSrcs.
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i

// True only for a relative, document-local path — no leading `/` (an
// absolute filesystem path, denied by resolveAssetPath on the main-process
// side anyway, but never even worth routing through the __asset__ scheme)
// and no URL scheme prefix (http(s), data:, pagedown-render:, ...).
// Reused by src/main/inline-local-images.ts (HTML export's data:-URI
// inlining) and src/renderer/src/milkdown/image-security.ts (the editor
// canvas's own resolution), so all three "is this a local image reference"
// questions in this codebase are literally the same function rather than
// three regexes that agree today.
export function isRelativeLocalPath(src: string): boolean {
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
export function urlToRelativePath(src: string): string {
  try {
    return decodeURIComponent(src)
  } catch {
    return src
  }
}

// Anchored at the COLON, not at `://`, and matching a leading `//` too.
// Both details were real, shipped bypasses caught in the remote-image-consent
// review and are documented at length at pipeline.ts's applyRemoteImagePolicy:
// `http:evil.com/x.png` (no slashes) is a genuinely fetchable remote URL,
// because per the WHATWG URL spec's "special authority ignore slashes state"
// a special scheme enters authority parsing regardless of slash count
// (`new URL('http:evil.com/x.png').href` is `http://evil.com/x.png`); and a
// protocol-relative `//host` resolves against whatever scheme the consuming
// context uses, which is architecture-dependent rather than reliably inert.
//
// THIS FUNCTION EXISTS TO COLLAPSE TWO HAND-SYNCED COPIES INTO ONE, and that
// is the whole point of it living in this dependency-free module rather than
// being defined next to either consumer. `pipeline.ts` (the real per-render
// ENFORCEMENT) and `renderer/src/lib/detectRemoteImages.ts` (which only
// decides whether to OFFER the consent banner) each carried their own
// identical regex, with a comment on each saying it must be kept in lockstep
// with the other -- and noting that the two disagreeing would be worse than
// either being wrong alone, since the banner would report "no remote images"
// for a document the pipeline was actively blocking. A third copy was about
// to be added for the editor canvas's own blocked-image message; one shared
// predicate is what makes that class of drift impossible instead of merely
// discouraged. (detectRemoteImages.ts's RAW_HTML_IMG_SRC_PATTERN still
// embeds the same scheme alternation inline, because it needs it as a
// fragment inside a larger tag-matching regex rather than as a whole-string
// test -- that one copy remains, and remains commented as such.)
const REMOTE_SRC_PATTERN = /^\s*(?:https?:|\/\/)/i

export function isRemoteImageSrc(src: string): boolean {
  return REMOTE_SRC_PATTERN.test(src)
}
