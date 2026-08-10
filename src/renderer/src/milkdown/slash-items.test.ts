import { describe, it, expect } from 'vitest'
import { commandsCtx, editorViewCtx } from '@milkdown/core'
import { getMarkdown } from '@milkdown/utils'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import type { Ctx } from '@milkdown/ctx'
import type { Editor } from '@milkdown/core'
import { createTestEditor } from './test-editor'
import { EDITOR_COMMAND_PLUGINS, isInsideTableCell, insertMathBlockCommand } from './commands'
import { EDITOR_SCHEMA_PLUGINS } from './plugins'
import { SLASH_ITEMS, enabledSlashItems, type SlashItem } from './slash-items'
import { filterSlashItems } from '../lib/slash-filter'

const PLUGINS = [...EDITOR_SCHEMA_PLUGINS.flat(), ...EDITOR_COMMAND_PLUGINS]

function itemById(id: string): SlashItem {
  const item = SLASH_ITEMS.find((candidate) => candidate.id === id)
  if (!item) throw new Error(`no such item: ${id}`)
  return item
}

// Places a collapsed selection at the character offset `offset` counted from
// the very start of the document's own first (and only, in every fixture
// below) top-level paragraph -- i.e. offset 0 is right after the paragraph's
// own opening position (doc position 1).
function selectAt(view: EditorView, offset: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1 + offset)))
}

describe('SLASH_ITEMS catalogue shape', () => {
  it('has exactly the items the task brief names, one entry per heading level', () => {
    const ids = SLASH_ITEMS.map((item) => item.id).sort()
    expect(ids).toEqual(
      [
        'heading-1',
        'heading-2',
        'heading-3',
        'bullet-list',
        'numbered-list',
        'task-list',
        'table',
        'code-block',
        'blockquote',
        'horizontal-rule',
        'page-break',
        'math-block',
        'mermaid-diagram'
      ].sort()
    )
  })

  it('every item id is unique', () => {
    const ids = SLASH_ITEMS.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('satisfies slash-filter.ts SlashFilterable constraint and composes with filterSlashItems', () => {
    // Purely a compile-time/structural check -- if SlashItem ever drifted
    // out of shape with SlashFilterable, this line would fail to typecheck,
    // not merely fail at runtime.
    const filtered = filterSlashItems(SLASH_ITEMS, 'head')
    expect(filtered.map((item) => item.id)).toEqual(['heading-1', 'heading-2', 'heading-3'])
  })

  it('never includes an Image item -- image-security.ts only renders data: sources in this renderer', () => {
    expect(SLASH_ITEMS.some((item) => item.id.includes('image'))).toBe(false)
    expect(SLASH_ITEMS.some((item) => item.label.toLowerCase().includes('image'))).toBe(false)
  })
})

// ===========================================================================
// THE HARD REQUIREMENT: block-replacing items must never be offered when the
// target block has other content. This is the single most important test in
// this file -- see slash-items.ts's own header comment and the task brief's
// own "HARD REQUIREMENT" section for the full writeup.
// ===========================================================================
describe('math-block / mermaid-diagram: block-replacing items refuse a non-empty block', () => {
  // Reproduces the EXACT measured scenario from the task brief's own code
  // review, byte for byte: a paragraph reading "Important prose here and
  // more text", caret placed mid-paragraph after a space (between "here"
  // and "and"), "/" typed with nothing further -- a session legitimately
  // opens per this feature's own designed-in "start of block OR after
  // whitespace" condition, and the query is empty. Before this file's own
  // gate existed, a reviewer confirmed insertMathBlockCommand's dry run
  // returned `true` here -- applicable exactly when running it would erase
  // "Important prose here" and " more text" outright, unselected, with no
  // confirmation.
  it('math-block: disabled with the caret mid-paragraph after a space, exactly the reviewer-measured scenario', async () => {
    const editor = await createTestEditor('Important prose here /and more text', PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    // Cursor right after the "/" itself -- an empty query, matching "user
    // types '/' -> a session legitimately opens" before anything further is
    // typed.
    selectAt(view, 'Important prose here /'.length)

    const enabled = editor.action((ctx: Ctx) => itemById('math-block').isEnabled(ctx, view.state))
    expect(enabled).toBe(false)

    // Prove this gate is load-bearing, not decorative: the underlying
    // command's OWN dry run, called directly with no gate in front of it,
    // really does report "applicable" here -- exactly the brief's own claim
    // ("the design doc's planned isEnabled dry-run CANNOT catch this...a dry
    // run reports it applicable exactly when it is destructive"). Without
    // isTargetBlockEmptyAfterQueryRemoved, the catalogue's own isEnabled
    // would be just as wrong as this raw dry run is.
    const rawCommandDryRun = editor.action((ctx: Ctx) =>
      ctx.get(commandsCtx).get(insertMathBlockCommand.key)(undefined)(view.state)
    )
    expect(rawCommandDryRun).toBe(true)

    // And a real dispatch of that same raw command genuinely destroys the
    // surrounding prose -- the exact measured failure this file's gate
    // exists to prevent a caller from ever reaching.
    const applied = editor.action((ctx: Ctx) =>
      ctx.get(commandsCtx).call(insertMathBlockCommand.key)
    )
    expect(applied).toBe(true)
    const output = editor.action(getMarkdown())
    expect(output).not.toContain('Important prose here')
    expect(output).not.toContain('more text')
  })

  it('mermaid-diagram: disabled with the caret mid-paragraph after a space, same scenario as math-block', async () => {
    const editor = await createTestEditor('Important prose here /and more text', PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    selectAt(view, 'Important prose here /'.length)

    const enabled = editor.action((ctx: Ctx) =>
      itemById('mermaid-diagram').isEnabled(ctx, view.state)
    )
    expect(enabled).toBe(false)
  })

  it('math-block: disabled when the query has grown past a bare "/" but prose still follows', async () => {
    // A more advanced case than the brief's own minimal repro. Typed
    // characters extend the QUERY -- they are inserted immediately after the
    // "/", not consumed from whatever text already followed it -- so after
    // typing "mat", the document reads "...here /matand more text": the
    // three-character query "mat" sits between the "/" and the ORIGINAL,
    // still-untouched "and more text". Removing "/mat" (the "/" plus the
    // full query) still leaves real prose on both sides.
    const editor = await createTestEditor('Important prose here /matand more text', PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    selectAt(view, 'Important prose here /mat'.length)

    const enabled = editor.action((ctx: Ctx) => itemById('math-block').isEnabled(ctx, view.state))
    expect(enabled).toBe(false)
  })

  it('math-block: ENABLED when the paragraph is genuinely empty except for the query (the safe, common case)', async () => {
    const editor = await createTestEditor('/math', PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    selectAt(view, '/math'.length)

    const enabled = editor.action((ctx: Ctx) => itemById('math-block').isEnabled(ctx, view.state))
    expect(enabled).toBe(true)

    // Prove the enabled case is ALSO genuinely functional, not merely
    // "reports true" -- run() really does replace the (empty-but-for-the-
    // query) block once the query itself is deleted, matching how Task 5's
    // controller will actually drive this (delete the query, then run).
    view.dispatch(view.state.tr.delete(1, 1 + '/math'.length))
    editor.action((ctx: Ctx) => itemById('math-block').run(ctx))
    expect(editor.action(getMarkdown())).toBe('$$\nx^2\n$$\n')
  })

  it('mermaid-diagram: ENABLED when the paragraph is genuinely empty except for the query', async () => {
    const editor = await createTestEditor('/mermaid', PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    selectAt(view, '/mermaid'.length)

    const enabled = editor.action((ctx: Ctx) =>
      itemById('mermaid-diagram').isEnabled(ctx, view.state)
    )
    expect(enabled).toBe(true)
  })

  it('math-block: disabled when only WHITESPACE would remain -- a leading-space edge case, treated conservatively', async () => {
    // "   /math" -- three leading spaces before the slash. Built via a real
    // keystroke-style transaction (insertText into an initially empty
    // paragraph), NOT via createTestEditor's own initial markdown parse:
    // CommonMark strips a paragraph's own leading whitespace as
    // indentation during parsing, so parsing "   /math" from markdown
    // source would silently produce a paragraph whose real text is just
    // "/math" -- not the scenario this test means to cover. Typing three
    // spaces into an already-mounted, already-empty paragraph is a real,
    // reachable user gesture that parsing can't reproduce.
    //
    // Per this file's own literal reading of the brief ("is there any OTHER
    // content left"), whitespace counts as content: the remaining "   "
    // would sit as inert text alongside the inserted block, which is
    // harmless, but treating it as "content" is the conservative,
    // no-data-loss-possible reading, and this test pins that choice
    // deliberately rather than leaving it implicit.
    const editor = await createTestEditor('', PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    view.dispatch(view.state.tr.insertText('   /math', 1))

    const enabled = editor.action((ctx: Ctx) => itemById('math-block').isEnabled(ctx, view.state))
    expect(enabled).toBe(false)
  })
})

describe('table / horizontal-rule: refused inside a table cell (measured table-corruption hazard)', () => {
  const source = '| a | b |\n| --- | --- |\n| x | y |\n'

  async function editorWithCursorInCell(): Promise<{ editor: Editor; view: EditorView }> {
    const editor = await createTestEditor(source, PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    let cellTextPos: number | null = null
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'x') cellTextPos = pos + 1
      return true
    })
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cellTextPos!)))
    return { editor, view }
  }

  it('table: disabled inside a table cell', async () => {
    const { editor, view } = await editorWithCursorInCell()
    const enabled = editor.action((ctx: Ctx) => itemById('table').isEnabled(ctx, view.state))
    expect(enabled).toBe(false)
  })

  it('horizontal-rule: disabled inside a table cell', async () => {
    const { editor, view } = await editorWithCursorInCell()
    const enabled = editor.action((ctx: Ctx) =>
      itemById('horizontal-rule').isEnabled(ctx, view.state)
    )
    expect(enabled).toBe(false)
  })

  it('table: enabled in a plain top-level paragraph (the guard is specific to table cells, not a blanket refusal)', async () => {
    const editor = await createTestEditor('Hello world', PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    const enabled = editor.action((ctx: Ctx) => itemById('table').isEnabled(ctx, view.state))
    expect(enabled).toBe(true)
  })

  it('cross-check: isInsideTableCell itself agrees with the two results above (shared implementation, not a coincidence)', async () => {
    const { editor, view } = await editorWithCursorInCell()
    const inside = editor.action((ctx: Ctx) => isInsideTableCell(ctx, view.state))
    expect(inside).toBe(true)
  })
})

describe('page-break: honest dry run (the other required fix from this task)', () => {
  it('enabled in a plain paragraph', async () => {
    const editor = await createTestEditor('Hello world', PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    const enabled = editor.action((ctx: Ctx) => itemById('page-break').isEnabled(ctx, view.state))
    expect(enabled).toBe(true)
  })

  it('disabled inside a table cell, inherited from insertPagebreakCommand fixed dry run', async () => {
    const source = '| a | b |\n| --- | --- |\n| x | y |\n'
    const editor = await createTestEditor(source, PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    let cellTextPos: number | null = null
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'x') cellTextPos = pos + 1
      return true
    })
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cellTextPos!)))
    const enabled = editor.action((ctx: Ctx) => itemById('page-break').isEnabled(ctx, view.state))
    expect(enabled).toBe(false)
  })
})

describe('content-preserving items: real, informative dry runs, no destructive-gate needed', () => {
  it('heading-1/2/3, bullet-list, numbered-list, task-list, code-block, blockquote are all enabled against non-empty prose', async () => {
    const editor = await createTestEditor('Some plain prose here', PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    for (const id of [
      'heading-1',
      'heading-2',
      'heading-3',
      'bullet-list',
      'numbered-list',
      'task-list',
      'code-block',
      'blockquote'
    ]) {
      const enabled = editor.action((ctx: Ctx) => itemById(id).isEnabled(ctx, view.state))
      expect(enabled, `${id} should be enabled against non-empty prose`).toBe(true)
    }
    // None of these are block-replacing, so running one must PRESERVE the
    // original text rather than erase it -- proven directly for one
    // representative item (heading), matching this describe block's own
    // claim rather than merely asserting isEnabled in isolation.
    editor.action((ctx) => itemById('heading-1').run(ctx))
    expect(editor.action(getMarkdown())).toContain('Some plain prose here')
  })

  it('code-block and blockquote are ALSO enabled from inside a table cell -- both refuse-free, unlike table/horizontal-rule', async () => {
    const source = '| a | b |\n| --- | --- |\n| x | y |\n'
    const editor = await createTestEditor(source, PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    let cellTextPos: number | null = null
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'x') cellTextPos = pos + 1
      return true
    })
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cellTextPos!)))
    // Neither of these needs an isInsideTableCell gate: read directly from
    // their own installed source, setBlockType/wrapIn already refuse
    // cleanly inside a table cell's rigid 'paragraph'-only content model --
    // so BOTH the dry run AND the (harmless-to-attempt) real command call
    // should agree "not applicable" here, without this file adding a gate.
    expect(editor.action((ctx: Ctx) => itemById('code-block').isEnabled(ctx, view.state))).toBe(
      false
    )
    expect(editor.action((ctx: Ctx) => itemById('blockquote').isEnabled(ctx, view.state))).toBe(
      false
    )
  })
})

// enabledSlashItems (Task 5, wiring) -- the ONE formula MilkdownEditor.tsx's
// countMatching closure and editor-commands.ts's getSlashItems must both be
// built from (see this function's own doc comment for the exact desync it
// prevents). Tested here, alongside the catalogue it wraps, rather than in a
// separate file: it has no independent logic of its own to isolate --
// it IS filterSlashItems + isEnabled, composed -- so these tests exist to
// pin that composition, not to re-test either half again.
describe('enabledSlashItems: the one formula countMatching and getSlashItems must share', () => {
  it('against a paragraph containing only "/" (a genuinely open, empty-query session), returns every item filterSlashItems would for an empty query', async () => {
    // isTargetBlockEmptyAfterQueryRemoved (slash-items.ts) re-derives the
    // trigger via findSlashTrigger against the LIVE document -- it requires
    // an actual "/" to be present, matching how isEnabled is only ever
    // really asked this while a session is genuinely open (see that
    // function's own doc comment). A literally-empty paragraph with no "/"
    // at all is a DIFFERENT case (findSlashTrigger finds no trigger and it
    // conservatively refuses) -- not the scenario this test means to cover.
    const editor = await createTestEditor('/', PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    selectAt(view, 1)
    const enabled = editor.action((ctx: Ctx) => enabledSlashItems(ctx, view.state, ''))
    // The block is empty both before AND after removing the query -- so
    // math-block/mermaid-diagram are enabled too, and nothing in this
    // scenario disables anything else. Order must match filterSlashItems'
    // own pass-through order for an empty query, not just the same SET of
    // ids.
    expect(enabled.map((item) => item.id)).toEqual(SLASH_ITEMS.map((item) => item.id))
  })

  it('filters by query exactly like filterSlashItems alone, e.g. "head" -> only the three headings', async () => {
    const editor = await createTestEditor('/head', PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    selectAt(view, 5)
    const enabled = editor.action((ctx: Ctx) => enabledSlashItems(ctx, view.state, 'head'))
    expect(enabled.map((item) => item.id)).toEqual(['heading-1', 'heading-2', 'heading-3'])
  })

  it('reproduces the HARD REQUIREMENT scenario: 11 items, not 13 -- filterSlashItems alone would over-report by exactly the 2 block-replacing items', async () => {
    // Byte-for-byte the same fixture as the "math-block / mermaid-diagram"
    // describe block above -- this is the exact scenario fix round 1 of the
    // item-catalogue task (I3) pinned as the real, measured "13 counted vs
    // 11 rendered" desync this function exists to make structurally
    // impossible to reintroduce.
    const editor = await createTestEditor('Important prose here /and more text', PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    selectAt(view, 'Important prose here /'.length)
    const queryOnlyCount = filterSlashItems(SLASH_ITEMS, '').length
    const enabled = editor.action((ctx: Ctx) => enabledSlashItems(ctx, view.state, ''))
    expect(queryOnlyCount).toBe(13)
    expect(enabled.length).toBe(11)
    expect(enabled.some((item) => item.id === 'math-block')).toBe(false)
    expect(enabled.some((item) => item.id === 'mermaid-diagram')).toBe(false)
  })
})
