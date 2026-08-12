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
 *
 * SAME-ID OCCURRENCES COLLAPSE INTO ONE ENTRY, matching how
 * resolveCommentCommand already sweeps the whole document by id rather than
 * by mark instance -- one logical comment, one sidebar row, one React key.
 * This is not defensive padding: files saved by an earlier build genuinely
 * contain two marker pairs sharing one id for a comment spanning a
 * hand-wrapped paragraph (each line was serialized as its own pair), and
 * without this they rendered two identical rows under DUPLICATE React keys.
 * Such a file re-serializes to a single pair on its next save, so this is
 * the read side of that repair, not a permanent second representation.
 *
 * The FIRST occurrence wins for every scalar field, so `sourceOffset` -- the
 * value the sidebar scrolls to -- points at where the marked span actually
 * begins. `matchedText` concatenates the fragments in document order,
 * because they are literally the pieces of one marked span.
 */
export function extractComments(source: string): ExtractedComment[] {
  const parseProcessor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkComment)
  const parsedTree = parseProcessor.parse(source) as Root
  const tree = parseProcessor.runSync(parsedTree) as Root

  // A Map preserves first-insertion order, so the returned list stays in
  // document order without a second sort.
  const comments = new Map<string, ExtractedComment>()
  visit(tree, 'comment', (node: Comment) => {
    const sourceOffset = node.position?.start.offset
    if (sourceOffset == null) return
    const existing = comments.get(node.id)
    if (existing) {
      const fragment = matchedText(node)
      if (fragment !== '') {
        existing.matchedText =
          existing.matchedText === '' ? fragment : `${existing.matchedText} ${fragment}`
      }
      return
    }
    comments.set(node.id, {
      id: node.id,
      author: node.author,
      text: node.text,
      createdAt: node.createdAt,
      sourceOffset,
      matchedText: matchedText(node)
    })
  })

  return [...comments.values()]
}
