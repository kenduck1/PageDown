import { basename } from 'node:path'
import type { MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '../menu/commands'
import type { WindowUiState } from '../menu/window-state'

// The application menu's TEMPLATE, as a pure function of (platform, dev-ness,
// the focused window's reported UI state, the recent-files list). Kept in its
// own module, with `electron` imported for TYPES ONLY, so the whole thing is
// directly unit-testable under plain Vitest with no `vi.mock('electron')` and
// no running Electron process -- the same split, and the same reasoning, as
// recent-files.ts (Electron-free, directly testable) versus file-io.ts
// (imports `dialog`). src/main/app-menu.ts is the thin Electron-touching half
// that feeds this and calls Menu.buildFromTemplate/setApplicationMenu.
//
// ROLES ARE USED WHEREVER ONE EXISTS, and that is not merely idiomatic: a
// role gets the platform's own correct label, accelerator, enablement and
// behaviour for free (Cut/Copy/Paste know about the focused input's
// selection; Minimize/Zoom/Front are macOS window-server operations; Quit is
// "Quit PageDown" on macOS and "Exit" on Windows). Hand-rolling any of them
// means reimplementing platform behaviour badly.
//
// TWO PLACES DELIBERATELY DO NOT USE A ROLE, both because the role would do
// the WRONG thing for this app:
//
//  - View > Zoom In/Out/Actual Size are custom commands, NOT Electron's
//    `zoomIn`/`zoomOut`/`resetZoom` roles. Those roles change Chromium's own
//    webContents zoom factor, which scales the entire app shell (toolbar,
//    sidebar, status bar) -- while this app's zoom control is a
//    `transform: scale()` on the page canvas alone, which is what "zoom" means
//    in a document editor. Worse, webContents zoom is exactly the factor
//    src/main/index.ts's split-preview:setBounds handler multiplies its
//    reported CSS rectangle by, so the two would compound.
//
//  - There is no Find role at all in Electron; Find/Find Next/Find Previous
//    are commands routed into the renderer's own findStore.
//
// ACCELERATOR COLLISIONS WITH THE EDITOR WERE CHECKED AGAINST SOURCE, NOT
// ASSUMED. Every accelerator below was checked against ShortcutsHelpModal.tsx's
// own verified list of what the Milkdown presets and this app's own `window`
// keydown listeners already bind. The reason that check matters: a menu
// accelerator is at minimum a competitor for the keystroke, and Electron
// documents an accelerator as being handled by its menu item.
//
//  - `Cmd/Ctrl+E` was REJECTED for Export as PDF (the obvious choice, and
//    what this sub-project's brief suggested) because @milkdown/preset-commonmark
//    binds Mod-e to inline code. `Cmd/Ctrl+Shift+E` is used instead. This is
//    the one collision where losing the race would be silently destructive
//    (inline code stops working, with no error anywhere), so it is avoided by
//    construction rather than reasoned about.
//  - `Cmd/Ctrl+F` (Find) and `Cmd/Ctrl+/` (Keyboard Shortcuts) DO compete
//    with the two bare `window` keydown listeners that were this app's only
//    shortcuts before the menu existed (useFindShortcuts.ts, EditorScreen.tsx).
//    Which side wins was deliberately NOT measured, and deliberately made not
//    to matter: both routes call the SAME function (openFindFromShortcut;
//    closeSlashMenu + openShortcutsHelp), and running either twice is
//    idempotent. See useFindShortcuts.ts's own header for the full argument.
//
// Undo/Redo/Cut/Copy/Paste keep their roles and their standard accelerators,
// and that IS measured rather than reasoned about. Electron already installs
// a default menu carrying those same role accelerators when an app sets none
// -- the state this app shipped in until now -- and phase0/gate20 has been
// passing real Mod-Z/Mod-Shift-Z ProseMirror undo/redo against it the whole
// time, and still passes with this menu installed. So a role accelerator on
// an editing command demonstrably does not rob the page of the keystroke
// (they are Chromium editing commands, which a page may preventDefault).
// Gate 20 is the regression check if that ever changes.

export interface AppMenuTemplateParams {
  // Shown as the first (application) menu's label on macOS. See
  // window-title.ts's APP_NAME for why this is a constant rather than
  // app.getName().
  appName: string
  // Passed in rather than read from `process.platform` directly so the
  // template for every platform is unit-testable from one test run.
  platform: NodeJS.Platform
  // Gates Reload / Force Reload / Toggle DevTools. Shipping a "Toggle
  // DevTools" item in a production document editor invites a user into a
  // surface with no product meaning.
  isDev: boolean
  // The FOCUSED window's own reported state -- see window-state.ts.
  state: WindowUiState
  // Absolute paths, most-recent-first, exactly as recent-files.json holds
  // them (already capped at 10 entries there).
  recentFiles: string[]
  // Delivers a command to the focused window. Injected rather than imported
  // so this module stays free of BrowserWindow/webContents entirely.
  send: (command: MenuCommand, payload?: string) => void
}

export function buildAppMenuTemplate(params: AppMenuTemplateParams): MenuItemConstructorOptions[] {
  const { appName, platform, isDev, state, recentFiles, send } = params
  const isMac = platform === 'darwin'
  // Every File/View item that acts on the document currently on screen. The
  // enablement question this answers is deliberately coarse -- "is the editor
  // screen showing a document at all" -- rather than per-item ("is this
  // document dirty", "does it have a path"): Save on a clean document is a
  // real, harmless no-op that users expect to stay clickable, and greying
  // items out on a state that flips with every keystroke makes a menu feel
  // broken. What it DOES prevent is the genuinely meaningless case: Save /
  // Export / Print / mode-switching / zoom while the user is on the Home or
  // Settings screen, where there is no editor mounted to act on and (for
  // Save) the only "document" is documentStore's always-present blank tab.
  const { documentOpen } = state

  const clickCommand = (command: MenuCommand) => (): void => send(command)

  // A single disabled placeholder when there is nothing to list, rather than
  // an empty submenu: an empty submenu renders as a live-looking menu that
  // opens onto nothing, which reads as a bug.
  const recentSubmenu: MenuItemConstructorOptions[] =
    recentFiles.length === 0
      ? [{ label: 'No Recent Documents', enabled: false }]
      : recentFiles.map((filePath) => ({
          // Basename only, matching macOS's own Open Recent convention (and
          // this app's Home-screen recent rows, which also show the
          // basename). Two same-named files in different directories
          // therefore produce two identical labels -- a real, accepted
          // limitation of the convention, not an oversight.
          label: basename(filePath),
          click: () => send('file:openRecent', filePath)
        }))

  // Plain labels, no `&Foo` Windows-mnemonic ampersands: Chromium strips them
  // into underlined access keys on Windows/Linux but macOS renders them
  // literally, and Electron's own documented example template uses plain
  // labels for exactly that reason.
  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      { label: 'New', accelerator: 'CmdOrCtrl+N', click: clickCommand('file:new') },
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: clickCommand('file:open') },
      { label: 'Open Recent', submenu: recentSubmenu },
      { type: 'separator' },
      {
        label: 'Save',
        accelerator: 'CmdOrCtrl+S',
        enabled: documentOpen,
        click: clickCommand('file:save')
      },
      {
        label: 'Save As…',
        accelerator: 'CmdOrCtrl+Shift+S',
        enabled: documentOpen,
        click: clickCommand('file:saveAs')
      },
      { type: 'separator' },
      {
        label: 'Export as PDF…',
        // NOT Cmd+E -- see this module's own header on the inline-code
        // collision that ruled it out.
        accelerator: 'CmdOrCtrl+Shift+E',
        enabled: documentOpen,
        click: clickCommand('file:exportPdf')
      },
      {
        label: 'Print…',
        accelerator: 'CmdOrCtrl+P',
        enabled: documentOpen,
        click: clickCommand('file:print')
      },
      { type: 'separator' },
      // Non-macOS convention puts Preferences under File (macOS puts it in
      // the application menu, built below) and ends File with Quit/Exit.
      ...(isMac
        ? []
        : ([
            {
              label: 'Preferences…',
              accelerator: 'CmdOrCtrl+,',
              click: clickCommand('app:preferences')
            },
            { type: 'separator' }
          ] as MenuItemConstructorOptions[])),
      // "Close Window" lives here, and NOT also in the Window menu, on
      // purpose: macOS's own HIG puts Close in File (Window carries
      // Minimize/Zoom/Bring All to Front), and listing the same Cmd+W
      // accelerator on two items would register it twice with only one of
      // them able to fire.
      { role: 'close', label: 'Close Window' },
      ...(isMac ? [] : ([{ role: 'quit' }] as MenuItemConstructorOptions[]))
    ]
  }

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'selectAll' },
      { type: 'separator' },
      {
        label: 'Find…',
        accelerator: 'CmdOrCtrl+F',
        enabled: documentOpen,
        click: clickCommand('edit:find')
      },
      {
        label: 'Find Next',
        accelerator: 'CmdOrCtrl+G',
        enabled: documentOpen,
        click: clickCommand('edit:findNext')
      },
      {
        label: 'Find Previous',
        accelerator: 'CmdOrCtrl+Shift+G',
        enabled: documentOpen,
        click: clickCommand('edit:findPrevious')
      }
    ]
  }

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      // `radio` rather than three plain items: these are three states of one
      // setting, and the checkmark is the only place in the menu that
      // reports which mode the window is actually in. `checked` comes from
      // the focused window's own reported viewMode, so the menu follows the
      // toolbar's segmented control (and vice versa) rather than tracking
      // its own idea of the mode.
      {
        label: 'Format',
        type: 'radio',
        checked: state.viewMode === 'format',
        accelerator: 'CmdOrCtrl+1',
        enabled: documentOpen,
        click: clickCommand('view:format')
      },
      {
        label: 'Split',
        type: 'radio',
        checked: state.viewMode === 'split',
        accelerator: 'CmdOrCtrl+2',
        enabled: documentOpen,
        click: clickCommand('view:split')
      },
      {
        label: 'Source',
        type: 'radio',
        checked: state.viewMode === 'source',
        accelerator: 'CmdOrCtrl+3',
        enabled: documentOpen,
        click: clickCommand('view:source')
      },
      { type: 'separator' },
      {
        label: 'Zoom In',
        accelerator: 'CmdOrCtrl+Plus',
        enabled: documentOpen,
        click: clickCommand('view:zoomIn')
      },
      {
        label: 'Zoom Out',
        accelerator: 'CmdOrCtrl+-',
        enabled: documentOpen,
        click: clickCommand('view:zoomOut')
      },
      {
        label: 'Actual Size',
        accelerator: 'CmdOrCtrl+0',
        enabled: documentOpen,
        click: clickCommand('view:zoomReset')
      },
      { type: 'separator' },
      {
        label: 'Toggle Sidebar',
        accelerator: 'CmdOrCtrl+\\',
        enabled: documentOpen,
        click: clickCommand('view:toggleSidebar')
      },
      ...(isDev
        ? ([
            { type: 'separator' },
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' }
          ] as MenuItemConstructorOptions[])
        : [])
    ]
  }

  // Deliberately NOT `role: 'windowMenu'`, even though that role exists and
  // names exactly this menu. `windowMenu` is a role that SUPPLIES ITS OWN
  // submenu, and Electron's own documentation states that on macOS an item
  // carrying a role has every option other than `label`/`accelerator`
  // ignored -- so pairing it with the item list below risks silently
  // discarding that list on the one platform where this menu matters most.
  // Not verified against Electron's internal source (it is compiled into the
  // binary, not readable from node_modules), so this takes the unambiguous
  // route: Electron's own documented example template builds the Window menu
  // as a plain label plus per-item roles, which is what this follows.
  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      // `zoom` and `front` are macOS-only roles (the window-server "zoom"
      // green-button behaviour, and "Bring All to Front"). Including them on
      // Windows/Linux would render dead items.
      ...(isMac
        ? ([
            { role: 'zoom' },
            { type: 'separator' },
            { role: 'front' }
          ] as MenuItemConstructorOptions[])
        : ([{ role: 'close' }] as MenuItemConstructorOptions[]))
    ]
  }

  // `role: 'help'` WITH a custom submenu is safe where `role: 'windowMenu'`
  // was not: `help` is a marker role (it tells macOS which menu to attach its
  // own Help search field to) rather than one that supplies its own submenu,
  // and Electron's documented example template uses exactly this pairing.
  const helpMenu: MenuItemConstructorOptions = {
    label: 'Help',
    role: 'help',
    submenu: [
      {
        label: 'Keyboard Shortcuts',
        accelerator: 'CmdOrCtrl+/',
        // Gated on documentOpen for a concrete reason rather than by
        // analogy with the File items: ShortcutsHelpModal is rendered by
        // EditorScreen and by nothing else, so `app:shortcuts` genuinely has
        // no handler anywhere while the user is on Home or Settings. An
        // enabled item that silently does nothing is worse than a greyed one.
        // (Making it work everywhere means hoisting the modal to App.tsx --
        // a real, separate change, since EditorScreen would have to stop
        // rendering it or two would appear at once.)
        enabled: documentOpen,
        click: clickCommand('app:shortcuts')
      },
      // macOS already carries About in the application menu below.
      ...(isMac ? [] : ([{ type: 'separator' }, { role: 'about' }] as MenuItemConstructorOptions[]))
    ]
  }

  const appMenu: MenuItemConstructorOptions = {
    label: appName,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      // Not `role: 'appMenu'` wholesale: that role's stock submenu has no
      // Preferences item at all, and Preferences is this app's only route to
      // the Settings screen from the keyboard.
      { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: clickCommand('app:preferences') },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  }

  return [...(isMac ? [appMenu] : []), fileMenu, editMenu, viewMenu, windowMenu, helpMenu]
}
