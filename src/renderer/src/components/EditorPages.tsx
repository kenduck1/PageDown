export interface EditorPagesProps {
  /** Total pages, or undefined while the count is still unknown. */
  pageCount?: number
  /** 1-based page currently shown by the paginated preview. */
  currentPage: number
  onSelectPage: (page: number) => void
}

/**
 * The sidebar's "Pages" tab: a clickable list of the document's real pages.
 *
 * Deliberately a numbered list rather than visual thumbnails (design doc:
 * docs/superpowers/specs/2026-08-08-page-navigation-design.md, D3). Real
 * per-page thumbnails would need a new offscreen render harness performing one
 * capturePage() per page on every settled edit -- the existing
 * thumbnail-generator captures a single page because its view is exactly one
 * page tall, and pages scrolled out of view are never painted, so there is no
 * cheap sub-rect trick. That cost lands hardest on exactly the long documents
 * this app targets. A list that genuinely navigates is real functionality; a
 * half-finished thumbnail renderer would not be.
 *
 * Selecting a page navigates the Split-mode preview, which is the only surface
 * in this app with real page boundaries -- see the design doc's
 * "architectural constraint" section.
 */
function EditorPages({
  pageCount,
  currentPage,
  onSelectPage
}: EditorPagesProps): React.JSX.Element {
  if (typeof pageCount !== 'number' || pageCount <= 0) {
    return (
      <div className="flex flex-1 flex-col items-center gap-2 px-4 py-6 text-center">
        <p className="text-11 text-text-tertiary">
          Page count is not available yet. It appears once the document has been laid out.
        </p>
      </div>
    )
  }

  return (
    <ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
      {Array.from({ length: pageCount }, (_unused, index) => index + 1).map((page) => {
        const isCurrent = page === currentPage
        return (
          <li key={page}>
            <button
              type="button"
              onClick={() => onSelectPage(page)}
              aria-current={isCurrent ? 'true' : undefined}
              className={`w-full rounded-sm px-2 py-1.5 text-left text-12 ${
                isCurrent ? 'bg-accent/14 font-semibold text-text-primary' : 'text-text-secondary'
              }`}
            >
              Page {page}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export default EditorPages
