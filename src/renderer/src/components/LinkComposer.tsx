import { useState, type KeyboardEvent, type ReactElement } from 'react'
import { useAppStore } from '../store/appStore'

// A LAYOUT ROW, never a floating popover -- the same architectural
// requirement FindBar.tsx documents at length and CommentComposer.tsx already
// reuses: Split mode's preview pane is a real native WebContentsView, which
// composites above ALL DOM unconditionally, so any floating overlay needs the
// zero-size-rectangle special-casing PageSetupModal had to add. A layout row
// sidesteps this by construction -- inserting it shrinks the content area,
// which moves SplitPreview's placeholder, which fires its existing
// ResizeObserver, which re-reports bounds over existing IPC.
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
// same Enter-to-confirm/Escape-to-cancel keyboard contract, same placement in
// EditorScreen's layout-row stack -- rather than inventing a second shape for
// what is structurally the same interaction (a one-field inline prompt over
// the current selection).
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
  // the underlying command (toggleLinkCommand, via
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
  // exactly the class of dead control this pass exists to eliminate.
  onRemoveLink: () => void
}

function LinkComposer({
  initialHref,
  onInsertLink,
  onRemoveLink
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

  if (!isOpen) return null

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
      aria-label="Insert link"
      className="flex flex-none items-center gap-1.5 border-b border-border-chrome bg-chrome-dark px-3 py-1.5 text-12 text-text-secondary"
    >
      <span className="flex-none">{initialHref === '' ? 'Link' : 'Edit link'}</span>
      <input
        type="text"
        aria-label="Link URL"
        placeholder="https://example.com"
        // autoFocus so the user can type the URL immediately, exactly as
        // CommentComposer does -- and safe for the same verified reason:
        // moving DOM focus out of the editor does NOT disturb ProseMirror's
        // own `state.selection`, which is what toggleLinkCommand reads. This
        // is why applyFindState's rule (never call view.focus()) is not
        // violated here either: nothing in this component touches the editor
        // view at all, in either direction. The comment feature -- the same
        // "focus an input row, then apply a mark to the still-selected
        // range" flow -- is proven end to end in the real app by
        // phase0/gate27-comments.spec.ts.
        autoFocus
        value={href}
        onChange={(e) => setHref(e.target.value)}
        onKeyDown={handleKeyDown}
        className="h-[30px] min-w-0 flex-1 rounded-sm border border-border-chrome bg-page px-2.5 text-12 text-text-primary"
      />
      <button
        type="button"
        onClick={handleSubmit}
        disabled={href.trim() === ''}
        className="flex-none rounded-sm border border-border-chrome px-2.5 py-1 text-12 text-text-primary transition-colors hover:bg-chrome-light disabled:cursor-not-allowed disabled:opacity-40"
      >
        {initialHref === '' ? 'Insert' : 'Update'}
      </button>
      {initialHref !== '' && (
        <button
          type="button"
          onClick={() => {
            onRemoveLink()
            handleClose()
          }}
          className="flex-none rounded-sm border border-border-chrome px-2.5 py-1 text-12 text-text-primary transition-colors hover:bg-chrome-light"
        >
          Remove link
        </button>
      )}
      <button
        type="button"
        onClick={handleClose}
        className="flex-none rounded-sm px-2.5 py-1 text-12 text-text-secondary transition-colors hover:bg-chrome-light"
      >
        Cancel
      </button>
    </div>
  )
}

export default LinkComposer
