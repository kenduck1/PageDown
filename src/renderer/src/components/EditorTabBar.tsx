import { useDocumentStore } from '../store/documentStore'
// Moved out to lib/ when the window-close guard needed the identical label for
// its "save the changes you made to <name>?" dialog -- see that module.
import { tabLabel } from '../lib/tab-label'

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
  // Called INSTEAD of the store's plain closeTab(tabId) for EVERY close, not
  // just a dirty one, whenever the parent provides it (EditorScreen does).
  //
  // It used to be `onCloseDirtyActiveTab` and fire only when the tab was BOTH
  // dirty AND active, with every other close -- including a dirty BACKGROUND
  // tab's -- going straight to closeTab. That discarded a dirty background tab
  // silently and irrecoverably: useAutosave only ever sees the ACTIVE tab, so
  // a background tab has no autosave snapshot either.
  //
  // The widening from "dirty closes" to ALL closes is not incidental. This
  // component cannot answer "is this tab dirty?" reliably on its own:
  // @milkdown/plugin-listener's onChange is 200ms-debounced, so a tab edited
  // moments ago still reads isDirty: false here. Only the parent can flush the
  // live editor first and THEN decide -- so the decision has to move there
  // wholesale rather than being split across the two.
  //
  // Optional so every existing test rendering <EditorTabBar /> standalone
  // keeps working: with no handler, closes fall back to the store directly.
  onRequestCloseTab?: (tabId: string) => void
}

function EditorTabBar({ onRequestCloseTab }: EditorTabBarProps): React.JSX.Element {
  const tabs = useDocumentStore((state) => state.tabs)
  const activeTabId = useDocumentStore((state) => state.activeTabId)
  const switchTab = useDocumentStore((state) => state.switchTab)
  const closeTab = useDocumentStore((state) => state.closeTab)
  const openTab = useDocumentStore((state) => state.openTab)

  const handleClose = (tabId: string): void => {
    if (onRequestCloseTab) {
      onRequestCloseTab(tabId)
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
            {/* The unsaved-changes marker. This square was previously rendered
                UNCONDITIONALLY (a decorative "kind tag" from the design
                handoff, with no per-document colour behind it), so it conveyed
                nothing at all -- isDirty reached the UI in exactly one place,
                the status bar, for the active tab only. A user with five tabs
                open therefore had no way to see which held unsaved work, which
                is precisely the information needed to answer the close/quit
                prompts this same change adds.

                Kept in the layout when clean (`invisible`, not removed) so
                saving a document doesn't shift every tab's text sideways.
                `invisible` also removes it from the accessibility tree, which
                is what makes the role/aria-label below unambiguous: the marker
                has an accessible name exactly when it means something.

                NOT conveyed by colour alone: it is a presence/absence marker
                with a real accessible name and a `title` tooltip. The name is
                on the marker rather than folded into the tab's own aria-label
                deliberately -- the tab's label is what `getByRole('tab', {name})`
                and the close button's own "Close <label>" derive from. */}
            <span
              {...(tab.isDirty
                ? { role: 'img', 'aria-label': 'Unsaved changes', title: 'Unsaved changes' }
                : { 'aria-hidden': true })}
              className={`h-1.5 w-1.5 flex-none rounded-full bg-accent ${
                tab.isDirty ? '' : 'invisible'
              }`}
            />
            <span className="max-w-[160px] truncate">{label}</span>
            <button
              type="button"
              aria-label={`Close ${label}`}
              onClick={(event) => {
                event.stopPropagation()
                handleClose(tab.id)
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
