import { $command, $prose, $useKeymap } from '@milkdown/utils'
import { commandsCtx } from '@milkdown/core'
import { history, undo, redo } from '@milkdown/prose/history'
import { TextSelection } from '@milkdown/prose/state'
import type { Mark } from '@milkdown/prose/model'
import { pagebreakNode } from './nodes/pagebreak'
import { commentSchema } from './nodes/comment'
import { safeImageViewProse } from './image-security'

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

// Neither stock preset binds a keyboard shortcut for undo/redo either --
// confirmed the same way the comment on historyProse above did (neither
// preset's own composed/plugins.ts references `history` at all), and
// prosemirror-history's own history() plugin only tracks undo/redo STATE, it
// doesn't bind any keys on its own. Format mode's toolbar Undo/Redo buttons
// already call undoCommand/redoCommand directly and work fine -- but before
// this, Mod-z/Mod-Shift-z/Mod-y did nothing at all in Format mode, which is
// a real, surprising gap for what's likely the single most reflexive
// keyboard shortcut in any text editor. (Source mode needs no equivalent --
// it's a plain <textarea>, which gets the browser's own native text-input
// undo stack for free, activated by Cmd/Ctrl+Z with zero JS.) Follows the
// exact same $useKeymap pattern @milkdown/preset-commonmark's own
// strongKeymap/emphasisKeymap use (see node_modules/.pnpm/
// @milkdown+preset-commonmark.../src/mark/strong.ts) -- commandsCtx.call()
// dispatches the already-defined undoCommand/redoCommand by their own $command
// key, the same mechanism the toolbar buttons already use, so both paths stay
// in sync by construction rather than duplicating the undo/redo logic itself.
// Redo binds both Mod-Shift-z (the more common convention, matches most
// editors including this one's own toolbar tooltip) and Mod-y (the
// Windows/Ctrl convention many editors also honor everywhere) -- both are
// harmless to bind unconditionally since neither collides with any other
// shortcut this project defines.
export const historyKeymap = $useKeymap('historyKeymap', {
  Undo: {
    shortcuts: 'Mod-z',
    command: (ctx) => {
      const commands = ctx.get(commandsCtx)
      return () => commands.call(undoCommand.key)
    }
  },
  Redo: {
    shortcuts: ['Mod-Shift-z', 'Mod-y'],
    command: (ctx) => {
      const commands = ctx.get(commandsCtx)
      return () => commands.call(redoCommand.key)
    }
  }
})

// Neither preset ships a command to insert THIS project's own custom
// pagebreak atom node (naturally -- pagebreakNode, from ./nodes/pagebreak.ts,
// is a PageDown-specific node, not part of commonmark/gfm), so this defines
// one of its own, following the exact same $command shape every preset
// command it sits alongside uses (see e.g. downgradeHeadingCommand in
// @milkdown/preset-commonmark's own source for the same
// `(ctx) => () => (state, dispatch) => {...}` shape).
// Fix-round finding (verified, not theorized): the original implementation
// called `state.tr.replaceSelectionWith(type.create())` directly against
// whatever the CURRENT selection was. `replaceSelectionWith` REPLACES the
// selection, not just inserts at it -- with a non-empty (ranged) selection,
// that's silent data loss: "Hello World" with "Hello" selected, then
// insert-page-break, produced a pagebreak node followed by "<p> World</p>"
// -- "Hello" was gone (undoable via the real undo/redo above, but silently,
// on the very plausible gesture of "select some text, click insert page
// break"). Collapsing the selection to its start FIRST, then replacing
// THAT (now-empty) selection, keeps `replaceSelectionWith`'s own
// block-splitting behavior (needed for inserting a block-level atom
// mid-paragraph) while inserting rather than consuming: whatever was
// selected survives, immediately after the new page break.
export const insertPagebreakCommand = $command(
  'InsertPagebreak',
  (ctx) => () => (state, dispatch) => {
    const type = pagebreakNode.type(ctx)
    const collapsed = TextSelection.create(state.doc, state.selection.from)
    const tr = state.tr.setSelection(collapsed).replaceSelectionWith(type.create())
    dispatch?.(tr)
    return true
  }
)

// Applies a real comment MARK (not a node -- see comment.ts's own top
// comment) over the current selection. Returns false (a no-op command,
// standard ProseMirror convention for "not applicable right now") for an
// empty selection or one spanning more than one block -- refused, not
// silently clipped to the first block, per the design doc's own scope
// boundary (docs/superpowers/specs/2026-08-09-comments-design.md):
// `$from.sameParent($to)` is the direct ProseMirror check for "both ends of
// the selection share the same immediate parent," which is exactly "does
// not cross a block boundary" for the kinds of selections this app's
// schema allows (a selection can't span, say, one list item into another
// without ALSO crossing their shared parent list -- sameParent already
// covers every case that matters here, not just the single-paragraph one).
// `id`/`createdAt` are generated here, not passed in by the caller, so
// every comment's identity is genuinely fresh and every timestamp reflects
// the actual moment of creation -- crypto.randomUUID() is a standard Web
// Crypto API, present in this renderer with no additional plugin (same
// global this codebase already relies on being real -- see e.g.
// documentStore's own use for tab ids).
export const addCommentCommand = $command(
  'AddComment',
  (ctx) => (payload?: { author: string; text: string }) => (state, dispatch) => {
    if (!payload || payload.text.trim() === '') return false
    const { from, to } = state.selection
    if (from === to) return false
    const $from = state.doc.resolve(from)
    const $to = state.doc.resolve(to)
    if (!$from.sameParent($to)) return false

    const markType = commentSchema.type(ctx)
    const mark = markType.create({
      id: crypto.randomUUID(),
      author: payload.author,
      text: payload.text,
      createdAt: new Date().toISOString()
    })
    const tr = state.tr.addMark(from, to, mark)
    dispatch?.(tr)
    return true
  }
)

// Removes every mark instance carrying the given `id` from the WHOLE
// document, not just the current selection -- a single logical comment can
// in principle be represented by more than one ProseMirror mark instance
// sharing the same id (e.g. if editing ever split a marked range), so
// "resolve this comment" must sweep everywhere, matching how the sidebar's
// own extractComments treats same-id occurrences as one comment. Walks
// every descendant (not just text nodes) because a comment can mark any
// inline content, including non-text inline nodes this schema might add in
// the future -- matching Mark, not the node's type, so this only ever
// removes marks belonging to THIS one comment id, never an unrelated,
// overlapping comment.
export const resolveCommentCommand = $command(
  'ResolveComment',
  (ctx) => (id?: string) => (state, dispatch) => {
    if (!id) return false
    const markType = commentSchema.type(ctx)
    let tr = state.tr
    let found = false
    state.doc.descendants((node, pos) => {
      const mark = node.marks.find((m: Mark) => m.type === markType && m.attrs.id === id)
      if (mark) {
        tr = tr.removeMark(pos, pos + node.nodeSize, mark)
        found = true
      }
      return true
    })
    if (!found) return false
    dispatch?.(tr)
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
// `.flat()` here (not left to each call site, unlike EDITOR_SCHEMA_PLUGINS,
// which every consumer already flattens itself) because historyKeymap is a
// $useKeymap() result -- confirmed by reading @milkdown/preset-commonmark's
// own composed/keymap.ts, a $useKeymap() plugin is NOT a single plugin
// reference the way $command/$prose results are; the preset's own equivalent
// list literal ends in `.flat()` for exactly this reason. Flattening once
// here, at the definition, is safer than trusting every future consumer to
// remember it themselves.
export const EDITOR_COMMAND_PLUGINS = [
  historyProse,
  undoCommand,
  redoCommand,
  historyKeymap,
  insertPagebreakCommand,
  addCommentCommand,
  resolveCommentCommand,
  // See image-security.ts's own module comment for the real, confirmed
  // vulnerability this closes: the stock commonmark image node renders an
  // unrestricted <img src> directly in this privileged renderer. Rendering
  // behavior, not schema (round-trip fidelity for image syntax is
  // untouched), so this belongs here alongside historyProse/undoCommand,
  // not in plugins.ts's EDITOR_SCHEMA_PLUGINS.
  safeImageViewProse
].flat()
