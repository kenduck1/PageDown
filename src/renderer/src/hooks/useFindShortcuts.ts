import { useEffect, type RefObject } from 'react'
import { useFindStore } from '../store/findStore'

// This app's FIRST bare-`window`-level keyboard shortcut (a second,
// ShortcutsHelpModal's Mod-/, followed the same pattern later -- see
// EditorScreen.tsx's own shortcuts-help keydown effect). The reason it was a
// bare `window` listener rather than a menu accelerator was that this app had
// no application Menu of its own at all.
//
// THAT IS NO LONGER TRUE: Edit > Find… now carries the real `CmdOrCtrl+F`
// accelerator (src/main/app-menu-template.ts). Which of the two paths
// actually fires for a given keypress was NOT measured -- Electron documents
// a menu accelerator as being handled by the menu, but this was deliberately
// not made to matter, and that is the point of the refactor below rather
// than a gap in it:
//
//   - if the accelerator wins, EditorScreen's `edit:find` menu-command
//     handler runs the flow and this listener never sees the keydown;
//   - if the keydown still reaches the page, this listener runs the SAME
//     function;
//   - if somehow both fire, running it twice is idempotent (openFind on an
//     already-open bar, and re-seeding the same query).
//
// So the listener is kept, deliberately: it is the only path that works if
// the application menu is ever absent (Electron allows
// setApplicationMenu(null), and no menu exists until app-ready), and it is
// what this hook's own jsdom tests exercise, since a native menu cannot
// exist there. What must NOT drift is the FLOW itself -- which is why the
// body below is factored into `openFindFromShortcut` and called from BOTH
// here and the menu-command handler, rather than the menu handler doing a
// bare `openFind()` and silently losing the seed-from-selection and focus
// behaviour. phase0/gate17 passing after this change confirms the flow still
// works end to end; it deliberately does not discriminate which path ran,
// because by construction nothing observable depends on that.
//
// A ProseMirror `keymap` (Milkdown's own binding mechanism, used for e.g.
// undo/redo -- see editor-commands.ts) was considered and rejected: a keymap
// only fires while the ProseMirror EditorView itself has DOM focus. Cmd+F
// needs to work no matter where focus currently is -- inside the Source-mode
// textarea (a completely different element with no ProseMirror keymap at
// all), or in the toolbar/sidebar chrome -- so a keymap would silently do
// nothing for exactly the cases this shortcut most needs to cover.
export interface FindShortcutsParams {
  getSelectedText: () => string
  queryInputRef: RefObject<HTMLInputElement | null>
}

// The complete "the user asked for Find" flow, shared by the keydown listener
// below and by EditorScreen's `edit:find` application-menu command handler.
// Exported (rather than inlined in the hook) precisely so the menu path
// cannot degrade into a bare `openFind()` that silently drops the
// seed-from-selection and focus-the-input behaviour users would immediately
// notice missing.
export function openFindFromShortcut(params: FindShortcutsParams, withReplace: boolean): void {
  const { getSelectedText, queryInputRef } = params
  // Read the store via getState(), not from a render closure -- this matches
  // the getState() convention EditorScreen.tsx already establishes for
  // exactly this risk class (see e.g. handleSetViewMode's own comment on the
  // same choice): the listener is registered once, on mount, and getState()
  // is what lets it act on whatever the store's CURRENT state is at keypress
  // time without ever needing to be re-registered when that state changes.
  const { openFind, openFindAndReplace, setQuery } = useFindStore.getState()

  if (withReplace) {
    openFindAndReplace()
  } else {
    openFind()
  }

  // Seed the query from whatever's currently selected, the way every
  // other editor's Cmd+F does -- but never overwrite an existing query
  // with an empty selection (e.g. re-pressing Cmd+F with the cursor
  // sitting in blank space shouldn't erase what was already typed), and
  // never seed a multi-line selection: in most editors a multi-line
  // selection means "search inside this region," not "search for this
  // literal (probably multi-paragraph) text" -- seeding it here would
  // produce a query that matches nothing, which is worse than leaving
  // the existing query alone.
  const selected = getSelectedText()
  if (selected !== '' && !selected.includes('\n')) {
    setQuery(selected)
  }

  // Try synchronously first, and only defer if that's not possible yet.
  // When the bar was ALREADY open (re-pressing Cmd+F to reselect the
  // query text), queryInputRef.current is already attached and this
  // resolves immediately, with no visible delay. When the bar was
  // CLOSED, the store update just above (openFind/openFindAndReplace)
  // is what mounts FindBar's query input in the first place -- and
  // that mount is not synchronous with the store update that triggers
  // it (confirmed empirically against a real Zustand+React harness,
  // not assumed: a plain `window` keydown listener calling a store's
  // setState does NOT get a same-tick DOM update, even though
  // `useSyncExternalStore`'s own subscription notifies synchronously --
  // React still defers the resulting re-render/commit). So on that
  // tick queryInputRef.current is still null; falling back to
  // requestAnimationFrame gives React's next commit a chance to attach
  // the ref before trying again.
  if (queryInputRef.current) {
    queryInputRef.current.focus()
    queryInputRef.current.select()
  } else {
    requestAnimationFrame(() => {
      queryInputRef.current?.focus()
      queryInputRef.current?.select()
    })
  }
}

export function useFindShortcuts(params: FindShortcutsParams): void {
  const { getSelectedText, queryInputRef } = params

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const { closeFind, isOpen } = useFindStore.getState()

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        openFindFromShortcut({ getSelectedText, queryInputRef }, event.altKey)
        return
      }

      if (event.key === 'Escape' && isOpen) {
        closeFind()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [getSelectedText, queryInputRef])
}
