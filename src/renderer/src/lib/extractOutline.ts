import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import { visit } from 'unist-util-visit'
import type { Root, Heading, Text, InlineCode } from 'mdast'

export interface OutlineHeading {
  depth: number
  text: string
  sourceOffset: number
}

// Flattens a heading's inline content to plain text by concatenating every
// text/inlineCode leaf's value, in document order. Deliberately narrow
// rather than pulling in `mdast-util-to-string`: that package is only a
// transitive dependency here (nothing in package.json declares it), and
// under pnpm's strict node_modules layout a transitive-only package isn't
// resolvable via a plain `import` from application code. Headings only ever
// contain phrasing content (plain text, emphasis/strong/delete wrapping
// text, inline code, links/images wrapping text) -- walking every
// text/inlineCode leaf covers all of it.
function headingText(node: Heading): string {
  let text = ''
  visit(node, (child) => {
    if (child.type === 'text' || child.type === 'inlineCode') {
      text += (child as Text | InlineCode).value
    }
  })
  return text
}

/**
 * Parses raw Markdown and returns every heading found, in document order,
 * with its nesting depth (1-6), flattened plain text, and the character
 * offset into `source` where the heading node starts (`position.start.offset`)
 * -- needed so a future integration step can scroll the real editor to that
 * location. Returns `[]` for a document with no headings, including an empty
 * string.
 *
 * Uses the exact same parse-time plugin stack as markdownToHtml
 * (src/markdown/pipeline.ts): remark-parse + remark-gfm + remark-frontmatter,
 * with the same remarkFrontmatter(['yaml']) option -- see CLAUDE.md's "One
 * parser everywhere" rule. Deliberately built as its own minimal processor
 * here rather than importing pipeline.ts directly: pipeline.ts's remaining
 * stages (remarkPagebreak, remarkRehype, the sanitize/rehype-stringify pass)
 * exist only to produce sanitized render HTML and never touch heading nodes
 * either way (remarkPagebreak is a post-parse tree *transform*, not a syntax
 * extension -- see pagebreak-plugin.ts -- and it only ever matches raw-HTML/
 * text-command leaves, never `heading` nodes). This function only needs the
 * parsed mdast tree's `heading` nodes and their `position.start.offset`,
 * both already fully determined by remark-parse's own parse phase
 * (remarkGfm/remarkFrontmatter register micromark/mdast-util-from-markdown
 * syntax extensions that the parse phase itself consults, matching the same
 * reasoning pipeline.ts's own comment gives for why those two don't need a
 * `.runSync()`). If pipeline.ts's parse-time plugin set or options ever
 * changes, this must change with it -- this is a second *processor
 * construction*, not a second, independently-behaving Markdown parser.
 */
export function extractOutline(source: string): OutlineHeading[] {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .parse(source) as Root
  const headings: OutlineHeading[] = []

  visit(tree, 'heading', (node: Heading) => {
    const sourceOffset = node.position?.start.offset
    if (sourceOffset == null) return
    headings.push({ depth: node.depth, text: headingText(node), sourceOffset })
  })

  return headings
}
