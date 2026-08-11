// Recovering WHERE Paged.js put each page break, expressed in a coordinate
// space the Milkdown editor can also speak: the index of a top-level block in
// the document's source.
//
// This module is BUNDLED INTO THE SANDBOX (resources/pagination-render/
// index.ts imports it), so it must stay dependency-free for the same reason
// page-nav.ts does -- a runtime import of anything under src/markdown/ would
// drag unified/remark into the one context that deliberately runs untrusted
// document HTML. Everything here is arithmetic plus read-only DOM attribute
// reads, both of which the sandbox and jsdom provide natively.
//
// The DOM-reading half lives here rather than inline in the render context
// specifically so it is unit-testable: `resources/` is outside vitest's
// include, which is the same constraint that forced document-style.ts and
// page-geometry.ts out of the render context and Gate 16 to pin
// buildDocumentStylesheet's `@page` margin ORDER end to end.

/**
 * The attribute `markdownToHtml` stamps on every top-level element it emits,
 * carrying that element's index into the document's own mdast root children.
 *
 * Paged.js's Chunker CLONES and RELOCATES real DOM nodes into its per-page
 * wrappers (`layout.js`'s `cloneNode`), so an attribute stamped on the
 * pre-pagination HTML structurally survives into the paginated output -- which
 * is the entire reason this approach is viable at all.
 */
export const BLOCK_INDEX_ATTRIBUTE = 'data-pd-block'

/**
 * The same thing, spelled the way a hast tree keys its properties.
 *
 * Both spellings are needed and neither is redundant. `markdownToHtml` works
 * on a hast tree, where properties are camelCased and where
 * `hast-util-sanitize` matches its schema against `Object.keys(properties)`
 * directly; the sandboxed render context works on a real DOM, where the
 * attribute has its literal dashed name. The round trip between the two
 * happens inside `hast-util-raw`, which serializes the tree to HTML and
 * re-parses it. They are declared together, here, so the pair is visible at a
 * glance rather than being a comment in one file asking a reader to trust a
 * string in another -- and pipeline.test.ts pins the correspondence against
 * real emitted HTML, which is the only place it can actually be checked.
 */
export const BLOCK_INDEX_HAST_PROPERTY = 'dataPdBlock'

/** One recovered page boundary. */
export interface PageBreakPosition {
  /** 1-based number of the page that ENDS at this break. Never the last page. */
  page: number
  /**
   * Index into the document's top-level blocks of the LAST block with any
   * content on `page`. The break falls at or inside this block's end.
   */
  blockIndex: number
  /**
   * True when that same block also has content on the NEXT page, i.e. Paged.js
   * split the block itself rather than breaking cleanly between two blocks.
   * The guide then cannot be drawn where the break really is -- see
   * `PageGuide` and the editor-side plugin for how this is surfaced rather
   * than hidden.
   */
  splitsBlock: boolean
}

/** One drawn guide: a boundary, plus every page that ends at it. */
export interface PageGuide {
  /** Draw after this top-level block. */
  blockIndex: number
  /** 1-based page numbers ending here, ascending. Usually one. */
  pages: number[]
  /** True when at least one of `pages` breaks INSIDE `blockIndex`'s block. */
  splitsBlock: boolean
}

/**
 * Reads the block indices present on each rendered page, in DOM order.
 *
 * Takes the `.pagedjs_page` elements (already ordered by Paged.js, which
 * appends pages as it lays them out). A block split across a boundary appears
 * on BOTH pages carrying the SAME index -- that duplication is the signal
 * `recoverPageBreaks` uses to detect a split, not noise to deduplicate away.
 *
 * An unparseable or absent index is skipped rather than treated as 0: the
 * attribute is stripped by `hast-util-sanitize` unless it carries this
 * render's own unguessable token (see pipeline.ts), so anything reaching here
 * malformed is a bug in our own emitter, and silently mapping it to block 0
 * would draw a guide at the top of the document.
 */
export function readPageBlockIndices(pages: ArrayLike<Element>): number[][] {
  const perPage: number[][] = []
  for (let index = 0; index < pages.length; index += 1) {
    const indices: number[] = []
    const stamped = pages[index].querySelectorAll(`[${BLOCK_INDEX_ATTRIBUTE}]`)
    for (let i = 0; i < stamped.length; i += 1) {
      const raw = stamped[i].getAttribute(BLOCK_INDEX_ATTRIBUTE)
      if (raw === null) continue
      const parsed = Number(raw)
      if (!Number.isInteger(parsed) || parsed < 0) continue
      indices.push(parsed)
    }
    perPage.push(indices)
  }
  return perPage
}

/**
 * Turns per-page block indices into one boundary per page transition.
 *
 * The rule is uniform for both the clean and the split case: the break after
 * page N is attributed to the LAST block with content on page N. When that
 * block also appears on page N+1 the break really falls somewhere inside it,
 * which is flagged rather than smoothed over.
 *
 * Attributing a split break to the block's END (rather than to the boundary
 * BEFORE it) is deliberate and was chosen over the alternative for a concrete
 * reason: the "before" anchor collides with the previous clean break. Consider
 * a clean break after block 3, then block 4 spanning pages 2-5. Anchoring the
 * split before block 4 puts pages 2-5's guide at the same boundary as page 1's
 * guide; anchoring after block 4 keeps the guides strictly ordered down the
 * document, which is what makes them readable at all.
 *
 * A page carrying no stamped block at all yields NO break rather than
 * inheriting its neighbour's index. That happens for a page filled entirely by
 * content `markdownToHtml` emits without a top-level source block of its own:
 * the generated footnotes `<section>` (mdast-util-to-hast builds it fresh at
 * the end of the document, so it has no single source node) and raw HTML
 * blocks (which reach hast as a `raw` string node, not an element, so there is
 * nothing to stamp before `hast-util-raw` re-parses them). Dropping the break
 * loses one guide; inventing a position for it would draw a wrong one.
 */
export function recoverPageBreaks(
  pageBlockIndices: readonly (readonly number[])[]
): PageBreakPosition[] {
  const breaks: PageBreakPosition[] = []
  for (let index = 0; index + 1 < pageBlockIndices.length; index += 1) {
    const current = pageBlockIndices[index]
    if (current.length === 0) continue
    const blockIndex = current[current.length - 1]
    const next = pageBlockIndices[index + 1]
    breaks.push({
      page: index + 1,
      blockIndex,
      splitsBlock: next.length > 0 && next[0] === blockIndex
    })
  }
  return breaks
}

/**
 * Collapses breaks that land on the same boundary into one guide, and drops
 * any whose block no longer exists in the live document.
 *
 * The collapse is what stops a single long block that spans five pages from
 * stacking five identical guides on one boundary; the resulting guide names
 * every page it covers, so the label can say "Pages 2-5" honestly instead of
 * showing "Page 2" four times.
 *
 * `blockCount` is the LIVE editor document's top-level node count, not the
 * count the render was computed from. Filtering against it is the staleness
 * guard: a recovered break describes the document as it was when the
 * (debounced) render was requested, and the caller has typically moved on by
 * the time it arrives. Intra-block typing leaves block indices valid, so
 * guides survive it (slightly stale in POSITION, which is the disclosed
 * "true but slightly stale" trade the design doc accepts); adding or removing
 * a block invalidates them, and the caller is expected to suppress the whole
 * set on a count mismatch rather than rely on this range check alone.
 */
export function groupPageGuides(
  breaks: readonly PageBreakPosition[],
  blockCount: number
): PageGuide[] {
  const byBlock = new Map<number, PageGuide>()
  for (const position of breaks) {
    if (position.blockIndex < 0 || position.blockIndex >= blockCount) continue
    const existing = byBlock.get(position.blockIndex)
    if (existing) {
      existing.pages.push(position.page)
      existing.splitsBlock = existing.splitsBlock || position.splitsBlock
      continue
    }
    byBlock.set(position.blockIndex, {
      blockIndex: position.blockIndex,
      pages: [position.page],
      splitsBlock: position.splitsBlock
    })
  }
  return [...byBlock.values()].sort((a, b) => a.blockIndex - b.blockIndex)
}
