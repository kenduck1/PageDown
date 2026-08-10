import { describe, it, expect, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { editorViewCtx, type Editor } from '@milkdown/core'
import { getMarkdown } from '@milkdown/utils'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { createTestEditor } from './test-editor'
import { EDITOR_COMMAND_PLUGINS } from './commands'
import { EDITOR_SCHEMA_PLUGINS } from './plugins'
import { buildEditorCommands, type EditorCommands } from './editor-commands'

afterEach(() => {
  cleanup()
})

// Table structure editing, asserted against the RESULTING MARKDOWN rather than
// the ProseMirror node shape -- the markdown is the contract (it is the file on
// disk, and the input to every other rendering surface), and a node-shape
// assertion can be perfectly green while the serializer drops the change.
//
// Everything here goes through buildEditorCommands, i.e. the exact object
// MilkdownEditor.tsx hands to the toolbar and the selection bubble, for the
// same anti-drift reason that function's own doc comment already gives: a test
// that dispatched the preset command keys directly would verify the COMMANDS
// work, not that this app is wired to the right ones.

const PLUGINS = [...EDITOR_SCHEMA_PLUGINS.flat(), ...EDITOR_COMMAND_PLUGINS]

// A 2x2 GFM table with no alignment markers -- the shape this app's own
// "Insert table" button produces, and the shape its Invoice/Report templates
// use. Round-trips to `| - |` delimiters (remark-stringify's own minimal form)
// with the cell text untouched.
const TABLE = '| a | b |\n| --- | --- |\n| x | y |\n'
// What TABLE round-trips to untouched. remark-stringify emits the MINIMAL
// delimiter row and pads every column to its widest cell, so `| --- |` on the
// way in comes back as `| - |`. (Before the empty-cell fix below, a test
// whose table gained a `<br />` cell -- six characters -- saw every delimiter
// in that column widen to match; that's gone now that an empty cell is
// genuinely empty instead.) Pinning the exact bytes is the point throughout
// this file: it's asserting the file on disk, not a prettified view of it.
const TABLE_ROUNDTRIP = '| a | b |\n| - | - |\n| x | y |\n'

interface Harness {
  editor: Editor
  view: EditorView
  commands: EditorCommands
  markdown: () => string
  caretAt: (text: string) => void
}

async function harness(source: string): Promise<Harness> {
  const editor = await createTestEditor(source, PLUGINS)
  const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
  return {
    editor,
    view,
    commands: buildEditorCommands(editor),
    markdown: () => editor.action(getMarkdown()),
    caretAt: (text: string) => {
      let pos: number | null = null
      view.state.doc.descendants((node, p) => {
        if (node.isText && node.text === text) pos = p + 1
        return true
      })
      if (pos === null) throw new Error(`no text node "${text}"`)
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
    }
  }
}

// FIXED (product-completeness audit, Tier 1): an EMPTY table cell used to
// serialize as `<br />`, whatever created it -- the shipped "Insert table"
// toolbar button had always produced `| <br /> | <br /> |`, non-portable HTML
// landing in the user's file before they had typed anything. This describe
// block used to PIN that as pre-existing, deliberately-not-this-file's-fault
// behaviour; it now pins the CORRECTED behaviour instead, deliberately, so a
// regression back to `<br />` fails loudly. Root cause (see
// table-cell-empty-fix.ts's own header comment for the full writeup): not a
// table-specific bug at all -- @milkdown/preset-commonmark's paragraphSchema
// substitutes `<br />` for ANY genuinely empty paragraph so a deliberately
// blank line in the document BODY survives a save/reopen round trip, and a
// GFM table cell's own required paragraph child tripped that same
// substitution even though `|  |` already represents an empty cell
// unambiguously. Fixed
// by overriding table_cell/table_header's own toMarkdown runners to stop
// delegating into that substitution specifically.
describe('empty table cells (fixed serializer behaviour)', () => {
  it('serializes a hand-written empty cell as a blank cell, not <br />', async () => {
    const { markdown } = await harness('| a | b |\n| --- | --- |\n|  | y |\n')
    const result = markdown()
    expect(result).not.toContain('<br')
    expect(result).toBe('| a | b |\n| - | - |\n|   | y |\n')
  })

  // Verifies the fix against the REAL serializer's round trip, not just the
  // one-way output: feeding the corrected markdown back through a fresh
  // editor instance must parse it back to an equivalent table and re-emit
  // the SAME bytes -- a stable fixed point -- proving `|   |` really does
  // parse as an empty cell rather than, say, losing the row or column
  // entirely on reparse.
  it('the corrected empty-cell markdown round-trips to itself', async () => {
    const { markdown: firstPass } = await harness('| a | b |\n| --- | --- |\n|  | y |\n')
    const onceSerialized = firstPass()
    const { markdown: secondPass } = await harness(onceSerialized)
    expect(secondPass()).toBe(onceSerialized)
  })

  // A cell that is NOT empty -- including one with no TEXT but very much not
  // blank (an image) -- must take the exact original path and round-trip
  // untouched. Guards against an over-broad "is this cell empty" check that
  // would silently drop real content instead of only a genuinely empty one.
  it('leaves a non-empty cell (including an image-only one) completely untouched', async () => {
    const { markdown } = await harness('| a | b |\n| --- | --- |\n| ![x](y.png) | z |\n')
    expect(markdown()).toBe('| a           | b |\n| ----------- | - |\n| ![x](y.png) | z |\n')
  })
})

describe('adding rows and columns', () => {
  it('addRowAfter appends a row below the caret row', async () => {
    const { commands, markdown, caretAt } = await harness(TABLE)
    caretAt('x')
    commands.addRowAfter()
    // The new row's cells are genuinely empty (`|   |`), not `<br />` --
    // see table-cell-empty-fix.ts. Delimiter row is minimal (`- -`, not
    // `------`) because nothing in this table is wide enough to need padding
    // now that `<br />`'s six characters no longer inflate the column width.
    expect(markdown()).toBe('| a | b |\n| - | - |\n| x | y |\n|   |   |\n')
  })

  it('addRowBefore inserts a row above the caret row', async () => {
    const { commands, markdown, caretAt } = await harness(TABLE)
    caretAt('x')
    commands.addRowBefore()
    expect(markdown()).toBe('| a | b |\n| - | - |\n|   |   |\n| x | y |\n')
  })

  it('addColumnAfter inserts a column to the right of the caret column', async () => {
    const { commands, markdown, caretAt } = await harness(TABLE)
    caretAt('x')
    commands.addColumnAfter()
    // The new column carries `:-`, not `:-----`: prosemirror-tables builds
    // its cells with `createAndFill()`, which takes the gfm schema's own
    // `alignment` default of 'left'. Pre-existing preset behaviour, pinned
    // here so a future change to it is visible rather than silent -- the
    // delimiter itself shrank from `:-----` to `:-` versus this test's own
    // pre-fix pin, purely because the column's cells are now genuinely empty
    // rather than the six-character `<br />` string.
    expect(markdown()).toBe('| a |    | b |\n| - | :- | - |\n| x |    | y |\n')
  })

  it('addColumnBefore inserts a column to the left of the caret column', async () => {
    const { commands, markdown, caretAt } = await harness(TABLE)
    caretAt('y')
    commands.addColumnBefore()
    expect(markdown()).toBe('| a |    | b |\n| - | :- | - |\n| x |    | y |\n')
  })

  it('does nothing at all outside a table', async () => {
    const { commands, markdown } = await harness('Just a paragraph.\n')
    commands.addRowAfter()
    commands.addColumnAfter()
    expect(markdown()).toBe('Just a paragraph.\n')
  })
})

// The three delete commands are this project's own (commands.ts) rather than
// the preset's `deleteSelectedCellsCommand`, which refuses outright unless the
// selection is a CellSelection -- i.e. unless the user has drag-selected cells
// first. A caret is what a user editing a table actually has, so these tests
// drive them from a plain caret specifically.
describe('deleting rows, columns and the whole table', () => {
  it('deleteRow removes the caret row from a plain caret', async () => {
    const { commands, markdown, caretAt } = await harness(
      '| a | b |\n| --- | --- |\n| x | y |\n| p | q |\n'
    )
    caretAt('x')
    commands.deleteRow()
    expect(markdown()).toBe('| a | b |\n| - | - |\n| p | q |\n')
  })

  it('deleteColumn removes the caret column from a plain caret', async () => {
    const { commands, markdown, caretAt } = await harness(
      '| a | b | c |\n| --- | --- | --- |\n| x | y | z |\n'
    )
    caretAt('y')
    commands.deleteColumn()
    expect(markdown()).toBe('| a | c |\n| - | - |\n| x | z |\n')
  })

  it('deleteTable removes the entire table', async () => {
    const { commands, markdown, caretAt } = await harness(`Before.\n\n${TABLE}\nAfter.\n`)
    caretAt('x')
    commands.deleteTable()
    const result = markdown()
    expect(result).not.toContain('|')
    expect(result).toContain('Before.')
    expect(result).toContain('After.')
  })

  it('does nothing at all outside a table', async () => {
    const { commands, markdown } = await harness('Just a paragraph.\n')
    commands.deleteRow()
    commands.deleteColumn()
    commands.deleteTable()
    expect(markdown()).toBe('Just a paragraph.\n')
  })
})

describe('column alignment', () => {
  // THE test this command exists for. The preset's own setAlignCommand writes
  // only the cell(s) the selection covers, so invoking it from a BODY cell
  // writes an attr that (a) never serializes -- only the header row's does --
  // and (b) keepTableAlignPlugin overwrites from the header on the very next
  // transaction. Driving from a body cell and asserting the emitted delimiter
  // row is what proves this project's command targets the whole column.
  it('sets the delimiter row from a BODY cell, not just the caret cell', async () => {
    const { commands, markdown, caretAt } = await harness(
      '| a | b | c |\n| --- | --- | --- |\n| x | y | z |\n'
    )
    caretAt('y')
    commands.setColumnAlignment('center')
    expect(markdown()).toContain('| - | :-: | - |')
  })

  it('supports left and right too, per column, independently', async () => {
    const { commands, markdown, caretAt } = await harness(
      '| a | b | c |\n| --- | --- | --- |\n| x | y | z |\n'
    )
    caretAt('x')
    commands.setColumnAlignment('left')
    caretAt('z')
    commands.setColumnAlignment('right')
    expect(markdown()).toContain('| :- | - | -: |')
  })

  it('is a no-op when the column already has that alignment', async () => {
    const { commands, markdown, caretAt } = await harness('| a |\n| :-: |\n| x |\n')
    caretAt('x')
    const before = markdown()
    commands.setColumnAlignment('center')
    expect(markdown()).toBe(before)
  })

  it('does nothing outside a table', async () => {
    const { commands, markdown } = await harness('Just a paragraph.\n')
    commands.setColumnAlignment('center')
    expect(markdown()).toBe('Just a paragraph.\n')
  })
})

// Tab-appends-a-row. Testable here (unlike a prosemirror-keymap binding, which
// CLAUDE.md documents as unreachable from a jsdom-dispatched keydown) because
// this is a $prose plugin's own `props.handleKeyDown` -- a different dispatch
// path, and one fireEvent/dispatchEvent genuinely does reach, per the slash
// menu's own recorded finding.
describe('Tab in a table', () => {
  function pressTab(view: EditorView, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
      ...init
    })
    view.dom.dispatchEvent(event)
    return event
  }

  it('appends a row when the caret is in the LAST cell', async () => {
    const { view, markdown, caretAt } = await harness(TABLE)
    caretAt('y')
    const event = pressTab(view)
    expect(event.defaultPrevented).toBe(true)
    expect(markdown()).toBe('| a | b |\n| - | - |\n| x | y |\n|   |   |\n')
  })

  it('leaves the document alone in a NON-last cell (the preset moves the caret instead)', async () => {
    const { view, markdown, caretAt } = await harness(TABLE)
    caretAt('x')
    const before = view.state.selection.from
    pressTab(view)
    expect(markdown()).toBe(TABLE_ROUNDTRIP)
    // Proves the fall-through actually reached the preset's own Tab binding
    // rather than simply being swallowed: the caret moved to the next cell.
    expect(view.state.selection.from).toBeGreaterThan(before)
  })

  it('does not fire for Shift-Tab, which is the preset’s "previous cell"', async () => {
    const { view, markdown, caretAt } = await harness(TABLE)
    caretAt('y')
    pressTab(view, { shiftKey: true })
    expect(markdown()).toBe(TABLE_ROUNDTRIP)
  })

  it('does not fire outside a table', async () => {
    const { view, markdown } = await harness('Just a paragraph.\n')
    const event = pressTab(view)
    expect(event.defaultPrevented).toBe(false)
    expect(markdown()).toBe('Just a paragraph.\n')
  })
})
