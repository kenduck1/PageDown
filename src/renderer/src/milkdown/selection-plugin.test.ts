import { describe, expect, it, vi } from 'vitest'
import { editorViewCtx } from '@milkdown/core'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { $prose } from '@milkdown/utils'
import { createTestEditor } from './test-editor'
import { EDITOR_COMMAND_PLUGINS } from './commands'
import {
  createSelectionPlugin,
  readSelectionRect,
  readSelectionSnapshot,
  sameSnapshot,
  type SelectionSnapshot
} from './selection-plugin'

// !!! READ BEFORE ADDING A POSITIONING TEST HERE !!!
// `view.coordsAtPos()` does NOT throw under jsdom -- it silently returns
// ALL-ZERO rects, because this repo's own test-setup.ts polyfills
// Range.getClientRects/getBoundingClientRect (for an unrelated ProseMirror
// scrollToSelection reason) with zero-valued stubs. So "the bubble sits above
// the selection" passes against {0,0,0,0} and proves nothing at all -- a
// strictly nastier trap than drop-image.ts's posAtCoords, which at least
// throws loudly. There is one test at the bottom of this file that PINS the
// zero-rect behaviour so the hazard is visible rather than folklore; every
// real positioning claim belongs in lib/floating-position.test.ts (pure
// arithmetic, where the occlusion guarantee actually lives) or in a Playwright
// gate against the real built app.

const noop = (): void => {}

// Mirrors find-plugin.test.ts's own viewFor helper exactly: the selection
// plugin is a per-mount $prose plugin (same as MilkdownEditor.tsx mounts it),
// and EDITOR_COMMAND_PLUGINS rides along so the composition under test is the
// real one rather than a thinner stand-in.
async function viewFor(
  markdown: string,
  onSelectionChanged: (snapshot: SelectionSnapshot | null) => void = noop
): Promise<{ view: EditorView; editor: Awaited<ReturnType<typeof createTestEditor>> }> {
  const editor = await createTestEditor(markdown, [
    $prose(() => createSelectionPlugin(onSelectionChanged)),
    ...EDITOR_COMMAND_PLUGINS
  ])
  const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
  return { view, editor }
}

// jsdom's own Selection API does not sync into ProseMirror's state.selection
// (the same limitation MilkdownEditor.test.tsx documents), so every selection
// here is established by dispatching a real transaction.
function select(view: EditorView, from: number, to: number = from): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))
}

/**
 * The document position of `text`'s first character.
 *
 * Walks real text nodes rather than indexing into `doc.textBetween(...)`: a
 * block boundary costs TWO document positions but only one separator
 * character, so a textBetween-based index silently drifts one position per
 * block and lands the selection inside the previous block (caught here for
 * real -- the list test below reported `bullet_list` for a selection that was
 * supposed to be in the paragraph AFTER the list).
 */
function posOf(view: EditorView, text: string): number {
  let found = -1
  view.state.doc.descendants((node, pos) => {
    if (found >= 0) return false
    if (node.isText && node.text) {
      const index = node.text.indexOf(text)
      if (index >= 0) found = pos + index
    }
    return found < 0
  })
  if (found < 0) throw new Error(`posOf: ${text} not found in document`)
  return found
}

describe('readSelectionSnapshot', () => {
  it('reports bold for a range inside bold text', async () => {
    const { view } = await viewFor('**cat** dog')
    const start = posOf(view, 'cat')
    select(view, start, start + 3)
    const snapshot = readSelectionSnapshot(view)
    expect(snapshot.empty).toBe(false)
    expect(snapshot.marks.bold).toBe(true)
    expect(snapshot.marks.italic).toBe(false)
  })

  it('reports italic and inline code from the real schema mark names', async () => {
    // Guards against a plausible wrong guess at the schema's own naming: these
    // are `emphasis` and `inlineCode` in @milkdown/preset-commonmark, not
    // `em`/`code`. A typo there is silently false forever, never an error.
    const { view } = await viewFor('_cat_ `dog`')
    const cat = posOf(view, 'cat')
    select(view, cat, cat + 3)
    expect(readSelectionSnapshot(view).marks.italic).toBe(true)
    const dog = posOf(view, 'dog')
    select(view, dog, dog + 3)
    expect(readSelectionSnapshot(view).marks.inlineCode).toBe(true)
  })

  it('reports strikethrough, whose schema name is `strike_through` and not the obvious guess', async () => {
    // Exactly the trap the italic/inlineCode test above guards, one package
    // over: @milkdown/preset-gfm registers this mark as `strike_through` while
    // its command, this app's label and this field are all spelled
    // "strikethrough". Reading `schema.marks.strikethrough` yields undefined,
    // markActive returns false for undefined, and the indicator is then
    // permanently false with no error anywhere -- which is the same
    // permanently-false-indicator defect Bold and Italic shipped with once.
    const { view } = await viewFor('~~cat~~ dog')
    const cat = posOf(view, 'cat')
    select(view, cat, cat + 3)
    expect(readSelectionSnapshot(view).marks.strikethrough).toBe(true)
    // The negative half, so the assertion above cannot pass against a
    // hardcoded true.
    const dog = posOf(view, 'dog')
    select(view, dog, dog + 3)
    expect(readSelectionSnapshot(view).marks.strikethrough).toBe(false)
  })

  it('reports a link', async () => {
    const { view } = await viewFor('[cat](https://example.com)')
    const start = posOf(view, 'cat')
    select(view, start, start + 3)
    expect(readSelectionSnapshot(view).marks.link).toBe(true)
  })

  it('reports the heading level of the selection’s own block', async () => {
    const { view } = await viewFor('## Title\n\nbody')
    const title = posOf(view, 'Title')
    select(view, title, title + 5)
    expect(readSelectionSnapshot(view).headingLevel).toBe(2)
    const body = posOf(view, 'body')
    select(view, body, body + 4)
    expect(readSelectionSnapshot(view).headingLevel).toBeNull()
  })

  it('reports the nearest ancestor list type', async () => {
    const { view } = await viewFor('- item\n\nplain')
    const item = posOf(view, 'item')
    select(view, item, item + 4)
    expect(readSelectionSnapshot(view).listType).toBe('bullet_list')
    const plain = posOf(view, 'plain')
    select(view, plain, plain + 5)
    expect(readSelectionSnapshot(view).listType).toBeNull()
  })

  it('reports a collapsed selection as empty, with the marks at the caret', async () => {
    const { view } = await viewFor('**cat** dog')
    const start = posOf(view, 'cat')
    select(view, start + 1)
    const snapshot = readSelectionSnapshot(view)
    expect(snapshot.empty).toBe(true)
    expect(snapshot.marks.bold).toBe(true)
  })

  it('reports marks for a PARTIALLY marked range -- documented ProseMirror semantics, not a bug', () => {
    // rangeHasMark is true when ANY part of the range carries the mark, so a
    // half-bold selection reads as bold. Pinned deliberately: Word/Docs would
    // show an indeterminate state, and someone will eventually read this as an
    // off-by-one. It matches what toggleMark then DOES to that range, which is
    // the property worth keeping.
    return viewFor('**cat** dog').then(({ view }) => {
      const start = posOf(view, 'cat')
      select(view, start, start + 7)
      expect(readSelectionSnapshot(view).marks.bold).toBe(true)
    })
  })
})

describe('sameSnapshot', () => {
  const base: SelectionSnapshot = {
    from: 1,
    to: 5,
    empty: false,
    hasFocus: true,
    nodeSelection: false,
    marks: { bold: false, italic: false, inlineCode: false, strikethrough: false, link: false },
    headingLevel: null,
    listType: null,
    linkHref: null,
    taskList: false,
    table: null
  }

  it('compares positions for a NON-empty selection -- a growing drag-select must re-anchor', () => {
    expect(sameSnapshot(base, { ...base, to: 6 })).toBe(false)
  })

  it('IGNORES positions for a collapsed selection -- this is the per-keystroke render guard', () => {
    // Typing moves the caret on every character. Comparing positions here
    // would report a change per keystroke and fire a React render per
    // character, which is the one cost this feature is not allowed to add.
    const caret = { ...base, empty: true, from: 1, to: 1 }
    expect(sameSnapshot(caret, { ...caret, from: 9, to: 9 })).toBe(true)
  })

  it('still reports a formatting change while collapsed', () => {
    const caret = { ...base, empty: true, from: 1, to: 1 }
    expect(sameSnapshot(caret, { ...caret, marks: { ...caret.marks, bold: true } })).toBe(false)
  })

  it('reports focus and node-selection changes', () => {
    expect(sameSnapshot(base, { ...base, hasFocus: false })).toBe(false)
    expect(sameSnapshot(base, { ...base, nodeSelection: true })).toBe(false)
  })

  it('treats null on either side as a change, and null/null as unchanged', () => {
    expect(sameSnapshot(null, base)).toBe(false)
    expect(sameSnapshot(base, null)).toBe(false)
    expect(sameSnapshot(null, null)).toBe(true)
  })
})

describe('createSelectionPlugin', () => {
  it('reports a new selection through its callback', async () => {
    const seen: Array<SelectionSnapshot | null> = []
    const { view } = await viewFor('**cat** dog', (snapshot) => seen.push(snapshot))
    const start = posOf(view, 'cat')
    select(view, start, start + 3)
    const last = seen.at(-1)
    expect(last?.empty).toBe(false)
    expect(last?.marks.bold).toBe(true)
  })

  it('does NOT report again for a caret move through identically formatted text', async () => {
    // The early-return that keeps this feature from costing a React render per
    // keystroke. Deleting sameSnapshot's collapsed-position exemption (or the
    // early return itself) makes this fail.
    const seen: Array<SelectionSnapshot | null> = []
    const { view } = await viewFor('alpha beta', (snapshot) => seen.push(snapshot))
    select(view, 2)
    const afterFirstMove = seen.length
    select(view, 4)
    select(view, 6)
    expect(seen.length).toBe(afterFirstMove)
  })

  it('reports again when the formatting under the caret changes', async () => {
    const seen: Array<SelectionSnapshot | null> = []
    const { view } = await viewFor('**cat** dog', (snapshot) => seen.push(snapshot))
    const cat = posOf(view, 'cat')
    select(view, cat + 1)
    const afterBoldCaret = seen.length
    select(view, posOf(view, 'dog') + 1)
    expect(seen.length).toBeGreaterThan(afterBoldCaret)
    expect(seen.at(-1)?.marks.bold).toBe(false)
  })

  it('dispatches nothing of its own, and a selection transaction cannot mark the document dirty', async () => {
    // The load-bearing claim: showing the bubble must never make a clean
    // document dirty. MilkdownEditor's editedSinceMountRef fires on exactly
    // `(tr.docChanged || tr.storedMarksSet) && tr.getMeta('addToHistory') !==
    // false` (its own filter, copied from @milkdown/plugin-listener's), so
    // assert against that predicate directly rather than against a proxy like
    // "the markdown didn't change" -- a docChanged transaction producing
    // equal-looking text would still trip the tracker.
    const seen: Array<SelectionSnapshot | null> = []
    const { view } = await viewFor('alpha beta', (snapshot) => seen.push(snapshot))
    const before = view.state.doc.toJSON()
    const dispatchSpy = vi.spyOn(view, 'dispatch')
    const start = posOf(view, 'beta')
    select(view, start, start + 4)
    expect(seen.at(-1)?.empty).toBe(false)
    expect(view.state.doc.toJSON()).toEqual(before)
    expect(dispatchSpy.mock.calls.length).toBe(1)
    for (const [tr] of dispatchSpy.mock.calls) {
      const wouldMarkDirty =
        (tr.docChanged || tr.storedMarksSet) && tr.getMeta('addToHistory') !== false
      expect(wouldMarkDirty).toBe(false)
    }
  })

  it('reports null when the editor is destroyed, so a stale bubble cannot outlive it', async () => {
    const seen: Array<SelectionSnapshot | null> = []
    const { view, editor } = await viewFor('alpha beta', (snapshot) => seen.push(snapshot))
    select(view, 1, 6)
    expect(seen.at(-1)).not.toBeNull()
    await editor.destroy()
    expect(seen.at(-1)).toBeNull()
  })

  it('reports on a real DOM blur, which dispatches no transaction at all', async () => {
    // Focus changes do not necessarily produce a ProseMirror transaction, so
    // the view.update hook alone would leave the bubble on screen, fully
    // interactive, after the user clicked away into the app chrome. The plugin
    // listens for real focus/blur on the editor's own node for this. jsdom's
    // hasFocus() is false throughout here, so the observable proof is that
    // `blur` reaches the plugin at all -- driven by making the snapshot differ
    // via a real selection first.
    const seen: Array<SelectionSnapshot | null> = []
    const { view } = await viewFor('alpha beta', (snapshot) => seen.push(snapshot))
    select(view, 1, 6)
    const before = seen.length
    const focusSpy = vi.fn()
    view.dom.addEventListener('blur', focusSpy)
    view.dom.dispatchEvent(new FocusEvent('blur'))
    expect(focusSpy).toHaveBeenCalledTimes(1)
    // No snapshot field actually changed (hasFocus was already false under
    // jsdom), so the early-return correctly suppresses a redundant report --
    // asserting that, rather than a spurious extra callback, is what proves
    // the listener is wired without pretending jsdom models focus.
    expect(seen.length).toBe(before)
  })
})

describe('readSelectionRect', () => {
  it('RETURNS ALL ZEROS UNDER JSDOM -- this test exists to make that visible', async () => {
    // Not a behavioural requirement: a PIN on the environment hazard. Under
    // real Chromium this returns the selection's true viewport box; under
    // jsdom, test-setup.ts's Range polyfills make coordsAtPos silently produce
    // zeros instead of throwing. If this test ever starts failing because the
    // numbers became real, jsdom grew a layout engine and the warning at the
    // top of this file can be revisited -- until then, never assert a bubble
    // POSITION in this environment.
    const { view } = await viewFor('alpha beta')
    select(view, 1, 6)
    expect(readSelectionRect(view)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
  })
})
