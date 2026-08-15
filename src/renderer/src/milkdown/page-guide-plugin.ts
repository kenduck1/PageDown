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

// The class name is still `...-page-guide` rather than `...-page-seam`
// deliberately, even though what it draws is now a seam rather than a line:
// it is an internal identifier referenced from base.css, this plugin's unit
// tests and Gate 37, and renaming it would be pure churn across four files
// for no user-visible gain. The user-visible naming is in the LABEL.
export const PAGE_GUIDE_CLASS = 'pagedown-page-guide'
export const PAGE_GUIDE_LABEL_CLASS = 'pagedown-page-guide-label'
/** The gutter band between the two sheets -- the only part that is not paper. */
export const PAGE_SEAM_GUTTER_CLASS = 'pagedown-page-seam-gutter'

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

/**
 * The seam's DOM: three stacked bands, of which only the middle one is drawn.
 *
 * The outer element's own height IS the boundary (paper above + gutter +
 * paper below, all from the document's own margins -- see
 * src/typography/page-seam.ts), and the gutter is painted over the middle of
 * it. The paper bands need no element of their own: the page card behind them
 * is already white, so "still paper" is simply "nothing drawn here".
 *
 * The label lives INSIDE the gutter rather than beside it -- there is now a
 * real band to put it in, which is where a page separator's caption belongs,
 * and it means the label cannot overlap document text the way a caption
 * floating above a hairline could.
 */
function buildGuideElement(guide: PageGuide): HTMLElement {
  const element = document.createElement('div')
  element.className = guide.splitsBlock ? `${PAGE_GUIDE_CLASS} is-approximate` : PAGE_GUIDE_CLASS
  // Widget DOM is not part of the document, and ProseMirror does not mark it
  // uneditable for us. Without this, a caret can land inside the guide and
  // typing there produces DOM mutations ProseMirror has to reconcile against
  // a document that has no such node. This matters MORE now than it did when
  // the widget was a zero-height line: a seam is a ~216px target that a click
  // could plausibly land in. (base.css additionally gives it
  // `pointer-events: none`, so a click passes through to .ProseMirror and
  // lands the caret at the nearest real position -- both are kept, since the
  // attribute also governs caret movement by keyboard, which pointer-events
  // says nothing about.)
  //
  // setAttribute, not the `contentEditable` IDL property: jsdom implements
  // the property without reflecting it to the attribute, so the property
  // form is untestable there (and real Chromium honours either).
  element.setAttribute('contenteditable', 'false')
  element.setAttribute('data-page-guide', String(guide.pages[0]))
  element.setAttribute('aria-hidden', 'true')

  const gutter = document.createElement('div')
  gutter.className = PAGE_SEAM_GUTTER_CLASS

  const label = document.createElement('span')
  label.className = PAGE_GUIDE_LABEL_CLASS
  label.textContent = formatPageGuideLabel(guide)
  gutter.appendChild(label)
  element.appendChild(gutter)
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
 *
 * `onSeamCountChanged` reports how many seams are ACTUALLY DRAWN right now --
 * which is not the same number as `input.breaks.length` and must not be
 * derived from it by the caller. Breaks collapse onto shared boundaries
 * (`groupPageGuides`), out-of-range ones are dropped, and the whole set is
 * suppressed on a block-count mismatch. EditorScreen sizes the page card from
 * this so the card shows exactly as many sheets as the canvas actually draws
 * boundaries for -- a card sized for five sheets while the guides are failing
 * closed would be a page and a half of unexplained blank paper, i.e. the
 * wrong-layout-with-no-explanation failure the fail-closed posture exists to
 * avoid. Reported from `view.update`, never from `apply`: `apply` runs inside
 * transaction application, so a React setter there would fire a render from
 * inside a ProseMirror dispatch (find-plugin.ts's rule, and the same reason
 * that file reports its own match count through a callback).
 */
export function createPageGuidePlugin(onSeamCountChanged?: (count: number) => void): Plugin {
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
    view: (initialView) => {
      // Seeded to -1 rather than 0 so the very first report always fires,
      // even for the (normal) initial count of zero -- the caller starts from
      // its own default and this is what makes the two provably agree rather
      // than agree by coincidence. Everything after that is change-only, so
      // the ~500ms page-count tick on an idle document costs no renders.
      let reported = -1
      const report = (view: EditorView): void => {
        const count = pageGuidePluginKey.getState(view.state)?.decorations.find().length ?? 0
        if (count === reported) return
        reported = count
        onSeamCountChanged?.(count)
      }
      report(initialView)
      return {
        update: report,
        // Without this, a remount (every `key={revision}` change) would leave
        // the card sized for the OUTGOING document's page count until the
        // incoming editor's first update lands.
        destroy: () => {
          if (reported === 0) return
          reported = 0
          onSeamCountChanged?.(0)
        }
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
