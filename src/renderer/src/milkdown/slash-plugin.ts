import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction
} from '@milkdown/prose/state'
import { ReplaceStep } from '@milkdown/prose/transform'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view'
import { closeHistory } from '@milkdown/prose/history'
import type { Node as ProseNode } from '@milkdown/prose/model'
import { findSlashTrigger, MAX_QUERY_LENGTH } from '../lib/slash-query'
import { SLASH_LISTBOX_ID, slashOptionDomId } from '../lib/slash-a11y'

// The ProseMirror-plugin half of the slash-command menu -- structurally a
// sibling of find-plugin.ts (read that file's own header first; every rule
// documented there about WHY -- notify React from view.update, never apply;
// never call view.focus(); a meta-only transaction must not dirty the
// document -- applies here verbatim and isn't re-derived below). The one
// deliberate departure, per the design doc: Find's activeIndex lives in
// React and round-trips through a two-way convergence loop (push query+
// activeIndex in, plugin recomputes, report count+clamped-index out, which
// can re-trigger the push -- CLAUDE.md documents it settling in "at most two
// rounds"). Here activeIndex lives IN THE PLUGIN, because handleKeyDown has
// to move it synchronously on every ArrowDown/ArrowUp regardless -- keeping
// it here removes that loop by construction instead of making it converge.
//
// This file deliberately knows NOTHING about the item catalogue
// (slash-items.ts, Task 4) or filterSlashItems (slash-filter.ts, Task 1) --
// forcing that dependency here would mean every future catalogue change
// touches this file too. Instead, whoever DOES hold the filtered list
// (Task 5's MilkdownEditor.tsx mount effect, which has the live Ctx a
// catalogue lookup needs) supplies a `countMatching(query, state)` closure
// AND an `onChooseActive(activeIndex)` closure at construction time -- see
// createSlashPlugin's own comment for why this is dependency injection
// rather than an external report channel (an earlier version of this file
// used the latter for itemCount; fix round 1 replaced it after review found
// two real, measured costs: a stale-count window between a query changing
// and the next report, and silent failure -- arrows permanently inert, the
// empty-list close never firing -- if a caller ever forgot to report).
// `onChooseActive` closes the equivalent gap for CHOOSING an item -- see its
// own doc comment (fix round 1, CRITICAL C1) for the real bug it fixes:
// Enter/Tab were previously swallowed with nothing behind them at all.

/** A live slash-command session: the palette is open and tracking a query. */
export interface SlashSession {
  /** Document position of the triggering "/" character itself (not after it). */
  anchorPos: number
  /** Everything after the "/" up to the cursor -- what the palette filters on. */
  query: string
  /**
   * Document position of the RIGHT edge of the query's own tracked content,
   * as of the last update -- i.e. where the cursor was the last time this
   * session was recomputed. Exists ONLY to detect the cursor moving forward
   * past it (see advanceSession's own header comment for the real, measured
   * bug this closes): `query` itself is still derived as
   * `doc.textBetween(anchorPos + 1, selection.from)`, exactly as before.
   * Never read outside this file -- it is bookkeeping for advanceSession,
   * not part of the palette's own display contract -- but left on the
   * public interface rather than hidden in module state, since a session's
   * entire shape is otherwise a plain, inspectable value.
   */
  queryEnd: number
  /**
   * Index into the CURRENTLY FILTERED item list. Lives here, not in React --
   * see this file's own header comment for why. Recomputed alongside `query`
   * on every change (see advanceSession), clamped into [0, itemCount) so a
   * query that narrows the list can never leave this pointing past the end.
   */
  activeIndex: number
  /**
   * How many items currently match `query`, computed via the injected
   * countMatching(query) in the SAME apply that changes the query -- never
   * stale, never independently "not yet known" the way an external-report
   * design would leave it (see this file's header comment). A session
   * cannot exist with itemCount <= 0: both tryOpen and advanceSession close
   * (or refuse to open) outright the moment countMatching returns <= 0,
   * which is this file's entire implementation of the design doc's "close
   * on empty filtered list".
   */
  itemCount: number
}

export interface SlashPluginState {
  session: SlashSession | null
  decorations: DecorationSet
}

// Fix round 1, IMPORTANT I3: widened from `(query: string) => number` to also
// receive the live EditorState. The catalogue's own "which items are
// currently offered" question (slash-items.ts's isEnabled) is NOT a pure
// function of the query string alone -- it also depends on document
// structure (is the target block empty once the query is removed; is the
// cursor inside a table cell). Task 5's real `countMatching` is expected to
// be `(query, state) => filterSlashItems(SLASH_ITEMS, query).filter((item) =>
// item.isEnabled(ctx, state)).length` (ctx captured by closure at
// construction) -- and BOTH call sites below already have the relevant
// EditorState in scope (`newState`), so this is a threading change, not new
// machinery. Before this fix, `countMatching` only ever saw the query, so
// there was no way for it to apply isEnabled filtering AT ALL -- it was
// structurally forced to report the LARGER, query-only catalogue size
// (filterSlashItems alone), while the palette itself (built with access to
// both ctx and state) would only ever RENDER the smaller, isEnabled-filtered
// subset. This plugin's own activeIndex wraps against the larger, wrong
// number it was fed, so arrow-key navigation could walk past the end of the
// shorter, actually-rendered list -- exactly the "13 counted vs 11
// rendered, ArrowDown 11 times highlights nothing" desync a code review
// caught, in this feature's own mid-paragraph safety-gate scenario. This
// file still takes no direct dependency on the item catalogue or on Ctx
// (see this file's header) -- `state` is exactly what tryOpen/advanceSession
// already had in hand for their own use, just also handed to the injected
// callback now.
export type CountMatching = (query: string, state: EditorState) => number

// Fix round 1, CRITICAL C1: Enter/Tab were swallow-ONLY (this file's own
// header called that out as deliberate -- "this file has no catalogue to
// run one from" -- but the caller this comment pointed at, useSlashMenu.ts,
// never actually implemented the other half). Net effect: the palette was
// mouse-only -- ArrowDown/Up moved the highlight, but Enter/Tab did nothing
// visible at all, no block inserted, no paragraph split, no feedback.
// `onChooseActive(activeIndex)` is the fix: called from the Enter/Tab
// branch with the session's OWN activeIndex, right before `return true`,
// so choosing-by-keyboard reads the exact same plugin-owned pointer
// ArrowDown/Up already moves -- no separate, potentially-stale React copy
// of "which item is active" is ever consulted. This file still resolves
// nothing about WHICH item that index maps to (see this file's header for
// why it stays catalogue-free) -- the caller (MilkdownEditor.tsx's mount
// effect) is expected to re-derive the enabled item list from the LIVE
// state in the SAME synchronous call this fires from, exactly the way
// countMatching already does, so the index and the list it indexes into
// can never disagree.
export type OnChooseActive = (activeIndex: number) => void

export const slashPluginKey = new PluginKey<SlashPluginState>('pagedownSlash')

const EMPTY_STATE: SlashPluginState = { session: null, decorations: DecorationSet.empty }

// Whitespace anywhere in a LIVE query closes the session (design doc: "Close
// on: ... whitespace in the query"). Deliberately a bare inline regex, not an
// import from slash-query.ts -- that file's own WHITESPACE is private, and
// unlike MAX_QUERY_LENGTH (a genuine magic-number bound worth sharing one
// definition of) this is a one-character-class literal with nothing to drift
// out of sync; findSlashTrigger's own backward-scan ALGORITHM is what must
// not be re-derived here (see this file's header and advanceSession below),
// not this regex.
const WHITESPACE = /\s/

// Leaf-text stand-in for tryOpen's own textBetween call below ONLY --
// advanceSession's own call already passes a bare '\n' for every leaf
// (see its own comment for why that one call is different: it scans the
// WHOLE DOCUMENT, where a real block boundary is a genuine possibility).
// Every non-text inline atom maps to '￼' (OBJECT REPLACEMENT CHARACTER,
// non-whitespace -- correct for e.g. an image, so a "/" typed immediately
// after one is treated as "preceded by non-whitespace," the same way
// "and/or" is) EXCEPT a hardbreak, which maps to '\n' instead, matching
// that node's own declared semantics
// (@milkdown/preset-commonmark's hardbreakSchema sets `leafText: () =>
// '\n'` on its own node spec).
//
// Fix round (final review): before this fix, tryOpen passed the bare '￼'
// literal for EVERY leaf, hardbreak included. Measured: insert a hardbreak
// (Shift-Enter), then type "/" right after it -- findSlashTrigger's own
// backward scan (slash-query.ts) requires the "/" to be preceded by
// whitespace or the start of the block, and '￼' is deliberately
// non-whitespace, so a "/" immediately after a hardbreak read as mid-word
// (the same rule that correctly rejects "and/or") and no session opened at
// all, silently -- even though a hardbreak reads visually as "the start of
// a new line," exactly the gesture this feature's own trigger rule means to
// welcome.
function slashLeafText(leafNode: ProseNode): string {
  return leafNode.type.name === 'hardbreak' ? '\n' : '￼'
}

// Meta shapes this plugin's own state.apply reads via tr.getMeta(key).
// Private to this module -- every external caller goes through the
// EditorView-taking helpers at the bottom of this file (openSlashSessionAt /
// closeSlashIn / runSlashItemIn), mirroring how find-plugin.ts's
// FindStateInput is the one exception (applyFindState takes it as a real
// parameter) rather than the rule. No 'setItemCount' variant any more (fix
// round 1 removed it along with setSlashItemCount) -- itemCount is now
// always computed inline from the injected countMatching, never pushed in
// from outside as a separate meta transaction.
type SlashMeta = { type: 'close' } | { type: 'setActiveIndex'; activeIndex: number }

function buildDecorations(doc: ProseNode, session: SlashSession): DecorationSet {
  const to = session.anchorPos + 1 + session.query.length
  return DecorationSet.create(doc, [
    Decoration.inline(session.anchorPos, to, { class: 'pagedown-slash-query' })
  ])
}

function withSession(doc: ProseNode, session: SlashSession): SlashPluginState {
  return { session, decorations: buildDecorations(doc, session) }
}

function sameSession(a: SlashSession | null, b: SlashSession | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.anchorPos === b.anchorPos &&
    a.query === b.query &&
    a.queryEnd === b.queryEnd &&
    a.activeIndex === b.activeIndex &&
    a.itemCount === b.itemCount
  )
}

// Follow-up 1 fix (CLAUDE.md's "Slash command menu" section: "the palette is
// effectively invisible to assistive technology"). Two problems compounded
// to make the a11y markup that shipped with the feature buy nothing:
//   1. `aria-activedescendant` sat on SlashMenu.tsx's own listbox `<div>`,
//      but that element NEVER holds DOM focus -- focus deliberately stays
//      on the ProseMirror contenteditable node the whole time a session is
//      open (typing has to keep extending the query), so the listbox is
//      never the "element with DOM focus" ARIA requires
//      aria-activedescendant to live on. An attribute on the wrong element
//      is inert, not merely incomplete.
//   2. Options were nested inside an untyped section `<div>`, so they
//      weren't OWNED by the listbox at all -- ARIA's listbox pattern
//      requires every child a listbox owns to carry `option` or `group`.
// Fixed by moving this relationship onto `view.dom` -- the ProseMirror
// node that genuinely holds focus -- rather than by patching either
// symptom individually. Applied HERE, inside the plugin's own `view()`
// spec, not threaded out through onStateChanged/useSlashMenu.ts/
// MilkdownEditor.tsx: this function already has direct, synchronous access
// to `view.dom` on every update, and the session state it needs
// (activeIndex) is exactly what it already tracks -- no new prop, ref, or
// store round trip is needed to reach the one DOM node this whole fix is
// about.
//
// aria-activedescendant is keyed on `session.activeIndex` alone (via
// slashOptionDomId, lib/slash-a11y.ts), NOT on any item id -- deliberately,
// preserving this file's own "knows nothing about the item catalogue"
// architecture (see this file's header comment): SlashSession.activeIndex
// is BY DEFINITION "an index into the currently filtered [and
// isEnabled-filtered] item list" (see that field's own doc comment), the
// exact array SlashMenu.tsx renders in order -- so the plugin can compute a
// correct, always-in-sync id purely from its own state, with no Ctx/item
// lookup required. See lib/slash-a11y.ts's own header for why a
// catalogue-aware id (keyed on item.id) was rejected.
//
// `session: null` clears all three attributes rather than merely leaving
// them stale -- per this task's own framing, "a stale aria-expanded=true is
// worse than none": a screen reader that still believes a collapsed
// listbox exists and is expanded is actively misleading, not just
// unhelpful. `view.dom.removeAttribute` on an element that never had the
// attribute (the common "session was already closed" case, reached on
// every ordinary keystroke once no session is open) is a harmless no-op,
// so this needs no "was it actually set" guard of its own.
function applySlashA11y(view: EditorView, session: SlashSession | null): void {
  if (!session) {
    view.dom.removeAttribute('aria-activedescendant')
    view.dom.removeAttribute('aria-controls')
    view.dom.removeAttribute('aria-expanded')
    return
  }
  view.dom.setAttribute('aria-expanded', 'true')
  view.dom.setAttribute('aria-controls', SLASH_LISTBOX_ID)
  view.dom.setAttribute('aria-activedescendant', slashOptionDomId(session.activeIndex))
}

// A step's slice qualifies as "the / insertion" iff its content is ONE bare,
// unopened text node whose text is zero-or-more whitespace characters
// followed by exactly one "/" -- see insertedSingleSlash's own header for
// why the whitespace prefix is there (it is not optional padding, it is
// what the real, measured Chromium transaction shape requires).
const SLASH_INSERTION_TEXT = /^\s*\/$/

// True iff `tr` genuinely inserted one literal "/" character immediately
// before where the cursor now sits, and nothing else of consequence. Typing
// "/" is the one gesture this feature triggers on, matching the design doc's
// own framing ("Open only when: a transaction inserted a single /") -- a
// paste, an IME composition, or a bulk programmatic edit must never open a
// session, and still don't (see the checks below).
//
// !!! WIDENED, Gate 29 fix -- a real bug jsdom cannot reproduce, only found
// by driving REAL Chromium (phase0/gate29-slash-menu.spec.ts's own
// investigation), and the widening below is ITSELF the product of a second
// round of real-app measurement, not the first guess !!! The ORIGINAL
// version of this function required `tr` to be EXACTLY one ReplaceStep whose
// slice was a bare single-character "/" -- nothing else, ever. That is
// correct for typing "/" at the start of an empty paragraph or after an
// ALREADY-EXISTING space, but real Chromium does not represent "type a
// space, then type / immediately after it" that way: contenteditable stores
// a genuinely TRAILING space as `&nbsp;` (so it isn't collapsed away by
// normal whitespace rules), and typing the very next character converts
// that nbsp back to a plain space as part of the SAME DOM mutation that
// inserts the new character -- so typing "text /" (the single most common
// way to invoke a slash menu) opened nothing.
//
// THE FIRST FIX ATTEMPT HERE WAS WRONG, AND CAUGHT BY THIS GATE ITSELF, NOT
// BY REASONING ALONE -- worth recording so the next person doesn't repeat
// the same guess. It assumed the nbsp swap and the "/" insertion would be
// TWO separate steps (a length-preserving replace, plus a bare single-
// character insert) and widened the step-matching loop to allow an extra
// incidental step alongside a bare "/" step. Rerunning the ACTUAL gate
// against real Chromium (with temporary diagnostic logging of `tr.steps`
// added, then removed once this was understood) showed the real transaction
// is a SINGLE ReplaceStep whose slice is one text node containing " /" (a
// space THEN the slash) as ONE unit -- replacing the 1-character nbsp
// range with that 2-character run. Chromium's own DOM diff, not
// ProseMirror's, decided where the edit boundary falls, and it did not
// isolate the "/" into its own step at all. The two-separate-steps guess
// was never observed in practice; SLASH_INSERTION_TEXT's whitespace-prefix
// pattern is what the real, captured transaction needed instead.
//
// The fix inspects what the transaction actually DID, rather than how many
// steps it took to do it, via checks that together rule out exactly the
// same things the old single-step check ruled out:
//
//   1. The character immediately before the FINAL cursor position really is
//      "/" (checked against `tr.doc`, the resulting document -- indifferent
//      to step count).
//   2. Net TEXT-LENGTH delta across the whole transaction is exactly +1
//      (`tr.doc.textContent.length` vs `tr.before.textContent.length`).
//      This is what still rejects a real multi-character paste, even a
//      single-step one ending in "/": it changes total text length by MORE
//      than one, however many steps it takes.
//   3. There EXISTS a step whose slice is ONE bare, unopened text node
//      matching SLASH_INSERTION_TEXT (whitespace* then "/") -- deliberately
//      NOT "any text ending in /", which would accept an arbitrary paste
//      replacing a selection (e.g. pasting "xyz/" over selected text) --
//      and whose own inserted content maps FORWARD (through every
//      subsequent step's own mapping, `tr.mapping.slice(i + 1)`) to land
//      EXACTLY at the final cursor position. Combined with check #2, this
//      step alone already accounts for the ENTIRE transaction's net +1 (a
//      leading-whitespace-then-/ run replacing a same-or-smaller old range
//      nets to exactly +1 only when that whitespace prefix is itself a
//      1-for-1 restatement of what was already there, e.g. nbsp-for-nbsp or
//      nbsp-for-space) -- so no OTHER step can be adding real content
//      anywhere else in the document, and this is also the "genuinely
//      inserted, not merely pre-existing content the cursor moved next to"
//      proof: a pure cursor move has no ReplaceStep at all, so this loop
//      finds nothing and returns false regardless of what the cursor landed
//      next to.
function insertedSingleSlash(tr: Transaction): boolean {
  if (!tr.docChanged) return false
  const { selection } = tr
  if (!(selection instanceof TextSelection) || !selection.empty) return false
  const pos = selection.from
  if (pos < 1) return false
  if (tr.doc.textBetween(pos - 1, pos, '￼', '￼') !== '/') return false

  const oldLength = tr.before.textContent.length
  const newLength = tr.doc.textContent.length
  if (newLength !== oldLength + 1) return false

  for (let i = 0; i < tr.steps.length; i++) {
    const step = tr.steps[i]
    if (!(step instanceof ReplaceStep)) continue
    const { slice } = step
    // openStart/openEnd > 0 would mean the slice is a fragment of a larger
    // structure (e.g. half of a split node) rather than a bare inserted leaf
    // -- not reachable for a single typed character, kept as an explicit
    // guard rather than assumed.
    if (slice.openStart !== 0 || slice.openEnd !== 0) continue
    if (slice.content.childCount !== 1) continue
    const node = slice.content.firstChild
    if (!node || !node.isText || !SLASH_INSERTION_TEXT.test(node.text ?? '')) continue
    // This step's own inserted run ends at `step.from + slice.content.size`
    // in the document AS IT STOOD immediately after this one step
    // (openStart/openEnd are both 0, so there is no open-depth adjustment to
    // account for). Map that position FORWARD through every step that came
    // after it to land in the FINAL document's own coordinates, and require
    // it to be exactly where the cursor now sits.
    const end = step.from + slice.content.size
    if (tr.mapping.slice(i + 1).map(end) === pos) return true
  }
  return false
}

// Whether a brand-new session should open, given the transaction just
// inserted a single "/" (checked by the caller). Every condition here is the
// design doc's own "Open only when" list, checked in the SAME order that
// list states them, so a future edit can diff against it directly:
//   1. a transaction inserted a single "/" -- checked by the caller
//   2. selection is empty and a TextSelection
//   3. parent is a paragraph and not type.spec.code
//   4. not inside an inlineCode mark
//   5. findSlashTrigger accepts the text before the cursor
//   6. countMatching(query) is > 0 -- see this function's own itemCount
//      comment below; not literally in the design doc's list (query is
//      always '' here, see findSlashTrigger's own invariant), but the same
//      "close on empty filtered list" rule applies symmetrically at open
//      time so a session can never exist with nothing to show.
function tryOpen(
  newState: EditorState,
  prev: SlashPluginState,
  countMatching: CountMatching
): SlashPluginState {
  const { selection, schema, doc } = newState
  if (!(selection instanceof TextSelection) || !selection.empty) return prev

  const $from = selection.$from
  const paragraphType = schema.nodes.paragraph
  if (!paragraphType || $from.parent.type !== paragraphType) return prev
  // Defensive, not reachable today: a node registered under the name
  // "paragraph" never also sets `code: true` in its own spec (confirmed by
  // reading @milkdown/preset-commonmark's paragraphSchema directly -- only
  // codeBlockSchema does). Kept explicit anyway, matching the design doc's
  // own two-part phrasing ("parent is a paragraph AND not type.spec.code"),
  // as a guard against a future schema change rather than an assumption.
  if ($from.parent.type.spec.code) return prev

  const inlineCodeType = schema.marks.inlineCode
  // Same "marks at the cursor" idiom selection-plugin.ts's own markActive
  // uses for a collapsed selection: storedMarks (what the NEXT typed
  // character would carry) falls back to $from.marks() (what the character
  // just typed -- the "/" itself -- actually carries) when there are no
  // stored marks overriding it.
  if (inlineCodeType && inlineCodeType.isInSet(newState.storedMarks || $from.marks())) return prev

  // slashLeafText (this file's own header, just above WHITESPACE) maps a
  // hardbreak to '\n' and every other leaf (e.g. an image) to '￼' -- see
  // its own doc comment for the real, measured bug this fixes.
  const textBeforeCursor = $from.parent.textBetween(0, $from.parentOffset, '￼', slashLeafText)
  const trigger = findSlashTrigger(textBeforeCursor)
  if (!trigger) return prev

  // trigger.query is always '' here in practice (findSlashTrigger's backward
  // scan can only have matched the "/" this transaction JUST inserted as the
  // very start of its run, since nothing follows it yet), but itemCount is
  // still computed from trigger.query rather than hardcoded '' so this stays
  // correct even if that invariant ever changes. `newState` is passed
  // through so an isEnabled-aware countMatching sees the SAME document a
  // real choice would run against (see CountMatching's own doc comment).
  const itemCount = countMatching(trigger.query, newState)
  if (itemCount <= 0) return prev

  const anchorPos = $from.start() + trigger.slashOffset
  return withSession(doc, {
    anchorPos,
    query: trigger.query,
    queryEnd: selection.from,
    activeIndex: 0,
    itemCount
  })
}

// Recomputes an ALREADY-OPEN session against a transaction that changed the
// document and/or selection. Per this file's own header and the design doc:
// the query is DERIVED from the anchor position via doc.textBetween, never
// by re-running findSlashTrigger's backward scan -- that scan finds "the
// nearest /", which is exactly wrong here (it would let the cursor silently
// re-anchor to an unrelated LATER "/" typed elsewhere in the same
// paragraph, rather than correctly closing this session because the cursor
// left its range).
//
// !!! queryEnd / the RIGHT edge -- fix round 1, a real, measured bug !!!
// The original version of this function enforced only the LEFT edge
// (`selection.from <= anchorPos` closes) and derived the query purely from
// wherever the cursor currently sat, with no boundary on how far right it
// could go. That leaves the right edge undefined BY the cursor itself, so
// it can never be "crossed": open a session before pre-existing text ("Hello
// /world", session anchored before "world"), press ArrowRight once (NOT
// intercepted by handleKeyDown -- only ArrowDown/Up are, for the item list --
// so it reaches ProseMirror's own cursor movement), and the query silently
// becomes "w", annexing a character that was never typed into it. Choosing
// an item then deletes that annexed text along with the real query, which
// is exactly the data loss the anchor-based design (CLAUDE.md/design doc:
// "yields the exact [from, to) range to delete") exists to prevent.
// `queryEnd` is the fix: it tracks where the query's own content ended as of
// the LAST update, mapped forward through each new transaction the same way
// `anchorPos` is. Typing AT queryEnd extends it forward (`Mapping.map`'s
// default assoc=1 means a position exactly at an insertion point maps to
// AFTER the inserted content), so ordinary typing is unaffected. But a
// transaction that only moves the selection (assoc doesn't matter --
// there's no step at all, so the mapping is the identity) leaves the mapped
// `queryEnd` exactly where it was, and if the new cursor position is past
// that, the session closes -- the cursor left the query's own tracked
// range, which is "selection leaving the anchored range" per the design
// doc's own close condition, now enforced on BOTH edges instead of one.
function advanceSession(
  session: SlashSession,
  tr: Transaction,
  newState: EditorState,
  countMatching: CountMatching
): SlashPluginState {
  const anchorPos = tr.mapping.map(session.anchorPos)
  const prevEnd = tr.mapping.map(session.queryEnd)
  const { doc, selection } = newState

  if (anchorPos < 0 || anchorPos + 1 > doc.content.size) return EMPTY_STATE
  if (!(selection instanceof TextSelection) || !selection.empty) return EMPTY_STATE
  // LEFT edge: the cursor must sit AT OR AFTER the position right after the
  // "/" -- otherwise it has moved onto or before the trigger character
  // itself (Left arrow, Home, a click before the "/").
  if (selection.from <= anchorPos) return EMPTY_STATE
  // RIGHT edge: the cursor must not have moved past where the query's own
  // tracked content ended, mapped forward through this transaction. See
  // this function's own header comment for the real bug this closes.
  if (selection.from > prevEnd) return EMPTY_STATE
  if (doc.textBetween(anchorPos, anchorPos + 1) !== '/') return EMPTY_STATE

  // '\n' as both separators here (unlike tryOpen's '￼' above): this
  // scans the WHOLE DOCUMENT between two absolute positions, where a real
  // block boundary is a genuine possibility (the selection jumped to a
  // different paragraph) and must read as whitespace so the very next check
  // closes the session, rather than as an inert placeholder character.
  const query = doc.textBetween(anchorPos + 1, selection.from, '\n', '\n')
  if (WHITESPACE.test(query) || query.length > MAX_QUERY_LENGTH) return EMPTY_STATE

  // itemCount is recomputed HERE, in the same apply that just derived the
  // new query -- not reported in later from outside (fix round 1 removed
  // that design; see this file's header). itemCount <= 0 closes outright,
  // which is this file's entire implementation of "close on empty filtered
  // list": synchronous, and structurally impossible to forget to call.
  // `newState` (not the pre-transaction state) is passed through, matching
  // tryOpen's own call -- an isEnabled-aware countMatching must see the
  // document as it stands AFTER this transaction, the same document the
  // palette itself is about to render against.
  const itemCount = countMatching(query, newState)
  if (itemCount <= 0) return EMPTY_STATE

  return withSession(doc, {
    anchorPos,
    query,
    queryEnd: selection.from,
    itemCount,
    // A changed query invalidates whatever the old activeIndex pointed at --
    // the filtered list itself just changed, so land back on the first item
    // rather than an index that may no longer make sense. An unchanged
    // query (e.g. this transaction only moved the selection within the same
    // range) keeps the user's current pick, still defensively re-clamped in
    // case countMatching is not perfectly stable across calls.
    activeIndex:
      query === session.query ? (session.activeIndex < itemCount ? session.activeIndex : 0) : 0
  })
}

// Constructed per MOUNT (in MilkdownEditor.tsx, alongside findProse /
// selectionProse / dropImageProse, Task 5), because it closes over
// per-mount callbacks -- same reasoning as createFindPlugin/
// createSelectionPlugin.
//
// `countMatching(query, state)` is supplied by the caller (Task 5's
// MilkdownEditor.tsx mount effect, which owns the item catalogue,
// slash-filter.ts's filterSlashItems, AND the live Ctx isEnabled needs) and
// is expected to be `(query, state) => filterSlashItems(SLASH_ITEMS,
// query).filter((item) => item.isEnabled(ctx, state)).length` or
// equivalent -- see CountMatching's own doc comment above for why `state`
// was added in fix round 1 (an isEnabled-aware count is NOT a pure function
// of the query string alone). `onChooseActive(activeIndex)` is the SAME
// caller's second, symmetric obligation -- see OnChooseActive's own doc
// comment above (fix round 1, CRITICAL C1) for why Enter/Tab were dead keys
// without it. This file still takes no dependency on the catalogue or on
// slash-filter.ts/Ctx itself (see this file's header for why); dependency
// injection is the seam that keeps that true while still letting itemCount
// be computed synchronously, in the SAME apply that changes the query,
// rather than reported in later via a separate meta transaction (fix round
// 1's removed setSlashItemCount) -- which review found two real costs for:
// a stale-count window between the query changing and the next external
// report, and silent failure (arrows permanently inert, the empty-list
// close never firing) if a future caller simply forgot to call the
// reporter.
export function createSlashPlugin(
  onStateChanged: (session: SlashSession | null) => void,
  countMatching: CountMatching,
  onChooseActive: OnChooseActive
): Plugin {
  return new Plugin<SlashPluginState>({
    key: slashPluginKey,
    state: {
      init: () => EMPTY_STATE,
      apply: (tr, prev, _oldState, newState) => {
        const meta = tr.getMeta(slashPluginKey) as SlashMeta | undefined

        if (meta?.type === 'close') {
          return prev.session ? EMPTY_STATE : prev
        }

        if (prev.session) {
          if (meta?.type === 'setActiveIndex') {
            return withSession(newState.doc, { ...prev.session, activeIndex: meta.activeIndex })
          }
          // Nothing moved: no doc change and no selection change (a meta-only
          // transaction from an unrelated plugin, or one with no meta and no
          // effect at all). Mirrors find-plugin.ts's identical early return.
          if (!tr.docChanged && !tr.selectionSet) return prev
          return advanceSession(prev.session, tr, newState, countMatching)
        }

        // No open session: the only way one can start is a transaction that
        // itself inserted a single "/" -- anything else (an unrelated edit
        // elsewhere, a selection-only transaction) has nothing to open.
        if (!tr.docChanged || !insertedSingleSlash(tr)) return prev
        return tryOpen(newState, prev, countMatching)
      }
    },
    props: {
      decorations: (state) => slashPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
      // Verified empirically under jsdom (not assumed -- see task-3-report.md's
      // spike), unlike prosemirror-keymap (CLAUDE.md's documented jsdom gap for
      // Mod-b/etc.): a real DOM keydown dispatched via fireEvent DOES reach a
      // $prose plugin's own handleKeyDown here, and returning `true` triggers
      // ProseMirror's own preventDefault() call -- but NEVER stopPropagation(),
      // confirmed by the same spike -- which is exactly why Escape below calls
      // it explicitly. EVERYTHING not explicitly matched below falls through
      // to `default: return false` -- this is what lets ordinary printable
      // characters keep extending the query, and it is directly tested (fix
      // round 1: `default: return true` -- swallowing every keystroke,
      // including plain letters -- previously passed all 32 existing tests,
      // because none of them dispatched a real keydown for a printable
      // character and checked event.defaultPrevented).
      handleKeyDown: (view, event) => {
        const session = slashPluginKey.getState(view.state)?.session
        if (!session) return false

        switch (event.key) {
          case 'ArrowDown':
          case 'ArrowUp': {
            const delta = event.key === 'ArrowDown' ? 1 : -1
            const { itemCount, activeIndex } = session
            // Wraps in both directions via a positive-remainder modulo.
            // itemCount is always > 0 here -- a session cannot exist with
            // itemCount <= 0 (both tryOpen and advanceSession refuse/close
            // on that), so there is no divide-by-zero case to guard left
            // over from the earlier external-report design.
            const next = (activeIndex + delta + itemCount) % itemCount
            view.dispatch(
              view.state.tr.setMeta(slashPluginKey, {
                type: 'setActiveIndex',
                activeIndex: next
              } satisfies SlashMeta)
            )
            return true
          }
          case 'Enter':
          case 'Tab':
            // Fix round 1, CRITICAL C1: this used to be swallow-ONLY, with
            // no way to actually choose an item by keyboard at all -- see
            // OnChooseActive's own doc comment for the full writeup of that
            // bug and why this call is the fix. `session.activeIndex` is
            // read HERE, synchronously, from this file's own plugin state --
            // not from any React-mirrored copy that could have drifted
            // (there is no window for it to: ArrowDown/Up's own dispatch
            // above and this handler both run inside the same
            // handleKeyDown, and nothing else in this plugin's own state can
            // move activeIndex between two keystrokes).
            //
            // Returning true is what stops the underlying keymap's Enter ->
            // splitBlock/splitListItem/goToNextTableCell from ever firing
            // while a session is open, per the design doc's "Keys
            // intercepted while open" section -- that ordering is structural
            // (see the design doc's "Keymap priority" section), not
            // something tuned here. Directly proven, not just asserted:
            // this file's own test suite fires a real Enter with no session
            // open (the paragraph really splits, childCount 1 -> 2) as the
            // control for the same real Enter with a session open (it does
            // not split, childCount stays 1).
            onChooseActive(session.activeIndex)
            return true
          case 'Escape':
            // stopPropagation is load-bearing, not defensive: ProseMirror's
            // own dispatchKeyDown calls preventDefault() for us because we
            // return true, but never stopPropagation() (verified by spike,
            // see this handler's own header comment) -- without this, the
            // same Escape keystroke would keep bubbling to
            // useFindShortcuts's bubble-phase `window` listener and close
            // Find at the same moment it closes this session.
            event.stopPropagation()
            closeSlashIn(view)
            return true
          default:
            return false
        }
      },
      handleDOMEvents: {
        // Design doc: "Close on: ... blur". Unconditional -- closeSlashIn
        // itself no-ops when nothing is open, so there's no need to check
        // session state twice. NOTE for whoever builds the palette (Task
        // 4/5): a click on a palette ITEM must preventDefault its own
        // mousedown so focus never actually leaves the editor DOM node in
        // the first place, exactly like the selection bubble already does
        // (selection-plugin.ts's own header comment) -- otherwise every
        // click on the palette would close it via this handler before the
        // click's own logic ever runs.
        blur: (view) => {
          closeSlashIn(view)
          return false
        }
      }
    },
    // Notifying from view.update, never state.apply -- verbatim reuse of
    // find-plugin.ts's own load-bearing reasoning: apply runs INSIDE
    // transaction application, so a React setter there fires a render from
    // inside a ProseMirror dispatch. destroy() reports null so a
    // key={revision} remount (a different document, or Format<->Source mode
    // switching) can't leave a stale palette on screen after the instance
    // that owned it is gone -- same pattern as selectionProse's own destroy.
    //
    // Follow-up 1 (applySlashA11y, above): the factory below takes its
    // `initialView` argument -- previously ignored (`view: () => ({...})`)
    // -- and captures it so destroy() (which prosemirror-view calls with NO
    // arguments of its own; only the per-update `update(view, prevState)`
    // callback receives one) still has a real `view.dom` to clear the three
    // aria attributes off of on teardown. Both are the SAME EditorView
    // instance for this plugin's entire lifetime (a ProseMirror view is
    // constructed once and updated in place, never swapped), so capturing
    // the factory's own argument is exactly as current as reading update's.
    view: (initialView) => ({
      update: (view, prevState) => {
        const previous = slashPluginKey.getState(prevState)
        const next = slashPluginKey.getState(view.state)
        if (!next) return
        if (sameSession(previous?.session ?? null, next.session)) return
        onStateChanged(next.session)
        applySlashA11y(view, next.session)
      },
      destroy: () => {
        onStateChanged(null)
        applySlashA11y(initialView, null)
      }
    })
  })
}

// Inserts a literal "/" at `pos` -- exactly the real transaction a user
// typing "/" produces (a single-step, single-character ReplaceStep), so it
// opens a session through the SAME tryOpen path a real keystroke does rather
// than a parallel "force open" code path that could silently drift from what
// typing actually does. Mirrors find-plugin.ts's applyFindState in shape (a
// single EditorView-taking entry point) but NOT in role -- unlike
// applyFindState, which is a genuine production entry point (MilkdownEditor's
// find command surface calls it for real), this is a TEST SEAM ONLY: there is
// no production caller anywhere in this codebase (a real "/" always arrives
// via a genuine keystroke, which tryOpen already handles directly), and none
// is expected -- deliberately no "set the session to arbitrary state" helper
// exists either, because a session's shape (anchorPos, query) must always be
// derived from real document content via tryOpen/advanceSession, never
// asserted from outside. Exported, and used throughout this file's own test
// suite plus MilkdownEditor.test.tsx's SLASH_PLUGINS-based tests, purely so
// those tests can open a session without simulating a real DOM keydown for
// every single case.
//
// Explicitly sets the selection to right after the inserted "/", rather than
// trusting Transaction.insertText's own default -- a real, caught bug, not
// defensive padding: insertText(text, from, to), given EXPLICIT from/to (as
// opposed to being called with no position, which replaces the CURRENT
// selection), does NOT move the selection to the insertion point on its own.
// It maps whatever selection already existed through the change, so calling
// this at any position other than the current cursor silently left the
// selection wherever it already was -- tryOpen would then resolve $from
// against a stale, unrelated position and never see the "/" at all. Caught
// by this file's own tests (a "/" inserted into a SECOND paragraph while the
// cursor was still in the first) before it could reach openSlashSessionAt's
// own callers.
export function openSlashSessionAt(view: EditorView, pos: number): void {
  const tr = view.state.tr.insertText('/', pos)
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1)))
}

// Closes the current session, if one is open -- a plain meta-only
// transaction (no doc change, no stored marks), so it can never mark a clean
// document dirty. No-ops when nothing is open, so callers (Escape, blur, a
// future "click outside" handler) can call it unconditionally without first
// checking session state themselves.
export function closeSlashIn(view: EditorView): void {
  if (!slashPluginKey.getState(view.state)?.session) return
  view.dispatch(view.state.tr.setMeta(slashPluginKey, { type: 'close' } satisfies SlashMeta))
}

// Moves activeIndex directly to `index` -- the SAME meta-only dispatch
// handleKeyDown's own ArrowDown/ArrowUp branch already issues internally
// (see the 'setActiveIndex' case above), factored out into a real exported
// entry point so an external caller (Task 5's useSlashMenu, backing
// SlashMenu's onHover) can reach it without a second, duplicate meta shape
// of its own. Pointer hover has to move THIS SAME plugin-owned pointer, not
// a parallel React-only one -- see this file's own header comment for why
// activeIndex lives here at all: handleKeyDown must move it synchronously on
// every ArrowDown/Up regardless, and a hover-only copy in React would let
// the two disagree about which item is "active" the next time a key moves it.
// No-ops when nothing is open (mirrors closeSlashIn's own guard) OR when
// `index` already equals the session's own activeIndex -- SlashMenu's own
// onMouseEnter fires on every hover, and this dedupe is what keeps a
// re-hover of the already-active item from dispatching a transaction (and
// therefore an onStateChanged round trip) for genuinely nothing. Does NOT
// clamp/validate `index` against itemCount -- unlike the internal
// handleKeyDown branch, which always computes an in-range value via its own
// wraparound arithmetic, this is a raw external setter, and its one real
// caller (SlashMenu's own onHover) can only ever pass an index into the
// array it is currently rendering -- which is built from the exact same
// enabledSlashItems formula the plugin's own itemCount is computed from (see
// slash-items.ts's own enabledSlashItems doc comment), so the two counts
// cannot disagree.
export function setActiveSlashIndexIn(view: EditorView, index: number): void {
  const session = slashPluginKey.getState(view.state)?.session
  if (!session || session.activeIndex === index) return
  view.dispatch(
    view.state.tr.setMeta(slashPluginKey, {
      type: 'setActiveIndex',
      activeIndex: index
    } satisfies SlashMeta)
  )
}

// Deletes exactly `[from, to)` -- the "/query" text -- then calls `run`.
// Two dispatches, not one: ProseMirror dispatch is synchronous (this
// codebase already relies on that property -- see editor-commands.ts's own
// toggleBulletList, which reads the state its own first dispatch just
// produced before issuing a second), so by the time `run` executes, the
// delete has already landed and any $command it calls (via
// editor.action(callCommand(...))) reads the post-delete document. `run`
// takes no arguments deliberately: this file has no `ctx`/`Editor` of its
// own (see this file's header), so the caller (Task 5's useSlashMenu, which
// DOES hold both) closes over whatever it needs -- keeping this a plain,
// catalogue-agnostic utility, the same reason countMatching and this file
// as a whole take no dependency on the item catalogue.
//
// !!! Follow-up 2 fix (CLAUDE.md's "Slash command menu" section: "undo
// grouping is unpinned") !!! `closeHistory` (prosemirror-history, re-exported
// from `@milkdown/prose/history`) is stamped on the delete transaction
// specifically -- not on the transaction `run()` goes on to dispatch, and
// not as a THIRD, separate no-op transaction either.
//
// DECISION, worth restating here since the mechanism only makes sense in
// light of it: choosing a slash-menu item is a discrete, deliberate UI
// action -- the same category as clicking a toolbar button -- so it must be
// exactly ONE undo group (the query delete + the item's own insertion,
// atomically), and that group must be DETERMINISTICALLY separate from
// whatever free-form query typing preceded it, never merged with it just
// because the user happened to press Enter quickly. Measured before this
// fix: prosemirror-history groups transactions that land within its own
// 500ms `newGroupDelay` of each other (and are "adjacent," i.e. touch
// overlapping ranges) into ONE undo event -- so typing "/head" and pressing
// Enter immediately silently merged the typing + this delete + the item's
// own insertion into ONE group (one undo emptied the document completely),
// while pausing past 500ms before Enter produced TWO groups instead. Same
// gesture, two different outcomes, purely as a function of real wall-clock
// timing -- exactly the kind of flake a user could never predict or
// reproduce on purpose.
//
// closeHistory's real, read-from-source effect (prosemirror-history's own
// `applyTransaction`): stamping it on a transaction resets the history
// plugin's OWN "am I still inside the same group?" bookkeeping (prevTime to
// 0, prevRanges to null) before that transaction is folded in -- which
// forces THIS transaction to start a brand-new group unconditionally,
// severing it from whatever group preceded it, regardless of real elapsed
// time. The immediately-following transaction `run()` dispatches (the
// item's own wrapInHeadingCommand/wrapInBulletListCommand/etc., same call
// stack, no closeHistory of its own) is then free to merge FORWARD into
// THIS new group via prosemirror-history's ordinary adjacency/timing rule --
// exactly the same rule that already, correctly, merges two back-to-back
// keystrokes -- so the net result is one clean group covering exactly
// {delete, insert}, on every choose, regardless of how long the user spent
// composing the query beforehand.
//
// REJECTED alternative: collapsing the ENTIRE gesture -- every keystroke of
// the query typing, PLUS this delete, PLUS the item's own insertion -- into
// one deterministic undo group regardless of how long the user pauses while
// typing. There is no public prosemirror-history primitive that FORCES a
// merge (closeHistory only ever forces a SPLIT); reaching that outcome would
// mean poking at the plugin's own private HistoryState, which no public API
// exposes. It would also be worse UX: a user who pauses for minutes
// mid-query, deliberating over wording, would have that entire pause swept
// into one "session" alongside a later, unrelated block insertion -- one
// undo removing several minutes of unrelated typing along with the choice
// that actually needs undoing.
export function runSlashItemIn(view: EditorView, from: number, to: number, run: () => void): void {
  view.dispatch(closeHistory(view.state.tr.delete(from, to)))
  run()
}
