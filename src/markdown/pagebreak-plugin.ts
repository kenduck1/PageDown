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

export function remarkPagebreak() {
  return (tree: Root): void => {
    visit(tree, 'html', (node: Html, index, parent: Parent | undefined) => {
      if (index === undefined || !parent) return
      if (!BLOCK_CONTAINER_TYPES.has(parent.type)) return
      if (node.value.trim() !== PAGEBREAK_MARKER) return

      const pagebreak: Pagebreak = { type: 'pagebreak', position: node.position }
      parent.children[index] = pagebreak
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
