import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction
} from '@milkdown/prose/state'
import { ReplaceStep } from '@milkdown/prose/transform'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view'
import type { Node as ProseNode } from '@milkdown/prose/model'
import { findSlashTrigger, MAX_QUERY_LENGTH } from '../lib/slash-query'

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
// (Task 5's useSlashMenu controller) supplies a `countMatching(query)`
// closure at construction time -- see createSlashPlugin's own comment for
// why this is dependency injection rather than an external report channel
// (an earlier version of this file used the latter; fix round 1 replaced it
// after review found two real, measured costs: a stale-count window between
// a query changing and the next report, and silent failure -- arrows
// permanently inert, the empty-list close never firing -- if a caller ever
// forgot to report).

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

// True iff `tr` is EXACTLY "insert one literal '/' character, nothing else"
// -- a single ReplaceStep whose slice is a single, unopened text node "/".
// Deliberately narrow: a paste, an IME composition, or any multi-step
// transaction is NOT this, and must not open a session -- typing "/" is the
// one gesture this feature triggers on, matching the design doc's own
// framing ("Open only when: a transaction inserted a single /"). Checking
// the STEP shape (not just "does the resulting text end in /") is what
// correctly ignores a "/" that arrived some other way, e.g. as part of a
// larger pasted string ending in "/". (A single-character "/" paste is
// indistinguishable from typing one and DOES open a session -- there is no
// way to tell the two apart from the transaction alone, and there is no
// reason to: a bare "/" paste is behaviourally identical to a keystroke.)
function insertedSingleSlash(tr: Transaction): boolean {
  if (tr.steps.length !== 1) return false
  const [step] = tr.steps
  if (!(step instanceof ReplaceStep)) return false
  const { slice } = step
  // openStart/openEnd > 0 would mean the slice is a fragment of a larger
  // structure (e.g. half of a split node) rather than a bare inserted leaf --
  // not reachable for a single typed character, kept as an explicit guard
  // rather than assumed.
  if (slice.openStart !== 0 || slice.openEnd !== 0) return false
  if (slice.content.childCount !== 1) return false
  const node = slice.content.firstChild
  return !!node && node.isText && node.text === '/'
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

  // '￼' (OBJECT REPLACEMENT CHARACTER) as the leaf-text stand-in for a
  // non-text inline atom (e.g. an image): non-whitespace, so a "/" typed
  // immediately after one is correctly treated as "preceded by a non-
  // whitespace character" and rejected by findSlashTrigger, the same way
  // "and/or" is -- not as "start of block."
  const textBeforeCursor = $from.parent.textBetween(0, $from.parentOffset, '￼', '￼')
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
// selectionProse / dropImageProse, Task 5), because it closes over a
// per-mount callback -- same reasoning as createFindPlugin/
// createSelectionPlugin.
//
// `countMatching(query, state)` is supplied by the caller (Task 5's
// useSlashMenu, which owns the item catalogue, slash-filter.ts's
// filterSlashItems, AND the live Ctx isEnabled needs) and is expected to be
// `(query, state) => filterSlashItems(SLASH_ITEMS, query).filter((item) =>
// item.isEnabled(ctx, state)).length` or equivalent -- see CountMatching's
// own doc comment above for why `state` was added in fix round 1 (an
// isEnabled-aware count is NOT a pure function of the query string alone).
// This file still takes no dependency on the catalogue or on
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
  countMatching: CountMatching
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
            // Swallow ONLY. Which item actually runs is decided by whoever
            // holds the filtered catalogue (Task 5's useSlashMenu, via its own
            // keydown handling -- the DOM event still bubbles to it, same
            // propagates-after-preventDefault behavior the Escape branch below
            // relies on) -- this file has no catalogue to run one from (see
            // this file's own header). Returning true here is what stops the
            // underlying keymap's Enter -> splitBlock/splitListItem/
            // goToNextTableCell from ever firing while a session is open,
            // per the design doc's "Keys intercepted while open" section --
            // that ordering is structural (see the design doc's "Keymap
            // priority" section), not something tuned here. Directly proven,
            // not just asserted: this file's own test suite fires a real
            // Enter with no session open (the paragraph really splits,
            // childCount 1 -> 2) as the control for the same real Enter with
            // a session open (it does not split, childCount stays 1).
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
    view: () => ({
      update: (view, prevState) => {
        const previous = slashPluginKey.getState(prevState)
        const next = slashPluginKey.getState(view.state)
        if (!next) return
        if (sameSession(previous?.session ?? null, next.session)) return
        onStateChanged(next.session)
      },
      destroy: () => {
        onStateChanged(null)
      }
    })
  })
}

// Inserts a literal "/" at `pos` -- exactly the real transaction a user
// typing "/" produces (a single-step, single-character ReplaceStep), so it
// opens a session through the SAME tryOpen path a real keystroke does rather
// than a parallel "force open" code path that could silently drift from what
// typing actually does. Mirrors find-plugin.ts's applyFindState in spirit
// (a single EditorView-taking entry point usable by both tests and any
// future production caller) but not in shape -- there is deliberately no
// "set the session to arbitrary state" helper, because a session's shape
// (anchorPos, query) must always be derived from real document content via
// tryOpen/advanceSession, never asserted from outside.
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
export function runSlashItemIn(view: EditorView, from: number, to: number, run: () => void): void {
  view.dispatch(view.state.tr.delete(from, to))
  run()
}
