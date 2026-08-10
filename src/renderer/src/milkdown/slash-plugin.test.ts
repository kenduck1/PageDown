import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { commandsCtx, editorViewCtx } from '@milkdown/core'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { undo, undoDepth } from '@milkdown/prose/history'
import { $prose } from '@milkdown/utils'
import { hardbreakSchema, wrapInHeadingCommand } from '@milkdown/preset-commonmark'
import { createTestEditor } from './test-editor'
import { EDITOR_COMMAND_PLUGINS } from './commands'
import {
  closeSlashIn,
  createSlashPlugin,
  openSlashSessionAt,
  runSlashItemIn,
  setActiveSlashIndexIn,
  slashPluginKey,
  type CountMatching,
  type OnChooseActive,
  type SlashSession
} from './slash-plugin'
import { SLASH_ITEMS } from './slash-items'
import { filterSlashItems } from '../lib/slash-filter'
import { EDITOR_SCHEMA_PLUGINS } from './plugins'
import { SLASH_LISTBOX_ID, slashOptionDomId } from '../lib/slash-a11y'

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
// `onChooseActive` (fix round 1, CRITICAL C1) defaults to a no-op for the
// same reason -- most tests below don't care whether Enter/Tab actually
// chose anything, only the dedicated describe block further down does.
async function viewFor(
  markdown: string,
  onStateChanged: (session: SlashSession | null) => void = noop,
  countMatching: CountMatching = () => PLENTY,
  onChooseActive: OnChooseActive = noop
): Promise<{ view: EditorView; editor: Awaited<ReturnType<typeof createTestEditor>> }> {
  const editor = await createTestEditor(markdown, [
    $prose(() => createSlashPlugin(onStateChanged, countMatching, onChooseActive)),
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

  // === Gate 29 fix: the widened insertedSingleSlash, and what jsdom CAN and
  // CANNOT prove about it ===
  //
  // jsdom cannot reproduce the actual Chromium DOM behavior that caused this
  // bug (contenteditable silently converting a trailing space to `&nbsp;`
  // then back again as part of the SAME mutation that inserts the next
  // character -- see Gate 29's own header comment and this file's
  // insertedSingleSlash for the full, measured writeup) -- there is no
  // keyboard/DOM API this test file can drive that would make jsdom produce
  // that transaction shape on its own the way real Chromium does. What CAN
  // be proven here is the SHAPE of the fix: given a transaction matching
  // what real Chromium was measured to produce (built directly), does the
  // plugin's OWN logic correctly open a session? That is a real, direct test
  // of insertedSingleSlash's new behavior, just not a test that the browser
  // quirk itself exists -- that half is only provable against the real
  // built app (phase0/gate29-slash-menu.spec.ts's own "trailing space" test,
  // added alongside this fix).
  //
  // TWO ROUNDS of this fix, and the test below is what the SECOND one is
  // pinned against -- worth recording plainly rather than only in
  // slash-plugin.ts's own comment, since it's exactly the kind of thing a
  // future reader would otherwise re-derive the hard way. The first attempt
  // (still tested below, as "Gate 29 hypothetical shape") assumed Chromium
  // would represent this as TWO separate steps: a length-preserving
  // nbsp<->space swap, then a separate bare "/" insert. Running the ACTUAL
  // gate against real Chromium (with temporary diagnostic logging of
  // `tr.steps`, added and then removed once this was understood) showed
  // that guess was wrong: the real transaction is a SINGLE ReplaceStep whose
  // slice is one text node containing " /" (a space, then the slash) AS ONE
  // UNIT, replacing the 1-character nbsp with that whole 2-character run.
  // insertedSingleSlash's SLASH_INSERTION_TEXT pattern (whitespace* then a
  // literal "/") is what actually matches this.
  it('Gate 29: opens a session for the REAL measured Chromium shape -- one ReplaceStep replacing the nbsp with a " /" (space + slash) text run', async () => {
    // Content ends in U+00A0 (a non-breaking space, written as an escape so
    // this source file doesn't itself contain a raw irregular-whitespace
    // character eslint would flag) -- standing in for "the user already
    // typed a trailing space, which Chromium is currently representing as
    // nbsp." "Hello" occupies positions 1-5, the nbsp sits at position 6.
    const { view } = await viewFor('Hello\u00A0')
    // ONE step: replace the nbsp (6,7) with the two-character text " /" --
    // this is the literal shape captured from the real built app (Gate 29's
    // own diagnostic run against real Chromium, not assumed or guessed).
    const tr = view.state.tr.insertText(' /', 6, 7)
    // insertText, given EXPLICIT from/to, does NOT move the selection to the
    // insertion point on its own (the exact bug openSlashSessionAt's own doc
    // comment already documents, from this file's very first task) -- set it
    // explicitly, matching that established fix.
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 8)))
    expect(session(view)).toEqual({
      anchorPos: 7,
      query: '',
      queryEnd: 8,
      activeIndex: 0,
      itemCount: PLENTY
    })
  })

  it('Gate 29 hypothetical shape: also opens for a "/" insertion accompanied by a SEPARATE, incidental length-preserving step -- not what real Chromium was measured to produce, but a shape the fix happens to support too', async () => {
    // Content ends in U+00A0, same setup as the test above.
    const { view } = await viewFor('Hello\u00A0')
    // Step 1: replace the nbsp (6,7) with a plain space -- length-preserving
    // (1 char removed, 1 char inserted). Step 2: insert "/" right after it,
    // as its OWN separate step. Both steps land on the SAME transaction
    // (chained Transform calls accumulate steps). This is NOT the shape Gate
    // 29's own real-Chromium measurement found (see the test above and
    // insertedSingleSlash's own comment for that) -- kept as a second,
    // independent proof that the fix is not narrowly tuned to only the one
    // exact captured shape.
    const tr = view.state.tr.insertText(' ', 6, 7).insertText('/', 7)
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 8)))
    expect(session(view)).toEqual({
      anchorPos: 7,
      query: '',
      queryEnd: 8,
      activeIndex: 0,
      itemCount: PLENTY
    })
  })

  it('Gate 29 control: a 2-character replacement ending in "/" is rejected when the FIRST character is not whitespace -- proves SLASH_INSERTION_TEXT is a whitespace-prefix check, not just a length/net-delta check', async () => {
    const { view } = await viewFor('Hello\u00A0')
    // Replaces the nbsp with "y/" -- the SAME size shape as the real
    // Chromium case (1 old char -> 2 new chars, net +1), but "y" is not
    // whitespace. A real paste of "y/" over one selected character must not
    // open a session just because it happens to share a net-length delta
    // with the real browser quirk this fix exists for.
    const tr = view.state.tr.insertText('y/', 6, 7)
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 8)))
    expect(session(view)).toBeNull()
  })

  it('Gate 29 control: a multi-step transaction whose LAST step is a multi-character insertion ending in "/" still does not open -- the widened check does not accept an arbitrary multi-character paste just because it rides alongside another step', async () => {
    const { view } = await viewFor('Hello\u00A0')
    // Same length-preserving first step as above, but the second step
    // inserts "xyz/" (4 characters), not a bare "/" -- no step in this
    // transaction matches the narrow "bare single-character /" shape
    // insertedSingleSlash's loop requires, so this must not open regardless
    // of the incidental first step riding along.
    const tr = view.state.tr.insertText(' ', 6, 7).insertText('xyz/', 7)
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 11)))
    expect(session(view)).toBeNull()
  })

  it('Gate 29 control: a genuine "/" insertion accompanied by an UNRELATED bulk edit elsewhere in the document does not open -- the net text-length-delta guard', async () => {
    // Two paragraphs: the "/" lands in the second, a large unrelated
    // insertion lands in the first, in the SAME transaction. The "/" step
    // alone is the exact bare single-character shape and its own mapped
    // position DOES land at the new cursor -- so without the net-length
    // check, this would incorrectly open. With it, the whole transaction's
    // net text-length delta is +1 (the "/") + 20 (the bulk insertion) = +21,
    // not +1, and it correctly refuses.
    const { view } = await viewFor('para one\n\npara two')
    const secondParaEnd = posOf(view, 'two') + 3 // end of "two", in the STARTING doc
    const tr = view.state.tr.insertText('/', secondParaEnd).insertText('X'.repeat(20), 1) // unrelated bulk edit in the FIRST paragraph
    // The final cursor position is computed via the transaction's OWN
    // mapping (`secondParaEnd` mapped forward through both steps), not
    // hand-added arithmetic -- the second step shifts everything from
    // position 1 onward forward by 20, including where the "/" itself
    // landed, so a manually-added offset would silently point at the wrong
    // position once the bulk insertion is added above it.
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(secondParaEnd))))
    expect(session(view)).toBeNull()
  })

  it('a pure selection move landing right after a PRE-EXISTING "/" does not open a session -- no doc change at all, so there is nothing for the widened check to even inspect', async () => {
    const { view } = await viewFor('and/or')
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, posOf(view, '/or') + 1))
    )
    expect(session(view)).toBeNull()
  })

  it('refuses to open at all when countMatching("") is already 0 -- the "empty filtered list" rule applies symmetrically at open time', async () => {
    const { view } = await viewFor('', noop, () => 0)
    openSlashSessionAt(view, 1)
    expect(session(view)).toBeNull()
  })

  // Final whole-branch review, item 4: tryOpen's own textBetween call used
  // to map EVERY leaf node, hardbreak included, to '￼' (the non-whitespace
  // stand-in correct for e.g. an inline image) -- so a "/" typed
  // immediately after a hardbreak (Shift-Enter) read as "preceded by
  // non-whitespace content" and findSlashTrigger rejected it, the same rule
  // that correctly rejects "and/or". The fix (slashLeafText) maps a
  // hardbreak specifically to '\n', matching that node's own
  // hardbreakSchema `leafText: () => '\n'` declaration
  // (@milkdown/preset-commonmark) -- '\n' IS whitespace per WHITESPACE
  // (slash-query.ts), so a "/" right after one is now correctly treated as
  // "start of a new line," not "mid-word."
  it('opens when the "/" is preceded by a hardbreak (Shift-Enter) -- "\\n" is whitespace, not a non-text-atom stand-in', async () => {
    const { view, editor } = await viewFor('Buy milk')
    editor.action((ctx) => {
      const hardbreakType = hardbreakSchema.type(ctx)
      // Inserted as the paragraph's own first inline child (position 1,
      // right after the paragraph's own open token) -- "Buy milk" shifts one
      // position to the right, so the hardbreak now occupies position 1-2
      // and position 2 sits immediately after it.
      view.dispatch(view.state.tr.insert(1, hardbreakType.create()))
    })
    openSlashSessionAt(view, 2)
    expect(session(view)).toEqual({
      anchorPos: 2,
      query: '',
      queryEnd: 3,
      activeIndex: 0,
      itemCount: PLENTY
    })
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

// === CRITICAL C1 regression, fix round 1 ===
// Before this fix, Enter/Tab were swallow-ONLY: the "Enter and Tab are
// swallowed" test above proves defaultPrevented/bubbling, but nothing
// proved anything downstream of that swallow ever ran -- the palette was
// mouse-only in the shipped app (ArrowDown/Up moved the highlight, Enter/Tab
// visibly did nothing). onChooseActive(activeIndex) is the fix; these tests
// prove the plugin genuinely calls it, with the CURRENT (not stale/initial)
// activeIndex, only for Enter/Tab, and only while a session is open.
describe('slash-plugin: onChooseActive (fix round 1, CRITICAL C1)', () => {
  it('Enter calls onChooseActive with the CURRENT activeIndex, after ArrowDown moved it', async () => {
    const onChooseActive = vi.fn()
    const { view } = await viewFor('', noop, () => 5, onChooseActive)
    openSlashSessionAt(view, 1)
    fireEvent.keyDown(view.dom, { key: 'ArrowDown' })
    fireEvent.keyDown(view.dom, { key: 'ArrowDown' })
    expect(session(view)?.activeIndex).toBe(2)
    fireEvent.keyDown(view.dom, { key: 'Enter' })
    expect(onChooseActive).toHaveBeenCalledTimes(1)
    expect(onChooseActive).toHaveBeenCalledWith(2)
  })

  it('Tab calls onChooseActive too, with the same activeIndex Enter would use', async () => {
    const onChooseActive = vi.fn()
    const { view } = await viewFor('', noop, () => 5, onChooseActive)
    openSlashSessionAt(view, 1)
    fireEvent.keyDown(view.dom, { key: 'ArrowUp' }) // wraps backward: 0 -> 4
    expect(session(view)?.activeIndex).toBe(4)
    fireEvent.keyDown(view.dom, { key: 'Tab' })
    expect(onChooseActive).toHaveBeenCalledTimes(1)
    expect(onChooseActive).toHaveBeenCalledWith(4)
  })

  it('is called with activeIndex 0 when the session was never navigated -- the common "type / then Enter immediately" case', async () => {
    const onChooseActive = vi.fn()
    const { view } = await viewFor('', noop, () => 5, onChooseActive)
    openSlashSessionAt(view, 1)
    fireEvent.keyDown(view.dom, { key: 'Enter' })
    expect(onChooseActive).toHaveBeenCalledWith(0)
  })

  it('is NOT called for any other key -- ArrowDown/Up, Escape, or a printable character', async () => {
    const onChooseActive = vi.fn()
    const { view } = await viewFor('', noop, () => 5, onChooseActive)
    openSlashSessionAt(view, 1)
    fireEvent.keyDown(view.dom, { key: 'ArrowDown' })
    fireEvent.keyDown(view.dom, { key: 'a' })
    fireEvent.keyDown(view.dom, { key: 'Escape' })
    expect(onChooseActive).not.toHaveBeenCalled()
  })

  it('is NOT called when no session is open', async () => {
    const onChooseActive = vi.fn()
    const { view } = await viewFor('', noop, () => 5, onChooseActive)
    fireEvent.keyDown(view.dom, { key: 'Enter' })
    fireEvent.keyDown(view.dom, { key: 'Tab' })
    expect(onChooseActive).not.toHaveBeenCalled()
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

// === IMPORTANT I3 regression, fix round 1 ===
// countMatching used to be `(query: string) => number` -- a pure function of
// the query alone, with no way to apply slash-items.ts's own isEnabled
// (which needs BOTH a live Ctx and the current EditorState). Task 5's real
// wiring is expected to be exactly `(query, state) =>
// filterSlashItems(SLASH_ITEMS, query).filter((item) =>
// item.isEnabled(ctx, state)).length` -- built here for real, against the
// REAL catalogue, rather than a stand-in closure, because a stand-in could
// not have caught the actual desync: in the safety gate's own mid-paragraph
// scenario, math-block and mermaid-diagram are both correctly disabled by
// isEnabled but were STILL counted by the old query-only countMatching,
// so session.itemCount (13) outran what the palette could actually render
// (11) -- ArrowDown 11 times landed on `items[11]`, undefined, with nothing
// aria-selected and Enter picking nothing.
describe('slash-plugin: itemCount agrees with the real, isEnabled-aware catalogue (fix round 1, IMPORTANT I3)', () => {
  it('mid-paragraph destructive scenario: itemCount matches filterSlashItems+isEnabled (11), not the query-only catalogue size (13)', async () => {
    const editor = await createTestEditor('Important prose here and more text', [
      $prose((ctx) => {
        const realCountMatching: CountMatching = (query, state) =>
          filterSlashItems(SLASH_ITEMS, query).filter((item) => item.isEnabled(ctx, state)).length
        return createSlashPlugin(noop, realCountMatching, noop)
      }),
      ...EDITOR_SCHEMA_PLUGINS.flat(),
      ...EDITOR_COMMAND_PLUGINS
    ])
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView

    // Exactly the reviewer-measured HARD REQUIREMENT scenario: "/" typed
    // mid-paragraph, right after the space before "and" -- a session
    // legitimately opens (findSlashTrigger's own "preceded by whitespace"
    // rule) with an empty query.
    openSlashSessionAt(view, posOf(view, 'and'))

    // Independently computed expectation, not trusted from the plugin's own
    // report -- the query-only catalogue size (all 13 items, unfiltered by
    // isEnabled) versus the real, isEnabled-aware count a palette built the
    // way Task 5 is expected to build it would actually render.
    expect(filterSlashItems(SLASH_ITEMS, '').length).toBe(13)
    const reallyEnabled = editor.action(
      (ctx) =>
        filterSlashItems(SLASH_ITEMS, '').filter((item) => item.isEnabled(ctx, view.state)).length
    )
    expect(reallyEnabled).toBe(11) // math-block + mermaid-diagram both disabled here

    // The plugin's own itemCount must agree with the real, rendered count --
    // not the larger, query-only number the pre-fix code would have reported.
    expect(session(view)?.itemCount).toBe(11)
  })

  it('ArrowDown never lands past the last REAL item in that scenario -- the desync this fix closes', async () => {
    // Direct behavioral proof, not just a number: cycling ArrowDown exactly
    // itemCount times must always land back on a valid index (0, by
    // wraparound), never an out-of-range index a stale, too-large itemCount
    // would have permitted.
    const editor = await createTestEditor('Important prose here and more text', [
      $prose((ctx) => {
        const realCountMatching: CountMatching = (query, state) =>
          filterSlashItems(SLASH_ITEMS, query).filter((item) => item.isEnabled(ctx, state)).length
        return createSlashPlugin(noop, realCountMatching, noop)
      }),
      ...EDITOR_SCHEMA_PLUGINS.flat(),
      ...EDITOR_COMMAND_PLUGINS
    ])
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    openSlashSessionAt(view, posOf(view, 'and'))
    const itemCount = session(view)?.itemCount
    expect(itemCount).toBe(11)

    for (let i = 0; i < (itemCount as number); i++) {
      fireEvent.keyDown(view.dom, { key: 'ArrowDown' })
    }
    // Wrapped all the way around exactly once -- back to 0, a real,
    // in-range item, not 11 (which would be `items[11]`, undefined, per the
    // desync this fix closes).
    expect(session(view)?.activeIndex).toBe(0)
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

// === Follow-up 2: undo grouping was unpinned, racing prosemirror-history's
// own 500ms newGroupDelay ===
//
// DECISION (this project's own follow-up report has the full writeup):
// choosing a slash-menu item is a discrete, deliberate UI action -- the same
// category as clicking a toolbar button, not a continuation of free-form
// typing -- so it must be EXACTLY one undo group (the query delete + the
// item's own insertion, atomically), and that group must be
// DETERMINISTICALLY separate from whatever query typing preceded it, never
// merged with it just because the user happened to press Enter quickly.
// `closeHistory` (runSlashItemIn's own fix, see that function's doc comment)
// is the mechanism: stamped on the delete transaction, it forces that
// transaction to start a brand-new prosemirror-history group unconditionally,
// regardless of real elapsed wall-clock time -- the immediately-following
// item transaction then merges FORWARD into that new group via
// prosemirror-history's ordinary adjacency/timing rule (the same rule that
// already merges two back-to-back keystrokes), so the net result is always
// one clean {delete, insert} group.
//
// REJECTED alternative: collapsing the WHOLE gesture (every keystroke of the
// query typing PLUS the delete PLUS the insert) into one group,
// deterministically, regardless of how long the user pauses mid-query. No
// public prosemirror-history primitive can force a MERGE (closeHistory only
// ever forces a SPLIT), and it would be worse UX besides -- see
// runSlashItemIn's own doc comment in slash-plugin.ts for the full argument.
//
// Both tests below use `vi.spyOn(Date, 'now')`, not `vi.useFakeTimers()` --
// prosemirror-state's own `Transaction` constructor sets `this.time =
// Date.now()` (confirmed by reading its source), which is the ONLY thing
// prosemirror-history's grouping math reads, so stubbing just that call
// gives full, deterministic control over the "how much wall-clock time
// passed" question this fix is about, without also stubbing
// setTimeout/rAF/etc. and risking perturbing Milkdown's own internal
// scheduling during editor construction (`vi.useFakeTimers()`'s broader
// blast radius, used elsewhere in this codebase for genuinely timer-driven
// code like useAutosave, is more than this fix needs).
describe('slash-plugin: runSlashItemIn pins undo grouping deterministically (Follow-up 2)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Real production shape, not a synthetic stand-in: open a session, type
  // "head" as the query (matching slash-items.ts's own heading-1 filter
  // bucket), wait `gapMs` of SIMULATED wall-clock time, then choose
  // "Heading 1" via runSlashItemIn with a REAL wrapInHeadingCommand
  // dispatch -- the exact command slash-items.ts's own heading-1 `run`
  // calls (`ctx.get(commandsCtx).call(wrapInHeadingCommand.key, 1)`).
  // Returns the undoDepth delta the choose action itself produced, so both
  // timings can be compared for EQUALITY -- proving the fix removes the
  // timing dependency rather than merely happening to pass at two sampled
  // points.
  async function typeThenChoose(gapMs: number): Promise<{
    view: EditorView
    deltaOnChoose: number
  }> {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const { view, editor } = await viewFor('')
    openSlashSessionAt(view, 1)
    view.dispatch(view.state.tr.insertText('head', view.state.selection.from))

    const depthAfterTyping = editor.action((ctx) => undoDepth(ctx.get(editorViewCtx).state))
    now += gapMs

    const current = session(view)!
    runSlashItemIn(view, current.anchorPos, current.queryEnd, () => {
      editor.action((ctx) => {
        ctx.get(commandsCtx).call(wrapInHeadingCommand.key, 1)
      })
    })

    const depthAfterChoose = editor.action((ctx) => undoDepth(ctx.get(editorViewCtx).state))
    return { view, deltaOnChoose: depthAfterChoose - depthAfterTyping }
  }

  it('choosing IMMEDIATELY after typing (0ms gap, well under the 500ms group delay) opens its OWN new undo group', async () => {
    // Pre-fix, this was the FAILING case: adjacency + near-zero time gap let
    // the delete (and, transitively, the insert) silently merge INTO the
    // still-open typing group, so choosing added no new group at all
    // (delta 0) -- matching the bug report's own "ONE undo returns the
    // document to completely empty."
    const { deltaOnChoose } = await typeThenChoose(0)
    expect(deltaOnChoose).toBe(1)
  })

  it('choosing after a 600ms gap (past the 500ms group delay) ALSO opens exactly one new undo group -- the SAME outcome as the immediate case', async () => {
    const { deltaOnChoose } = await typeThenChoose(600)
    expect(deltaOnChoose).toBe(1)
  })

  it('one undo after choosing -- at EITHER timing -- lands back on the un-deleted query text, never on the pre-typing empty document: delete+insert undo TOGETHER, as one group, separate from typing', async () => {
    for (const gapMs of [0, 600]) {
      const { view } = await typeThenChoose(gapMs)
      // Before undo: the chosen heading was really inserted, and the query
      // text is really gone.
      expect(view.state.doc.firstChild?.type.name).toBe('heading')
      expect(view.state.doc.textContent).toBe('')

      const undone = undo(view.state, view.dispatch)
      expect(undone).toBe(true)

      // Back to "/head" as plain paragraph text -- the query typing itself
      // is a SEPARATE, still-intact undo group that this one undo did not
      // touch, at EITHER timing.
      expect(view.state.doc.firstChild?.type.name).toBe('paragraph')
      expect(view.state.doc.textContent).toBe('/head')
    }
  })
})

// Task 5 addition -- backs SlashMenu's onHover (pointer hover moves the SAME
// plugin-owned activeIndex handleKeyDown's ArrowDown/Up already move, so a
// subsequent keypress continues from wherever the mouse last left it). See
// this function's own doc comment for why it deliberately does NOT
// clamp/validate `index` the way handleKeyDown's own wraparound arithmetic
// does.
describe('slash-plugin: setActiveSlashIndexIn', () => {
  it('moves activeIndex directly to the given value', async () => {
    const { view } = await viewFor('', noop, () => 5)
    openSlashSessionAt(view, 1)
    expect(session(view)?.activeIndex).toBe(0)
    setActiveSlashIndexIn(view, 3)
    expect(session(view)?.activeIndex).toBe(3)
  })

  it('is a no-op when no session is open', async () => {
    const { view } = await viewFor('')
    const dispatchSpy = vi.spyOn(view, 'dispatch')
    setActiveSlashIndexIn(view, 2)
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('is a no-op when `index` already equals the current activeIndex -- no transaction dispatched for genuinely nothing', async () => {
    const { view } = await viewFor('', noop, () => 5)
    openSlashSessionAt(view, 1)
    const dispatchSpy = vi.spyOn(view, 'dispatch')
    setActiveSlashIndexIn(view, 0)
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('dispatches only a doc-unchanged, no-stored-marks transaction -- cannot mark a clean document dirty', async () => {
    const { view } = await viewFor('', noop, () => 5)
    openSlashSessionAt(view, 1)
    const dispatchSpy = vi.spyOn(view, 'dispatch')
    setActiveSlashIndexIn(view, 2)
    expect(dispatchSpy.mock.calls.length).toBeGreaterThan(0)
    for (const [tr] of dispatchSpy.mock.calls) {
      expect(tr.docChanged).toBe(false)
      expect(tr.storedMarksSet).toBe(false)
    }
  })

  it('reports the change through onStateChanged, same as an ArrowDown/Up-triggered move', async () => {
    const seen: Array<SlashSession | null> = []
    const { view } = await viewFor(
      '',
      (next) => seen.push(next),
      () => 5
    )
    openSlashSessionAt(view, 1)
    const countAfterOpen = seen.length
    setActiveSlashIndexIn(view, 4)
    expect(seen.length).toBeGreaterThan(countAfterOpen)
    expect(seen.at(-1)?.activeIndex).toBe(4)
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

// === Follow-up 1: "the palette is effectively invisible to assistive
// technology" ===
// jsdom cannot prove a screen reader announces anything, but it CAN prove
// the DOM contract a real screen reader would read from is actually there:
// the right attributes, on the right element (`view.dom`, the ProseMirror
// contenteditable node -- the one element that genuinely holds DOM focus
// while a session is open, unlike SlashMenu.tsx's own listbox, which never
// does), referencing real ids, updating live as activeIndex changes, and
// fully removed the moment the session closes (a stale aria-expanded="true"
// is worse than none, per this task's own framing). Deliberately does NOT
// assert rendered position/geometry -- jsdom's coordsAtPos lies (see
// CLAUDE.md/this codebase's own established warning), and none of that is
// what this fix is about.
describe('slash-plugin: applySlashA11y sets/clears aria-activedescendant/aria-controls/aria-expanded on view.dom (Follow-up 1)', () => {
  it('sets all three attributes on view.dom the moment a session opens', async () => {
    const { view } = await viewFor('')
    expect(view.dom.hasAttribute('aria-activedescendant')).toBe(false)
    expect(view.dom.hasAttribute('aria-controls')).toBe(false)
    expect(view.dom.hasAttribute('aria-expanded')).toBe(false)

    openSlashSessionAt(view, 1)

    expect(view.dom.getAttribute('aria-expanded')).toBe('true')
    expect(view.dom.getAttribute('aria-controls')).toBe(SLASH_LISTBOX_ID)
    // Freshly opened: activeIndex is always 0 (SlashSession's own tryOpen
    // contract, see this file's "opens at the start of an empty paragraph"
    // test above).
    expect(view.dom.getAttribute('aria-activedescendant')).toBe(slashOptionDomId(0))
  })

  it('updates aria-activedescendant as activeIndex moves via a real ArrowDown -- never a stale, mount-time value', async () => {
    const { view } = await viewFor('', undefined, () => 3)
    openSlashSessionAt(view, 1)
    expect(view.dom.getAttribute('aria-activedescendant')).toBe(slashOptionDomId(0))

    fireEvent.keyDown(view.dom, { key: 'ArrowDown' })
    expect(session(view)?.activeIndex).toBe(1)
    expect(view.dom.getAttribute('aria-activedescendant')).toBe(slashOptionDomId(1))

    fireEvent.keyDown(view.dom, { key: 'ArrowDown' })
    expect(session(view)?.activeIndex).toBe(2)
    expect(view.dom.getAttribute('aria-activedescendant')).toBe(slashOptionDomId(2))
  })

  it("updates aria-activedescendant when the index moves via setActiveSlashIndexIn (SlashMenu's own onHover path), not just via keyboard", async () => {
    const { view } = await viewFor('', undefined, () => 5)
    openSlashSessionAt(view, 1)
    setActiveSlashIndexIn(view, 3)
    expect(view.dom.getAttribute('aria-activedescendant')).toBe(slashOptionDomId(3))
  })

  it('removes all three attributes the moment the session closes (Escape) -- a stale aria-expanded is worse than none', async () => {
    const { view } = await viewFor('')
    openSlashSessionAt(view, 1)
    expect(view.dom.hasAttribute('aria-expanded')).toBe(true)

    closeSlashIn(view)

    expect(view.dom.hasAttribute('aria-activedescendant')).toBe(false)
    expect(view.dom.hasAttribute('aria-controls')).toBe(false)
    expect(view.dom.hasAttribute('aria-expanded')).toBe(false)
  })

  it('removes all three attributes when the session closes because the query narrowed to an empty match list -- not just on an explicit Escape/blur', async () => {
    const countMatching: CountMatching = (query) => (query === '' ? 5 : 0)
    const { view } = await viewFor('', undefined, countMatching)
    openSlashSessionAt(view, 1)
    expect(view.dom.hasAttribute('aria-expanded')).toBe(true)

    view.dispatch(view.state.tr.insertText('z', view.state.selection.from))
    expect(session(view)).toBeNull()
    expect(view.dom.hasAttribute('aria-activedescendant')).toBe(false)
    expect(view.dom.hasAttribute('aria-controls')).toBe(false)
    expect(view.dom.hasAttribute('aria-expanded')).toBe(false)
  })

  it('removes all three attributes on editor destroy -- a remount cannot inherit a stale, still-expanded contenteditable node', async () => {
    const { view, editor } = await viewFor('')
    openSlashSessionAt(view, 1)
    expect(view.dom.hasAttribute('aria-expanded')).toBe(true)

    await editor.destroy()

    expect(view.dom.hasAttribute('aria-activedescendant')).toBe(false)
    expect(view.dom.hasAttribute('aria-controls')).toBe(false)
    expect(view.dom.hasAttribute('aria-expanded')).toBe(false)
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
