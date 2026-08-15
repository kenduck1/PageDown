import { useState, type KeyboardEvent, type ReactElement, type RefObject } from 'react'
import FloatingCard from './FloatingCard'
import type { Rect } from '../lib/floating-position'
import { useAppStore } from '../store/appStore'

// A POPOVER ANCHORED AT THE SELECTION, via FloatingCard -- not the full-width
// layout row this used to be.
//
// WHY IT MOVED. It was a row because a WebContentsView (Split mode's live
// preview) composites above ALL DOM unconditionally, so a floating panel gets
// silently painted over -- the reasoning FindBar documents at length and this
// component originally copied by analogy. That reasoning is still exactly right
// for FindBar (a find bar is conventionally full-width, and being a row is what
// lets it RESIZE the preview instead of covering it) and was never right for a
// URL field, which belongs at the cursor: the app already pops a
// SelectionBubble at the selection, and its own Link button then threw the
// user's eye to a strip at the top of the window. The occlusion problem is
// solved rather than dodged, by the clamp SelectionBubble already proved out --
// see FloatingCard.tsx's header for the full argument and for why this is the
// third caller of lib/floating-position.ts rather than a second clamp.
//
// WHY THIS EXISTS AT ALL: EditorToolbar's "Insert link" button used to call
// `window.prompt('Link URL')`. In Electron's renderer that call THROWS
// ("Error: prompt() is not supported.", measured directly in the real built
// app) -- it does not return null and it does not open a dialog. The throw
// happened on the line BEFORE `editorRef.current?.insertLink(href)`, so the
// feature was completely dead: no dialog, no link, no error surfaced anywhere
// (this renderer has no global error handler and no ErrorBoundary, and
// documentStore.error was never touched). The two tests that covered it
// `vi.spyOn(window, 'prompt')`-mocked the exact broken call, so they stayed
// green the whole time -- see EditorToolbar.test.tsx for their replacements,
// which now spy on `prompt` only to assert it is NEVER called.
//
// Modeled on CommentComposer.tsx deliberately -- same store-boolean trigger,
// same Enter-to-confirm/Escape-to-cancel keyboard contract, same FloatingCard
// shell -- rather than inventing a second shape for what is structurally the
// same interaction (a one-field inline prompt over the current selection).
export interface LinkComposerProps {
  // The href of the link the selection is ALREADY on, or '' when there is
  // none. Until the capability-gap pass this component seeded its input from
  // `useState('')` and never looked at the document at all, so there was no
  // way to see -- let alone correct -- an existing link's URL: the field
  // opened blank every time, and submitting a "correction" over already-linked
  // text ran toggleMark's REMOVE branch and destroyed the link (see
  // EditorCommands.insertLink for that mechanism). Prefilling is half the fix;
  // the update-vs-toggle branch in insertLink is the other half.
  initialHref: string
  // Called with the trimmed URL when the user confirms. Returns nothing,
  // deliberately unlike CommentComposer's `onAddComment: (text) => boolean`:
  // the underlying command (updateLinkCommand / toggleLinkCommand, via
  // editor-commands.ts's insertLink) has no refusal condition to surface.
  // Applying it over a collapsed selection sets a STORED mark that takes
  // effect on the next character typed -- documented, intended toggleMark
  // behavior (see EditorCommands.insertLink's own doc comment), not a
  // failure -- so there is nothing here for an inline error to report, and
  // inventing a boolean would be a fake seam.
  onInsertLink: (href: string) => void
  // Dispatched instead of onInsertLink when the user clicks "Remove link".
  // Only reachable when `initialHref` is non-empty -- there is nothing to
  // remove otherwise, and a permanently present button that silently no-ops is
  // exactly the class of dead control this pass exists to eliminate. Backed by
  // a real unlinkCommand rather than toggleLinkCommand, which splits a link in
  // half on a partial selection and does nothing at all from a caret.
  onRemoveLink: () => void
  // Where to anchor, read at call time -- see FloatingCard's own `measure`
  // doc comment for why this is a function rather than two rect props.
  measure: () => { anchor: Rect | null; safe: Rect | null }
  // The scrolling editor pane, so the popover follows the text when the pane
  // resizes under it.
  paneRef: RefObject<HTMLElement | null>
}

// Wide enough for a realistic URL to be readable without horizontal scrolling,
// narrow enough to sit inside Split mode's left pane at the default 50/50
// ratio. FloatingCard clamps it down further via computeFloatingPosition's own
// maxWidth when the pane is narrower still (MIN_SPLIT_RATIO leaves ~168px), so
// this is a preference, never a floor that could push the popover under the
// native preview view.
const LINK_POPOVER_WIDTH_PX = 300

function LinkComposer({
  initialHref,
  onInsertLink,
  onRemoveLink,
  measure,
  paneRef
}: LinkComposerProps): ReactElement | null {
  const isOpen = useAppStore((state) => state.linkComposerOpen)
  const closeComposer = useAppStore((state) => state.closeLinkComposer)
  const [href, setHref] = useState('')
  // Seeding on OPEN, not on mount, and via React's own "adjust state during
  // render" pattern rather than an effect. Two constraints force this shape:
  // this component is rendered unconditionally by EditorScreen and returns
  // null while closed, so it never unmounts and a `useState(initialHref)`
  // initialiser would run exactly once, for the very first document, forever;
  // and mirroring an external value into local state from a `useEffect` trips
  // this project's `react-hooks/set-state-in-effect` rule (a real cascading-
  // render warning), the same trap SettingsScreen's autosave-interval field
  // documents and solves the same way.
  const [wasOpen, setWasOpen] = useState(false)
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen)
    if (isOpen) setHref(initialHref)
  }

  const handleClose = (): void => {
    setHref('')
    closeComposer()
  }

  const handleSubmit = (): void => {
    const trimmed = href.trim()
    // Trimmed, and empty-guarded, matching the `if (href)` guard the old
    // prompt-based code had -- except that guard let a whitespace-only string
    // through, which would have produced a link with a blank href.
    if (trimmed === '') return
    onInsertLink(trimmed)
    handleClose()
  }

  // Enter only. ESCAPE IS DELIBERATELY NOT HANDLED HERE ANY MORE: FloatingCard
  // registers one window-level Escape listener, unconditionally on mount, and
  // that is strictly the better home for it -- a field-level handler can only
  // see a keypress that reaches the field, and this popover leaves the canvas
  // and the tab bar fully clickable behind it, so the user can easily be
  // pressing Escape with focus somewhere else entirely. Keeping both would
  // have been harmless (closeLinkComposer is an idempotent "set false") but
  // would leave two places to keep in step.
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
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
      label="Insert link"
      widthPx={LINK_POPOVER_WIDTH_PX}
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-11-5 text-text-secondary">
          {initialHref === '' ? 'Link' : 'Edit link'}
        </span>
        <input
          type="text"
          aria-label="Link URL"
          placeholder="https://example.com"
          // autoFocus so the user can type the URL immediately, exactly as
          // CommentComposer does -- and safe for the same verified reason,
          // which is the single most important fact about this whole surface:
          // moving DOM focus out of the editor does NOT disturb ProseMirror's
          // own `state.selection`, which is what updateLinkCommand/
          // toggleLinkCommand read. Selection is document state; focus is not.
          // This is also why applyFindState's rule (never call view.focus())
          // is not violated: nothing in this component touches the editor view
          // at all, in either direction. Proven end to end in the real app by
          // tests/gates/gate27-comments.spec.ts for the comment composer -- the
          // identical flow -- and now by gate34 for this one.
          autoFocus
          value={href}
          onChange={(e) => setHref(e.target.value)}
          onKeyDown={handleKeyDown}
          className="h-[30px] w-full min-w-0 rounded-sm border border-border-chrome bg-page px-2.5 text-12 text-text-primary"
        />
        {/* Right-aligned button row rather than the old row's left-to-right
        strip: at popover width the confirm action has to be findable at a
        glance, and end-alignment is the convention every anchored input panel
        in this app's reference set uses. `flex-wrap` because "Remove link"
        only exists when editing, and three buttons plus a clamped-narrow pane
        (Split at MIN_SPLIT_RATIO) is the one combination that can overflow. */}
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {initialHref !== '' && (
            <button
              type="button"
              onClick={() => {
                onRemoveLink()
                handleClose()
              }}
              className="mr-auto flex-none rounded-sm px-2 py-1 text-12 text-text-secondary transition-colors hover:bg-chrome-light"
            >
              Remove link
            </button>
          )}
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
            disabled={href.trim() === ''}
            className="flex-none rounded-sm border border-border-chrome px-2.5 py-1 text-12 text-text-primary transition-colors hover:bg-chrome-light disabled:cursor-not-allowed disabled:opacity-40"
          >
            {initialHref === '' ? 'Insert' : 'Update'}
          </button>
        </div>
      </div>
    </FloatingCard>
  )
}

export default LinkComposer
