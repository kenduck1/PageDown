import { useEffect, type RefObject } from 'react'
import { useFindStore } from '../store/findStore'

// This app's FIRST AND ONLY keyboard shortcut. There is no Electron
// application Menu (see CLAUDE.md's known-gaps notes elsewhere for the
// broader "no real app menu yet" state), and the only other `keydown`
// listener anywhere in the renderer is EditorTabBar's own per-tab Enter/Space
// a11y handler -- so a bare `window` listener, rather than a real menu
// accelerator, is genuinely the only mechanism available right now. The
// stated cost of that choice: this shortcut does not show up in any menu (no
// menu exists to show it in), and there is no discoverability path beyond the
// toolbar's own Find button. Building a real app Menu -- which would need
// main-process menu construction plus an IPC channel to deliver the resulting
// command into the renderer -- is a separate, deliberately deferred
// sub-project, not something folded into this one.
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

export function useFindShortcuts(params: FindShortcutsParams): void {
  const { getSelectedText, queryInputRef } = params

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      // Read the store via getState() inside the handler, not from a render
      // closure -- this matches the getState() convention EditorScreen.tsx
      // already establishes for exactly this risk class (see e.g.
      // handleSetViewMode's own comment on the same choice): the listener is
      // registered once, on mount, and getState() is what lets it act on
      // whatever the store's CURRENT state is at keypress time without ever
      // needing to be re-registered when that state changes.
      const { openFind, openFindAndReplace, closeFind, setQuery, isOpen } = useFindStore.getState()

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        if (event.altKey) {
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
