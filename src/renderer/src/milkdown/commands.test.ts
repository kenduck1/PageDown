import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import type { Editor } from '@milkdown/core'
import { commandsCtx, editorViewCtx } from '@milkdown/core'
import { getMarkdown, insert } from '@milkdown/utils'
import { TextSelection } from '@milkdown/prose/state'
import { splitBlock } from '@milkdown/prose/commands'
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
  insertMermaidBlockCommand,
  insertPagebreakCommand,
  isInsideTableCell
} from './commands'
import { EDITOR_SCHEMA_PLUGINS } from './plugins'
import { extractComments } from '../lib/extractComments'

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
// callbacks are correct -- and tests/gates/gate-format-mode-shortcuts.spec.ts (a
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

  // The save/reload round trip for a MULTI-LINE comment body, driven through
  // the real editor rather than the plugin in isolation: the editor serialises
  // to markdown bytes (what a Save writes), and extractComments reads those
  // bytes back exactly as the Comments sidebar does on the next open.
  //
  // Note what this does NOT change: the comment MARK still spans inline
  // content within one block ("plain"), which is the design's real, deliberate
  // scope boundary. Only the body is multi-line.
  it('a multi-line comment BODY survives serialisation and is read back with its newlines', async () => {
    const editor = await createTestEditor('Some plain text here.', PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6, 11)))

    const body = 'First paragraph.\n\nSecond paragraph, after a blank line.'
    const applied = editor.action((ctx) =>
      ctx.get(commandsCtx).call(addCommentCommand.key, { author: 'Kai', text: body })
    )
    expect(applied).toBe(true)

    const saved = editor.action(getMarkdown())
    // The marker itself stays ONE line no matter how many lines the body has
    // -- base64 emits no newline -- which is what keeps the one-line marker
    // regexes in comment-plugin.ts valid.
    const markerLine = saved.split('\n').find((line) => line.includes('<!--comment id='))
    expect(markerLine).toContain('<!--/comment id=')

    const [reloaded] = extractComments(saved)
    expect(reloaded.text).toBe(body)
    expect(reloaded.matchedText).toBe('plain')
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

  // Fix-round regression test (Critical 1): a heading is a textblock too
  // (headingSchema's content is also `inline*`), and its content ALSO
  // passes the validContent check just below the guard this test exercises
  // -- so the original `!blockNode.isTextblock` guard let this command run
  // against a heading, destroying its title text and producing a broken
  // `"$$\nx^2\n$$\n--\n"` (mdast-util-to-markdown falling back to Setext
  // underline syntax because of the embedded raw newlines), which was
  // neither a working heading nor working math (only a genuine paragraph's
  // content parses as remark-math block math). The pre-existing code-block
  // test just above does NOT exercise this branch -- it's refused by
  // `validContent` failing (no room for a hardbreak in `text*` content),
  // never reaching the paragraph-type check at all -- which is exactly why
  // this bug shipped without a failing test. Reproduced directly against
  // the pre-fix guard before writing this test, not assumed.
  it('refuses (returns false, mutates nothing) inside a heading -- only a paragraph is a valid target', async () => {
    const source = '## My Heading\n'
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

// insertPagebreakCommand needs BOTH the pagebreak node's own SCHEMA
// (EDITOR_SCHEMA_PLUGINS, per plugins.ts) and the command itself
// (EDITOR_COMMAND_PLUGINS) -- unlike the task-list/math/mermaid describe
// blocks above, which reuse pre-existing commonmark/gfm schema that
// createTestEditor already mounts unconditionally. Same PLUGINS composition
// as the 'comment mark commands' describe block above, re-declared locally
// rather than hoisted to module scope, matching that block's own precedent.
describe('insertPagebreakCommand', () => {
  const PLUGINS = [...EDITOR_SCHEMA_PLUGINS.flat(), ...EDITOR_COMMAND_PLUGINS]

  it('still inserts normally in a plain paragraph -- the fix must not regress the common case', async () => {
    const editor = await createTestEditor('Hello world', PLUGINS)
    const applied = editor.action((ctx) => ctx.get(commandsCtx).call(insertPagebreakCommand.key))
    expect(applied).toBe(true)
    expect(editor.action(getMarkdown())).toContain('<!-- pagebreak -->')
  })

  it('dry run (no dispatch) reports true for a plain paragraph -- was previously "always true" regardless of context, now happens to agree here', async () => {
    const editor = await createTestEditor('Hello world', PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    const dry = editor.action((ctx) => {
      const command = ctx.get(commandsCtx).get(insertPagebreakCommand.key)(undefined)
      return command(view.state)
    })
    expect(dry).toBe(true)
    // A dry run must never mutate, same convention as every other command's
    // own dry-run test in this file.
    expect(editor.action(getMarkdown())).toBe('Hello world\n')
  })

  // The measured, real bug this test reproduces (see isInsideTableCell's own
  // doc comment in commands.ts): a table cell's content model is exactly
  // ONE required paragraph, no siblings allowed, so replaceSelectionWith's
  // fitting algorithm doesn't refuse when it can't insert cleanly -- it
  // restructures the enclosing table instead. Before the fix, both the dry
  // run AND a real dispatch reported "true" here while silently corrupting
  // the table (a second, spurious table appeared, and the sibling cell's own
  // "y" content was replaced by an empty line). This is this command's own
  // version of the slash-menu's Math/Mermaid "block-replacing" hazard --
  // destructive, not just uninformative -- for a different container (an
  // ancestor table) instead of the immediate block's own content.
  it('refuses -- both dry run and real dispatch -- inside a table cell, leaving the table byte-for-byte untouched', async () => {
    const source = '| a | b |\n| --- | --- |\n| x | y |\n'
    const editor = await createTestEditor(source, PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView

    let cellTextPos: number | null = null
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'x') cellTextPos = pos + 1
      return true
    })
    expect(cellTextPos).not.toBeNull()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cellTextPos!)))

    // Baseline BEFORE the (refused) command, not the hand-typed source
    // string -- this project's pinned remark-stringify options normalize
    // the table-divider row (`---` -> `-`) on parse/serialize regardless of
    // this command, so comparing against `source` verbatim would fail on
    // that unrelated normalization rather than on genuine table corruption.
    const before = editor.action(getMarkdown())

    const dry = editor.action((ctx) => {
      const command = ctx.get(commandsCtx).get(insertPagebreakCommand.key)(undefined)
      return command(view.state)
    })
    expect(dry).toBe(false)

    const applied = editor.action((ctx) => ctx.get(commandsCtx).call(insertPagebreakCommand.key))
    expect(applied).toBe(false)
    expect(editor.action(getMarkdown())).toBe(before)
  })

  it('mid-paragraph in a plain top-level paragraph still splits cleanly -- pre-existing, collapsed-selection behavior, must not regress', async () => {
    // Direct regression coverage for the block-splitting behavior this
    // command's own top doc comment documents (collapsing to the selection's
    // start specifically to preserve it) -- proven here with real content on
    // BOTH sides of the insertion point, not just a collapsed-selection
    // no-op.
    const editor = await createTestEditor('Hello there world', PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    const pos = 1 + 'Hello there'.length
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
    const applied = editor.action((ctx) => ctx.get(commandsCtx).call(insertPagebreakCommand.key))
    expect(applied).toBe(true)
    const output = editor.action(getMarkdown())
    expect(output).toContain('Hello there')
    expect(output).toContain('world')
    expect(output).toContain('<!-- pagebreak -->')
  })
})

// isInsideTableCell is exported specifically so slash-items.ts (Task 4's
// palette catalogue) can apply the identical guard to insertTableCommand and
// insertHrCommand -- neither of which is this project's own command body to
// patch, but both of which share this exact failure mode (measured directly,
// see commands.ts's own comment on isInsideTableCell). Tested directly here,
// independent of insertPagebreakCommand's own integration test above, since
// it is now a reusable unit with its own call sites.
describe('isInsideTableCell', () => {
  const PLUGINS = [...EDITOR_SCHEMA_PLUGINS.flat(), ...EDITOR_COMMAND_PLUGINS]

  it('is false for a plain top-level paragraph', async () => {
    const editor = await createTestEditor('Hello world', PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    const result = editor.action((ctx) => isInsideTableCell(ctx, view.state))
    expect(result).toBe(false)
  })

  it('is true for a cursor inside a table cell (body row)', async () => {
    const source = '| a | b |\n| --- | --- |\n| x | y |\n'
    const editor = await createTestEditor(source, PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    let cellTextPos: number | null = null
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'x') cellTextPos = pos + 1
      return true
    })
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cellTextPos!)))
    const result = editor.action((ctx) => isInsideTableCell(ctx, view.state))
    expect(result).toBe(true)
  })

  it('is true for a cursor inside a table HEADER cell too, not just a body cell', async () => {
    const source = '| a | b |\n| --- | --- |\n| x | y |\n'
    const editor = await createTestEditor(source, PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    let cellTextPos: number | null = null
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'a') cellTextPos = pos + 1
      return true
    })
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cellTextPos!)))
    const result = editor.action((ctx) => isInsideTableCell(ctx, view.state))
    expect(result).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Undo grouping (historyProse's newGroupDelay + historyGroupingProse)
// ---------------------------------------------------------------------------
//
// The reported bug was "undo is choppy and sometimes undoes too much", which
// is one bug, not two: with `history()`'s defaults, grouping is purely
// time-based (`newGroupDelay: 500`), so how much one Cmd+Z removes is a
// function of TYPING SPEED and nothing else. These tests pin the property the
// fix is actually for -- that the number of undos to clear a sentence is the
// same whether it was typed quickly or slowly, and that it lands on word-ish
// units either way.
//
// Only `Date` is faked, never `setTimeout`: prosemirror-history reads
// `tr.time`, which Transaction's constructor sets from `Date.now()` (read from
// prosemirror-state's own source), so faking Date is exactly enough to control
// grouping -- while Milkdown's own async editor construction still needs real
// timers to resolve at all. `vi.useFakeTimers({ toFake: ['Date'] })` is what
// gives one without the other.
describe('undo grouping', () => {
  const START = new Date('2026-08-11T09:00:00.000Z')

  // Types one character per transaction, exactly like real keystrokes do
  // (each keypress is its own transaction carrying a one-character
  // ReplaceStep). `msBetweenKeystrokes` advances only the fake clock, so a
  // "slow" run is deterministic rather than a real wall-clock sleep.
  //
  // Dispatching transactions directly rather than firing key events is
  // forced, not preferred: this file's own historyKeymap comment records that
  // a real keydown does not reach prosemirror-keymap under jsdom at all. The
  // transaction shape is identical either way, which is what makes this a
  // faithful proxy for the thing under test (grouping is decided from
  // transactions, never from events).
  function type(view: EditorView, text: string, msBetweenKeystrokes = 0): void {
    for (const ch of text) {
      if (msBetweenKeystrokes > 0) vi.setSystemTime(new Date(Date.now() + msBetweenKeystrokes))
      view.dispatch(view.state.tr.insertText(ch))
    }
  }

  // How many Cmd+Z presses it takes to get back to an empty document --
  // literally the user-visible quantity the bug report is about. Bounded so a
  // regression fails with a real number instead of hanging.
  function undosToClear(editor: Editor, view: EditorView): number {
    let count = 0
    while (view.state.doc.textContent !== '' && count < 60) {
      editor.action((ctx) => ctx.get(commandsCtx).call(undoCommand.key))
      count++
    }
    return count
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  async function newEditor(): Promise<{ editor: Editor; view: EditorView }> {
    const editor = await createTestEditor('', EDITOR_COMMAND_PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    return { editor, view }
  }

  it('a four-word sentence takes exactly four undos when typed FAST', async () => {
    const { editor, view } = await newEditor()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(START)

    // Zero delay between keystrokes: every character lands inside
    // newGroupDelay, so time-based grouping alone would merge the entire
    // sentence into ONE undo step (which is exactly the "undoes too much"
    // half of the report). The word boundaries are what split it.
    type(view, 'The quick brown fox.')
    expect(view.state.doc.textContent).toBe('The quick brown fox.')

    expect(undosToClear(editor, view)).toBe(4)
  })

  it('the SAME sentence takes exactly four undos when typed SLOWLY, too', async () => {
    const { editor, view } = await newEditor()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(START)

    // 600ms per keystroke is past the OLD 500ms newGroupDelay, so before this
    // fix this same sentence took one undo per CHARACTER (20 of them) -- the
    // "choppy" half of the report, from the same defaults that produced the
    // "undoes too much" half above. Same count as the fast run is the whole
    // point: undo steps are now a property of the text, not of the typist.
    type(view, 'The quick brown fox.', 600)

    expect(undosToClear(editor, view)).toBe(4)
  })

  it('one undo removes exactly the last word, leaving the rest intact', async () => {
    const { editor, view } = await newEditor()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(START)
    type(view, 'alpha beta gamma')

    editor.action((ctx) => ctx.get(commandsCtx).call(undoCommand.key))

    // The boundary character travels with the word it TERMINATES, so the
    // space after "beta" survives -- the same thing Cmd+Backspace does, and
    // the reason historyGroupingProse closes the group AFTER the boundary
    // rather than before it.
    expect(view.state.doc.textContent).toBe('alpha beta ')
  })

  it('an apostrophe does not split a word ("don\'t" stays one undo step)', async () => {
    const { editor, view } = await newEditor()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(START)

    // Without the NOT_A_BOUNDARY carve-out, \p{P} would match the apostrophe
    // and make this THREE steps ("don" / "'t " / "stop") -- reintroducing
    // exactly the choppiness this change removes, in one of the commonest
    // words in English prose.
    type(view, "don't stop")

    expect(undosToClear(editor, view)).toBe(2)
  })

  it('pressing Enter is a boundary, so a second line is its own undo step', async () => {
    const { editor, view } = await newEditor()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(START)

    type(view, 'one')
    // A real block split, the same transaction Enter produces. It carries no
    // text at all -- insertedTextOf reads it as "\n" purely because
    // Fragment.textBetween emits the block separator between the two
    // textblocks the split creates, which is what makes Enter a boundary with
    // no special case of its own.
    splitBlock(view.state, view.dispatch)
    type(view, 'two')

    expect(undosToClear(editor, view)).toBe(2)
  })

  it('a long pause mid-word still splits, so elapsed time remains a real backstop', async () => {
    const { editor, view } = await newEditor()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(START)

    type(view, 'hel')
    // Past the raised 2000ms newGroupDelay: nothing about this is a word
    // boundary, so if time had been removed as a grouping input entirely this
    // would be a single step.
    vi.setSystemTime(new Date(Date.now() + 5000))
    type(view, 'lo world')

    // "hel" | "lo " | "world"
    expect(undosToClear(editor, view)).toBe(3)
  })

  it('redo still walks back up the same groups (Undo/Redo stay symmetric)', async () => {
    const { editor, view } = await newEditor()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(START)
    type(view, 'alpha beta')

    editor.action((ctx) => ctx.get(commandsCtx).call(undoCommand.key))
    expect(view.state.doc.textContent).toBe('alpha ')

    editor.action((ctx) => ctx.get(commandsCtx).call(redoCommand.key))
    expect(view.state.doc.textContent).toBe('alpha beta')
  })
})
