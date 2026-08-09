import { useMemo } from 'react'
import { extractComments } from '../lib/extractComments'

export interface EditorCommentsProps {
  content: string
  onSelectComment: (id: string) => void
  onResolveComment: (id: string) => void
}

// Mirrors EditorOutline.tsx's own structure: a real, useMemo'd derivation
// from the raw document source, not a live read of Milkdown's editor state
// -- extractComments.ts (src/renderer/src/lib/extractComments.ts) parses
// `content` directly, the same way extractOutline.ts already does for
// headings.
function EditorComments({
  content,
  onSelectComment,
  onResolveComment
}: EditorCommentsProps): React.JSX.Element {
  const comments = useMemo(() => extractComments(content), [content])

  if (comments.length === 0) {
    return (
      <div className="px-3 py-4 text-11 text-text-tertiary">
        No comments in this document yet. Select some text and click &quot;Add Comment&quot; to
        leave one.
      </div>
    )
  }

  return (
    <ul className="flex flex-col gap-1.5 overflow-y-auto px-2 py-2">
      {comments.map((comment) => (
        <li
          key={comment.id}
          className="flex flex-col gap-1 rounded-md border border-border-subtle bg-page px-2.5 py-2"
        >
          <button type="button" onClick={() => onSelectComment(comment.id)} className="text-left">
            <span className="block truncate text-11-5 italic text-text-tertiary">
              &quot;{comment.matchedText || '(empty span)'}&quot;
            </span>
            <span className="block text-12-5 text-text-primary">{comment.text}</span>
            <span className="block text-11 text-text-tertiary">{comment.author || 'You'}</span>
          </button>
          <button
            type="button"
            onClick={() => onResolveComment(comment.id)}
            className="self-start rounded-sm px-1.5 py-0.5 text-11 font-semibold text-accent hover:bg-accent/9"
          >
            Resolve
          </button>
        </li>
      ))}
    </ul>
  )
}

export default EditorComments
