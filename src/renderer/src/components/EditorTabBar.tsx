import { useDocumentStore } from '../store/documentStore'

// Mirrors HomeScreen.tsx's RecentRow basename convention (filePath.split on
// both path separators) -- a tab bar has far less horizontal room per item
// than EditorScreen's title bar (which shows the full path), so a tab shows
// just the filename, falling back to "Untitled" for an unsaved document.
function tabLabel(filePath: string | null): string {
  if (!filePath) return 'Untitled'
  return filePath.split(/[/\\]/).pop() ?? filePath
}

// Per docs/design-handoff/README.md, "Editor -- shared chrome", item 2 ("Tab
// bar") and the matching markup in docs/design-handoff/PageDown.dc.html
// (~line 207): 38px tall, #f6f6f7 (bg-chrome-light) bg, browser-style tabs --
// active tab is white (bg-page) with a border on 3 sides (border on all 4,
// bottom painted page-white so it visually merges with the white surface
// below) and 8px (rounded-t-md) top corners; inactive tabs are borderless
// with grey text. Each tab carries a fixed 6x6px accent-colored "kind" tag
// square (no real per-document color-tagging yet -- see task brief) and a
// close ("x") affordance. A "+" button at the end opens a new blank tab.
//
// Two colors in the HTML mock (inactive-tab text and the "+" icon, both
// #80858b) don't have an exact match in base.css's token set -- mapped to
// text-secondary (the closest existing "de-emphasized UI chrome text" token,
// already used for this same role elsewhere, e.g. EditorScreen's "<- Home"
// button) rather than hardcoding a new hex, per this project's
// tokens-exclusively styling convention. This is a deliberate, minor
// deviation from the mock's literal hex -- see GA_TRACK_1_REPORT.md.
interface EditorTabBarProps {
  // Called instead of the store's plain closeTab(tabId) ONLY when the tab
  // being closed is BOTH dirty AND the currently active one -- the one case
  // that needs a live MilkdownEditor flush() (to pick up an edit still
  // sitting inside the ~200ms onChange debounce) and Save capability this
  // component doesn't own (EditorScreen does, via editorRef/save() -- same
  // machinery its own handleGoHome already uses for the "<- Home" button,
  // see that function's doc comments for the full reasoning this mirrors).
  //
  // Every OTHER close -- a clean tab, or a dirty BACKGROUND tab -- still
  // goes straight to the store's closeTab, unchanged from before this prop
  // existed. A dirty background tab's close-confirmation is a real, still-
  // deferred gap, not silently dropped by this change: documentStore.ts's
  // own closeTab doc comment already discloses it, and closing it properly
  // would need a tab-scoped save (documentStore.save() only ever operates
  // on the ACTIVE tab's mirror fields today) -- out of scope for this pass,
  // which targets the far more common "closing the tab you're currently
  // looking at" case.
  //
  // Optional so every existing test rendering <EditorTabBar /> standalone
  // (none of which puts a dirty tab in play) keeps working unchanged.
  onCloseDirtyActiveTab?: (tabId: string) => void
}

function EditorTabBar({ onCloseDirtyActiveTab }: EditorTabBarProps): React.JSX.Element {
  const tabs = useDocumentStore((state) => state.tabs)
  const activeTabId = useDocumentStore((state) => state.activeTabId)
  const switchTab = useDocumentStore((state) => state.switchTab)
  const closeTab = useDocumentStore((state) => state.closeTab)
  const openTab = useDocumentStore((state) => state.openTab)

  const handleClose = (tabId: string, isDirty: boolean): void => {
    if (isDirty && tabId === activeTabId && onCloseDirtyActiveTab) {
      onCloseDirtyActiveTab(tabId)
      return
    }
    closeTab(tabId)
  }

  const handleTabKeyDown = (event: React.KeyboardEvent, tabId: string): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      switchTab(tabId)
    }
  }

  return (
    <div
      role="tablist"
      aria-label="Open documents"
      className="flex h-[38px] flex-none items-end gap-0.5 border-b border-border-chrome bg-chrome-light px-2.5"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId
        const label = tabLabel(tab.filePath)
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            aria-label={label}
            tabIndex={isActive ? 0 : -1}
            onClick={() => switchTab(tab.id)}
            onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
            className={
              isActive
                ? 'group flex cursor-default items-center gap-2 rounded-t-md border border-border-chrome border-b-page bg-page pb-[9px] pl-3.5 pr-2.5 pt-2 text-12-5 text-text-primary'
                : 'group flex cursor-pointer items-center gap-2 pb-[9px] pl-3.5 pr-2.5 pt-2 text-12-5 text-text-secondary'
            }
          >
            <span aria-hidden="true" className="h-1.5 w-1.5 flex-none rounded-[1px] bg-accent" />
            <span className="max-w-[160px] truncate">{label}</span>
            <button
              type="button"
              aria-label={`Close ${label}`}
              onClick={(event) => {
                event.stopPropagation()
                handleClose(tab.id, tab.isDirty)
              }}
              className={`text-13 leading-none text-text-tertiary ${
                isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
            >
              &times;
            </button>
          </div>
        )
      })}
      <button
        type="button"
        aria-label="New tab"
        onClick={() => openTab(null, '')}
        className="ml-1 mt-[5px] flex h-6 w-6 flex-none items-center justify-center rounded-sm text-text-secondary"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 8.2v7.6M8.2 12h7.6" />
        </svg>
      </button>
    </div>
  )
}

export default EditorTabBar
