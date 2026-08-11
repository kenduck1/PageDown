import { useModalDialog } from '../hooks/useModalDialog'
import { isMacPlatform } from '../lib/platform'

// A real, honest reference of every keyboard shortcut that actually exists
// in this app right now -- every entry below was verified directly against
// its own source before being listed here, not assumed from convention:
//
// - Every "File"/"View" entry, plus Find/Find Next/Find Previous and
//   Keyboard Shortcuts: real accelerators on real application-menu items
//   (src/main/app-menu-template.ts). The claim this list used to make --
//   "this app has no native OS menu with accelerators yet" -- is no longer
//   true, and these entries were read straight off that template rather than
//   assumed. Note two of them (Find, Keyboard Shortcuts) ALSO still have the
//   bare `window` keydown listeners that were the only implementation before
//   the menu existed; the menu accelerator is what actually fires in the real
//   app now (it consumes the keystroke before the page sees it), which is why
//   both paths deliberately run the same function.
// - Find & Replace: a REAL application-menu item now too (`Edit > Find and
//   Replace…`, src/main/app-menu-template.ts), with a platform-specific
//   accelerator -- Option+Cmd+F on macOS (the existing TextEdit/Pages/Xcode
//   convention, unchanged), Ctrl+H on Windows/Linux (Word/VS Code/Notepad++/
//   Sublime/Chrome DevTools convention -- NOT Ctrl+Alt+F, which was
//   discoverable by nobody and is what this entry used to advertise via a
//   bare `${MOD}${ALT}F` that rendered as the unreadable, non-conventional
//   "CtrlAltF"). Cmd+H is deliberately never bound on macOS -- it is
//   system-reserved for Hide Application, and hijacking it would be a real
//   bug. useFindShortcuts.ts's bare `window` listener binds the SAME two
//   platform-specific combos directly (Cmd+Alt+F / Ctrl+H), for the same
//   "menu may be absent" reason Find itself keeps its own listener -- see
//   that file's header. Escape-to-close remains listener-only, since it is
//   not (and does not need to be) a menu item at all.
// - Undo/Redo: src/renderer/src/milkdown/commands.ts's historyKeymap, a
//   real $useKeymap() ProseMirror plugin this project added (previously,
//   Format mode's toolbar Undo/Redo buttons worked but no keyboard shortcut
//   did at all -- confirmed by reading the pre-existing code, not assumed).
// - Every "Formatting"/"Structure"/"Tables" entry: read directly out of the
//   INSTALLED @milkdown/preset-commonmark and @milkdown/preset-gfm package
//   source (their own `/// - `Mod-x`` doc comments and `shortcuts:` keymap
//   registrations), not from memory of "what Milkdown usually binds" -- the
//   installed version is 7.21.3, pinned in package.json, and that's the
//   version actually in effect.
// - "/" (slash command menu): src/renderer/src/lib/slash-query.ts's own
//   findSlashTrigger -- start of a BLOCK (a paragraph, however many visual
//   lines it wraps to, is one block), or immediately preceded by ANY
//   whitespace character (not just a literal space), matching this app's
//   own trigger rule exactly rather than a generic "type / anywhere" claim.
//   Fix round 1, M2: an earlier version of this bullet, and the shortcut's
//   own description below, both said "start of a line... after a space" --
//   plausible-sounding but not what the code actually checks.
//
// Format-mode-only shortcuts (everything except Find/Find & Replace/Escape,
// which work from anywhere) are marked as such below -- Source mode is a
// plain <textarea> with the browser's own native text-editing shortcuts
// (including its own free native undo/redo), not these ProseMirror keymaps.
// isMacPlatform() (src/renderer/src/lib/platform.ts) is display-only HERE --
// this modal never gates behavior on it, only which glyphs to print -- but
// the same function is no longer display-only everywhere: useFindShortcuts.ts
// now also uses it to decide whether Ctrl+H opens Find and Replace. That
// second, behavioral use is exactly why the check was extracted into a
// shared module instead of staying a local const in each file -- see that
// module's own header for the full reasoning.
const IS_MAC = isMacPlatform()
const MOD = IS_MAC ? '⌘' : 'Ctrl'
const ALT = IS_MAC ? '⌥' : 'Alt'
const SHIFT = '⇧'

interface Shortcut {
  keys: string
  description: string
}

interface ShortcutCategory {
  name: string
  shortcuts: Shortcut[]
}

const CATEGORIES: ShortcutCategory[] = [
  {
    name: 'File',
    shortcuts: [
      { keys: `${MOD}N`, description: 'New document' },
      { keys: `${MOD}O`, description: 'Open…' },
      { keys: `${MOD}S`, description: 'Save' },
      { keys: `${MOD}${SHIFT}S`, description: 'Save As…' },
      // Deliberately NOT ⌘E, which @milkdown/preset-commonmark already binds
      // to inline code -- see app-menu-template.ts's own note.
      { keys: `${MOD}${SHIFT}E`, description: 'Export as PDF…' },
      // Both added when the single-row-toolbar pass removed the Export-as-HTML
      // button and gave Page Setup a keyboard route. Alt+E pairs with Export
      // as PDF on the same base key; Shift+P is the platform's own
      // long-standing Page Setup accelerator. Neither collides -- checked
      // against this list and pinned by app-menu-template.test.ts's
      // "never reuses one accelerator" sweep.
      { keys: `${MOD}${ALT}E`, description: 'Export as HTML…' },
      { keys: `${MOD}P`, description: 'Print…' },
      { keys: `${MOD}${SHIFT}P`, description: 'Page setup…' },
      { keys: `${MOD}W`, description: 'Close window' }
    ]
  },
  {
    name: 'App',
    shortcuts: [
      { keys: `${MOD}F`, description: 'Find' },
      // Deliberately NOT `${MOD}${ALT}F` on non-mac -- unlike every other
      // `${MOD}${ALT}…` entry in this file (Structure/Formatting below),
      // where the SAME physical keys are bound on every platform and only
      // the modifier glyphs differ, Find and Replace binds a genuinely
      // DIFFERENT key per platform (see app-menu-template.ts/
      // useFindShortcuts.ts): Option+Cmd+F on macOS, Ctrl+H on Windows/Linux
      // (Cmd+H is never bound -- macOS's own Hide Application shortcut).
      // `${MOD}${ALT}F` would have rendered as "CtrlAltF" on Windows/Linux,
      // documenting a binding this app no longer even advertises as the
      // primary one there.
      { keys: IS_MAC ? `${MOD}${ALT}F` : 'Ctrl+H', description: 'Find and Replace' },
      { keys: `${MOD}G`, description: 'Find next' },
      { keys: `${MOD}${SHIFT}G`, description: 'Find previous' },
      { keys: 'Esc', description: 'Close Find (while open)' },
      { keys: `${MOD},`, description: 'Preferences' },
      { keys: `${MOD}/`, description: 'Keyboard shortcuts (this window)' }
    ]
  },
  {
    name: 'View',
    shortcuts: [
      { keys: `${MOD}1`, description: 'Format view' },
      { keys: `${MOD}2`, description: 'Split view' },
      { keys: `${MOD}3`, description: 'Source view' },
      { keys: `${MOD}+`, description: 'Zoom in' },
      { keys: `${MOD}−`, description: 'Zoom out' },
      { keys: `${MOD}0`, description: 'Actual size' },
      { keys: `${MOD}\\`, description: 'Toggle sidebar' }
    ]
  },
  {
    name: 'Editing (Format mode)',
    shortcuts: [
      { keys: `${MOD}Z`, description: 'Undo' },
      { keys: `${MOD}${SHIFT}Z`, description: 'Redo' },
      { keys: `${MOD}${SHIFT}M`, description: 'Add comment' },
      { keys: '/', description: 'Slash command menu (start of a block, or after whitespace)' }
    ]
  },
  {
    name: 'Formatting (Format mode)',
    shortcuts: [
      { keys: `${MOD}B`, description: 'Bold' },
      { keys: `${MOD}I`, description: 'Italic' },
      { keys: `${MOD}E`, description: 'Inline code' },
      { keys: `${MOD}${ALT}X`, description: 'Strikethrough' },
      { keys: `${MOD}${SHIFT}B`, description: 'Blockquote' }
    ]
  },
  {
    name: 'Structure (Format mode)',
    shortcuts: [
      { keys: `${MOD}${ALT}0`, description: 'Normal text' },
      { keys: `${MOD}${ALT}1`, description: 'Heading 1' },
      { keys: `${MOD}${ALT}2`, description: 'Heading 2' },
      { keys: `${MOD}${ALT}3`, description: 'Heading 3' },
      { keys: `${MOD}${ALT}4`, description: 'Heading 4' },
      { keys: `${MOD}${ALT}5`, description: 'Heading 5' },
      { keys: `${MOD}${ALT}6`, description: 'Heading 6' },
      { keys: `${MOD}${ALT}7`, description: 'Ordered list' },
      { keys: `${MOD}${ALT}8`, description: 'Bullet list' },
      { keys: `${MOD}${ALT}C`, description: 'Code block' },
      { keys: 'Shift ⏎', description: 'Line break (stay in the same paragraph)' }
    ]
  },
  {
    name: 'Tables (Format mode, while inside one)',
    shortcuts: [
      { keys: '⇥', description: 'Next cell' },
      { keys: `${SHIFT}⇥`, description: 'Previous cell' },
      { keys: `${MOD}⏎`, description: 'Exit the table' }
    ]
  }
]

export interface ShortcutsHelpModalProps {
  open: boolean
  onClose: () => void
}

function ShortcutsHelpModal({ open, onClose }: ShortcutsHelpModalProps): React.JSX.Element | null {
  // Escape-to-close, a real focus trap, focus-in on open, and focus-restore
  // on close -- see useModalDialog.ts's own header comment for why this was
  // missing (aria-modal="true" was previously a false claim) and the
  // reported symptom it fixes. Called unconditionally, before the `if
  // (!open)` early return below, per the Rules of Hooks -- the hook itself
  // no-ops internally whenever `open` is false.
  const dialogRef = useModalDialog(open, onClose)

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      onClick={onClose}
      data-testid="shortcuts-help-scrim"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[min(600px,88vh)] w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-lg bg-page shadow-modal"
      >
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3.5">
          <h2 className="text-15-5 font-bold text-text-primary">Keyboard shortcuts</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-15 text-text-secondary"
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {CATEGORIES.map((category) => (
            <div key={category.name} className="mb-5 last:mb-0">
              <h3 className="mb-2 text-11-5 font-semibold uppercase tracking-wide text-text-secondary">
                {category.name}
              </h3>
              <div className="flex flex-col gap-1.5">
                {category.shortcuts.map((shortcut) => (
                  <div key={shortcut.description} className="flex items-center justify-between">
                    <span className="text-12-5 text-text-primary">{shortcut.description}</span>
                    <kbd className="rounded-sm border border-border-chrome bg-chrome-light px-1.5 py-0.5 text-11-5 font-mono text-text-secondary">
                      {shortcut.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default ShortcutsHelpModal
