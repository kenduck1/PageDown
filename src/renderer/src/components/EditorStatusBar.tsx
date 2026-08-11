import { useMemo, useState } from 'react'
import { analyzeText } from '../lib/wordCount'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
// Moved out of this file and into lib/ so View > Zoom In/Out/Actual Size in
// the application menu steps through the EXACT same levels this <select>
// renders -- a zoom value not in this list makes the control render blank,
// so the two surfaces have to share the list itself, not just a range.
import { ZOOM_OPTIONS } from '../lib/zoom-levels'

// Product-completeness audit §2.4: `analyzeText` runs a full remark parse
// (see wordCount.ts), and this component recomputed it synchronously on
// EVERY render whose `content` prop changed -- which, in Source mode, is
// EVERY keystroke (SourceEditor writes the store directly per keystroke,
// unlike Format mode's Milkdown mount, which only calls back through its own
// 200ms-debounced `markdownUpdated`; see CLAUDE.md's "Quirk" note on that
// debounce). On a large document (measured directly, via `tsx` against the
// real module: ~215ms mean per parse on the 523KB/322-page `very-long.md`
// corpus fixture, Node/V8 -- see this sub-project's own report for the full
// before/after numbers) that is a real, synchronous, main-thread block WELL
// past the ~100ms "instant" perception threshold, on every single character
// typed in Source mode.
//
// Three fixes were weighed:
//   1. Debounce the stats the way `usePageCount` already debounces its own
//      IPC round trip (chosen).
//   2. Compute from a cheaper source (e.g. a naive `content.split(/\s+/)`
//      instead of a real parse). Rejected: the current implementation is
//      already correct in ways a naive split is not (excludes code/
//      frontmatter, merges "un*bel*ievable" into one word, counts
//      "**bold**." as one word not two -- see wordCount.ts's own test
//      suite) -- the task was explicitly to extend it, not regress its
//      accuracy for a speed win a debounce achieves for free anyway.
//   3. Share one parse across every renderer-side consumer that runs its
//      own remark parse off the same `content` (this component, plus
//      EditorOutline's extractOutline and RemoteImageBanner's
//      documentHasRemoteImages). Rejected FOR THIS COMPONENT specifically:
//      those three live in separate, non-nested subtrees (this bar,
//      EditorSidebar's Outline tab, and a top-level layout row), so sharing
//      one memoized tree would mean lifting a parse cache into a common
//      ancestor (EditorScreen) and threading a parsed-tree prop through
//      three unrelated components for a benefit debouncing already
//      captures -- a real architectural change, not a "close this one
//      finding" change. (RemoteImageBanner and EditorOutline got the same
//      debounce treatment independently, for the same reason, since they
//      have the identical bug shape -- see those files' own comments.)
//
// 200ms, not `usePageCount`'s own 500ms: this is a synchronous, in-process
// computation (no IPC round trip to wait out), so there's no reason to wait
// longer than Milkdown's own `markdownUpdated` debounce already imposes on
// Format mode -- this just gives Source mode the identical cadence Format
// mode already has "for free," rather than inventing a new number.
const STATS_DEBOUNCE_MS = 200

// A commonly-cited average adult silent-reading speed (Medium's own stated
// convention, among others) -- not intended to be precise per-document (that
// would need real prose-complexity analysis), just a standard, unsurprising
// estimate matching what other writing tools already show.
const WORDS_PER_MINUTE = 200

function formatReadingTime(words: number): string {
  const minutes = words / WORDS_PER_MINUTE
  if (minutes < 1) return '< 1 min read'
  return `${Math.round(minutes)} min read`
}

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
   * The scale the document canvas is CURRENTLY RENDERED AT, as a CSS
   * multiplier (1 = 100%, 0.5 = 50%, 2 = 200%), NOT a raw percentage number.
   *
   * In Format and Source mode that is the user's own chosen zoom, and
   * `zoomEnabled` is true so this control also sets it. In Split mode it is
   * EditorScreen's computed fit-to-width scale (`computeFitScale`), and
   * `zoomEnabled` is false -- the readout is then reporting a number the user
   * cannot change, which is the honest reading of "zoom" in a mode whose scale
   * is chosen by the pane's width. Feeding the user's inapplicable zoom here
   * instead would restate the very defect this control was already fixed for
   * once (see `zoomEnabled` below).
   *
   * EditorScreen applies it: CSS `zoom` on an inner wrapper inside the
   * scrolling pane, in both the single-pane and Split branches. This component
   * never applies it itself.
   */
  zoom: number
  onZoomChange: (zoom: number) => void
  /**
   * Whether zoom can actually be applied to what is currently on screen.
   * Defaults to `true`, so this component's own standalone tests (and any
   * caller that has no mode concept) keep the pre-existing behaviour.
   *
   * `false` in Split mode, and that is a correctness fix rather than polish:
   * Split's two-pane row renders outside `EditorScreen`'s zoom wrapper on
   * purpose (its right pane is a native `WebContentsView` whose bounds come
   * from a DOM rect that a CSS scale would silently desync), so the control
   * used to accept a change, report it, and change nothing -- measured: 150%
   * selected in Split left the pane transform at "none" and the page card's
   * rect unchanged while this readout said 150%, and switching back to Format
   * then jumped the document to 150% out of nowhere. Disabled, not hidden: the
   * current level is still worth reading, and a control that disappears and
   * reappears on every mode switch is its own kind of noise.
   */
  zoomEnabled?: boolean
  /**
   * A message describing the most recent Split-mode preview render failure,
   * or `null`/omitted when the last attempt succeeded (or Split mode isn't
   * active). EditorScreen owns this -- it clears automatically on the next
   * successful render and is reset entirely on leaving Split mode -- see
   * that screen's own `splitPreviewError` state and SplitPreview's
   * `onRenderError` prop for the source of truth.
   */
  splitPreviewError?: string | null
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
  onZoomChange,
  zoomEnabled = true,
  splitPreviewError
}: EditorStatusBarProps): React.JSX.Element {
  const debouncedContent = useDebouncedValue(content, STATS_DEBOUNCE_MS)
  const { words: wordCount, characters: characterCount } = useMemo(
    () => analyzeText(debouncedContent),
    [debouncedContent]
  )
  const [jumpDraft, setJumpDraft] = useState<string | null>(null)
  // A controlled `<select>` whose `value` is not among its own options renders
  // BLANK -- zoom-levels.ts's own module comment records that trap, and it is
  // reachable for real now that Split mode reports a fit-to-width scale here
  // rather than the (inapplicable, and therefore untrue) user-chosen zoom.
  // Those scales are quantised to whole percents but are otherwise arbitrary,
  // so 71% is a perfectly ordinary value and is not on the manual list.
  //
  // Showing the REAL scale rather than leaving the readout at "100%" is the
  // point: a readout that says 100% while the pane renders at 71% is the exact
  // defect the second product audit found and fixed here (150% reported while
  // `paneTransform` stayed "none"), just pointing the other way. The extra
  // option is only ever appended when the control is disabled, so the manual
  // list a user can actually pick from is unchanged.
  const zoomOptions = useMemo(() => {
    if (ZOOM_OPTIONS.some((option) => option.value === zoom)) return ZOOM_OPTIONS
    const fitOption = { label: `${Math.round(zoom * 100)}%`, value: zoom }
    return [...ZOOM_OPTIONS, fitOption].sort((a, b) => a.value - b.value)
  }, [zoom])
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
          disabled={!zoomEnabled}
          // Names the reason before the click, the same convention the page
          // navigation controls above already follow ("Next page (shown in
          // Split view)") -- a greyed control with no explanation reads as
          // broken.
          title={
            zoomEnabled
              ? undefined
              : 'Split view scales the page to fit the editor pane; zoom applies to Format and Source view'
          }
          className="rounded-sm bg-transparent text-11-5 text-text-secondary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {zoomOptions.map((option) => (
            <option key={option.value} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {/* The document statistics cluster -- word count (pre-existing),
      plus character count and reading time (product-completeness audit
      §2.4's "other half": word count was the entire statistics surface).
      Three separate text nodes, not one combined string, so existing
      queries like `getByText('5 words')` keep matching an exact node
      rather than a substring of a longer sentence -- and so a screen
      reader's or test's search for one figure never has to parse the
      others out of it. The middle-dot separators are aria-hidden: they're
      pure visual punctuation with nothing for a screen reader to announce,
      and each real span already reads as a complete, self-contained
      phrase in sequence without needing "and" or a spoken dot between them. */}
      <span>
        {wordCount} {wordCount === 1 ? 'word' : 'words'}
      </span>
      <span aria-hidden="true" className="text-text-tertiary">
        ·
      </span>
      <span>
        {characterCount} {characterCount === 1 ? 'character' : 'characters'}
      </span>
      <span aria-hidden="true" className="text-text-tertiary">
        ·
      </span>
      <span>{formatReadingTime(wordCount)}</span>

      {/* Product-completeness audit Tier 3, B.3: Split-mode preview render
      failures used to be console-only -- the preview silently kept showing
      stale content with no indication anything was wrong. Placed in the
      status bar rather than as a layout row (like FindBar/CommentComposer/
      RemoteImageBanner) deliberately: those rows shrink/grow the content
      area on open/close, which would resize the native preview pane's own
      bounds (see SplitPreview.tsx's ResizeObserver chain) every time this
      flips -- exactly the kind of visual noise "without being noisy" rules
      out. The status bar's height never changes, so this can appear/
      disappear with zero effect on the preview's own layout. `role="status"`
      (implicit aria-live="polite") is deliberately different from the
      pageCountPending dot above, which explicitly avoids any live region --
      that dot re-renders every debounce cycle with no new INFORMATION each
      time (see its own comment), while this text only changes between two
      genuinely different, meaningful states (a real failure vs. resolved),
      so there is nothing to "chatter" about. */}
      {splitPreviewError && (
        <span role="status" aria-live="polite" title={splitPreviewError} className="text-amber-600">
          Preview may be out of date
        </span>
      )}

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
