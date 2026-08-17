import { useEffect, useMemo, useRef } from 'react'
import { extractComments } from '../lib/extractComments'

export interface EditorCommentsProps {
  content: string
  onSelectComment: (id: string) => void
  onResolveComment: (id: string) => void
  /**
   * The comment the user just clicked in the document, or null.
   *
   * Highlighted and scrolled into view here. Without it, clicking a
   * highlighted span switched to this tab and left the reader to find the
   * matching row themselves -- which on a document with many comments is the
   * same problem as not switching at all.
   */
  activeCommentId?: string | null
}

// Mirrors EditorOutline.tsx's own structure: a real, useMemo'd derivation
// from the raw document source, not a live read of Milkdown's editor state
// -- extractComments.ts (src/renderer/src/lib/extractComments.ts) parses
// `content` directly, the same way extractOutline.ts already does for
// headings.
function EditorComments({
  content,
  onSelectComment,
  onResolveComment,
  activeCommentId = null
}: EditorCommentsProps): React.JSX.Element {
  const comments = useMemo(() => extractComments(content), [content])
  const activeRef = useRef<HTMLLIElement | null>(null)

  // Scroll the active row into view when it changes. `block: 'nearest'` rather
  // than 'center': this rail is a short column, and centring would scroll the
  // list even when the row is already fully visible, which reads as the panel
  // jumping for no reason.
  useEffect(() => {
    if (!activeCommentId) return
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeCommentId])

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
          ref={comment.id === activeCommentId ? activeRef : undefined}
          data-active={comment.id === activeCommentId ? 'true' : undefined}
          // The active row is tinted with the SAME token the comment mark uses
          // in the document (`--color-comment-mark`), so the highlighted span
          // you clicked and the row that answers it read as the same object
          // rather than two unrelated selections.
          className={
            'flex flex-col gap-1 rounded-md border px-2.5 py-2 ' +
            (comment.id === activeCommentId
              ? 'border-accent bg-comment-mark'
              : 'border-border-subtle bg-page')
          }
        >
          <button type="button" onClick={() => onSelectComment(comment.id)} className="text-left">
            <span className="block truncate text-11-5 italic text-text-tertiary">
              &quot;{comment.matchedText || '(empty span)'}&quot;
            </span>
            {/* `whitespace-pre-wrap` is load-bearing now that the composer
                takes multi-line bodies (Shift+Enter): HTML collapses a run of
                whitespace, so without it a two-paragraph comment renders as
                one run-on line here -- the blank line between the paragraphs
                disappears entirely and the two paragraphs fuse with a single
                space. `break-words` covers the other half: this rail is a
                216px column, so an unbroken long token (a URL, a file path)
                would otherwise overflow it rather than wrap. */}
            <span className="block whitespace-pre-wrap break-words text-12-5 text-text-primary">
              {comment.text}
            </span>
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
