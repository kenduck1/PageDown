import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type RefObject
} from 'react'
import FloatingCard from './FloatingCard'
import type { Rect } from '../lib/floating-position'
import { useAppStore } from '../store/appStore'

// A POPOVER ANCHORED AT THE SELECTION, via FloatingCard -- not the full-width
// layout row this used to be. See FloatingCard.tsx's header for why the
// occlusion argument that made it a row (a WebContentsView composites above
// ALL DOM unconditionally) is now solved by the clamp SelectionBubble proved
// out rather than dodged by taking layout space, and why FindBar deliberately
// did NOT move with it.
//
// The user-visible reason, in one line: the app already pops a bubble at the
// selection, and its own "Add comment" button then sent the eye to a strip at
// the top of the window to type into. A comment is about the words under the
// cursor, so the field belongs there.
export interface CommentComposerProps {
  // Returns whether the comment was actually applied -- false means the
  // current selection was empty or spanned more than one block (see
  // addCommentCommand's own doc comment, commands.ts). The composer shows a
  // real inline error in that case rather than silently closing.
  onAddComment: (text: string) => boolean
  // Where to anchor, read at call time -- see FloatingCard's own `measure`
  // doc comment for why this is a function rather than two rect props.
  measure: () => { anchor: Rect | null; safe: Rect | null }
  // The scrolling editor pane, so the popover follows the text when the pane
  // resizes under it.
  paneRef: RefObject<HTMLElement | null>
}

// A static id, not one generated via `useId()`, is safe here: appStore's
// `commentComposerOpen` is a single boolean, so at most one CommentComposer
// is ever mounted at a time -- there is no second instance a static id could
// collide with the way there would be for a component rendered in a list.
const COMMENT_ERROR_ID = 'comment-composer-error'

// How tall the auto-growing field is allowed to get before it starts
// scrolling internally, in px. ~6 lines at this popover's 12px/1.4 text.
//
// THE REASON FOR THE CAP CHANGED WITH THE SURFACE, and the cap survived the
// change: as a layout row, every pixel it grew was a pixel taken from the
// editor canvas underneath it, and an unbounded field could push the canvas
// off screen. As a popover it steals no layout at all -- but an unbounded one
// would grow past the safe rect, and computeFloatingPosition's vertical clamp
// would then pin its TOP to `safe.top + FLOATING_EDGE_PAD` and let the bottom
// (buttons included) run off the end of the pane. Capping the field and
// scrolling it internally keeps the Add/Cancel buttons reachable no matter how
// long the comment gets.
const MAX_FIELD_HEIGHT_PX = 104

// Slightly wider than the link popover: a comment is prose, and a 300px field
// at ~6 lines reads cramped. Still clamped down by FloatingCard when the pane
// is narrower (Split at MIN_SPLIT_RATIO), so this is a preference rather than
// a floor that could push it under the native preview view.
const COMMENT_POPOVER_WIDTH_PX = 320

function CommentComposer({
  onAddComment,
  measure,
  paneRef
}: CommentComposerProps): ReactElement | null {
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
  // useLayoutEffect, not useEffect: this runs before paint, so the popover
  // never shows a frame at the stale height. It is also what makes the growth
  // visible to FloatingCard at all -- that component observes its own box with
  // a ResizeObserver, so a height written here is picked up and the popover
  // re-places itself around the taller card.
  useLayoutEffect(() => {
    const field = fieldRef.current
    if (!field) return
    field.style.height = 'auto'
    field.style.height = `${Math.min(field.scrollHeight, MAX_FIELD_HEIGHT_PX)}px`
  }, [text, isOpen])

  const handleClose = (): void => {
    setText('')
    setError(null)
    closeComposer()
  }

  const handleSubmit = (): void => {
    if (text.trim() === '') return
    // Trimmed, not raw: the field is multi-line, so a Shift+Enter the user
    // changed their mind about leaves a trailing newline that would otherwise
    // be encoded into the marker and rendered as a blank line in the Comments
    // sidebar forever. Interior newlines -- the whole point of the multi-line
    // field -- are untouched.
    const applied = onAddComment(text.trim())
    if (!applied) {
      setError('Select some text within a single paragraph first.')
      return
    }
    handleClose()
  }

  // ENTER SUBMITS, SHIFT+ENTER INSERTS A NEWLINE -- deliberately that way
  // round, not the reverse, and unchanged by the move to a popover.
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
  //
  // Escape is deliberately absent here -- FloatingCard owns one window-level
  // listener registered unconditionally on mount, which also catches an Escape
  // pressed while focus has moved out of this field (the canvas and tab bar
  // stay clickable behind the popover). See LinkComposer's matching note.
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSubmit()
    }
  }

  return (
    <FloatingCard
      open={isOpen}
      measure={measure}
      paneRef={paneRef}
      onClose={handleClose}
      label="Add comment"
      widthPx={COMMENT_POPOVER_WIDTH_PX}
    >
      <div className="flex flex-col gap-1.5">
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
          // placeholder rather than as a hint row so it costs no height, and
          // sits exactly where the user is already looking.
          placeholder="Add a comment… (Shift+Enter for a new line)"
          // Safe for the same verified reason LinkComposer's own autoFocus is
          // (see that file's note): DOM focus and ProseMirror's
          // `state.selection` are independent, so focusing this field does not
          // disturb the range addCommentCommand will mark. Proven end to end
          // in the real app by tests/gates/gate27-comments.spec.ts, which types
          // here and then reads the marker back off disk.
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
          className="min-h-[30px] w-full min-w-0 resize-none overflow-y-auto rounded-sm border border-border-chrome bg-page px-2.5 py-1.5 text-12 leading-[1.4] text-text-primary"
        />
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
        {/* End-aligned, matching LinkComposer -- the two popovers are the same
        control in two flavours and should not read as two different designs. */}
        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={handleClose}
            className="flex-none rounded-sm px-2 py-1 text-12 text-text-secondary transition-colors hover:bg-chrome-light"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={text.trim() === ''}
            className="flex-none rounded-sm border border-border-chrome px-2.5 py-1 text-12 text-text-primary transition-colors hover:bg-chrome-light disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add
          </button>
        </div>
      </div>
    </FloatingCard>
  )
}

export default CommentComposer
