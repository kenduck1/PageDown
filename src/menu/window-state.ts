// What each window's renderer reports about itself, over
// WINDOW_STATE_CHANNEL, so the main process can do the three things only it
// can do: enable/disable the right application-menu items, set the real OS
// window title (plus macOS's own "document edited" close-button dot), and
// route an OS-delivered file-open request (a Finder double-click, "Open
// With", a Windows/Linux file-association relaunch) to the window that is
// ALREADY showing that document instead of opening a redundant second one.
//
// Same placement reasoning as commands.ts -- see that file's own header.
// Also dependency-free for the same reason.

// Structurally identical to appStore.ts's own exported `ViewMode`, and
// deliberately NOT imported from there: this module is bundled into the MAIN
// process, which must not pull a Zustand store (and everything a renderer
// module transitively imports) in with it. Same deliberate-duplication
// precedent, and the same keep-in-sync obligation, as
// src/preload/index.d.ts's own RecentFileEntry/Preferences/PageNavState
// copies. The two unions are compared structurally at every call site that
// passes an appStore ViewMode into a WindowUiState, so a divergence is a
// compile error in the renderer rather than a silent runtime mismatch.
export type WindowViewMode = 'format' | 'split' | 'source'

export interface WindowUiState {
  // `screen === 'editor'`, i.e. there is a document on screen to act on.
  // Drives menu-item enablement for everything under File that operates on
  // the current document (Save/Save As/Export/Print) and everything under
  // View (mode switching, zoom, sidebar) -- all of which are inert on the
  // Home and Settings screens.
  documentOpen: boolean
  // Drives the View menu's Format/Split/Source radio checkmarks.
  viewMode: WindowViewMode
  // The document's BASENAME, not its full path -- the window title shows a
  // filename, and computing the basename in the renderer (which already
  // splits paths for the tab bar and the Home screen's recent rows) keeps the
  // main process from having to care whether the path is POSIX or Windows.
  // `null` for a document with no path yet (a never-saved "Untitled").
  fileName: string | null
  isDirty: boolean
  // Every non-null document path currently open in THIS window's tabs -- full
  // paths, unlike `fileName` above, because the main process compares them
  // against an OS-supplied path rather than displaying them.
  //
  // WHY THE RENDERER REPORTS THIS AT ALL, rather than the main process
  // keeping its own registry: main sees a path only when it is asked to do
  // something with it (file:openPath, file:open's dialog result, file:save's
  // Save-As target). It never sees a tab CLOSE, and it cannot tell an open
  // tab from a closed one, so a main-side registry could only ever be
  // "documents this window has ever touched" -- a superset. Focusing a window
  // on that basis lands the user on a window that no longer shows the file
  // and then does nothing at all, which is worse than opening a second
  // window. The renderer's own documentStore is the only place that knows
  // what is open right now.
  //
  // Paths are compared as raw strings (no fs.realpath canonicalization),
  // matching documentStore's own same-window tab dedup -- see that action's
  // PATH-COMPARISON note for the full reasoning. Both sides of the comparison
  // here are OS-supplied absolute paths for a real file the user just
  // double-clicked, so a spelling divergence needs a symlinked route into the
  // same file, not ordinary use.
  openFilePaths: string[]
}

export const DEFAULT_WINDOW_UI_STATE: WindowUiState = {
  documentOpen: false,
  viewMode: 'format',
  fileName: null,
  isDirty: false,
  openFilePaths: []
}

const VIEW_MODES: readonly string[] = ['format', 'split', 'source']

// A window with more open documents than this reports only the first
// MAX_REPORTED_OPEN_PATHS -- a bound on what an (in principle compromised)
// renderer can make the main process retain per window, not a real product
// limit: the tab bar becomes unusable long before 64 tabs, and the only cost
// of truncation is that a 65th document falls back to opening its own window.
const MAX_REPORTED_OPEN_PATHS = 64

// Validates whatever actually arrives over IPC rather than trusting the
// declared type. The renderer is the only sender today, but an IPC payload is
// still untyped data crossing a process boundary -- and this value reaches
// `win.setTitle()`, so a non-string `fileName` would surface as a literal
// "[object Object]" in the OS title bar rather than a caught error. Degrades
// per-field to the default (matching preferences.ts's own sanitizePreferences
// discipline) instead of rejecting the whole message for one bad field.
export function coerceWindowUiState(value: unknown): WindowUiState {
  if (typeof value !== 'object' || value === null) return DEFAULT_WINDOW_UI_STATE
  const raw = value as Partial<Record<keyof WindowUiState, unknown>>
  return {
    documentOpen:
      typeof raw.documentOpen === 'boolean'
        ? raw.documentOpen
        : DEFAULT_WINDOW_UI_STATE.documentOpen,
    viewMode:
      typeof raw.viewMode === 'string' && VIEW_MODES.includes(raw.viewMode)
        ? (raw.viewMode as WindowViewMode)
        : DEFAULT_WINDOW_UI_STATE.viewMode,
    fileName: typeof raw.fileName === 'string' ? raw.fileName : DEFAULT_WINDOW_UI_STATE.fileName,
    isDirty: typeof raw.isDirty === 'boolean' ? raw.isDirty : DEFAULT_WINDOW_UI_STATE.isDirty,
    // Per-ELEMENT filtering, not a whole-array reject: one malformed entry
    // must not discard the rest, same discipline as the per-field degradation
    // above. An empty array is the correct degradation for a non-array
    // payload -- it means "this window is showing nothing I can route to",
    // which falls back to opening a new window rather than focusing a wrong
    // one.
    openFilePaths: Array.isArray(raw.openFilePaths)
      ? raw.openFilePaths
          .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
          .slice(0, MAX_REPORTED_OPEN_PATHS)
      : // A fresh array, not DEFAULT_WINDOW_UI_STATE's own -- that constant is
        // exported and handed out as a whole state elsewhere, and sharing one
        // mutable array across every coerced message is a trap waiting for the
        // first caller that sorts or pushes in place.
        []
  }
}

// True when a change between two reported states can actually change what the
// application menu looks like. The renderer reports on every dirty flip and
// every filename change too (both drive the window TITLE), and rebuilding the
// whole menu for those would be pure waste -- `isDirty` in particular flips on
// the first keystroke after every save.
export function menuRelevantStateChanged(
  previous: WindowUiState | undefined,
  next: WindowUiState
): boolean {
  if (!previous) return true
  return previous.documentOpen !== next.documentOpen || previous.viewMode !== next.viewMode
}
