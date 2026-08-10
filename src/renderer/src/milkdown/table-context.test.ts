import { describe, it, expect, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { editorViewCtx } from '@milkdown/core'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { createTestEditor } from './test-editor'
import { EDITOR_COMMAND_PLUGINS } from './commands'
import { EDITOR_SCHEMA_PLUGINS } from './plugins'
import { columnCellPositions, findTableContext } from './table-context'

afterEach(() => {
  cleanup()
})

const PLUGINS = [...EDITOR_SCHEMA_PLUGINS.flat(), ...EDITOR_COMMAND_PLUGINS]

function caretAt(view: EditorView, text: string): void {
  let pos: number | null = null
  view.state.doc.descendants((node, p) => {
    if (node.isText && node.text === text) pos = p + 1
    return true
  })
  if (pos === null) throw new Error(`no text node "${text}"`)
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
}

async function open(source: string): Promise<EditorView> {
  const editor = await createTestEditor(source, PLUGINS)
  return editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
}

describe('findTableContext', () => {
  it('is null outside a table', async () => {
    const view = await open('Just a paragraph.')
    expect(findTableContext(view.state)).toBeNull()
  })

  it('reports the enclosing table and the caret column from a BODY cell', async () => {
    const view = await open('| a | b | c |\n| --- | --- | --- |\n| x | y | z |\n')
    caretAt(view, 'y')
    expect(findTableContext(view.state)).toEqual({ tablePos: 0, column: 1, alignment: null })
  })

  it('reports the same column from a HEADER cell', async () => {
    const view = await open('| a | b | c |\n| --- | --- | --- |\n| x | y | z |\n')
    caretAt(view, 'c')
    expect(findTableContext(view.state)?.column).toBe(2)
  })

  // The single most important property in this module: the alignment reported
  // for a BODY cell is its COLUMN's, taken from the header row -- the only
  // alignment markdown carries. Reading `$from.node(cellDepth).attrs.alignment`
  // instead would look identical on a freshly-parsed document (because
  // keepTableAlignPlugin mirrors header -> body) and diverge the moment
  // anything writes a body cell directly, which is exactly what the preset's
  // own setAlignCommand does.
  it('reports a BODY cell alignment from the column HEADER, per column', async () => {
    const view = await open('| a | b | c |\n| :-- | :-: | --: |\n| x | y | z |\n')
    caretAt(view, 'x')
    expect(findTableContext(view.state)?.alignment).toBe('left')
    caretAt(view, 'y')
    expect(findTableContext(view.state)?.alignment).toBe('center')
    caretAt(view, 'z')
    expect(findTableContext(view.state)?.alignment).toBe('right')
  })

  // `| --- |` (no markers) parses to a genuine null, NOT to the schema's own
  // 'left' default -- and it has to stay null, or every table this editor
  // merely opens would be rewritten with explicit `:---` markers on the next
  // save.
  it('reports null (not "left") for a column with no alignment markers', async () => {
    const view = await open('| a |\n| --- |\n| x |\n')
    caretAt(view, 'x')
    expect(findTableContext(view.state)?.alignment).toBeNull()
  })

  it('tracks the table position, so two tables are told apart', async () => {
    const view = await open('| a |\n| --- |\n| x |\n\ntext\n\n| b |\n| --- |\n| y |\n')
    caretAt(view, 'x')
    const first = findTableContext(view.state)
    caretAt(view, 'y')
    const second = findTableContext(view.state)
    expect(first?.tablePos).not.toBe(second?.tablePos)
  })
})

describe('columnCellPositions', () => {
  it('returns one position per row, header included, in document order', async () => {
    const view = await open('| a | b |\n| --- | --- |\n| x | y |\n| p | q |\n')
    caretAt(view, 'y')
    const context = findTableContext(view.state)!
    const positions = columnCellPositions(view.state, context)
    expect(positions).toHaveLength(3)
    expect([...positions].sort((m, n) => m - n)).toEqual(positions)
    // Every returned position must actually be a cell of the requested
    // column -- asserted by reading the real node back, not by trusting the
    // arithmetic that produced it.
    for (const pos of positions) {
      const node = view.state.doc.nodeAt(pos)
      expect(['table_cell', 'table_header']).toContain(node?.type.name)
    }
    expect(positions.map((pos) => view.state.doc.nodeAt(pos)?.textContent)).toEqual(['b', 'y', 'q'])
  })
})
