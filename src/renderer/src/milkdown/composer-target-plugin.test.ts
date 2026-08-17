import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { editorViewCtx } from '@milkdown/core'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { $prose } from '@milkdown/utils'
import { createTestEditor } from './test-editor'
import { buildEditorCommands } from './editor-commands'
import { EDITOR_COMMAND_PLUGINS } from './commands'
import {
  COMPOSER_TARGET_CLASS,
  composerTargetPluginKey,
  createComposerTargetPlugin,
  setComposerTargetIn
} from './composer-target-plugin'

// Mounted exactly the way MilkdownEditor.tsx mounts it -- a per-mount $prose
// wrapper around createComposerTargetPlugin(), riding alongside the real
// EDITOR_COMMAND_PLUGINS -- so these tests exercise the shipped composition
// rather than a thinner stand-in, matching find-plugin.test.ts's own viewFor.
async function viewFor(
  markdown: string
): Promise<{ view: EditorView; editor: Awaited<ReturnType<typeof createTestEditor>> }> {
  const editor = await createTestEditor(markdown, [
    $prose(() => createComposerTargetPlugin()),
    ...EDITOR_COMMAND_PLUGINS
  ])
  const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
  return { view, editor }
}

/** Selects [from, to) in document coordinates, the way a real drag would. */
function select(view: EditorView, from: number, to: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))
}

function decoratedRanges(view: EditorView): Array<{ from: number; to: number }> {
  const set = composerTargetPluginKey.getState(view.state)?.decorations
  if (!set) return []
  return set.find().map((decoration) => ({ from: decoration.from, to: decoration.to }))
}

/**
 * What actually reaches the rendered DOM. Stronger than reading the
 * DecorationSet back: a decoration built with the wrong class, or one
 * ProseMirror never applies, still shows up in the set.
 */
function highlightedText(view: EditorView): string {
  return Array.from(view.dom.querySelectorAll(`.${COMPOSER_TARGET_CLASS}`))
    .map((element) => element.textContent ?? '')
    .join('')
}

describe('composer-target-plugin', () => {
  it('paints nothing until a composer opens, then paints the selected range', async () => {
    // THE headline behaviour, and the whole reason this plugin exists: while a
    // composer holds DOM focus the browser has destroyed the contenteditable's
    // selection (Gate 43's measurement -- see the plugin's own header), so
    // without this decoration the user cannot see what they selected. Asserted
    // through the real rendered DOM, not only through the DecorationSet.
    const { view } = await viewFor('alpha beta gamma')
    const from = view.state.doc.content.size - 'beta gamma'.length - 1
    const to = from + 'beta'.length
    select(view, from, to)

    // Selected, but no composer open: nothing is painted. Asserted BEFORE the
    // interaction so a plugin that highlighted unconditionally could not pass
    // this test by accident.
    expect(highlightedText(view)).toBe('')
    expect(decoratedRanges(view)).toEqual([])

    setComposerTargetIn(view, true)

    expect(highlightedText(view)).toBe('beta')
    expect(decoratedRanges(view)).toEqual([{ from, to }])
  })

  it('clears the highlight when the composer closes', async () => {
    const { view } = await viewFor('alpha beta')
    select(view, 1, 6)
    setComposerTargetIn(view, true)
    expect(highlightedText(view)).toBe('alpha')

    setComposerTargetIn(view, false)

    expect(highlightedText(view)).toBe('')
    expect(decoratedRanges(view)).toEqual([])
    expect(composerTargetPluginKey.getState(view.state)?.active).toBe(false)
  })

  it('tracks the LIVE selection rather than a snapshot taken when it opened', async () => {
    // The plugin's own design decision, asserted rather than trusted: both
    // composers dispatch against `view.state.selection` at SUBMIT time, so the
    // highlight has to be derived from the same place or the two can disagree
    // about what is targeted. The canvas stays live and clickable behind an
    // open composer (FloatingCard is role="group", it traps nothing), so this
    // is reachable, not hypothetical.
    const { view } = await viewFor('alpha beta')
    select(view, 1, 6)
    setComposerTargetIn(view, true)
    expect(highlightedText(view)).toBe('alpha')

    select(view, 7, 11)

    expect(highlightedText(view)).toBe('beta')
  })

  it('paints nothing for a collapsed caret, which is what the commands refuse anyway', async () => {
    // Honest degradation rather than a zero-width sliver: an empty selection is
    // exactly the state addCommentCommand returns false for, so showing no
    // target is the truthful rendering of it.
    const { view } = await viewFor('alpha beta')
    select(view, 3, 3)
    setComposerTargetIn(view, true)

    expect(highlightedText(view)).toBe('')
    expect(decoratedRanges(view)).toEqual([])
    // ...and the plugin is still ACTIVE, so the highlight appears the moment a
    // real range exists again. Without this half, "no decoration" here would
    // be indistinguishable from the plugin having silently turned itself off.
    expect(composerTargetPluginKey.getState(view.state)?.active).toBe(true)
    select(view, 1, 6)
    expect(highlightedText(view)).toBe('alpha')
  })

  it('follows the range across a document edit while the composer stays open', async () => {
    const { view } = await viewFor('alpha beta')
    select(view, 7, 11)
    setComposerTargetIn(view, true)
    expect(highlightedText(view)).toBe('beta')

    // Insert ahead of the highlighted range: every position after it shifts.
    view.dispatch(view.state.tr.insertText('XY', 1))

    expect(highlightedText(view)).toBe('beta')
  })

  it('dispatches only doc-unchanged, no-stored-marks transactions, and never focuses', async () => {
    // The two hard rules this codebase enforces on every decoration plugin.
    //
    // docChanged/storedMarksSet is the exact pair MilkdownEditor's
    // editedSinceMountRef keys on (it mirrors @milkdown/plugin-listener's own
    // filter), so a transaction failing this would mark a CLEAN document DIRTY
    // purely because the user opened a composer -- a spurious unsaved-changes
    // indicator, a spurious native Save/Don't Save prompt on navigation, and a
    // spurious autosave snapshot. Spying on dispatch rather than comparing
    // doc.toJSON() is deliberate: an equal-looking doc produced by a
    // docChanged: true transaction still trips the tracker, and toJSON()
    // equality cannot see that.
    //
    // view.focus() is asserted directly because none of the decoration
    // assertions above would fail if a stray focus() were added -- and here it
    // would be worse than in find's case: focus must stay in the composer's
    // field, and stealing it back would defeat the surface entirely.
    const { view } = await viewFor('alpha beta')
    select(view, 1, 6)
    const focusSpy = vi.spyOn(view, 'focus')
    const dispatchSpy = vi.spyOn(view, 'dispatch')

    setComposerTargetIn(view, true)
    setComposerTargetIn(view, false)

    expect(dispatchSpy.mock.calls.length).toBeGreaterThan(0)
    for (const [tr] of dispatchSpy.mock.calls) {
      expect(tr.docChanged).toBe(false)
      expect(tr.storedMarksSet).toBe(false)
      expect(tr.steps).toHaveLength(0)
    }
    expect(focusSpy).not.toHaveBeenCalled()
  })

  it('dispatches nothing at all when the value has not changed', async () => {
    // The no-op guard applyPageGuides uses. EditorScreen drives this from an
    // effect, so it re-runs for reasons unrelated to the composer; a
    // transaction per re-render would be pure noise flowing through every
    // other plugin's apply().
    const { view } = await viewFor('alpha beta')
    select(view, 1, 6)
    setComposerTargetIn(view, true)

    const dispatchSpy = vi.spyOn(view, 'dispatch')
    setComposerTargetIn(view, true)
    expect(dispatchSpy).not.toHaveBeenCalled()

    setComposerTargetIn(view, false)
    dispatchSpy.mockClear()
    setComposerTargetIn(view, false)
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('leaves the document byte-identical', async () => {
    // The highlight is a view-layer decoration and must never become content:
    // it exists only while a popover is open, and a document that gained a
    // span from opening one would be a real corruption.
    const { view, editor } = await viewFor('alpha beta')
    const before = view.state.doc.toJSON()
    select(view, 1, 6)
    setComposerTargetIn(view, true)
    expect(view.state.doc.toJSON()).toEqual(before)
    expect(editor.action((ctx) => ctx.get(editorViewCtx).state.doc.toJSON())).toEqual(before)
  })

  it('is reachable through the real EditorCommands surface, not just the raw function', async () => {
    // The wiring gap editor-commands.ts's own header documents: a
    // mutation-tested rewiring of toggleBold passed 177 tests because they
    // called the command mechanism directly instead of going through the
    // shipped handle. This calls buildEditorCommands -- the exact object
    // MilkdownEditor.tsx's useImperativeHandle delegates to.
    const { view, editor } = await viewFor('alpha beta')
    select(view, 1, 6)

    buildEditorCommands(editor).setComposerTargetActive(true)

    expect(highlightedText(view)).toBe('alpha')
  })

  it('emits exactly the class base.css styles', async () => {
    // The constant and the stylesheet are two files that must agree; asserting
    // the literal here is what makes a rename of one without the other fail
    // rather than silently render an unstyled decoration.
    expect(COMPOSER_TARGET_CLASS).toBe('pagedown-composer-target')
    const { view } = await viewFor('alpha beta')
    select(view, 1, 6)
    setComposerTargetIn(view, true)
    expect(view.dom.querySelectorAll('.pagedown-composer-target')).toHaveLength(1)
  })

  it('is styled from base.css, never from the shared document stylesheet', async () => {
    // Three failure modes this closes, none of which any DOM assertion above
    // can see, following document-typography.test.ts's own read-the-source
    // precedent:
    //
    //  1. A decoration whose class no rule matches -- it lands in the DOM,
    //     every test passes, and the user still sees nothing.
    //  2. A rule referencing a custom property nobody declares. An unresolved
    //     var() is invalid-at-computed-value-time, and `background` is not
    //     inherited, so it silently falls back to transparent: again visible
    //     to no test and to the user as "the fix did not work".
    //  3. The rule drifting into src/typography/document-typography.css, which
    //     is shared VERBATIM with the sandboxed pagination render context --
    //     an editor-only highlight there would be printed into the exported
    //     PDF. Same rule and same reason as .pagedown-find-match,
    //     .pagedown-comment-mark, .pagedown-slash-query and
    //     .pagedown-page-guide.
    const baseCss = readFileSync(join(__dirname, '../assets/base.css'), 'utf8')
    expect(baseCss).toContain(`--color-composer-target:`)
    expect(baseCss).toContain(`.${COMPOSER_TARGET_CLASS} {`)
    expect(baseCss).toContain('background: var(--color-composer-target)')

    const sharedCss = readFileSync(
      join(__dirname, '../../../typography/document-typography.css'),
      'utf8'
    )
    expect(sharedCss).not.toContain(COMPOSER_TARGET_CLASS)
    expect(sharedCss).not.toContain('composer-target')
  })
})
