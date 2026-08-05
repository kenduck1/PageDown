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
import { exportDocumentToPdf } from './pdf-exporter'
import {
  openFileDialog,
  readFileByPath,
  saveFileToKnownOrChosenPath,
  getRecentFiles,
  addRecentFile,
  isKnownPath,
  confirmDiscardChanges
} from './file-io'

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
    const result = await openFileDialog()
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
    const result = await readFileByPath(filePath)
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
    const { content } = await readFileByPath(filePath)
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

  ipcMain.handle('dialog:confirmDiscard', () => confirmDiscardChanges(mainWindow))

  // Real Export PDF plumbing (see src/main/pdf-exporter.ts): no isKnownPath
  // check needed here, unlike file:save/file:openPath -- the destination
  // path comes from a real dialog.showSaveDialog() result inside
  // exportDocumentToPdf, not from a renderer-supplied path, so it's already
  // vetted the same way a Save-As dialog's chosen path is (see CLAUDE.md's
  // File I/O security invariant section).
  ipcMain.handle('file:exportPdf', (_event, content: string) =>
    exportDocumentToPdf(mainWindow, content)
  )

  // Phase 0 spike wiring: prove the sandboxed pagination render harness
  // (Gate 5, see src/main/pagination-window.ts) constructs successfully
  // under real app startup, not just under the Playwright test's
  // app.evaluate(). Positioned off-window so it doesn't cover the app's
  // own UI — this is not part of the harness's real interface, just how
  // this spike attaches it for a visible-if-you-go-looking smoke check.
  // Real integration into app UI is out of scope for Task 3.
  createPaginationHarness(mainWindow)
    .then((harness) => {
      harness.view.setBounds({ x: -9999, y: -9999, width: 816, height: 1056 })
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
