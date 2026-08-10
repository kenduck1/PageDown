// The wire contract for the window-close guard: main asks the focused
// window's renderer "may I close?", the renderer answers once it has finished
// whatever confirmation the user's unsaved work requires.
//
// Lives in its own dependency-free `src/window/` directory for exactly the
// reason `src/menu/commands.ts` documents for itself: BOTH the main process
// (which registers the ipcMain listener) and the PRELOAD bundle (which owns
// the only `ipcRenderer.on`/`send` for these channels) need these constants at
// RUNTIME, and a `src/main/*` module could serve neither -- src/main is
// outside tsconfig.web.json's program and every module there transitively
// imports `electron`. Nothing in this file imports anything, deliberately.
//
// WHY MAIN HAS TO ASK AT ALL, rather than deciding for itself: dirty state
// lives entirely in the renderer's Zustand document store (per-tab), and the
// only machinery that can act on it -- flushing Milkdown's 200ms-debounced
// onChange, saving a specific tab, clearing that tab's pending autosave
// snapshot -- is renderer-side too. A `win.on('close')` handler is cancelable
// but synchronous, so the answer necessarily arrives on a second channel.

// main -> renderer. Carries no payload: the renderer already knows everything
// about its own documents, and there is exactly one window per renderer.
export const WINDOW_CLOSE_REQUEST_CHANNEL = 'window:closeRequest'

// renderer -> main, carrying a single boolean: true = "I am done, close me",
// false = "the user cancelled, stay open". The main process keys the reply on
// `BrowserWindow.fromWebContents(event.sender)`, so a renderer can only ever
// answer for its OWN window.
export const WINDOW_CLOSE_RESPONSE_CHANNEL = 'window:closeResponse'
