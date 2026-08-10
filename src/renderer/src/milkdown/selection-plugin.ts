import { NodeSelection, Plugin, PluginKey, type EditorState } from '@milkdown/prose/state'
import type { MarkType } from '@milkdown/prose/model'
import type { EditorView } from '@milkdown/prose/view'
import { unionRect, type Rect } from '../lib/floating-position'
import { findTableContext, type TableContext } from './table-context'

// The selection-reporting half of the bubble menu: a stateless ProseMirror
// plugin that tells React WHAT is selected and HOW it is currently formatted.
// It deliberately reports no geometry -- the contract this feature is built on
// is "the plugin reports state, the handle reports geometry (readSelectionRect
// below, called through MilkdownEditorHandle.getSelectionRect), React does
// layout (lib/floating-position.ts)". Keeping those three apart is what makes
// the occlusion guarantee a unit-testable property of pure arithmetic rather
// than an emergent property of a mounted editor.

export type ListTypeName = 'bullet_list' | 'ordered_list'

export interface SelectionMarks {
  bold: boolean
  italic: boolean
  inlineCode: boolean
  link: boolean
}

export interface SelectionSnapshot {
  /**
   * Document positions of the selection's two ends. Meaningful ONLY when
   * `empty` is false -- see sameSnapshot below, which deliberately ignores
   * them for a collapsed selection, so a collapsed snapshot's positions can be
   * stale by design. Nothing may read them without checking `empty` first.
   */
  from: number
  to: number
  /** Collapsed (a caret, not a range). */
  empty: boolean
  /**
   * Whether the editor's own DOM currently holds focus. Load-bearing for the
   * bubble, not informational: Find deliberately SELECTS its active match
   * without focusing (applyFindState's own documented rule), so without this
   * every Find hit would pop a bubble the user never asked for.
   */
  hasFocus: boolean
  /** A NodeSelection (image / pagebreak / frontmatter atom), not a text range. */
  nodeSelection: boolean
  marks: SelectionMarks
  /**
   * The `href` of the link mark under the selection, or null when there is
   * none. Carried alongside `marks.link` (which only says whether one exists)
   * because the link composer must PREFILL with the current URL: without it
   * there is no way for a user to even see, let alone correct, the URL of a
   * link they already have -- the composer opened blank every time.
   */
  linkHref: string | null
  /** 1-6 when the selection's block is a heading, else null. */
  headingLevel: number | null
  /** The nearest ancestor list, if any. */
  listType: ListTypeName | null
  /**
   * True when the selection sits in a GFM task list item (`- [ ]`/`- [x]`),
   * i.e. a `list_item` whose `checked` attr is non-null. Distinct from
   * `listType === 'bullet_list'`, which every task item ALSO satisfies -- the
   * toolbar needs to tell the two apart to press the right button.
   */
  taskList: boolean
  /**
   * Where the selection sits inside a table, or null when it is not in one.
   * This is what makes the selection bubble context-sensitive: the table
   * controls only exist while this is non-null, so they cost nothing (and
   * occupy nothing) for the overwhelming majority of documents.
   */
  table: TableContext | null
}

/**
 * Whether `type` applies at the current selection -- the standard ProseMirror
 * idiom, split by selection kind because the two cases genuinely differ: a
 * caret's formatting is whatever the NEXT typed character would carry (stored
 * marks, falling back to the marks at the resolved position), while a range's
 * is a property of the document text itself.
 *
 * Documented, deliberate semantics on a partially-marked range:
 * `rangeHasMark` is true when ANY part of the range carries the mark, so a
 * half-bold selection reports bold: true and the button reads pressed. That is
 * conventional ProseMirror behaviour (and matches what toggleMark itself will
 * then do -- it un-bolds the whole range). Word/Docs instead show an
 * indeterminate state; matching ProseMirror keeps the indicator and the action
 * consistent with each other, which matters more than matching Word here.
 */
export function markActive(state: EditorState, type: MarkType | undefined): boolean {
  if (!type) return false
  const { from, $from, to, empty } = state.selection
  if (empty) return type.isInSet(state.storedMarks || $from.marks()) != null
  return state.doc.rangeHasMark(from, to, type)
}

/**
 * The nearest ancestor `bullet_list`/`ordered_list` of the current selection,
 * or null. Lives here (rather than staying private to editor-commands.ts,
 * which is where it started) so the toolbar's ACTIVE state and the toggle
 * commands' own three-way branch read list membership through the exact same
 * walk -- an indicator that disagrees with what the button then does is worse
 * than no indicator, and two copies of an ancestor walk is exactly how that
 * happens. editor-commands.ts imports it from here; this module deliberately
 * imports nothing from editor-commands, keeping the dependency one-way.
 */
export function findAncestorListType(state: EditorState): ListTypeName | null {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name
    if (name === 'bullet_list' || name === 'ordered_list') return name
  }
  return null
}

/**
 * The `href` of the link mark covering the selection, or null.
 *
 * Two lookups rather than one, for the same reason `markActive` splits: with a
 * caret, the link the user means is the one at the resolved position (stored
 * marks first, since those are what the next typed character would carry);
 * with a range, it is whichever link the range actually touches. The range
 * scan widens a collapsed `to` by one so a caret sitting immediately before a
 * linked character still finds it -- the exact widening
 * `@milkdown/preset-commonmark`'s own `updateLinkCommand` uses, so "which link
 * does the composer show" and "which link does Update rewrite" cannot disagree.
 */
export function readLinkHref(state: EditorState): string | null {
  const linkType = state.schema.marks.link
  if (!linkType) return null
  const { from, to, empty, $from } = state.selection
  if (empty) {
    const mark = linkType.isInSet(state.storedMarks || $from.marks())
    const href = mark?.attrs.href
    return typeof href === 'string' ? href : null
  }
  let href: string | null = null
  state.doc.nodesBetween(from, to, (node) => {
    if (href !== null) return false
    const mark = node.marks.find((candidate) => candidate.type === linkType)
    if (!mark) return true
    const value = mark.attrs.href
    if (typeof value === 'string') href = value
    return false
  })
  return href
}

/**
 * True when the selection is inside a GFM task list item. Reads `checked` off
 * the nearest ancestor `list_item`: `null` is an ordinary bullet, `false`/
 * `true` are an unchecked/checked task (that is
 * `extendListItemSchemaForTask`'s own convention -- its toMarkdown runner only
 * emits `- [ ] `/`- [x] ` syntax for a non-null value).
 */
export function isTaskListItem(state: EditorState): boolean {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type.name !== 'list_item') continue
    return node.attrs.checked !== null && node.attrs.checked !== undefined
  }
  return false
}

export function readSelectionSnapshot(view: EditorView): SelectionSnapshot {
  const { state } = view
  const { selection } = state
  const parentBlock = selection.$from.parent
  return {
    from: selection.from,
    to: selection.to,
    empty: selection.empty,
    hasFocus: view.hasFocus(),
    nodeSelection: selection instanceof NodeSelection,
    marks: {
      bold: markActive(state, state.schema.marks.strong),
      italic: markActive(state, state.schema.marks.emphasis),
      inlineCode: markActive(state, state.schema.marks.inlineCode),
      link: markActive(state, state.schema.marks.link)
    },
    linkHref: readLinkHref(state),
    headingLevel:
      parentBlock.type.name === 'heading' && typeof parentBlock.attrs.level === 'number'
        ? parentBlock.attrs.level
        : null,
    listType: findAncestorListType(state),
    taskList: isTaskListItem(state),
    table: findTableContext(state)
  }
}

/**
 * Whether two snapshots describe the same selection state, i.e. whether React
 * can be spared a render.
 *
 * The one non-obvious rule, and it is the difference between this feature
 * costing nothing and costing a React render per keystroke: WHEN BOTH
 * SELECTIONS ARE COLLAPSED, POSITIONS ARE IGNORED. Typing moves the caret on
 * every character, so comparing `from`/`to` unconditionally would report a
 * change for every keystroke in an ordinary paragraph -- exactly the "React
 * render per character" the design forbids. Nothing consumes a collapsed
 * snapshot's positions (the bubble is hidden while collapsed; the toolbar only
 * reads the formatting fields), so the staleness is unobservable, whereas the
 * renders would not be. A non-empty selection compares positions in full,
 * because the bubble must re-anchor as a drag-select grows.
 */
export function sameSnapshot(a: SelectionSnapshot | null, b: SelectionSnapshot | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.empty !== b.empty) return false
  if (a.hasFocus !== b.hasFocus) return false
  if (a.nodeSelection !== b.nodeSelection) return false
  if (a.headingLevel !== b.headingLevel) return false
  if (a.listType !== b.listType) return false
  if (a.taskList !== b.taskList) return false
  if (a.linkHref !== b.linkHref) return false
  // Every field of TableContext is compared, and every one of them is stable
  // per keystroke (see TableContext's own doc comments), so this does not
  // reintroduce the "React render per character" the collapsed-position
  // exemption below exists to prevent -- while still re-reporting when the
  // caret moves to a different column (the alignment buttons' pressed state
  // depends on it) or into a different table.
  if ((a.table === null) !== (b.table === null)) return false
  if (a.table && b.table) {
    if (
      a.table.tablePos !== b.table.tablePos ||
      a.table.column !== b.table.column ||
      a.table.alignment !== b.table.alignment
    ) {
      return false
    }
  }
  if (
    a.marks.bold !== b.marks.bold ||
    a.marks.italic !== b.marks.italic ||
    a.marks.inlineCode !== b.marks.inlineCode ||
    a.marks.link !== b.marks.link
  ) {
    return false
  }
  if (!a.empty && (a.from !== b.from || a.to !== b.to)) return false
  return true
}

/**
 * The selection's on-screen box: the union of the coordinates of its two ends.
 *
 * NO ZOOM CORRECTION, and that is a real decision rather than an omission.
 * EditorScreen's single-pane branch wraps the canvas in `transform:
 * scale(zoom)`, but `coordsAtPos` bottoms out in `getClientRects()` /
 * `getBoundingClientRect()`, which per CSSOM-View already report POST-transform
 * viewport coordinates -- prosemirror-view's own `clientRect()` helper
 * corroborates this, carrying the comment "Adjust for elements with style
 * `transform: scale()`" and dividing by offsetWidth, i.e. treating that output
 * as already scaled. Dividing by `zoom` here is the exact mirror image of the
 * SplitPreview DIP trap (there: multiplying by an already-applied factor).
 * The overlay itself must then render OUTSIDE that transformed wrapper, since
 * a transform establishes a containing block for fixed-position descendants.
 *
 * !!! JSDOM HAZARD, MEASURED, AND WORSE THAN IT LOOKS !!!
 * `view.coordsAtPos()` does NOT throw under jsdom -- it silently returns
 * ALL-ZERO rects. Bare jsdom implements neither `Range.getClientRects` nor
 * `Range.getBoundingClientRect`, but this repo's own test-setup.ts already
 * polyfills both (added for an unrelated ProseMirror scrollToSelection reason),
 * and those polyfills return zeros. So a jsdom test asserting "the bubble sits
 * above the selection" passes against {0,0,0,0} and proves exactly nothing --
 * strictly more dangerous than drop-image.ts's `posAtCoords`, which at least
 * throws loudly. Test the ARITHMETIC (lib/floating-position.test.ts) and leave
 * real positioning to a Playwright gate against the real built app.
 *
 * The try/catch is not defensive padding: `coordsAtPos` legitimately throws
 * for a position whose DOM is not currently rendered.
 */
export function readSelectionRect(view: EditorView): Rect | null {
  const { from, to } = view.state.selection
  try {
    const start = view.coordsAtPos(from)
    const end = view.coordsAtPos(to)
    return unionRect(start, end)
  } catch {
    return null
  }
}

/**
 * The enclosing TABLE's own on-screen box, but ONLY for a collapsed selection
 * inside a table -- null in every other case, including a ranged selection
 * inside a table.
 *
 * This exists because the bubble now appears for a bare caret in a table (the
 * table controls have to be reachable without first selecting something), and
 * a caret anchor cannot be tracked there. `sameSnapshot` deliberately ignores
 * positions while BOTH selections are collapsed -- that exemption is what
 * keeps typing from costing a React render per character -- so nothing
 * re-reports as the caret moves, and an anchor measured from `coordsAtPos`
 * would freeze wherever the caret happened to be when the bubble appeared and
 * then lie as the user Tab'd across the row. The table's own rect has the
 * opposite property: it does not move while typing in a cell or tabbing
 * between cells, so a stale measurement and a fresh one are the same
 * measurement. Moving to a DIFFERENT table does change `table.tablePos`, which
 * `sameSnapshot` does compare, so that case re-reports and re-measures.
 *
 * Returns null for a ranged selection so the caller falls back to
 * `readSelectionRect`: with real selected text the bubble should sit by that
 * text, and a ranged selection re-reports on every change anyway.
 *
 * Same jsdom hazard as readSelectionRect above: `getBoundingClientRect` is
 * polyfilled to all-zeros there, so a jsdom test asserting a position proves
 * nothing. Test the arithmetic; leave real positioning to a gate.
 */
export function readTableRect(view: EditorView): Rect | null {
  if (!view.state.selection.empty) return null
  const context = findTableContext(view.state)
  if (!context) return null
  const dom = view.nodeDOM(context.tablePos)
  if (!(dom instanceof HTMLElement)) return null
  const rect = dom.getBoundingClientRect()
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
}

export const selectionPluginKey = new PluginKey('pagedownSelection')

/**
 * Constructed per MOUNT (in MilkdownEditor.tsx, alongside findProse /
 * dropImageProse) rather than added to the static EDITOR_COMMAND_PLUGINS list,
 * because it closes over a per-mount callback.
 *
 * Reports from the view's `update` hook, NEVER from a state `apply` -- verbatim
 * reuse of find-plugin.ts's documented reasoning: `apply` runs inside
 * transaction application, so a React setter there fires a React render from
 * inside a ProseMirror dispatch. This plugin holds no plugin state at all,
 * which makes `update` the only sensible home anyway.
 *
 * It also listens for real DOM focus/blur on the editor's own node. That is
 * not redundant with `update`: focus changes do not necessarily dispatch a
 * transaction, so without these the bubble would linger, fully interactive,
 * after the user clicked away into the chrome. They cannot fire on a bubble
 * button click, because the bubble preventDefaults its own mousedown precisely
 * so focus never leaves the editor.
 *
 * `destroy()` reports null so a mode switch or a key={revision} remount clears
 * a stale bubble; find-plugin doesn't need that because decorations die with
 * the view, but visible chrome living in React does not.
 *
 * There is NO convergence loop here, unlike Find: the bubble never pushes
 * state back into the plugin, it only dispatches commands on click. Stated
 * explicitly so nobody re-derives Find's own two-round termination argument
 * looking for the equivalent here.
 */
export function createSelectionPlugin(
  onSelectionChanged: (snapshot: SelectionSnapshot | null) => void
): Plugin {
  return new Plugin({
    key: selectionPluginKey,
    view: (view) => {
      // The last snapshot actually handed to React. Comparing against THIS
      // (rather than deriving one from the `prevState` argument) is what lets
      // the focus/blur listeners share the same early-return path -- they have
      // no prevState to derive anything from.
      let reported: SelectionSnapshot | null = null

      const report = (): void => {
        const next = readSelectionSnapshot(view)
        if (sameSnapshot(reported, next)) return
        reported = next
        onSelectionChanged(next)
      }

      view.dom.addEventListener('focus', report)
      view.dom.addEventListener('blur', report)

      return {
        update: () => report(),
        destroy: () => {
          view.dom.removeEventListener('focus', report)
          view.dom.removeEventListener('blur', report)
          onSelectionChanged(null)
        }
      }
    }
  })
}
