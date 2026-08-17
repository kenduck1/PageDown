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
    createdAt: { default: '', validate: 'string' },
    // The EMPTY STRING means unresolved, not `undefined`/`null`, and that is
    // forced rather than chosen: a ProseMirror attr always has a value (it
    // carries a declared default and cannot be absent), so there is no "field
    // is missing" state available on this side of the pipeline the way there
    // is in the mdast/JSON payload. `validate: 'string'` matches the other
    // four attrs and would reject null anyway.
    //
    // The translation between the two spellings lives in exactly two places,
    // both immediately below: parseMarkdown maps absent -> '', and toMarkdown
    // hands the '' straight back for remarkCommentToMarkdown to normalise to
    // absent again. Keeping the ProseMirror side total (always a string) and
    // the FILE side optional is what makes an unresolved comment's bytes
    // survive a Format-mode edit unchanged.
    resolvedAt: { default: '', validate: 'string' }
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
          createdAt: el.getAttribute('data-comment-created-at') ?? '',
          resolvedAt: el.getAttribute('data-comment-resolved-at') ?? ''
        }
      }
    }
  ],
  // The resolved state reaches CSS as a second class on the same element
  // rather than as a separate element or an attribute selector, so that every
  // existing `.pagedown-comment-mark` consumer keeps matching unchanged --
  // EditorScreen's own `querySelector('.pagedown-comment-mark[data-comment-id
  // ="..."]')` scroll-into-view, its click-to-reveal `closest(...)`, and Gate
  // 27's `.pagedown-comment-mark` counts all still see a resolved comment as
  // the comment mark it still is. Only the styling differs (base.css), which
  // is exactly the intended difference: a resolved comment is still there, it
  // just stops shouting.
  toDOM: (mark) => [
    'span',
    {
      class: mark.attrs.resolvedAt
        ? 'pagedown-comment-mark pagedown-comment-resolved'
        : 'pagedown-comment-mark',
      'data-comment-id': mark.attrs.id,
      'data-comment-author': mark.attrs.author,
      'data-comment-text': mark.attrs.text,
      'data-comment-created-at': mark.attrs.createdAt,
      // Emitted only when set, so an unresolved mark's DOM is byte-identical
      // to what it was before this feature (an empty `data-comment-resolved-at
      // =""` would also be truthy to `closest('[data-comment-resolved-at]')`,
      // which is exactly the kind of near-miss selector a future reader would
      // reach for).
      ...(mark.attrs.resolvedAt ? { 'data-comment-resolved-at': mark.attrs.resolvedAt } : {})
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
        createdAt: node.createdAt,
        // Absent in the file (an old comment, or any unresolved one) becomes
        // '' here -- see the attr's own comment for why the two sides spell
        // "unresolved" differently.
        resolvedAt: node.resolvedAt ?? ''
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
        createdAt: mark.attrs.createdAt,
        resolvedAt: mark.attrs.resolvedAt
      })
    }
  }
}))
