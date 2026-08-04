import { useAppStore } from '../store/appStore'
import EditorOutline from './EditorOutline'

export interface EditorSidebarProps {
  // Forwarded straight through to EditorOutline -- this component has no
  // direct store access to document content, so whatever eventually mounts
  // EditorSidebar (EditorScreen or a future split-mode container) is
  // responsible for supplying the real document.
  content: string
  onSelectHeading: (sourceOffset: number) => void
  activeSourceOffset?: number
  // Real per-page thumbnails need the pagination engine -- a separate,
  // larger, deferred piece of work (see this component's Pages-tab render
  // below). Optional and un-guessed: nothing supplies a real page count to
  // this component yet, so omitting it renders an honest "not available"
  // note rather than a fabricated number.
  pageCount?: number
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
      className={[
        'flex-1 rounded-sm py-[5px] text-center text-12 font-semibold',
        isActive ? 'bg-page text-text-primary shadow-flat' : 'text-text-secondary'
      ].join(' ')}
    >
      {label}
    </button>
  )
}

function PagesPlaceholder({ pageCount }: { pageCount?: number }): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center gap-2 px-4 py-6 text-center">
      {typeof pageCount === 'number' && (
        <p className="text-12-5 font-semibold text-text-primary">
          {pageCount} {pageCount === 1 ? 'page' : 'pages'}
        </p>
      )}
      <p className="text-11 text-text-tertiary">
        {typeof pageCount === 'number'
          ? 'Page thumbnails are not built yet.'
          : 'Page count is not available yet, and page thumbnails are not built yet.'}
      </p>
    </div>
  )
}

// The shared left rail: a Pages/Outline pill switcher over either a real
// Outline (EditorOutline) or an honest Pages placeholder (real per-page
// thumbnails need the pagination engine -- deferred). Reads/writes
// useAppStore's existing sidebarTab/setSidebarTab directly; document content
// and heading-selection/active-section state are plain props, since this
// component has no store of its own for document content.
function EditorSidebar({
  content,
  onSelectHeading,
  activeSourceOffset,
  pageCount
}: EditorSidebarProps): React.JSX.Element {
  const sidebarTab = useAppStore((state) => state.sidebarTab)
  const setSidebarTab = useAppStore((state) => state.setSidebarTab)

  return (
    <div className="flex h-full w-[216px] shrink-0 flex-col gap-3.5 border-r border-border-subtle bg-chrome-light p-3.5">
      <div className="flex items-center gap-0.5 rounded-md bg-chrome-dark p-[3px]">
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
      </div>
      <div className="flex flex-1 flex-col overflow-hidden">
        {sidebarTab === 'outline' ? (
          <EditorOutline
            content={content}
            onSelectHeading={onSelectHeading}
            activeSourceOffset={activeSourceOffset}
          />
        ) : (
          <PagesPlaceholder pageCount={pageCount} />
        )}
      </div>
    </div>
  )
}

export default EditorSidebar
