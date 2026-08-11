// The wire contract between the native application menu (main process,
// src/main/app-menu.ts) and whatever renderer is focused when a menu item is
// clicked or its accelerator pressed.
//
// This module lives in `src/menu/` -- a THIRD-party directory to both
// processes, like `src/typography/` and `src/pagination/` already are --
// rather than in `src/main/`, and that placement is load-bearing rather than
// tidiness: the renderer needs `MenuCommand` (to type its handler map) and
// the PRELOAD needs `isMenuCommand` at RUNTIME (to validate what arrives over
// IPC before handing it to renderer code). A `src/main/*` module could not
// serve either -- src/main is outside tsconfig.web.json's program and every
// main-process module here transitively imports `electron`. Nothing in this
// file imports anything at all, deliberately, so it can be pulled into the
// preload bundle, the main bundle and the renderer bundle alike.

// Channel names, defined once so main and preload cannot disagree about them.
// A mismatch here fails silently in the worst possible way -- the menu item
// clicks, main sends, and nothing anywhere ever receives it.
export const MENU_COMMAND_CHANNEL = 'menu:command'
export const WINDOW_STATE_CHANNEL = 'window:setState'

// Every command the menu can deliver. Deliberately an exhaustive const array
// rather than a bare union type: the preload layer validates an incoming
// command against this exact list before invoking any renderer callback (see
// `isMenuCommand`), so the runtime allowlist and the compile-time type are
// the same single source. A command that isn't here cannot reach renderer
// code even if something managed to send it on this channel.
//
// `file:openRecent` is the only command that carries a payload (the recent
// file's path). That path originates from the main process's OWN
// recent-files.json, not from the renderer -- and the renderer then re-opens
// it through the ordinary `documentStore.openPath()` -> `file:openPath` ->
// `isKnownPath()` path, so this grants no disk access that clicking the same
// file on the Home screen wouldn't (CLAUDE.md's File I/O security invariant).
export const MENU_COMMANDS = [
  'file:new',
  'file:open',
  'file:openRecent',
  'file:save',
  'file:saveAs',
  'file:exportPdf',
  'file:print',
  'edit:find',
  'edit:findReplace',
  'edit:findNext',
  'edit:findPrevious',
  'view:format',
  'view:split',
  'view:source',
  'view:zoomIn',
  'view:zoomOut',
  'view:zoomReset',
  'view:toggleSidebar',
  'app:preferences',
  'app:shortcuts'
] as const

export type MenuCommand = (typeof MENU_COMMANDS)[number]

// Widened to `readonly string[]` before `.includes` on purpose: the array is
// `as const`, so its own `includes` signature only accepts a `MenuCommand`,
// which defeats the whole point of a guard taking `unknown`.
export function isMenuCommand(value: unknown): value is MenuCommand {
  return typeof value === 'string' && (MENU_COMMANDS as readonly string[]).includes(value)
}
