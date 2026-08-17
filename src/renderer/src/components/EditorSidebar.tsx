import { useAppStore } from '../store/appStore'
import EditorOutline from './EditorOutline'
import EditorHistory from './EditorHistory'
import EditorPages from './EditorPages'
import EditorComments from './EditorComments'

export interface EditorSidebarProps {
  // Forwarded straight through to EditorOutline -- this component has no
  // direct store access to document content, so whatever eventually mounts
  // EditorSidebar (EditorScreen or a future split-mode container) is
  // responsible for supplying the real document.
  content: string
  onSelectHeading: (sourceOffset: number) => void
  activeSourceOffset?: number
  // Forwarded straight through to EditorPages -- the real page count once
  // the document has been laid out. Optional and un-guessed: omitting it
  // renders an honest "not available" note rather than a fabricated number.
  pageCount?: number
  // Forwarded straight through to EditorPages -- the 1-based page currently
  // shown by the paginated preview.
  currentPage: number
  onSelectPage: (page: number) => void
  // Forwarded straight through to EditorHistory -- null for a document that
  // has never been saved (no history is possible yet), matching the
  // documentStore mirror field's own type.
  filePath: string | null
  // `void | Promise<void>`: EditorScreen's handleRestoreVersion returns the
  // underlying flush+Save+replace promise rather than void-discarding it,
  // so EditorHistory can await this before refetching its snapshot list --
  // see EditorHistory.tsx's own comment on why that ordering matters.
  onRestoreVersion: (content: string) => void | Promise<void>
  // Forwarded straight through to EditorComments.
  onSelectComment: (id: string) => void
  onResolveComment: (id: string) => void
  /** The comment clicked in the document, highlighted in the Comments list. */
  activeCommentId?: string | null
}

// Segmented-control track/pill styling matches the real design-handoff
// prototype markup (docs/design-handoff/PageDown.dc.html)'s own `tab()`
// helper exactly: track background rgba(0,0,0,.05) over this rail's
// chrome-light backdrop composites to ~#eaeaec, close enough to the
// chrome-dark token (#ececee) that reusing it (rather than adding a new
// token) is the correct "closest existing token" call -- see this track's
// own token-choice note in the sub-project report. Active-pill white bg +
// soft shadow maps to the existing shadow-flat token (0 1px 3px rgba(0,0,0,.08)),
// the closest existing shadow to the prototype's own 0 1px 2px rgba(0,0,0,.1).
//
// `min-w-0` + `truncate` are a BACKSTOP, not the fix: the 2x2 grid below is
// what actually makes every label fit (see its own comment for the measured
// numbers). Without `min-w-0` a grid item's `min-width: auto` floors it at
// its own min-content width, which is exactly how the previous single-row
// layout came to overflow its track rather than shrink -- so a future fifth
// tab, a longer label, or a larger user font degrades to an ellipsis instead
// of silently bursting the track again.
function TabButton({
  label,
  isActive,
  onClick
}: {
  label: string
  isActive: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      // `title` only when it can actually say something the label doesn't --
      // never unconditionally: a tooltip that merely repeats fully-visible
      // text is noise. It is here purely so a truncated label (the backstop
      // case above) is still readable, which is also why it carries the same
      // string rather than a hand-written description.
      title={label}
      className={[
        'min-w-0 truncate rounded-sm px-1.5 py-[5px] text-center text-12 font-semibold',
        isActive ? 'bg-page text-text-primary shadow-flat' : 'text-text-secondary'
      ].join(' ')}
    >
      {label}
    </button>
  )
}

// The shared left rail: a Pages/Outline/History pill switcher over either a
// real page list (EditorPages), a real Outline (EditorOutline), or the
// version History tab. Reads/writes useAppStore's existing
// sidebarTab/setSidebarTab directly; document content and heading-selection/
// active-section state are plain props, since this component has no store of
// its own for document content.
function EditorSidebar({
  content,
  onSelectHeading,
  activeSourceOffset,
  pageCount,
  currentPage,
  onSelectPage,
  filePath,
  onRestoreVersion,
  onSelectComment,
  onResolveComment,
  activeCommentId
}: EditorSidebarProps): React.JSX.Element {
  const sidebarTab = useAppStore((state) => state.sidebarTab)
  const setSidebarTab = useAppStore((state) => state.setSidebarTab)

  return (
    <div className="flex h-full w-[216px] shrink-0 flex-col gap-3.5 border-r border-border-subtle bg-chrome-light p-3.5">
      {/* TWO ROWS, not one, and the numbers are measured rather than
          estimated (real built app, gate probe, both at the 1000px default
          window and at the 760px MIN_WINDOW_WIDTH -- identical, because this
          rail is `w-[216px] shrink-0` and therefore window-width-independent).

          This track's content box is 182px: 216 rail - 28 (`p-3.5` both
          sides) - 6 (`p-[3px]` both sides). The four labels measure 35.94 +
          42.59 + 43.17 + 63.74 = 185.44px of text, plus 3 gaps = 191.44px
          needed in ONE row. `flex-1` (`flex: 1 1 0%`) could not save it: a
          flex item's default `min-width: auto` floors it at its min-content
          width, so instead of shrinking to fit, the pills overflowed the
          track by ~9px with their text jammed edge-to-edge (they carried no
          horizontal padding at all). The Comments tab, added later, took this
          from three pills to four without the container being revisited.

          At 2 columns each cell is (182 - 2 gap) / 2 = 90px, against a
          worst-case 63.74px label -- every label fits with ~26px to spare,
          which is what pays for the `px-1.5` the pills now have. The cost is
          one extra ~24px row of vertical space in a rail whose panel below is
          `flex-1` and scrolls, at a 560px MIN_WINDOW_HEIGHT.

          REJECTED, each for a concrete reason rather than taste:
            - Icons + tooltips. The constraint here is purely horizontal and
              the rail has vertical room to spare, so paying with legibility
              (a tooltip is a hover-only, touch-hostile, screen-reader-only
              label) buys nothing this layout needs.
            - A wider rail. Fitting all four in one row needs ~200px of track,
              i.e. a ~240px rail -- on a 760px minimum window that is a third
              of the width, taken from the canvas, permanently, to save 24px
              of rail height.
            - A dropdown. Turns the rail's own navigation into two clicks and
              hides three of the four destinations.
            - Shorter labels. "Notes" is not what these are; the sidebar and
              the composer both say "comment" everywhere else.
            - Icon + text on the active pill only. Inactive pills would still
              need tooltips, and every pill's width would jump on each switch. */}
      <div className="grid grid-cols-2 gap-0.5 rounded-md bg-chrome-dark p-[3px]">
        <TabButton
          label="Pages"
          isActive={sidebarTab === 'pages'}
          onClick={() => setSidebarTab('pages')}
        />
        <TabButton
          label="Outline"
          isActive={sidebarTab === 'outline'}
          onClick={() => setSidebarTab('outline')}
        />
        <TabButton
          label="History"
          isActive={sidebarTab === 'history'}
          onClick={() => setSidebarTab('history')}
        />
        <TabButton
          label="Comments"
          isActive={sidebarTab === 'comments'}
          onClick={() => setSidebarTab('comments')}
        />
      </div>
      <div className="flex flex-1 flex-col overflow-hidden">
        {sidebarTab === 'outline' ? (
          <EditorOutline
            content={content}
            onSelectHeading={onSelectHeading}
            activeSourceOffset={activeSourceOffset}
          />
        ) : sidebarTab === 'history' ? (
          <EditorHistory filePath={filePath} onRestore={onRestoreVersion} />
        ) : sidebarTab === 'comments' ? (
          <EditorComments
            content={content}
            onSelectComment={onSelectComment}
            onResolveComment={onResolveComment}
            activeCommentId={activeCommentId}
          />
        ) : (
          <EditorPages
            pageCount={pageCount}
            currentPage={currentPage}
            onSelectPage={onSelectPage}
          />
        )}
      </div>
    </div>
  )
}

export default EditorSidebar
