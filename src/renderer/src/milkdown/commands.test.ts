import { describe, it, expect, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { commandsCtx } from '@milkdown/core'
import { getMarkdown, insert } from '@milkdown/utils'
import { createTestEditor } from './test-editor'
import { EDITOR_COMMAND_PLUGINS, undoCommand, redoCommand } from './commands'

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
