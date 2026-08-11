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
    // Both would register the same Cmd+W accelerator, with only one able to
    // fire -- and File is where macOS's own HIG puts Close.
    const template = build({ platform: 'darwin' }).template
    expect(submenuOf(template, 'File').some((item) => item.role === 'close')).toBe(true)
    expect(submenuOf(template, 'Window').some((item) => item.role === 'close')).toBe(false)
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

  it('binds Find/Find Next/Find Previous', () => {
    const editMenu = submenuOf(build({ state: EDITING }).template, 'Edit')
    expect(itemIn(editMenu, 'Find…').accelerator).toBe('CmdOrCtrl+F')
    expect(itemIn(editMenu, 'Find Next').accelerator).toBe('CmdOrCtrl+G')
    expect(itemIn(editMenu, 'Find Previous').accelerator).toBe('CmdOrCtrl+Shift+G')
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
    for (const label of ['Find…', 'Find Next', 'Find Previous']) {
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
    click('File', 'Export as PDF…')
    click('View', 'Split')
    click('View', 'Toggle Sidebar')
    click('Help', 'Keyboard Shortcuts')

    expect(send.mock.calls.map((call) => call[0])).toEqual([
      'file:new',
      'file:save',
      'file:saveAs',
      'file:exportPdf',
      'view:split',
      'view:toggleSidebar',
      'app:shortcuts'
    ])
  })
})
