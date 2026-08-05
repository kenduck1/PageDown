import { useMemo } from 'react'
import { countWords } from '../lib/wordCount'
import { usePageCount } from '../hooks/usePageCount'

export interface EditorStatusBarProps {
  content: string
  isDirty: boolean
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

const ZOOM_OPTIONS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '50%', value: 0.5 },
  { label: '75%', value: 0.75 },
  { label: '90%', value: 0.9 },
  { label: '100%', value: 1 },
  { label: '125%', value: 1.25 },
  { label: '150%', value: 1.5 },
  { label: '200%', value: 2 }
]

// Inert: real chevron-click page navigation needs a live, incrementally-
// repaginated preview to actually scroll/jump to -- this codebase's own
// Phase 0 Gate 7 findings (docs/superpowers/plans/2026-07-25-phase0-
// findings.md) are why that's a separate, larger, deferred sub-project
// rather than something this status bar can wire up on its own. Clicking
// either chevron currently does nothing.
// eslint-disable-next-line @typescript-eslint/no-empty-function
function noop(): void {}

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
 * Built as a standalone, isolated component (not wired into EditorScreen —
 * that integration is a separate, later step owned by whichever track
 * merges this in). Two pieces are deliberately real and two are
 * deliberately inert, per this sub-project's own scoping decision:
 *
 * - Word count (real): computed from `content` via `countWords`
 *   (`../lib/wordCount`), memoized on `content`.
 * - Page count (real): fetched via `usePageCount`, which debounces and
 *   round-trips through a dedicated main-process pagination harness
 *   (`file:getPageCount` IPC -> `src/main/page-count-generator.ts`) — a
 *   real, correct count from real Paged.js layout, not a placeholder.
 * - Page navigation (INERT): the chevrons and the "Page X of Y" jump-to-page
 *   control are visibly present but do nothing when clicked. Real chevron
 *   navigation and a real jump-to-page popover both require a live,
 *   incrementally-repaginated preview to navigate within — a separate,
 *   larger, deferred sub-project (see Phase 0 Gate 7's findings on why
 *   incremental re-layout is its own body of work). "Page 1" is a static
 *   placeholder for the same reason: there is no live current-page state to
 *   read yet, only a real total page count.
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
  zoom,
  onZoomChange
}: EditorStatusBarProps): React.JSX.Element {
  const wordCount = useMemo(() => countWords(content), [content])
  const { pageCount } = usePageCount(content)

  return (
    <div className="flex h-8 flex-shrink-0 items-center gap-4 border-t border-border-chrome bg-chrome-dark px-3 text-11-5 text-text-secondary">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={noop}
          aria-label="Previous page"
          title="Page navigation is not available yet"
          className="flex h-5 w-5 items-center justify-center rounded-sm"
        >
          <ChevronLeftIcon />
        </button>
        <button
          type="button"
          onClick={noop}
          title="Jump to page is not available yet"
          className="px-0.5"
        >
          Page 1 of {pageCount ?? '—'}
        </button>
        <button
          type="button"
          onClick={noop}
          aria-label="Next page"
          title="Page navigation is not available yet"
          className="flex h-5 w-5 items-center justify-center rounded-sm"
        >
          <ChevronRightIcon />
        </button>
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
