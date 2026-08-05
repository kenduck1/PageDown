import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import { visit, SKIP } from 'unist-util-visit'
import type { Node } from 'unist'
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
//
// Only `['yaml']` is passed here, matching `pipeline.ts`'s own real config
// exactly -- a `+++`-delimited TOML frontmatter block is NOT recognized as
// frontmatter by this parser configuration at all (remark-frontmatter would
// need `['yaml', 'toml']` for that), so unlike a real `---`-delimited YAML
// block, TOML frontmatter content is NOT excluded from the word count below
// -- it just parses as ordinary paragraph text and counts as prose, the same
// (mis-)behavior the shared pipeline already has for TOML frontmatter. Not
// fixed here since it's a pre-existing characteristic of the shared parse
// config this file deliberately mirrors, not something specific to word
// counting.
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml'])

// Node types whose children are held directly as PHRASING (inline) content
// per mdast/GFM's grammar -- i.e. the "leaf blocks" that actually contain
// reader-visible running text. This is deliberately an exhaustive enumerate
// of the mdast+gfm grammar's leaf-block types, not every node with a
// `children` array (list/listItem/blockquote/table/tableRow/
// footnoteDefinition all hold further BLOCK content as children -- e.g. a
// listItem's text is wrapped in an inner `paragraph`, never held directly on
// the listItem itself -- so they're deliberately excluded here; visiting
// stops at whichever of these three is reached first walking down from the
// root, and their own descendants are handled by the concatenation below,
// not by further top-level matches).
const TEXT_CONTAINER_TYPES = new Set(['paragraph', 'heading', 'tableCell'])

// Recursively concatenates ALL inline text within a single leaf-block node
// (paragraph/heading/tableCell) into one string, BEFORE any word-splitting
// happens. This is the fix for a real counting bug: splitting each `text`/
// `inlineCode` node's value independently (the original, wrong approach)
// undercounts or overcounts whenever an inline element (bold/italic/link/
// inline code) sits directly adjacent to surrounding text with NO
// whitespace between them in the source -- e.g. "This is **bold**." parses
// as three sibling nodes (text "This is ", strong["bold"], text "."); split
// independently, the trailing "." becomes its own spurious one-character
// "word" (4 total) instead of merging onto "bold" the way a reader actually
// reads it ("bold." -- 3 words total). Concatenating the whole block's text
// FIRST ("This is bold.") and splitting ONCE afterward gets this right,
// including the more extreme case of a word split mid-token by emphasis
// with no whitespace anywhere ("un*bel*ievable word" -> "unbelievable word"
// -> 2 words, not 4 from three independently-split fragments).
function concatenateInlineText(node: Node): string {
  if (node.type === 'text' || node.type === 'inlineCode') {
    return (node as Text | InlineCode).value
  }
  // A hard line break (trailing double-space or backslash before a
  // newline) has no literal space character in either neighboring text
  // node's value -- without treating it as a word-boundary itself, the
  // last word before it and the first word after it would wrongly merge
  // into one token the same way the bug above did for other inline nodes.
  if (node.type === 'break') {
    return ' '
  }
  const children = (node as { children?: Node[] }).children
  if (Array.isArray(children)) {
    return children.map(concatenateInlineText).join('')
  }
  // Any other leaf type reachable here (e.g. `image`, whose reader-visible
  // alt/title text lives in node properties, not children) contributes no
  // inline text.
  return ''
}

// Splits a leaf-block's already-concatenated, already-Markdown-syntax-free
// prose into words by whitespace. Intentionally simple (not attempting
// locale-aware word segmentation) -- by this point every Markdown syntax
// marker has already been stripped by parsing/concatenation, so what's left
// is exactly the plain-text run a reader would see, and counting
// whitespace-delimited runs in already-plain-text matches how a reader (and
// tools like Word/Google Docs) think about "word count" for real prose.
const WORD_RE = /\S+/g

/**
 * Returns an accurate count of the real prose words in a raw Markdown
 * document -- i.e. what a reader would see once the document is rendered,
 * not a literal whitespace-split of the raw Markdown source. Frontmatter and
 * fenced/indented code block content are excluded; inline code is included
 * (see the node-type notes above for the full breakdown of what is/isn't
 * counted and why). Words are counted per leaf block (paragraph/heading/
 * table cell) using its FULL concatenated text, not per individual inline
 * node, so an inline element directly adjacent to other text with no
 * whitespace between them (a bold/italic/linked/coded word at the end of a
 * sentence, or an emphasized word-fragment) is counted correctly instead of
 * being split into extra spurious tokens.
 */
export function countWords(markdown: string): number {
  const tree = processor.parse(markdown) as Root
  let count = 0
  visit(tree, (node) => {
    if (!TEXT_CONTAINER_TYPES.has(node.type)) return
    const text = concatenateInlineText(node)
    const matches = text.match(WORD_RE)
    if (matches) count += matches.length
    // Already consumed this whole subtree via concatenateInlineText above
    // -- no need for `visit`'s own traversal to separately descend into
    // it too (and structurally, none of paragraph/heading/tableCell can
    // nest inside another one anyway, so this is a pure efficiency gain,
    // not load-bearing for correctness).
    return SKIP
  })
  return count
}
