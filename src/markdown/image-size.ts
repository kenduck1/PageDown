import { visit } from 'unist-util-visit'
import type { Root, Image, ImageReference, Text, Parent } from 'mdast'
import { DPI } from '../typography/page-geometry'

// `import type` above is deliberate for PageConfig-shaped modules elsewhere in
// this tree; DPI is a plain number constant and is imported for real, on
// purpose. Restating 96 here would put a second copy of the app's one
// device-pixel-ratio assumption in a file that has to agree with the page box
// exactly -- `{width=3in}` has to mean the same three inches the margins do.

declare module 'mdast' {
  interface Image {
    /**
     * Rendered width, already normalized to a CSS-legal `NN%` or an integer
     * pixel count as a bare string (never a unit this app's own renderers
     * would have to re-interpret). Set by `remarkImageAttrs` from a trailing
     * `{width=...}` attribute block; absent when the author wrote none.
     */
    width?: string
  }
  interface ImageReference {
    width?: string
  }
}

/**
 * A trailing attribute block, anchored at the very start of the text node that
 * follows an image. Pandoc's own `link_attributes` extension and
 * `remark-attr` both use this shape, which is why it was chosen over the two
 * alternatives considered:
 *
 *   - `![alt|50%](photo.png)` (a pipe inside the alt text) is not a
 *     convention anything else reads, and it destroys the alt text -- the one
 *     part of an image that has real accessibility meaning.
 *   - `<img src="photo.png" width="50%">` already works today (raw HTML
 *     survives this pipeline, and `width` is in hast-util-sanitize's own
 *     allowlist). It is not a substitute: raw HTML is not what the WYSIWYG
 *     canvas edits, it defeats the local-asset rewrite that makes relative
 *     paths resolve, and telling a user of a Markdown editor to hand-write
 *     HTML to resize a logo is the failure this feature exists to remove.
 *
 * Only `width` is recognized, and the block must contain NOTHING else -- see
 * `parseAttributeBlock` for why `height` is not merely unimplemented.
 */
const ATTRIBUTE_BLOCK_RE = /^\{([^{}]*)\}/

// `50%`, `200px`, `200`, `3in`, `2.5cm`, `20mm`, `144pt`. Bare numbers are
// pixels, matching the HTML `width` attribute's own meaning.
const WIDTH_VALUE_RE = /^(\d+(?:\.\d+)?)(%|px|in|cm|mm|pt)?$/

const PX_PER_UNIT: Record<string, number> = {
  px: 1,
  in: DPI,
  // 2.54cm to the inch; 25.4mm; 72pt. Converted HERE, to px, rather than
  // emitted as a CSS unit, because the value's destination is the HTML
  // `width` presentational attribute -- see `applyWidth`'s own comment.
  cm: DPI / 2.54,
  mm: DPI / 25.4,
  pt: DPI / 72
}

/**
 * Turns one attribute-block body into a normalized width, or `null` if the
 * block is not one this pipeline understands.
 *
 * Returning `null` for an unrecognized block means the block is LEFT IN THE
 * DOCUMENT as literal text. That is the deliberate failure mode: a user who
 * writes `{hieght=200px}` sees their typo rendered on the page and can fix it,
 * where silently swallowing it would look like the feature is broken.
 *
 * `height` is rejected rather than supported, and it is worth recording why,
 * because "add height too" looks like a two-line change and is not. Both
 * surfaces set `height: auto` on document images -- the shared
 * document-typography.css rule on the paginated side, and Tailwind Preflight's
 * own `img { max-width: 100%; height: auto }` on the editor side. An author
 * stylesheet beats a presentational hint in the cascade, so an emitted
 * `height="200"` attribute would be overridden and do nothing, on both
 * surfaces. Making it bite would require either a real `style` attribute
 * (which this pipeline's sanitize schema deliberately does not allow, since
 * the value would be author-controlled CSS) or a generated class with the
 * value baked in (which `markdownToHtml` has no stylesheet to emit into --
 * the two consuming surfaces build their own). Width alone is also what
 * actually matters for the stated use case: with `height: auto` a width sets
 * the rendered size and preserves the aspect ratio.
 */
export function parseAttributeBlock(body: string): string | null {
  const pairs = body.trim().split(/\s+/).filter(Boolean)
  if (pairs.length !== 1) return null

  const [key, rawValue] = pairs[0].split('=')
  if (key !== 'width' || rawValue === undefined) return null

  const match = WIDTH_VALUE_RE.exec(rawValue.replace(/^["']|["']$/g, ''))
  if (!match) return null

  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return null

  const unit = match[2]
  if (unit === '%') {
    // Clamped at 100%: a percentage resolves against the content box, so
    // anything larger is already capped by `max-width: 100%` on both surfaces
    // -- normalizing here means the attribute value and what is actually
    // painted agree, rather than the document claiming 400% forever.
    return `${Math.min(100, amount)}%`
  }

  const px = amount * (PX_PER_UNIT[unit ?? 'px'] ?? 1)
  // Rounded to a whole pixel because that is what the HTML dimension
  // attribute's own parsing rules produce anyway; keeping the fraction would
  // only create a value that reads back differently than it renders.
  return String(Math.max(1, Math.round(px)))
}

/**
 * The inverse, for serializing back to Markdown. A normalized width is always
 * either `NN%` or a bare integer, so this never has to re-derive a unit.
 */
export function formatAttributeBlock(width: string): string {
  return width.endsWith('%') ? `{width=${width}}` : `{width=${width}px}`
}

// The normalized width goes onto the `<img>` VERBATIM -- a percentage stays a
// percentage, a pixel count stays a bare integer -- because the HTML `width`
// content attribute is a "dimension attribute" whose parsing rules accept
// exactly those two forms and map them to a presentational hint for the CSS
// `width` property. That is the whole reason this feature needs no `style`
// attribute, no sanitize schema change and no new CSS: `width` is already in
// hast-util-sanitize's default `'*'` allowlist (verified against its own
// schema, not assumed), so the value survives the pipeline untouched.
//
// It is also why `parseAttributeBlock` must convert `3in`/`2cm`/`144pt` to
// pixels rather than passing the unit through: HTML's dimension parsing stops
// at the first non-digit, so `width="3in"` would silently render as three
// PIXELS.
function applyWidth(node: Image | ImageReference, width: string): void {
  node.width = width
  // `mdast-util-to-hast`'s own image/imageReference handlers both end in
  // `state.applyData(node, result)`, which merges `data.hProperties` onto the
  // emitted element -- so this needs no custom hast handler at all, unlike the
  // pagebreak/toc/math nodes. Set here rather than in a separate hast pass so
  // the two consumers (markdownToHtml, and Milkdown's own parse) share exactly
  // one place where a width is recognized.
  const data = (node.data ??= {})
  const hProperties = ((data as { hProperties?: Record<string, unknown> }).hProperties ??= {})
  hProperties.width = width
}

/**
 * Consumes a trailing `{width=...}` block written immediately after an image
 * and records it on the image node itself.
 *
 * Shared by BOTH consumers, the same way `remarkPagebreak`/`remarkToc` are:
 * `markdownToHtml` (every rendering surface) and Milkdown's own internal parse
 * pipeline. One matcher, so the canvas and the paginator cannot disagree about
 * what is a size and what is prose -- which matters more here than for the
 * other markers, because Gate 10 pins the two surfaces at 0.000px and an image
 * sized on only one of them would be a large, obvious divergence.
 *
 * The block must be the START of the immediately-following text node. Anything
 * after it in that same text node is preserved verbatim, so
 * `![a](b.png){width=50%} and then some prose` keeps its prose.
 */
export function remarkImageAttrs() {
  return (tree: Root): void => {
    visit(tree, (node, index, parent: Parent | undefined) => {
      if (index === undefined || !parent) return
      if (node.type !== 'image' && node.type !== 'imageReference') return

      const next = parent.children[index + 1]
      if (!next || next.type !== 'text') return

      const match = ATTRIBUTE_BLOCK_RE.exec((next as Text).value)
      if (!match) return

      const width = parseAttributeBlock(match[1])
      if (width === null) return

      applyWidth(node as Image | ImageReference, width)

      const remainder = (next as Text).value.slice(match[0].length)
      if (remainder.length === 0) {
        parent.children.splice(index + 1, 1)
      } else {
        // Position is deliberately dropped for a partially-consumed text node
        // rather than adjusted: source-map.ts derives offsets from
        // `position.start.offset`, and a stale start offset pointing at the
        // `{` we just removed would be worse than none at all.
        const rest = next as Text
        rest.value = remainder
        delete rest.position
      }
    })
  }
}

// THERE IS DELIBERATELY NO `remarkImageAttrsToMarkdown` COUNTERPART, unlike
// every other custom node in this pipeline (pagebreak, toc, comment), and the
// asymmetry is worth stating so nobody "completes the set" by adding one.
//
// Those nodes need a serializer because they are node TYPES
// `mdast-util-to-markdown` has never heard of. A sized image is not a new
// type: it is a stock `image` node plus one extra field, and the block itself
// is ordinary TEXT. So the way back out is for the ProseMirror image node's
// own `toMarkdown` runner to emit a plain text sibling carrying
// `formatAttributeBlock(width)` -- see image-width-schema.ts. The stock
// handlers then serialize both correctly, and, verified empirically rather
// than assumed, WITHOUT escaping: `{`, `}` and `%` are not in
// mdast-util-to-markdown's unsafe set, and `=` is unsafe only at the start of
// a line (where it would be a Setext underline), which a node sitting
// immediately after an image never is.
//
// Replacing the stock `image` handler instead was considered and rejected: it
// would mean reimplementing destination escaping (angle-bracket wrapping for a
// URL containing spaces or parens) and title quoting, which is exactly the
// fidelity machinery this project has already been bitten by.
