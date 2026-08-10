import { editorViewCtx, type Editor } from '@milkdown/core'
import type { Ctx } from '@milkdown/ctx'
import { callCommand } from '@milkdown/utils'
import { NodeSelection, Selection, TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  wrapInHeadingCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  liftListItemCommand,
  toggleLinkCommand,
  updateLinkCommand
} from '@milkdown/preset-commonmark'
import {
  addColAfterCommand,
  addColBeforeCommand,
  addRowAfterCommand,
  addRowBeforeCommand,
  insertTableCommand
} from '@milkdown/preset-gfm'
import {
  undoCommand,
  redoCommand,
  insertPagebreakCommand,
  addCommentCommand,
  resolveCommentCommand,
  deleteTableRowCommand,
  deleteTableColumnCommand,
  deleteWholeTableCommand,
  setColumnAlignmentCommand,
  toggleTaskListCommand,
  unlinkCommand
} from './commands'
import type { TableAlignment } from './table-context'
import {
  applyFindState,
  replaceActiveMatchIn,
  replaceAllMatchesIn,
  type FindStateInput
} from './find-plugin'
import { findAncestorListType, markActive, readSelectionRect, readTableRect } from './selection-plugin'
import { slashPluginKey, closeSlashIn, runSlashItemIn, setActiveSlashIndexIn } from './slash-plugin'
import { enabledSlashItems, type SlashItem } from './slash-items'
import type { Rect } from '../lib/floating-position'

// This is a separate file from MilkdownEditor.tsx (fix-round change) purely
// for eslint-plugin-react-refresh's `only-export-components` rule -- a
// component file may only export React components (plus type-only exports),
// and buildEditorCommands below is a plain function. No behavior changed by
// this move; MilkdownEditor.tsx imports everything from here unchanged.

// True heading level 1-6 (`headingSchema`'s own `level` attr, from
// @milkdown/preset-commonmark's source), narrowed to 1-3 here because
// that's all the mockup's paragraph-style dropdown ("Normal text"/H1/H2/H3)
// exposes -- see EditorToolbar.tsx.
export type ToggleableHeadingLevel = 1 | 2 | 3

// findAncestorListType MOVED to selection-plugin.ts (bubble-menu sub-project)
// and is imported above rather than reimplemented. Its own reasoning is
// unchanged and now lives with the definition; the reason for the move is
// that the bubble/toolbar's list ACTIVE state must be computed by the exact
// same ancestor walk the toggle commands below branch on, or the indicator and
// the action can disagree. Its signature changed from (view) to (state) in the
// same move -- it only ever read `view.state.selection` -- which is why the
// call sites below pass `view.state`.

// The formatting-toolbar command surface -- everything MilkdownEditorHandle
// exposes besides flush() (which stays in MilkdownEditor.tsx, since it
// depends on editedSinceMountRef, a piece of that component's own mount
// lifecycle, not just a live Editor instance).
//
// Everything below dispatches directly into the live Milkdown `Editor` via
// `editor.action(callCommand(commandKey, payload))` -- verified empirically
// to be the correct mechanism for calling a command from outside the
// editor's own keymap/input-rule machinery, the same way
// MilkdownEditor.test.tsx's own "API pattern verification" block already
// verifies @milkdown/plugin-listener's behavior directly against a real
// Editor instance rather than assuming its shape from memory. Each command
// key referenced here is a REAL exported constant from
// @milkdown/preset-commonmark/@milkdown/preset-gfm (or this project's own
// commands.ts for the three this project had to define itself:
// undo/redo/insertPageBreak), confirmed by reading each package's own
// .d.ts/.ts source under node_modules -- none of these names were assumed
// from memory.
//
// All of these are no-ops (never throw) if called before the editor has
// finished constructing or after it has been destroyed -- MilkdownEditor.tsx
// only assigns its commandsRef once buildEditorCommands has actually run
// against a created Editor, and clears it back to null on unmount/destroy.
export interface EditorCommands {
  // toggleStrongCommand -- a genuine ProseMirror `toggleMark`, so this is a
  // real toggle: bold text becomes un-bold, and vice versa.
  toggleBold: () => void
  // toggleEmphasisCommand -- same toggleMark-backed behavior as bold.
  toggleItalic: () => void
  // toggleInlineCodeCommand -- @milkdown/preset-commonmark's own command,
  // exported and keymapped (Mod-e) by that preset since before this project
  // existed, but never reachable from this app's own UI until the selection
  // bubble needed it. NOT a plain toggleMark, unlike bold/italic: reading its
  // source, it refuses a collapsed selection outright (`if (selection.empty)
  // return false`, so there is no stored-mark behaviour to speak of) and, when
  // applying, first STRIPS every other mark from the range -- correct for
  // Markdown, where inline code is a verbatim span that cannot itself be bold
  // or a link, and worth knowing before wiring it to anything that assumes
  // toggleMark semantics.
  toggleInlineCode: () => void
  // wrapInHeadingCommand is NOT a toggle by itself (confirmed by reading its
  // source: it always calls `setBlockType` to the given level, with no
  // "already this level, so revert to paragraph" branch) -- this method adds
  // that check itself: if the current block is already an `h{level}`,
  // it turns it back into a plain paragraph (wrapInHeadingCommand's own
  // documented level-0 behavior, per its source), otherwise it sets the
  // block to that heading level. Only levels 1-3 are exposed, matching the
  // mockup's paragraph-style dropdown (Normal text/H1/H2/H3).
  toggleHeading: (level: ToggleableHeadingLevel) => void
  // Unconditionally converts the current block to a plain paragraph, via
  // wrapInHeadingCommand's own documented "level below 1" behavior (`0`) --
  // NOT contingent on already knowing the active heading level, contrary to
  // an earlier, incorrect version of this file's own comment here (fixed in
  // the same review round that added this method): wrapInHeadingCommand(0)
  // converts to a paragraph regardless of the block's current type, exactly
  // like wrapInHeadingCommand(2) sets it to h2 regardless of current type.
  // Backs EditorToolbar's paragraph-style dropdown's "Normal text" option.
  setParagraph: () => void
  // wrapInBulletListCommand also isn't a toggle by itself (it's a plain
  // ProseMirror `wrapIn`) -- this method adds the real three-way check
  // (findAncestorListType above): already a bullet list -> lift out; inside
  // an ORDERED list -> lift out of that first, then wrap in a bullet list
  // (switches type, rather than wrapIn's own silent no-op when attempted
  // directly against an existing list of the other type -- verified: DOM
  // byte-identical before/after a direct wrap attempt while already inside
  // an ordered_list); not in any list -> wrap.
  toggleBulletList: () => void
  // Same three-way treatment as toggleBulletList, for wrapInOrderedListCommand.
  toggleOrderedList: () => void
  // Applies a link, and -- as of the capability-gap pass -- CORRECTLY updates
  // one that already exists.
  //
  // This used to be `toggleLinkCommand` unconditionally, which actively
  // DESTROYED user content on the most obvious gesture there is: select an
  // existing link, submit a corrected URL. `toggleLinkCommand` is a plain
  // `toggleMark`, and prosemirror-commands' toggleMark defaults
  // `removeWhenPresent` to true and branches on `rangeHasMark(..., markType)`
  // ALONE -- the attrs it is handed are not consulted at all when deciding
  // between add and remove (read directly from prosemirror-commands' source).
  // So submitting a new href over already-linked text ran `tr.removeMark(...)`:
  // the link was stripped and the typed URL thrown away, with no error and no
  // indication. Submitting a second time re-added it, which is how the bug
  // masqueraded as "you have to do it twice."
  //
  // @milkdown/preset-commonmark ships exactly the right command for the
  // already-linked case, `updateLinkCommand`, and it was never imported
  // anywhere in this project. It finds the existing mark's own full extent and
  // rewrites its attrs in place, so the link survives and the URL changes.
  // Branching on `markActive` (selection-plugin.ts's shared predicate, the
  // same one that drives the bubble's pressed state) is what picks between the
  // two -- so what the UI reports and what this does cannot disagree.
  insertLink: (href: string) => void
  // Removes the link mark from the whole link under the selection. See
  // unlinkCommand (commands.ts) for why toggleLinkCommand cannot serve as
  // "unlink" (it splits a link in half on a partial selection, and does
  // nothing visible at all from a bare caret).
  removeLink: () => void
  // insertTableCommand, given `{ row: 2, col: 2 }` -- a minimal 2x2 table
  // (one header row + one body row, two columns; `row` counts the header
  // row, confirmed by reading @milkdown/preset-gfm's own createTable source).
  insertTable: () => void
  // ---- Table structure editing (capability-gap pass) -------------------
  // Until this pass, `insertTable` above was the ONLY one of @milkdown/
  // preset-gfm's fifteen registered table commands reachable from any UI in
  // this app: no toolbar item, no slash item, no bubble item, no keybinding.
  // A user who inserted a 2x2 table could type in it and nothing else -- and
  // this app ships Invoice and Report templates built on tables, where
  // "I need one more line item" was a dead end.
  //
  // The four add-* methods are straight pass-throughs to the preset's own
  // commands (which are correct from a plain caret, unlike its delete and
  // align commands -- see commands.ts). The three delete methods and
  // setColumnAlignment go through this project's own commands for the
  // reasons documented there.
  addRowBefore: () => void
  addRowAfter: () => void
  addColumnBefore: () => void
  addColumnAfter: () => void
  deleteRow: () => void
  deleteColumn: () => void
  deleteTable: () => void
  setColumnAlignment: (alignment: TableAlignment) => void
  // toggleTaskListCommand (commands.ts) -- backs the toolbar's Checklist
  // button, which had no backing command at all until this pass despite GFM
  // task lists being fully supported end to end (the Meeting Notes template
  // already uses them, `@milkdown/preset-gfm` has a real
  // extendListItemSchemaForTask node, and the sanitize schema already allows
  // the checkbox markup).
  toggleTaskList: () => void
  // insertPagebreakCommand (commands.ts) -- inserts this editor's own
  // existing pagebreak atom node (nodes/pagebreak.ts) at the current
  // selection, reusing the schema this editor already mounts rather than
  // introducing a second way to represent a page break. Collapses a
  // non-empty selection to its start first (commands.ts's own fix-round
  // comment) so a page break inserted over selected text doesn't delete it.
  insertPageBreak: () => void
  // undoCommand/redoCommand (commands.ts) -- prosemirror-history's own
  // `undo`/`redo`, exposed as real Milkdown commands. Wiring in
  // prosemirror-history (via commands.ts's historyProse plugin) for the
  // first time in this project required re-verifying MilkdownEditor.tsx's
  // editedTrackerProse's `addToHistory !== false` exclusion still can't hide
  // a genuine content change -- see commands.ts's own comment for the
  // verified result (it can't: prosemirror-history's undo/redo transactions
  // don't set `addToHistory: false` on themselves).
  undo: () => void
  redo: () => void
  // Moves the selection to the end of the document and focuses the editor
  // -- backs EditorScreen's page-card click handler (a click on the page's
  // own blank space, below the last real line, should behave like clicking
  // in a real document: move the cursor to the nearest actual position,
  // not silently do nothing). Genuinely needs ProseMirror's own dispatch
  // mechanism, not a DOM-level workaround: tried first and reverted,
  // verified NOT to work -- neither manually setting the native Selection/
  // Range then calling element.focus(), nor dispatching synthetic
  // mousedown/mouseup MouseEvents at a computed coordinate, actually moved
  // focus or the visible cursor (confirmed via document.activeElement
  // staying <body> and the native Selection landing somewhere unrelated in
  // both cases) -- ProseMirror's EditorView owns its own selection state
  // and only a real transaction dispatched through it (or a genuine,
  // OS-trusted input event, which JS-dispatched synthetic events are not)
  // actually moves it.
  //
  // Review-round finding (verified empirically, not theorized -- see this
  // method's own implementation comment below): plain `Selection.atEnd`
  // is NOT always a safe "cursor at the nearest real position" -- when the
  // document's LAST top-level block is a selectable atom with nothing
  // after it (this schema's pagebreak and frontmatter nodes both qualify,
  // and doc's own content expression is "block+", so a document that's
  // genuinely nothing but a trailing pagebreak, or nothing but
  // frontmatter, is real schema-valid content, not a contrived case), it
  // resolves to a NodeSelection over that atom rather than a collapsed
  // text cursor -- and the very next keystroke then REPLACES (deletes)
  // that node, per ProseMirror's ordinary "typing over a NodeSelection"
  // behavior. The implementation below special-cases this.
  focusEnd: () => void
  // Pushes the find bar's current query/options/cursor into the mounted find
  // plugin (find-plugin.ts) and, when the active match changes, selects and
  // scrolls to it -- see applyFindState's own doc comment for why selecting
  // (rather than only decorating) is the right move and why it deliberately
  // does not steal focus.
  setFindState: (next: FindStateInput) => void
  // Replaces the currently active match with literal text, inheriting the
  // marks at the match's start. A no-op when there is no active match.
  replaceActiveMatch: (replacement: string) => void
  // Replaces every current match in ONE transaction, i.e. one undo step.
  replaceAllMatches: (replacement: string) => void
  // The document text under the current selection, or '' when the selection
  // is collapsed -- backs Cmd/Ctrl+F seeding the query from whatever the user
  // had selected, the way every editor does.
  getSelectedText: () => string
  // The selection's on-screen box, in viewport coordinates, or null when it
  // can't be measured -- the GEOMETRY half of the selection bubble's contract
  // (selection-plugin.ts reports state; this reports where it is; React does
  // layout). Deliberately a pull, not a push: the bubble must re-measure on
  // scroll and resize, neither of which produces a ProseMirror transaction, so
  // a snapshot carrying a rect would go stale with nothing to invalidate it.
  // See readSelectionRect (selection-plugin.ts) for the zoom-transform
  // reasoning and the measured jsdom hazard before writing any test against it.
  getSelectionRect: () => Rect | null
  // The enclosing TABLE's on-screen box, for a COLLAPSED selection inside a
  // table only; null otherwise. The bubble anchors to this instead of the
  // caret in that one case, because a caret anchor cannot be kept fresh there
  // -- see readTableRect's own doc comment for the sameSnapshot interaction
  // that makes a caret anchor go stale, and why a table rect does not.
  getTableRect: () => Rect | null
  // addCommentCommand (commands.ts) -- applies a real comment mark over the
  // current selection. Returns the command's own boolean result (`editor.
  // action()` returns whatever the wrapped action returns, and callCommand's
  // return type is genuinely `(ctx) => boolean`, not void) so the caller
  // (CommentComposer.tsx) can show a real error rather than silently doing
  // nothing when the selection is empty or spans more than one block -- see
  // addCommentCommand's own doc comment for the exact refusal conditions.
  addComment: (author: string, text: string) => boolean
  // resolveCommentCommand (commands.ts) -- removes every mark instance for
  // the given comment id, anywhere in the document.
  resolveComment: (id: string) => void
  // Runs the slash-menu item with this `id` against the LIVE session
  // (slash-plugin.ts's own slashPluginKey state) -- reads anchorPos/queryEnd
  // fresh at call time rather than accepting them as parameters, so a caller
  // (SlashMenu's onChoose, via hooks/useSlashMenu.ts) can never pass a range
  // computed before some other edit landed. session.queryEnd is used as the
  // delete range's own `to` rather than re-deriving `anchorPos + 1 +
  // query.length` by hand -- they're always equal (both are set from the
  // SAME selection.from inside slash-plugin.ts's own tryOpen/advanceSession),
  // and reusing the field avoids a second, hand-copied formula that could
  // silently drift from buildDecorations' identical one.
  //
  // Fix round 1, IMPORTANT I2: `id` is looked up against
  // slash-items.ts's enabledSlashItems(ctx, state, session.query) -- the
  // CURRENTLY-ENABLED subset -- not the full, unfiltered SLASH_ITEMS. This
  // is a PUBLIC method, reachable from anywhere holding the handle, so a
  // stale/forged id for a currently-disabled item (most acutely,
  // math-block/mermaid-diagram outside the narrow window where running them
  // is safe) must be refused, not merely "not expected in practice." A
  // no-op (mutates nothing) when no session is open or `id` doesn't resolve
  // against that enabled list.
  runSlashItem: (id: string) => void
  // Closes the current slash-menu session, if one is open, WITHOUT touching
  // the "/query" text itself -- the exact closeSlashIn (slash-plugin.ts) the
  // plugin's own Escape/blur handling already calls internally. Exposed on
  // the handle for the one real gap those two don't cover: a keyboard-only
  // overlay trigger (EditorScreen's Mod-/ opening ShortcutsHelpModal) fires
  // from a bare `window` listener with no click on any focusable element, so
  // nothing blurs the editor DOM node and the plugin's own blur-close never
  // runs -- see EditorScreen.tsx's own shortcuts-help keydown effect for the
  // one real call site this exists for today.
  closeSlashMenu: () => void
  // The catalogue's own currently-offered item list for `query`, evaluated
  // against the LIVE document state via slash-items.ts's enabledSlashItems
  // -- the EXACT formula MilkdownEditor.tsx's own countMatching closure
  // (constructed in its mount effect, fed into createSlashPlugin) also uses,
  // so the two structurally cannot disagree about how many items exist (see
  // slash-plugin.ts's own CountMatching doc comment for the real "13 counted
  // vs 11 rendered" desync fix round 1 of the item-catalogue task found and
  // closed -- this is what stops Task 5's own wiring from reintroducing it).
  // Returns [] before the editor has finished constructing, matching
  // getSelectedText's own empty-string fallback for the identical reason.
  getSlashItems: (query: string) => SlashItem[]
  // Moves the slash session's activeIndex directly to `index` -- backs
  // SlashMenu's onHover (pointer hover should move the highlight, and a
  // SUBSEQUENT ArrowDown/Up should continue from there, not from wherever
  // the keyboard last left it, matching ordinary command-palette UX).
  // setActiveSlashIndexIn (slash-plugin.ts) is the exact dispatch
  // handleKeyDown's own ArrowDown/Up branch already uses internally,
  // exported so this is the SAME mechanism moving the SAME plugin-owned
  // pointer -- not a second, React-local copy that could disagree with it
  // the next time a key press moves the index instead of a hover.
  setActiveSlashIndex: (index: number) => void
}

// Selector for chooseSlashItem below: the KEYBOARD path (MilkdownEditor.tsx's
// slashProse onChooseActive, fired from Enter/Tab) resolves against the
// session's own plugin-owned activeIndex; the CLICK/imperative-handle path
// (runSlashItem below, called from SlashMenu's onChoose) resolves against a
// stable item id. Both selectors resolve into the SAME enabled-and-filtered
// list -- see chooseSlashItem's own doc comment for why that must be true.
export type SlashItemSelector = { index: number } | { id: string }

// THE single formula standing between the user and silent data loss from a
// block-replacing item (math-block/mermaid-diagram, see slash-items.ts's
// isTargetBlockEmptyAfterQueryRemoved) chosen against an unsafe target block.
// Reads the LIVE session (slashPluginKey.getState(view.state)), re-derives
// the CURRENTLY-ENABLED item list fresh via enabledSlashItems -- the
// isEnabled-aware subset, never the full unfiltered SLASH_ITEMS -- resolves
// one item against `selector`, and runs it via runSlashItemIn (delete the
// "/query" text, then run the item, as two synchronous dispatches).
//
// Fix round (final review, items 1+2): previously duplicated verbatim in TWO
// places -- MilkdownEditor.tsx's slashProse onChooseActive closure (the
// keyboard path) and this file's own runSlashItem (the click path). They
// differed only in how they picked an item out of the identical enabled
// list, and that duplication was not merely untidy: the KEYBOARD copy had
// ZERO regression coverage of its own safety gate until this fix round
// (MilkdownEditor.test.tsx's mid-paragraph "math-block disabled" test only
// ever exercised the id-based CLICK path) -- a mutation swapping
// enabledSlashItems(ctx, view.state, session.query) for the raw, unfiltered
// filterSlashItems(SLASH_ITEMS, session.query) in the keyboard copy alone
// left every test in this codebase AND Gate 29 green, and would have shipped
// a real, reachable "type /m mid-paragraph, press Enter, lose the paragraph
// to a math placeholder" bug. Extracting this one function -- used by BOTH
// paths now -- makes that formula structurally impossible to drift apart,
// the identical "one formula, not two copies" reasoning slash-items.ts's own
// enabledSlashItems doc comment gives for its own extraction.
export function chooseSlashItem(ctx: Ctx, view: EditorView, selector: SlashItemSelector): void {
  const session = slashPluginKey.getState(view.state)?.session
  if (!session) return
  const items = enabledSlashItems(ctx, view.state, session.query)
  const item =
    'index' in selector
      ? items[selector.index]
      : items.find((candidate) => candidate.id === selector.id)
  if (!item) return
  runSlashItemIn(view, session.anchorPos, session.queryEnd, () => item.run(ctx))
}

// Builds the real formatting-toolbar command surface for a live Editor
// instance -- a standalone, exported function (fix-round change)
// specifically so tests can call the exact same implementation the mounted
// MilkdownEditor component uses, not a hand-copied duplicate. This closes a
// real, verified gap: mutation-testing (rewiring toggleBold to dispatch
// toggleEmphasisCommand instead) passed all 177 pre-fix-round tests,
// because the existing test suite's "API pattern verification" block called
// `callCommand(toggleStrongCommand.key)` directly rather than going through
// MilkdownEditor.tsx's own wiring -- it verified the command MECHANISM
// works, not that MilkdownEditorHandle.toggleBold is wired to the right
// command key. MilkdownEditor.test.tsx now calls this function directly
// (with a real ProseMirror selection established via direct transaction
// dispatch, since jsdom's own Selection/Range API does not sync into
// ProseMirror's `state.selection` -- verified empirically, see that test
// file's own comment) against the identical plugin composition
// MilkdownEditor.tsx mounts, so a wiring bug like the mutation-tested one is
// now caught: this IS the shipped implementation, not a stand-in for it.
export function buildEditorCommands(editor: Editor): EditorCommands {
  return {
    toggleBold: () => {
      editor.action(callCommand(toggleStrongCommand.key))
    },
    toggleItalic: () => {
      editor.action(callCommand(toggleEmphasisCommand.key))
    },
    toggleInlineCode: () => {
      editor.action(callCommand(toggleInlineCodeCommand.key))
    },
    toggleHeading: (level) => {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        const currentBlock = view.state.selection.$from.parent
        const isSameLevel =
          currentBlock.type.name === 'heading' && currentBlock.attrs.level === level
        // wrapInHeadingCommand's own documented behavior: a level below 1
        // turns the block into a plain paragraph (see its source in
        // @milkdown/preset-commonmark) -- reused here as the "toggle off"
        // branch instead of a separate command.
        return callCommand(wrapInHeadingCommand.key, isSameLevel ? 0 : level)(ctx)
      })
    },
    setParagraph: () => {
      // wrapInHeadingCommand(0) -> paragraph, unconditionally -- see this
      // method's own doc comment on EditorCommands above for why no "what's
      // the active level" check is needed here (verified directly: it
      // isn't, contrary to an earlier version of this comment).
      editor.action(callCommand(wrapInHeadingCommand.key, 0))
    },
    toggleBulletList: () => {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        const listType = findAncestorListType(view.state)
        if (listType === 'bullet_list') {
          return callCommand(liftListItemCommand.key)(ctx)
        }
        if (listType === 'ordered_list') {
          // In the OTHER list type: lift out of it first, then wrap in a
          // bullet list, rather than attempting wrapIn directly against an
          // existing (ordered) list -- see findAncestorListType's own
          // comment for the verified silent-no-op this avoids. ProseMirror
          // dispatch is synchronous, so the second callCommand below reads
          // the state the first one's dispatch just produced, not a stale
          // snapshot -- verified directly (see MilkdownEditor.test.tsx).
          callCommand(liftListItemCommand.key)(ctx)
          return callCommand(wrapInBulletListCommand.key)(ctx)
        }
        return callCommand(wrapInBulletListCommand.key)(ctx)
      })
    },
    toggleOrderedList: () => {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        const listType = findAncestorListType(view.state)
        if (listType === 'ordered_list') {
          return callCommand(liftListItemCommand.key)(ctx)
        }
        if (listType === 'bullet_list') {
          callCommand(liftListItemCommand.key)(ctx)
          return callCommand(wrapInOrderedListCommand.key)(ctx)
        }
        return callCommand(wrapInOrderedListCommand.key)(ctx)
      })
    },
    insertLink: (href) => {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        // markActive, not a hand-rolled rangeHasMark: the same predicate the
        // bubble's own pressed state reads, so "the UI says this is a link"
        // and "this takes the update branch" are the same question asked once.
        // See EditorCommands.insertLink's own doc comment for the destructive
        // toggleMark behaviour this branch exists to avoid.
        const hasLink = markActive(view.state, view.state.schema.marks.link)
        const key = hasLink ? updateLinkCommand.key : toggleLinkCommand.key
        return callCommand(key, { href })(ctx)
      })
    },
    removeLink: () => {
      editor.action(callCommand(unlinkCommand.key))
    },
    insertTable: () => {
      // A minimal 2x2 table -- `row` includes the header row (see
      // insertTableCommand's own createTable helper source), so
      // `{ row: 2, col: 2 }` is one header row + one body row.
      editor.action(callCommand(insertTableCommand.key, { row: 2, col: 2 }))
    },
    addRowBefore: () => {
      editor.action(callCommand(addRowBeforeCommand.key))
    },
    addRowAfter: () => {
      editor.action(callCommand(addRowAfterCommand.key))
    },
    addColumnBefore: () => {
      editor.action(callCommand(addColBeforeCommand.key))
    },
    addColumnAfter: () => {
      editor.action(callCommand(addColAfterCommand.key))
    },
    deleteRow: () => {
      editor.action(callCommand(deleteTableRowCommand.key))
    },
    deleteColumn: () => {
      editor.action(callCommand(deleteTableColumnCommand.key))
    },
    deleteTable: () => {
      editor.action(callCommand(deleteWholeTableCommand.key))
    },
    setColumnAlignment: (alignment) => {
      editor.action(callCommand(setColumnAlignmentCommand.key, alignment))
    },
    toggleTaskList: () => {
      editor.action(callCommand(toggleTaskListCommand.key))
    },
    insertPageBreak: () => {
      editor.action(callCommand(insertPagebreakCommand.key))
    },
    undo: () => {
      editor.action(callCommand(undoCommand.key))
    },
    redo: () => {
      editor.action(callCommand(redoCommand.key))
    },
    focusEnd: () => {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        const { doc, schema } = view.state
        const endSelection = Selection.atEnd(doc)
        let tr = view.state.tr
        if (endSelection instanceof NodeSelection) {
          // Verified empirically (a throwaway scratch test against this
          // exact schema, deleted after use): dispatching this
          // NodeSelection as-is is wrong for this method's purpose.
          // ProseMirror's default typing/insertText behavior REPLACES a
          // NodeSelection's node with whatever gets typed next -- so
          // clicking blank space below a trailing pagebreak (or a
          // frontmatter-only document) and then typing a single character
          // silently deleted that node, replacing it with a new paragraph
          // containing the typed character. No real editor lets clicking
          // below the last line of content "select" that last object such
          // that the next keystroke destroys it. Appending a fresh empty
          // paragraph immediately after the atom and placing a real text
          // cursor inside THAT (the same move Notion/Word/Google Docs make
          // when you click below a trailing non-text block/embed) gives
          // the same "click blank space -> real, appendable cursor"
          // behavior this method exists for, without ever risking the atom
          // node itself. Accepted, narrow trade-off: this DOES mean a
          // click alone (no typing) can mark the document dirty in this
          // one case -- unavoidable, since a genuine "cursor after the
          // last atom" position cannot be represented at all without
          // somewhere with inline content to host it, and leaving the
          // NodeSelection in place is the strictly worse, data-losing
          // alternative this replaces.
          const insertPos = endSelection.to
          tr = tr.insert(insertPos, schema.nodes.paragraph.create())
          tr = tr.setSelection(TextSelection.create(tr.doc, insertPos + 1))
        } else {
          tr = tr.setSelection(endSelection)
        }
        view.dispatch(tr)
        view.focus()
      })
    },
    setFindState: (next) => {
      editor.action((ctx) => {
        applyFindState(ctx.get(editorViewCtx), next)
      })
    },
    replaceActiveMatch: (replacement) => {
      editor.action((ctx) => {
        replaceActiveMatchIn(ctx.get(editorViewCtx), replacement)
      })
    },
    replaceAllMatches: (replacement) => {
      editor.action((ctx) => {
        replaceAllMatchesIn(ctx.get(editorViewCtx), replacement)
      })
    },
    getSelectedText: () => {
      let selected = ''
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        const { from, to } = view.state.selection
        selected = from === to ? '' : view.state.doc.textBetween(from, to, ' ')
      })
      return selected
    },
    getSelectionRect: () => {
      // Same "assign inside editor.action, return after" shape as
      // getSelectedText immediately above -- editor.action runs its callback
      // synchronously, which is what makes this read (rather than a promise)
      // correct.
      let rect: Rect | null = null
      editor.action((ctx) => {
        rect = readSelectionRect(ctx.get(editorViewCtx))
      })
      return rect
    },
    getTableRect: () => {
      let rect: Rect | null = null
      editor.action((ctx) => {
        rect = readTableRect(ctx.get(editorViewCtx))
      })
      return rect
    },
    addComment: (author, text) => {
      return editor.action(callCommand(addCommentCommand.key, { author, text }))
    },
    resolveComment: (id) => {
      editor.action(callCommand(resolveCommentCommand.key, id))
    },
    runSlashItem: (id) => {
      // Delegates to chooseSlashItem (this file, above) with an id selector
      // -- fix round (final review, item 2): this used to inline its own
      // copy of "read the live session, re-derive enabledSlashItems, resolve
      // one item, runSlashItemIn," duplicated verbatim (differing only in
      // selector) with MilkdownEditor.tsx's keyboard-path closure. See
      // chooseSlashItem's own doc comment for why that duplication mattered
      // (fix round 1, IMPORTANT I2's own "PUBLIC method, must never run a
      // currently-disabled item" reasoning still applies -- it's just
      // enforced by the shared function now, not a local copy).
      editor.action((ctx) => {
        chooseSlashItem(ctx, ctx.get(editorViewCtx), { id })
      })
    },
    closeSlashMenu: () => {
      editor.action((ctx) => {
        closeSlashIn(ctx.get(editorViewCtx))
      })
    },
    getSlashItems: (query) => {
      // Same "assign inside editor.action, return after" shape as
      // getSelectedText/getSelectionRect above.
      let items: SlashItem[] = []
      editor.action((ctx) => {
        items = enabledSlashItems(ctx, ctx.get(editorViewCtx).state, query)
      })
      return items
    },
    setActiveSlashIndex: (index) => {
      editor.action((ctx) => {
        setActiveSlashIndexIn(ctx.get(editorViewCtx), index)
      })
    }
  }
}
