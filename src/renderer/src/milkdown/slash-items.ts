import { commandsCtx } from '@milkdown/core'
import type { Ctx } from '@milkdown/ctx'
import type { EditorState } from '@milkdown/prose/state'
import {
  wrapInHeadingCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  wrapInBlockquoteCommand,
  insertHrCommand,
  createCodeBlockCommand
} from '@milkdown/preset-commonmark'
import { insertTableCommand } from '@milkdown/preset-gfm'
import {
  insertTaskListCommand,
  insertMathBlockCommand,
  insertMermaidBlockCommand,
  insertPagebreakCommand,
  insertTocCommand,
  isInsideTableCell
} from './commands'
import { findSlashTrigger } from '../lib/slash-query'
import { filterSlashItems } from '../lib/slash-filter'

// The item catalogue behind the slash-command palette (Task 4). Pure data +
// small closures over a live Milkdown `Ctx` -- no React, no ProseMirror
// plugin state, no knowledge of the live session (anchorPos/query) beyond
// what can be re-derived from the CURRENT editor state (see
// isTargetBlockEmptyAfterQueryRemoved below). This keeps the catalogue
// testable with a real Milkdown test editor and a hand-placed selection,
// the same style commands.test.ts already uses, with no plugin/session
// machinery in the loop at all.
//
// Deliberately omits an Image item. image-security.ts's own isSafeImageSrc
// renders only `data:` sources in this privileged renderer (its own module
// comment names extending it to resolve document-relative paths as real,
// separate, security-sensitive future work) -- so a slash-inserted
// `![alt](relative/path.png)` reference would render visibly "blocked" in
// the Format-mode canvas the instant it's inserted. Shipping a menu item
// whose own result looks broken is worse than not shipping it; drag-and-drop
// image insertion already exists as this app's one working path to a local
// image (see CLAUDE.md's "Drag-and-drop image insertion" section).

export type SlashItemGroup = 'Text' | 'Lists' | 'Insert' | 'Advanced'

/**
 * One palette entry. `run`/`isEnabled` both take the live Milkdown `Ctx`
 * (the same object `editor.action((ctx) => ...)` hands a caller elsewhere in
 * this codebase, e.g. editor-commands.ts) rather than a bound `Editor`
 * instance -- Task 5's controller already has a `Ctx` in hand from wherever
 * it calls into this catalogue (the slash plugin's own `view.update`
 * doesn't give it an `Editor`), and every command in this file is reachable
 * through `ctx.get(commandsCtx)` alone.
 *
 * `label`/`keywords` alone would already satisfy slash-filter.ts's
 * `SlashFilterable` constraint (structural typing) -- listed again here
 * because this is the full, canonical shape Task 5 builds the catalogue
 * against, not merely "whatever filterSlashItems happens to need."
 */
export interface SlashItem {
  id: string
  group: SlashItemGroup
  label: string
  description: string
  keywords: string[]
  /** Actually performs the insertion/conversion. Assumes it IS enabled. */
  run: (ctx: Ctx) => void
  /**
   * Whether choosing this item right now is safe -- a genuine ProseMirror
   * dry run of the underlying command (CommandManager.get(key) returns the
   * raw factory, so calling it with no `dispatch` argument mutates nothing;
   * see CommandManager's own .call() vs .get() in @milkdown/core, which
   * dispatch for real and never do, respectively) PLUS, for a
   * "block-replacing" item, an additional check no dry run can express --
   * see isTargetBlockEmptyAfterQueryRemoved below for why.
   */
  isEnabled: (ctx: Ctx, state: EditorState) => boolean
}

// '￼' (U+FFFC OBJECT REPLACEMENT CHARACTER) as the leaf-text stand-in for a
// non-text inline atom (e.g. an image) -- the exact convention
// slash-plugin.ts's own tryOpen uses for the identical reason (a "/"
// immediately after a non-text atom is preceded by real, non-whitespace
// content, not "start of block"). Reused as a bare literal here rather than
// imported from that file: it is a one-character literal with nothing to
// drift out of sync, the same reasoning slash-plugin.ts's own header comment
// gives for not importing slash-query.ts's private WHITESPACE regex either.
const NON_TEXT_LEAF = '￼'

/**
 * THE HARD REQUIREMENT this module exists to enforce (see this task's own
 * brief, and the doc comments on insertMathBlockCommand/
 * insertMermaidBlockCommand in commands.ts): those two commands REPLACE the
 * entire target block's content, unconditionally, with no confirmation and
 * no attempt to preserve anything. A plain ProseMirror dry run of either
 * command cannot catch this -- both return `true` for ANY paragraph,
 * applicable exactly when running them would be destructive. Measured,
 * reproduced scenario (a Task 2/3 code review): a paragraph reading
 * "Important prose here and more text", caret placed mid-paragraph after a
 * space, "/" typed (a session legitimately opens -- start-of-block OR after
 * whitespace is this feature's own designed-in open condition), "Math
 * block" picked with an empty query -- result: the WHOLE paragraph's prose
 * is gone, replaced by the math placeholder, un-selected, no confirmation.
 *
 * The fix: offer a block-replacing item ONLY when the target block would be
 * EMPTY once the slash query itself -- the "/" plus everything typed after
 * it, i.e. `[anchorPos, anchorPos + 1 + query.length)` -- is removed. `ctx`
 * is unused here (the check is pure ProseMirror-state arithmetic, no
 * command needed) but kept on `isTargetBlockEmptyAfterQueryRemoved`'s own
 * call sites' signature for symmetry with every other isEnabled below.
 *
 * Reuses findSlashTrigger (slash-query.ts) rather than taking an explicit
 * anchorPos/query parameter: `state` here is the LIVE editor state, and it
 * still carries the "/query" text un-deleted -- isEnabled is always
 * evaluated BEFORE an item is chosen (runSlashItemIn only deletes the query
 * once the user actually picks something), so the exact backward scan
 * slash-plugin.ts's own tryOpen/advanceSession use to find the trigger in
 * the first place re-derives the same {slashOffset, query} here, with no
 * separate SlashSession dependency -- keeping this file's own header claim
 * ("no knowledge of the live session beyond what's re-derivable from state")
 * literally true rather than aspirational.
 */
function isTargetBlockEmptyAfterQueryRemoved(state: EditorState): boolean {
  const $from = state.selection.$from
  const parent = $from.parent
  const textBeforeCursor = parent.textBetween(0, $from.parentOffset, NON_TEXT_LEAF, NON_TEXT_LEAF)
  const trigger = findSlashTrigger(textBeforeCursor)
  // No active trigger found in the text before the cursor: isEnabled is only
  // ever meant to be asked this while a slash session is genuinely open
  // (Task 5's controller), but if it somehow isn't, there is no anchor to
  // compute "what would be left" against. Refuse rather than guess --
  // matching this file's conservative posture throughout: a false negative
  // (an item incorrectly disabled) is an inconvenience, a false positive
  // here is silent data loss.
  if (!trigger) return false

  const blockText = parent.textBetween(0, parent.content.size, NON_TEXT_LEAF, NON_TEXT_LEAF)
  const removeStart = trigger.slashOffset
  const removeEnd = trigger.slashOffset + 1 + trigger.query.length
  const remaining = blockText.slice(0, removeStart) + blockText.slice(removeEnd)
  return remaining.length === 0
}

// Findings from reading every candidate command's own source directly (not
// assumed -- see this task's own report for the full measured writeup),
// which is WHY the items below are gated the way they are and not some
// other way:
//
//   - insertMathBlockCommand / insertMermaidBlockCommand: BLOCK-REPLACING.
//     Both wipe the target block's entire content outright (see their own
//     doc comments in commands.ts). Gated on isInsideTableCell (fix round,
//     final review -- see this file's own isEnabled comments below for the
//     measured "sole, useless item inside an empty cell" finding this
//     closes) composed with isTargetBlockEmptyAfterQueryRemoved, composed
//     with each command's own dry run as a defensive third check (harmless
//     belt-and-suspenders, since a session can only be open inside a real
//     paragraph to begin with -- see slash-plugin.ts's tryOpen).
//   - insertTableCommand (@milkdown/preset-gfm) / insertHrCommand
//     (@milkdown/preset-commonmark): NOT block-replacing (both use
//     replaceSelectionWith on the session's own always-collapsed selection,
//     which splits a plain paragraph cleanly rather than consuming it -- the
//     same mechanism insertPagebreakCommand's own doc comment documents).
//     But BOTH share a different, real, measured hazard: from inside a
//     table cell (whose content model is a rigid, single-child 'paragraph',
//     no room for a sibling), replaceSelectionWith's fallback fitting
//     algorithm doesn't refuse -- it restructures the enclosing table
//     instead, corrupting it. See isInsideTableCell's own doc comment in
//     commands.ts, which this file reuses rather than re-deriving. Neither
//     command's own dry run is informative enough to catch this on its own
//     (insertHrCommand's is `if (!dispatch) return true` -- unconditional;
//     insertTableCommand's never even checks `dispatch` before returning
//     `true`) -- confirmed by reading both directly, not assumed -- so
//     isInsideTableCell is this file's OWN gate for both, applied at the
//     call site since neither command is this project's to patch.
//   - createCodeBlockCommand (@milkdown/preset-commonmark) /
//     wrapInBlockquoteCommand (@milkdown/preset-commonmark): SAFE, including
//     from inside a table cell -- both refuse cleanly there on their own
//     (setBlockType / wrapIn's own real applicability checks), measured
//     directly against the same table fixture the two hazards above were
//     found with. Their own dry runs are genuinely informative, so no extra
//     gate is applied.
//   - insertPagebreakCommand (this project's own, commands.ts): was
//     previously "always true" unconditionally (this task's other required
//     fix) and ALSO shared the exact table-corruption hazard insertTableCommand/
//     insertHrCommand have -- fixed at the SOURCE (isInsideTableCell is
//     called inside the command itself, since this one IS this project's
//     code), so its own dry run is now honest and no extra gate is needed
//     here.
//   - wrapInHeadingCommand / wrapInBulletListCommand /
//     wrapInOrderedListCommand / insertTaskListCommand (this project's own):
//     all real, content-preserving conversions (setBlockType/wrapIn-backed,
//     or -- for the task-list command -- built on wrapIn the same way, see
//     its own doc comment in commands.ts) with genuinely informative dry
//     runs. No additional gate needed.

export const SLASH_ITEMS: SlashItem[] = [
  {
    id: 'heading-1',
    group: 'Text',
    label: 'Heading 1',
    description: 'Big section heading',
    keywords: ['h1', 'heading', 'title', 'big'],
    run: (ctx) => {
      ctx.get(commandsCtx).call(wrapInHeadingCommand.key, 1)
    },
    isEnabled: (ctx, state) => ctx.get(commandsCtx).get(wrapInHeadingCommand.key)(1)(state)
  },
  {
    id: 'heading-2',
    group: 'Text',
    label: 'Heading 2',
    description: 'Medium section heading',
    keywords: ['h2', 'heading', 'subtitle', 'medium'],
    run: (ctx) => {
      ctx.get(commandsCtx).call(wrapInHeadingCommand.key, 2)
    },
    isEnabled: (ctx, state) => ctx.get(commandsCtx).get(wrapInHeadingCommand.key)(2)(state)
  },
  {
    id: 'heading-3',
    group: 'Text',
    label: 'Heading 3',
    description: 'Small section heading',
    keywords: ['h3', 'heading', 'small'],
    run: (ctx) => {
      ctx.get(commandsCtx).call(wrapInHeadingCommand.key, 3)
    },
    isEnabled: (ctx, state) => ctx.get(commandsCtx).get(wrapInHeadingCommand.key)(3)(state)
  },
  {
    id: 'bullet-list',
    group: 'Lists',
    label: 'Bullet list',
    description: 'Simple bulleted list',
    keywords: ['ul', 'unordered', 'bullets', 'list'],
    run: (ctx) => {
      ctx.get(commandsCtx).call(wrapInBulletListCommand.key)
    },
    isEnabled: (ctx, state) =>
      ctx.get(commandsCtx).get(wrapInBulletListCommand.key)(undefined)(state)
  },
  {
    id: 'numbered-list',
    group: 'Lists',
    label: 'Numbered list',
    description: 'List with numbering',
    keywords: ['ol', 'ordered', 'numbered', 'list'],
    run: (ctx) => {
      ctx.get(commandsCtx).call(wrapInOrderedListCommand.key)
    },
    isEnabled: (ctx, state) =>
      ctx.get(commandsCtx).get(wrapInOrderedListCommand.key)(undefined)(state)
  },
  {
    id: 'task-list',
    group: 'Lists',
    label: 'Task list',
    description: 'Checklist with checkboxes',
    keywords: ['todo', 'checkbox', 'checklist', 'task', 'list'],
    run: (ctx) => {
      ctx.get(commandsCtx).call(insertTaskListCommand.key)
    },
    isEnabled: (ctx, state) => ctx.get(commandsCtx).get(insertTaskListCommand.key)(undefined)(state)
  },
  {
    id: 'table',
    group: 'Insert',
    label: 'Table',
    description: '2x2 table',
    keywords: ['grid', 'rows', 'columns', 'table'],
    // { row: 2, col: 2 } matches editor-commands.ts's own toolbar
    // insertTable exactly (a header row + one body row, two columns) --
    // one definition of "the default table this app inserts", not a second,
    // independently-chosen size.
    run: (ctx) => {
      ctx.get(commandsCtx).call(insertTableCommand.key, { row: 2, col: 2 })
    },
    // insertTableCommand's own dry run is UNCONDITIONALLY true (read
    // directly from @milkdown/preset-gfm's own source: it returns `true`
    // without ever checking its `dispatch` argument), so it adds nothing
    // useful here -- the real, measured gate is isInsideTableCell. See this
    // file's own findings comment above.
    isEnabled: (ctx, state) => !isInsideTableCell(ctx, state)
  },
  {
    id: 'code-block',
    group: 'Insert',
    label: 'Code block',
    description: 'Plain fenced code block',
    keywords: ['code', 'fence', 'snippet', 'pre'],
    run: (ctx) => {
      ctx.get(commandsCtx).call(createCodeBlockCommand.key)
    },
    isEnabled: (ctx, state) =>
      ctx.get(commandsCtx).get(createCodeBlockCommand.key)(undefined)(state)
  },
  {
    id: 'blockquote',
    group: 'Insert',
    label: 'Blockquote',
    description: 'Quoted text block',
    keywords: ['quote', 'citation', 'blockquote'],
    run: (ctx) => {
      ctx.get(commandsCtx).call(wrapInBlockquoteCommand.key)
    },
    isEnabled: (ctx, state) =>
      ctx.get(commandsCtx).get(wrapInBlockquoteCommand.key)(undefined)(state)
  },
  {
    id: 'horizontal-rule',
    group: 'Insert',
    label: 'Horizontal rule',
    description: 'Horizontal divider line',
    keywords: ['hr', 'divider', 'separator', 'rule', 'line'],
    run: (ctx) => {
      ctx.get(commandsCtx).call(insertHrCommand.key)
    },
    // insertHrCommand's own dry run is ALSO unconditionally true (read
    // directly: `if (!dispatch) return true`, a bare early return with no
    // applicability check at all) -- same reasoning as Table above.
    isEnabled: (ctx, state) => !isInsideTableCell(ctx, state)
  },
  {
    id: 'page-break',
    group: 'Insert',
    label: 'Page break',
    description: 'Force a new page on export',
    keywords: ['page', 'break', 'newpage'],
    run: (ctx) => {
      ctx.get(commandsCtx).call(insertPagebreakCommand.key)
    },
    // insertPagebreakCommand's own dry run is now honest (this task's other
    // required fix, made directly in commands.ts) -- including its own
    // isInsideTableCell guard -- so no extra gate is needed at this call
    // site the way Table/Horizontal rule above need one.
    isEnabled: (ctx, state) =>
      ctx.get(commandsCtx).get(insertPagebreakCommand.key)(undefined)(state)
  },
  {
    id: 'table-of-contents',
    group: 'Insert',
    label: 'Table of contents',
    description: 'Auto-generated list of headings',
    // Deliberately no 'headings' keyword, even though it describes the item
    // well: filterSlashItems matches on substrings, so it would make typing
    // "/head" -- overwhelmingly a request for Heading 1/2/3 -- return a fourth,
    // unrelated result at the top of a four-item list. Caught by
    // slash-items.test.ts's own "'head' -> only the three headings" assertion,
    // which is exactly the kind of discrimination a catalogue test is for.
    keywords: ['toc', 'contents', 'outline', 'index'],
    run: (ctx) => {
      ctx.get(commandsCtx).call(insertTocCommand.key)
    },
    // NOT block-replacing, and that is a property of insertTocCommand rather
    // than an assumption about it: like insertPagebreakCommand, it collapses
    // the selection to its start before calling replaceSelectionWith, so a
    // plain paragraph is SPLIT rather than consumed. It also carries its own
    // isInsideTableCell refusal (shared with insertPagebreakCommand, for the
    // measured table-corruption bug documented there) and returns
    // `tr.docChanged` rather than an unconditional `true` -- so unlike
    // insertTableCommand/insertHrCommand above, its dry run is genuinely
    // informative and needs no extra gate at this call site.
    //
    // isTargetBlockEmptyAfterQueryRemoved is deliberately NOT applied. That
    // gate exists for the two commands that WIPE the target block; applying
    // it here would refuse the extremely ordinary "type a sentence, then add
    // a TOC below it" gesture for no safety benefit.
    isEnabled: (ctx, state) => ctx.get(commandsCtx).get(insertTocCommand.key)(undefined)(state)
  },
  {
    id: 'math-block',
    group: 'Advanced',
    label: 'Math block',
    description: 'KaTeX equation ($$ ... $$)',
    keywords: ['equation', 'latex', 'katex', 'formula', 'math'],
    run: (ctx) => {
      ctx.get(commandsCtx).call(insertMathBlockCommand.key)
    },
    // BLOCK-REPLACING -- see this file's own header comment. The emptiness
    // check is the load-bearing gate; the command's own dry run is a
    // defensive second check, not the primary one (a dry run alone is
    // exactly what this task's brief proved is NOT sufficient here).
    //
    // Fix round (final review): `!isInsideTableCell` prepended. Measured: an
    // EMPTY table cell (no prose to protect) passed
    // isTargetBlockEmptyAfterQueryRemoved and insertMathBlockCommand's own
    // dry run both -- neither one is table-aware, and a cell's content model
    // is a single, unsplittable paragraph, so the command's own
    // "target must be a paragraph" check is satisfied by the CELL's
    // paragraph too. Choosing it writes a raw `$$` block straight into the
    // cell's markdown source (`| $$\nx^2\n$$ | d |`) -- non-destructive
    // (round-trips byte-stably) but nonsensical: math has no meaning inside
    // a table cell, and this was the ONLY item ever offered there, so an
    // empty cell's palette had exactly one, useless entry. Table/Horizontal
    // rule/Page break already refuse inside a table cell (see this file's
    // own findings comment above) for the SAME isInsideTableCell reason;
    // this brings Math block/Mermaid diagram in line with that precedent.
    isEnabled: (ctx, state) =>
      !isInsideTableCell(ctx, state) &&
      isTargetBlockEmptyAfterQueryRemoved(state) &&
      ctx.get(commandsCtx).get(insertMathBlockCommand.key)(undefined)(state)
  },
  {
    id: 'mermaid-diagram',
    group: 'Advanced',
    label: 'Mermaid diagram',
    description: 'Mermaid flowchart placeholder',
    keywords: ['diagram', 'chart', 'flowchart', 'graph', 'mermaid'],
    run: (ctx) => {
      ctx.get(commandsCtx).call(insertMermaidBlockCommand.key)
    },
    // BLOCK-REPLACING -- identical reasoning to Math block above, including
    // the `!isInsideTableCell` fix round addition (final review).
    isEnabled: (ctx, state) =>
      !isInsideTableCell(ctx, state) &&
      isTargetBlockEmptyAfterQueryRemoved(state) &&
      ctx.get(commandsCtx).get(insertMermaidBlockCommand.key)(undefined)(state)
  }
]

/**
 * The catalogue's own single, authoritative "what's currently offered"
 * computation -- filterSlashItems (by `query`) composed with each surviving
 * item's own isEnabled(ctx, state), in that order. Added by Task 5 (wiring)
 * because it turned out to be needed in TWO places that must never disagree:
 * MilkdownEditor.tsx's countMatching closure (passed into slash-plugin.ts's
 * createSlashPlugin, which clamps/wraps the plugin's own activeIndex against
 * whatever count it's given) and editor-commands.ts's getSlashItems (which
 * backs the palette's actually-rendered array via useSlashMenu.ts). Both
 * MUST be built from the identical formula -- see slash-plugin.ts's own
 * CountMatching doc comment for the exact desync this prevents (fix round 1,
 * IMPORTANT I3, from the item-catalogue task): a count built from
 * filterSlashItems alone, without the isEnabled half, is LARGER than the
 * actually-rendered array, and arrow-key navigation can then walk
 * activeIndex past the end of it -- `items[activeIndex]` undefined, nothing
 * `aria-selected`, Enter picking nothing. Factoring this into one exported
 * function (rather than two call sites each writing
 * `filterSlashItems(SLASH_ITEMS, query).filter((item) => item.isEnabled(ctx,
 * state))` by hand) makes that formula structurally impossible to drift
 * apart, the same reasoning selection-plugin.ts's own findAncestorListType
 * doc comment gives for living in one place rather than two.
 */
export function enabledSlashItems(ctx: Ctx, state: EditorState, query: string): SlashItem[] {
  return filterSlashItems(SLASH_ITEMS, query).filter((item) => item.isEnabled(ctx, state))
}
