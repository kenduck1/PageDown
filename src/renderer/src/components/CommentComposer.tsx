import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
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

// How tall the auto-growing field is allowed to get before it starts
// scrolling internally, in px. Deliberately a cap rather than unbounded
// growth: this composer is a LAYOUT ROW (see the module comment), so every
// pixel it grows is a pixel taken from the editor canvas underneath it --
// and an unbounded field would let a long comment push the canvas off
// screen entirely. ~6 lines at this row's 12px/1.4 text.
const MAX_FIELD_HEIGHT_PX = 104

function CommentComposer({ onAddComment }: CommentComposerProps): ReactElement | null {
  const isOpen = useAppStore((state) => state.commentComposerOpen)
  const closeComposer = useAppStore((state) => state.closeCommentComposer)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const fieldRef = useRef<HTMLTextAreaElement>(null)

  // A textarea has no intrinsic "size to my content" behaviour, so the height
  // is driven from scrollHeight after each change. Reset to 'auto' FIRST --
  // scrollHeight can never report a value smaller than the element's current
  // height, so without the reset the field would only ever grow and would
  // stay tall after the text was deleted.
  //
  // useLayoutEffect, not useEffect: this runs before paint, so the row never
  // shows a frame at the stale height. Declared BEFORE the `isOpen` early
  // return below, like every other hook here -- hook order stays stable
  // because the return is what varies, never the hook list.
  useLayoutEffect(() => {
    const field = fieldRef.current
    if (!field) return
    field.style.height = 'auto'
    field.style.height = `${Math.min(field.scrollHeight, MAX_FIELD_HEIGHT_PX)}px`
  }, [text, isOpen])

  if (!isOpen) return null

  const handleClose = (): void => {
    setText('')
    setError(null)
    closeComposer()
  }

  const handleSubmit = (): void => {
    if (text.trim() === '') return
    // Trimmed, not raw: the field is multi-line now, so a Shift+Enter the
    // user changed their mind about leaves a trailing newline that would
    // otherwise be encoded into the marker and rendered as a blank line in
    // the Comments sidebar forever. Interior newlines -- the whole point of
    // the change -- are untouched.
    const applied = onAddComment(text.trim())
    if (!applied) {
      setError('Select some text within a single paragraph first.')
      return
    }
    handleClose()
  }

  // ENTER SUBMITS, SHIFT+ENTER INSERTS A NEWLINE -- deliberately that way
  // round, not the reverse.
  //
  // The overwhelmingly common comment is a single line ("typo", "cite this"),
  // and this composer already shipped with plain Enter submitting it; making
  // the common case require a modifier to save the rarer multi-paragraph case
  // a modifier is a straight downgrade, and would silently retrain a gesture
  // people already have. Shift+Enter as "soft newline inside a single-field
  // composer" is the established convention (Slack, Linear, Jira inline
  // comments) for exactly this shape of control.
  //
  // Shift+Enter is handled by NOT handling it: no preventDefault, so the
  // textarea's own native newline insertion runs and React's onChange fires
  // with the newline already in the value. Writing the newline ourselves
  // would mean reimplementing caret/selection-replacement handling for no
  // gain.
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
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
      {/* `items-end`, not `items-center`: the field grows downward as the
          comment gains lines, and buttons floating to the vertical middle of
          a six-line field read as unanchored. Bottom-aligned, they stay on
          the same line as the last line of text, where the caret is. */}
      <div className="flex items-end gap-1.5">
        <textarea
          ref={fieldRef}
          rows={1}
          aria-label="Comment text"
          // Product-completeness audit Tier 3, B.1: only set (never a bare
          // `undefined`-vs-omitted split) while an error is actually showing,
          // so a screen reader user tabbing into this field is told there is
          // a related description to read (via the id below) exactly when
          // there is one, and hears nothing extra otherwise.
          aria-describedby={error ? COMMENT_ERROR_ID : undefined}
          // The Shift+Enter half of the key contract is genuinely
          // undiscoverable otherwise -- a single-looking field gives a user no
          // reason to suspect it takes more than one line. Stated in the
          // placeholder rather than as a hint row so it costs no layout
          // height, and sits exactly where the user is already looking.
          placeholder="Add a comment… (Shift+Enter for a new line)"
          autoFocus
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setError(null)
          }}
          onKeyDown={handleKeyDown}
          // No fixed height: the useLayoutEffect above owns `style.height`,
          // and a Tailwind height class would fight it. `resize-none` because
          // the drag handle would fight it too (a user-dragged height is
          // overwritten on the very next keystroke). `leading-[1.4]` is what
          // MAX_FIELD_HEIGHT_PX's own "~6 lines" figure is derived from, so
          // the two must move together.
          className="min-h-[30px] min-w-0 flex-1 resize-none overflow-y-auto rounded-sm border border-border-chrome bg-page px-2.5 py-1.5 text-12 leading-[1.4] text-text-primary"
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
