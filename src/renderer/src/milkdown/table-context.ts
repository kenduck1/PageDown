import { TableMap } from '@milkdown/prose/tables'
import type { Node as ProseNode } from '@milkdown/prose/model'
import type { EditorState } from '@milkdown/prose/state'

// "Where is the selection, relative to the table it is inside?" -- the one
// shared answer, used by BOTH the selection snapshot (selection-plugin.ts,
// which drives the bubble's visibility and its alignment buttons' pressed
// state) and the real column-alignment command (commands.ts). Kept in its own
// module rather than inside either of those for the same reason
// findAncestorListType was moved into selection-plugin.ts: an indicator
// computed by one ancestor walk and an action computed by a second copy of
// that walk is exactly how the two silently start disagreeing.
//
// Deliberately ctx-free and view-free -- it takes an EditorState and nothing
// else -- so it is directly unit-testable against a real document without
// mounting an editor.

export type TableAlignment = 'left' | 'center' | 'right'

export interface TableContext {
  /**
   * Document position of the enclosing `table` node itself. Stable while
   * typing anywhere inside that table (a cell's own start position does not
   * move when characters are added after it), which is what lets the selection
   * bubble anchor to the table and stay put per keystroke -- see
   * `sameSnapshot`'s collapsed-selection rule in selection-plugin.ts.
   */
  tablePos: number
  /**
   * 0-based column index of the cell holding the selection head.
   *
   * The cell's own document POSITION is deliberately not carried here. It has
   * no consumer -- every command re-derives its own context from live state at
   * dispatch time rather than trusting a snapshot -- so publishing it would
   * only create a field that can go stale between reports.
   */
  column: number
  /**
   * The column's alignment AS IT WILL SERIALIZE. Read from the column's own
   * HEADER cell, never from the body cell the caret happens to sit in, because
   * that is the only one markdown actually carries -- see
   * `readColumnAlignment` below.
   */
  alignment: TableAlignment | null
}

const CELL_TYPES = new Set(['table_cell', 'table_header'])

/**
 * The alignment `@milkdown/preset-gfm`'s own `tableSchema.toMarkdown` runner
 * will emit for column `column`.
 *
 * READ FROM THE HEADER ROW, and that is the whole point of this helper rather
 * than an incidental detail. Confirmed by reading the installed preset's
 * source (7.21.3, `lib/index.js`), two facts that only bite together:
 *
 *  1. `tableSchema`'s `toMarkdown` runner builds its `align` array by walking
 *     `node.content.firstChild` -- the header row -- and reading each cell's
 *     `alignment` attr. Body cells' own `alignment` attrs are never consulted
 *     and never serialize.
 *  2. `keepTableAlignPlugin` (a real `appendTransaction` in the preset's own
 *     plugin list) copies each header cell's `alignment` DOWN onto every body
 *     cell in that column on every doc-changing transaction.
 *
 * So a body cell's alignment attr is a derived, overwritten mirror. This is
 * also exactly why the preset's own `setAlignCommand` is NOT usable from an
 * ordinary caret: it is `setCellAttr('alignment', ...)`, which writes only the
 * cell(s) the selection covers, so invoking it in a body cell writes a value
 * `keepTableAlignPlugin` reverts on the very next transaction and which could
 * never have serialized anyway. `setColumnAlignmentCommand` (commands.ts)
 * writes the whole column, header included, for that reason.
 */
function readColumnAlignment(
  table: ProseNode,
  map: TableMap,
  column: number
): TableAlignment | null {
  // map.map is row-major, so index `column` is row 0 -- the header row --
  // regardless of the caret's own row. Positions in `map.map` are relative to
  // the start of the table's CONTENT, which is precisely what Node#nodeAt
  // takes (the same call prosemirror-tables' own `columnIsHeader` makes).
  const headerCell = table.nodeAt(map.map[column])
  const alignment = headerCell?.attrs.alignment
  // The schema's own default is the string 'left', but a table parsed from
  // `| --- |` (no alignment markers) carries a genuine `null` -- which must
  // round-trip back to `| --- |` rather than being reported, and then written,
  // as an explicit left alignment.
  return alignment === 'left' || alignment === 'center' || alignment === 'right' ? alignment : null
}

/**
 * The table context of the current selection head, or null when the selection
 * is not inside a table at all.
 *
 * Walks every ancestor depth rather than only `$from.parent`, because the
 * chain from a caret is `paragraph -> table_cell -> table_row -> table` (a
 * cell's content model is the rigid single-child `paragraph`, see
 * `isInsideTableCell`'s own note in commands.ts).
 */
export function findTableContext(state: EditorState): TableContext | null {
  const $from = state.selection.$from
  let cellPos: number | null = null
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (cellPos === null && CELL_TYPES.has(node.type.name)) {
      cellPos = $from.before(depth)
      continue
    }
    if (node.type.name !== 'table') continue

    // A `table` ancestor with no cell ancestor below it is not a shape this
    // schema can produce (`table > table_header_row|table_row > cell`), but
    // returning null beats computing a column index off a bogus position.
    if (cellPos === null) return null
    const tablePos = $from.before(depth)
    const table = node
    const map = TableMap.get(table)
    // `colCount` takes a position relative to the start of the table's
    // content, hence the `- (tablePos + 1)`.
    const column = map.colCount(cellPos - (tablePos + 1))
    return { tablePos, column, alignment: readColumnAlignment(table, map, column) }
  }
  return null
}

/**
 * Every cell position (absolute, document coordinates) in column `column` of
 * the table at `tablePos`, header row included.
 *
 * Returned in document order and de-duplicated: `TableMap` records one entry
 * per covered grid slot, so a (hypothetical) `colspan`-ed cell appears once
 * per slot it spans. GFM markdown cannot express a spanned cell at all, so
 * this cannot arise from a parsed document -- the de-dupe is a cheap guard for
 * a document built some other way, not an expected case.
 */
export function columnCellPositions(state: EditorState, context: TableContext): number[] {
  const table = state.doc.nodeAt(context.tablePos)
  if (!table) return []
  const map = TableMap.get(table)
  const tableStart = context.tablePos + 1
  const seen = new Set<number>()
  for (let row = 0; row < map.height; row++) {
    seen.add(tableStart + map.map[row * map.width + context.column])
  }
  return [...seen].sort((a, b) => a - b)
}
