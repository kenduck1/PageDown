import { visit } from 'unist-util-visit'
import type { Root, Html, Text, Parent } from 'mdast'
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

// Common alternate page-break conventions from other Markdown toolchains,
// recognized on parse and normalized to the canonical PAGEBREAK_MARKER on
// serialize (remarkPagebreakToMarkdown below already always emits
// PAGEBREAK_MARKER regardless of which syntax matched here -- no change
// needed there) -- per the master design doc's File Format section.
// Tolerant of quote style, internal whitespace, and an optional trailing
// semicolon, but otherwise matches this exact, narrow convention -- not an
// open-ended "any div mentioning page-break-after" matcher.
const PAGE_BREAK_DIV_RE =
  /^<div\s+style\s*=\s*(["'])page-break-after\s*:\s*always\s*;?\s*\1\s*>\s*<\/div>$/i

// LaTeX/Pandoc raw commands. Case-sensitive -- these are literal command
// names, not free text a user might casually capitalize differently.
const PAGEBREAK_TEXT_COMMANDS = new Set(['\\newpage', '\\pagebreak'])

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
  if (node.type !== 'html') return false
  const trimmed = (node as Html).value.trim()
  return trimmed === PAGEBREAK_MARKER || PAGE_BREAK_DIV_RE.test(trimmed)
}

function isMatchingTextCommand(node: { type: string; value?: string }): node is Text {
  return node.type === 'text' && PAGEBREAK_TEXT_COMMANDS.has((node as Text).value.trim())
}

// A leaf that counts as a pagebreak when it's the sole content of its
// paragraph -- either raw HTML (the comment or the div convention) or a
// raw-text LaTeX/Pandoc command.
function isPagebreakLeaf(node: { type: string; value?: string }): boolean {
  return isMatchingHtml(node) || isMatchingTextCommand(node)
}

export function remarkPagebreak() {
  return (tree: Root): void => {
    visit(tree, (node, index, parent: Parent | undefined) => {
      if (index === undefined || !parent) return

      // Raw HTML (the comment or the div convention) as a direct child of a
      // block container -- the shape plain remark-parse produces for
      // block-level HTML. \newpage/\pagebreak never reach this branch: as
      // plain text they can only ever be paragraph content, never a direct,
      // unwrapped child of root/blockquote/footnoteDefinition.
      if (isMatchingHtml(node) && BLOCK_CONTAINER_TYPES.has(parent.type)) {
        const pagebreak: Pagebreak = { type: 'pagebreak', position: node.position }
        parent.children[index] = pagebreak
        return
      }

      // A paragraph whose SOLE child is a matching leaf. Two structurally
      // distinct reasons this shape arises, both handled by the same check:
      // (1) preset-commonmark's remarkHtmlTransformer reparents a block-level
      // html node into paragraph{[html]} before this plugin runs, inside
      // Milkdown's internal pipeline only -- markdownToHtml's plain
      // remark-parse pipeline never produces this shape for raw HTML at all
      // (a real block-level marker parses as a direct root>html child, not
      // paragraph-wrapped). (2) \newpage/\pagebreak, being plain text, are
      // ALWAYS paragraph content in every pipeline -- CommonMark has no
      // "bare text" block type -- so this branch is what promotes them,
      // identically in markdownToHtml's plain pipeline and Milkdown's.
      if (
        node.type === 'paragraph' &&
        (node as Parent).children.length === 1 &&
        isPagebreakLeaf((node as Parent).children[0]) &&
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
