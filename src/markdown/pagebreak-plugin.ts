import { visit } from 'unist-util-visit'
import type { Root, Html, Parent } from 'mdast'
import type { Node } from 'unist'
import type { Processor } from 'unified'

export interface Pagebreak extends Node {
  type: 'pagebreak'
}

declare module 'mdast' {
  interface RootContentMap {
    pagebreak: Pagebreak
  }
}

const PAGEBREAK_MARKER = '<!-- pagebreak -->'

export const PAGEBREAK_CLASS = 'pagedown-pagebreak'

// Only these mdast node types admit block-level HTML as a direct child per
// CommonMark's own grammar. Deliberately an allowlist, not a denylist of
// known phrasing-content types (paragraph, heading, strong, emphasis,
// delete, link, linkReference, ...): a denylist silently promotes any
// phrasing container nobody thought to exclude, while this allowlist's
// worst case is a safe false negative (fails to promote in some future
// block container we haven't enumerated). `listItem` is deliberately
// excluded — the master design doc states breaks inside list items are
// unsupported in v1 (docs/superpowers/specs/2026-07-25-pagedown-design.md,
// File Format section). GFM table cells need no exclusion: their grammar
// only admits inline content, so a marker inside one is always inline
// `html`, never reaching a block-container parent at all.
const BLOCK_CONTAINER_TYPES = new Set(['root', 'blockquote', 'footnoteDefinition'])

function isMatchingHtml(node: { type: string; value?: string }): node is Html {
  return node.type === 'html' && (node as Html).value.trim() === PAGEBREAK_MARKER
}

export function remarkPagebreak() {
  return (tree: Root): void => {
    visit(tree, (node, index, parent: Parent | undefined) => {
      if (index === undefined || !parent) return

      if (isMatchingHtml(node) && BLOCK_CONTAINER_TYPES.has(parent.type)) {
        const pagebreak: Pagebreak = { type: 'pagebreak', position: node.position }
        parent.children[index] = pagebreak
        return
      }

      // preset-commonmark's remarkHtmlTransformer reparents a block-level
      // html node into `paragraph { children: [html] }` before this plugin
      // runs, inside Milkdown's internal pipeline only — markdownToHtml's
      // plain remark-parse pipeline never produces this shape at all,
      // verified directly (neither a real block-level marker, which parses
      // as a direct root>html child, nor a mid-paragraph inline occurrence,
      // which stays embedded among text siblings, ever produces a paragraph
      // whose SOLE child is a matching html node) — so matching it here is
      // safe without checking which pipeline produced it. `parent` here is
      // the paragraph's OWN parent — i.e. what would have been the html
      // node's grandparent before preset-commonmark's reparenting — so the
      // same BLOCK_CONTAINER_TYPES check applies: preset-commonmark's own
      // reparenting trigger includes `listItem` (not just `root`/
      // `blockquote`), and without this check a marker inside a list item
      // would incorrectly activate here even though it's excluded above and
      // "unsupported in v1" per the design doc — verified this exact gap
      // empirically before adding this check (a real Milkdown editor
      // instance produced a `pagebreak` node inside a `list_item` without
      // it, and correctly left it inert with it).
      if (
        node.type === 'paragraph' &&
        (node as Parent).children.length === 1 &&
        isMatchingHtml((node as Parent).children[0]) &&
        BLOCK_CONTAINER_TYPES.has(parent.type)
      ) {
        const pagebreak: Pagebreak = {
          type: 'pagebreak',
          position: (node as Parent).children[0].position
        }
        parent.children[index] = pagebreak
      }
    })
  }
}

// Teaches mdast-util-to-markdown (the serializer remark-stringify wraps)
// how to print a `pagebreak` node — needed only by Milkdown's internal
// remark pipeline, which serializes ProseMirror content back to Markdown
// text. markdownToHtml never serializes back to Markdown, so it never
// needs this half of the plugin — only the parse-time transform above.
//
// `this` must be accessed directly in the attacher body, not in a returned
// transformer: unified only binds `this` to the processor for the attacher
// call itself (`attacher.call(self, ...options)` in unified/lib/index.js's
// `freeze()`). A transformer returned from an attacher is later invoked by
// trough's `wrap()` as a bare function call, so `this` inside it is
// `undefined` — verified empirically (TypeError: Cannot read properties of
// undefined (reading 'data')) and by reading unified's and trough's source.
// This mirrors remark-frontmatter's actual real source
// (node_modules/remark-frontmatter/lib/index.js), which reads `this.data()`
// directly in its attacher body and returns nothing, not a transformer.
export function remarkPagebreakToMarkdown(this: Processor): void {
  const data = this.data() as { toMarkdownExtensions?: unknown[] }
  const extensions = data.toMarkdownExtensions ?? (data.toMarkdownExtensions = [])
  extensions.push({
    handlers: {
      pagebreak() {
        return '<!-- pagebreak -->'
      }
    }
  })
}
