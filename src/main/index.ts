import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerPaginationScheme } from './pagination-scheme'
import { createPaginationHarness, sendGate7Phase1, sendGate7Phase2 } from './pagination-window'
import { paginateAndTime } from '../pagination/paginate'

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
declare global {
  var __pagedownPhase0:
    | {
        createPaginationHarness: typeof createPaginationHarness
        paginateAndTime: typeof paginateAndTime
        sendGate7Phase1: typeof sendGate7Phase1
        sendGate7Phase2: typeof sendGate7Phase2
      }
    | undefined
}
globalThis.__pagedownPhase0 = {
  createPaginationHarness,
  paginateAndTime,
  sendGate7Phase1,
  sendGate7Phase2
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

  const mainWindow = createWindow()

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
