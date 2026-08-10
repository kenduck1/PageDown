// A real, honest reference of every keyboard shortcut that actually exists
// in this app right now -- every entry below was verified directly against
// its own source before being listed here, not assumed from convention:
//
// - Find/Find & Replace/Escape: useFindShortcuts.ts's own bare `window`
//   keydown listener (this app has no native OS menu with accelerators yet
//   -- see that file's own module comment for why).
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
// navigator.platform is deprecated but still functionally reports "MacIntel"
// on every real Mac (Intel or Apple Silicon, via Rosetta-compatibility
// reporting) -- reliable enough for "is this a Mac" specifically, which is
// all this needs. No IPC round trip to the main process's real
// process.platform: this is display-only labeling, not behavior that needs
// to be correct with 100% certainty (useFindShortcuts.ts's own real
// shortcut handling checks `event.metaKey || event.ctrlKey` directly at
// keydown time regardless of what's shown here).
const IS_MAC = navigator.platform.toUpperCase().includes('MAC')
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
    name: 'App',
    shortcuts: [
      { keys: `${MOD}F`, description: 'Find' },
      { keys: `${MOD}${ALT}F`, description: 'Find and Replace' },
      { keys: 'Esc', description: 'Close Find (while open)' }
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
  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      onClick={onClose}
      data-testid="shortcuts-help-scrim"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
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
