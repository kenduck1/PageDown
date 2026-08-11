import { describe, expect, it } from 'vitest'
import {
  BLOCK_INDEX_ATTRIBUTE,
  groupPageGuides,
  readPageBlockIndices,
  recoverPageBreaks
} from './page-breaks'

// Builds one fake `.pagedjs_page` per entry. A number is a block index; a
// literal string is markup inserted verbatim, which is how the "content with
// no stamp at all" cases (the generated footnotes section, a raw HTML block)
// are exercised.
function buildPages(pages: Array<Array<number | string>>): HTMLElement[] {
  return pages.map((blocks) => {
    const page = document.createElement('div')
    page.innerHTML = blocks
      .map((block) =>
        typeof block === 'number' ? `<p ${BLOCK_INDEX_ATTRIBUTE}="${block}">x</p>` : block
      )
      .join('')
    return page
  })
}

describe('readPageBlockIndices', () => {
  it('reads the stamped indices on each page, in DOM order', () => {
    expect(
      readPageBlockIndices(
        buildPages([
          [0, 1, 2],
          [3, 4]
        ])
      )
    ).toEqual([
      [0, 1, 2],
      [3, 4]
    ])
  })

  it('keeps a duplicated index across two pages rather than deduplicating it', () => {
    // The duplicate IS the signal that Paged.js split the block, so
    // collapsing it would destroy the only evidence of the limitation the
    // whole feature has to disclose.
    expect(
      readPageBlockIndices(
        buildPages([
          [0, 1],
          [1, 2]
        ])
      )
    ).toEqual([
      [0, 1],
      [1, 2]
    ])
  })

  it('reports an empty list for a page carrying no stamped block', () => {
    expect(
      readPageBlockIndices(buildPages([[0], ['<section class="footnotes"><p>note</p></section>']]))
    ).toEqual([[0], []])
  })

  it('skips a malformed index rather than treating it as block 0', () => {
    // Mapping an unparseable value to 0 would draw a guide at the very top of
    // the document -- a confidently wrong position, which is worse than a
    // missing one.
    const pages = buildPages([
      [`<p ${BLOCK_INDEX_ATTRIBUTE}="oops">x</p>`, `<p ${BLOCK_INDEX_ATTRIBUTE}="-3">x</p>`, 4],
      [5]
    ])
    expect(readPageBlockIndices(pages)).toEqual([[4], [5]])
  })

  it('finds a stamped block nested inside Paged.js page wrappers', () => {
    // Paged.js nests real content several levels deep (.pagedjs_sheet >
    // .pagedjs_pagebox > .pagedjs_area > .pagedjs_page_content > div), so a
    // root-children-only read would find nothing at all.
    const pages = buildPages([
      [`<div><div><p ${BLOCK_INDEX_ATTRIBUTE}="7">deep</p></div></div>`],
      [8]
    ])
    expect(readPageBlockIndices(pages)).toEqual([[7], [8]])
  })
})

describe('recoverPageBreaks', () => {
  it('reports nothing for a single-page document', () => {
    expect(recoverPageBreaks([[0, 1, 2]])).toEqual([])
  })

  it('attributes a clean break to the last block on the ending page', () => {
    expect(
      recoverPageBreaks([
        [0, 1, 2],
        [3, 4]
      ])
    ).toEqual([{ page: 1, blockIndex: 2, splitsBlock: false }])
  })

  it('flags a break that falls inside a block', () => {
    expect(
      recoverPageBreaks([
        [0, 1],
        [1, 2]
      ])
    ).toEqual([{ page: 1, blockIndex: 1, splitsBlock: true }])
  })

  it('reports one break per transition, never one for the final page', () => {
    const breaks = recoverPageBreaks([[0], [1], [2], [3]])
    expect(breaks.map((b) => b.page)).toEqual([1, 2, 3])
  })

  it('reports the same block for every page a long block spans', () => {
    // The realistic case this exists for: one fenced code listing occupying
    // pages 2 through 4 in full. Every transition inside it is a split of the
    // same block, which is what lets groupPageGuides collapse them.
    expect(recoverPageBreaks([[0, 1], [1], [1], [1, 2]])).toEqual([
      { page: 1, blockIndex: 1, splitsBlock: true },
      { page: 2, blockIndex: 1, splitsBlock: true },
      { page: 3, blockIndex: 1, splitsBlock: true }
    ])
  })

  it('drops the break for a page with no stamped block rather than guessing', () => {
    // Page 2 is all footnotes section. Page 1's break is still reported (its
    // own last block is known); page 2's is not, because there is no honest
    // answer for it.
    expect(recoverPageBreaks([[0, 1], [], [2]])).toEqual([
      { page: 1, blockIndex: 1, splitsBlock: false }
    ])
  })
})

describe('groupPageGuides', () => {
  it('keeps distinct boundaries separate and sorts them by block index', () => {
    const guides = groupPageGuides(
      [
        { page: 2, blockIndex: 9, splitsBlock: false },
        { page: 1, blockIndex: 4, splitsBlock: false }
      ],
      20
    )
    expect(guides).toEqual([
      { blockIndex: 4, pages: [1], splitsBlock: false },
      { blockIndex: 9, pages: [2], splitsBlock: false }
    ])
  })

  it('collapses consecutive breaks inside one block into a single guide', () => {
    expect(
      groupPageGuides(
        [
          { page: 1, blockIndex: 1, splitsBlock: true },
          { page: 2, blockIndex: 1, splitsBlock: true },
          { page: 3, blockIndex: 1, splitsBlock: true }
        ],
        5
      )
    ).toEqual([{ blockIndex: 1, pages: [1, 2, 3], splitsBlock: true }])
  })

  it('marks a merged guide approximate when any of its breaks split the block', () => {
    expect(
      groupPageGuides(
        [
          { page: 1, blockIndex: 2, splitsBlock: false },
          { page: 2, blockIndex: 2, splitsBlock: true }
        ],
        5
      )[0].splitsBlock
    ).toBe(true)
  })

  it('drops an out-of-range block index', () => {
    // The last line of defence against an index arriving from the sandboxed
    // render context: positionAfterBlock would throw on doc.child(childCount).
    expect(
      groupPageGuides(
        [
          { page: 1, blockIndex: 3, splitsBlock: false },
          { page: 2, blockIndex: 99, splitsBlock: false },
          { page: 3, blockIndex: -1, splitsBlock: false }
        ],
        5
      )
    ).toEqual([{ blockIndex: 3, pages: [1], splitsBlock: false }])
  })
})
