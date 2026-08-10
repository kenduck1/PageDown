import type { WindowUiState } from '../menu/window-state'

// The product name as users should ever see it, hardcoded rather than read
// from `app.getName()`. That call returns package.json's `name` field --
// "pagedown", lowercase -- in development, and only resolves to
// electron-builder.yml's `productName` ("PageDown") once the app is actually
// packaged. A user-facing window title (and the macOS app-menu label built
// from the same constant) reading "pagedown" during development and
// "PageDown" in production is an avoidable inconsistency, and this string is
// short enough that one shared constant beats reconciling two sources.
export const APP_NAME = 'PageDown'

// The "this document has unsaved changes" marker. A leading bullet is used on
// EVERY platform, including macOS where `BrowserWindow.setDocumentEdited(true)`
// separately paints the real dot inside the close button: the two are
// complementary rather than redundant -- the close-button dot is invisible
// when the window is not focused or when the user is looking at a window
// list/Mission Control, both of which show the TITLE. VS Code, Sublime and
// TextMate all mark the title too.
const DIRTY_MARKER = '• '

// Deliberately an em dash surrounded by spaces, matching this app's own
// existing chrome (the design handoff's own separators) rather than the
// hyphen many Electron templates default to.
const TITLE_SEPARATOR = ' — '

// A never-saved document has no filename to show. "Untitled" matches what
// EditorScreen's own path label and documentStore's blank-tab handling
// already call it, so the title and the in-app chrome agree.
const UNTITLED_NAME = 'Untitled'

// Pure, and deliberately separated from the `win.setTitle()` call that
// consumes it (src/main/app-menu.ts) so the formatting itself is directly
// unit-testable without an Electron window -- the same split, for the same
// reason, as isKnownPath living in the Electron-free recent-files.ts rather
// than in file-io.ts.
export function formatWindowTitle(state: WindowUiState): string {
  // No document on screen (Home or Settings): the app's own name alone. A
  // "• Untitled — PageDown" title while the user is looking at the Home
  // screen would be actively wrong -- the blank tab documentStore always
  // keeps alive is not a document the user has opened.
  if (!state.documentOpen) return APP_NAME
  const name = state.fileName ?? UNTITLED_NAME
  return `${state.isDirty ? DIRTY_MARKER : ''}${name}${TITLE_SEPARATOR}${APP_NAME}`
}
