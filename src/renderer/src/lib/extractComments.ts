import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import { visit } from 'unist-util-visit'
import type { Root, Text, InlineCode } from 'mdast'
import { remarkComment, type Comment } from '../../../markdown/comment-plugin'

export interface ExtractedComment {
  id: string
  author: string
  text: string
  createdAt: string
  sourceOffset: number
  matchedText: string
}

// Flattens a comment's own marked span to plain text, the exact same
// text/inlineCode-leaf-walk extractOutline.ts's own headingText uses for a
// heading's content -- both only ever contain phrasing content, so the same
// narrow walk covers it (see that function's own comment for why
// mdast-util-to-string isn't pulled in for this instead).
function matchedText(node: Comment): string {
  let text = ''
  visit(node, (child) => {
    if (child.type === 'text' || child.type === 'inlineCode') {
      text += (child as Text | InlineCode).value
    }
  })
  return text
}

/**
 * Parses raw Markdown and returns every comment found, in document order.
 * Mirrors extractOutline.ts's own structure and its own documented reason
 * for building a dedicated processor rather than importing pipeline.ts
 * directly (pipeline.ts's remaining stages exist only to produce sanitized
 * render HTML and have no bearing on this). Unlike extractOutline's own
 * plugins (syntax extensions only, `.parse()` suffices), remarkComment is a
 * POST-PARSE tree transform (matching remarkPagebreak's own shape) and
 * needs an explicit `.runSync()` on the same processor instance -- see
 * pipeline.ts's own comment on exactly this distinction.
 *
 * A comment whose marker pair didn't match (see comment-plugin.ts's own
 * "fails closed" comment -- an unpaired marker, or a marker spanning more
 * than one block) never becomes a `comment` mdast node at all, so it's
 * simply absent from this list -- not a special case here.
 */
export function extractComments(source: string): ExtractedComment[] {
  const parseProcessor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkComment)
  const parsedTree = parseProcessor.parse(source) as Root
  const tree = parseProcessor.runSync(parsedTree) as Root

  const comments: ExtractedComment[] = []
  visit(tree, 'comment', (node: Comment) => {
    const sourceOffset = node.position?.start.offset
    if (sourceOffset == null) return
    comments.push({
      id: node.id,
      author: node.author,
      text: node.text,
      createdAt: node.createdAt,
      sourceOffset,
      matchedText: matchedText(node)
    })
  })

  return comments
}
