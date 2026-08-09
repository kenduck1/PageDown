import { describe, it, expect, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { commandsCtx, editorViewCtx } from '@milkdown/core'
import { getMarkdown, insert } from '@milkdown/utils'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { createTestEditor } from './test-editor'
import {
  EDITOR_COMMAND_PLUGINS,
  undoCommand,
  redoCommand,
  addCommentCommand,
  resolveCommentCommand,
  insertTaskListCommand,
  insertMathBlockCommand,
  insertMermaidBlockCommand
} from './commands'
import { EDITOR_SCHEMA_PLUGINS } from './plugins'

afterEach(() => {
  cleanup()
})

// historyKeymap (commands.ts) is what these tests exist to verify: before it
// existed, prosemirror-history's undo/redo STATE was tracked (the toolbar's
// own Undo/Redo buttons already worked, via undoCommand/redoCommand called
// directly), but no keyboard shortcut triggered either -- Mod-z did nothing
// at all in Format mode.
//
// What these tests do NOT cover, and why: a real `fireEvent.keyDown()`
// dispatched at the mounted ProseMirror view's own DOM node does not reach
// prosemirror-keymap's own event handling in this project's jsdom test
// environment -- confirmed directly, not assumed, by writing a throwaway
// diagnostic test against a STOCK, pre-existing Milkdown shortcut
// (@milkdown/preset-commonmark's own Mod-b bold toggle, wired by the preset
// itself, nothing this project built) using the exact same technique: it
// failed identically. That rules out a bug in historyKeymap's own
// configuration and narrows this to a genuine jsdom limitation (jsdom's
// contentEditable/Selection support is well known to be incomplete, and
// ProseMirror's own event routing depends on it) -- the same class of gap
// MilkdownEditor.test.tsx's own comment on `userEvent.type()` already
// documents for input rules. So: these tests verify the COMMAND half
// (commands.call(undoCommand.key)/redoCommand.key) actually undoes/redoes a
// real edit when invoked directly -- proving the keymap's own command
// callbacks are correct -- and phase0/gate-format-mode-shortcuts.spec.ts (a
// real Playwright gate against the actual built app, real Chromium, not
// jsdom) covers the keyboard-dispatch half this file structurally cannot.
describe('historyKeymap command wiring', () => {
  it('EDITOR_COMMAND_PLUGINS includes historyKeymap (not silently dropped by .flat())', () => {
    // $useKeymap() results are arrays under the hood (see commands.ts's own
    // comment on why EDITOR_COMMAND_PLUGINS ends in .flat()) -- this asserts
    // the flattened array is genuinely non-empty and longer than it would be
    // without a keymap plugin, not just that the expression doesn't throw.
    expect(EDITOR_COMMAND_PLUGINS.length).toBeGreaterThan(4)
  })

  it("undoCommand's own callback (what historyKeymap's Undo shortcut dispatches) reverts a real edit", async () => {
    const editor = await createTestEditor('# Hello', EDITOR_COMMAND_PLUGINS)
    editor.action(insert(' World'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(editor.action(getMarkdown())).toContain('World')

    editor.action((ctx) => {
      const commands = ctx.get(commandsCtx)
      commands.call(undoCommand.key)
    })

    expect(editor.action(getMarkdown())).not.toContain('World')
  })

  it("redoCommand's own callback (what historyKeymap's Redo shortcuts dispatch) re-applies an edit just undone", async () => {
    const editor = await createTestEditor('# Hello', EDITOR_COMMAND_PLUGINS)
    editor.action(insert(' World'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    editor.action((ctx) => ctx.get(commandsCtx).call(undoCommand.key))
    expect(editor.action(getMarkdown())).not.toContain('World')

    editor.action((ctx) => ctx.get(commandsCtx).call(redoCommand.key))
    expect(editor.action(getMarkdown())).toContain('World')
  })
})

// addCommentCommand/resolveCommentCommand need commentSchema's mark TYPE
// registered, which lives in EDITOR_SCHEMA_PLUGINS (plugins.ts), not
// EDITOR_COMMAND_PLUGINS (commands.ts) -- both must be mounted together
// here, unlike historyKeymap's own tests above, which only ever needed
// commonmark/gfm's base schema (createTestEditor's own unconditional base).
describe('comment mark commands', () => {
  const PLUGINS = [...EDITOR_SCHEMA_PLUGINS.flat(), ...EDITOR_COMMAND_PLUGINS]

  it('addCommentCommand marks the current selection with a real comment mark that round-trips', async () => {
    const editor = await createTestEditor('Some plain text here.', PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView

    // "plain" is characters 5-10 of "Some plain text here."; position 1 is
    // where a single top-level paragraph's own text content begins.
    const from = 1 + 5
    const to = 1 + 10
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))

    const applied = editor.action((ctx) =>
      ctx.get(commandsCtx).call(addCommentCommand.key, { author: 'Kai', text: 'a note' })
    )
    expect(applied).toBe(true)

    const output = editor.action(getMarkdown())
    expect(output).toContain('plain')
    expect(output).toContain('<!--comment id="')
    expect(output).toContain('<!--/comment id="')
  })

  it('addCommentCommand refuses an empty selection', async () => {
    const editor = await createTestEditor('Some plain text here.', PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 3)))

    const applied = editor.action((ctx) =>
      ctx.get(commandsCtx).call(addCommentCommand.key, { author: 'Kai', text: 'a note' })
    )
    expect(applied).toBe(false)
    expect(editor.action(getMarkdown())).not.toContain('<!--comment')
  })

  it('resolveCommentCommand removes every mark instance for the given id, leaving the text intact', async () => {
    const editor = await createTestEditor('Some plain text here.', PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6, 11)))
    editor.action((ctx) =>
      ctx.get(commandsCtx).call(addCommentCommand.key, { author: 'Kai', text: 'a note' })
    )

    const withComment = editor.action(getMarkdown())
    const idMatch = withComment.match(/<!--comment id="([^"]+)"/)
    expect(idMatch).not.toBeNull()

    const resolved = editor.action((ctx) =>
      ctx.get(commandsCtx).call(resolveCommentCommand.key, idMatch![1])
    )
    expect(resolved).toBe(true)

    const output = editor.action(getMarkdown())
    expect(output).not.toContain('<!--comment')
    expect(output).not.toContain('<!--/comment')
    expect(output).toContain('plain')
  })

  it('resolveCommentCommand returns false for an id that is not present', async () => {
    const editor = await createTestEditor('Some plain text here.', PLUGINS)
    const resolved = editor.action((ctx) =>
      ctx.get(commandsCtx).call(resolveCommentCommand.key, 'not-a-real-id')
    )
    expect(resolved).toBe(false)
  })
})

// insertTaskListCommand/insertMathBlockCommand/insertMermaidBlockCommand
// need no schema beyond what commonmark/gfm already register (task list
// reuses gfm's existing extendListItemSchemaForTask `checked` attr; math
// reuses commonmark's own hardbreak/text; mermaid reuses commonmark's own
// code_block) -- so, like the historyKeymap tests above and unlike the
// comment-mark tests, EDITOR_COMMAND_PLUGINS alone is enough (createTestEditor
// always mounts commonmark+gfm as its own unconditional baseline).
describe('insertTaskListCommand', () => {
  it('wraps the current block in a task-list item that serializes to exactly "- [ ] "', async () => {
    const editor = await createTestEditor('Buy milk', EDITOR_COMMAND_PLUGINS)
    const applied = editor.action((ctx) => ctx.get(commandsCtx).call(insertTaskListCommand.key))
    expect(applied).toBe(true)
    expect(editor.action(getMarkdown())).toBe('- [ ] Buy milk\n')
  })

  it('is a real ProseMirror Command: dry-run (called via a Command function directly, with no dispatch) mutates nothing', async () => {
    // Exercises the command's OWN returned function with dispatch omitted --
    // the standard ProseMirror "is this applicable" convention -- rather
    // than going through commandsCtx.call (which always supplies a real
    // dispatch), to prove the guard this file's own module comment
    // describes (every dispatch?.(...) call site) actually holds.
    const editor = await createTestEditor('Buy milk', EDITOR_COMMAND_PLUGINS)
    const before = editor.action(getMarkdown())
    editor.action((ctx) => {
      const command = ctx.get(commandsCtx).get(insertTaskListCommand.key)(undefined)
      const view = ctx.get(editorViewCtx)
      const applicable = command(view.state)
      expect(applicable).toBe(true)
    })
    expect(editor.action(getMarkdown())).toBe(before)
  })
})

describe('insertMathBlockCommand', () => {
  it('replaces the current block with the $$ math placeholder sequence, exactly matching the verified round-trip recipe', async () => {
    const editor = await createTestEditor('Some text', EDITOR_COMMAND_PLUGINS)
    const applied = editor.action((ctx) => ctx.get(commandsCtx).call(insertMathBlockCommand.key))
    expect(applied).toBe(true)
    expect(editor.action(getMarkdown())).toBe('$$\nx^2\n$$\n')
  })

  it('selects the placeholder text ("x^2") so the next keystroke types over it, not the surrounding $$/hardbreaks', async () => {
    const editor = await createTestEditor('Some text', EDITOR_COMMAND_PLUGINS)
    editor.action((ctx) => ctx.get(commandsCtx).call(insertMathBlockCommand.key))
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    const selected = view.state.doc.textBetween(
      view.state.selection.from,
      view.state.selection.to,
      ' '
    )
    expect(selected).toBe('x^2')
  })

  it('refuses (returns false, mutates nothing) inside a code block, whose schema has no room for a hardbreak', async () => {
    const source = '```js\nconsole.log(1)\n```\n'
    const editor = await createTestEditor(source, EDITOR_COMMAND_PLUGINS)
    const applied = editor.action((ctx) => ctx.get(commandsCtx).call(insertMathBlockCommand.key))
    expect(applied).toBe(false)
    expect(editor.action(getMarkdown())).toBe(source)
  })
})

describe('insertMermaidBlockCommand', () => {
  it('converts the current block into a ```mermaid fenced code block carrying the placeholder diagram', async () => {
    const editor = await createTestEditor('Some text', EDITOR_COMMAND_PLUGINS)
    const applied = editor.action((ctx) => ctx.get(commandsCtx).call(insertMermaidBlockCommand.key))
    expect(applied).toBe(true)
    expect(editor.action(getMarkdown())).toBe('```mermaid\ngraph TD;\n  A-->B;\n```\n')
  })

  it('replaces whatever text the block already held, rather than prepending the placeholder before it', async () => {
    // Regression test for the reverse-of-drop-image-style bug this command's
    // own doc comment describes: an earlier probe that inserted the
    // placeholder at the post-conversion cursor (instead of replacing the
    // block's content) produced "graph TD;\n  A-->B;Hello world." -- the
    // placeholder glued onto the pre-existing text with no separator, since
    // a code_block's `text*` content has no block boundary to split on.
    const editor = await createTestEditor('Hello world.', EDITOR_COMMAND_PLUGINS)
    editor.action((ctx) => ctx.get(commandsCtx).call(insertMermaidBlockCommand.key))
    const output = editor.action(getMarkdown())
    expect(output).toBe('```mermaid\ngraph TD;\n  A-->B;\n```\n')
    expect(output).not.toContain('Hello world.')
  })
})
