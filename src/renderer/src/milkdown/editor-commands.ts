import { editorViewCtx, type Editor } from '@milkdown/core'
import { callCommand } from '@milkdown/utils'
import { NodeSelection, Selection, TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  wrapInHeadingCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  liftListItemCommand,
  toggleLinkCommand
} from '@milkdown/preset-commonmark'
import { insertTableCommand } from '@milkdown/preset-gfm'
import { undoCommand, redoCommand, insertPagebreakCommand } from './commands'

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

type ListTypeName = 'bullet_list' | 'ordered_list'

// Walks up from the current selection's resolved position looking for an
// ancestor `bullet_list`/`ordered_list` node, returning WHICH one (not just
// whether the target type matches). Fix-round finding (verified, not
// theorized): the original version of this helper only checked the TARGET
// type (`isInListType(view, 'bullet_list')` returned `false` while the
// cursor was inside an `ordered_list`), so toggleBulletList() with the
// cursor in an ordered list took the "wrap" branch -- and
// wrapInBulletListCommand's underlying ProseMirror `wrapIn` silently no-ops
// when the selection is already inside ANY list (confirmed: DOM
// byte-identical before/after, the `<ol>` stays an `<ol>`). Returning the
// actual ancestor list type (or `null`) lets the two toggle methods below
// distinguish "already this type, so lift out" from "in the OTHER type, so
// convert" from "not in a list at all, so wrap" -- three real cases the
// single boolean this replaces could not tell apart.
function findAncestorListType(view: EditorView): ListTypeName | null {
  const { $from } = view.state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name
    if (name === 'bullet_list' || name === 'ordered_list') return name
  }
  return null
}

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
  // toggleLinkCommand -- a toggleMark over the link mark's {href, title}
  // attrs. Like bold/italic, applying this with an empty (collapsed)
  // selection sets a *stored* mark that only takes visible effect on the
  // next character typed, rather than rewriting any existing text -- the
  // same toggleMark characteristic bold/italic have, not a special case.
  insertLink: (href: string) => void
  // insertTableCommand, given `{ row: 2, col: 2 }` -- a minimal 2x2 table
  // (one header row + one body row, two columns; `row` counts the header
  // row, confirmed by reading @milkdown/preset-gfm's own createTable source).
  insertTable: () => void
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
        const listType = findAncestorListType(view)
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
        const listType = findAncestorListType(view)
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
      editor.action(callCommand(toggleLinkCommand.key, { href }))
    },
    insertTable: () => {
      // A minimal 2x2 table -- `row` includes the header row (see
      // insertTableCommand's own createTable helper source), so
      // `{ row: 2, col: 2 }` is one header row + one body row.
      editor.action(callCommand(insertTableCommand.key, { row: 2, col: 2 }))
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
    }
  }
}
