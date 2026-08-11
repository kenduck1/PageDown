import { imageSchema } from '@milkdown/preset-commonmark'
import { $remark } from '@milkdown/utils'
import { formatAttributeBlock, remarkImageAttrs } from '../../../../markdown/image-size'

// The SAME transform markdownToHtml runs -- one matcher, so the canvas and the
// paginator cannot disagree about what is a size and what is prose. That
// matters more here than for the other markers: Gate 10 pins the two surfaces
// at 0.000px, and an image sized on only one of them would be a large,
// obvious divergence rather than a subtle one.
export const imageAttrsRemark = $remark('remarkImageAttrs', () => remarkImageAttrs)

// Adds a `width` attr to @milkdown/preset-commonmark's stock `image` node, so
// a `![alt](photo.png){width=50%}` size survives a Format-mode edit instead of
// being silently dropped the first time the document is saved.
//
// MECHANISM: Milkdown's own sanctioned `$nodeSchema#extendSchema`, registered
// AFTER `commonmark` in plugins.ts -- the same last-registration-wins override
// contract table-cell-empty-fix.ts and list-spread-fix.ts already document at
// length. Every field this file does not name is spread straight through from
// the original spec.
//
// WHY THE ATTR IS NEEDED AT ALL, given `remarkImageAttrs` already recognizes
// the block: parsing recovers the width into the mdast tree, and the editor
// then throws it away the moment it serializes, because the ProseMirror node
// has nowhere to keep it. Exactly the same shape as `Pagebreak#raw`/`Toc#raw`
// -- the plugin-level half is inert on the editing surface without the attr
// half.
//
// WHY toMarkdown EMITS A TEXT SIBLING rather than a replacement `image`
// handler: see the long note at the bottom of src/markdown/image-size.ts. In
// short, a sized image is a stock `image` node plus ordinary text, so
// reimplementing the stock handler (destination escaping, title quoting) would
// risk real fidelity machinery to gain nothing.
export const imageSchemaWithWidth = imageSchema.extendSchema((prev) => (ctx) => {
  const spec = prev(ctx)
  return {
    ...spec,
    attrs: {
      ...spec.attrs,
      // Default '' rather than undefined, matching pagebreakNode's `raw`:
      // ProseMirror attrs must be JSON-serializable and a missing attr is not
      // distinguishable from an explicit undefined in toDOM/parseDOM.
      width: { default: '', validate: 'string' }
    },
    // The stock rule is wrapped rather than replaced so its own `title`
    // fallback-to-alt behaviour (read directly from the preset's source) keeps
    // working without being restated here and drifting.
    parseDOM: (spec.parseDOM ?? []).map((rule) => ({
      ...rule,
      getAttrs: (dom: HTMLElement | string) => {
        const base = rule.getAttrs?.(dom as never)
        if (base === false || base === null) return base
        const element = dom as HTMLElement
        return {
          ...base,
          width: typeof element.getAttribute === 'function' ? element.getAttribute('width') : ''
        }
      }
    })),
    toDOM: (node) => {
      // The stock toDOM spreads `...node.attrs` onto the <img>, so a
      // width-less image would otherwise emit a literal `width=""`. Harmless
      // to render, but it round-trips back in through parseDOM and makes every
      // copied image look like it carries a size.
      const dom = spec.toDOM?.(node) as [string, Record<string, unknown>, ...unknown[]]
      if (dom && dom[1] && !dom[1].width) delete dom[1].width
      return dom
    },
    parseMarkdown: {
      match: spec.parseMarkdown.match,
      // Restates the stock runner's three attrs rather than delegating,
      // because a runner's whole job is the `state.addNode` call and there is
      // no way to append one more attr to a call somebody else makes. Kept
      // byte-comparable to the preset's own version (read from
      // @milkdown/preset-commonmark's node/image.ts) so a future upgrade diff
      // is obvious.
      runner: (state, node, type) => {
        state.addNode(type, {
          src: node.url,
          alt: node.alt,
          title: node.title,
          width: typeof node.width === 'string' ? node.width : ''
        })
      }
    },
    toMarkdown: {
      match: spec.toMarkdown.match,
      runner: (state, node) => {
        state.addNode('image', undefined, undefined, {
          title: node.attrs.title,
          url: node.attrs.src,
          alt: node.attrs.alt
        })
        const width = typeof node.attrs.width === 'string' ? node.attrs.width : ''
        if (width) state.addNode('text', undefined, formatAttributeBlock(width))
      }
    }
  }
})
