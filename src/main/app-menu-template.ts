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
//  - `Cmd/Ctrl+F` (Find), `Find and Replace…`'s own accelerator, and
//    `Cmd/Ctrl+/` (Keyboard Shortcuts) DO compete with the bare `window`
//    keydown listeners that were this app's only shortcuts before the menu
//    existed (useFindShortcuts.ts, EditorScreen.tsx). Which side wins was
//    deliberately NOT measured, and deliberately made not to matter: both
//    routes call the SAME function (openFindFromShortcut; closeSlashMenu +
//    openShortcutsHelp), and running either twice is idempotent. See
//    useFindShortcuts.ts's own header for the full argument.
//  - `Find and Replace…`'s accelerator is the one PLATFORM-CONDITIONAL value
//    in this whole template: `Cmd+Alt+F` on macOS (TextEdit/Pages/Xcode
//    convention), `Ctrl+H` on Windows/Linux (Word/VS Code/Notepad++/Sublime/
//    Chrome DevTools convention -- nobody's muscle memory is `Ctrl+Alt+F`,
//    which is what a naive `CmdOrCtrl+Alt+F` would have produced). `Cmd+H` is
//    never used on macOS at any point -- that is the OS's own system-reserved
//    Hide Application shortcut, and Electron's accelerator system would
//    intercept it the same as any other, silently breaking Hide. Checked
//    against the installed `prosemirror-commands` package directly (the
//    library @milkdown/prose re-exports, though this project never actually
//    wires its `baseKeymap` into the editor): its own `macBaseKeymap` binds
//    `Ctrl-h` to backspace, but that binding is (a) mac-only within that
//    library and (b) never reachable here regardless, since this app's
//    Ctrl+H is non-mac-only by construction -- so there is no real collision
//    with Milkdown/ProseMirror on either platform.
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
  // The one per-mode exception to the coarse rule above -- see the View menu's
  // zoom items for the full reasoning.
  const zoomApplies = documentOpen && state.viewMode !== 'split'
  // The Split-only items are the mirror image of the zoom exception: they are
  // the only two things in this menu that mean nothing OUTSIDE Split mode.
  // Both used to be toolbar pills that simply were not RENDERED outside Split
  // (EditorToolbar gated them on `viewMode === 'split'`, and Follow
  // additionally on `splitLeftMode === 'format'`); a menu item cannot come and
  // go the same way without the menu visibly reflowing, so the equivalent is
  // to keep them present and disabled.
  const splitApplies = documentOpen && state.viewMode === 'split'
  // Follow's own arithmetic (useSplitFollowScroll.ts, via page-nav.ts's
  // estimatePageFromScrollOffset) is keyed to the Milkdown page card's
  // content-box height, which has no counterpart in a plain <textarea> -- so
  // it is genuinely inapplicable when the left pane is Source, exactly as the
  // toolbar pill's own render gate already encoded.
  const followApplies = splitApplies && state.splitLeftMode === 'format'

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
        // Same base key as Export as PDF, different modifier, because the two
        // are the same operation in two formats and a mnemonic that survives
        // is worth more than an unrelated free letter. Alt+E is genuinely
        // free: the Mod+Alt bindings the editor already claims are 0-8, C, X
        // (headings/code block/strikethrough) and F (Find and Replace, macOS)
        // -- checked against ShortcutsHelpModal.tsx's own verified list, which
        // is itself read out of the installed presets.
        label: 'Export as HTML…',
        accelerator: 'CmdOrCtrl+Alt+E',
        enabled: documentOpen,
        click: clickCommand('file:exportHtml')
      },
      {
        // Third on the same base key, for the same "these are one operation in
        // three formats" reason the HTML item above documents. Alt+Shift+E is
        // free: the Mod+Alt bindings the editor claims are 0-8, C, X and
        // (macOS) F, none of which add Shift, and Mod+Shift+E/Mod+Alt+E are
        // the two items directly above -- checked against
        // ShortcutsHelpModal.tsx's own verified list and pinned by this
        // module's own "never reuses one accelerator" test.
        //
        // Labelled "Word" rather than ".docx" because the recipient this
        // export exists for ("send me the Word file") asks for it by that
        // name, and the ellipsis is real -- a Save dialog follows.
        label: 'Export as Word…',
        accelerator: 'CmdOrCtrl+Alt+Shift+E',
        enabled: documentOpen,
        click: clickCommand('file:exportDocx')
      },
      {
        label: 'Print…',
        accelerator: 'CmdOrCtrl+P',
        enabled: documentOpen,
        click: clickCommand('file:print')
      },
      {
        // Cmd+Shift+P is the platform's own long-standing Page Setup
        // accelerator, and it is free here. This item did not exist while
        // Page Setup was reachable ONLY from a toolbar icon; it matters more
        // now, because Page Setup is also where the document's font family
        // and body size moved to (see PageSetupModal.tsx's Typography
        // section), so it is no longer a rarely-touched dialog.
        label: 'Page Setup…',
        accelerator: 'CmdOrCtrl+Shift+P',
        enabled: documentOpen,
        click: clickCommand('file:pageSetup')
      },
      { type: 'separator' },
      // Second-pass product-completeness audit: "There is no Close Tab; Cmd+W
      // closes the whole window." Every other tabbed editor closes the TAB on
      // Cmd+W and the WINDOW on Cmd+Shift+W -- this app shipped only the
      // latter, at the FORMER's accelerator, which is the wrong reflex to
      // punish in an app with an always-visible tab bar (one stray Cmd+W
      // used to take out every open tab at once). `documentOpen`, the same
      // coarse gate every other document-scoped item here uses -- there is
      // no tab bar at all on Home, so an enabled-but-silent item there would
      // violate this menu's own "disabled, never enabled-and-inert" rule.
      //
      // THE ACCELERATOR IS ALSO GATED, not just the enablement, and that is a
      // fix rather than symmetry. Gating enablement alone meant Cmd+W was
      // claimed by a disabled item on Home and Settings and therefore did
      // NOTHING AT ALL -- and because Close Tab had also displaced the
      // window-close role off its own default (below), the very first Cmd+W a
      // new user presses, on the screen the app opens to, was inert. Handing
      // the keystroke back to Close Window there follows this menu's own
      // precedent for Help > Keyboard Shortcuts: an item's gate has to be
      // judged against what the gate makes UNREACHABLE, not only against
      // whether the gate is locally consistent.
      //
      // "Close the frontmost thing" is what Cmd+W means, and what the
      // frontmost thing IS depends on the screen: a tab in the editor, the
      // window on Home. That is the same reading this app already applies one
      // level down -- documentStore.closeTab never leaves zero tabs, so Cmd+W
      // on a single-tab window clears the tab rather than closing the window,
      // matching a browser's "last tab left standing" behaviour.
      //
      // DISCLOSED COST: with no document open, Cmd+Shift+W then does nothing,
      // because Close Window is holding Cmd+W instead. One accelerator per
      // item is the whole constraint -- there is no way to give an item two.
      // Cmd+W is overwhelmingly the reflex being served, and it is the one
      // that was previously dead.
      //
      // Routes to `handleRequestCloseTab` (EditorScreen.tsx) -- the EXACT
      // function the tab bar's own "x" button already calls, not a second
      // closing path -- so a dirty active tab gets the identical
      // confirm/flush/save/clear-autosave sequence regardless of which
      // control asked. On the last remaining tab it does exactly what that
      // button already does: documentStore.closeTab never leaves zero tabs,
      // replacing a closed last tab with a fresh blank "Untitled" one rather
      // than falling back to Close Window -- so Cmd+W on a single-tab window
      // clears it instead of closing the window, matching a browser tab's
      // own "last tab left standing" behavior rather than Electron's role
      // default.
      {
        label: 'Close Tab',
        // Dropped entirely rather than left claiming a key it cannot use --
        // an accelerator on a DISABLED item still consumes the keystroke.
        accelerator: documentOpen ? 'CmdOrCtrl+W' : undefined,
        enabled: documentOpen,
        click: clickCommand('file:closeTab')
      },
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
      // Minimize/Zoom/Bring All to Front), and listing the same accelerator
      // on two items would register it twice with only one of them able to
      // fire.
      //
      // Accelerator moved to CmdOrCtrl+Shift+W (from the role's own default
      // CmdOrCtrl+W, which Close Tab above claims whenever a document is
      // open) -- an explicit `accelerator` on a role item overrides the
      // role's platform default.
      //
      // It moves BACK to CmdOrCtrl+W with no document open, so that reflex
      // keeps working on Home and Settings where there is no tab to close.
      // See Close Tab's own comment above for the full argument and for the
      // disclosed cost.
      //
      // CORRECTION. The clause that used to end this comment claimed the
      // override "is a mechanism `role: 'close'` on non-mac's Window menu
      // below already doesn't need, because it's never listed alongside a
      // competing claim on the same key". That was FALSE, and it was false
      // from the moment Close Tab was added: the Window menu really did carry
      // a bare `{ role: 'close' }` on Windows/Linux, and that role's default
      // accelerator really is `CommandOrControl+W` -- read out of the shipped
      // Electron 39.8.10 binary rather than assumed, where the roles table
      // reads `close:{label:...,accelerator:"CommandOrControl+W",...}`. So on
      // every non-macOS build, Cmd/Ctrl+W was claimed twice and one of the two
      // silently never fired. The Window menu's copy is now gone (see
      // windowMenu below), which restores the policy this comment always
      // described, and app-menu-template.test.ts's accelerator sweep was
      // extended to resolve role defaults so a bare role can never smuggle in
      // a third claim unseen.
      {
        role: 'close',
        label: 'Close Window',
        accelerator: documentOpen ? 'CmdOrCtrl+Shift+W' : 'CmdOrCtrl+W'
      },
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
        label: 'Find and Replace…',
        // NOT `CmdOrCtrl+Alt+F` -- see this module's own header for why the
        // two platforms need genuinely different literal accelerators here,
        // unlike every other item in this menu.
        accelerator: isMac ? 'Cmd+Alt+F' : 'Ctrl+H',
        enabled: documentOpen,
        click: clickCommand('edit:findReplace')
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
      // SPLIT LEFT PANE and FOLLOW PREVIEW SCROLL are this menu's only home,
      // not a duplicate of a toolbar control. Both shipped as pills in
      // EditorToolbar's right-hand cluster and were moved here by the
      // single-row-toolbar pass: together they cost 218px of toolbar width and
      // ONLY in Split mode, which is exactly the mode where the toolbar had
      // least room -- so they were what forced the toolbar onto a second row.
      // They land in View rather than anywhere else because this menu already
      // owns "how is this window showing the document" (the radio group
      // directly above, zoom below), and a radio pair plus a checkbox can
      // report their own live state, which a plain command item could not.
      //
      // NEITHER carries an accelerator, and that is a checked conclusion
      // rather than an omission: the obvious pair for a sub-choice of Cmd+1 /
      // Cmd+3 would be Cmd+Alt+1 / Cmd+Alt+3, and @milkdown/preset-commonmark
      // already binds both to Heading 1 / Heading 3 (ShortcutsHelpModal.tsx's
      // Structure section, read out of the installed preset). Inventing an
      // unrelated chord for a per-window layout preference would be worse than
      // a labelled menu item with a live checkmark.
      {
        label: 'Split Left Pane',
        submenu: [
          {
            label: 'Format',
            type: 'radio',
            checked: state.splitLeftMode === 'format',
            enabled: splitApplies,
            click: clickCommand('view:splitLeftFormat')
          },
          {
            label: 'Source',
            type: 'radio',
            checked: state.splitLeftMode === 'source',
            enabled: splitApplies,
            click: clickCommand('view:splitLeftSource')
          }
        ]
      },
      {
        label: 'Follow Preview Scroll',
        type: 'checkbox',
        checked: state.splitFollowEnabled,
        enabled: followApplies,
        click: clickCommand('view:toggleSplitFollow')
      },
      { type: 'separator' },
      // The three zoom items are the ONE place this menu's deliberately-coarse
      // "gated on documentOpen, not per-item state" rule is not enough, and
      // the exception is about capability rather than taste: zoom has no
      // effect at all in Split mode. Split's two-pane row renders outside
      // EditorScreen's zoom wrapper on purpose, because its right pane is a
      // native WebContentsView positioned from a DOM rect that a CSS scale
      // would silently desync -- so a live Zoom In there changed the status
      // bar's readout, changed nothing on screen, and then made the document
      // jump on the next switch back to Format. `viewMode` is already part of
      // WindowUiState (it drives the radio checkmarks above) and
      // menuRelevantStateChanged already rebuilds the menu when it changes, so
      // this costs no new IPC and no new state.
      {
        label: 'Zoom In',
        accelerator: 'CmdOrCtrl+Plus',
        enabled: zoomApplies,
        click: clickCommand('view:zoomIn')
      },
      {
        label: 'Zoom Out',
        accelerator: 'CmdOrCtrl+-',
        enabled: zoomApplies,
        click: clickCommand('view:zoomOut')
      },
      {
        label: 'Actual Size',
        accelerator: 'CmdOrCtrl+0',
        enabled: zoomApplies,
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
      //
      // The non-macOS branch used to be `[{ role: 'close' }]`, and that was a
      // REAL, shipped accelerator collision rather than a redundant menu
      // entry: a bare `role: 'close'` carries the role's own default
      // `CommandOrControl+W` (verified against the shipped Electron 39.8.10
      // binary, not assumed -- see the Close Window item in the File menu
      // above for the exact roles-table line), which is precisely what File >
      // Close Tab claims. Two items on one accelerator means one of them
      // silently never fires from the keyboard. Removed rather than given an
      // explicit accelerator of its own, because File already carries Close
      // Window on every platform and this menu's own stated policy is that
      // Close lives in File and NOT also here -- the non-macOS branch was
      // contradicting that policy, not extending it. Windows/Linux therefore
      // get a Window menu of just Minimize, which is more than many apps on
      // those platforms offer at all.
      ...(isMac
        ? ([
            { role: 'zoom' },
            { type: 'separator' },
            { role: 'front' }
          ] as MenuItemConstructorOptions[])
        : [])
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
        // Deliberately NOT gated on documentOpen, unlike every File and View
        // item. It used to be, for a concrete reason that has since been
        // fixed: ShortcutsHelpModal was rendered by EditorScreen and by
        // nothing else, so `app:shortcuts` genuinely had no handler while the
        // user was on Home or Settings, and an enabled item that silently
        // does nothing is worse than a greyed one. The modal is now hoisted
        // to App.tsx (which also owns a screen-agnostic Mod-/ listener and
        // registers `app:shortcuts` with useMenuCommands), so the handler
        // exists on every screen -- which matters more here than for any
        // other item, since this is the app's only in-product documentation
        // and gating it made that documentation unreachable until the user
        // was already inside a document.
        enabled: true,
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
