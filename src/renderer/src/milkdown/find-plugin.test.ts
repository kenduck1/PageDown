import { describe, expect, it } from 'vitest'
import { editorViewCtx } from '@milkdown/core'
import type { EditorView } from '@milkdown/prose/view'
import { $prose, getMarkdown } from '@milkdown/utils'
import { createTestEditor } from './test-editor'
import { buildEditorCommands } from './editor-commands'
import { EDITOR_COMMAND_PLUGINS } from './commands'
import {
  applyFindState,
  collectTextRuns,
  createFindPlugin,
  findPluginKey,
  replaceActiveMatchIn,
  replaceAllMatchesIn
} from './find-plugin'

const PLAIN = { caseSensitive: false, wholeWord: false }

const noop = (): void => {}

// Adapted from the brief's own `createTestEditor(markdown)` / `createTestEditor(markdown,
// callback)` -- both wrong against the real, already-committed two-argument
// `createTestEditor(markdown, extraPlugins: MilkdownPlugin[])` signature in test-editor.ts. The
// find plugin is a per-mount $prose plugin (same as MilkdownEditor.tsx's own edit-tracking
// plugin), so it's built here with `$prose(() => createFindPlugin(onMatchesChanged))` and passed
// through `extraPlugins`, exactly the way MilkdownEditor.tsx will mount it in Task 4 -- this
// exercises the real composition, not a stand-in for it. EDITOR_COMMAND_PLUGINS (historyProse,
// undoCommand, redoCommand, insertPagebreakCommand, safeImageViewProse) rides along on every
// call, matching MilkdownEditor.test.tsx's own "wired-implementation verification" pattern of
// mounting the real non-schema editing-behavior plugins alongside whatever's under test -- the
// "replaces every match in a single undoable transaction" test below needs real undo/redo to
// assert its actual claim (ONE undo step reverts ALL replacements), and there's no reason for the
// other tests to diverge from that composition and mount a thinner one.
async function viewFor(
  markdown: string,
  onMatchesChanged: (count: number, activeIndex: number) => void = noop
): Promise<{ view: EditorView; editor: Awaited<ReturnType<typeof createTestEditor>> }> {
  const editor = await createTestEditor(markdown, [
    $prose(() => createFindPlugin(onMatchesChanged)),
    ...EDITOR_COMMAND_PLUGINS
  ])
  const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
  return { view, editor }
}

describe('find-plugin', () => {
  it('finds a match that spans a mark boundary', async () => {
    // 'he**ll**o' is three separate ProseMirror text nodes. A per-text-node
    // scan would miss 'hello' entirely; the run-based scan must find it.
    const { view } = await viewFor('he**ll**o world')
    applyFindState(view, { query: 'hello', options: PLAIN, activeIndex: 0 })
    const state = findPluginKey.getState(view.state)
    expect(state?.matches).toHaveLength(1)
    expect(view.state.doc.textBetween(state!.matches[0].from, state!.matches[0].to)).toBe('hello')
  })

  it('reports matches at positions that address the real document text', async () => {
    const { view } = await viewFor('alpha beta alpha')
    applyFindState(view, { query: 'alpha', options: PLAIN, activeIndex: 0 })
    const state = findPluginKey.getState(view.state)
    expect(state?.matches).toHaveLength(2)
    for (const match of state!.matches) {
      expect(view.state.doc.textBetween(match.from, match.to)).toBe('alpha')
    }
  })

  it('does not let a run span an inline atom', async () => {
    // The image is an inline atom: it contributes to document positions but
    // not to text, so a run must TERMINATE at it rather than silently
    // concatenating across and producing offsets that no longer address the
    // text they claim to.
    const { view } = await viewFor('he![x](y.png)llo')
    const runs = collectTextRuns(view.state.doc)
    expect(runs.length).toBeGreaterThan(1)
    applyFindState(view, { query: 'hello', options: PLAIN, activeIndex: 0 })
    expect(findPluginKey.getState(view.state)?.matches).toHaveLength(0)
  })

  it('decorates every match and marks the active one', async () => {
    const { view } = await viewFor('cat cat cat')
    applyFindState(view, { query: 'cat', options: PLAIN, activeIndex: 1 })
    const state = findPluginKey.getState(view.state)
    const decorations = state!.decorations.find()
    expect(decorations).toHaveLength(3)
    const classes = decorations.map((d) => (d.spec as { class?: string }).class ?? '')
    expect(classes.filter((c) => c.includes('pagedown-find-match-active'))).toHaveLength(1)
    expect(classes[1]).toContain('pagedown-find-match-active')
  })

  it('selects the active match without focusing or changing the document', async () => {
    const { view } = await viewFor('alpha beta')
    const before = view.state.doc.toJSON()
    applyFindState(view, { query: 'beta', options: PLAIN, activeIndex: 0 })
    expect(view.state.doc.toJSON()).toEqual(before)
    expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe(
      'beta'
    )
  })

  it('rescans when the document changes', async () => {
    const { view } = await viewFor('cat')
    applyFindState(view, { query: 'cat', options: PLAIN, activeIndex: 0 })
    expect(findPluginKey.getState(view.state)?.matches).toHaveLength(1)
    view.dispatch(view.state.tr.insertText(' cat', view.state.doc.content.size - 1))
    expect(findPluginKey.getState(view.state)?.matches).toHaveLength(2)
  })

  it('replaces only the active match', async () => {
    const { view, editor } = await viewFor('cat cat')
    applyFindState(view, { query: 'cat', options: PLAIN, activeIndex: 1 })
    replaceActiveMatchIn(view, 'dog')
    expect(editor.action(getMarkdown()).trim()).toBe('cat dog')
  })

  it('replaces every match in a single undoable transaction', async () => {
    // The real behavioural claim is "one undo step", so assert exactly that:
    // ONE undo must restore ALL THREE matches. A test that only checked the
    // post-replace text would pass just as happily against three separate
    // dispatches, which is the bug this guards against.
    const { view, editor } = await viewFor('cat cat cat')
    const commands = buildEditorCommands(editor)
    applyFindState(view, { query: 'cat', options: PLAIN, activeIndex: 0 })
    replaceAllMatchesIn(view, 'dog')
    expect(editor.action(getMarkdown()).trim()).toBe('dog dog dog')
    commands.undo()
    expect(editor.action(getMarkdown()).trim()).toBe('cat cat cat')
  })

  it('reports match counts through its callback', async () => {
    const seen: Array<[number, number]> = []
    const { view } = await viewFor('cat cat', (count, index) => {
      seen.push([count, index])
    })
    applyFindState(view, { query: 'cat', options: PLAIN, activeIndex: 0 })
    expect(seen.at(-1)).toEqual([2, 0])
  })
})
