import {
  app,
  shell,
  dialog,
  BrowserWindow,
  ipcMain,
  Menu,
  screen,
  type MenuItemConstructorOptions
} from 'electron'
import { join, isAbsolute } from 'path'
import { stat } from 'node:fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  readWindowState,
  writeWindowState,
  resolveInitialWindowBounds,
  type WindowBounds,
  type InitialWindowBounds
} from './window-bounds'
import { registerPaginationScheme } from './pagination-scheme'
import {
  createPaginationHarness,
  sendGate7Phase1,
  sendGate7Phase2,
  sendGate4HeaderFooterProbe
} from './pagination-window'
import { paginateAndTime } from '../pagination/paginate'
import { exportToPdf } from '../export/export-pdf'
import { getThumbnail, destroyThumbnailHarness } from './thumbnail-generator'
import { getPageCount, destroyPageCountHarness } from './page-count-generator'
import { createSplitPreviewHarness, type SplitPreviewHarness } from './split-preview-window'
import { exportDocumentToPdf } from './pdf-exporter'
import { exportDocumentToHtml } from './html-exporter'
import { printDocument } from './print-exporter'
import { readPreferences, writePreferences, type Preferences } from './preferences'
import {
  openFileDialog,
  readFileByPath,
  saveFileToKnownOrChosenPath,
  getRecentFiles,
  addRecentFile,
  removeRecentFile,
  clearRecentFiles,
  isKnownPath,
  confirmDiscardChanges,
  canonicalizeDocumentPath,
  saveDroppedImage
} from './file-io'
import {
  writeSnapshot,
  listSnapshots,
  readSnapshotContent,
  clearPendingAutosaveForFile
} from './version-history'
import { PAGE_WIDTH_PX, PAGE_HEIGHT_PX } from '../typography/page-geometry'
import { applyWindowUiState, initApplicationMenu, refreshApplicationMenu } from './app-menu'
import { drainConfigWarnings } from './config-warnings'
import { MENU_COMMAND_CHANNEL, WINDOW_STATE_CHANNEL, type MenuCommand } from '../menu/commands'
import {
  WINDOW_CLOSE_REQUEST_CHANNEL,
  WINDOW_CLOSE_RESPONSE_CHANNEL
} from '../window/close-request'
import { extractMarkdownPathFromArgv, looksLikeMarkdownPath } from './open-file-args'

// Must run before app.whenReady() is awaited anywhere — Electron requires
// protocol.registerSchemesAsPrivileged() to be called before the `ready`
// event fires (see pagination-scheme.ts for why this scheme needs to be
// privileged at all).
registerPaginationScheme()

// ---------------------------------------------------------------------------
// Product-completeness audit 2.5: file associations, "Open With", and a
// single-instance lock. All three ship together, deliberately, because they
// only work correctly AS a set:
//
//   - electron-builder.yml's `fileAssociations` (.md/.markdown) is what
//     makes the OS route a double-click / "Open With PageDown" to this app
//     at all -- without it, none of the code below ever runs, because the
//     OS would never launch this app for a document in the first place.
//   - Without the single-instance lock below, EVERY double-click would spawn
//     a brand-new OS process (a full extra Electron app, not just a window)
//     on Windows/Linux, since neither platform recognizes "PageDown is
//     already running" on its own the way macOS's LaunchServices does.
//   - Without `second-instance` (registered by the lock below), a SECOND
//     double-click while the app is already running would do nothing at all
//     once the duplicate second process refuses to start -- the file needs
//     an explicit, IPC-like path back into the ALREADY-running process.
//
// --- Why an OS-supplied path is trusted as a FOURTH isKnownPath source ---
//
// CLAUDE.md's File I/O security invariant states the allowlist is fed only
// by a real native dialog result or an already-persisted recents entry.
// A path arriving via `open-file` (macOS), `process.argv` (Windows/Linux
// cold launch), or `second-instance`'s own `argv` (Windows/Linux warm
// launch) is a genuinely NEW, fourth source -- worth reasoning through
// explicitly rather than adding by analogy.
//
// Verdict: trusted, and added to the SAME allowlist a native Open dialog
// result already feeds, via the SAME addRecentFile call every other
// "known" path goes through -- no new, parallel allowlist, no schema
// change to isKnownPath itself. Reasoning:
//
//   1. It is a genuine, deliberate user gesture. Double-clicking a document
//      in Finder/Explorer, or choosing "Open With > PageDown", is at least
//      as intentional as navigating a native Open dialog to the same file
//      and clicking Open -- arguably more so, since the user is acting on
//      the FILE directly rather than on the app.
//   2. It cannot be forged by a renderer. Nothing under src/renderer/**
//      can fire an `open-file` app event or rewrite this process's own
//      `process.argv` -- those are OS-to-main-process channels with zero
//      renderer involvement, contextBridge or otherwise. This is NOT the
//      same shape of risk isKnownPath's own comment warns about for
//      registerAssetRoot ("any future caller must pass an
//      isKnownPath-validated absolute path") -- that guards against a
//      RENDERER laundering an arbitrary path through a main-process API;
//      there is no renderer-reachable API here for that at all. A renderer
//      cannot ask this app to "open-file" an arbitrary path on its
//      behalf -- the only two entry points into this code path are a real
//      OS launch event and a real OS-delivered argv list.
//   3. It is validated BEFORE being trusted, not merely accepted verbatim.
//      `resolveOsOpenedMarkdownPath` below requires the path to be
//      absolute, to end in .md/.markdown, and to `stat()` as a real,
//      currently-existing regular file -- the exact same "is this really a
//      file, right now" check `readFileByPath` would perform anyway on
//      open. A path that fails any of those is silently dropped, never
//      opened and never added to recents.
//   4. Once validated, it is handed to the SAME `addRecentFile` +
//      `createWindow(path)` pair "Open in New Window" and the Home
//      screen's own recent-file rows already use -- the new window's own
//      App.tsx independently RE-validates the path through the real
//      `file:openPath` handler's own `isKnownPath` check before ever
//      reading its content (see createWindow's own doc comment on the
//      `openPath` parameter). So this code path grants no new, direct
//      disk-read capability of its own; its only real effect is deciding
//      which already-known-safe path a fresh, already-fully-privileged
//      window is told to open.
// ---------------------------------------------------------------------------

// Cheap, synchronous shape check (extractMarkdownPathFromArgv/
// looksLikeMarkdownPath, open-file-args.ts) plus a real, async `stat` --
// absolute-path-required and must resolve to an existing regular file RIGHT
// NOW. Returns null (never throws) for anything that fails either check, so
// a stale/deleted/malformed OS-supplied path is silently ignored rather than
// surfacing a confusing error for a launch the user didn't consciously
// trigger through this app's own UI at all.
async function resolveOsOpenedMarkdownPath(rawPath: string): Promise<string | null> {
  if (!looksLikeMarkdownPath(rawPath)) return null
  if (!isAbsolute(rawPath)) return null
  try {
    const stats = await stat(rawPath)
    if (!stats.isFile()) return null
  } catch {
    return null
  }
  return rawPath
}

// The shared "a real OS launch just named this document" handler -- used by
// BOTH the macOS `open-file` listener and the Windows/Linux
// `second-instance` listener below. Validates, records the path as a real
// recent file (see this block's own "fourth isKnownPath source" reasoning
// above), and opens a fresh window for it via the exact same `createWindow`
// path/query-param mechanism `window:openInNew` already uses.
async function handleOpenRequestedPath(rawPath: string): Promise<void> {
  const validated = await resolveOsOpenedMarkdownPath(rawPath)
  if (!validated) return
  try {
    await addRecentFile(app.getPath('userData'), validated)
    void refreshApplicationMenu()
  } catch (err) {
    console.error('Failed to record an OS-opened file as recent', err)
  }
  createWindow(validated)
}

// macOS delivers a file-open request (a Finder double-click, drag-onto-Dock-
// icon, or "Open With") via this event, NOT via `process.argv` the way
// Windows/Linux do -- confirmed by Electron's own documented behavior (macOS
// file-open requests route through LaunchServices/Apple Events, surfaced as
// `open-file`, regardless of whether the app was already running).
//
// The classic bug this guards against: `open-file` CAN fire before
// `app.whenReady()` resolves (a cold launch triggered BY double-clicking the
// document itself, not by opening the app first) -- an unguarded handler
// that called `handleOpenRequestedPath` immediately would try to create a
// BrowserWindow before Electron is ready for one, and typically silently
// drop the request. `pendingOpenFilePaths` queues every such early event;
// `app.whenReady()`'s own callback below drains it as part of deciding what
// the FIRST window should open, rather than opening a redundant separate
// window for it.
// `event.preventDefault()` marks this event as handled, per Electron's own
// documented contract for `open-file`.
const pendingOpenFilePaths: string[] = []
let openFileQueueDrained = false
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (openFileQueueDrained) {
    void handleOpenRequestedPath(filePath)
  } else {
    pendingOpenFilePaths.push(filePath)
  }
})

// Windows/Linux: a file-association double-click while PageDown is not
// already running spawns a brand-new OS process, which -- without this
// lock -- would become a second, fully independent instance of the app
// rather than opening the file in the one the user is presumably already
// using. `requestSingleInstanceLock()` returns false in that brand-new
// process the INSTANT a lock-holding instance is detected; quitting
// immediately here (before any window is created) is what stops the
// duplicate instance from ever showing anything, while the ORIGINAL
// instance's own `second-instance` listener below receives that second
// launch's argv and takes the actual action.
//
// Scoped by Electron to the app's own userData path (confirmed against
// Electron's documented behavior, not assumed) -- phase0/phase1 gate specs,
// which each launch via `launchIsolatedApp`'s own fresh `--user-data-dir`
// per test (CLAUDE.md's own documented reason: never pollute a real
// developer's recent-files.json), therefore never collide with each other
// OR with a real interactively-running dev instance's own default userData
// directory. Left unconditional (not gated behind `is.dev`) on purpose --
// single-instance behavior is exactly as real a product requirement in
// development as in a packaged build, and gating it would mean this code
// path never actually runs until the first real packaged install.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

// Fires in the ORIGINAL (lock-holding) instance whenever a SECOND launch is
// attempted -- `argv` is that second launch's own full command line, which
// is where electron-builder's `fileAssociations`-driven
// `pagedown.exe "C:\path\to\file.md"` launch actually carries the document
// path on Windows/Linux (macOS never reaches this path for a file-open --
// see the `open-file` listener above). Harmless to register even in the
// process that FAILED to get the lock (it's about to quit via app.quit()
// above and this listener will simply never fire there).
//
// Focuses/restores an existing window regardless of whether this second
// launch also names a file -- bringing the already-running app to the
// front is the entire point of a single-instance lock, independent of
// whatever else the second launch was trying to do.
app.on('second-instance', (_event, argv) => {
  const target = [...documentWindows][0]
  if (target) {
    if (target.isMinimized()) target.restore()
    target.focus()
  }
  const candidate = extractMarkdownPathFromArgv(argv)
  if (candidate) void handleOpenRequestedPath(candidate)
})

// Phase 0 spike bridge, not part of the shipped app: Playwright's
// `electronApplication.evaluate()` runs the injected callback in a bare V8
// context with no `require` and no working dynamic `import()` (confirmed
// empirically — both throw ReferenceError / "no dynamic import callback
// specified" respectively). globalThis *is* shared with that context
// though, so exposing createPaginationHarness this way is how gate5 (and
// every later Phase 0 gate script) reaches it from a Playwright test.
//
// Task 6 adds `paginateAndTime` to this same bridge for exactly the same
// reason: the brief's gate2-performance.spec.ts sample does
// `await import('../src/pagination/paginate')` inside `app.evaluate()`,
// which fails the same way `import('../src/main/pagination-window')` did
// in Task 3/Gate 5 — confirmed empirically, not assumed.
//
// Task 7 adds `sendGate7Phase1`/`sendGate7Phase2` for the same reason again,
// split into two functions (rather than one, like `paginateAndTime`)
// because the Gate 7 spike genuinely needs two separate `app.evaluate()`
// round trips: phase 1's result (the section number nearest the captured
// breakToken) has to come back out to the *Node* test process so it can
// build an edited markdown string and run it through `markdownToHtml`
// (itself only reachable from a plain Node context, not from inside
// `app.evaluate()`'s bare V8 context) before phase 2 can run. See
// phase0/gate7-incremental-relayout.spec.ts.
//
// Task 9 adds `exportToPdf` for the same reason again: its own consumer
// (phase0/gate4-export.spec.ts) needs to call `harness.view.webContents
// .printToPDF(...)` from inside `app.evaluate()`, which requires reaching
// `exportToPdf` itself the same bridged way every other main-process-only
// function on this object already is. `sendGate4HeaderFooterProbe` is
// added alongside it for the same reason as `sendGate7Phase1`/`Phase2` —
// see pagination-window.ts's own comment on why this probe exists at all.
//
// Task 4 (Home Screen) adds `getThumbnail` for the same reason again:
// phase0/gate8-thumbnail-generation.spec.ts needs to call it from inside
// `app.evaluate()`'s bare V8 context, same as every other entry here.
//
// Gated behind `is.dev` (App identity/packaging cleanup pass): this object
// exists purely for phase0/phase1 gate specs, which always launch the
// unpackaged `out/` build directly (`_electron.launch(['out/main/index.js'])`,
// never a real electron-builder package) — so `is.dev` (`!app.isPackaged`,
// per @electron-toolkit/utils) is `true` for every one of them, and this
// gating changes nothing about what any existing gate can reach. A real,
// packaged end-user install has `app.isPackaged === true`, so the bridge
// (and every main-process function it pins a reference to) is simply never
// installed there — one fewer piece of test-only scaffolding shipped to
// users. Do not remove the gate to "simplify": that is what makes this safe
// to keep at all rather than deleting it and fixing ~15 gate files.
declare global {
  var __pagedownPhase0:
    | {
        createPaginationHarness: typeof createPaginationHarness
        paginateAndTime: typeof paginateAndTime
        sendGate7Phase1: typeof sendGate7Phase1
        sendGate7Phase2: typeof sendGate7Phase2
        exportToPdf: typeof exportToPdf
        sendGate4HeaderFooterProbe: typeof sendGate4HeaderFooterProbe
        getThumbnail: typeof getThumbnail
      }
    | undefined
}
if (is.dev) {
  globalThis.__pagedownPhase0 = {
    createPaginationHarness,
    paginateAndTime,
    sendGate7Phase1,
    sendGate7Phase2,
    exportToPdf,
    sendGate4HeaderFooterProbe,
    getThumbnail
  }
}

// Split mode's own lazily-created harness instance and its serializing
// queue, both held in this module's scope -- mirrors the existing
// mainWindow-closure pattern every other IPC handler in this file already
// uses (see CLAUDE.md's "known pre-existing issues" section for the
// documented staleness limitation that pattern carries; it applies here too
// and is not re-solved by this task). Created lazily by whichever of
// split-preview:setBounds/split-preview:sendDocument fires first, torn down
// and cleared by split-preview:destroy so the next call recreates it fresh.
let splitPreviewHarnessPromise: Promise<SplitPreviewHarness> | null = null

function getOrCreateSplitPreviewHarness(win: BrowserWindow): Promise<SplitPreviewHarness> {
  if (!splitPreviewHarnessPromise) {
    splitPreviewHarnessPromise = createSplitPreviewHarness(win)
  }
  return splitPreviewHarnessPromise
}

// Serializes every call that dispatches work into the split-preview harness
// -- required for exactly the reason thumbnail-generator.ts's and
// page-count-generator.ts's own enqueueHarnessWork queues exist (see
// CLAUDE.md's "the pagination render harness handles exactly ONE in-flight
// request at a time" invariant): resources/pagination-render/index.ts's
// render context tracks a single `currentRequestId` module variable and
// silently drops the result of any request that isn't the most recently
// dispatched one. Live typing in Split mode will produce a new
// split-preview:sendDocument call well within the previous one's round trip
// -- the renderer's own debounce is 500ms, and a full relayout can exceed
// that -- so without this queue, concurrent calls would race the render
// context and intermittently time out after 10s. This is a SEPARATE queue
// from both of those (and from the Phase-0-spike harness in this same
// file), per this codebase's established "don't couple unrelated harness
// consumers" rule. Also used to serialize split-preview:destroy behind any
// already-queued sendDocument work, below, so the harness is never torn
// down mid-render.
let splitPreviewQueue: Promise<unknown> = Promise.resolve()

function enqueueSplitPreviewWork<T>(task: () => Promise<T>): Promise<T> {
  const result = splitPreviewQueue.then(task)
  // Chain the queue's tail through a value- and rejection-swallowing
  // continuation, not `result` directly -- otherwise one rejected call would
  // permanently wedge the queue for every caller after it (same fix as
  // thumbnail-generator.ts's/page-count-generator.ts's identical pattern).
  splitPreviewQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

// Tears down the lazily-created split-preview harness (if one exists) and
// clears the module-scope reference so the NEXT setBounds/sendDocument call
// recreates it fresh. Shared by two callers: the split-preview:destroy IPC
// handler below (the renderer's own explicit "left Split mode" signal) and
// `createWindow`'s `mainWindow` `'closed'` handler just below this function
// -- unlike thumbnail-generator.ts's/page-count-generator.ts's own harnesses,
// which each own a SEPARATE, dedicated BaseWindow that mainWindow closing
// never touches, this harness's WebContentsView is a CHILD of mainWindow's
// own contentView (per Task 2's design, deliberately -- Split mode's whole
// point is a visibly composited pane, not an off-screen render target).
// Electron does not appear to destroy a child WebContentsView's own
// WebContents just because its parent BrowserWindow closes (it's a sibling
// compositing layer, not the window's primary WebContents) -- so without
// this call, closing the app's real window while Split mode was ever visited
// would leak that view's own sandboxed renderer process for the remainder of
// the app's lifetime. `destroy()` itself is safe to call on an
// already-destroyed mainWindow (guards with `mainWindow.isDestroyed()`
// internally, per Task 2), matching the codebase's "never throw from
// teardown" discipline every other harness here also follows.
function destroySplitPreviewHarness(): Promise<void> {
  const harnessPromise = splitPreviewHarnessPromise
  splitPreviewHarnessPromise = null
  if (!harnessPromise) return Promise.resolve()
  return enqueueSplitPreviewWork(async () => {
    try {
      const harness = await harnessPromise
      harness.destroy()
    } catch (err) {
      console.error('Failed to destroy split preview harness', err)
    }
  })
}

// Every open document window (Multi-window support) -- NOT just the first
// one createWindow() ever makes. Used so shared, process-wide harness
// teardown (thumbnail/page-count generators, both dedicated invisible
// BaseWindows unrelated to any specific document window -- see
// thumbnail-generator.ts's own module comment) only fires once the LAST
// window closes, not every time ANY window closes. Split mode's own
// harness is deliberately NOT covered by this set-based teardown -- see
// destroySplitPreviewHarness's own updated comment for why it stays tied
// to the FIRST window specifically, a disclosed, narrower scope than full
// per-window Split mode support.
const documentWindows = new Set<BrowserWindow>()

// Product-completeness audit 2.3: "Show in folder" for a just-exported PDF/
// HTML file. Deliberately NOT an arbitrary-path reveal primitive -- the
// `shell:showItemInFolder` handler below only ever reveals a path that
// EXISTS IN THIS SET, and the only two places that ever ADD to it are the
// file:exportPdf/file:exportHtml handlers themselves, immediately after a
// real dialog.showSaveDialog()-chosen path was actually written to. A
// renderer can hand this handler any string it wants (contextBridge grants
// no protection against a compromised renderer calling an exposed IPC
// method with attacker-chosen arguments), but that string can only ever
// match a path THIS PROCESS itself just wrote -- there is no way to get an
// arbitrary existing file (a user's SSH key, a config file) into this set
// without this app's own export flow having written a file at that exact
// path a moment earlier. `rememberRevealablePath` below caps this at a
// small, bounded size (most-recently-exported-first) purely for hygiene --
// unbounded growth here is a memory footprint concern over a very long
// session, never a security one, since membership is the only thing that
// matters, not recency.
const revealableExportPaths = new Set<string>()
const MAX_REVEALABLE_EXPORT_PATHS = 20

function rememberRevealablePath(filePath: string): void {
  // Delete-then-add moves an already-present path to the "most recent" end
  // of the Set's own iteration order, so repeatedly re-exporting the same
  // path doesn't let it get evicted by newer, unrelated exports while it's
  // still the one most likely to be revealed next.
  revealableExportPaths.delete(filePath)
  revealableExportPaths.add(filePath)
  while (revealableExportPaths.size > MAX_REVEALABLE_EXPORT_PATHS) {
    const oldest = revealableExportPaths.values().next().value
    if (oldest === undefined) break
    revealableExportPaths.delete(oldest)
  }
}

// ---------------------------------------------------------------------------
// Window-close / app-quit guard.
//
// Before this existed there was NO `close` handler and NO `before-quit`
// handler anywhere in this file, and no `beforeunload` anywhere in `src/` or
// `resources/` either -- so closing a window (Cmd+W, the red button, File >
// Close Window) or quitting (Cmd+Q, File > Exit) discarded every unsaved
// document with no prompt at all. The app already knew how to ask (the
// Save/Don't Save/Cancel dialog EditorScreen's "<- Home" button and its
// dirty-tab close both run); the guard was simply absent from the two exits
// users actually use.
//
// Worst case was TOTAL loss rather than partial: `useAutosave` only fires for
// a document that already has a file path, so a never-saved "Untitled" tab has
// no autosave snapshot and nothing in version history to recover from.
//
// The renderer, not this process, runs the actual confirmation -- see
// src/window/close-request.ts for why that direction is forced.
// ---------------------------------------------------------------------------

// Windows whose close has ALREADY been approved. `win.on('close')` is
// re-entered when we close the window a second time after approval, and this
// is what lets that second pass through instead of asking again. A WeakSet so
// an entry cannot outlive its window.
const closeApproved = new WeakSet<BrowserWindow>()

// One in-flight approval round trip per window, so mashing Cmd+W while a
// confirmation dialog is already up cannot start a second round of prompts.
const pendingCloseApprovals = new WeakMap<BrowserWindow, Promise<boolean>>()

// The `resolve` of the promise above, looked up when the renderer answers.
const closeResponders = new WeakMap<BrowserWindow, (allow: boolean) => void>()

// Asks a window's renderer whether it is safe to close, resolving true when it
// is. Never rejects and never hangs on a dead renderer.
//
// The three short-circuits are all "there is no unsaved state left to lose, so
// asking is both impossible and pointless": a destroyed or crashed webContents
// no longer holds the document store at all, and a window still loading its
// main frame has not yet had a chance to accumulate an edit. Without them a
// window closed during startup, or one whose renderer has crashed, would have
// its close cancelled forever with nothing able to answer -- an unclosable
// window, which is a worse bug than the one this guard fixes.
function requestCloseApproval(win: BrowserWindow): Promise<boolean> {
  const inFlight = pendingCloseApprovals.get(win)
  if (inFlight) return inFlight

  if (win.isDestroyed()) return Promise.resolve(true)
  const contents = win.webContents
  if (contents.isDestroyed() || contents.isCrashed() || contents.isLoadingMainFrame()) {
    return Promise.resolve(true)
  }

  const approval = new Promise<boolean>((resolve) => {
    closeResponders.set(win, resolve)
    // A renderer that dies mid-prompt must not trap its own window. Both
    // events are one-shot and harmless if they never fire.
    contents.once('render-process-gone', () => resolve(true))
    contents.once('destroyed', () => resolve(true))
    contents.send(WINDOW_CLOSE_REQUEST_CHANNEL)
  }).finally(() => {
    pendingCloseApprovals.delete(win)
    closeResponders.delete(win)
  })
  pendingCloseApprovals.set(win, approval)
  return approval
}

// Closes a window through the guard, resolving true once it is genuinely
// closing. Shared by `win.on('close')` and the quit sequence below so both
// exits run one implementation.
async function closeWindowWithApproval(win: BrowserWindow): Promise<boolean> {
  const allow = await requestCloseApproval(win)
  if (!allow) return false
  closeApproved.add(win)
  if (!win.isDestroyed()) win.close()
  return true
}

// Quit is guarded SEPARATELY from window close, because `before-quit` fires
// BEFORE any window gets a `close` event -- a quit that only relied on the
// per-window guard would tear every window down without asking anything.
//
// The two cannot double-prompt: the loop below marks each window approved
// before calling close(), so the `close` handler's own first line returns
// immediately for it.
let quitApproved = false
let quitInProgress = false

app.on('before-quit', (event) => {
  // Second pass, after every window has already confirmed -- let it through.
  if (quitApproved) return
  event.preventDefault()
  // A second Cmd+Q while the first quit is still asking must not restart the
  // prompts; the in-flight round trip is already covering every window.
  if (quitInProgress) return
  quitInProgress = true

  void (async () => {
    try {
      // A copied array, not the live Set: closing a window mutates
      // `documentWindows` from its own 'closed' handler mid-iteration.
      for (const win of [...documentWindows]) {
        if (win.isDestroyed()) continue
        // ONE window cancelling cancels the whole quit -- the same semantics
        // every document-based app has, and the only safe reading of "Cancel"
        // when the alternative is discarding that window's work anyway.
        if (!(await closeWindowWithApproval(win))) return
      }
      quitApproved = true
      app.quit()
    } finally {
      quitInProgress = false
    }
  })()
})

// Routes an application-menu command to the window that should act on it.
//
// The FOCUSED window, matching the `BrowserWindow.fromWebContents(event.sender)`
// pattern dialog:confirmDiscard/file:exportPdf/file:save already use for the
// mirror-image direction (a renderer-initiated request that needs to know
// which window asked). A menu is global to the app; the document it acts on
// is not.
//
// The `documentWindows` fallback covers a narrow but real gap: on macOS a
// window can be open while the app is not frontmost, in which case
// getFocusedWindow() is null even though there is exactly one obvious
// recipient. Deterministic (insertion order, i.e. the first window still
// open) rather than arbitrary.
//
// With NO window at all -- macOS's "app running, every window closed" state,
// where the menu is still on screen and still clickable -- only New and Open
// do anything: they create a window, which boots at Home where both actions
// are one click away. The command itself is deliberately NOT queued and
// replayed into the new window: that would need a whole
// deliver-once-the-renderer-is-ready handshake for two commands whose entire
// effect is "show a screen the fresh window already shows." Every other
// command is dropped, which is correct -- Save/Export/Find have no document
// to act on.
function dispatchMenuCommand(command: MenuCommand, payload?: string): void {
  const focused = BrowserWindow.getFocusedWindow()
  const target = focused ?? documentWindows.values().next().value
  if (!target || target.isDestroyed()) {
    if (command === 'file:new' || command === 'file:open') createWindow()
    return
  }
  target.webContents.send(MENU_COMMAND_CHANNEL, command, payload)
}

// Builds the real native spelling-suggestion + standard edit context menu
// for a given window's webContents -- see the original inline comment this
// was extracted from (now attached per-window inside createWindow, not
// registered once for a single captured mainWindow) for the full
// rationale: this app had NO context menu at all before it, for spelling
// suggestions AND ordinary Cut/Copy/Paste/Select All alike.
function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const template: MenuItemConstructorOptions[] = []

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions) {
        template.push({
          label: suggestion,
          click: () => win.webContents.replaceMisspelling(suggestion)
        })
      }
      if (params.dictionarySuggestions.length > 0) {
        template.push({ type: 'separator' })
      }
      template.push({
        label: 'Add to Dictionary',
        click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      })
      template.push({ type: 'separator' })
    }

    template.push(
      { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
      { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
      { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { label: 'Select All', role: 'selectAll', enabled: params.editFlags.canSelectAll }
    )

    Menu.buildFromTemplate(template).popup()
  })
}

// Debounced, best-effort window-bounds persistence (App identity/packaging
// cleanup pass) -- keyed process-wide, not per-window: there is exactly one
// window-state.json, remembering whichever window was most recently
// resized/moved. That is correct for this app's default single-window
// usage and no worse than most single-file "remember my window"
// implementations elsewhere; a real per-window scheme would need a keyed
// store the same way Split mode's own per-window limitation (see CLAUDE.md's
// "Multi-window support" section) was deliberately not built out either.
// The short debounce avoids hammering disk on every drag-resize tick; the
// 'close' listener wired below additionally flushes synchronously-read
// bounds immediately, covering a resize-then-immediately-close sequence the
// debounce would otherwise drop.
let windowBoundsSaveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleWindowBoundsSave(bounds: WindowBounds): void {
  if (windowBoundsSaveTimer) clearTimeout(windowBoundsSaveTimer)
  windowBoundsSaveTimer = setTimeout(() => {
    windowBoundsSaveTimer = null
    void writeWindowState(app.getPath('userData'), bounds).catch((err) => {
      console.error('Failed to save window bounds', err)
    })
  }, 400)
}

// A minimized window's getBounds() is unreliable across platforms (it can
// report the pre-minimize size or a degenerate one) -- skipping the save
// while minimized means the last SAVED bounds are always a real, restorable
// on-screen size.
function wireWindowBoundsPersistence(win: BrowserWindow): void {
  const persist = (): void => {
    if (win.isDestroyed() || win.isMinimized()) return
    scheduleWindowBoundsSave(win.getBounds())
  }
  win.on('resize', persist)
  win.on('move', persist)
  win.on('close', () => {
    if (windowBoundsSaveTimer) {
      clearTimeout(windowBoundsSaveTimer)
      windowBoundsSaveTimer = null
    }
    if (win.isDestroyed() || win.isMinimized()) return
    // Fire-and-forget, matching this codebase's other best-effort
    // persistence (autosave snapshots, etc.) -- must never delay or block
    // the close guard registered separately below.
    void writeWindowState(app.getPath('userData'), win.getBounds()).catch((err) => {
      console.error('Failed to save window bounds on close', err)
    })
  })
}

// `openPath`, when given, is a document to load automatically once this
// window's renderer boots -- App.tsx reads it back off its own
// `window.location.search` (`?openPath=...`) and calls the SAME
// `openPath()` documentStore action a user clicking a recent-file row
// already triggers, so it goes through that action's own real
// `file:openPath` IPC round trip and the SAME `isKnownPath` validation --
// passing a path through here grants no NEW disk access whatsoever, it
// only chooses which document a fresh, already-fully-privileged window
// attempts to open via an already-validated path.
//
// `initialBounds`, when given, seeds the window's starting size/position --
// used only by the very first window app.whenReady() creates, which awaits
// a real disk read (readWindowState) plus resolveInitialWindowBounds's
// on-screen check before this function is ever called. Every OTHER caller
// (File > New/Open with no window focused, "Open in New Window", macOS
// `activate` with zero windows open) omits it and gets the plain default
// size, centered -- a deliberate, narrower scope than "every new window
// remembers the last used size": those are in-session actions creating an
// ADDITIONAL window, not the cold-launch restore this feature exists for.
function createWindow(openPath?: string, initialBounds?: InitialWindowBounds): BrowserWindow {
  const bounds = initialBounds ?? { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT }
  // Create the browser window.
  const win = new BrowserWindow({
    ...bounds,
    // Enforced by the OS on every resize, not just at launch -- below this,
    // the toolbar's sticky left group crowds out the scrollable segment
    // (see CLAUDE.md's Comments section on the "Add comment" button) and
    // there is no longer enough vertical room for toolbar + status bar +
    // a usable page sliver.
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    // `autoHideMenuBar: true` (the electron-vite template's own default) was
    // removed when this app gained a real application menu: on Windows/Linux
    // it hides the menu bar until Alt is pressed, which is precisely the
    // discoverability problem this sub-project exists to fix -- the
    // accelerators worked either way, but nothing showed a user that File >
    // Export as PDF or View > Split existed. No effect on macOS, where the
    // menu lives in the system menu bar regardless.
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true
    }
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  documentWindows.add(win)
  wireWindowBoundsPersistence(win)

  // The cancelable half of the close guard (see the block above
  // `documentWindows` for the full rationale). `'close'` -- present tense,
  // cancelable -- not the pre-existing `'closed'` handler below, which fires
  // after the window is already destroyed and can no longer stop anything.
  //
  // Works with the application menu rather than against it: File > Close
  // Window is `role: 'close'` and Cmd+Q is `role: 'quit'`, which are exactly
  // `win.close()` and `app.quit()`, so both arrive here (or at `before-quit`)
  // with nothing menu-specific to special-case.
  win.on('close', (event) => {
    if (closeApproved.has(win)) return
    event.preventDefault()
    void closeWindowWithApproval(win)
  })

  // A renderer crash takes the whole in-memory document store with it, so the
  // user must at least be TOLD -- before this, `render-process-gone` had no
  // handler anywhere and a crashed window simply went blank and stayed blank.
  // Reload is offered rather than performed automatically because reloading is
  // itself destructive to anything the crash left behind; recovery of a saved
  // document's unsaved edits goes through the existing autosave-on-open path,
  // which is what the detail text points at.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process gone', details)
    if (win.isDestroyed()) return
    void dialog
      .showMessageBox(win, {
        type: 'error',
        buttons: ['Reload', 'Close Window'],
        defaultId: 0,
        cancelId: 1,
        message: 'This window stopped working and its document view was lost.',
        detail:
          'Reload to start this window again. PageDown offers to recover a saved document ' +
          'from its most recent autosave when you reopen it.'
      })
      .then(({ response }) => {
        if (win.isDestroyed()) return
        if (response === 0) win.reload()
        // destroy(), not close(): the close guard would try to ask a renderer
        // that has already proven it cannot answer.
        else win.destroy()
      })
      .catch((err) => {
        console.error('Failed to prompt after a renderer crash', err)
      })
  })

  // Both the thumbnail generator's and the page-count generator's
  // pagination harnesses now live on their own dedicated, never-shown
  // BaseWindows (see thumbnail-generator.ts's getHarness/
  // destroyThumbnailHarness and page-count-generator.ts's own equivalent
  // for why: a shown-but-off-canvas WebContentsView gets Chromium's
  // rendering-throttle treatment, which starved Paged.js's rAF-driven
  // layout loop and made large documents time out) -- process-wide, shared
  // across every document window, not owned by any one of them. Both
  // windows are real to Electron's window-tracking, though — if either is
  // never destroyed, BaseWindow.getAllWindows() never returns to zero
  // after the user closes every real document window, so
  // `window-all-closed` below would silently never fire on Windows/Linux
  // and the app would keep running invisibly forever. Torn down here only
  // once `documentWindows` becomes empty (Multi-window support) -- NOT on
  // every individual window's own close, which would tear down a harness a
  // still-open SECOND window might be actively using. Each destroy call is
  // a harmless no-op if its harness was never created this session, or is
  // already gone.
  win.on('closed', () => {
    documentWindows.delete(win)
    if (documentWindows.size === 0) {
      destroyThumbnailHarness()
      destroyPageCountHarness()
    }
  })

  win.webContents.setWindowOpenHandler((details) => {
    try {
      const url = new URL(details.url)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        shell.openExternal(details.url)
      }
    } catch {
      // Malformed URL — deny without opening anything.
    }
    return { action: 'deny' }
  })

  // Every window gets its own real context menu (Multi-window support) --
  // previously only ever attached to the single, first-created mainWindow,
  // so a second window would have had NO Cut/Copy/Paste/spelling-suggestion
  // menu at all.
  attachContextMenu(win)

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for
  // production. `openPath`, when given, rides along as a `?openPath=...`
  // query param -- see this function's own doc comment above for why this
  // grants no new disk access.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const devUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    if (openPath) devUrl.searchParams.set('openPath', openPath)
    win.loadURL(devUrl.toString())
  } else {
    win.loadFile(
      join(__dirname, '../renderer/index.html'),
      openPath ? { search: `openPath=${encodeURIComponent(openPath)}` } : undefined
    )
  }

  return win
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // The instance that failed to acquire the single-instance lock already
  // called app.quit() at module scope (see that check's own comment above)
  // -- but app.quit() is a REQUEST, not synchronous termination, so this
  // promise still resolves in that doomed process before it actually exits.
  // Returning here (before creating any window, registering any IPC
  // handler, or touching any file) is what stops it from doing any of that
  // pointless work in the brief window before the process really dies.
  if (!gotSingleInstanceLock) return

  // Set app user model id for windows -- must match electron-builder.yml's
  // own `appId` (com.pagedown.app), or Windows taskbar grouping/toast
  // attribution silently splits from the installed app's real identity.
  electronApp.setAppUserModelId('com.pagedown.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Recording a recent file is a nicety, not part of the open/save contract:
  // addRecentFile can genuinely throw (disk full, permissions, removed userData
  // dir), and letting that reject the handler would report an already-completed
  // read/write to the renderer as a failure — leaving the Document Store with a
  // stale filePath and isDirty still set after a successful save.
  ipcMain.handle('file:open', async () => {
    const result = await openFileDialog(app.getPath('userData'))
    if (result) {
      try {
        await addRecentFile(app.getPath('userData'), result.filePath)
        // The File > Open Recent submenu is built from this same allowlist,
        // so every write to it has to rebuild the menu or that submenu goes
        // stale until the next focus change. Fire-and-forget for the same
        // reason the addRecentFile call it follows is best-effort: a menu
        // that is one entry behind must never fail an already-completed
        // file open.
        void refreshApplicationMenu()
      } catch (err) {
        console.error('Failed to record recent file', err)
      }
    }
    return result
  })

  ipcMain.handle('file:openPath', async (_event, filePath: string) => {
    const userDataDir = app.getPath('userData')
    if (!(await isKnownPath(userDataDir, filePath))) {
      throw new Error('Requested path is not a known recent file')
    }
    const result = await readFileByPath(filePath, userDataDir)
    try {
      await addRecentFile(userDataDir, result.filePath)
      // See file:open above for why every recents write refreshes the menu.
      void refreshApplicationMenu()
    } catch (err) {
      console.error('Failed to record recent file', err)
    }
    return result
  })

  ipcMain.handle(
    'file:save',
    async (event, filePath: string | null, content: string, expectedMtimeMs: number | null) => {
      const userDataDir = app.getPath('userData')
      // `mainWindow` is declared further down in this same app.whenReady()
      // closure -- safe to reference here (this callback only ever RUNS on a
      // real IPC call, well after createWindow() has returned) but read
      // CLAUDE.md's own note on this exact pattern (see the preferences:set
      // handler below) before assuming it's an oversight in a future edit.
      const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
      const result = await saveFileToKnownOrChosenPath(
        win,
        userDataDir,
        filePath,
        content,
        expectedMtimeMs
      )
      if (result) {
        try {
          await addRecentFile(userDataDir, result.filePath)
          // See file:open above for why every recents write refreshes the
          // menu. Save-As in particular is a genuinely new recents entry.
          void refreshApplicationMenu()
        } catch (err) {
          console.error('Failed to record recent file', err)
        }
      }
      return result
    }
  )

  ipcMain.handle('file:getRecents', () => getRecentFiles(app.getPath('userData')))

  // Product-completeness audit 0.6: "a dead recents row cannot be removed."
  // Both handlers only ever NARROW the isKnownPath allowlist (recent-files.ts's
  // removeRecentFile/clearRecentFiles can only drop entries, never add one --
  // see their own comments) -- removing a path only revokes this app's own
  // willingness to write there again via the fast (non-Save-As) path; it can
  // never grant access to a new one. Both refresh the application menu's own
  // File > Open Recent submenu for the same reason file:open/file:save
  // already do (that submenu is built from this exact list) -- fire-and-
  // forget, since a menu that's one entry behind must never block or fail an
  // already-completed removal.
  ipcMain.handle('file:removeRecent', async (_event, filePath: string) => {
    const userDataDir = app.getPath('userData')
    const updated = await removeRecentFile(userDataDir, filePath)
    void refreshApplicationMenu()
    return updated
  })

  ipcMain.handle('file:clearRecents', async () => {
    const userDataDir = app.getPath('userData')
    await clearRecentFiles(userDataDir)
    void refreshApplicationMenu()
  })

  // filePath is renderer-supplied (documentStore's own active-tab mirror) --
  // saveDroppedImage re-validates it via isKnownPath itself (same rule as
  // every other renderer-supplied path this app touches), so an unknown or
  // unsaved-document path is refused with a real error rather than trusted.
  ipcMain.handle(
    'file:saveDroppedImage',
    (_event, filePath: string | null, base64Data: string, suggestedFilename: string) =>
      saveDroppedImage(app.getPath('userData'), filePath, base64Data, suggestedFilename)
  )

  ipcMain.handle('preferences:get', () => readPreferences(app.getPath('userData')))

  // Each window's renderer reports its own screen/view-mode/filename/dirty
  // state here (App.tsx's own effect). `ipcMain.on`, not `handle` -- there is
  // no result to await, and this fires on ordinary state changes, matching
  // split-preview:setBounds's own precedent. The payload is re-validated
  // inside applyWindowUiState (coerceWindowUiState) rather than trusted:
  // `fileName` reaches a real `win.setTitle()` call. A message from an
  // already-closed window resolves to no window and is dropped.
  ipcMain.on(WINDOW_STATE_CHANNEL, (event, state: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) applyWindowUiState(win, state)
  })

  // The renderer's answer to the close guard's question (see the block above
  // `documentWindows`). Keyed on `event.sender`, so a renderer can only ever
  // answer for its OWN window -- it never names a window, and cannot approve
  // anyone else's close. A reply for a window with no pending question (a
  // duplicate send, or one that arrives after the requester already gave up on
  // a dead renderer) finds no responder and is dropped.
  ipcMain.on(WINDOW_CLOSE_RESPONSE_CHANNEL, (event, allow: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    closeResponders.get(win)?.(allow === true)
  })

  // See src/main/config-warnings.ts. Drains rather than reads, so a corrupt
  // preferences/recent-files file is surfaced exactly once per app run.
  ipcMain.handle('app:getStartupWarnings', () => drainConfigWarnings())

  // package.json's own `version` field -- app.getVersion() reads it directly
  // in development and from the packaged app's metadata once built, so this
  // is always the real shipped version, never a hand-maintained duplicate.
  // Surfaced in the renderer purely for display (SettingsScreen's footer);
  // nothing in this app branches on it.
  ipcMain.handle('app:getVersion', () => app.getVersion())

  // File associations / "Open With" (product-completeness audit 2.5): does
  // THIS launch itself name a document to open? macOS answers via whatever
  // `open-file` queued before this promise resolved (that listener's own
  // comment explains why an early event can't be handled immediately);
  // Windows/Linux never emit `open-file` for a plain launch and instead
  // pass the path as a real `process.argv` entry (electron-builder's
  // `fileAssociations` is what makes the OS launch
  // `pagedown.exe "C:\path\to\file.md"` in the first place). Each candidate
  // is validated (existence + shape) via the SAME function `open-file`/
  // `second-instance` already use, so a launch naming a stale or malformed
  // path degrades to a plain Home-screen launch rather than a startup error.
  const launchOpenPaths: string[] = []
  for (const candidate of pendingOpenFilePaths) {
    const validated = await resolveOsOpenedMarkdownPath(candidate)
    if (validated) launchOpenPaths.push(validated)
  }
  pendingOpenFilePaths.length = 0
  // openFileQueueDrained flips AFTER draining the queue above, not before --
  // an `open-file` arriving in the narrow window while this very `await`
  // chain is still running is a genuinely NEW request (e.g. the user
  // double-clicks a second file while PageDown is still finishing startup),
  // correctly handled as "just-arrived", not re-processed as part of this
  // cold launch's own batch.
  openFileQueueDrained = true
  if (launchOpenPaths.length === 0 && process.platform !== 'darwin') {
    const argvCandidate = extractMarkdownPathFromArgv(process.argv)
    if (argvCandidate) {
      const validated = await resolveOsOpenedMarkdownPath(argvCandidate)
      if (validated) launchOpenPaths.push(validated)
    }
  }
  for (const validated of launchOpenPaths) {
    try {
      await addRecentFile(app.getPath('userData'), validated)
    } catch (err) {
      console.error('Failed to record an OS-opened file as recent', err)
    }
  }

  // Window state persistence (App identity/packaging cleanup pass): restore
  // the last saved size/position for the FIRST window this launch creates
  // only -- see createWindow's own doc comment for why every other
  // createWindow() call site deliberately does not repeat this read.
  // resolveInitialWindowBounds drops the saved x/y (falling back to
  // Electron's own default centering) if it no longer overlaps any
  // currently-connected display, e.g. after an external monitor the window
  // was last positioned on gets disconnected -- there is no OS-universal
  // affordance to drag a fully off-screen window back.
  const savedWindowBounds = await readWindowState(app.getPath('userData'))
  const initialWindowBounds = resolveInitialWindowBounds(
    savedWindowBounds,
    screen.getAllDisplays().map((display) => display.workArea)
  )
  const mainWindow = createWindow(launchOpenPaths[0], initialWindowBounds)
  // Any ADDITIONAL queued document (macOS's own multi-file "Open With", or a
  // pathological case of more than one launch-open source resolving at
  // once) gets its own separate window, same as "Open in New Window"
  // already does for one path at a time -- these deliberately do NOT
  // receive `initialWindowBounds` (that saved size/position is a single
  // "restore the last real window" value, meaningful only for the one
  // window that stands in for the app's own last session).
  for (const extra of launchOpenPaths.slice(1)) {
    createWindow(extra)
  }

  // The real application menu. Before this, the app ran on ELECTRON'S OWN
  // default menu (Electron installs one when an app sets none) -- which is
  // why Cmd+Q/Cmd+W/Cmd+Z already worked while nothing app-specific did:
  // there was no Save, no Open, no Export, no view switching, and no way to
  // discover any of it. Installed after createWindow so the first build can
  // already see a window, though the menu is global to the app and does not
  // depend on one existing.
  initApplicationMenu({
    userDataDir: app.getPath('userData'),
    isDev: is.dev,
    dispatch: dispatchMenuCommand
  })

  // Applies the spellcheck half of a preferences change LIVE, on the same
  // session document-editing windows already use, not just on the next app
  // launch -- session.setSpellCheckerEnabled is a real runtime toggle (does
  // NOT require recreating the BrowserWindow the way changing
  // `webPreferences.spellcheck` at construction time would). Registered
  // after `mainWindow` exists (not before, alongside `preferences:get`
  // above) purely for readability -- the closure below only ever RUNS once
  // a real IPC call arrives, well after this window is constructed, so
  // ordering relative to `createWindow()` has no correctness effect, but
  // referencing a `const` before its own declaration line reads as a bug
  // even when it safely isn't one.
  ipcMain.handle('preferences:set', async (_event, preferences: Preferences) => {
    await writePreferences(app.getPath('userData'), preferences)
    mainWindow.webContents.session.setSpellCheckerEnabled(preferences.spellcheckEnabled)
  })

  // Applies the PERSISTED spellcheck preference from the moment this window
  // exists, not just after the user next opens Settings -- Electron
  // defaults spellcheck to enabled, so without this, a user who previously
  // disabled it would see it silently re-enabled every fresh launch.
  readPreferences(app.getPath('userData')).then((preferences) => {
    mainWindow.webContents.session.setSpellCheckerEnabled(preferences.spellcheckEnabled)
  })

  // Context menu attachment moved into createWindow() itself (Multi-window
  // support) -- every window gets its own now, not just this first one.
  // See attachContextMenu's own comment for the full spelling-suggestion
  // rationale, unchanged from before this move.

  // Split mode's own harness (getOrCreateSplitPreviewHarness, below) is
  // deliberately still tied to THIS specific window only -- its
  // WebContentsView is a child of mainWindow's own contentView (Split
  // mode's architecture, unchanged by Multi-window support: see this
  // file's own split-preview section for why generalizing it to a
  // per-window harness map is real, separate, disclosed future work, not
  // built here). So its teardown stays keyed to mainWindow's own close,
  // not to `documentWindows` becoming empty -- a still-open SECOND window
  // doesn't keep this harness alive (it was never that window's harness to
  // use), and mainWindow closing orphans it regardless of what else is
  // open (its parent contentView is gone either way).
  mainWindow.on('closed', () => {
    void destroySplitPreviewHarness()
  })

  // "Open in New Window" (Multi-window support) -- a genuinely new,
  // independent BrowserWindow with its own separate renderer process and
  // Zustand store state (Electron gives every window a fresh renderer by
  // construction; no explicit "reset state" step is needed). `filePath`
  // is renderer-supplied and forwarded WITHOUT its own isKnownPath check
  // here -- see createWindow's own doc comment for why that's safe: the
  // new window's own App.tsx independently re-validates it through the
  // exact same file:openPath handler and isKnownPath check a user
  // clicking a recent-file row already goes through. `null`/omitted opens
  // a plain new window at Home, same as the app's own first launch.
  ipcMain.handle('window:openInNew', (_event, filePath: string | null) => {
    createWindow(filePath ?? undefined)
  })

  ipcMain.handle('file:getThumbnail', async (_event, filePath: string) => {
    const userDataDir = app.getPath('userData')
    if (!(await isKnownPath(userDataDir, filePath))) {
      throw new Error('Requested path is not a known recent file')
    }
    const { content } = await readFileByPath(filePath, userDataDir)
    // `filePath` is forwarded ONLY because the isKnownPath check above has
    // already vetted it -- getThumbnail uses it purely to resolve the
    // document's local asset references against its own directory (see
    // thumbnail-generator.ts). Note the deliberate asymmetry with
    // `file:getPageCount` below, which DROPS an unknown path instead of
    // throwing: this handler cannot proceed at all without a valid path (it
    // has to read the file to have any content to render), whereas page
    // counting has the content in hand and only ever wanted the path for
    // assets.
    return getThumbnail(content, userDataDir, filePath)
  })

  ipcMain.handle('template:getThumbnail', async (_event, content: string) => {
    // No document path, deliberately: a template is in-memory content with no
    // on-disk location, so it has no directory to resolve local assets
    // against and must load none. Passing nothing is what enforces that --
    // see getThumbnail's own doc comment.
    return getThumbnail(content, app.getPath('userData'))
  })

  // Status bar's real page-count display (EditorStatusBar.tsx / the
  // usePageCount hook). Takes raw content directly. Uses its own dedicated
  // harness/queue/window (`page-count-generator.ts`), deliberately not
  // sharing `getThumbnail`'s harness or `mainWindow` itself -- see that
  // file's own module comment for why it owns a private, never-shown
  // BaseWindow instead of attaching to the real app window the way every
  // other harness here does.
  //
  // `filePath` is a renderer-supplied path, so CLAUDE.md's File I/O security
  // invariant binds: it MUST be validated with `isKnownPath` before anything
  // resolves disk paths beneath it. This is not a formality -- registering a
  // directory as an asset root grants the sandboxed render context the
  // ability to read any file under it, so an unvetted path here would be a
  // genuine arbitrary-file-read primitive, exactly the class of bug that
  // invariant was added for.
  //
  // An unknown path is DROPPED, not thrown on -- deliberately asymmetric with
  // `file:getThumbnail` above, which does throw. That handler cannot proceed
  // at all without a valid path (it has to read the file to have any content
  // to render); page counting already has the content in hand and only ever
  // wanted the path to resolve local assets. Throwing here would turn a
  // missing or stale allowlist entry into a broken status bar, whereas
  // dropping degrades exactly one document to "local assets denied" -- the
  // same, already-correct treatment an unsaved document gets.
  ipcMain.handle(
    'file:getPageCount',
    async (_event, content: string, filePath: string | null = null, allowRemoteImages = false) => {
      const userDataDir = app.getPath('userData')
      const documentPath =
        filePath && (await isKnownPath(userDataDir, filePath)) ? filePath : undefined
      return getPageCount(content, documentPath, allowRemoteImages)
    }
  )

  // Split mode IPC surface (Task 3 of the Split mode plan). All three share
  // the single, lazily-created harness held in this module's scope (see
  // getOrCreateSplitPreviewHarness above) -- created by whichever of
  // setBounds/sendDocument fires first, torn down by destroy.
  //
  // split-preview:setBounds is `ipcMain.on`/`ipcRenderer.send`, not
  // `invoke`/`handle` -- it fires on every ResizeObserver tick from the
  // renderer's preview pane, there is no result the caller needs to await,
  // and routing a high-frequency resize tick through a round-trip Promise
  // would be pure overhead. Converts the reported CSS-pixel rectangle to
  // WebContentsView.setBounds's own Rectangle units via toViewBounds (Task 1,
  // renamed from toPhysicalBounds in the final whole-branch review -- it was
  // never converting to physical pixels at all, see that file's own comment),
  // using mainWindow.webContents.getZoomFactor() as the scale factor.
  //
  // WHY getZoomFactor() ALONE, WITH NO devicePixelRatio MULTIPLY: this was
  // flagged going in as UNVERIFIED (the plan's own formula multiplied by
  // devicePixelRatio) and was resolved empirically for this task, not just
  // inferred -- see task-3-report.md for the full evidence. Short version:
  // Electron's Rectangle-typed geometry APIs (screen, BrowserWindow,
  // View/WebContentsView) operate in DIP ("device independent pixels"), the
  // same unit as a renderer's own getBoundingClientRect() -- confirmed both
  // by Electron's own screen-module docs (which explicitly distinguish DIP
  // points from "physical screen points" and provide screenToDipPoint/
  // dipToScreenPoint converters) and, decisively, by direct measurement on
  // this development machine's Retina display (devicePixelRatio 2): setting
  // a WebContentsView's bounds to {width:500,height:400} and then capturing
  // that view's own real painted content via webContents.capturePage()
  // produced a PNG at EXACTLY 1000x800 pixels -- proof Chromium already
  // scales DIP bounds up to the display's real physical pixels internally,
  // the same way it does for an ordinary BrowserWindow. Multiplying by
  // devicePixelRatio here would double-apply that scaling and render the
  // preview at roughly 2x the intended size, badly misplaced next to the
  // editor pane. getZoomFactor() (rather than a hardcoded 1) accounts for
  // ELECTRON'S OWN webContents zoom level (Ctrl/Cmd+=, or a future
  // webContents.setZoomFactor() call) -- a genuine, separate axis from the
  // DIP question above. Nothing in this codebase calls setZoomFactor()
  // today (verified: zero occurrences), so in practice this returns 1.0
  // right now and the DIP-only conversion above is the only thing actually
  // being exercised. IMPORTANT, and easy to get backwards: this does NOT
  // account for EditorScreen's own CSS `zoom` state (Format-mode canvas's
  // `transform: scale(zoom)`, src/renderer/src/screens/EditorScreen.tsx) --
  // that's a renderer-local React useState driving a CSS transform, has
  // nothing to do with Electron's webContents zoom, and getZoomFactor()
  // cannot see it. If a future Split mode pane needs the preview to track
  // THAT CSS zoom, the adjustment belongs in the RENDERER's reported bounds
  // (Task 4), not here -- this handler only converts whatever CSS-pixel
  // rectangle it's given using Electron's own current zoom state.
  ipcMain.on(
    'split-preview:setBounds',
    (_event, cssBounds: { x: number; y: number; width: number; height: number }) => {
      void getOrCreateSplitPreviewHarness(mainWindow)
        .then((harness) => {
          const scaleFactor = mainWindow.webContents.getZoomFactor()
          harness.setBounds(cssBounds, scaleFactor)
        })
        .catch((err) => {
          console.error('Failed to apply split preview bounds', err)
        })
    }
  )

  // split-preview:sendDocument, unlike setBounds, needs a real return value
  // (the PaginationResult driving the preview pane's page-count/diagram/
  // image overlay state), so it's ipcMain.handle/ipcRenderer.invoke.
  // `filePath` is renderer-supplied, so CLAUDE.md's File I/O security
  // invariant binds -- validated with isKnownPath exactly like
  // file:getPageCount above, and on an unknown path this handler DROPS it
  // and proceeds with local assets denied rather than throwing, matching
  // file:getPageCount's own established rationale verbatim: the preview
  // never strictly needs the path (only local-asset resolution does), and
  // throwing here would regress a working preview pane the moment a file
  // ages out of the 10-entry recents allowlist. Queued through
  // enqueueSplitPreviewWork -- see that function's own comment above for why
  // every call into the shared sandboxed render context must serialize
  // itself.
  ipcMain.handle(
    'split-preview:sendDocument',
    async (
      _event,
      content: string,
      filePath: string | null,
      allowRemoteImages: boolean = false
    ) => {
      const userDataDir = app.getPath('userData')
      const validatedPath = filePath && (await isKnownPath(userDataDir, filePath)) ? filePath : null
      return enqueueSplitPreviewWork(async () => {
        const harness = await getOrCreateSplitPreviewHarness(mainWindow)
        return harness.sendDocument(content, validatedPath, allowRemoteImages)
      })
    }
  )

  // Called by the renderer when viewMode leaves 'split' (Task 5), so a user
  // who never revisits Split mode doesn't keep a second WebContentsView (and
  // its own sandboxed renderer process) alive for the rest of the session.
  // Delegates to destroySplitPreviewHarness (defined above, alongside the
  // rest of this module's split-preview state) -- shared with mainWindow's
  // own 'closed' handler, see that function's own comment for why both need
  // it and how the module-scope reference is cleared before the queued
  // destroy() actually runs.
  ipcMain.handle('split-preview:destroy', () => destroySplitPreviewHarness())

  // Page navigation (docs/superpowers/specs/2026-08-08-page-navigation-design.md).
  //
  // Both are deliberately NON-CREATING: unlike setBounds/sendDocument they must
  // never call getOrCreateSplitPreviewHarness. Asking "what page is showing"
  // must not spin up a sandboxed renderer process -- the renderer polls
  // getSplitPreviewPage on a timer while Split mode is open, and a creating
  // handler would resurrect a harness that Split mode had just torn down.
  //
  // No isKnownPath check applies: neither accepts a path, and the only
  // renderer-supplied value is an integer the sandbox clamps. Neither rejects
  // -- page navigation is a convenience and must never break editing.
  ipcMain.handle('split-preview:scrollToPage', async (_event, pageIndex: number) => {
    if (!splitPreviewHarnessPromise) return { currentPage: 1, pageCount: 0 }
    return enqueueSplitPreviewWork(async () => {
      const harnessPromise = splitPreviewHarnessPromise
      if (!harnessPromise) return { currentPage: 1, pageCount: 0 }
      try {
        const harness = await harnessPromise
        return await harness.scrollToPage(pageIndex)
      } catch (err) {
        console.error('Failed to scroll split preview', err)
        return { currentPage: 1, pageCount: 0 }
      }
    })
  })

  ipcMain.handle('split-preview:getPage', async () => {
    if (!splitPreviewHarnessPromise) return { currentPage: 1, pageCount: 0 }
    return enqueueSplitPreviewWork(async () => {
      const harnessPromise = splitPreviewHarnessPromise
      if (!harnessPromise) return { currentPage: 1, pageCount: 0 }
      try {
        const harness = await harnessPromise
        return await harness.getPage()
      } catch (err) {
        console.error('Failed to read split preview page', err)
        return { currentPage: 1, pageCount: 0 }
      }
    })
  })

  // Version-history IPC surface (Task 2 of the autosave/crash-recovery/
  // version-history plan). All four validate `filePath` via isKnownPath --
  // same File I/O security invariant as file:openPath/file:save/
  // file:getPageCount above -- and all four drop-not-throw on an unknown
  // path, matching file:getPageCount's own established rationale: none of
  // these operations strictly requires success for the app to keep working
  // correctly, so a dropped autosave tick or an empty history list just
  // means slightly less protection, not a broken app.
  //
  // Each body is ALSO wrapped in its own try/catch, and -- per fix round 1
  // review -- the isKnownPath check lives INSIDE that try, not before it:
  // isKnownPath is unreachable-by-throw today (readRecentFiles swallows
  // every read error internally), but that's an implementation detail of
  // the current allowlist storage, not a contract this handler should rely
  // on. Keeping the check inside the same try the rest of the body is in
  // means a future isKnownPath that legitimately can throw (e.g. one that
  // adds a stat/realpath call) stays covered by the exact same
  // drop-not-throw guarantee as everything after it, rather than silently
  // becoming the one uncovered statement in a handler whose surrounding
  // comment claims full coverage.
  //
  // Per this plan's global "snapshot writes are best-effort and must never
  // block, delay, or fail a real Save" invariant, a rejected
  // writeSnapshot/clearPendingAutosave call must never surface as a failed
  // IPC promise -- the renderer calls these fire-and-forget (`void ...`),
  // so an unhandled rejection here would either produce a spurious console
  // error unrelated to anything the user did, or (worse) get attributed to
  // an otherwise-successful Save. Logged and swallowed instead, matching
  // addRecentFile's own failure handling above.
  //
  // `filePath` is canonicalized via canonicalizeDocumentPath (fs.realpath)
  // before being passed into version-history.ts -- see that function's own
  // comment in file-io.ts for why this must happen consistently across
  // every entry point that touches version-history storage.
  ipcMain.handle('file:autosaveSnapshot', async (_event, content: string, filePath: string) => {
    const userDataDir = app.getPath('userData')
    try {
      if (!(await isKnownPath(userDataDir, filePath))) return
      const canonicalPath = await canonicalizeDocumentPath(filePath)
      await writeSnapshot(userDataDir, canonicalPath, content)
    } catch (err) {
      console.error('Failed to write autosave snapshot', err)
    }
  })

  ipcMain.handle('file:getVersionHistory', async (_event, filePath: string) => {
    const userDataDir = app.getPath('userData')
    try {
      if (!(await isKnownPath(userDataDir, filePath))) return []
      const canonicalPath = await canonicalizeDocumentPath(filePath)
      return await listSnapshots(userDataDir, canonicalPath)
    } catch (err) {
      console.error('Failed to list version history', err)
      return []
    }
  })

  ipcMain.handle(
    'file:restoreVersionContent',
    async (_event, filePath: string, snapshotId: string) => {
      const userDataDir = app.getPath('userData')
      try {
        if (!(await isKnownPath(userDataDir, filePath))) return null
        const canonicalPath = await canonicalizeDocumentPath(filePath)
        return await readSnapshotContent(userDataDir, canonicalPath, snapshotId)
      } catch (err) {
        console.error('Failed to restore version content', err)
        return null
      }
    }
  )

  // No renderer-supplied cutoff -- CRITICAL FIX (found in review): this
  // handler used to accept `sinceIso` from the renderer, with
  // EditorScreen's "Don't Save" path passing `new Date().toISOString()`
  // (the moment of the click). version-history.ts's clearPendingAutosave
  // deletes only entries whose `timestamp > sinceIso` -- but every
  // snapshot that already exists was written in the PAST relative to
  // "now," so that comparison was false for all of them and NOTHING was
  // ever deleted. The pending snapshot then survived, was more than
  // MTIME_TOLERANCE_MS newer than the file's untouched on-disk mtime, and
  // got silently "recovered" on the very next open -- a direct violation
  // of this feature's own core promise (a deliberately discarded edit
  // must never reappear). The design spec's own wording is "deletes every
  // snapshot newer than ... the file's own on-disk mtime" -- so the
  // cutoff is computed from the validated path's real `stat()` result, not
  // accepted as a parameter. Delegated to version-history.ts's
  // `clearPendingAutosaveForFile` (not done inline here) so this
  // previously-buggy logic is directly unit-testable under plain Vitest --
  // this handler itself stays a thin, Electron-touching wrapper, same
  // pattern as isKnownPath/canonicalizeDocumentPath above.
  ipcMain.handle('file:clearPendingAutosave', async (_event, filePath: string) => {
    const userDataDir = app.getPath('userData')
    try {
      if (!(await isKnownPath(userDataDir, filePath))) return
      const canonicalPath = await canonicalizeDocumentPath(filePath)
      await clearPendingAutosaveForFile(userDataDir, canonicalPath, filePath)
    } catch (err) {
      console.error('Failed to clear pending autosave snapshots', err)
    }
  })

  // event.sender-derived, not the captured mainWindow (Multi-window
  // support) -- this dialog must anchor as a native sheet to whichever
  // window actually asked, not always the first one. Falls back to
  // mainWindow only in the unreachable case BrowserWindow.fromWebContents
  // finds nothing (a request from an already-destroyed window), so this
  // never throws where the old unconditional mainWindow reference never
  // could either.
  // `documentName` is display-only dialog text (which document is this about),
  // never a path -- see confirmDiscardChanges in file-io.ts, which coerces and
  // length-caps it. No isKnownPath rule applies: nothing here touches disk.
  ipcMain.handle('dialog:confirmDiscard', (event, documentName?: unknown) =>
    confirmDiscardChanges(
      BrowserWindow.fromWebContents(event.sender) ?? mainWindow,
      typeof documentName === 'string' ? documentName : undefined
    )
  )

  // Real Export PDF plumbing (see src/main/pdf-exporter.ts): no isKnownPath
  // check needed for the SAVE DESTINATION, unlike file:save/file:openPath --
  // that path comes from a real dialog.showSaveDialog() result inside
  // exportDocumentToPdf, not from a renderer-supplied path, so it's already
  // vetted the same way a Save-As dialog's chosen path is (see CLAUDE.md's
  // File I/O security invariant section). `filePath` (the SOURCE document,
  // used only to resolve local image references for the export) IS a
  // renderer-supplied path and IS validated here -- same drop-not-throw
  // treatment as file:getPageCount just above: an export never strictly
  // needs the source path, so an unknown/stale one just means local images
  // in the exported PDF resolve to nothing rather than a failed export.
  ipcMain.handle(
    'file:exportPdf',
    async (event, content: string, filePath: string | null = null, allowRemoteImages = false) => {
      const userDataDir = app.getPath('userData')
      const documentPath =
        filePath && (await isKnownPath(userDataDir, filePath)) ? filePath : undefined
      // event.sender-derived, not the captured mainWindow (Multi-window
      // support) -- same reasoning as dialog:confirmDiscard just above: the
      // real Save dialog exportDocumentToPdf opens must anchor to whichever
      // window actually asked for the export.
      const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
      const result = await exportDocumentToPdf(win, content, documentPath, allowRemoteImages)
      // Only a genuinely successful, real write is ever revealable -- a
      // cancelled Save dialog resolves `null` and adds nothing here.
      if (result) rememberRevealablePath(result.filePath)
      return result
    }
  )

  // Product-completeness audit 2.3 (HTML export). Identical shape and
  // reasoning to file:exportPdf immediately above -- see html-exporter.ts's
  // own module comment for what this format deliberately does and does not
  // render (typography-parity flowing HTML; Mermaid/math stay inert
  // placeholders), and for why it needs no enqueueExport-style queue (it
  // never touches the shared pagination harness at all).
  ipcMain.handle(
    'file:exportHtml',
    async (event, content: string, filePath: string | null = null, allowRemoteImages = false) => {
      const userDataDir = app.getPath('userData')
      const documentPath =
        filePath && (await isKnownPath(userDataDir, filePath)) ? filePath : undefined
      const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
      const result = await exportDocumentToHtml(win, content, documentPath, allowRemoteImages)
      if (result) rememberRevealablePath(result.filePath)
      return result
    }
  )

  // "Show in folder" for a just-exported PDF/HTML file (product-completeness
  // audit 2.3). Deliberately does NOT treat `filePath` as a general
  // renderer-supplied path the way file:getPageCount/file:exportPdf's own
  // SOURCE path does -- there is no meaningful "known document" allowlist
  // concept for an export's own OUTPUT path (isKnownPath's allowlist is
  // .md-open-history, not export history), so this checks membership in
  // `revealableExportPaths` instead -- see that Set's own module-scope
  // comment for the full "why this isn't an arbitrary-path reveal
  // primitive" reasoning. Resolves `false` (never throws, never rejects)
  // for anything not in that set, matching this codebase's established
  // "a courtesy action degrades quietly, never as a user-visible error"
  // posture (autosave snapshots, menu refreshes, etc.).
  ipcMain.handle('shell:showItemInFolder', (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || !revealableExportPaths.has(filePath)) return false
    shell.showItemInFolder(filePath)
    return true
  })

  // Real native print plumbing (see src/main/print-exporter.ts). Same
  // renderer-supplied-source-path treatment as file:exportPdf just above --
  // drop-not-throw on an unknown path, since printing never strictly needs
  // it either (only local image references would resolve to nothing).
  ipcMain.handle(
    'file:print',
    async (_event, content: string, filePath: string | null = null, allowRemoteImages = false) => {
      const userDataDir = app.getPath('userData')
      const documentPath =
        filePath && (await isKnownPath(userDataDir, filePath)) ? filePath : undefined
      return printDocument(content, documentPath, allowRemoteImages)
    }
  )

  // Phase 0 spike wiring: prove the sandboxed pagination render harness
  // (Gate 5, see src/main/pagination-window.ts) constructs successfully
  // under real app startup, not just under the Playwright test's
  // app.evaluate(). Positioned off-window so it doesn't cover the app's
  // own UI — this is not part of the harness's real interface, just how
  // this spike attaches it for a visible-if-you-go-looking smoke check.
  // Real integration into app UI is out of scope for Task 3.
  //
  // Gated behind `is.dev` for the same reason as the __pagedownPhase0
  // bridge above: every phase0/phase1 gate spec launches the unpackaged
  // `out/` build, where `is.dev` is `true` (`!app.isPackaged`), so no gate's
  // behavior changes. A real packaged install (`is.dev === false`) no
  // longer spins up this extra, permanently-off-screen sandboxed renderer
  // process on every launch for a smoke check nothing in the shipped app
  // consumes. `gate15`/`gate18`'s own `probeSplitPreviewView`/
  // `probePageScroll` helpers document this view's existence in a comment,
  // but disambiguate the real split-preview view from it purely via an
  // on-screen-bounds filter (`bounds.x >= 0 && bounds.y >= 0`), which stays
  // correct whether or not this off-screen view exists at all — confirmed
  // by reading every assertion in both files: none counts
  // `pagedown-render://` views, each only filters for one matching an
  // on-screen rectangle.
  if (is.dev) {
    createPaginationHarness(mainWindow)
      .then((harness) => {
        harness.view.setBounds({ x: -9999, y: -9999, width: PAGE_WIDTH_PX, height: PAGE_HEIGHT_PX })
        console.log('[phase0] pagination render harness ready:', harness.view.webContents.getURL())
      })
      .catch((err) => {
        console.error('[phase0] failed to create pagination render harness', err)
      })
  }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
