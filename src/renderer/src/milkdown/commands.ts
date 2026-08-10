import { $command, $prose, $useKeymap } from '@milkdown/utils'
import { commandsCtx } from '@milkdown/core'
import type { Ctx } from '@milkdown/ctx'
import { history, undo, redo } from '@milkdown/prose/history'
import { wrapIn, setBlockType } from '@milkdown/prose/commands'
import { Plugin, TextSelection } from '@milkdown/prose/state'
import type { EditorState, Transaction } from '@milkdown/prose/state'
import {
  deleteColumn,
  deleteRow,
  deleteTable,
  goToNextCell,
  isInTable
} from '@milkdown/prose/tables'
import { Fragment } from '@milkdown/prose/model'
import type { Mark } from '@milkdown/prose/model'
import {
  bulletListSchema,
  listItemSchema,
  codeBlockSchema,
  hardbreakSchema,
  linkSchema,
  paragraphSchema
} from '@milkdown/preset-commonmark'
import { addRowAfterCommand, tableCellSchema, tableHeaderSchema } from '@milkdown/preset-gfm'
import { pagebreakNode } from './nodes/pagebreak'
import { commentSchema } from './nodes/comment'
import { safeImageViewProse } from './image-security'
import { columnCellPositions, findTableContext, type TableAlignment } from './table-context'

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

// Task 4 (slash-menu) finding, measured directly against a real editor, not
// theorized: a table cell's content model is the rigid, single-child
// 'paragraph' (no `+`/`*`) -- confirmed by reading @milkdown/preset-gfm's own
// table/schema.ts, which builds both table_cell and table_header via
// prosemirror-tables' tableNodes({ cellContent: 'paragraph' }). That's
// categorically different from a plain top-level paragraph or a list item
// (listItemSchema's own content is 'paragraph block*', genuinely flexible) --
// a table cell has NO room for a sibling block at all. Several stock preset
// commands that insert a block-level node via ProseMirror's own
// `replaceSelectionWith` on a collapsed selection -- insertPagebreakCommand
// below (before this fix), plus @milkdown/preset-gfm's insertTableCommand
// and @milkdown/preset-commonmark's insertHrCommand, neither of which is
// this project's own code to patch -- don't refuse in that situation:
// replaceSelectionWith's fallback path (prosemirror-transform's
// replaceRange, reached whenever insertPoint() can't find a clean nearby
// escape) instead walks OUTWARD through table_row/table looking for ANY
// depth the node fits at. Measured directly: inserting a page break, a
// table, or a horizontal rule from inside one cell of a real 2x2 table each
// produced a corrupted THREE-TABLE document with the sibling cell's own
// content silently replaced by `<br />`. (wrapInBlockquoteCommand and
// createCodeBlockCommand do NOT share this failure -- both refuse cleanly
// inside a cell on their own, via wrapIn/setBlockType's real applicability
// checks -- so this guard is deliberately not applied to every command.)
//
// One shared implementation, exported so slash-items.ts (Task 4's palette
// catalogue) can apply the SAME guard to insertTableCommand/insertHrCommand
// at the call site -- the only place a guard CAN go for a command this
// project doesn't own the body of. insertPagebreakCommand uses it directly
// below, since that command IS ours. Walking every ancestor depth (not just
// the immediate parent) is deliberate -- $from.parent is the paragraph
// itself, and the table_cell/table_header is one level up.
export function isInsideTableCell(ctx: Ctx, state: EditorState): boolean {
  const cellType = tableCellSchema.type(ctx)
  const headerType = tableHeaderSchema.type(ctx)
  const $from = state.selection.$from
  for (let depth = $from.depth; depth >= 0; depth--) {
    const ancestorType = $from.node(depth).type
    if (ancestorType === cellType || ancestorType === headerType) return true
  }
  return false
}

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

    // See isInsideTableCell's own doc comment above for the real, measured
    // table-corruption bug this refuses outright rather than merely
    // reporting honestly on a dry run.
    if (isInsideTableCell(ctx, state)) return false

    const collapsed = TextSelection.create(state.doc, state.selection.from)
    const tr = state.tr.setSelection(collapsed).replaceSelectionWith(type.create())
    // Fix-round finding: this used to `return true` unconditionally, even on
    // a dry run (no dispatch), which is exactly the "reports applicable when
    // it's actually a no-op" bug the slash-menu palette's own isEnabled dry
    // run depends on NOT happening (see slash-items.ts). `tr.docChanged` is
    // the correct, general signal here: setSelection never adds a Step, so
    // this is true iff replaceSelectionWith genuinely inserted the pagebreak
    // node somewhere -- false for the (today, believed unreachable given the
    // slash menu's own paragraph-only gate, but not proven impossible for
    // every future caller) case where no valid insertion point exists at
    // all, distinct from the table-corruption case above, which is refused
    // explicitly rather than relying on this generic check to catch it.
    if (!tr.docChanged) return false
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

// This project's slash-command menu (built in a later task) needs three
// block insertions neither stock preset ships as a command: a task-list
// item, a $$-fenced math placeholder, and a Mermaid code-fence placeholder.
// All three below share one shape, deliberately: build (or capture) a
// SINGLE Transaction covering the whole operation, and only ever call the
// real `dispatch` once, at the very end, iff it was actually provided --
// exactly the dry-run-safe Command convention insertPagebreakCommand/
// addCommentCommand/resolveCommentCommand above already follow (a command
// invoked with no `dispatch` arg -- the standard ProseMirror "is this
// applicable right now" check -- must never mutate anything). That
// discipline ruled out the tempting alternative for the first two of these:
// dispatching a stock preset command (wrapInBulletListCommand,
// createCodeBlockCommand) via `ctx.get(commandsCtx).call(...)` and then
// dispatching a SECOND, separate transaction for the follow-up attribute/
// content change -- editor-commands.ts's own toggleBulletList already does
// exactly that chained-real-dispatch pattern, and it's fine there because
// that function is a direct UI entry point, never itself wrapped in
// $command's own (state, dispatch) contract. Here, going through
// commandsCtx.call() would dispatch for real UNCONDITIONALLY, even when
// THIS command was itself only being asked "are you applicable" with no
// dispatch -- and it would also split one logical user action into two
// separate undo steps. Capturing the wrapping/type-change transaction via a
// fake, non-dispatching callback and continuing to build on that SAME
// Transaction object (Transform methods mutate and return `this`, so
// further `.setNodeMarkup`/`.replaceWith` calls compose naturally) keeps
// each of these one atomic operation and one undo step, while still
// literally reusing the stock command's own underlying logic
// (wrapIn/setBlockType, the exact functions wrapInBulletListCommand/
// createCodeBlockCommand themselves call) rather than reimplementing it.

// No command in @milkdown/preset-gfm turns the current block into a task
// list item -- confirmed by reading its installed source
// (composed/inputrules.ts): the ONLY task-list-aware piece is
// wrapInTaskListInputRule, an $inputRule that fires on typing `[ ] `/`[x] `
// at the start of an ALREADY-EXISTING list_item, which sets `checked` via
// `tr.setNodeMarkup` on that item. There is no equivalent $command a
// keyboard shortcut, toolbar button, or (this project's) slash menu could
// call directly. This defines one, following that input rule's own
// verified recipe (re-read directly from the installed package, not
// recalled from memory): wrap the current block in a bullet list exactly
// like wrapInBulletListCommand does (`wrapIn(bulletListSchema.type(ctx))`),
// then flip the newly-created list_item's `checked` attr from `null`
// (a plain bullet) to `false` (an unchecked task) -- `extendListItemSchemaForTask`'s
// own toMarkdown runner (preset-gfm, read directly) only emits `- [ ] `/
// `- [x] ` syntax when `checked` is non-null, so `false` is what actually
// produces `- [ ] `, not merely "not checked."
//
// Fix-round change (capability-gap pass): the body below moved into the shared
// `buildTaskListTransaction` helper further down this file, so the toolbar's
// newly-wired Checklist button (toggleTaskListCommand) and this slash-menu
// entry cannot drift into producing different markdown. Nothing about this
// command's own behaviour changed -- see that helper for the wrapIn
// fake-dispatch capture technique and the walk-up-to-the-list_item reasoning
// this comment used to carry inline.
export const insertTaskListCommand = $command(
  'InsertTaskList',
  (ctx) => () => (state, dispatch) => {
    const tr = buildTaskListTransaction(ctx, state)
    if (!tr) return false
    dispatch?.(tr)
    return true
  }
)

// Milkdown has no math node at all -- `$$...$$` is parsed and rendered
// ONLY by the sandboxed pagination context's own remark-math pipeline (see
// CLAUDE.md's math-equations section); Milkdown's internal parse pipeline
// treats a `$$`-fenced block as inert plain text, confirmed directly by
// round-trip.test.ts's own "round-trips inline and block math markers as
// inert plain text" case. So there is no schema node to insert here either
// -- instead this builds the exact plain-text/hardbreak node sequence that
// was verified (via a throwaway probe against a real test editor, deleted
// after use -- see task-2-report.md) to round-trip byte-identically back
// to a real `$$\n...\n$$\n` fenced block: a textblock containing
// text("$$"), an INLINE hardbreak, the placeholder text, another inline
// hardbreak, then text("$$"). `isInline: true` on the hardbreak matters --
// hardbreakSchema's own toMarkdown runner (read directly) serializes an
// inline hardbreak as a literal `\n` text character, and a BLOCK hardbreak
// (the default, `isInline: false`) as a hard line break (two trailing
// spaces, per this project's pinned remark-stringify options) instead --
// which would NOT reparse as a `$$`-fenced block at all.
//
// REPLACES the current textblock's entire content, rather than inserting
// at the cursor -- verified necessary, not a style choice: an
// insert-at-cursor version was tried first (probed against a non-empty
// "Before text." paragraph) and produced
// `$$\nx^2\n$$Before text.\n` -- the closing `$$` fuses directly onto
// whatever followed the cursor with no separator, because inline content
// (text + inline hardbreaks) never forces ProseMirror to split the
// surrounding block the way a block-level atom (insertPagebreakCommand's
// own pagebreak node) does. A `$$`-fenced block only parses as block math
// when it's the sole content of its own paragraph (mirroring this
// codebase's own pagebreak-marker convention of requiring "sole content of
// its paragraph" -- see pagebreak-plugin.ts), so replacing the whole
// current block's content is what actually guarantees that shape, matching
// how insertMermaidBlockCommand below also replaces its target block's
// content wholesale rather than inserting into it.
//
// CONTRACT, not enforced by ProseMirror itself: this command replaces
// whatever the target block currently holds with NO confirmation and NO
// attempt to preserve it -- mirroring insertPagebreakCommand's own doc
// comment above, which documents a real, previously-shipped bug from doing
// the opposite (a ranged selection silently eaten by a naive
// `replaceSelectionWith`). Callers (the slash-menu palette, built in a
// later task) must only invoke this where the target block's content is
// genuinely expendable -- in practice, an empty or soon-to-be-cleared
// paragraph at the point the palette itself was triggered from, not
// arbitrary existing prose.
//
// Fix-round finding (verified by direct execution, not theorized): the
// original guard here was `!blockNode.isTextblock`, which is strictly
// BROADER than "is this a paragraph" -- a `heading` is a textblock too
// (`headingSchema.content = "inline*"`), and its content also passes the
// `validContent` check just below (hardbreak/text fit `inline*` fine). That
// let this command run against a heading like `## My Heading`: `applied`
// came back `true`, but the result was neither a working heading (its
// title text was gone, replaced by the math sequence) nor working math
// (only a PARAGRAPH's worth of content parses as `remark-math` block math,
// per this comment's own paragraph-requirement claim two paragraphs up --
// a heading never does), and `getMarkdown()` produced a broken
// `"$$\nx^2\n$$\n--\n"` -- mdast-util-to-markdown falling back to Setext
// underline syntax because the embedded raw newlines no longer round-trip
// as a clean ATX heading. Narrowing the guard to an exact paragraph-type
// check (rather than "any textblock") closes this: a heading, a table
// cell's own inline content, and any other non-paragraph textblock now all
// correctly refuse instead of silently corrupting. Table cells and list
// items are UNAFFECTED by this narrowing and stay working, because their
// own textblock child already IS a real `paragraph` node (confirmed by
// reading both schemas) -- this only newly refuses genuinely non-paragraph
// textblocks like headings.
export const insertMathBlockCommand = $command(
  'InsertMathBlock',
  (ctx) => () => (state, dispatch) => {
    const hardbreakType = hardbreakSchema.type(ctx)
    const paragraphType = paragraphSchema.type(ctx)
    const $from = state.selection.$from
    const blockNode = $from.parent
    // Exact paragraph-type check, not `isTextblock` -- see this command's
    // own doc comment above for the real heading-corruption bug this
    // guards against. `validContent` alone (below) is not enough on its
    // own: a heading's `inline*` content happily accepts a hardbreak too,
    // so it never rejects a heading by itself.
    if (blockNode.type !== paragraphType) return false

    const placeholder = 'x^2'
    const nodes = [
      state.schema.text('$$'),
      hardbreakType.create({ isInline: true }),
      state.schema.text(placeholder),
      hardbreakType.create({ isInline: true }),
      state.schema.text('$$')
    ]
    // Belt-and-suspenders: even restricted to a genuine paragraph, confirm
    // its schema can actually hold this exact node sequence before
    // mutating anything. `Fragment.from` + `validContent` is a pure,
    // read-only check.
    if (!blockNode.type.validContent(Fragment.from(nodes))) return false

    const blockStart = $from.before($from.depth)
    const contentStart = blockStart + 1
    const contentEnd = blockStart + blockNode.nodeSize - 1
    const tr = state.tr.replaceWith(contentStart, contentEnd, nodes)

    // Select the placeholder text (not the surrounding "$$"/hardbreaks) so
    // the very next keystroke types over it, per this task's own
    // requirement. Computed from fixed offsets rather than searched for,
    // since the sequence we just inserted is fully known: contentStart,
    // then text("$$") (2 chars), then one hardbreak (a leaf node, nodeSize
    // 1) -- verified against the probe's own dumped doc JSON, not assumed.
    const placeholderStart = contentStart + '$$'.length + hardbreakType.create().nodeSize
    const placeholderEnd = placeholderStart + placeholder.length
    dispatch?.(tr.setSelection(TextSelection.create(tr.doc, placeholderStart, placeholderEnd)))
    return true
  }
)

// createCodeBlockCommand (@milkdown/preset-commonmark) already does exactly
// what a "insert a Mermaid diagram" slash-menu entry needs for the STRUCTURAL
// half -- `setBlockType(codeBlockSchema.type(ctx), { language })` turns the
// current block into a fenced code block carrying that language, and
// codeBlockSchema's own toMarkdown runner (read directly) already emits
// ```mermaid fences for it with zero extra work. What's missing is placeholder
// CONTENT: calling createCodeBlockCommand alone converts the block but leaves
// whatever text (or nothing) was already there, producing an empty
// ```mermaid``` fence a user has to know to fill in themselves.
//
// Same "capture the stock command's transaction, keep building on it, dispatch
// once" shape as insertTaskListCommand above, and the same "REPLACE the whole
// target block's content" shape as insertMathBlockCommand above -- verified
// necessary here too, for a related but distinct reason: this command's very
// first probe (inserting the placeholder at `selection.from` after conversion,
// rather than replacing the block's content) prepended the placeholder before
// whatever text the block already held (`graph TD;\n  A-->B;Hello world.`,
// all one code_block, since a code_block's `text*` content has no block
// boundary to split on the way a table/paragraph split would) -- replacing
// the block's content outright, the same fix insertMathBlockCommand needed,
// avoids that regardless of what the block contained before conversion.
//
// CONTRACT, not enforced by ProseMirror itself, same as insertMathBlockCommand
// above: this command replaces whatever the target block currently holds with
// NO confirmation and NO attempt to preserve it. Unlike insertMathBlockCommand,
// there is deliberately no paragraph-only guard here -- `setBlockType` (the
// same underlying function createCodeBlockCommand itself calls) already
// converts ANY qualifying textblock, headings included, into a code_block,
// which is ordinary, expected stock behavior (the same thing typing a code
// fence's own input rule while the cursor is in a heading would do), not a
// new correctness bug this command introduces. Callers (the slash-menu
// palette, built in a later task) must still only invoke this where the
// target block's content is genuinely expendable, for the same reason
// insertMathBlockCommand's own contract note gives.
export const insertMermaidBlockCommand = $command(
  'InsertMermaidBlock',
  (ctx) => () => (state, dispatch) => {
    const codeBlockType = codeBlockSchema.type(ctx)

    // Fake dispatch, same technique as insertTaskListCommand's wrapIn
    // capture above: setBlockType's own dispatch branch is
    // `dispatch(tr)` where `tr` already has every per-range
    // `tr.setBlockType(...)` step applied (read directly from
    // prosemirror-commands) -- capturing it here gets the real Transaction
    // without applying it to any EditorState, so a dry-run (no `dispatch`
    // passed to THIS command) still does nothing.
    let captured: Transaction | undefined
    const applicable = setBlockType(codeBlockType, { language: 'mermaid' })(state, (tr) => {
      captured = tr
    })
    if (!applicable || !captured) return false

    // setBlockType changes a textblock's own type in place -- it doesn't
    // change nesting depth or wrap anything -- so the just-converted node is
    // simply `$from.parent` at the (auto-mapped) selection, unlike
    // insertTaskListCommand's list_item, which is a NEW ancestor wrapIn just
    // introduced and has to be searched for. The type check is a defensive
    // backstop matching insertTaskListCommand's own `itemPos == null` guard,
    // not an expected-to-fire branch.
    const $from = captured.selection.$from
    const blockNode = $from.parent
    if (blockNode.type !== codeBlockType) return false

    const blockStart = $from.before($from.depth)
    const contentStart = blockStart + 1
    const contentEnd = blockStart + blockNode.nodeSize - 1
    const placeholder = 'graph TD;\n  A-->B;'
    captured.replaceWith(contentStart, contentEnd, state.schema.text(placeholder))

    // Land the cursor at the end of the placeholder (not selecting it) --
    // unlike the math placeholder, this text is a real, runnable diagram
    // example on its own, not a "type over me" stand-in the task brief asked
    // to keep selected, so a plain "continue editing from here" cursor
    // position (the same place typing the placeholder by hand would have
    // left it) is the more useful default.
    const cursorPos = contentStart + placeholder.length
    dispatch?.(captured.setSelection(TextSelection.create(captured.doc, cursorPos)))
    return true
  }
)

// ---------------------------------------------------------------------------
// Table structure editing
// ---------------------------------------------------------------------------
//
// @milkdown/preset-gfm registers real, working commands for adding a row or a
// column (addRowBeforeCommand/addRowAfterCommand/addColBeforeCommand/
// addColAfterCommand) and this project wires those straight through -- see
// editor-commands.ts. The three commands below exist because the preset's own
// equivalents are NOT usable from an ordinary caret, which is the only
// selection a user typing in a table actually has:
//
//   - `deleteSelectedCellsCommand` opens with `if (!(selection instanceof
//     CellSelection)) return false` (read from the installed 7.21.3 source).
//     A caret in a cell is a TextSelection, so it refuses. Reaching it would
//     mean first dispatching selectRowCommand/selectColCommand, i.e. moving
//     the user's selection as a side effect of a delete.
//   - `setAlignCommand` is `setCellAttr('alignment', ...)`, which writes only
//     the cell(s) the selection covers -- and a body cell's alignment attr
//     neither serializes nor survives. See table-context.ts's
//     `readColumnAlignment` for the two preset facts that make that true.
//
// prosemirror-tables' own `deleteRow`/`deleteColumn`/`deleteTable` (which is
// exactly what `deleteSelectedCellsCommand` itself delegates to, and which
// @milkdown/prose/tables re-exports) already handle BOTH cases correctly: each
// resolves `selectedRect(state)`, which is the current cell for a caret and
// the full covered rectangle for a CellSelection -- so selecting three rows
// and hitting delete removes all three, with no branch of our own.
//
// All three are plain pass-throughs, so a dry run (no `dispatch`) stays a dry
// run: prosemirror-tables' commands follow the standard convention.

export const deleteTableRowCommand = $command(
  'DeleteTableRow',
  () => () => (state, dispatch) => deleteRow(state, dispatch)
)

export const deleteTableColumnCommand = $command(
  'DeleteTableColumn',
  () => () => (state, dispatch) => deleteColumn(state, dispatch)
)

export const deleteWholeTableCommand = $command(
  'DeleteWholeTable',
  () => () => (state, dispatch) => deleteTable(state, dispatch)
)

// Sets a whole COLUMN's alignment -- header cell included, which is the only
// cell markdown carries (see table-context.ts's readColumnAlignment for the
// two preset facts, read out of the installed source, that make the preset's
// own setAlignCommand wrong here: the header row is what serializes, and
// keepTableAlignPlugin overwrites every body cell from it on the next
// transaction anyway).
//
// Writes every cell in the column rather than only the header, even though
// keepTableAlignPlugin would eventually propagate a header-only write: that
// propagation happens in a SEPARATE appendTransaction, so a header-only write
// would repaint the table in two steps and leave two entries in the undo
// history for one click. Writing the column outright makes the change atomic
// and leaves that plugin with nothing to do.
export const setColumnAlignmentCommand = $command(
  'SetColumnAlignment',
  () => (alignment?: TableAlignment) => (state, dispatch) => {
    if (!alignment) return false
    const context = findTableContext(state)
    if (!context) return false
    if (context.alignment === alignment) return false

    const positions = columnCellPositions(state, context)
    if (positions.length === 0) return false

    const tr = state.tr
    for (const pos of positions) {
      const cell = state.doc.nodeAt(pos)
      if (!cell) continue
      tr.setNodeMarkup(pos, undefined, { ...cell.attrs, alignment })
    }
    if (!tr.docChanged) return false
    dispatch?.(tr)
    return true
  }
)

// Tab on the LAST cell of a table appends a row and moves into it.
//
// The gap this closes, measured rather than assumed: @milkdown/preset-gfm's
// `tableKeymap` binds Tab to `goToNextTableCellCommand`, which is
// prosemirror-tables' `goToNextCell(1)` -- and that returns FALSE when there
// is no next cell (`findNextCell` returns null past the last one). So Tab in
// the bottom-right cell of a table did nothing at all, and the only way to add
// a row was a control that did not exist. Appending on Tab is the single most
// expected table behaviour there is (Word, Google Docs, Notion all do it).
//
// A `$prose` plugin's `handleKeyDown`, NOT a `$useKeymap` entry, and that is
// forced rather than preferred: `tableKeymap`'s NextCell binding carries
// `priority: 100`, and Milkdown merges EVERY keymap into ONE ProseMirror
// plugin, so priority is resolved internally to that plugin and a second
// keymap cannot outrank it. A `$prose` plugin lands in `prosePlugins`, which
// @milkdown/core's own editor-state.ts places BEFORE that merged keymap in
// `state.plugins`, and prosemirror-view returns on the first truthy handler --
// the same mechanism slash-plugin.ts already relies on and documents.
//
// Deliberately narrow, so nothing else changes: it returns false (letting the
// preset's own binding run, exactly as before) for any modifier combination,
// for Shift-Tab, outside a table, and -- crucially -- whenever a next cell
// genuinely exists. That last check is a real DRY RUN: prosemirror-tables'
// goToNextCell only mutates when handed a `dispatch`, so calling it with the
// state alone answers "is there a next cell?" without moving anything.
export const tableTabProse = $prose((ctx) => {
  return new Plugin({
    props: {
      handleKeyDown: (view, event) => {
        if (event.key !== 'Tab') return false
        if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false
        if (!isInTable(view.state)) return false
        // A next cell exists -- let the preset's own Tab binding move to it.
        if (goToNextCell(1)(view.state)) return false

        event.preventDefault()
        // The preset's own addRowAfterCommand, not prosemirror-tables' bare
        // addRowAfter: the preset wraps it in `addRowWithAlignment`, which
        // copies each column's alignment onto the new row's cells. A bare
        // addRowAfter would create cells at the schema default ('left') and
        // leave keepTableAlignPlugin to fix them up in yet another
        // transaction.
        ctx.get(commandsCtx).call(addRowAfterCommand.key)
        // Now that a row exists after the current one, the "next cell" the
        // user asked for does too. Dispatched separately, which merges into
        // the same undo group as the insertion above by prosemirror-history's
        // ordinary adjacency rule (both land well inside newGroupDelay).
        goToNextCell(1)(view.state, view.dispatch)
        return true
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Task list toggle
// ---------------------------------------------------------------------------

// The shared body of insertTaskListCommand (above) and toggleTaskListCommand
// (below): wrap the current block in a bullet list and flip the resulting
// list_item's `checked` attr from null (a plain bullet) to false (an unchecked
// task). Extracted rather than copied so the toolbar's Checklist button and
// the slash menu's "Task list" item cannot drift into producing different
// markdown. Returns the built Transaction, or null when the current selection
// cannot be wrapped in a list at all -- never dispatches, so both callers stay
// dry-run safe.
function buildTaskListTransaction(ctx: Ctx, state: EditorState): Transaction | null {
  const listType = bulletListSchema.type(ctx)
  const itemType = listItemSchema.type(ctx)

  let captured: Transaction | undefined
  const applicable = wrapIn(listType)(state, (tr) => {
    captured = tr
  })
  if (!applicable || !captured) return null

  const $pos = captured.selection.$from
  let itemPos: number | null = null
  for (let depth = $pos.depth; depth >= 0; depth--) {
    if ($pos.node(depth).type === itemType) {
      itemPos = $pos.before(depth)
      break
    }
  }
  if (itemPos == null) return null

  const itemNode = captured.doc.nodeAt(itemPos)
  if (!itemNode) return null

  captured.setNodeMarkup(itemPos, undefined, { ...itemNode.attrs, checked: false })
  return captured
}

// The nearest ancestor list_item of the selection, whether or not it is a task
// item. `checked` distinguishes the two: null (or absent) is an ordinary
// bullet, false/true is an unchecked/checked task -- that is
// extendListItemSchemaForTask's own convention, whose toMarkdown runner only
// emits `- [ ] `/`- [x] ` syntax for a non-null value.
function findListItem(ctx: Ctx, state: EditorState): { pos: number; node: ProseNodeLike } | null {
  const itemType = listItemSchema.type(ctx)
  const $from = state.selection.$from
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type !== itemType) continue
    return { pos: $from.before(depth), node }
  }
  return null
}

// Minimal structural shape of the bits of a ProseMirror Node used above --
// avoids importing the Node type purely for one field, matching how the rest
// of this file leans on inference.
interface ProseNodeLike {
  attrs: Record<string, unknown>
}

// A real TOGGLE, unlike insertTaskListCommand: already a task item -> back to
// a plain bullet (`checked: null`); anything else -> a task item. Backs the
// toolbar's Checklist button, which sits alongside the bullet/numbered list
// buttons and must behave like them (both of those lift you back out).
//
// insertTaskListCommand is deliberately NOT replaced by this. The slash menu's
// "Task list" entry means "insert one", and an insertion that silently
// un-tasked the block when it happened to already be a task would be wrong
// there; the shared helper above is what keeps the two from drifting.
export const toggleTaskListCommand = $command(
  'ToggleTaskList',
  (ctx) => () => (state, dispatch) => {
    // ALREADY IN A LIST -- including a plain, non-task bullet. Flipping
    // `checked` in place is the whole operation here; wrapping again (which
    // buildTaskListTransaction would do) produces a NESTED list, which is not
    // what a Checklist toggle means and was a real failure caught by this
    // command's own test, not by inspection.
    const existing = findListItem(ctx, state)
    if (existing) {
      const isTask =
        existing.node.attrs.checked !== null && existing.node.attrs.checked !== undefined
      const tr = state.tr.setNodeMarkup(existing.pos, undefined, {
        ...existing.node.attrs,
        checked: isTask ? null : false
      })
      dispatch?.(tr)
      return true
    }
    const tr = buildTaskListTransaction(ctx, state)
    if (!tr) return false
    dispatch?.(tr)
    return true
  }
)

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

// Removes the link mark from the WHOLE link under the selection, not merely
// from the selected characters.
//
// `toggleLinkCommand` cannot do this job, and the difference is not cosmetic.
// It is a plain `toggleMark`, so with a collapsed caret inside a link it only
// clears a stored mark (the visible link is untouched), and with a partial
// selection it splits one link into a linked and an unlinked half. "Remove
// link", pressed with the caret anywhere in a link, has exactly one sensible
// meaning, so this finds the mark's own full extent the same way
// @milkdown/preset-commonmark's `updateLinkCommand` does (a `nodesBetween`
// scan widened to `to + 1` for the collapsed case) and removes it there.
export const unlinkCommand = $command('Unlink', (ctx) => () => (state, dispatch) => {
  const linkType = linkSchema.type(ctx)
  const { from, to } = state.selection
  let markedFrom = -1
  let markedTo = -1
  let mark: Mark | undefined
  state.doc.nodesBetween(from, from === to ? to + 1 : to, (node, pos) => {
    if (mark) return false
    const found = node.marks.find((candidate: Mark) => candidate.type === linkType)
    if (!found) return true
    mark = found
    markedFrom = pos
    markedTo = pos + node.nodeSize
    return false
  })
  if (!mark) return false
  dispatch?.(state.tr.removeMark(markedFrom, markedTo, mark))
  return true
})

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
  // The three new block-insertion commands this task adds -- see each of
  // their own doc comments above. Behavior plugins, not schema (same
  // reasoning as insertPagebreakCommand immediately above): none of them
  // introduces a new node/mark type, so none belongs in plugins.ts's
  // EDITOR_SCHEMA_PLUGINS or round-trip.test.ts's coverage of it.
  insertTaskListCommand,
  insertMathBlockCommand,
  insertMermaidBlockCommand,
  // Capability-gap pass: table structure editing (row/column delete, column
  // alignment), the Checklist toolbar button's real toggle, and "Remove link".
  // Behavior plugins, not schema -- none introduces a node or mark type -- so
  // they belong here rather than in plugins.ts's EDITOR_SCHEMA_PLUGINS, same
  // reasoning as every entry above.
  deleteTableRowCommand,
  deleteTableColumnCommand,
  deleteWholeTableCommand,
  setColumnAlignmentCommand,
  toggleTaskListCommand,
  unlinkCommand,
  // Tab-appends-a-row. A $prose plugin rather than a keymap, which is what
  // lets it outrank @milkdown/preset-gfm's own priority-100 Tab binding --
  // see its own doc comment.
  tableTabProse,
  // See image-security.ts's own module comment for the real, confirmed
  // vulnerability this closes: the stock commonmark image node renders an
  // unrestricted <img src> directly in this privileged renderer. Rendering
  // behavior, not schema (round-trip fidelity for image syntax is
  // untouched), so this belongs here alongside historyProse/undoCommand,
  // not in plugins.ts's EDITOR_SCHEMA_PLUGINS.
  safeImageViewProse
].flat()
