import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { buildAppMenuTemplate, type AppMenuTemplateParams } from './app-menu-template'
import { DEFAULT_WINDOW_UI_STATE, type WindowUiState } from '../menu/window-state'
import type { MenuCommand } from '../menu/commands'

// This whole file runs with NO vi.mock('electron') and no Electron process --
// which is the point of app-menu-template.ts existing separately from
// app-menu.ts. `MenuItemConstructorOptions` is a type-only import there and
// here, so nothing at runtime ever touches the electron package.

function build(overrides: Partial<AppMenuTemplateParams> = {}): {
  template: MenuItemConstructorOptions[]
  send: ReturnType<typeof vi.fn>
} {
  const send = vi.fn()
  const template = buildAppMenuTemplate({
    appName: 'PageDown',
    platform: 'darwin',
    isDev: false,
    state: DEFAULT_WINDOW_UI_STATE,
    recentFiles: [],
    send: send as unknown as (command: MenuCommand, payload?: string) => void,
    ...overrides
  })
  return { template, send }
}

const EDITING: WindowUiState = {
  ...DEFAULT_WINDOW_UI_STATE,
  documentOpen: true,
  fileName: 'report.md'
}

function submenuOf(
  template: MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions[] {
  const menu = template.find((item) => item.label === label)
  if (!menu) throw new Error(`No top-level menu labelled "${label}"`)
  return (menu.submenu ?? []) as MenuItemConstructorOptions[]
}

function itemIn(submenu: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const item = submenu.find((entry) => entry.label === label)
  if (!item) throw new Error(`No item labelled "${label}"`)
  return item
}

describe('buildAppMenuTemplate: structure', () => {
  it('puts the application menu first, and only on macOS', () => {
    const { template } = build({ platform: 'darwin' })
    expect(template[0].label).toBe('PageDown')
    expect(template.map((item) => item.label)).toEqual([
      'PageDown',
      'File',
      'Edit',
      'View',
      'Window',
      'Help'
    ])

    const { template: win } = build({ platform: 'win32' })
    expect(win.map((item) => item.label)).toEqual(['File', 'Edit', 'View', 'Window', 'Help'])
  })

  it('gives the macOS application menu About/Preferences/Services/Hide/Quit', () => {
    const { template } = build({ platform: 'darwin' })
    const appMenu = submenuOf(template, 'PageDown')
    const roles = appMenu.map((item) => item.role).filter(Boolean)
    expect(roles).toEqual(['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit'])
    expect(itemIn(appMenu, 'Preferences…').accelerator).toBe('CmdOrCtrl+,')
  })

  it('moves Preferences and Quit into File on non-macOS', () => {
    // The platform convention: Windows/Linux have no application menu, so
    // both would be unreachable if they only lived there.
    const fileMenu = submenuOf(build({ platform: 'win32' }).template, 'File')
    expect(itemIn(fileMenu, 'Preferences…').accelerator).toBe('CmdOrCtrl+,')
    expect(fileMenu.some((item) => item.role === 'quit')).toBe(true)

    const macFile = submenuOf(build({ platform: 'darwin' }).template, 'File')
    expect(macFile.some((item) => item.label === 'Preferences…')).toBe(false)
    expect(macFile.some((item) => item.role === 'quit')).toBe(false)
  })

  it('uses real Electron roles for every standard edit command', () => {
    // Regression guard for the "do not hand-roll Cut/Copy/Paste/Undo/Redo"
    // rule: a hand-rolled Copy would not know about the focused input's
    // selection, and a hand-rolled Undo would fight ProseMirror's history.
    const editMenu = submenuOf(build().template, 'Edit')
    expect(editMenu.map((item) => item.role).filter(Boolean)).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'selectAll'
    ])
  })

  it('uses window roles rather than custom clicks for Minimize/Zoom/Front', () => {
    const macWindow = submenuOf(build({ platform: 'darwin' }).template, 'Window')
    expect(macWindow.map((item) => item.role).filter(Boolean)).toEqual([
      'minimize',
      'zoom',
      'front'
    ])
    // `zoom`/`front` are macOS-only roles and would render dead items
    // elsewhere.
    const linuxWindow = submenuOf(build({ platform: 'linux' }).template, 'Window')
    expect(linuxWindow.map((item) => item.role).filter(Boolean)).toEqual(['minimize', 'close'])
  })

  it('shows Close Window in File and NOT also in the Window menu', () => {
    // Both would register the same accelerator, with only one able to
    // fire -- and File is where macOS's own HIG puts Close.
    const template = build({ platform: 'darwin' }).template
    expect(submenuOf(template, 'File').some((item) => item.role === 'close')).toBe(true)
    expect(submenuOf(template, 'Window').some((item) => item.role === 'close')).toBe(false)
  })

  // Second-pass product-completeness audit: "There is no Close Tab; Cmd+W
  // closes the whole window." Close Tab now claims the conventional Cmd+W
  // slot, which forced Close Window off its role default -- see
  // app-menu-template.ts's own comment on both items for the full reasoning.
  it('adds Close Tab to File (CmdOrCtrl+W) and moves Close Window to CmdOrCtrl+Shift+W', () => {
    const fileMenu = submenuOf(build({ platform: 'darwin', state: EDITING }).template, 'File')
    expect(itemIn(fileMenu, 'Close Tab').accelerator).toBe('CmdOrCtrl+W')
    expect(itemIn(fileMenu, 'Close Window').accelerator).toBe('CmdOrCtrl+Shift+W')
    // role: 'close' has its own platform-default accelerator (CmdOrCtrl+W)
    // that an explicit `accelerator` overrides -- asserting the role itself
    // is still there guards against the override having silently replaced
    // the whole item instead of just its accelerator.
    expect(itemIn(fileMenu, 'Close Window').role).toBe('close')
  })

  it('disables Close Tab with no document open, and enables it once one is', () => {
    const closedFile = submenuOf(build({ state: DEFAULT_WINDOW_UI_STATE }).template, 'File')
    expect(itemIn(closedFile, 'Close Tab').enabled).toBe(false)
    const openFile = submenuOf(build({ state: EDITING }).template, 'File')
    expect(itemIn(openFile, 'Close Tab').enabled).toBe(true)
  })

  it('hides Reload/DevTools outside development', () => {
    const prod = submenuOf(build({ isDev: false }).template, 'View')
    expect(prod.some((item) => item.role === 'toggleDevTools')).toBe(false)
    const dev = submenuOf(build({ isDev: true }).template, 'View')
    expect(dev.map((item) => item.role).filter(Boolean)).toEqual([
      'reload',
      'forceReload',
      'toggleDevTools'
    ])
  })

  it('puts About in Help only on non-macOS', () => {
    expect(
      submenuOf(build({ platform: 'darwin' }).template, 'Help').some((i) => i.role === 'about')
    ).toBe(false)
    expect(
      submenuOf(build({ platform: 'win32' }).template, 'Help').some((i) => i.role === 'about')
    ).toBe(true)
  })
})

describe('buildAppMenuTemplate: accelerators', () => {
  it('binds the core file accelerators', () => {
    const fileMenu = submenuOf(build({ state: EDITING }).template, 'File')
    expect(itemIn(fileMenu, 'New').accelerator).toBe('CmdOrCtrl+N')
    expect(itemIn(fileMenu, 'Open…').accelerator).toBe('CmdOrCtrl+O')
    expect(itemIn(fileMenu, 'Save').accelerator).toBe('CmdOrCtrl+S')
    expect(itemIn(fileMenu, 'Save As…').accelerator).toBe('CmdOrCtrl+Shift+S')
    expect(itemIn(fileMenu, 'Print…').accelerator).toBe('CmdOrCtrl+P')
    // Added by the single-row-toolbar pass, because these two are now the
    // ONLY way to reach HTML export and Page Setup from the keyboard: their
    // toolbar buttons went to make the toolbar fit on one line, and the rule
    // for removing a toolbar control at all is that it keeps a real home.
    // Alt+E pairs with Export as PDF's own Shift+E on the same base key;
    // Shift+P is the platform's long-standing Page Setup accelerator. Both
    // are additionally protected by the "never reuses one accelerator" test
    // below.
    expect(itemIn(fileMenu, 'Export as HTML…').accelerator).toBe('CmdOrCtrl+Alt+E')
    expect(itemIn(fileMenu, 'Page Setup…').accelerator).toBe('CmdOrCtrl+Shift+P')
  })

  it('does NOT bind Cmd+E to Export as PDF', () => {
    // Load-bearing, not stylistic: @milkdown/preset-commonmark binds Mod-e to
    // inline code, and a menu accelerator on a non-role item consumes the
    // keystroke before the page ever sees it -- so Cmd+E here would silently
    // break inline code in the editor. This is the single most likely
    // "improvement" a future editor would make to this file.
    const fileMenu = submenuOf(build({ state: EDITING }).template, 'File')
    const exportItem = itemIn(fileMenu, 'Export as PDF…')
    expect(exportItem.accelerator).toBe('CmdOrCtrl+Shift+E')
    expect(exportItem.accelerator).not.toBe('CmdOrCtrl+E')
  })

  it('binds Find/Find and Replace/Find Next/Find Previous', () => {
    const editMenu = submenuOf(build({ state: EDITING }).template, 'Edit')
    expect(itemIn(editMenu, 'Find…').accelerator).toBe('CmdOrCtrl+F')
    expect(itemIn(editMenu, 'Find and Replace…').accelerator).toBe('Cmd+Alt+F')
    expect(itemIn(editMenu, 'Find Next').accelerator).toBe('CmdOrCtrl+G')
    expect(itemIn(editMenu, 'Find Previous').accelerator).toBe('CmdOrCtrl+Shift+G')
  })

  it('binds Find and Replace to Ctrl+H on Windows/Linux, NOT Cmd+H or Ctrl+Alt+F', () => {
    // The regression this guards: Cmd+H is macOS's own system-reserved Hide
    // Application shortcut, so a naive `CmdOrCtrl+…` form applied to a
    // literal H accelerator would be correct on Windows/Linux but would
    // hijack Hide on macOS the moment this test's own darwin case (above)
    // used the same accelerator string. The two platforms must produce
    // GENUINELY DIFFERENT literal strings, not one shared form -- asserted
    // here on win32/linux and above on darwin, rather than trusting the
    // ternary that produces them.
    for (const platform of ['win32', 'linux'] as const) {
      const editMenu = submenuOf(build({ state: EDITING, platform }).template, 'Edit')
      const item = itemIn(editMenu, 'Find and Replace…')
      expect(item.accelerator).toBe('Ctrl+H')
      expect(item.accelerator).not.toBe('Cmd+H')
      expect(item.accelerator).not.toBe('CmdOrCtrl+Alt+F')
    }
  })

  it('binds view-mode, zoom and sidebar accelerators', () => {
    const viewMenu = submenuOf(build({ state: EDITING }).template, 'View')
    expect(itemIn(viewMenu, 'Format').accelerator).toBe('CmdOrCtrl+1')
    expect(itemIn(viewMenu, 'Split').accelerator).toBe('CmdOrCtrl+2')
    expect(itemIn(viewMenu, 'Source').accelerator).toBe('CmdOrCtrl+3')
    expect(itemIn(viewMenu, 'Zoom In').accelerator).toBe('CmdOrCtrl+Plus')
    expect(itemIn(viewMenu, 'Zoom Out').accelerator).toBe('CmdOrCtrl+-')
    expect(itemIn(viewMenu, 'Actual Size').accelerator).toBe('CmdOrCtrl+0')
    expect(itemIn(viewMenu, 'Toggle Sidebar').accelerator).toBe('CmdOrCtrl+\\')
  })

  it('never reuses one accelerator on two different items', () => {
    // Two items sharing an accelerator means one of them silently never
    // fires from the keyboard. Checked across the WHOLE menu, including
    // role-supplied items, since role accelerators are platform defaults this
    // file does not see.
    const template = build({ platform: 'darwin', state: EDITING, isDev: true }).template
    const accelerators: string[] = []
    const walk = (items: MenuItemConstructorOptions[]): void => {
      for (const item of items) {
        if (item.accelerator) accelerators.push(item.accelerator)
        if (Array.isArray(item.submenu)) walk(item.submenu as MenuItemConstructorOptions[])
      }
    }
    walk(template)
    expect(new Set(accelerators).size).toBe(accelerators.length)
  })
})

describe('buildAppMenuTemplate: enablement', () => {
  it('disables every document-scoped item with no document open', () => {
    const template = build({ state: DEFAULT_WINDOW_UI_STATE }).template
    const fileMenu = submenuOf(template, 'File')
    for (const label of ['Save', 'Save As…', 'Export as PDF…', 'Print…']) {
      expect(itemIn(fileMenu, label).enabled).toBe(false)
    }
    const editMenu = submenuOf(template, 'Edit')
    for (const label of ['Find…', 'Find and Replace…', 'Find Next', 'Find Previous']) {
      expect(itemIn(editMenu, label).enabled).toBe(false)
    }
    const viewMenu = submenuOf(template, 'View')
    for (const label of ['Format', 'Split', 'Source', 'Zoom In', 'Actual Size', 'Toggle Sidebar']) {
      expect(itemIn(viewMenu, label).enabled).toBe(false)
    }
  })

  it('enables them once a document is open', () => {
    const template = build({ state: EDITING }).template
    expect(itemIn(submenuOf(template, 'File'), 'Save').enabled).toBe(true)
    expect(itemIn(submenuOf(template, 'Edit'), 'Find…').enabled).toBe(true)
    expect(itemIn(submenuOf(template, 'View'), 'Split').enabled).toBe(true)
  })

  it('leaves New/Open/Open Recent/Preferences always available', () => {
    // These are the ways INTO a document (and out to Settings), so gating
    // them on already having one would be circular. `undefined` here means
    // "Electron's default", i.e. enabled -- asserted as not-false rather than
    // as true so the test does not demand a redundant `enabled: true`.
    const template = build({ state: DEFAULT_WINDOW_UI_STATE, platform: 'darwin' }).template
    const fileMenu = submenuOf(template, 'File')
    expect(itemIn(fileMenu, 'New').enabled).not.toBe(false)
    expect(itemIn(fileMenu, 'Open…').enabled).not.toBe(false)
    expect(itemIn(fileMenu, 'Open Recent').enabled).not.toBe(false)
    expect(itemIn(submenuOf(template, 'PageDown'), 'Preferences…').enabled).not.toBe(false)
  })

  it('leaves Keyboard Shortcuts enabled on EVERY screen, unlike the File and View items', () => {
    // This deliberately inverts what it used to assert. The item was
    // originally gated on documentOpen for a real reason -- ShortcutsHelpModal
    // was rendered by EditorScreen alone, so `app:shortcuts` reached no
    // handler at all on Home or Settings, and enabled-but-silent is worse
    // than greyed. That reason is gone: the modal is now hoisted to App.tsx,
    // which owns a screen-agnostic Mod-/ listener and registers the command
    // with useMenuCommands, so a handler exists everywhere.
    //
    // Keeping it enabled matters more here than for any other item: this is
    // the app's only in-product documentation, and gating it made that
    // documentation unreachable until the user was already inside a document
    // -- precisely when they least need to look up how to open one.
    const closed = build({ state: DEFAULT_WINDOW_UI_STATE }).template
    expect(itemIn(submenuOf(closed, 'Help'), 'Keyboard Shortcuts').enabled).toBe(true)
    const open = build({ state: EDITING }).template
    expect(itemIn(submenuOf(open, 'Help'), 'Keyboard Shortcuts').enabled).toBe(true)
  })

  it('disables the three Zoom items in Split mode, and only those', () => {
    // The one per-mode exception to this menu's deliberately coarse "gated on
    // documentOpen" rule, and it is about capability: Split's two-pane row
    // renders outside EditorScreen's zoom wrapper on purpose (its right pane
    // is a native WebContentsView whose bounds come from a DOM rect a CSS
    // scale would silently desync), so a live Zoom In there moved the status
    // bar's readout, changed nothing on screen, and made the document jump on
    // the next switch back to Format.
    const viewMenu = submenuOf(build({ state: { ...EDITING, viewMode: 'split' } }).template, 'View')
    for (const label of ['Zoom In', 'Zoom Out', 'Actual Size']) {
      expect(itemIn(viewMenu, label).enabled).toBe(false)
    }
    // Everything else in this menu is untouched by the mode -- switching AWAY
    // from Split has to stay reachable, or the disablement would be a trap.
    for (const label of ['Format', 'Split', 'Source', 'Toggle Sidebar']) {
      expect(itemIn(viewMenu, label).enabled).toBe(true)
    }
  })

  it('enables the Zoom items in Format and Source mode', () => {
    for (const viewMode of ['format', 'source'] as const) {
      const viewMenu = submenuOf(build({ state: { ...EDITING, viewMode } }).template, 'View')
      for (const label of ['Zoom In', 'Zoom Out', 'Actual Size']) {
        expect(itemIn(viewMenu, label).enabled).toBe(true)
      }
    }
  })

  it('checks the radio item matching the focused window view mode', () => {
    const viewMenu = submenuOf(build({ state: { ...EDITING, viewMode: 'split' } }).template, 'View')
    expect(itemIn(viewMenu, 'Format').checked).toBe(false)
    expect(itemIn(viewMenu, 'Split').checked).toBe(true)
    expect(itemIn(viewMenu, 'Source').checked).toBe(false)
    expect(itemIn(viewMenu, 'Split').type).toBe('radio')
  })

  // Split Left Pane and Follow Preview Scroll are NOT duplicates of a toolbar
  // control -- the single-row-toolbar pass made this menu their only home, so
  // these items carry the whole feature. They therefore have to do what the
  // pills did: report their own live state, and only be live where they mean
  // something.
  describe('Split Left Pane and Follow Preview Scroll', () => {
    const inSplit = (overrides: Partial<WindowUiState> = {}): MenuItemConstructorOptions[] =>
      submenuOf(build({ state: { ...EDITING, viewMode: 'split', ...overrides } }).template, 'View')

    it('renders Split Left Pane as a radio pair checked from the reported mode', () => {
      const pane = itemIn(inSplit({ splitLeftMode: 'source' }), 'Split Left Pane')
      const options = pane.submenu as MenuItemConstructorOptions[]
      expect(options.map((item) => item.label)).toEqual(['Format', 'Source'])
      expect(itemIn(options, 'Format')).toMatchObject({ type: 'radio', checked: false })
      expect(itemIn(options, 'Source')).toMatchObject({ type: 'radio', checked: true })
    })

    it('renders Follow Preview Scroll as a checkbox reflecting splitFollowEnabled', () => {
      expect(itemIn(inSplit({ splitFollowEnabled: true }), 'Follow Preview Scroll')).toMatchObject({
        type: 'checkbox',
        checked: true
      })
      expect(itemIn(inSplit({ splitFollowEnabled: false }), 'Follow Preview Scroll')).toMatchObject(
        {
          checked: false
        }
      )
    })

    it('disables both outside Split mode, mirroring the pills that never rendered there', () => {
      for (const viewMode of ['format', 'source'] as const) {
        const viewMenu = submenuOf(build({ state: { ...EDITING, viewMode } }).template, 'View')
        const options = itemIn(viewMenu, 'Split Left Pane').submenu as MenuItemConstructorOptions[]
        expect(options.every((item) => item.enabled === false)).toBe(true)
        expect(itemIn(viewMenu, 'Follow Preview Scroll').enabled).toBe(false)
      }
    })

    it('disables Follow when the Split left pane is Source, but leaves the pane choice live', () => {
      // Follow's arithmetic is keyed to the Milkdown page card's content-box
      // height, which a plain <textarea> has no counterpart for -- the exact
      // condition the toolbar pill encoded as `splitLeftMode === 'format'`.
      // The pane choice itself must stay enabled or the user could not get
      // back to Format and re-enable Follow at all.
      const viewMenu = inSplit({ splitLeftMode: 'source' })
      expect(itemIn(viewMenu, 'Follow Preview Scroll').enabled).toBe(false)
      const options = itemIn(viewMenu, 'Split Left Pane').submenu as MenuItemConstructorOptions[]
      expect(options.every((item) => item.enabled === true)).toBe(true)
    })
  })
})

describe('buildAppMenuTemplate: Open Recent', () => {
  it('renders a disabled placeholder when there are no recents', () => {
    const recent = itemIn(submenuOf(build().template, 'File'), 'Open Recent')
    const entries = recent.submenu as MenuItemConstructorOptions[]
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ label: 'No Recent Documents', enabled: false })
  })

  it('lists basenames, in the order given, and sends the FULL path', () => {
    const { template, send } = build({
      recentFiles: ['/Users/me/docs/report.md', '/Users/me/other/letter.md']
    })
    const entries = itemIn(submenuOf(template, 'File'), 'Open Recent')
      .submenu as MenuItemConstructorOptions[]
    expect(entries.map((entry) => entry.label)).toEqual(['report.md', 'letter.md'])

    // The label is a basename, but the PAYLOAD has to be the absolute path --
    // the renderer re-opens it through the same file:openPath/isKnownPath
    // round trip a Home-screen recent row uses, and a basename would never
    // match the allowlist.
    entries[1].click?.(undefined as never, undefined as never, undefined as never)
    expect(send).toHaveBeenCalledWith('file:openRecent', '/Users/me/other/letter.md')
  })
})

describe('buildAppMenuTemplate: command dispatch', () => {
  it('sends the matching command for each custom item', () => {
    const { template, send } = build({ state: EDITING })
    const click = (menu: string, label: string): void => {
      itemIn(submenuOf(template, menu), label).click?.(
        undefined as never,
        undefined as never,
        undefined as never
      )
    }
    click('File', 'New')
    click('File', 'Save')
    click('File', 'Save As…')
    // Second-pass product-completeness audit: Close Tab, now File's own
    // Cmd+W item -- see app-menu-template.ts's own comment on the accelerator
    // move this required.
    click('File', 'Close Tab')
    click('File', 'Export as PDF…')
    // The three items that are now these commands' ONLY trigger, since the
    // single-row-toolbar pass removed their toolbar buttons.
    click('File', 'Export as HTML…')
    click('File', 'Print…')
    click('File', 'Page Setup…')
    click('Edit', 'Find and Replace…')
    click('View', 'Split')
    click('View', 'Toggle Sidebar')
    click('Help', 'Keyboard Shortcuts')

    expect(send.mock.calls.map((call) => call[0])).toEqual([
      'file:new',
      'file:save',
      'file:saveAs',
      'file:closeTab',
      'file:exportPdf',
      'file:exportHtml',
      'file:print',
      'file:pageSetup',
      'edit:findReplace',
      'view:split',
      'view:toggleSidebar',
      'app:shortcuts'
    ])
  })

  it('sends the Split Left Pane and Follow commands from the View menu', () => {
    const { template, send } = build({ state: { ...EDITING, viewMode: 'split' } })
    const viewMenu = submenuOf(template, 'View')
    const pane = itemIn(viewMenu, 'Split Left Pane').submenu as MenuItemConstructorOptions[]
    const fire = (item: MenuItemConstructorOptions): void => {
      item.click?.(undefined as never, undefined as never, undefined as never)
    }
    fire(itemIn(pane, 'Source'))
    fire(itemIn(pane, 'Format'))
    fire(itemIn(viewMenu, 'Follow Preview Scroll'))

    expect(send.mock.calls.map((call) => call[0])).toEqual([
      'view:splitLeftSource',
      'view:splitLeftFormat',
      'view:toggleSplitFollow'
    ])
  })
})
