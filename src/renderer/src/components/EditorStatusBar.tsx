import { useMemo, useState } from 'react'
import { countWords } from '../lib/wordCount'
// Moved out of this file and into lib/ so View > Zoom In/Out/Actual Size in
// the application menu steps through the EXACT same levels this <select>
// renders -- a zoom value not in this list makes the control render blank,
// so the two surfaces have to share the list itself, not just a range.
import { ZOOM_OPTIONS } from '../lib/zoom-levels'

export interface EditorStatusBarProps {
  content: string
  isDirty: boolean
  /**
   * Total pages, or null while the count is still being computed. The count
   * is owned by EditorScreen (one usePageCount for the whole editor) rather
   * than fetched here -- navigation needs ONE authoritative total to clamp
   * against, and this component used to run a second, independent
   * usePageCount with its own debounce timer.
   */
  pageCount: number | null
  /**
   * True while a fresh page count is in flight (`usePageCount`'s own
   * `loading`). Drives a small in-progress dot next to the reading -- the
   * "subtle in-progress indicator" half of the design doc's requirement that
   * this control "shows the last known-good value with a subtle in-progress
   * indicator -- never blank or flickering" (design:189). The other half is
   * `usePageCount` retaining the previous count across both a content change
   * and a failed fetch, so `pageCount` genuinely stays populated while this
   * is true.
   *
   * Deliberately does NOT disable or grey out anything: the retained count is
   * a real page count the user can still navigate against, and a control that
   * flickered between enabled and disabled on every debounce cycle would be
   * exactly the "flickering" the requirement rules out.
   */
  pageCountPending: boolean
  /** 1-based page currently shown by the paginated preview. */
  currentPage: number
  /**
   * Asks the app to show `page`. In Split mode this scrolls the preview; in
   * Format/Source mode EditorScreen switches to Split first -- which is why
   * the tooltips below say so before the click, rather than surprising the
   * user with a mode change after it.
   */
  onNavigateToPage: (page: number) => void
  /**
   * A CSS scale multiplier (1 = 100%, 0.5 = 50%, 2 = 200%), NOT a raw
   * percentage number. A future integration step is expected to apply this
   * directly as a CSS transform on the mounted editor's own scrollable
   * container, e.g. `style={{ transform: \`scale(${zoom})\` }}` (plus
   * `transformOrigin: 'top center'` or similar) on `MilkdownEditor`'s mount
   * element / its scroll container in `EditorScreen.tsx` -- this component
   * does not (and, being built in an isolated worktree with no access to
   * that markup, cannot) apply the transform itself. See this sub-project's
   * report for the full integration note.
   */
  zoom: number
  onZoomChange: (zoom: number) => void
}

function ChevronLeftIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 6l-6 6 6 6" />
    </svg>
  )
}

function ChevronRightIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

function CheckIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 13l4 4L19 7" />
    </svg>
  )
}

/**
 * The editor's status bar (design-handoff/README.md, "Editor — shared
 * chrome" item 5): page navigation, a zoom control, word count, and a
 * right-aligned autosave indicator.
 *
 * - Word count (real): computed from `content` via `countWords`
 *   (`../lib/wordCount`), memoized on `content`.
 * - Page count (real): supplied by `pageCount`, owned by `EditorScreen`
 *   (one `usePageCount` for the whole editor) rather than fetched here —
 *   see that prop's own doc comment.
 * - Page navigation (real): the chevrons step `currentPage` by one page and
 *   the "Page X of Y" control swaps to a focused number input for jumping
 *   directly to a page (see `docs/superpowers/specs/2026-08-08-page-
 *   navigation-design.md`). Navigation targets the Split-mode preview —
 *   the only surface in this app with real page boundaries, since the
 *   Format-mode editor canvas is one continuous card with no page
 *   divisions — so navigating while in Format/Source mode switches to
 *   Split first. The tooltips name that consequence before the click
 *   rather than surprising the user with a mode change after it.
 * - Zoom (real): a genuine CSS scale value, driven entirely by this
 *   component's own dropdown via the `onZoomChange` prop. This component
 *   has no access to the editor's mount container (it's built in isolation
 *   from `EditorScreen`/`MilkdownEditor`), so it cannot apply the transform
 *   itself — see the `zoom` prop's own doc comment above for exactly what a
 *   future integration step needs to do with this value.
 */
function EditorStatusBar({
  content,
  isDirty,
  pageCount,
  pageCountPending,
  currentPage,
  onNavigateToPage,
  zoom,
  onZoomChange
}: EditorStatusBarProps): React.JSX.Element {
  const wordCount = useMemo(() => countWords(content), [content])
  const [jumpDraft, setJumpDraft] = useState<string | null>(null)
  const hasPages = typeof pageCount === 'number' && pageCount > 0
  const canGoPrevious = hasPages && currentPage > 1
  const canGoNext = hasPages && currentPage < (pageCount as number)

  const commitJump = (): void => {
    const draft = jumpDraft ?? ''
    const parsed = Number(draft)
    setJumpDraft(null)
    // An emptied input is a cancel, not a jump to page 1. `Number('')` is 0,
    // which is finite, so without this check clearing the field and pressing
    // Enter silently navigated to page 1 -- the one thing the user plainly
    // did not ask for. (A `type="number"` input also reports '' for any
    // value the browser considers invalid, so this covers that too.)
    if (draft.trim() === '') return
    if (!Number.isFinite(parsed) || !hasPages) return
    const clamped = Math.min(Math.max(Math.floor(parsed), 1), pageCount as number)
    onNavigateToPage(clamped)
  }

  return (
    <div className="flex h-8 flex-shrink-0 items-center gap-4 border-t border-border-chrome bg-chrome-dark px-3 text-11-5 text-text-secondary">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onNavigateToPage(currentPage - 1)}
          disabled={!canGoPrevious}
          aria-label="Previous page"
          title="Previous page (shown in Split view)"
          className="flex h-5 w-5 items-center justify-center rounded-sm disabled:opacity-40"
        >
          <ChevronLeftIcon />
        </button>
        {jumpDraft === null ? (
          <button
            type="button"
            onClick={() => setJumpDraft(String(currentPage))}
            disabled={!hasPages}
            title="Jump to page (shown in Split view)"
            className="px-0.5 disabled:opacity-40"
          >
            Page {currentPage} of {pageCount ?? '—'}
          </button>
        ) : (
          <input
            type="number"
            autoFocus
            aria-label="Jump to page"
            value={jumpDraft}
            min={1}
            max={pageCount ?? 1}
            onChange={(event) => setJumpDraft(event.target.value)}
            onBlur={() => setJumpDraft(null)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitJump()
              if (event.key === 'Escape') setJumpDraft(null)
            }}
            className="w-14 rounded-sm bg-transparent px-1 text-11-5 text-text-primary"
          />
        )}
        <button
          type="button"
          onClick={() => onNavigateToPage(currentPage + 1)}
          disabled={!canGoNext}
          aria-label="Next page"
          title="Next page (shown in Split view)"
          className="flex h-5 w-5 items-center justify-center rounded-sm disabled:opacity-40"
        >
          <ChevronRightIcon />
        </button>
        {/* AFTER the Next chevron, not beside the reading it describes, and
        that placement is deliberate: this element appears and disappears on
        every debounce cycle while the user types, and anything it precedes in
        this flex row shifts by its width each time. Sitting last means the
        three navigation controls -- the ones a user (and every gate spec)
        actually clicks -- never move.

        aria-hidden with a `title` rather than a live region: role="status"
        here would make a screen reader announce a re-count on every one of
        those cycles. The number to its left is the actual information, and
        the whole point of this feature is that the number stays put. */}
        {pageCountPending && (
          <span
            data-testid="page-count-pending"
            aria-hidden="true"
            title="Updating page count…"
            className="h-1 w-1 rounded-full bg-text-tertiary motion-safe:animate-pulse"
          />
        )}
      </div>

      <label className="flex items-center gap-1">
        <span className="sr-only">Zoom level</span>
        <select
          value={String(zoom)}
          onChange={(event) => onZoomChange(Number(event.target.value))}
          className="rounded-sm bg-transparent text-11-5 text-text-secondary"
        >
          {ZOOM_OPTIONS.map((option) => (
            <option key={option.value} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <span>
        {wordCount} {wordCount === 1 ? 'word' : 'words'}
      </span>

      <span className="ml-auto flex items-center gap-1">
        {isDirty ? (
          <span className="text-text-secondary">Unsaved changes</span>
        ) : (
          <span className="flex items-center gap-1 text-text-tertiary">
            <CheckIcon />
            Saved
          </span>
        )}
      </span>
    </div>
  )
}

export default EditorStatusBar
