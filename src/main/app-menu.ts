import { app, BrowserWindow, Menu } from 'electron'
import { readRecentFiles } from './recent-files'
import { buildAppMenuTemplate } from './app-menu-template'
import { APP_NAME, formatWindowTitle } from './window-title'
import {
  DEFAULT_WINDOW_UI_STATE,
  coerceWindowUiState,
  menuRelevantStateChanged,
  type WindowUiState
} from '../menu/window-state'
import type { MenuCommand } from '../menu/commands'

// The Electron-touching half of the application menu: it owns the per-window
// UI state each renderer reports, builds the real Menu from
// app-menu-template.ts's pure template, and sets the window title. Everything
// that can be decided without Electron lives in app-menu-template.ts /
// window-title.ts instead, so it can be unit-tested directly (same split as
// recent-files.ts vs file-io.ts).
//
// This module has no unit test of its own, matching src/main/index.ts's own
// established treatment: it is lifecycle wiring around functions that are
// already tested elsewhere, and its real behaviour (a menu genuinely
// installed, a title genuinely set) is only observable in a running Electron
// app -- see phase0/gate30-app-menu.spec.ts.

interface AppMenuDeps {
  userDataDir: string
  isDev: boolean
  // Delivers a menu command to whichever window should receive it. Injected
  // by src/main/index.ts, which owns both the window set and createWindow --
  // this module deliberately does not decide routing policy.
  dispatch: (command: MenuCommand, payload?: string) => void
}

let deps: AppMenuDeps | null = null

// Per-window, because the menu is global but the state driving it is not: two
// windows can be on different screens (one on Home, one editing) and in
// different view modes at the same time, and the menu must describe whichever
// one is FOCUSED. A WeakMap rather than a Map keyed by id so a closed
// window's entry cannot outlive the window itself.
const windowStates = new WeakMap<BrowserWindow, WindowUiState>()

// Rebuilt (rather than mutated) on every relevant change. Electron's Menu is
// immutable once built in practice -- flipping `enabled` on a live MenuItem
// works, but keeping a handle on every item to do so would mean a second,
// hand-maintained mirror of the template's structure. A menu rebuild is
// cheap and happens only on focus changes, document-open/view-mode changes
// and recent-file changes, never per keystroke (see menuRelevantStateChanged).
export async function refreshApplicationMenu(): Promise<void> {
  const current = deps
  if (!current) return
  // readRecentFiles never rejects (it swallows every read error internally
  // and returns []), so this cannot leave the app menu-less on a corrupt or
  // missing recent-files.json.
  const recents = await readRecentFiles(current.userDataDir)
  const focused = BrowserWindow.getFocusedWindow()
  // No focused window (every window closed on macOS, or the app is in the
  // background) falls back to the neutral default, which disables every
  // document-scoped item -- correct, since there is demonstrably no document
  // on screen to act on.
  const state = (focused ? windowStates.get(focused) : undefined) ?? DEFAULT_WINDOW_UI_STATE
  const template = buildAppMenuTemplate({
    appName: APP_NAME,
    platform: process.platform,
    isDev: current.isDev,
    state,
    recentFiles: recents.map((entry) => entry.filePath),
    send: current.dispatch
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

export function initApplicationMenu(next: AppMenuDeps): void {
  deps = next
  // Focus is what selects WHICH window's state the menu describes, so it is
  // the one event that must always rebuild -- including the very first focus,
  // which is typically what installs the correct enablement after startup.
  app.on('browser-window-focus', () => {
    void refreshApplicationMenu()
  })
  void refreshApplicationMenu()
}

// Called for every WINDOW_STATE_CHANNEL message. Does the two things only the
// main process can: the real OS window title, and the application menu's
// enablement/checkmarks.
export function applyWindowUiState(win: BrowserWindow, raw: unknown): void {
  const state = coerceWindowUiState(raw)
  const previous = windowStates.get(win)
  windowStates.set(win, state)

  // A message can genuinely arrive after its window is gone -- the renderer
  // sends on a React effect, and a close can land between the send and its
  // delivery. Every setter below throws on a destroyed window.
  if (win.isDestroyed()) return

  win.setTitle(formatWindowTitle(state))
  // macOS-only: paints the real dot inside the window's close button. Guarded
  // by platform rather than called blindly because it is documented as a
  // macOS API; the title's own bullet marker (see window-title.ts) is what
  // carries the same information everywhere else.
  if (process.platform === 'darwin') win.setDocumentEdited(state.isDirty)

  // Only rebuild for a change the menu can actually show, and only for the
  // window the menu is currently describing. Without the first guard this
  // would rebuild the entire menu on every dirty flip (i.e. on the first
  // keystroke after every save); without the second, a background window's
  // report would repaint the menu to describe a window the user isn't
  // looking at. `focused === null` is included deliberately: at startup the
  // first state report can land before the window has been focused at all,
  // and skipping it there would leave the menu stuck on the neutral default
  // until the user clicked somewhere.
  const focused = BrowserWindow.getFocusedWindow()
  if (menuRelevantStateChanged(previous, state) && (focused === win || focused === null)) {
    void refreshApplicationMenu()
  }
}
