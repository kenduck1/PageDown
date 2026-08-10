import { describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { editorViewCtx } from '@milkdown/core'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { $prose } from '@milkdown/utils'
import { createTestEditor } from './test-editor'
import { EDITOR_COMMAND_PLUGINS } from './commands'
import {
  closeSlashIn,
  createSlashPlugin,
  openSlashSessionAt,
  runSlashItemIn,
  setSlashItemCount,
  slashPluginKey,
  type SlashSession
} from './slash-plugin'

// !!! SPIKE RESULT, load-bearing for how this file is written !!!
// CLAUDE.md documents that a real DOM keydown does NOT reach
// prosemirror-keymap under jsdom (proven with a stock Mod-b control).
// handleKeyDown is a DIFFERENT dispatch path (editHandlers.keydown ->
// someProp, not the keymap plugin), and a throwaway spike (fireEvent.keyDown
// against a bare $prose plugin's own handleKeyDown, deleted after use --
// see task-3-report.md for the transcript) confirmed it DOES work: the event
// reaches handleKeyDown, and returning `true` triggers ProseMirror's own
// preventDefault() -- but never stopPropagation(), also confirmed by spike --
// exactly matching the design doc's claim. So every navigation-key test
// below drives a REAL fireEvent.keyDown against view.dom, not a direct call
// to plugin.props.handleKeyDown with a synthetic event.

const noop = (): void => {}

// Mirrors find-plugin.test.ts's / selection-plugin.test.ts's own viewFor
// helper: the slash plugin is a per-mount $prose plugin (same as
// MilkdownEditor.tsx will mount it in Task 5), and EDITOR_COMMAND_PLUGINS
// rides along so the composition under test -- and the plugin-ordering test
// below -- match the real one MilkdownEditor.tsx ships, not a thinner
// stand-in.
async function viewFor(
  markdown: string,
  onStateChanged: (session: SlashSession | null) => void = noop
): Promise<{ view: EditorView; editor: Awaited<ReturnType<typeof createTestEditor>> }> {
  const editor = await createTestEditor(markdown, [
    $prose(() => createSlashPlugin(onStateChanged)),
    ...EDITOR_COMMAND_PLUGINS
  ])
  const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
  return { view, editor }
}

// The document position of `text`'s first character. Copied from
// selection-plugin.test.ts's own posOf (not shared -- each plugin test file
// keeps its own copy, matching this codebase's existing precedent) --
// see that file's own comment for why this walks real text nodes rather
// than indexing into doc.textBetween(...): a block boundary costs TWO
// document positions but only one separator character, so a
// textBetween-based index silently drifts.
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

function session(view: EditorView): SlashSession | null {
  return slashPluginKey.getState(view.state)?.session ?? null
}

describe('slash-plugin: opening a session', () => {
  it('opens at the start of an empty paragraph', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    expect(session(view)).toEqual({ anchorPos: 1, query: '', activeIndex: 0, itemCount: 0 })
  })

  it('opens when the "/" is preceded by whitespace', async () => {
    const { view } = await viewFor('para one\n\npara two')
    const pos = posOf(view, 'two')
    openSlashSessionAt(view, pos)
    expect(session(view)).toEqual({ anchorPos: pos, query: '', activeIndex: 0, itemCount: 0 })
  })

  it('does not open mid-word ("and/or") -- the false-positive guard findSlashTrigger owns', async () => {
    const { view } = await viewFor('andor')
    openSlashSessionAt(view, posOf(view, 'or'))
    expect(session(view)).toBeNull()
  })

  it('does not open inside a code block -- parent is not a paragraph', async () => {
    const { view } = await viewFor('```\ncode\n```\n')
    openSlashSessionAt(view, posOf(view, 'code'))
    expect(session(view)).toBeNull()
  })

  it('does not open inside a heading -- parent must be EXACTLY a paragraph, not any textblock', async () => {
    // "Heading" sits at parentOffset 0 (structurally a valid trigger
    // position -- start of block), so this specifically isolates the
    // paragraph-type check from findSlashTrigger's own position rule.
    const { view } = await viewFor('# Heading')
    openSlashSessionAt(view, posOf(view, 'Heading'))
    expect(session(view)).toBeNull()
  })

  it('does not open inside an inlineCode mark -- a "/" typed there inherits the mark like any other character', async () => {
    const { view } = await viewFor('`ab`')
    openSlashSessionAt(view, posOf(view, 'ab') + 1)
    expect(session(view)).toBeNull()
  })

  it("opens inside a table cell's own paragraph -- applicability is an item-level concern, not a trigger-level one", async () => {
    const { view } = await viewFor('| a | b |\n| - | - |\n| xyz | d |\n')
    // Anchored at the START of the cell's own content (before "xyz"), not
    // after it -- a "/" typed directly after "xyz" with no separating
    // whitespace is correctly rejected by the SAME mid-word rule "and/or"
    // is (this is a trigger-position test, not a "does a table cell count
    // as a paragraph" test in disguise; that's the point being isolated).
    const pos = posOf(view, 'xyz')
    openSlashSessionAt(view, pos)
    expect(session(view)).toEqual({ anchorPos: pos, query: '', activeIndex: 0, itemCount: 0 })
  })

  it('does not open for a multi-character insertion ending in "/" -- e.g. a paste', async () => {
    const { view } = await viewFor('')
    view.dispatch(view.state.tr.insertText('abc/', 1))
    expect(session(view)).toBeNull()
  })
})

describe('slash-plugin: tracking the live query', () => {
  it('extends the query as more characters are typed, keeping the same anchor', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    view.dispatch(view.state.tr.insertText('he', view.state.selection.from))
    expect(session(view)).toEqual({ anchorPos: 1, query: 'he', activeIndex: 0, itemCount: 0 })
  })

  it('keeps the ORIGINAL anchor when a later "/" is typed into the live query -- never re-scans for a nearer trigger', async () => {
    // The design doc's own load-bearing claim: deriving the query from the
    // stored anchor (doc.textBetween(anchorPos + 1, selection.from)) rather
    // than re-running findSlashTrigger's backward scan on every keystroke.
    // A naive re-scan would find the SECOND "/" below as the nearest
    // trigger and report the anchor jumping forward with query "cd" --
    // silently losing "ab/" from the query. This proves the anchor is
    // sticky instead.
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    view.dispatch(view.state.tr.insertText('ab', view.state.selection.from))
    view.dispatch(view.state.tr.insertText('/', view.state.selection.from))
    view.dispatch(view.state.tr.insertText('cd', view.state.selection.from))
    expect(session(view)).toEqual({ anchorPos: 1, query: 'ab/cd', activeIndex: 0, itemCount: 0 })
  })

  it('closes when whitespace lands in the query', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    view.dispatch(view.state.tr.insertText('ab', view.state.selection.from))
    view.dispatch(view.state.tr.insertText(' ', view.state.selection.from))
    expect(session(view)).toBeNull()
  })

  it('stays open at exactly the 24-character cap and closes one character past it', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    view.dispatch(view.state.tr.insertText('a'.repeat(24), view.state.selection.from))
    expect(session(view)?.query).toHaveLength(24)
    view.dispatch(view.state.tr.insertText('b', view.state.selection.from))
    expect(session(view)).toBeNull()
  })

  it('closes when the selection leaves the anchored range -- e.g. a click into a different paragraph', async () => {
    const { view } = await viewFor('para one\n\npara two')
    openSlashSessionAt(view, posOf(view, 'two'))
    expect(session(view)).not.toBeNull()
    const elsewhere = posOf(view, 'para') // the FIRST "para", inside "para one"
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, elsewhere)))
    expect(session(view)).toBeNull()
  })

  it('closes when the "/" character itself is deleted (backspacing through it)', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    view.dispatch(view.state.tr.insertText('ab', view.state.selection.from))
    expect(session(view)?.query).toBe('ab')
    view.dispatch(view.state.tr.delete(1, 2)) // removes just the "/", leaving "ab"
    expect(session(view)).toBeNull()
  })

  it('decorates the "/query" range in the real rendered DOM', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    view.dispatch(view.state.tr.insertText('abc', view.state.selection.from))
    const span = view.dom.querySelector('.pagedown-slash-query')
    expect(span?.textContent).toBe('/abc')
  })
})

describe("slash-plugin: handleKeyDown (real DOM keydowns -- see this file's own spike note above)", () => {
  it('ArrowDown/ArrowUp move activeIndex with wraparound', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    setSlashItemCount(view, 3)
    fireEvent.keyDown(view.dom, { key: 'ArrowDown' })
    expect(session(view)?.activeIndex).toBe(1)
    fireEvent.keyDown(view.dom, { key: 'ArrowDown' })
    expect(session(view)?.activeIndex).toBe(2)
    fireEvent.keyDown(view.dom, { key: 'ArrowDown' })
    expect(session(view)?.activeIndex).toBe(0) // wraps forward
    fireEvent.keyDown(view.dom, { key: 'ArrowUp' })
    expect(session(view)?.activeIndex).toBe(2) // wraps backward
  })

  it('ArrowDown/Up are inert (but still swallowed) before any itemCount has been reported', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    fireEvent.keyDown(view.dom, { key: 'ArrowDown' })
    expect(session(view)?.activeIndex).toBe(0)
  })

  it('Enter and Tab are swallowed (preventDefault) but keep bubbling -- only Escape stops propagation', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    for (const key of ['Enter', 'Tab']) {
      let windowSaw = false
      const listener = (): void => {
        windowSaw = true
      }
      window.addEventListener('keydown', listener, { once: true })
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      view.dom.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(windowSaw).toBe(true)
      window.removeEventListener('keydown', listener)
    }
  })

  it('Escape closes the session AND stops propagation, so a concurrently open Find bar is not also closed', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    let windowSaw = false
    window.addEventListener('keydown', () => (windowSaw = true), { once: true })
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    view.dom.dispatchEvent(event)
    expect(session(view)).toBeNull()
    expect(event.defaultPrevented).toBe(true)
    expect(windowSaw).toBe(false)
  })

  it('does not intercept keys, and does not throw, when no session is open', async () => {
    const { view } = await viewFor('')
    let windowSaw = false
    window.addEventListener('keydown', () => (windowSaw = true), { once: true })
    expect(() => fireEvent.keyDown(view.dom, { key: 'ArrowDown' })).not.toThrow()
    expect(windowSaw).toBe(true)
  })

  it('closes on a real DOM blur', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    view.dom.dispatchEvent(new FocusEvent('blur'))
    expect(session(view)).toBeNull()
  })
})

describe('slash-plugin: setSlashItemCount', () => {
  it('closes the session on a report of 0 -- the "empty filtered list" close condition', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    setSlashItemCount(view, 0)
    expect(session(view)).toBeNull()
  })

  it('does NOT close a freshly-opened session before any report has arrived (itemCount defaults to 0)', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    expect(session(view)).not.toBeNull()
    expect(session(view)?.itemCount).toBe(0)
  })

  it('clamps activeIndex back to 0 when a fresh report no longer covers it', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    setSlashItemCount(view, 5)
    fireEvent.keyDown(view.dom, { key: 'ArrowDown' })
    fireEvent.keyDown(view.dom, { key: 'ArrowDown' })
    expect(session(view)?.activeIndex).toBe(2)
    setSlashItemCount(view, 2)
    expect(session(view)?.activeIndex).toBe(0)
  })

  it('is a no-op when no session is open', async () => {
    const { view } = await viewFor('')
    expect(() => setSlashItemCount(view, 5)).not.toThrow()
    expect(session(view)).toBeNull()
  })
})

describe('slash-plugin: runSlashItemIn', () => {
  it('deletes exactly [from, to) then calls run() synchronously against the post-delete document', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    view.dispatch(view.state.tr.insertText('task', view.state.selection.from))
    const current = session(view)!
    const from = current.anchorPos
    const to = current.anchorPos + 1 + current.query.length
    let sawDocTextInRun = 'not called'
    runSlashItemIn(view, from, to, () => {
      sawDocTextInRun = view.state.doc.textContent
    })
    expect(view.state.doc.textContent).toBe('')
    expect(sawDocTextInRun).toBe('')
  })
})

describe('slash-plugin: reporting to React', () => {
  it('reports session changes through its callback, from view.update -- not from apply', async () => {
    const seen: Array<SlashSession | null> = []
    const { view } = await viewFor('', (next) => seen.push(next))
    openSlashSessionAt(view, 1)
    expect(seen.at(-1)).toEqual({ anchorPos: 1, query: '', activeIndex: 0, itemCount: 0 })
    closeSlashIn(view)
    expect(seen.at(-1)).toBeNull()
  })

  it('reports null when the editor is destroyed, so a stale palette cannot outlive it', async () => {
    const seen: Array<SlashSession | null> = []
    const { view, editor } = await viewFor('', (next) => seen.push(next))
    openSlashSessionAt(view, 1)
    expect(seen.at(-1)).not.toBeNull()
    await editor.destroy()
    expect(seen.at(-1)).toBeNull()
  })

  it('does not report again when nothing meaningful changed (a no-op transaction)', async () => {
    const seen: Array<SlashSession | null> = []
    const { view } = await viewFor('', (next) => seen.push(next))
    openSlashSessionAt(view, 1)
    const countAfterOpen = seen.length
    // A transaction with no meta, no doc change, no selection change: this
    // codebase's own convention for "nothing happened" (mirrors
    // find-plugin.ts's identical apply-level early return).
    view.dispatch(view.state.tr)
    expect(seen.length).toBe(countAfterOpen)
  })
})

describe('slash-plugin: closing does not mark a clean document dirty', () => {
  it('closeSlashIn dispatches only a doc-unchanged, no-stored-marks transaction', async () => {
    // The exact predicate MilkdownEditor's own editedSinceMountRef gates on
    // (see that component's own doc comment): (docChanged || storedMarksSet)
    // && addToHistory !== false. Asserted directly, as CLAUDE.md and
    // find-plugin.test.ts's own equivalent test both require, rather than
    // inferred from "the document text looks unchanged".
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    const dispatchSpy = vi.spyOn(view, 'dispatch')
    closeSlashIn(view)
    expect(dispatchSpy.mock.calls.length).toBeGreaterThan(0)
    for (const [tr] of dispatchSpy.mock.calls) {
      expect(tr.docChanged).toBe(false)
      expect(tr.storedMarksSet).toBe(false)
    }
  })

  it('setSlashItemCount likewise dispatches only a doc-unchanged, no-stored-marks transaction', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    const dispatchSpy = vi.spyOn(view, 'dispatch')
    setSlashItemCount(view, 3)
    expect(dispatchSpy.mock.calls.length).toBeGreaterThan(0)
    for (const [tr] of dispatchSpy.mock.calls) {
      expect(tr.docChanged).toBe(false)
      expect(tr.storedMarksSet).toBe(false)
    }
  })
})

// Plugin/PluginKey's own `.key` string field is a real runtime property
// (confirmed by reading prosemirror-state's own source -- createKey(name)
// makes it "MILKDOWN_CUSTOM_INPUTRULES$" for the first PluginKey ever
// constructed with that name, "$1"/"$2"/... for any collision) but is
// deliberately NOT part of prosemirror-state's public .d.ts -- PluginKey.get/
// .getState are the supported surface. There is no other way to identify
// @milkdown/prose's own internal customInputRulesKey-tagged plugin from
// outside that package (we have no reference to its PluginKey instance to
// call .get() with), so this one, narrow cast is the only way to write the
// test the design doc's own ordering claim demands.
function runtimePluginKey(p: unknown): string {
  return (p as { key: string }).key
}

describe('slash-plugin: keymap priority', () => {
  it("precedes MILKDOWN_CUSTOM_INPUTRULES$ in view.state.plugins -- the design doc's own evidence that a $prose handleKeyDown outranks every Milkdown keymap depends on this", async () => {
    const { view } = await viewFor('')
    const slashIndex = view.state.plugins.findIndex(
      (p) => runtimePluginKey(p) === runtimePluginKey(slashPluginKey)
    )
    const inputRulesIndex = view.state.plugins.findIndex(
      (p) => runtimePluginKey(p) === 'MILKDOWN_CUSTOM_INPUTRULES$'
    )
    expect(slashIndex).toBeGreaterThanOrEqual(0)
    expect(inputRulesIndex).toBeGreaterThanOrEqual(0)
    expect(slashIndex).toBeLessThan(inputRulesIndex)
  })
})
