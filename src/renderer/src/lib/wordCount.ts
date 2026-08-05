import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import { visit } from 'unist-util-visit'
import type { Root, Text, InlineCode } from 'mdast'

// Same parser configuration `src/markdown/pipeline.ts`'s own `markdownToHtml`
// uses for parsing (remark-parse + remark-gfm + remark-frontmatter) -- this
// project's "one parser everywhere" rule (see CLAUDE.md) is about not
// introducing a second Markdown *parser*, not about every consumer having to
// route through `markdownToHtml` itself. That function's entire job is
// producing sanitized HTML (remark-rehype + hast-util-raw + hast-util-
// sanitize), none of which word counting needs -- it only ever needs the
// parsed mdast tree. Building a lighter processor with the identical
// parse-affecting plugin set gets the real, shared parser's behavior
// (accurate GFM tables/task-lists, real frontmatter-block recognition)
// without pulling the HTML-conversion machinery into a code path that would
// never use it. `remarkPagebreak` is deliberately NOT included: it only
// matters for HTML output / Milkdown round-tripping, and has zero effect on
// word counting either way (a `<!-- pagebreak -->` marker produces no mdast
// `text` node whether or not it gets promoted to a `pagebreak` node -- see
// EXCLUDED-by-construction note below).
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml'])

// Only mdast `text` and `inlineCode` nodes hold reader-visible prose as
// literal string content directly on the node. Every Markdown syntax marker
// (heading `#`s, list bullets/numbers, emphasis `*`/`_`, link/image
// `[]()`/`![]()` brackets, blockquote `>`) is consumed by remark-parse into
// *structural* node types (heading, listItem, emphasis, link, image,
// blockquote, ...) and never appears in a `text` node's `.value` at all --
// so walking only these two node types is sufficient to get pure prose
// without any separate regex-stripping step.
//
// This also means the "don't count as words" cases fall out for free, with
// no explicit skip-list needed:
// - Frontmatter (`yaml`/`toml` nodes, from remark-frontmatter) is a leaf
//   node whose raw block content lives in `.value` on a node of type
//   `yaml`/`toml`, never `text` -- naturally excluded.
// - Fenced/indented code blocks (`code` nodes) are leaf nodes the same way,
//   type `code` -- naturally excluded. (Inline code -- `inlineCode` -- is
//   deliberately the opposite: it sits inside a running prose sentence, e.g.
//   "run `npm install` first" reads as 4 words to an actual reader, so it IS
//   counted.)
// - Raw HTML (`html` nodes, including a literal `<!-- pagebreak -->` marker
//   that isn't promoted) is also a `.value`-bearing leaf node of type
//   `html`, never `text` -- naturally excluded. Rendered raw-HTML inner text
//   (e.g. `<div>some text</div>`) is intentionally NOT parsed further and
//   counted here -- doing so correctly would need the same HTML
//   reparse/sanitize step `markdownToHtml` performs, which is exactly the
//   machinery this lightweight utility exists to avoid.
// - Image alt/title text is a node *property* (`node.alt`/`node.title`), not
//   a child `text` node, so it's excluded automatically as well.
function isCountableTextNode(node: { type: string }): node is Text | InlineCode {
  return node.type === 'text' || node.type === 'inlineCode'
}

// Splits already-parsed prose into words by whitespace. This is intentionally
// simple (not attempting locale-aware word segmentation) -- by the time a
// node reaches this function, remark-parse has already stripped every
// Markdown syntax marker, so what's left is exactly the plain-text run a
// reader would see, and counting whitespace-delimited runs in
// already-plain-text matches how a reader (and tools like Word/Google Docs)
// think about "word count" for real prose.
const WORD_RE = /\S+/g

/**
 * Returns an accurate count of the real prose words in a raw Markdown
 * document -- i.e. what a reader would see once the document is rendered,
 * not a literal whitespace-split of the raw Markdown source. Frontmatter and
 * fenced/indented code block content are excluded; inline code is included
 * (see the node-type notes above for the full breakdown of what is/isn't
 * counted and why).
 */
export function countWords(markdown: string): number {
  const tree = processor.parse(markdown) as Root
  let count = 0
  visit(tree, (node) => {
    if (!isCountableTextNode(node)) return
    const matches = node.value.match(WORD_RE)
    if (matches) count += matches.length
  })
  return count
}
