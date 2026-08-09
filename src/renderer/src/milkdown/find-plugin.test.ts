import { describe, expect, it, vi } from 'vitest'
import { editorViewCtx } from '@milkdown/core'
import type { EditorView } from '@milkdown/prose/view'
import { $prose, getMarkdown } from '@milkdown/utils'
import { createTestEditor } from './test-editor'
import { buildEditorCommands } from './editor-commands'
import { EDITOR_COMMAND_PLUGINS } from './commands'
import { MAX_MATCHES } from '../lib/find-matches'
import {
  applyFindState,
  collectTextRuns,
  createFindPlugin,
  findDocMatches,
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
    // Asserted against the RENDERED DOM, not `Decoration#spec`. Mutation
    // proof (found in review): `Decoration.inline`'s 3rd argument (`attrs`)
    // is what actually gets painted onto the DOM as real attributes, while
    // its optional 4th argument (`spec`) is separate, ProseMirror-internal
    // metadata that is NOT derived from `attrs` -- so asserting through
    // `.spec` only proves something about what buildDecorations happened to
    // pass as a 4th argument, not that anything actually paints. Changing
    // buildDecorations to pass `{}` as `attrs` (the argument that paints)
    // while keeping the real class object as `spec` left every match
    // unhighlighted in the real app, yet every `.spec`-based assertion here
    // stayed green. `view.dom` is the real contenteditable root the editor
    // rendered into -- same mechanism MilkdownEditor.test.tsx's own
    // `root.querySelector('h1')?.innerHTML` assertions already rely on.
    const { view } = await viewFor('cat cat cat')
    applyFindState(view, { query: 'cat', options: PLAIN, activeIndex: 1 })
    const matchSpans = view.dom.querySelectorAll('.pagedown-find-match')
    const activeSpans = view.dom.querySelectorAll('.pagedown-find-match-active')
    expect(matchSpans).toHaveLength(3)
    expect(activeSpans).toHaveLength(1)
    // activeIndex: 1 is the SECOND "cat" in document order -- assert the
    // active span IS that second painted match span (identity, not just
    // "some span somewhere has the class"), pinning the active one lands on
    // the right match, not merely that exactly one match is marked active.
    expect(matchSpans[1]).toBe(activeSpans[0])
  })

  it('selects the active match without focusing or changing the document', async () => {
    const { view } = await viewFor('alpha beta')
    // `applyFindState`'s own doc comment states it does NOT call
    // `view.focus()` (focus must stay in the find input so Enter keeps
    // advancing) -- assert that directly rather than only its side effects,
    // since none of the doc/selection assertions below would fail if a
    // stray `view.focus()` were added.
    const focusSpy = vi.spyOn(view, 'focus')
    const before = view.state.doc.toJSON()
    applyFindState(view, { query: 'beta', options: PLAIN, activeIndex: 0 })
    expect(view.state.doc.toJSON()).toEqual(before)
    expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe(
      'beta'
    )
    expect(focusSpy).not.toHaveBeenCalled()
  })

  it('applyFindState dispatches only doc-unchanged, no-stored-marks transactions', async () => {
    // The load-bearing property applyFindState's own doc comment claims: a
    // selection-only transaction has docChanged: false and no
    // storedMarksSet, so it correctly does not trip MilkdownEditor's
    // editedSinceMountRef and cannot mark a clean document dirty. The test
    // above only proves the DOC content is unchanged (doc.toJSON() equal),
    // which is a weaker property than "every transaction dispatched along
    // the way was itself non-dirtying" -- a docChanged: true transaction
    // that happens to produce an equal-looking doc would still trip the
    // edit tracker, and toJSON() equality alone can't see that. Spying on
    // view.dispatch (rather than wrapping/replacing it) keeps the real
    // dispatch behavior intact while recording exactly what was dispatched.
    const { view } = await viewFor('alpha beta')
    const dispatchSpy = vi.spyOn(view, 'dispatch')
    applyFindState(view, { query: 'beta', options: PLAIN, activeIndex: 0 })
    expect(dispatchSpy.mock.calls.length).toBeGreaterThan(0)
    for (const [tr] of dispatchSpy.mock.calls) {
      expect(tr.docChanged).toBe(false)
      expect(tr.storedMarksSet).toBe(false)
    }
  })

  it('rescans when the document changes', async () => {
    const { view } = await viewFor('cat')
    applyFindState(view, { query: 'cat', options: PLAIN, activeIndex: 0 })
    expect(findPluginKey.getState(view.state)?.matches).toHaveLength(1)
    view.dispatch(view.state.tr.insertText(' cat', view.state.doc.content.size - 1))
    expect(findPluginKey.getState(view.state)?.matches).toHaveLength(2)
  })

  it('caps the DOCUMENT-wide match total at MAX_MATCHES, even though no single run comes close', async () => {
    // findDocMatches's own comment: findMatches (Task 1) already caps each
    // RUN independently at MAX_MATCHES, so a single long run can't
    // demonstrate the SECOND, document-wide cap findDocMatches adds on top
    // (`if (result.length >= MAX_MATCHES) return result`) -- deleting that
    // line leaves every other test in this file green, since none of them
    // come close to MAX_MATCHES in one run. Spreading matches across several
    // separate paragraphs (separate textblocks, i.e. separate runs) is what
    // actually exercises it: each run alone stays far under MAX_MATCHES, but
    // the running TOTAL across runs must still stop there.
    const perParagraph = Math.ceil(MAX_MATCHES / 3) + 100
    const paragraph = Array(perParagraph).fill('cat').join(' ')
    const markdown = [paragraph, paragraph, paragraph].join('\n\n')
    const { view } = await viewFor(markdown)
    const matches = findDocMatches(view.state.doc, 'cat', PLAIN)
    expect(matches).toHaveLength(MAX_MATCHES)
  })

  it('replaces only the active match', async () => {
    const { view, editor } = await viewFor('cat cat')
    applyFindState(view, { query: 'cat', options: PLAIN, activeIndex: 1 })
    replaceActiveMatchIn(view, 'dog')
    expect(editor.action(getMarkdown()).trim()).toBe('cat dog')
  })

  it('inserts the replacement as literal text -- Markdown-special characters are escaped on serialize, never parsed as formatting', async () => {
    // replaceActiveMatchIn's own doc comment: the replacement is inserted as
    // literal text and is never parsed as Markdown. Verified empirically
    // (throwaway scratch script, deleted after use) against this exact
    // input/output before writing this assertion: replacing "cat" with the
    // six literal characters "**bold**" produces a DOM with NO <strong>
    // element (plain text reading the asterisks), and remark-stringify
    // serializes that text node with the asterisks BACKSLASH-ESCAPED
    // ("\\*\\*bold\\*\\*\n") -- not bare ("**bold**\n"), which would
    // silently round-trip as real emphasis the next time this file is
    // opened. Asserting the serialized markdown is the right level here
    // (rather than just the DOM) because escaping only matters for what
    // survives a save/reopen round trip.
    const { view, editor } = await viewFor('cat')
    applyFindState(view, { query: 'cat', options: PLAIN, activeIndex: 0 })
    replaceActiveMatchIn(view, '**bold**')
    expect(view.dom.querySelector('strong')).toBeNull()
    expect(view.dom.textContent).toBe('**bold**')
    expect(editor.action(getMarkdown())).toBe('\\*\\*bold\\*\\*\n')
  })

  it('replacing inside marked text keeps the mark -- insertText, not replaceWith', async () => {
    // replaceActiveMatchIn's own doc comment: insertText (not replaceWith)
    // is used so the replacement INHERITS the marks at `from`. Verified
    // empirically (throwaway scratch script, deleted after use) that this
    // specifically discriminates the two: swapping to
    // `tr.replaceWith(from, to, schema.text(replacement))` against this
    // exact fixture drops the bold mark entirely (DOM becomes plain
    // "<p>dog</p>", serialized markdown becomes bare "dog\n") -- a real,
    // silent formatting loss on a very ordinary "replace a word inside bold
    // text" gesture that a docChanged/markdown-content-only assertion could
    // not tell apart from the correct, mark-preserving behavior.
    const { view, editor } = await viewFor('**cat**')
    applyFindState(view, { query: 'cat', options: PLAIN, activeIndex: 0 })
    replaceActiveMatchIn(view, 'dog')
    expect(view.dom.querySelector('strong')?.textContent).toBe('dog')
    expect(editor.action(getMarkdown())).toBe('**dog**\n')
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
