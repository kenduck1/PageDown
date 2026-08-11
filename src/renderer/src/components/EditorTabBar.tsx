import { useRef, useState } from 'react'
import { useDocumentStore } from '../store/documentStore'
// Moved out to lib/ when the window-close guard needed the identical label for
// its "save the changes you made to <name>?" dialog -- see that module.
import { tabLabel } from '../lib/tab-label'
import { computeReorderIndex, isDropAfter } from '../lib/tab-reorder'

// The ONLY dataTransfer type a tab drag carries, and deliberately a private
// one -- no `text/plain`, no `text/uri-list`.
//
// That is not tidiness, it is what stops a tab dropped on the document from
// typing itself into it. MilkdownEditor mounts a real ProseMirror drop handler
// (drop-image.ts) that ignores a drag with no image File in it, at which point
// ProseMirror's OWN default drop handling takes over -- and that reads
// text/html then text/plain off the dataTransfer and inserts whatever it
// finds. A drag advertising only a type nothing else recognises is inert
// everywhere outside this component, and is also what lets the handlers below
// tell a tab drag apart from a real file being dragged in from the OS.
const TAB_DRAG_TYPE = 'application/x-pagedown-tab'

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
  // Only needed so ArrowLeft/Right/Home/End below can move real DOM focus to
  // the target tab's own div -- see handleTabKeyDown's comment for why a
  // querySelectorAll off this ref, rather than a per-tab ref array, is
  // enough (DOM order here already matches `tabs` order by construction,
  // same one-query-not-N-refs convention useModalDialog.ts's focus trap
  // uses for its own focusable-descendant list).
  const tabListRef = useRef<HTMLDivElement>(null)
  const reorderTab = useDocumentStore((state) => state.reorderTab)
  // Which tab is being dragged, and where a drop would currently land. Both
  // are PURELY presentational (a dimmed source tab, an insertion line) --
  // nothing about the reorder itself reads them, so a state update that
  // arrives late can only ever mis-paint a hint for a frame, never mis-move a
  // tab. The authoritative dragged-tab id travels in the dataTransfer, which
  // is what the drop handler actually reads.
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<{ index: number; after: boolean } | null>(null)

  const handleClose = (tabId: string): void => {
    if (onRequestCloseTab) {
      onRequestCloseTab(tabId)
      return
    }
    closeTab(tabId)
  }

  // Moves real DOM focus onto the tab that ends up at `index` AFTER a reorder
  // has been applied. Deliberately separate from -- not a replacement for --
  // the synchronous querySelectorAll the plain arrow navigation below does:
  // that one never changes the order, so the element at the target index is
  // already the right one and focusing it synchronously is correct.
  //
  // A reorder is the opposite: `tabs` has moved, so the element sitting at
  // `index` right now is still the PRE-move occupant, and focusing it
  // synchronously would land on whatever the dragged tab swapped with.
  // Deferring to a microtask fixes that by ordering, not by luck -- calling
  // reorderTab() has already made Zustand notify React synchronously, so
  // React's own sync-lane flush microtask is queued BEFORE this one, and
  // microtasks run FIFO.
  //
  // Same fresh-query-not-a-ref-array reasoning as handleTabKeyDown's own
  // comment below, and for the extra reason that a ref array would itself
  // still be in pre-reorder order at this instant.
  const focusTabAt = (index: number): void => {
    queueMicrotask(() => {
      const tabEls = tabListRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')
      tabEls?.[index]?.focus()
    })
  }

  // ---------------------------------------------------------------------
  // Drag to reorder
  // ---------------------------------------------------------------------
  //
  // Native HTML5 drag and drop, not a pointer-event drag implementation:
  // `tabs` is a short, single-row, same-window list, which is precisely the
  // case native DnD handles well, and it comes with the OS drag image, the
  // Escape-cancels-the-drag contract and the correct cursor for free. A
  // pointermove-based reimplementation would have to recreate all three.
  //
  // Reordering deliberately does NOT switch to the dragged tab. A drag never
  // fires `click`, so this is not something we have to suppress -- it is
  // simply what the gesture means: rearranging the shelf is not the same
  // action as picking a book off it, and stealing the active document
  // mid-drag would swap the canvas out from under the user.
  const handleDragStart = (event: React.DragEvent, tabId: string): void => {
    event.dataTransfer.setData(TAB_DRAG_TYPE, tabId)
    event.dataTransfer.effectAllowed = 'move'
    setDraggingTabId(tabId)
  }

  const handleDragOver = (event: React.DragEvent, index: number): void => {
    // A drag carrying anything else -- most plausibly a real image file being
    // dragged in from the OS, which this app genuinely handles elsewhere
    // (drop-image.ts) -- must fall through untouched rather than be silently
    // eaten by the tab bar. Not calling preventDefault() is what refuses the
    // drop, per the HTML drag-and-drop model.
    if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    setDropHint({ index, after: isDropAfter(event.clientX, rect.left, rect.width) })
  }

  const handleDrop = (event: React.DragEvent, overIndex: number): void => {
    if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return
    event.preventDefault()
    // Read from the dataTransfer rather than from `draggingTabId`: this is the
    // one value the whole operation turns on, and the dataTransfer is the
    // drag's own authoritative carrier of it. (getData is readable in `drop`;
    // it deliberately is not in `dragover`, which is why the hint above works
    // off the type list alone.)
    const tabId = event.dataTransfer.getData(TAB_DRAG_TYPE)
    setDraggingTabId(null)
    setDropHint(null)
    if (!tabId) return
    const fromIndex = tabs.findIndex((tab) => tab.id === tabId)
    if (fromIndex === -1) return
    const rect = event.currentTarget.getBoundingClientRect()
    const after = isDropAfter(event.clientX, rect.left, rect.width)
    reorderTab(tabId, computeReorderIndex(fromIndex, overIndex, after))
  }

  // Fires whether the drag ended in a drop, outside the bar, or via Escape --
  // so this, not handleDrop alone, is what guarantees the visual state cannot
  // get stuck mid-drag.
  const handleDragEnd = (): void => {
    setDraggingTabId(null)
    setDropHint(null)
  }

  // Completes the roving-tabindex pattern this component only half-had:
  // tabIndex={isActive ? 0 : -1} below already SET UP roving tabindex (only
  // the active tab is in the normal Tab sequence), but nothing ever moved
  // that roving state -- Enter/Space activated whatever tab already HAD
  // focus, and nothing could give an inactive tab focus in the first place.
  // A keyboard user could therefore reach exactly one tab (the active one)
  // no matter how many were open. Fixed the standard way (WAI-ARIA APG
  // "tabs" pattern): arrow keys move focus AND switch the active tab
  // together (automatic activation) -- not "move focus only, activate
  // later on Enter" -- because this component's OWN existing model already
  // ties tabIndex directly to isActive (there is no separate "focused but
  // not yet selected" concept anywhere else in this file or in
  // documentStore), so decoupling focus from activation here would leave
  // the moved-to tab still showing tabIndex=-1 until a second, separate
  // activation step. Matches what a mouse click on a tab already does
  // (switches immediately) and keeps click/Enter/Space/arrows all
  // triggering the exact same switchTab call.
  const handleTabKeyDown = (event: React.KeyboardEvent, tabId: string): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      switchTab(tabId)
      return
    }

    const currentIndex = tabs.findIndex((tab) => tab.id === tabId)
    if (currentIndex === -1) return

    // KEYBOARD REORDERING, and yes it should exist: a drag-only reorder is
    // unreachable for anyone who cannot operate a pointer, and this bar
    // already has a complete keyboard model (roving tabindex + arrows) for the
    // modifier to build on -- "arrows move focus, arrows + Cmd/Ctrl+Shift move
    // the tab" is the most learnable mapping available, because the unmodified
    // gesture is already right there.
    //
    // Cmd/Ctrl+Shift+Arrow specifically: checked against
    // src/main/app-menu-template.ts's full accelerator list (read, not
    // assumed) -- nothing there binds an arrow key at all, so this cannot be
    // shadowed by a menu accelerator, which would win unconditionally if it
    // existed. It also only ever fires with a TAB focused (this is the tab's
    // own onKeyDown), so it cannot collide with the same chord's
    // extend-selection meaning inside a text field.
    //
    // Clamped rather than wrapped, unlike the plain-arrow navigation below.
    // Wrapping focus past the end is a convenience; wrapping a MOVE past the
    // end would teleport a tab from one end of the bar to the other on a
    // keystroke whose whole point is a one-step nudge.
    if ((event.metaKey || event.ctrlKey) && event.shiftKey) {
      const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      if (delta === 0) return
      event.preventDefault()
      const destination = Math.min(Math.max(currentIndex + delta, 0), tabs.length - 1)
      if (destination === currentIndex) return
      reorderTab(tabId, destination)
      // Focus follows the tab, not the position -- a user nudging a tab along
      // must be able to press the chord again without re-finding it.
      focusTabAt(destination)
      return
    }

    let targetIndex: number
    switch (event.key) {
      case 'ArrowRight':
        // Wraps in both directions via a positive-remainder modulo -- same
        // technique slash-plugin.ts's own ArrowDown/ArrowUp handler uses for
        // its item list, for the identical reason (ArrowRight past the last
        // tab should land back on the first, not do nothing).
        targetIndex = (currentIndex + 1) % tabs.length
        break
      case 'ArrowLeft':
        targetIndex = (currentIndex - 1 + tabs.length) % tabs.length
        break
      case 'Home':
        targetIndex = 0
        break
      case 'End':
        targetIndex = tabs.length - 1
        break
      default:
        return
    }

    event.preventDefault()
    const targetTab = tabs[targetIndex]
    switchTab(targetTab.id)
    // Query fresh rather than cache a per-tab ref array: every tab's div is
    // ALREADY in the DOM regardless of isActive (only tabIndex/styling
    // differ), so the target node exists and is focusable right now, before
    // the switchTab-triggered re-render even happens -- .focus() works on a
    // tabIndex=-1 element exactly as well as a tabIndex=0 one, it just isn't
    // reachable by sequential Tab. querySelectorAll's return order matches
    // `tabs` order because both come from the same single `tabs.map(...)`
    // call below.
    const tabEls = tabListRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')
    tabEls?.[targetIndex]?.focus()
  }

  return (
    <div
      ref={tabListRef}
      role="tablist"
      aria-label="Open documents"
      className="flex h-[38px] flex-none items-end gap-0.5 border-b border-border-chrome bg-chrome-light px-2.5"
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTabId
        const label = tabLabel(tab.filePath)
        // The insertion line. An INSET box-shadow rather than a real border or
        // a spacer element on purpose: it paints inside the tab's existing
        // box, so showing it cannot change any tab's width or position -- and
        // a drop indicator that reflows the very bar you are aiming at would
        // move the target out from under the pointer.
        const dropEdge =
          dropHint && dropHint.index === index
            ? dropHint.after
              ? 'shadow-[inset_-2px_0_0_0_var(--color-accent)]'
              : 'shadow-[inset_2px_0_0_0_var(--color-accent)]'
            : ''
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            aria-label={label}
            tabIndex={isActive ? 0 : -1}
            draggable
            onDragStart={(event) => handleDragStart(event, tab.id)}
            onDragOver={(event) => handleDragOver(event, index)}
            onDrop={(event) => handleDrop(event, index)}
            onDragEnd={handleDragEnd}
            onClick={() => switchTab(tab.id)}
            onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
            className={[
              isActive
                ? 'group flex cursor-default items-center gap-2 rounded-t-md border border-border-chrome border-b-page bg-page pb-[9px] pl-3.5 pr-2.5 pt-2 text-12-5 text-text-primary'
                : 'group flex cursor-pointer items-center gap-2 pb-[9px] pl-3.5 pr-2.5 pt-2 text-12-5 text-text-secondary',
              // The tab being dragged stays in place and dims, rather than
              // being removed from the row: pulling it out would reflow every
              // other tab the instant the drag started, so the row the user is
              // aiming into would no longer be the row they grabbed from.
              tab.id === draggingTabId ? 'opacity-40' : '',
              dropEdge
            ]
              .filter(Boolean)
              .join(' ')}
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
              // focus:opacity-100 is the actual fix, not a style nicety: this
              // button has no explicit tabIndex, so (unlike its parent tab
              // div, which IS part of the roving-tabindex scheme above) it
              // sits in the NORMAL Tab sequence on every tab, active or not.
              // Without this, a keyboard user tabbing through could already
              // land here on a background tab's close button while it was
              // still opacity-0 -- landing on, and able to activate, a
              // control they could not see and had no other way to find.
              className={`text-13 leading-none text-text-tertiary ${
                isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
              }`}
            >
              &times;
            </button>
          </div>
        )
      })}
      {/* `mb-[7px]`, NOT the `mt-[5px]` this used to carry. The old margin was
          on the wrong side for the alignment this row actually uses, and was
          therefore doing nothing at all: the tablist is `items-end`, which
          aligns each item by the BOTTOM of its margin box, so a top margin
          only extends the box upward and cannot move the button. The button
          simply sat flush with the bottom of a 38px row while the tabs' own
          labels sit `pb-[9px]` up from it -- so a 24px button bottom-aligned
          against ~38px tabs landed visibly low.

          The 7px is measured in the real built app, not guessed: before this
          fix the first tab's label centred on y=57.63 and the button on y=65,
          a 7.37px drop. Raising the button's bottom edge by 7px puts its
          centre at 58.0 -- 0.37px from the label's, and 0.13px from the tab
          box's own centre (58.13), i.e. inside half a pixel of both. */}
      <button
        type="button"
        aria-label="New tab"
        onClick={() => openTab(null, '')}
        className="mb-[7px] ml-1 flex h-6 w-6 flex-none items-center justify-center rounded-sm text-text-secondary"
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
