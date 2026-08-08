import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view'
import type { Node as ProseNode } from '@milkdown/prose/model'
import { findMatches, MAX_MATCHES, type FindMatch, type FindOptions } from '../lib/find-matches'

export interface FindPluginState {
  query: string
  options: FindOptions
  activeIndex: number
  matches: FindMatch[]
  decorations: DecorationSet
}

export interface FindStateInput {
  query: string
  options: FindOptions
  activeIndex: number
}

export const findPluginKey = new PluginKey<FindPluginState>('pagedownFind')

const EMPTY_OPTIONS: FindOptions = { caseSensitive: false, wholeWord: false }

// Text extraction is per RUN -- not per text node, and not via
// node.textContent. Both obvious alternatives are wrong in opposite ways:
//
// - Scanning each text node independently misses any match spanning a mark
//   boundary. `he<strong>ll</strong>o` is three text nodes, and "hello" must
//   still be found.
// - node.textContent concatenates a block's inline content while SKIPPING
//   non-text leaves entirely, so the moment an inline atom (an image) appears
//   in the block, its offsets stop corresponding to document positions and
//   every match after it addresses the wrong text.
//
// A run is therefore a maximal span of CONSECUTIVE text children within one
// textblock, whose local offsets map linearly onto document positions, and
// which TERMINATES at any non-text child. Accepted, documented consequence: a
// match cannot span an inline atom -- searching "hello" will not match
// `he![x](y)llo`. That is the correct trade, since that text is not
// contiguous on screen either.
export function collectTextRuns(doc: ProseNode): Array<{ text: string; pos: number }> {
  const runs: Array<{ text: string; pos: number }> = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    // Index rather than a captured object reference: TypeScript cannot narrow
    // a `let x: T | null` that is reassigned inside a callback, and the index
    // form sidesteps that without an assertion.
    let currentIndex = -1
    node.forEach((child, offset) => {
      if (child.isText && child.text) {
        const childPos = pos + 1 + offset
        const run = currentIndex >= 0 ? runs[currentIndex] : undefined
        if (run && run.pos + run.text.length === childPos) {
          run.text += child.text
        } else {
          runs.push({ text: child.text, pos: childPos })
          currentIndex = runs.length - 1
        }
      } else {
        currentIndex = -1
      }
    })
    // Inline content is handled above; don't descend into it again.
    return false
  })
  return runs
}

export function findDocMatches(doc: ProseNode, query: string, options: FindOptions): FindMatch[] {
  if (query === '') return []
  const result: FindMatch[] = []
  for (const run of collectTextRuns(doc)) {
    for (const match of findMatches(run.text, query, options)) {
      result.push({ from: run.pos + match.from, to: run.pos + match.to })
      // The per-run engine caps itself, but the DOCUMENT-wide total is the
      // number that actually bounds decoration count, so cap again here.
      if (result.length >= MAX_MATCHES) return result
    }
  }
  return result
}

function buildDecorations(
  doc: ProseNode,
  matches: FindMatch[],
  activeIndex: number
): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty
  return DecorationSet.create(
    doc,
    matches.map((match, index) => {
      const attrs = {
        class:
          index === activeIndex
            ? 'pagedown-find-match pagedown-find-match-active'
            : 'pagedown-find-match'
      }
      // Decoration.inline's signature is (from, to, attrs, spec) -- `attrs`
      // becomes real DOM attributes on the painted <span> (this is what
      // actually applies the CSS classes above), but `spec` is a SEPARATE,
      // optional 4th argument, retrievable later via `Decoration#spec`, that
      // ProseMirror does NOT mirror `attrs` into: confirmed by reading
      // prosemirror-view's own source, `spec` defaults to a fixed shared
      // empty object (`noSpec`) whenever the 4th argument is omitted. Passing
      // the same object as both is what lets code introspect which class a
      // decoration carries without a real paint pass -- load-bearing for
      // this file's own test ('decorates every match and marks the active
      // one'), not decorative.
      return Decoration.inline(match.from, match.to, attrs, attrs)
    })
  )
}

function clampIndex(index: number, count: number): number {
  if (count === 0) return -1
  if (index < 0 || index >= count) return 0
  return index
}

// Constructed per MOUNT (in MilkdownEditor.tsx, alongside editedTrackerProse)
// rather than added to the static EDITOR_COMMAND_PLUGINS list, because it
// needs a per-mount callback to report match counts back out to React.
export function createFindPlugin(
  onMatchesChanged: (count: number, activeIndex: number) => void
): Plugin {
  return new Plugin<FindPluginState>({
    key: findPluginKey,
    state: {
      init: () => ({
        query: '',
        options: EMPTY_OPTIONS,
        activeIndex: -1,
        matches: [],
        decorations: DecorationSet.empty
      }),
      apply: (tr, prev, _oldState, newState) => {
        const meta = tr.getMeta(findPluginKey) as FindStateInput | undefined
        // Nothing can have moved: no new query and no document change.
        if (!meta && !tr.docChanged) return prev
        const query = meta ? meta.query : prev.query
        const options = meta ? meta.options : prev.options
        const matches = findDocMatches(newState.doc, query, options)
        const activeIndex = clampIndex(meta ? meta.activeIndex : prev.activeIndex, matches.length)
        return {
          query,
          options,
          activeIndex,
          matches,
          decorations: buildDecorations(newState.doc, matches, activeIndex)
        }
      }
    },
    props: {
      decorations: (state) => findPluginKey.getState(state)?.decorations ?? DecorationSet.empty
    },
    // Notifying from the view's update hook rather than from `apply` is
    // deliberate: `apply` runs INSIDE transaction application, so calling a
    // React setter there triggers a React render from inside a ProseMirror
    // dispatch. This hook also covers the case a return value could not --
    // the match count changing because the DOCUMENT changed (every keystroke
    // while the bar is open), not because the query did.
    view: () => ({
      update: (view, prevState) => {
        const previous = findPluginKey.getState(prevState)
        const next = findPluginKey.getState(view.state)
        if (!next) return
        if (
          previous &&
          previous.matches.length === next.matches.length &&
          previous.activeIndex === next.activeIndex
        ) {
          return
        }
        onMatchesChanged(next.matches.length, next.activeIndex)
      }
    })
  })
}

// The single entry point for both querying and navigating. When the resulting
// active match differs from the previous one it also SELECTS it and scrolls it
// into view, in the same call -- there is deliberately no separate
// scrollToMatch, so the highlight and the scroll position cannot disagree.
//
// It does NOT call view.focus(): focus must stay in the find input so Enter
// keeps advancing. Setting a selection is still worth doing -- it leaves the
// cursor at the last match when the bar closes (what Word does), and makes
// "replace the current match" and "replace the selection" the same thing.
//
// A selection-only transaction has docChanged: false and no storedMarksSet,
// so it correctly does NOT trip MilkdownEditor's editedSinceMountRef and
// cannot mark a clean document dirty. That is load-bearing; see this file's
// test 'selects the active match without focusing or changing the document'.
export function applyFindState(view: EditorView, next: FindStateInput): void {
  const before = findPluginKey.getState(view.state)
  view.dispatch(view.state.tr.setMeta(findPluginKey, next))
  const after = findPluginKey.getState(view.state)
  if (!after || after.activeIndex < 0) return
  const match = after.matches[after.activeIndex]
  if (!match) return
  const previousMatch =
    before && before.activeIndex >= 0 ? before.matches[before.activeIndex] : undefined
  if (previousMatch && previousMatch.from === match.from && previousMatch.to === match.to) return
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, match.from, match.to))
      .scrollIntoView()
  )
}

// insertText (not replaceWith) so the replacement INHERITS the marks at
// `from` -- replacing a word inside bold text keeps it bold. The replacement
// is inserted as literal text and is never parsed as Markdown; typing `**x**`
// here inserts those six characters visibly, which is the honest behavior for
// a WYSIWYG surface.
export function replaceActiveMatchIn(view: EditorView, replacement: string): void {
  const state = findPluginKey.getState(view.state)
  if (!state || state.activeIndex < 0) return
  const match = state.matches[state.activeIndex]
  if (!match) return
  view.dispatch(view.state.tr.insertText(replacement, match.from, match.to))
}

// One transaction, applied from the LAST match to the FIRST, so every
// not-yet-applied match's positions are still valid without position mapping.
// One transaction is also one undo step, which is what a user expects from
// Replace All.
export function replaceAllMatchesIn(view: EditorView, replacement: string): void {
  const state = findPluginKey.getState(view.state)
  if (!state || state.matches.length === 0) return
  const tr = view.state.tr
  for (let index = state.matches.length - 1; index >= 0; index--) {
    const match = state.matches[index]
    tr.insertText(replacement, match.from, match.to)
  }
  view.dispatch(tr)
}
