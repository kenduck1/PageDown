import { useState, type KeyboardEvent, type ReactElement } from 'react'
import { useAppStore } from '../store/appStore'

// A LAYOUT ROW, never a floating popover -- the exact same architectural
// requirement FindBar.tsx documents at length, reused rather than
// re-derived: Split mode's preview pane is a real native WebContentsView,
// which composites above ALL DOM unconditionally, so any floating overlay
// needs the same special-casing PageSetupModal had to add (a zero-size-
// rectangle workaround). A layout row sidesteps this by construction --
// inserting it shrinks the content area, which the existing ResizeObserver
// chain (SplitPreview.tsx) already handles with no new code.
export interface CommentComposerProps {
  // Returns whether the comment was actually applied -- false means the
  // current selection was empty or spanned more than one block (see
  // addCommentCommand's own doc comment, commands.ts). The composer shows a
  // real inline error in that case rather than silently closing.
  onAddComment: (text: string) => boolean
}

// A static id, not one generated via `useId()`, is safe here: appStore's
// `commentComposerOpen` is a single boolean, so at most one CommentComposer
// is ever mounted at a time -- there is no second instance a static id could
// collide with the way there would be for a component rendered in a list.
const COMMENT_ERROR_ID = 'comment-composer-error'

function CommentComposer({ onAddComment }: CommentComposerProps): ReactElement | null {
  const isOpen = useAppStore((state) => state.commentComposerOpen)
  const closeComposer = useAppStore((state) => state.closeCommentComposer)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (!isOpen) return null

  const handleClose = (): void => {
    setText('')
    setError(null)
    closeComposer()
  }

  const handleSubmit = (): void => {
    if (text.trim() === '') return
    const applied = onAddComment(text)
    if (!applied) {
      setError('Select some text within a single paragraph first.')
      return
    }
    handleClose()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      handleSubmit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      handleClose()
    }
  }

  return (
    <div
      role="group"
      aria-label="Add comment"
      className="flex flex-none flex-col gap-1.5 border-b border-border-chrome bg-chrome-dark px-3 py-1.5 text-12 text-text-secondary"
    >
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          aria-label="Comment text"
          // Product-completeness audit Tier 3, B.1: only set (never a bare
          // `undefined`-vs-omitted split) while an error is actually showing,
          // so a screen reader user tabbing into this field is told there is
          // a related description to read (via the id below) exactly when
          // there is one, and hears nothing extra otherwise.
          aria-describedby={error ? COMMENT_ERROR_ID : undefined}
          placeholder="Add a comment…"
          autoFocus
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setError(null)
          }}
          onKeyDown={handleKeyDown}
          className="h-[30px] min-w-0 flex-1 rounded-sm border border-border-chrome bg-page px-2.5 text-12 text-text-primary"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={text.trim() === ''}
          className="flex-none rounded-sm border border-border-chrome px-2.5 py-1 text-12 text-text-primary transition-colors hover:bg-chrome-light disabled:cursor-not-allowed disabled:opacity-40"
        >
          Add
        </button>
        <button
          type="button"
          onClick={handleClose}
          className="flex-none rounded-sm px-2.5 py-1 text-12 text-text-secondary transition-colors hover:bg-chrome-light"
        >
          Cancel
        </button>
      </div>
      {/* Product-completeness audit Tier 3, B.1: `role="alert"` announces
      this the instant it appears (a genuinely discrete failure -- the
      selection was empty or spanned multiple blocks, see addCommentCommand's
      own doc comment -- not a value that updates continuously the way
      FindBar's match count does), and `id`+`aria-describedby` above ties it
      to the input it's actually ABOUT, so a screen reader reports it as part
      of that field's own description too, not just as an unrelated aside
      that happened to be announced around the same time. */}
      {error && (
        <span id={COMMENT_ERROR_ID} role="alert" className="text-11-5 text-red-600">
          {error}
        </span>
      )}
    </div>
  )
}

export default CommentComposer
