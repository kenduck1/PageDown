import type { Element, ElementContent } from 'hast'
import type { Handler } from 'mdast-util-to-hast'
import type { Toc, TocEntry } from './toc-plugin'

function ol(): Element {
  return { type: 'element', tagName: 'ol', properties: {}, children: [] }
}

function li(children: ElementContent[]): Element {
  return { type: 'element', tagName: 'li', properties: {}, children }
}

/**
 * Turns the flat, ordered entry list a `toc` node carries into a really
 * NESTED `<ol>`, one nesting level per heading level.
 *
 * Nesting rather than a flat list with a per-item level class is a
 * sanitize-surface decision as much as a semantic one: `hast-util-sanitize`'s
 * default schema allows no `class` on `li` (and only one specific value on
 * `a`), so a flat list would need a second, broader className exception per
 * heading level, whereas nested `<ol>`s need no attributes at all and are
 * styled entirely by descendant selectors in document-typography.css.
 *
 * A heading sequence that SKIPS a level (h1 then h3) indents by exactly one
 * step rather than two, and never emits a phantom empty entry to hang the
 * deeper list off. A sequence that goes BACKWARDS into a level it skipped
 * (h1, h3, h2) reuses the same nested list for both -- so a malformed heading
 * structure degrades to "flattened within that branch" instead of growing
 * extra empty rows. Neither is a correctness question; both are the
 * least-surprising rendering of a document that is already inconsistent.
 */
function buildList(entries: TocEntry[], clobberPrefix: string): Element {
  const root = ol()
  const stack: { list: Element; depth: number }[] = [{ list: root, depth: entries[0].depth }]

  for (const entry of entries) {
    while (stack.length > 1 && entry.depth < stack[stack.length - 1].depth) stack.pop()

    while (entry.depth > stack[stack.length - 1].depth) {
      const items = stack[stack.length - 1].list.children
      let host = items[items.length - 1] as Element | undefined
      if (!host) {
        host = li([])
        items.push(host)
      }
      const last = host.children[host.children.length - 1] as Element | undefined
      let nested = last
      if (!nested || nested.type !== 'element' || nested.tagName !== 'ol') {
        nested = ol()
        host.children.push(nested)
      }
      stack.push({ list: nested, depth: entry.depth })
    }

    stack[stack.length - 1].list.children.push(
      li([
        {
          type: 'element',
          tagName: 'a',
          // The DOM-clobbering prefix is applied HERE, on the href, and
          // nowhere else -- `remarkToc` stamps the heading's `id` BARE.
          // `hast-util-sanitize` unconditionally prefixes every `id` it sees
          // (confirmed in pipeline.ts's own `undoDoubleClobberPrefix`
          // comment, which exists because of the same machinery) but never
          // touches `href`, which is not in its clobber list. So pre-applying
          // the prefix on this side is exactly what makes the two ends match
          // after sanitization -- and it is why the anchors survive without
          // any new schema exception, without a post-sanitize fixup pass, and
          // without re-treading the footnote id/href bug that same comment
          // documents. `clobberPrefix` is passed in rather than restated,
          // because pipeline.ts already threads one shared constant into BOTH
          // `remarkRehype` and the sanitize schema for precisely this reason.
          properties: { href: `#${clobberPrefix}${entry.anchorId}` },
          children: [{ type: 'text', value: entry.text }]
        }
      ])
    )
  }

  return root
}

/**
 * `className` is this render's own unguessable token class, not the stable
 * public `pagedown-toc` -- pipeline.ts swaps it back at the very end. Same
 * mechanism, and the same reason, as `createPagebreakToHast`: the sanitize
 * schema exception that lets this `div` keep a class must not be one a
 * document author's own raw HTML can type out and forge.
 */
export function createTocToHast(className: string, clobberPrefix: string): Handler {
  return (state, node) => {
    const toc = node as Toc
    const entries = Array.isArray(toc.entries) ? toc.entries : []
    const result: Element = {
      type: 'element',
      tagName: 'div',
      properties: { className: [className] },
      // An empty container rather than a "no headings" placeholder: this is
      // print output, and a document whose TOC is empty should print nothing
      // there (document-typography.css hides `:empty`). The user is told
      // separately, and only in the editor, by `collectTocWarnings` and by
      // the canvas's own placeholder -- neither of which is document content.
      children: entries.length > 0 ? [buildList(entries, clobberPrefix)] : []
    }
    state.patch(node, result)
    // `applyData` is SAFE here, unlike in math-to-hast.ts: that module has to
    // avoid it because `mdast-util-math` stamps its own `data.hName`/
    // `data.hChildren` onto every math node at PARSE time, which applyData
    // would honour instead of the placeholder shape. A `toc` node is this
    // project's own type and never carries `data` at all, so applyData is a
    // no-op that keeps this handler shaped like `createPagebreakToHast`.
    return state.applyData(node, result)
  }
}
