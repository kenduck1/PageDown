import { app, BrowserWindow } from 'electron'

// "Which window is the user actually working in" -- ONE answer, shared by
// every part of the main process that has to act on a window it was not
// explicitly told about: the application menu (which describes the active
// window), menu-command routing, `second-instance` (raising the app when a
// second launch is attempted), and where a brand-new window should open.
//
// `BrowserWindow.getFocusedWindow()` alone is NOT that answer, and the gap is
// measured rather than theoretical. It returns null whenever no window holds
// OS focus -- the app is backgrounded (macOS: the user clicks another app), a
// native menu or dialog holds focus, or the app was launched without ever
// being brought to the front -- even though a perfectly good window is sitting
// right there. Three real bugs came from reading that null as "there is no
// window":
//
//   - app-menu.ts repainted the ENTIRE menu into DEFAULT_WINDOW_UI_STATE --
//     every document-scoped item greyed out, File > Save included -- because
//     its own `focused === null` branch fell through to the neutral default.
//     This one is not a maybe: tests/gates/gate30-app-menu.spec.ts was FAILING on
//     exactly that assertion before this file existed, in an environment where
//     the app window never receives OS focus, and the failure reproduces
//     identically on an unmodified checkout of the previous commit.
//   - `second-instance` raised `[...documentWindows][0]`, i.e. INSERTION
//     order, so a Windows/Linux file-association relaunch raised window 1 even
//     when the user had spent the last hour in window 2.
//   - a new window ignored the size of the window it was opened from, snapping
//     back to the built-in default.
//
// THREE FALLBACK LAYERS, each covering a case the one before it cannot:
//
//   1. The genuinely focused window. Right whenever the app is frontmost.
//   2. The last window that HELD focus, while it is still alive. This is the
//      backgrounded-app case: the user will come back to that window, so it is
//      what the menu should describe in the meantime.
//   3. The most recently created live window. This covers what layer 2
//      structurally cannot -- an app in which NO window has ever been focused,
//      so there is no "last focused" to remember. Confirmed to be a real state
//      rather than a defensive guess: instrumenting `browser-window-focus`
//      showed it never fires at all under this suite's Electron launches, and
//      `getFocusedWindow()` is null on every call. Rare interactively (a
//      window opened into the background), routine under automation. With zero
//      or one window it is exactly right; with several and no focus
//      information whatsoever, any answer is a guess, and "the one most
//      recently opened" is at least deterministic and matches what a user who
//      just opened a window means. It can only ever pick a real BrowserWindow
//      -- the thumbnail and page-count harnesses own never-shown BaseWindows,
//      which BrowserWindow.getAllWindows() does not return.
//
// Null therefore now means what it always should have: there is genuinely no
// window (macOS's "app running, everything closed" state).
//
// Deliberately NOT a full focus-ordered stack. That would only pay for itself
// if something needed the SECOND-most-recent window, and nothing does -- every
// caller asks exactly one question ("which window now?"), and a one-slot
// memory cannot go stale in a way the isDestroyed() checks do not cover.
let lastFocusedWindow: BrowserWindow | null = null

// Registered at module scope (before `app.whenReady()`), like every other
// app-level listener in this codebase -- `app.on` is legal before ready, and
// the very first `browser-window-focus` of a launch is exactly the event this
// must not miss.
export function initWindowFocusTracking(): void {
  app.on('browser-window-focus', (_event, win) => {
    lastFocusedWindow = win
  })
}

export function getActiveWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  if (lastFocusedWindow && !lastFocusedWindow.isDestroyed()) return lastFocusedWindow
  const live = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
  return live.length > 0 ? live[live.length - 1] : null
}
