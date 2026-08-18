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
  checkForUpdates: ReturnType<typeof vi.fn>
} {
  const send = vi.fn()
  const checkForUpdates = vi.fn()
  const template = buildAppMenuTemplate({
    appName: 'PageDown',
    platform: 'darwin',
    isDev: false,
    state: DEFAULT_WINDOW_UI_STATE,
    recentFiles: [],
    send: send as unknown as (command: MenuCommand, payload?: string) => void,
    // Defaults to the PACKAGED case, so the collision sweep and every other
    // pre-existing test in this file sees the real shipped menu rather than a
    // reduced development one.
    updatesEnabled: true,
    checkForUpdates,
    ...overrides
  })
  return { template, send, checkForUpdates }
}

const EDITING: WindowUiState = {
  ...DEFAULT_WINDOW_UI_STATE,
  documentOpen: true,
  fileName: 'report.md'
}

// Electron's OWN default accelerator for each role this template uses, for
// the collision sweep below.
//
// TRANSCRIBED FROM THE SHIPPED BINARY, NOT FROM MEMORY OR DOCS. Electron's
// `lib/browser/api/menu-item-roles.ts` is compiled into the framework rather
// than readable from node_modules, so these were read out of
// `node_modules/electron/dist/Electron.app/.../Electron Framework` with
// `strings`, e.g. `close:{label:...,accelerator:"CommandOrControl+W",...}`.
// That is what makes this a check and not a second guess.
//
// Only the roles buildAppMenuTemplate actually emits are listed; roles that
// genuinely carry no default (`about`, `front`, `zoom`, `unhide`, `services`,
// `help`) are recorded as `undefined` rather than omitted, so a reader can
// tell "no accelerator" from "nobody looked".
//
// The two platform-conditional entries are conditional in Electron's own
// table too: `redo` is Control+Y on win32 only, `quit` has NO accelerator on
// win32 (Alt+F4 is the platform gesture) and CommandOrControl+Q elsewhere.
//
// KEEP THIS IN STEP WITH `pnpm why electron`. A role default changing under
// an Electron upgrade is exactly the kind of thing that would reintroduce a
// silent double-bind, and this table is the only place that would notice.
const ROLE_DEFAULT_ACCELERATORS: Record<string, (platform: NodeJS.Platform) => string | undefined> =
  {
    undo: () => 'CommandOrControl+Z',
    redo: (p) => (p === 'win32' ? 'Control+Y' : 'Shift+CommandOrControl+Z'),
    cut: () => 'CommandOrControl+X',
    copy: () => 'CommandOrControl+C',
    paste: () => 'CommandOrControl+V',
    pasteAndMatchStyle: (p) => (p === 'darwin' ? 'Cmd+Option+Shift+V' : 'Shift+CommandOrControl+V'),
    selectAll: () => 'CommandOrControl+A',
    minimize: () => 'CommandOrControl+M',
    close: () => 'CommandOrControl+W',
    quit: (p) => (p === 'win32' ? undefined : 'CommandOrControl+Q'),
    hide: () => 'Command+H',
    hideOthers: () => 'Command+Alt+H',
    reload: () => 'CmdOrCtrl+R',
    forceReload: () => 'Shift+CmdOrCtrl+R',
    toggleDevTools: (p) => (p === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I'),
    about: () => undefined,
    front: () => undefined,
    zoom: () => undefined,
    unhide: () => undefined,
    services: () => undefined,
    help: () => undefined
  }

// What keystroke this item really claims: its explicit accelerator if it has
// one (an explicit value OVERRIDES a role's default), otherwise whatever its
// role supplies for this platform.
function resolveAccelerator(
  item: MenuItemConstructorOptions,
  platform: NodeJS.Platform
): string | undefined {
  if (item.accelerator) return item.accelerator
  if (!item.role) return undefined
  const lookup = ROLE_DEFAULT_ACCELERATORS[item.role]
  if (!lookup) throw new Error(`No recorded default accelerator for role "${item.role}"`)
  return lookup(platform)
}

// Reduces an Electron accelerator string to the actual KEYSTROKE it binds, so
// two spellings of one chord compare equal.
//
// Found the hard way, and worth stating plainly: comparing the raw strings is
// NOT ENOUGH, and a sweep that does so gives false confidence. Re-introducing
// the exact bug this test exists to catch -- a bare `role: 'close'` in the
// Window menu, alongside File > Close Tab -- left this test GREEN, because the
// role's default is spelled `CommandOrControl+W` while the template writes
// `CmdOrCtrl+W`. Same key, same platform, two strings, no collision detected.
// (The two structure tests above did catch that mutation, which is how this
// gap surfaced at all.)
//
// Three normalisations, each from Electron's own accelerator documentation:
// the alias pairs (Command/Cmd, Control/Ctrl, CommandOrControl/CmdOrCtrl,
// Option/Alt, Super/Meta); `CmdOrCtrl` resolved to the modifier it actually
// becomes ON THIS PLATFORM, so `Cmd+Alt+F` and `CmdOrCtrl+Alt+F` collide on
// darwin as they really would; and modifier ORDER, which Electron does not
// care about (`Alt+Command+I` and `Command+Alt+I` are one chord).
function normalizeAccelerator(accelerator: string, platform: NodeJS.Platform): string {
  const parts = accelerator.split('+').map((part) => part.trim())
  // The final segment is the key; everything before it is a modifier. Split
  // on '+' is safe because Electron spells a literal plus key as `Plus`.
  const key = (parts.pop() ?? '').toLowerCase()
  const modifiers = parts.map((modifier) => {
    const lower = modifier.toLowerCase()
    if (lower === 'commandorcontrol' || lower === 'cmdorctrl') {
      return platform === 'darwin' ? 'cmd' : 'ctrl'
    }
    if (lower === 'command' || lower === 'cmd') return 'cmd'
    if (lower === 'control' || lower === 'ctrl') return 'ctrl'
    if (lower === 'option' || lower === 'alt') return 'alt'
    if (lower === 'super' || lower === 'meta') return 'super'
    return lower
  })
  return `${[...new Set(modifiers)].sort().join('+')}|${key}`
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
    //
    // This assertion USED TO EXPECT `['minimize', 'close']`, i.e. it pinned
    // the bug rather than the behaviour: a bare `role: 'close'` here carries
    // Electron's own `CommandOrControl+W` default, which File > Close Tab
    // already claims, so on every Windows/Linux build one of the two silently
    // never fired. Changed deliberately -- see app-menu-template.ts's own
    // windowMenu comment.
    const linuxWindow = submenuOf(build({ platform: 'linux' }).template, 'Window')
    expect(linuxWindow.map((item) => item.role).filter(Boolean)).toEqual(['minimize'])
  })

  it('shows Close Window in File and NOT also in the Window menu, on EVERY platform', () => {
    // Both would register the same accelerator, with only one able to
    // fire -- and File is where macOS's own HIG puts Close.
    //
    // Swept across all three platforms rather than darwin only. The darwin-only
    // version of this test passed happily while the non-macOS branch of the
    // Window menu carried exactly the duplicate it claims to forbid.
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const template = build({ platform }).template
      expect(submenuOf(template, 'File').some((item) => item.role === 'close')).toBe(true)
      expect(
        submenuOf(template, 'Window').some((item) => item.role === 'close'),
        `Window menu on ${platform} must not carry a second close item`
      ).toBe(false)
    }
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

  it('hands Cmd+W to Close Window when no document is open, so it is never inert', () => {
    // The defect: Close Tab was gated `enabled: documentOpen` while still
    // CLAIMING Cmd+W, and it had also pushed the window-close role off that
    // key -- so on Home and Settings, the screen this app OPENS TO, the very
    // first Cmd+W a new user presses reached a disabled item and did nothing
    // at all. A disabled item still consumes its accelerator; enablement and
    // accelerator have to be gated together.
    const closedFile = submenuOf(build({ state: DEFAULT_WINDOW_UI_STATE }).template, 'File')
    expect(itemIn(closedFile, 'Close Tab').accelerator).toBeUndefined()
    expect(itemIn(closedFile, 'Close Window').accelerator).toBe('CmdOrCtrl+W')

    // ...and hands it straight back the moment there is a tab to close, so
    // the editor keeps the browser-standard pair.
    const openFile = submenuOf(build({ state: EDITING }).template, 'File')
    expect(itemIn(openFile, 'Close Tab').accelerator).toBe('CmdOrCtrl+W')
    expect(itemIn(openFile, 'Close Window').accelerator).toBe('CmdOrCtrl+Shift+W')

    // Still the real role in both states -- an explicit accelerator overrides
    // a role's default without replacing the role, and this guards against a
    // future edit that swaps it for a hand-rolled click handler.
    expect(itemIn(closedFile, 'Close Window').role).toBe('close')
    expect(itemIn(openFile, 'Close Window').role).toBe('close')
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

  it('sends file:exportDocx from a File > Export as Word item gated on a document', () => {
    // The File menu is the ONLY route to .docx export -- there is no toolbar
    // button and never was one -- so an item that is missing, mislabelled or
    // wired to nothing makes the whole feature unreachable.
    const { template, send } = build({ state: EDITING })
    const item = itemIn(submenuOf(template, 'File'), 'Export as Word…')
    expect(item.accelerator).toBe('CmdOrCtrl+Alt+Shift+E')
    expect(item.enabled).toBe(true)
    item.click?.(undefined as never, undefined as never, undefined as never)
    expect(send).toHaveBeenCalledWith('file:exportDocx')

    // Disabled with no document, matching every other document-scoped item --
    // this menu's own rule is "disabled, never enabled-and-inert".
    const home = build()
    expect(itemIn(submenuOf(home.template, 'File'), 'Export as Word…').enabled).toBe(false)
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
    // fires from the keyboard.
    //
    // THIS TEST USED TO CLAIM MORE THAN IT CHECKED, and the gap shipped a real
    // bug. Its own comment said it covered "the WHOLE menu, including
    // role-supplied items, since role accelerators are platform defaults this
    // file does not see" -- but the body only ever collected `item.accelerator`,
    // which is exactly the field a bare `{ role: 'close' }` does NOT have. It
    // therefore saw none of the platform defaults it named, and it built the
    // darwin template only, while the collision it missed (File > Close Tab's
    // CmdOrCtrl+W against a bare `role: 'close'` in the Window menu) existed
    // only on Windows/Linux. Both halves are fixed below: role defaults are
    // resolved through ROLE_DEFAULT_ACCELERATORS, and every platform is swept,
    // in both documentOpen states.
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      for (const state of [DEFAULT_WINDOW_UI_STATE, EDITING]) {
        const template = build({ platform, state, isDev: true }).template
        const claims: { label: string; chord: string }[] = []
        const walk = (items: MenuItemConstructorOptions[]): void => {
          for (const item of items) {
            const accelerator = resolveAccelerator(item, platform)
            // A DISABLED item still consumes its accelerator, so it counts as
            // a claim -- which is the other half of the same bug (Close Tab
            // holding Cmd+W while greyed out on Home).
            if (accelerator) {
              claims.push({
                label: `${String(item.label ?? item.role)} (${accelerator})`,
                chord: normalizeAccelerator(accelerator, platform)
              })
            }
            if (Array.isArray(item.submenu)) walk(item.submenu as MenuItemConstructorOptions[])
          }
        }
        walk(template)

        const byAccelerator = new Map<string, string[]>()
        for (const claim of claims) {
          byAccelerator.set(claim.chord, [...(byAccelerator.get(claim.chord) ?? []), claim.label])
        }
        const collisions = [...byAccelerator.entries()].filter(([, labels]) => labels.length > 1)
        expect(collisions, `${platform}, documentOpen=${state.documentOpen}`).toEqual([])
      }
    }
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

  describe('Help > Check for Updates…', () => {
    it('is present and enabled on every screen in a packaged build', () => {
      // Same reasoning as Keyboard Shortcuts directly above: checking for
      // updates has nothing to do with whether a document is on screen, so
      // gating it on documentOpen would make it unreachable from Home --
      // which is exactly where a user who just launched the app is standing.
      const closed = build({ updatesEnabled: true, state: DEFAULT_WINDOW_UI_STATE }).template
      expect(itemIn(submenuOf(closed, 'Help'), 'Check for Updates…').enabled).toBe(true)
      const open = build({ updatesEnabled: true, state: EDITING }).template
      expect(itemIn(submenuOf(open, 'Help'), 'Check for Updates…').enabled).toBe(true)
    })

    it('is omitted entirely, not disabled, when updates cannot run', () => {
      // A greyed item would be describing the BUILD rather than the
      // document, and nothing the user does can change it -- see the item's
      // own comment in app-menu-template.ts for why that distinction decides
      // between "disabled" and "absent".
      const help = submenuOf(build({ updatesEnabled: false }).template, 'Help')
      expect(help.map((item) => item.label)).not.toContain('Check for Updates…')
      // ...and the rest of the Help menu is untouched by its absence.
      expect(itemIn(help, 'Keyboard Shortcuts').enabled).toBe(true)
    })

    it('calls the injected main-process callback, NOT the renderer command channel', () => {
      // The distinction this pins: every other item in this menu routes
      // through `send` to a renderer. This one must not -- there is no
      // renderer state to consult, and bouncing it through a window only to
      // have that window invoke straight back into main is a round trip with
      // no purpose. A regression that "helpfully" moved it onto `send` would
      // otherwise be invisible.
      const { template, send, checkForUpdates } = build({ updatesEnabled: true })
      const item = itemIn(submenuOf(template, 'Help'), 'Check for Updates…')
      ;(item.click as () => void)()
      expect(checkForUpdates).toHaveBeenCalledTimes(1)
      expect(send).not.toHaveBeenCalled()
    })
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
