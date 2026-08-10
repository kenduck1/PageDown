import type { KeyboardEvent, ReactElement, ReactNode, RefObject } from 'react'
import { useFindStore } from '../store/findStore'

// A LAYOUT ROW, never a floating panel -- and that is an architectural
// requirement, not an aesthetic one. Split mode's preview pane is a real
// native WebContentsView, and a WebContentsView composites above ALL DOM
// unconditionally; this already bit PageSetupModal, which was found partially
// occluded (including its own buttons) and had to be fixed by reporting a
// zero-size rectangle while it is open. A floating find panel over the canvas
// would need exactly that same special-casing. A layout row cannot: inserting
// it SHRINKS the content area, which changes SplitPreview's placeholder rect,
// which fires its existing ResizeObserver, which re-reports bounds over the
// existing IPC -- the preview simply moves down. No new occlusion handling, no
// new IPC, no pageSetupOpen-style flag.
//
// This component owns no match state of its own: it reads and writes
// findStore, and the two replace actions are props, because performing a
// replace requires knowing which surface is active -- which is
// useFindController's job, not this component's.
export interface FindBarProps {
  onReplace: () => void
  onReplaceAll: () => void
  queryInputRef: RefObject<HTMLInputElement | null>
}

function ChevronUpIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 15l6-6 6 6" />
    </svg>
  )
}

function ChevronDownIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

function DisclosureChevronIcon({ expanded }: { expanded: boolean }): ReactElement {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`transition-transform ${expanded ? 'rotate-0' : '-rotate-90'}`}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

function CloseIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

interface BarIconButtonProps {
  label: string
  onClick: () => void
  // Only pass this for a genuinely toggleable control (Match case, Whole
  // word, Toggle replace) -- see EditorToolbar.tsx's own ToolbarIconButton
  // for the full rationale this mirrors: a screen reader announces
  // `aria-pressed="false"` as "toggle button, currently off," which is
  // actively misleading on a one-shot action button (Previous/Next match,
  // Close find). One-shot buttons must omit this prop entirely.
  pressed?: boolean
  disabled?: boolean
  children: ReactNode
}

// 30x30 hit target / rounded-sm, matching EditorToolbar's own
// ToolbarIconButton shape -- this bar sits directly beneath that toolbar and
// is meant to read as the same chrome language, not a visually distinct one.
function BarIconButton({
  label,
  onClick,
  pressed,
  disabled = false,
  children
}: BarIconButtonProps): ReactElement {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-[30px] w-[30px] flex-none items-center justify-center rounded-sm text-12 transition-colors ${
        pressed ? 'bg-accent/14 text-accent' : 'text-text-secondary hover:bg-chrome-light'
      } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
    >
      {children}
    </button>
  )
}

function ReplaceActionButton({
  label,
  onClick,
  disabled
}: {
  label: string
  onClick: () => void
  disabled: boolean
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex-none rounded-sm border border-border-chrome px-2.5 py-1 text-12 text-text-primary transition-colors hover:bg-chrome-light disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  )
}

function FindBar({ onReplace, onReplaceAll, queryInputRef }: FindBarProps): ReactElement | null {
  const isOpen = useFindStore((state) => state.isOpen)
  const replaceExpanded = useFindStore((state) => state.replaceExpanded)
  const query = useFindStore((state) => state.query)
  const replacement = useFindStore((state) => state.replacement)
  const caseSensitive = useFindStore((state) => state.options.caseSensitive)
  const wholeWord = useFindStore((state) => state.options.wholeWord)
  const matchCount = useFindStore((state) => state.matchCount)
  const activeIndex = useFindStore((state) => state.activeIndex)
  const capped = useFindStore((state) => state.capped)
  const setQuery = useFindStore((state) => state.setQuery)
  const setReplacement = useFindStore((state) => state.setReplacement)
  const toggleCaseSensitive = useFindStore((state) => state.toggleCaseSensitive)
  const toggleWholeWord = useFindStore((state) => state.toggleWholeWord)
  const toggleReplaceExpanded = useFindStore((state) => state.toggleReplaceExpanded)
  const goToNext = useFindStore((state) => state.goToNext)
  const goToPrevious = useFindStore((state) => state.goToPrevious)
  const closeFind = useFindStore((state) => state.closeFind)

  if (!isOpen) return null

  const noMatches = matchCount === 0
  const countText =
    query === ''
      ? ''
      : noMatches
        ? 'No results'
        : `${activeIndex + 1} / ${matchCount}${capped ? '+' : ''}`

  const handleQueryKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (event.shiftKey) {
      goToPrevious()
    } else {
      goToNext()
    }
  }

  return (
    <div
      role="search"
      aria-label="Find and replace"
      className="flex flex-none flex-col gap-1.5 border-b border-border-chrome bg-chrome-dark px-3 py-1.5 text-12 text-text-secondary"
    >
      <div className="flex items-center gap-1.5">
        <BarIconButton
          label="Toggle replace"
          onClick={toggleReplaceExpanded}
          pressed={replaceExpanded}
        >
          <DisclosureChevronIcon expanded={replaceExpanded} />
        </BarIconButton>

        <input
          ref={queryInputRef}
          type="text"
          aria-label="Find"
          placeholder="Find"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleQueryKeyDown}
          className="h-[30px] min-w-0 flex-1 rounded-sm border border-border-chrome bg-page px-2.5 text-12 text-text-primary"
        />

        {/* Product-completeness audit Tier 3, B.1: this readout had no live
        region at all, so "3 / 12" flipping to "No results" (or vice versa)
        as the user edits the query was invisible to a screen-reader user --
        sighted feedback only. `aria-live="polite"`, not `role="alert"`
        (assertive): this text changes on every keystroke while the user is
        actively typing in the adjacent input, and an assertive region
        INTERRUPTS whatever the screen reader is currently announcing --
        including, on some AT/browser combinations, the user's own just-typed
        character -- on every single change. Polite instead QUEUES the
        announcement behind whatever's in progress and, per how every major
        screen reader actually implements polite live regions, naturally
        coalesces a fast run of updates into announcing whatever the region's
        content settled on, not a separate utterance per keystroke -- so no
        extra debounce is needed here on top of that platform behavior
        (unlike EditorStatusBar's word count, which had to debounce because
        the cost there is a synchronous parse blocking the render thread, an
        entirely different problem from "how many things get spoken aloud").
        `aria-atomic="true"` makes the whole phrase re-read as one unit
        ("1 / 5000+") rather than a diff of what changed, which is the only
        sensible way to consume a count like this. */}
        <span
          data-testid="find-count"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="w-16 flex-none text-center text-11-5 text-text-tertiary"
        >
          {countText}
        </span>

        <div className="flex flex-none items-center gap-0.5">
          <BarIconButton label="Previous match" onClick={goToPrevious} disabled={noMatches}>
            <ChevronUpIcon />
          </BarIconButton>
          <BarIconButton label="Next match" onClick={goToNext} disabled={noMatches}>
            <ChevronDownIcon />
          </BarIconButton>
        </div>

        <div className="mx-0.5 h-5 w-px flex-none bg-border-chrome" aria-hidden="true" />

        <div className="flex flex-none items-center gap-0.5">
          <BarIconButton label="Match case" onClick={toggleCaseSensitive} pressed={caseSensitive}>
            <span className="text-12 font-medium leading-none">Aa</span>
          </BarIconButton>
          <BarIconButton label="Whole word" onClick={toggleWholeWord} pressed={wholeWord}>
            <span className="text-12 font-medium leading-none">ab</span>
          </BarIconButton>
        </div>

        <BarIconButton label="Close find" onClick={closeFind}>
          <CloseIcon />
        </BarIconButton>
      </div>

      {replaceExpanded && (
        <div className="flex items-center gap-1.5 pl-[36px]">
          <input
            type="text"
            aria-label="Replace with"
            placeholder="Replace with (plain text)"
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            className="h-[30px] min-w-0 flex-1 rounded-sm border border-border-chrome bg-page px-2.5 text-12 text-text-primary"
          />
          <ReplaceActionButton label="Replace" onClick={onReplace} disabled={noMatches} />
          <ReplaceActionButton label="Replace all" onClick={onReplaceAll} disabled={noMatches} />
        </div>
      )}
    </div>
  )
}

export default FindBar
