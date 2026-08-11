import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import { visit } from 'unist-util-visit'
import type { Root, Image, ImageReference, Definition, Html } from 'mdast'
import { isRemoteImageSrc } from '../../../markdown/local-image-src'

// Anchored at the COLON, not at `://`, and matching a leading `//` too, for
// the reason documented at length at pipeline.ts's applyRemoteImagePolicy:
// `http:evil.com/x.png` (no slashes) is a genuinely fetchable remote URL that
// every WHATWG-conformant parser normalizes to `http://evil.com/x.png`. A
// `://`-anchored pattern misses it. Here the consequence is milder than in the
// pipeline (the image is still blocked; the user just isn't offered the
// prompt) but it is the same bug.
//
// This used to be a hand-synced SECOND COPY of pipeline.ts's own regex, with a
// comment on each asking a future reader to keep the two in lockstep -- the
// two disagreeing would be worse than either being wrong alone, since this
// banner would report "no remote images" for a document the pipeline was
// actively blocking. Both now call one shared predicate
// (src/markdown/local-image-src.ts's isRemoteImageSrc, in a deliberately
// dependency-free module so importing it here costs this renderer bundle
// nothing), so that drift is impossible rather than merely discouraged.
// RAW_HTML_IMG_SRC_PATTERN just below still embeds the same scheme
// alternation inline, because it needs it as a FRAGMENT of a larger
// tag-matching regex rather than as a whole-string test -- that one copy
// remains, deliberately.
//
// Deliberately narrow -- only needs to catch the common `<img src="...">`
// shape well enough to decide whether to show the consent banner at all;
// the actual per-render enforcement (src/markdown/pipeline.ts's
// applyRemoteImagePolicy) runs on the real, fully-parsed hast tree and is
// what's actually load-bearing for security. A false negative here means
// the banner doesn't appear for an unusual raw-HTML construct this regex
// misses -- the image would still be silently blocked by pipeline.ts's own
// default-closed behavior, not silently allowed.
// No `g` flag: this is only ever used with .test() for a single true/false
// check per node, and a `g`-flagged regex's stateful `lastIndex` would
// silently skip matches across repeated .test() calls on different strings
// within the same visit() traversal below.
// Also matches a `srcset` (on any tag, so `<picture><source srcset=...>` is
// covered) -- that attribute carries NO protocol allowlist through
// hast-util-sanitize, so the pipeline strips it unconditionally; detecting it
// here keeps the banner honest about a document that genuinely reaches for
// remote content. Scheme matching is colon-anchored for the same reason
// isRemoteImageSrc is.
const RAW_HTML_IMG_SRC_PATTERN =
  /<img\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:|\/\/)|<[a-z][^>]*\bsrcset\s*=\s*["']?\s*(?:https?:|\/\/)/i

/**
 * Returns true if `source`'s Markdown references at least one remote
 * (http/https) image -- via `![alt](https://...)`, a resolved reference-style
 * image (`![alt][ref]` + `[ref]: https://...`), or a raw HTML `<img src="http...">`
 * tag. Used only to decide whether to show the remote-image consent banner
 * (EditorScreen) -- see pipeline.ts's stripRemoteImageSrcs for where consent
 * is actually enforced.
 *
 * Uses the exact same parse-time plugin stack as markdownToHtml
 * (src/markdown/pipeline.ts): remark-parse + remark-gfm + remark-frontmatter --
 * see extractOutline.ts's own comment for why this is a second *processor
 * construction*, not a second, independently-behaving Markdown parser, and
 * why it must be kept in sync if pipeline.ts's parse-time plugin set changes.
 */
export function documentHasRemoteImages(source: string): boolean {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .parse(source) as Root

  let found = false
  const definitions = new Map<string, string>()

  visit(tree, (node) => {
    if (found) return
    if (node.type === 'image' && isRemoteImageSrc((node as Image).url)) {
      found = true
    } else if (node.type === 'definition') {
      const def = node as Definition
      definitions.set(def.identifier, def.url)
    } else if (node.type === 'html' && RAW_HTML_IMG_SRC_PATTERN.test((node as Html).value)) {
      found = true
    }
  })
  if (found) return true

  // A second pass for imageReference nodes: definitions can appear anywhere
  // in the document, including AFTER the reference that uses them, so
  // resolving references requires the full definitions map above to have
  // already been built.
  visit(tree, 'imageReference', (node: ImageReference) => {
    if (found) return
    const url = definitions.get(node.identifier)
    if (url && isRemoteImageSrc(url)) {
      found = true
    }
  })

  return found
}
