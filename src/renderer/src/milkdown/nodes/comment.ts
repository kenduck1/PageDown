import { $markSchema, $remark } from '@milkdown/utils'
import { remarkComment, remarkCommentToMarkdown } from '../../../../markdown/comment-plugin'

// Mirrors pagebreak.ts's own $remark-wrapper pattern exactly: the SAME
// remarkComment/remarkCommentToMarkdown plugin pair markdownToHtml uses
// (src/markdown/pipeline.ts) is reused here, unmodified, for Milkdown's own
// internal parse/serialize pipeline -- one shared plugin serving both
// consumers, per pagebreak-plugin.ts's own established top-of-file
// rationale, not a second, independently-behaving implementation.
export const commentRemark = $remark('remarkComment', () => remarkComment)
export const commentRemarkToMarkdown = $remark(
  'remarkCommentToMarkdown',
  () => remarkCommentToMarkdown
)

// A ProseMirror MARK, not a node -- comments wrap a SPAN of existing inline
// content (a phrase inside one paragraph/heading/list-item/table-cell),
// exactly the same category of thing bold/italic are, unlike the atomic
// pagebreak NODE. Mirrors @milkdown/preset-commonmark's own strongSchema
// (node_modules/.pnpm/@milkdown+preset-commonmark.../src/mark/strong.ts)
// structurally: parseMarkdown's runner uses openMark/next/closeMark,
// toMarkdown's runner uses withMark -- the same three-call shape, adapted
// for this mark's own four attrs instead of strong's one.
export const commentSchema = $markSchema('comment', () => ({
  attrs: {
    id: { default: '', validate: 'string' },
    author: { default: '', validate: 'string' },
    text: { default: '', validate: 'string' },
    createdAt: { default: '', validate: 'string' }
  },
  parseDOM: [
    {
      tag: 'span[data-comment-id]',
      getAttrs: (dom) => {
        const el = dom as HTMLElement
        return {
          id: el.getAttribute('data-comment-id') ?? '',
          author: el.getAttribute('data-comment-author') ?? '',
          text: el.getAttribute('data-comment-text') ?? '',
          createdAt: el.getAttribute('data-comment-created-at') ?? ''
        }
      }
    }
  ],
  toDOM: (mark) => [
    'span',
    {
      class: 'pagedown-comment-mark',
      'data-comment-id': mark.attrs.id,
      'data-comment-author': mark.attrs.author,
      'data-comment-text': mark.attrs.text,
      'data-comment-created-at': mark.attrs.createdAt
    },
    0
  ],
  parseMarkdown: {
    match: ({ type }) => type === 'comment',
    runner: (state, node, markType) => {
      state.openMark(markType, {
        id: node.id,
        author: node.author,
        text: node.text,
        createdAt: node.createdAt
      })
      state.next(node.children)
      state.closeMark(markType)
    }
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'comment',
    runner: (state, mark) => {
      state.withMark(mark, 'comment', undefined, {
        id: mark.attrs.id,
        author: mark.attrs.author,
        text: mark.attrs.text,
        createdAt: mark.attrs.createdAt
      })
    }
  }
}))
