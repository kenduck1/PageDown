import { $command, $prose } from '@milkdown/utils'
import { history, undo, redo } from '@milkdown/prose/history'
import { pagebreakNode } from './nodes/pagebreak'

// prosemirror-history is not wired into either stock preset this editor
// mounts -- confirmed by reading @milkdown/preset-commonmark's and
// @milkdown/preset-gfm's own composed/plugins.ts, neither of which
// references `history` from anywhere. CLAUDE.md's Milkdown section
// previously recorded, as a fact MilkdownEditor.tsx's own editedTrackerProse
// plugin depended on, that "this project currently wires no undo/redo... so
// there is no real edit path that could ever set addToHistory: false and
// get silently excluded" -- this file is the "later" that comment
// anticipated, and the empirical re-verification it asked for: read
// directly from node_modules/.pnpm/prosemirror-history's own source
// (histTransaction in dist/index.cjs), an undo/redo transaction sets a
// `historyKey` transaction-meta entry to record the redo/undo bookkeeping,
// but never sets `addToHistory: false` on itself. That means
// editedTrackerProse's existing `(tr.docChanged || tr.storedMarksSet) &&
// tr.getMeta('addToHistory') !== false` filter continues to correctly treat
// a document-changing undo/redo as a real edit (docChanged is true,
// addToHistory is undefined, and undefined !== false) -- exactly the
// property flush()/Save-race protection needs to keep holding now that a
// real undo/redo path exists. No change to that filter was needed.
export const historyProse = $prose(() => history())

// prosemirror-history's own `undo`/`redo` already have the exact `Command`
// shape `$command`'s `cmd` callback expects to return (`(ctx) => (payload?)
// => Command`, where `Command` is `(state, dispatch?, view?) => boolean`) --
// confirmed by reading prosemirror-history's own .d.ts, which types both as
// plain `Command`. No wrapping beyond exposing them under a $command key is
// needed, so callCommand() can dispatch them the exact same way as every
// other command in this project (toggleStrongCommand, wrapInBulletListCommand,
// etc.).
export const undoCommand = $command('Undo', () => () => undo)
export const redoCommand = $command('Redo', () => () => redo)

// Neither preset ships a command to insert THIS project's own custom
// pagebreak atom node (naturally -- pagebreakNode, from ./nodes/pagebreak.ts,
// is a PageDown-specific node, not part of commonmark/gfm), so this defines
// one of its own, following the exact same $command shape every preset
// command it sits alongside uses (see e.g. downgradeHeadingCommand in
// @milkdown/preset-commonmark's own source for the same
// `(ctx) => () => (state, dispatch) => {...}` shape).
export const insertPagebreakCommand = $command(
  'InsertPagebreak',
  (ctx) => () => (state, dispatch) => {
    const type = pagebreakNode.type(ctx)
    dispatch?.(state.tr.replaceSelectionWith(type.create()))
    return true
  }
)

// The full set of non-schema editing-BEHAVIOR plugins MilkdownEditor.tsx
// mounts alongside EDITOR_SCHEMA_PLUGINS (plugins.ts) -- deliberately a
// separate list, for the same reason plugins.ts's own comment gives for
// excluding `listener`/editedTrackerProse from EDITOR_SCHEMA_PLUGINS: these
// three plugins add undo/redo/page-break-insertion behavior, not document
// schema, so they have no bearing on markdown round-trip fidelity and don't
// belong in the list round-trip.test.ts exercises. Exported so
// MilkdownEditor.test.tsx's command-plumbing verification tests can mount
// the exact composition MilkdownEditor.tsx ships, rather than risk a
// hand-copied list silently drifting from the real one -- the same
// anti-drift reasoning EDITOR_SCHEMA_PLUGINS documents for its own
// consumers.
export const EDITOR_COMMAND_PLUGINS = [
  historyProse,
  undoCommand,
  redoCommand,
  insertPagebreakCommand
]
