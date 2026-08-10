// What each window's renderer reports about itself, over
// WINDOW_STATE_CHANNEL, so the main process can do the two things only it
// can do: enable/disable the right application-menu items, and set the real
// OS window title (plus macOS's own "document edited" close-button dot).
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
}

export const DEFAULT_WINDOW_UI_STATE: WindowUiState = {
  documentOpen: false,
  viewMode: 'format',
  fileName: null,
  isDirty: false
}

const VIEW_MODES: readonly string[] = ['format', 'split', 'source']

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
    isDirty: typeof raw.isDirty === 'boolean' ? raw.isDirty : DEFAULT_WINDOW_UI_STATE.isDirty
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
