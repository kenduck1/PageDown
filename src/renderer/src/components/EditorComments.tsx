import { useEffect, useMemo, useRef, useState } from 'react'
import { extractComments, type ExtractedComment } from '../lib/extractComments'

export interface EditorCommentsProps {
  content: string
  onSelectComment: (id: string) => void
  /** Keeps the comment in the document, marked resolved. */
  onResolveComment: (id: string) => void
  /** Puts a resolved comment back in the active list. */
  onUnresolveComment: (id: string) => void
  /** Removes the mark entirely. Destructive; gated behind a confirm below. */
  onDeleteComment: (id: string) => void
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

// Renders a real Date only if the stored string actually parses. `resolvedAt`
// arrives from a base64 payload inside the .md file, which a human can edit by
// hand, so it is untrusted input like every other field here -- an unparseable
// value must degrade to the bare word "Resolved" rather than printing the
// browser's "Invalid Date" at the user.
function resolvedLabel(resolvedAt: string): string {
  const date = new Date(resolvedAt)
  if (Number.isNaN(date.getTime())) return 'Resolved'
  return `Resolved ${date.toLocaleDateString()}`
}

interface CommentRowProps {
  comment: ExtractedComment
  isActive: boolean
  activeRef: React.RefObject<HTMLLIElement | null>
  pendingDelete: boolean
  onSelect: (id: string) => void
  onResolve: (id: string) => void
  onUnresolve: (id: string) => void
  onRequestDelete: (id: string) => void
  onCancelDelete: () => void
  onConfirmDelete: (id: string) => void
}

function CommentRow({
  comment,
  isActive,
  activeRef,
  pendingDelete,
  onSelect,
  onResolve,
  onUnresolve,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete
}: CommentRowProps): React.JSX.Element {
  const resolved = comment.resolvedAt !== null

  return (
    <li
      ref={isActive ? activeRef : undefined}
      data-active={isActive ? 'true' : undefined}
      data-resolved={resolved ? 'true' : undefined}
      // The active row is tinted with the SAME token the comment mark uses
      // in the document (`--color-comment-mark`), so the highlighted span
      // you clicked and the row that answers it read as the same object
      // rather than two unrelated selections. A resolved row is deliberately
      // flatter than an active one even when it IS the active row: it keeps
      // the accent border (so "this is the one you clicked" still reads) but
      // not the violet fill, mirroring exactly what the mark itself does in
      // the document.
      className={
        'flex flex-col gap-1 rounded-md border px-2.5 py-2 ' +
        (isActive ? 'border-accent ' : 'border-border-subtle ') +
        (resolved ? 'bg-page opacity-70' : isActive ? 'bg-comment-mark' : 'bg-page')
      }
    >
      <button type="button" onClick={() => onSelect(comment.id)} className="text-left">
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
            would otherwise overflow it rather than wrap.

            Plain React text interpolation, never innerHTML: this is
            author-typed text round-tripped through hand-editable Markdown,
            i.e. untrusted. */}
        <span
          className={
            'block whitespace-pre-wrap break-words text-12-5 ' +
            (resolved ? 'text-text-secondary line-through' : 'text-text-primary')
          }
        >
          {comment.text}
        </span>
        <span className="block text-11 text-text-tertiary">
          {comment.author || 'You'}
          {comment.resolvedAt !== null ? ` · ${resolvedLabel(comment.resolvedAt)}` : ''}
        </span>
      </button>

      {pendingDelete ? (
        // DELETE IS A TWO-STEP CONFIRM, and the reason is that this is the one
        // action here the user cannot get back. Resolve is reversible from the
        // row right next to it (Unresolve); delete removes the mark from the
        // document outright. The ProseMirror undo stack does hold it, but its
        // keymap only fires while the EDITOR has DOM focus -- and this click
        // came from the sidebar rail, so Cmd+Z at that moment reaches nothing.
        // With no reachable undo, a one-click delete sitting a few pixels from
        // a one-click resolve is a data-loss trap.
        //
        // A native confirm() is not an option here for a reason this codebase
        // already paid for once: window.prompt throws in this renderer (it is
        // what made Insert Link silently dead), so the dialog family is not
        // something to reach for. An inline two-step is also better than a
        // modal anyway -- it keeps the question attached to the row it is
        // about.
        <div className="flex flex-col gap-1">
          <span className="text-11 text-text-secondary">Delete this comment?</span>
          <div className="flex gap-1">
            <button
              type="button"
              aria-label="Confirm delete"
              onClick={() => onConfirmDelete(comment.id)}
              className="rounded-sm bg-red-600 px-1.5 py-0.5 text-11 font-semibold text-white hover:bg-red-700"
            >
              Delete
            </button>
            <button
              type="button"
              aria-label="Cancel delete"
              onClick={onCancelDelete}
              className="rounded-sm px-1.5 py-0.5 text-11 font-semibold text-text-secondary hover:bg-accent/9"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        // Resolve/Unresolve sits at the LEFT in the accent colour, Delete at the
        // far RIGHT in the danger colour, with the flex gap between them -- the
        // three things that keep delete from being hit by accident are its
        // distance, its colour, and the confirm step above. All three, not one:
        // colour alone fails for a colour-blind reader, distance alone fails
        // for a fast click, and a confirm alone still invites the misclick.
        <div className="flex items-center justify-between">
          {resolved ? (
            <button
              type="button"
              onClick={() => onUnresolve(comment.id)}
              className="rounded-sm px-1.5 py-0.5 text-11 font-semibold text-accent hover:bg-accent/9"
            >
              Unresolve
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onResolve(comment.id)}
              className="rounded-sm px-1.5 py-0.5 text-11 font-semibold text-accent hover:bg-accent/9"
            >
              Resolve
            </button>
          )}
          <button
            type="button"
            onClick={() => onRequestDelete(comment.id)}
            // `text-red-600` rather than a new --color-danger token, matching
            // the precedent CommentComposer.tsx and ErrorBoundary.tsx already
            // set for this app's only other destructive/error affordances.
            className="rounded-sm px-1.5 py-0.5 text-11 font-semibold text-red-600 hover:bg-red-600/10"
          >
            Delete
          </button>
        </div>
      )}
    </li>
  )
}

// Mirrors EditorOutline.tsx's own structure: a real, useMemo'd derivation
// from the raw document source, not a live read of Milkdown's editor state
// -- extractComments.ts (src/renderer/src/lib/extractComments.ts) parses
// `content` directly, the same way extractOutline.ts already does for
// headings.
//
// RESOLVED COMMENTS GET THEIR OWN COLLAPSED SECTION, not a filter toggle over
// one list. Both were considered; the section wins on two concrete points.
// First, a toggle has modes, and a mode you cannot see is a lie the panel tells
// you: with "hide resolved" on, a document with eight resolved comments and
// none active shows the same empty rail as a document with no comments at all.
// A section header reading "Resolved (8)" answers that question without being
// asked. Second, resolving is meant to be low-stakes -- if resolved comments
// vanished from the panel entirely, resolve would feel as final as delete,
// which is exactly the distinction this whole change exists to draw.
//
// Collapsed by DEFAULT, because "out of the way" is the requirement and the
// active list is what the rail is for.
function EditorComments({
  content,
  onSelectComment,
  onResolveComment,
  onUnresolveComment,
  onDeleteComment,
  activeCommentId = null
}: EditorCommentsProps): React.JSX.Element {
  const comments = useMemo(() => extractComments(content), [content])
  const activeRef = useRef<HTMLLIElement | null>(null)
  const [showResolved, setShowResolved] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  // The activeCommentId this component has already reacted to -- see the
  // adjust-during-render block below. Seeded to null, NOT to `activeCommentId`:
  // the panel is commonly MOUNTED with a comment already active, because
  // revealComment switches the sidebar to this tab in the same action that sets
  // the id. Seeding from the prop would make that first render count as
  // "already reacted to", and the reveal that just happened would open nothing
  // -- the exact bug this block exists to prevent, reintroduced by the seed.
  const [lastRevealedId, setLastRevealedId] = useState<string | null>(null)

  const active = comments.filter((comment) => comment.resolvedAt === null)
  const resolved = comments.filter((comment) => comment.resolvedAt !== null)

  const activeIsResolved = resolved.some((comment) => comment.id === activeCommentId)

  // Scroll the active row into view when it changes. `block: 'nearest'` rather
  // than 'center': this rail is a short column, and centring would scroll the
  // list even when the row is already fully visible, which reads as the panel
  // jumping for no reason.
  useEffect(() => {
    if (!activeCommentId) return
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeCommentId])

  // REVEALING a resolved comment OPENS the section, once. If it did not, then
  // clicking a resolved mark in the document would switch to this tab and show
  // the reader a collapsed header -- precisely the "the click looks like it did
  // nothing" bug revealComment exists to fix (see appStore's own comment on that
  // action).
  //
  // Opening it ONCE, rather than deriving `open = showResolved ||
  // activeIsResolved`, is the difference between a disclosure and a lie. Under
  // the derived version the section is forced open for as long as that comment
  // stays active, so clicking the disclosure to collapse it did nothing at all
  // -- a control that visibly refuses to work, which is a worse thing to ship
  // than the state it was protecting. Opening it as an EVENT hands control back
  // to the user immediately afterwards.
  //
  // Adjusting state DURING RENDER (React's own documented pattern for deriving
  // from changed props) rather than in an effect, because this project's lint
  // config enables react-hooks/set-state-in-effect -- the same shape
  // SettingsScreen.tsx already uses for its own autosave-interval buffer, with
  // the same `lastSynced` comparison value.
  if (activeCommentId !== lastRevealedId) {
    setLastRevealedId(activeCommentId)
    if (activeIsResolved) setShowResolved(true)
  }
  const resolvedOpen = showResolved

  if (comments.length === 0) {
    return (
      <div className="px-3 py-4 text-11 text-text-tertiary">
        No comments in this document yet. Select some text and click &quot;Add Comment&quot; to
        leave one.
      </div>
    )
  }

  const rowProps = {
    activeRef,
    onSelect: onSelectComment,
    onResolve: (id: string) => {
      // A resolve/unresolve/delete can change which section a row lives in, so
      // an in-progress delete confirmation on some OTHER row would be left
      // pointing at a row the user is no longer looking at. Clearing it on any
      // lifecycle action keeps "the confirm is about the row it is drawn in"
      // true by construction.
      setPendingDeleteId(null)
      onResolveComment(id)
    },
    onUnresolve: (id: string) => {
      setPendingDeleteId(null)
      onUnresolveComment(id)
    },
    onRequestDelete: (id: string) => setPendingDeleteId(id),
    onCancelDelete: () => setPendingDeleteId(null),
    onConfirmDelete: (id: string) => {
      setPendingDeleteId(null)
      onDeleteComment(id)
    }
  }

  return (
    <div className="flex flex-col gap-2 overflow-y-auto px-2 py-2">
      {active.length === 0 ? (
        <p className="px-0.5 text-11 text-text-tertiary">No active comments.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {active.map((comment) => (
            <CommentRow
              key={comment.id}
              comment={comment}
              isActive={comment.id === activeCommentId}
              pendingDelete={comment.id === pendingDeleteId}
              {...rowProps}
            />
          ))}
        </ul>
      )}

      {resolved.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            aria-expanded={resolvedOpen}
            onClick={() => setShowResolved(!showResolved)}
            className="flex items-center gap-1 self-start rounded-sm px-0.5 py-0.5 text-11 font-semibold text-text-secondary hover:text-text-primary"
          >
            <span aria-hidden="true">{resolvedOpen ? '▾' : '▸'}</span>
            Resolved ({resolved.length})
          </button>
          {resolvedOpen && (
            <ul className="flex flex-col gap-1.5">
              {resolved.map((comment) => (
                <CommentRow
                  key={comment.id}
                  comment={comment}
                  isActive={comment.id === activeCommentId}
                  pendingDelete={comment.id === pendingDeleteId}
                  {...rowProps}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

export default EditorComments
