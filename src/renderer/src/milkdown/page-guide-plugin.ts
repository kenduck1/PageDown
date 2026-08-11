// Page-break guides in the Milkdown canvas, derived from Paged.js's own
// output rather than computed independently.
//
// This is the editor half of the master design doc's "review's
// highest-value finding" (design:50-58): there is exactly ONE pagination
// algorithm, and what the editor draws is *recovered from* it. The other
// half lives in src/markdown/pipeline.ts (which stamps each top-level block
// with its index) and src/pagination/page-breaks.ts (which reads those
// stamps back out of the finished pages). Nothing here measures heights or
// guesses where a page ends -- that independently-computed-guides approach
// is precisely what the design review rejected, on the grounds that two
// algorithms disagree exactly where it matters and a guide caught
// disagreeing is worse than no guide.
//
// Modelled on find-plugin.ts, this codebase's canonical decoration plugin,
// and it keeps that file's two hard rules: nothing notifies React from
// `apply` (which runs inside transaction application), and every transaction
// this plugin causes is a meta-only, zero-step one -- `docChanged: false`
// with no `storedMarksSet` -- so showing or moving a guide can never trip
// MilkdownEditor's `editedSinceMountRef` and mark a clean document dirty.

import { Plugin, PluginKey } from '@milkdown/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view'
import type { Node as ProseNode } from '@milkdown/prose/model'
import {
  groupPageGuides,
  type PageBreakPosition,
  type PageGuide
} from '../../../pagination/page-breaks'

/** What the renderer pushes in: one settled render's recovered breaks. */
export interface PageGuideInput {
  breaks: PageBreakPosition[]
  /** Top-level block count of the document those breaks were computed from. */
  blockCount: number
}

export interface PageGuidePluginState {
  input: PageGuideInput
  decorations: DecorationSet
}

export const pageGuidePluginKey = new PluginKey<PageGuidePluginState>('pagedownPageGuides')

const EMPTY_INPUT: PageGuideInput = { breaks: [], blockCount: 0 }

export const PAGE_GUIDE_CLASS = 'pagedown-page-guide'
export const PAGE_GUIDE_LABEL_CLASS = 'pagedown-page-guide-label'

/**
 * The document position immediately AFTER top-level node `blockIndex`.
 *
 * Walked rather than resolved through `doc.resolve`, because what is wanted
 * is the boundary BETWEEN two top-level nodes, which is the running sum of
 * the preceding nodes' `nodeSize`s -- `doc.child(i)` gives the node but not
 * its offset, and ProseMirror has no direct "offset of child i" accessor.
 */
function positionAfterBlock(doc: ProseNode, blockIndex: number): number {
  let position = 0
  for (let index = 0; index <= blockIndex; index += 1) {
    position += doc.child(index).nodeSize
  }
  return position
}

/**
 * The user-visible label for one guide.
 *
 * Three cases, and the second two exist to keep the feature HONEST about the
 * limitation it cannot engineer away rather than quietly presenting a guess
 * as a fact. Paged.js splits content *inside* a block -- a paragraph, a
 * table, a fenced code block can each straddle a boundary -- and a block is
 * the finest granularity the editor side can address (see
 * block-correspondence.test.ts for why the index correspondence exists at
 * all, and the design doc's own instruction at design:69 to "downgrade
 * honestly to block-level guides for that construct and say so in the UI"
 * rather than ship an offset that is wrong).
 *
 * So: a clean break between two blocks says "Page N ends here" and means it.
 * A break falling inside a block says so in as many words. And when several
 * consecutive pages all break inside the SAME block -- a long code listing
 * spanning five pages is the realistic case, not a contrived one -- they
 * collapse into one marker naming the whole range, because five identical
 * lines stacked on one boundary would be noise.
 */
export function formatPageGuideLabel(guide: PageGuide): string {
  const first = guide.pages[0]
  const last = guide.pages[guide.pages.length - 1]
  if (!guide.splitsBlock) return `Page ${first} ends here`
  if (first === last) return `Page ${first} ends inside this block`
  return `Pages ${first}–${last} end inside this block`
}

function buildGuideElement(guide: PageGuide): HTMLElement {
  const element = document.createElement('div')
  element.className = guide.splitsBlock ? `${PAGE_GUIDE_CLASS} is-approximate` : PAGE_GUIDE_CLASS
  // Widget DOM is not part of the document, and ProseMirror does not mark it
  // uneditable for us. Without this, a caret can land inside the guide and
  // typing there produces DOM mutations ProseMirror has to reconcile against
  // a document that has no such node.
  //
  // setAttribute, not the `contentEditable` IDL property: jsdom implements
  // the property without reflecting it to the attribute, so the property
  // form is untestable there (and real Chromium honours either).
  element.setAttribute('contenteditable', 'false')
  element.setAttribute('data-page-guide', String(guide.pages[0]))
  element.setAttribute('aria-hidden', 'true')

  const label = document.createElement('span')
  label.className = PAGE_GUIDE_LABEL_CLASS
  label.textContent = formatPageGuideLabel(guide)
  element.appendChild(label)
  return element
}

/**
 * Builds the widget decorations for one settled render.
 *
 * Two independent guards, both required, both failing CLOSED (no guides
 * rather than wrong guides):
 *
 * 1. **The structural staleness guard.** `input.blockCount` is the block
 *    count of the document the render was computed from; `doc.childCount` is
 *    the live one. They disagree whenever the user has added or removed a
 *    whole block since the (debounced, ~500ms) render was requested -- and a
 *    structural edit shifts every block index after it, so every guide below
 *    the edit would land somewhere wrong. Suppressing the whole set until the
 *    next render lands is the only honest answer; a guide in the wrong place
 *    is worse than no guide in an app whose entire premise is layout
 *    fidelity. This is also what discharges design:73's requirement that a
 *    recovered offset be mapped forward from the version it describes, or
 *    discarded -- at block granularity, "the block count still matches" is
 *    the mapping, and it needs no retained ProseMirror `Mapping` at all.
 *    Note what it deliberately does NOT suppress: typing *within* a block
 *    leaves every index valid, so the guides stay put and stay correct in
 *    index while going slightly stale in position, which is the disclosed
 *    trade.
 *
 * 2. **The range guard**, inside `groupPageGuides`: an out-of-range index is
 *    dropped. Redundant with the count check for the ordinary case, kept
 *    because it is the last line of defence against an index arriving from
 *    the sandboxed render context -- an untrusted-adjacent boundary -- and
 *    `positionAfterBlock` would throw on `doc.child(childCount)`.
 */
export function buildPageGuideDecorations(doc: ProseNode, input: PageGuideInput): DecorationSet {
  if (input.blockCount !== doc.childCount) return DecorationSet.empty
  const guides = groupPageGuides(input.breaks, doc.childCount)
  if (guides.length === 0) return DecorationSet.empty

  const decorations = guides.map((guide) =>
    Decoration.widget(positionAfterBlock(doc, guide.blockIndex), () => buildGuideElement(guide), {
      // `side: -1` keeps the guide attached to the END of the block it
      // follows rather than the start of the next one. It matters when the
      // user types at the very start of the following block: with a positive
      // side the widget would be pushed along by the inserted text.
      side: -1,
      // ProseMirror otherwise treats the widget as a possible selection
      // target, so an ArrowDown through the document would stop on a
      // decoration that is not part of the document at all.
      ignoreSelection: true,
      key: `page-guide-${guide.blockIndex}-${guide.pages.join(',')}-${guide.splitsBlock}`
    })
  )
  return DecorationSet.create(doc, decorations)
}

/**
 * The guides are pushed in from outside (the debounced `getPageCount` round
 * trip, via MilkdownEditor's own prop) rather than computed here, and are
 * recomputed against the live doc on every document change so that an edit
 * which changes the block count blanks them immediately instead of leaving
 * them hanging at stale positions until the next render lands.
 */
export function createPageGuidePlugin(): Plugin {
  return new Plugin<PageGuidePluginState>({
    key: pageGuidePluginKey,
    state: {
      init: () => ({ input: EMPTY_INPUT, decorations: DecorationSet.empty }),
      apply: (tr, previous, _oldState, newState) => {
        const meta = tr.getMeta(pageGuidePluginKey) as PageGuideInput | undefined
        if (!meta && !tr.docChanged) return previous
        const input = meta ?? previous.input
        return { input, decorations: buildPageGuideDecorations(newState.doc, input) }
      }
    },
    props: {
      decorations: (state) => pageGuidePluginKey.getState(state)?.decorations ?? DecorationSet.empty
    }
  })
}

/**
 * Pushes a settled render's recovered breaks into a mounted view.
 *
 * Dispatches a meta-only transaction (no steps at all), which is what keeps
 * this invisible to `editedSinceMountRef` -- see this file's header. Skips
 * the dispatch entirely when nothing changed, so the ~500ms `usePageCount`
 * tick on an idle document costs zero transactions rather than one per tick.
 */
export function applyPageGuides(view: EditorView, next: PageGuideInput): void {
  const current = pageGuidePluginKey.getState(view.state)?.input
  if (
    current &&
    current.blockCount === next.blockCount &&
    current.breaks.length === next.breaks.length &&
    current.breaks.every((position, index) => {
      const other = next.breaks[index]
      return (
        position.page === other.page &&
        position.blockIndex === other.blockIndex &&
        position.splitsBlock === other.splitsBlock
      )
    })
  ) {
    return
  }
  view.dispatch(view.state.tr.setMeta(pageGuidePluginKey, next))
}
