import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
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
import { printDocument } from './print-exporter'
import {
  openFileDialog,
  readFileByPath,
  saveFileToKnownOrChosenPath,
  getRecentFiles,
  addRecentFile,
  isKnownPath,
  confirmDiscardChanges,
  canonicalizeDocumentPath
} from './file-io'
import {
  writeSnapshot,
  listSnapshots,
  readSnapshotContent,
  clearPendingAutosaveForFile
} from './version-history'
import { PAGE_WIDTH_PX, PAGE_HEIGHT_PX } from '../typography/page-geometry'

// Must run before app.whenReady() is awaited anywhere — Electron requires
// protocol.registerSchemesAsPrivileged() to be called before the `ready`
// event fires (see pagination-scheme.ts for why this scheme needs to be
// privileged at all).
registerPaginationScheme()

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
globalThis.__pagedownPhase0 = {
  createPaginationHarness,
  paginateAndTime,
  sendGate7Phase1,
  sendGate7Phase2,
  exportToPdf,
  sendGate4HeaderFooterProbe,
  getThumbnail
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

function createWindow(): BrowserWindow {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Both the thumbnail generator's and the page-count generator's
  // pagination harnesses now live on their own dedicated, never-shown
  // BaseWindows (see thumbnail-generator.ts's getHarness/
  // destroyThumbnailHarness and page-count-generator.ts's own equivalent
  // for why: a shown-but-off-canvas WebContentsView gets Chromium's
  // rendering-throttle treatment, which starved Paged.js's rAF-driven
  // layout loop and made large documents time out). Both windows are real
  // to Electron's window-tracking, though — if either is never destroyed,
  // BaseWindow.getAllWindows() never returns to zero after the user closes
  // this real window, so `window-all-closed` below would silently never
  // fire on Windows/Linux and the app would keep running invisibly
  // forever. Destroying both here, on this window's own 'closed' event, is
  // what lets the window count actually reach zero so `window-all-closed`
  // fires normally afterward. Each is a harmless no-op if its harness was
  // never created this session, or is already gone.
  mainWindow.on('closed', () => {
    destroyThumbnailHarness()
    destroyPageCountHarness()
    // Fire-and-forget, same rationale as every other best-effort teardown in
    // this codebase (see destroySplitPreviewHarness's own comment above) --
    // there's no one left to report a failure to by this point, and the
    // function already logs internally.
    void destroySplitPreviewHarness()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
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

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

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
    } catch (err) {
      console.error('Failed to record recent file', err)
    }
    return result
  })

  ipcMain.handle('file:save', async (_event, filePath: string | null, content: string) => {
    const userDataDir = app.getPath('userData')
    const result = await saveFileToKnownOrChosenPath(userDataDir, filePath, content)
    if (result) {
      try {
        await addRecentFile(userDataDir, result.filePath)
      } catch (err) {
        console.error('Failed to record recent file', err)
      }
    }
    return result
  })

  ipcMain.handle('file:getRecents', () => getRecentFiles(app.getPath('userData')))

  const mainWindow = createWindow()

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
    async (_event, content: string, filePath: string | null = null) => {
      const userDataDir = app.getPath('userData')
      const documentPath =
        filePath && (await isKnownPath(userDataDir, filePath)) ? filePath : undefined
      return getPageCount(content, documentPath)
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
    async (_event, content: string, filePath: string | null) => {
      const userDataDir = app.getPath('userData')
      const validatedPath = filePath && (await isKnownPath(userDataDir, filePath)) ? filePath : null
      return enqueueSplitPreviewWork(async () => {
        const harness = await getOrCreateSplitPreviewHarness(mainWindow)
        return harness.sendDocument(content, validatedPath)
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

  ipcMain.handle('dialog:confirmDiscard', () => confirmDiscardChanges(mainWindow))

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
    async (_event, content: string, filePath: string | null = null) => {
      const userDataDir = app.getPath('userData')
      const documentPath =
        filePath && (await isKnownPath(userDataDir, filePath)) ? filePath : undefined
      return exportDocumentToPdf(mainWindow, content, documentPath)
    }
  )

  // Real native print plumbing (see src/main/print-exporter.ts). Same
  // renderer-supplied-source-path treatment as file:exportPdf just above --
  // drop-not-throw on an unknown path, since printing never strictly needs
  // it either (only local image references would resolve to nothing).
  ipcMain.handle('file:print', async (_event, content: string, filePath: string | null = null) => {
    const userDataDir = app.getPath('userData')
    const documentPath =
      filePath && (await isKnownPath(userDataDir, filePath)) ? filePath : undefined
    return printDocument(content, documentPath)
  })

  // Phase 0 spike wiring: prove the sandboxed pagination render harness
  // (Gate 5, see src/main/pagination-window.ts) constructs successfully
  // under real app startup, not just under the Playwright test's
  // app.evaluate(). Positioned off-window so it doesn't cover the app's
  // own UI — this is not part of the harness's real interface, just how
  // this spike attaches it for a visible-if-you-go-looking smoke check.
  // Real integration into app UI is out of scope for Task 3.
  createPaginationHarness(mainWindow)
    .then((harness) => {
      harness.view.setBounds({ x: -9999, y: -9999, width: PAGE_WIDTH_PX, height: PAGE_HEIGHT_PX })
      console.log('[phase0] pagination render harness ready:', harness.view.webContents.getURL())
    })
    .catch((err) => {
      console.error('[phase0] failed to create pagination render harness', err)
    })

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
