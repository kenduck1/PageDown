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
// (Task 5's useSlashMenu controller) reports its length in via
// setSlashItemCount below, which is also how "close on empty filtered list"
// (the design doc's own close condition) is satisfied without this file
// importing slash-filter.ts at all: an explicit report of 0 closes the
// session, but a session that has merely not been reported to YET (freshly
// opened, itemCount defaults to 0) does not auto-close itself -- see
// applyItemCount's own comment.

/** A live slash-command session: the palette is open and tracking a query. */
export interface SlashSession {
  /** Document position of the triggering "/" character itself (not after it). */
  anchorPos: number
  /** Everything after the "/" up to the cursor -- what the palette filters on. */
  query: string
  /**
   * Index into the CURRENTLY FILTERED item list. Lives here, not in React --
   * see this file's own header comment for why. Clamped into [0, itemCount)
   * every time itemCount changes (setSlashItemCount below), so a query that
   * narrows the list can never leave this pointing past the end.
   */
  activeIndex: number
  /**
   * How many items currently match `query`, as last reported by
   * setSlashItemCount. 0 until the first report arrives after a session
   * opens -- deliberately NOT treated as "the list is empty, close" on its
   * own (see applyItemCount), since 0-because-nothing-has-reported-yet and
   * 0-because-the-query-genuinely-matches-nothing are different states this
   * plugin has no way to tell apart by itself.
   */
  itemCount: number
}

export interface SlashPluginState {
  session: SlashSession | null
  decorations: DecorationSet
}

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
// closeSlashIn / setSlashItemCount / runSlashItemIn), mirroring how
// find-plugin.ts's FindStateInput is the one exception (applyFindState takes
// it as a real parameter) rather than the rule.
type SlashMeta =
  | { type: 'close' }
  | { type: 'setItemCount'; itemCount: number }
  | { type: 'setActiveIndex'; activeIndex: number }

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
// larger pasted string ending in "/".
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
function tryOpen(newState: EditorState, prev: SlashPluginState): SlashPluginState {
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

  const anchorPos = $from.start() + trigger.slashOffset
  return withSession(doc, { anchorPos, query: trigger.query, activeIndex: 0, itemCount: 0 })
}

// Recomputes an ALREADY-OPEN session against a transaction that changed the
// document and/or selection. Per this file's own header and the design
// doc: the query is DERIVED from the anchor position via doc.textBetween,
// never by re-running findSlashTrigger's backward scan -- that scan finds
// "the nearest /", which is exactly wrong here (it would let the cursor
// silently re-anchor to an unrelated LATER "/" typed elsewhere in the same
// paragraph, rather than correctly closing this session because the cursor
// left its range).
function advanceSession(
  session: SlashSession,
  tr: Transaction,
  newState: EditorState
): SlashPluginState {
  const anchorPos = tr.mapping.map(session.anchorPos)
  const { doc, selection } = newState

  if (anchorPos < 0 || anchorPos + 1 > doc.content.size) return EMPTY_STATE
  if (!(selection instanceof TextSelection) || !selection.empty) return EMPTY_STATE
  // The cursor must sit AT OR AFTER the position right after the "/" --
  // otherwise it has moved onto or before the trigger character itself
  // (Left arrow, Home, a click before the "/"), which is "selection leaving
  // the anchored range" per the design doc's own close condition.
  if (selection.from <= anchorPos) return EMPTY_STATE
  if (doc.textBetween(anchorPos, anchorPos + 1) !== '/') return EMPTY_STATE

  // '\n' as both separators here (unlike tryOpen's '￼' above): this
  // scans the WHOLE DOCUMENT between two absolute positions, where a real
  // block boundary is a genuine possibility (the selection jumped to a
  // different paragraph) and must read as whitespace so the very next check
  // closes the session, rather than as an inert placeholder character.
  const query = doc.textBetween(anchorPos + 1, selection.from, '\n', '\n')
  if (WHITESPACE.test(query) || query.length > MAX_QUERY_LENGTH) return EMPTY_STATE

  return withSession(doc, {
    anchorPos,
    query,
    itemCount: session.itemCount,
    // A changed query invalidates whatever the old activeIndex pointed at --
    // the filtered list itself is about to change (Task 5's controller will
    // re-filter and report a fresh itemCount), so land back on the first
    // item rather than an index that may no longer make sense. An unchanged
    // query (e.g. this transaction only moved the selection within the same
    // range, or was a no-op replace) keeps the user's current pick.
    activeIndex: query === session.query ? session.activeIndex : 0
  })
}

// Applies an explicit itemCount report (setSlashItemCount below). itemCount
// <= 0 closes the session outright -- this is the ONLY path that implements
// the design doc's "close on empty filtered list", and it is deliberately a
// REPORTED fact, not something this plugin infers on its own, because a
// freshly opened session (itemCount defaults to 0, see tryOpen) must NOT
// look indistinguishable from "the query genuinely matches nothing" before
// anyone has actually computed the filtered list yet.
function applyItemCount(
  session: SlashSession,
  itemCount: number,
  doc: ProseNode
): SlashPluginState {
  if (itemCount <= 0) return EMPTY_STATE
  const activeIndex = session.activeIndex < itemCount ? session.activeIndex : 0
  return withSession(doc, { ...session, itemCount, activeIndex })
}

// Constructed per MOUNT (in MilkdownEditor.tsx, alongside findProse /
// selectionProse / dropImageProse, Task 5), because it closes over a
// per-mount callback -- same reasoning as createFindPlugin/
// createSelectionPlugin.
export function createSlashPlugin(onStateChanged: (session: SlashSession | null) => void): Plugin {
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
          if (meta?.type === 'setItemCount') {
            return applyItemCount(prev.session, meta.itemCount, newState.doc)
          }
          if (meta?.type === 'setActiveIndex') {
            return withSession(newState.doc, { ...prev.session, activeIndex: meta.activeIndex })
          }
          // Nothing moved: no doc change and no selection change (a meta-only
          // transaction from an unrelated plugin, or one with no meta and no
          // effect at all). Mirrors find-plugin.ts's identical early return.
          if (!tr.docChanged && !tr.selectionSet) return prev
          return advanceSession(prev.session, tr, newState)
        }

        // No open session: the only way one can start is a transaction that
        // itself inserted a single "/" -- anything else (an unrelated edit
        // elsewhere, a selection-only transaction) has nothing to open.
        if (!tr.docChanged || !insertedSingleSlash(tr)) return prev
        return tryOpen(newState, prev)
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
      // it explicitly.
      handleKeyDown: (view, event) => {
        const session = slashPluginKey.getState(view.state)?.session
        if (!session) return false

        switch (event.key) {
          case 'ArrowDown':
          case 'ArrowUp': {
            const delta = event.key === 'ArrowDown' ? 1 : -1
            const { itemCount, activeIndex } = session
            // Wraps in both directions via a positive-remainder modulo. When
            // itemCount is still 0 (a session that just opened and hasn't had
            // its first setSlashItemCount report yet), stay at 0 rather than
            // divide by zero -- harmless, and self-corrects the moment a real
            // count is reported.
            const next = itemCount > 0 ? (activeIndex + delta + itemCount) % itemCount : 0
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
            // priority" section), not something tuned here.
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

// Reports how many items currently match the live query -- the one channel
// through which the item catalogue's own filtering (Task 4/5, deliberately
// NOT a dependency of this file) reaches this plugin. Also a plain meta-only
// transaction, same non-dirtying guarantee as closeSlashIn. No-ops when
// nothing is open, for the same reason: a stale report arriving after the
// session already closed (e.g. a debounced filter callback resolving late)
// must not resurrect it.
export function setSlashItemCount(view: EditorView, itemCount: number): void {
  if (!slashPluginKey.getState(view.state)?.session) return
  view.dispatch(
    view.state.tr.setMeta(slashPluginKey, { type: 'setItemCount', itemCount } satisfies SlashMeta)
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
// catalogue-agnostic utility, the same reason setSlashItemCount and this
// file as a whole take no dependency on the item catalogue.
export function runSlashItemIn(view: EditorView, from: number, to: number, run: () => void): void {
  view.dispatch(view.state.tr.delete(from, to))
  run()
}
