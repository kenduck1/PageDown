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
// to plugin.props.handleKeyDown with a synthetic event. Fix round 1 leaned on
// this further still: it's also what makes the "no session -> a real Enter
// really splits the paragraph" control (I2 below) possible at all -- a real,
// measured finding (not assumed) that a bare, unmodified key like Enter DOES
// reach the underlying keymap plugin under jsdom, unlike the modifier-chord
// case (Mod-Z etc.) CLAUDE.md documents as NOT reaching prosemirror-keymap.

const noop = (): void => {}

// The default injected item count for tests that don't care about the exact
// number, just that a session can open and stay open at all (itemCount <= 0
// refuses to open / closes outright -- see createSlashPlugin's own header).
// Picked to be an obviously-arbitrary "plenty of items" constant, distinct
// from 0 and from 1, so a test that DOES care about the exact value reads as
// deliberate rather than coincidental.
const PLENTY = 8

// Mirrors find-plugin.test.ts's / selection-plugin.test.ts's own viewFor
// helper: the slash plugin is a per-mount $prose plugin (same as
// MilkdownEditor.tsx will mount it in Task 5), and EDITOR_COMMAND_PLUGINS
// rides along so the composition under test -- and the plugin-ordering test
// below -- match the real one MilkdownEditor.tsx ships, not a thinner
// stand-in. `countMatching` defaults to a constant (fix round 1 replaced the
// old setSlashItemCount external-report channel with this constructor-time
// dependency injection -- see slash-plugin.ts's own header for why) so tests
// that don't care about the exact filtered count don't have to supply one.
async function viewFor(
  markdown: string,
  onStateChanged: (session: SlashSession | null) => void = noop,
  countMatching: (query: string) => number = () => PLENTY
): Promise<{ view: EditorView; editor: Awaited<ReturnType<typeof createTestEditor>> }> {
  const editor = await createTestEditor(markdown, [
    $prose(() => createSlashPlugin(onStateChanged, countMatching)),
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

// A real, cancelable, bubbling KeyboardEvent -- used wherever a test needs to
// read `event.defaultPrevented` afterward (fireEvent.keyDown's own return
// value isn't the event, and constructing it directly is what selection-
// plugin.test.ts's own blur test already does for the same reason).
function keydown(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
}

describe('slash-plugin: opening a session', () => {
  it('opens at the start of an empty paragraph', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    expect(session(view)).toEqual({
      anchorPos: 1,
      query: '',
      queryEnd: 2,
      activeIndex: 0,
      itemCount: PLENTY
    })
  })

  it('opens when the "/" is preceded by whitespace', async () => {
    const { view } = await viewFor('para one\n\npara two')
    const pos = posOf(view, 'two')
    openSlashSessionAt(view, pos)
    expect(session(view)).toEqual({
      anchorPos: pos,
      query: '',
      queryEnd: pos + 1,
      activeIndex: 0,
      itemCount: PLENTY
    })
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
    expect(session(view)).toEqual({
      anchorPos: pos,
      query: '',
      queryEnd: pos + 1,
      activeIndex: 0,
      itemCount: PLENTY
    })
  })

  it('does not open for a multi-character insertion ending in "/" -- e.g. a paste', async () => {
    const { view } = await viewFor('')
    view.dispatch(view.state.tr.insertText('abc/', 1))
    expect(session(view)).toBeNull()
  })

  it('refuses to open at all when countMatching("") is already 0 -- the "empty filtered list" rule applies symmetrically at open time', async () => {
    const { view } = await viewFor('', noop, () => 0)
    openSlashSessionAt(view, 1)
    expect(session(view)).toBeNull()
  })
})

describe('slash-plugin: tracking the live query', () => {
  it('extends the query as more characters are typed, keeping the same anchor', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    view.dispatch(view.state.tr.insertText('he', view.state.selection.from))
    expect(session(view)).toEqual({
      anchorPos: 1,
      query: 'he',
      queryEnd: 4,
      activeIndex: 0,
      itemCount: PLENTY
    })
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
    expect(session(view)).toEqual({
      anchorPos: 1,
      query: 'ab/cd',
      queryEnd: 7,
      activeIndex: 0,
      itemCount: PLENTY
    })
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

  // === CRITICAL C1 regression, fix round 1 ===
  // Measured by probe (see slash-plugin.ts's own advanceSession header
  // comment for the full writeup): opening a session before pre-existing
  // text and pressing ArrowRight once -- NOT intercepted by handleKeyDown,
  // which only claims ArrowDown/Up for item-list navigation, so this really
  // reaches ProseMirror's own cursor movement -- used to silently ANNEX the
  // next character of that pre-existing text into the query. Choosing an
  // item would then delete that annexed text along with the real query, a
  // real, one-keypress-reachable data-loss bug. The fix (queryEnd, tracking
  // the query's own right edge) closes the session instead.
  //
  // !!! JSDOM HAZARD !!! A real ArrowRight keydown does NOT move the
  // ProseMirror selection under jsdom: prosemirror-commands' own baseKeymap
  // (confirmed by reading its source) binds no ArrowLeft/ArrowRight command
  // at all -- plain caret movement is entirely native browser/contentEditable
  // behavior, which jsdom does not implement (the same class of gap
  // documented elsewhere in this codebase for coordsAtPos/getClientRects).
  // Dispatching `keydown('ArrowRight')` here was tried first and left the
  // selection completely unchanged. The test instead dispatches the
  // SELECTION TRANSACTION a real ArrowRight would have produced -- what
  // matters for this fix is that the transaction is selection-only (no doc
  // change, not intercepted by this plugin's own handleKeyDown, exactly
  // like a real un-intercepted arrow key), not the literal DOM event that
  // would cause it in a real browser. The genuine end-to-end key-press proof
  // belongs in Gate 29 (Task 6), which drives real Chromium.
  it('C1: does not annex pre-existing text when the cursor moves right past the query -- closes instead', async () => {
    const { view } = await viewFor('Hello world')
    const pos = posOf(view, 'world')
    openSlashSessionAt(view, pos)
    expect(session(view)).toEqual({
      anchorPos: pos,
      query: '',
      queryEnd: pos + 1,
      activeIndex: 0,
      itemCount: PLENTY
    })
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, view.state.selection.from + 1)
      )
    )
    expect(session(view)).toBeNull()
  })

  // A related, intentional consequence of the SAME fix, worth pinning rather
  // than leaving as an undocumented surprise: queryEnd is reset to
  // selection.from on every update (per the prescribed fix), so moving the
  // cursor LEFT into an already-typed query shrinks the tracked right edge
  // to match -- and a SUBSEQUENT ArrowRight back toward where the cursor
  // used to be then also closes the session, because it now exceeds that
  // shrunken edge. This is not a separate bug: it is the same right-edge
  // protection applied consistently, at the cost of also catching a
  // "correct a typo mid-query, then arrow back" gesture. Documented here so
  // a future reader doesn't mistake it for an oversight.
  it('a related consequence: ArrowLeft into the query shrinks its tracked right edge, so a later ArrowRight past that (now smaller) edge also closes', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    view.dispatch(view.state.tr.insertText('abc', view.state.selection.from))
    expect(session(view)?.query).toBe('abc')
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, view.state.selection.from - 1)
      )
    )
    expect(session(view)?.query).toBe('ab') // still open, truncated
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, view.state.selection.from + 1)
      )
    )
    expect(session(view)).toBeNull()
  })
})

describe("slash-plugin: handleKeyDown (real DOM keydowns -- see this file's own spike note above)", () => {
  it('ArrowDown/ArrowUp move activeIndex with wraparound', async () => {
    const { view } = await viewFor('', noop, () => 3)
    openSlashSessionAt(view, 1)
    fireEvent.keyDown(view.dom, { key: 'ArrowDown' })
    expect(session(view)?.activeIndex).toBe(1)
    fireEvent.keyDown(view.dom, { key: 'ArrowDown' })
    expect(session(view)?.activeIndex).toBe(2)
    fireEvent.keyDown(view.dom, { key: 'ArrowDown' })
    expect(session(view)?.activeIndex).toBe(0) // wraps forward
    fireEvent.keyDown(view.dom, { key: 'ArrowUp' })
    expect(session(view)?.activeIndex).toBe(2) // wraps backward
  })

  // === IMPORTANT I1 regression, fix round 1 ===
  // Mutating the `default:` branch from `return false` to `return true`
  // previously left all 32 existing tests green -- every query-tracking
  // test drove `tr.insertText` directly and never reached handleKeyDown at
  // all, so nothing actually proved a printable keystroke is left alone.
  // `return true` would swallow every keystroke while the palette is open,
  // meaning the query could never be typed in the real app.
  it('I1: a printable character is NOT swallowed -- everything but the explicitly matched keys returns false', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    const event = keydown('a')
    view.dom.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
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
      const event = keydown(key)
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
    const event = keydown('Escape')
    view.dom.dispatchEvent(event)
    expect(session(view)).toBeNull()
    expect(event.defaultPrevented).toBe(true)
    expect(windowSaw).toBe(false)
  })

  // === IMPORTANT I2 regression, fix round 1 ===
  // The old "does not intercept keys ... when no session is open" test only
  // fired ArrowDown and asserted "didn't throw" + "window saw it" -- both
  // stay true even if Enter/Tab were swallowed EDITOR-WIDE (a severe
  // regression: nothing could ever split a paragraph again). This pair is
  // the real, measured control: a bare Enter, with no session open, really
  // splits the paragraph (a genuine doc.childCount 1 -> 2, proving the real
  // keymap fires under jsdom for this key), and the identical Enter, with a
  // session open, does not (the plugin's own handleKeyDown genuinely beat
  // the keymap to it) -- also the only runtime evidence for the
  // keymap-priority claim; the plugin-ordering test near the bottom of this
  // file proves array order only.
  it('I2 control: a real Enter with NO session open really splits the paragraph', async () => {
    const { view } = await viewFor('hello')
    expect(view.state.doc.childCount).toBe(1)
    view.dom.dispatchEvent(keydown('Enter'))
    expect(view.state.doc.childCount).toBe(2)
  })

  it('I2: the identical Enter, with a session open, does NOT split the paragraph -- handleKeyDown genuinely wins', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    expect(view.state.doc.childCount).toBe(1)
    view.dom.dispatchEvent(keydown('Enter'))
    expect(view.state.doc.childCount).toBe(1)
  })

  it('does not throw, and does not intercept, ArrowDown when no session is open', async () => {
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

describe('slash-plugin: itemCount is computed synchronously via the injected countMatching', () => {
  // === IMPORTANT I3, fix round 1 (replacing the old setSlashItemCount tests) ===
  // The previous design reported itemCount IN from outside via a separate
  // meta transaction, which review found two real costs for: a stale-count
  // window between the query changing and the next external report, and
  // silent failure (arrows permanently inert, the empty-list close never
  // firing) if a future caller simply forgot to call the reporter. These
  // tests prove the replacement -- a constructor-injected countMatching --
  // closes both gaps: itemCount is recomputed in the SAME apply that
  // changes the query, and "forgetting to report" is no longer a reachable
  // state at all (there is nothing left to forget to call).
  it('computes itemCount from countMatching at open time', async () => {
    const { view } = await viewFor('', noop, (query) => (query === '' ? 5 : 0))
    openSlashSessionAt(view, 1)
    expect(session(view)?.itemCount).toBe(5)
  })

  it('recomputes itemCount in the SAME transaction that changes the query -- no stale window', async () => {
    const countMatching = (query: string): number => {
      if (query === '') return 5
      if (query.startsWith('h')) return 2
      return 0
    }
    const { view } = await viewFor('', noop, countMatching)
    openSlashSessionAt(view, 1)
    expect(session(view)?.itemCount).toBe(5)
    view.dispatch(view.state.tr.insertText('h', view.state.selection.from))
    expect(session(view)?.itemCount).toBe(2)
  })

  it('closes the moment the query narrows to match nothing -- synchronous, not a later report', async () => {
    const countMatching = (query: string): number =>
      query === '' ? 5 : query.startsWith('h') ? 2 : 0
    const { view } = await viewFor('', noop, countMatching)
    openSlashSessionAt(view, 1)
    view.dispatch(view.state.tr.insertText('z', view.state.selection.from))
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
    expect(seen.at(-1)).toEqual({
      anchorPos: 1,
      query: '',
      queryEnd: 2,
      activeIndex: 0,
      itemCount: PLENTY
    })
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

describe('slash-plugin: closing/navigating does not mark a clean document dirty', () => {
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

  it('the ArrowDown/Up-triggered setActiveIndex transaction is also doc-unchanged and no-stored-marks', async () => {
    const { view } = await viewFor('', noop, () => 3)
    openSlashSessionAt(view, 1)
    const dispatchSpy = vi.spyOn(view, 'dispatch')
    fireEvent.keyDown(view.dom, { key: 'ArrowDown' })
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
  it("precedes MILKDOWN_CUSTOM_INPUTRULES$ in view.state.plugins -- the design doc's own evidence that a $prose handleKeyDown outranks every Milkdown keymap depends on this (array order only -- see I2 above for the runtime proof)", async () => {
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
