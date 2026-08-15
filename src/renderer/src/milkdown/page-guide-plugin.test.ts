import { describe, it, expect, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { editorViewCtx } from '@milkdown/core'
import { $prose } from '@milkdown/utils'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { createTestEditor } from './test-editor'
import {
  applyPageGuides,
  buildPageGuideDecorations,
  createPageGuidePlugin,
  formatPageGuideLabel,
  pageGuidePluginKey,
  PAGE_GUIDE_CLASS,
  PAGE_SEAM_GUTTER_CLASS,
  type PageGuideInput
} from './page-guide-plugin'
import type { PageBreakPosition } from '../../../pagination/page-breaks'

afterEach(() => {
  cleanup()
})

// Three top-level blocks, so a guide can sit after any of them.
const SOURCE = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n'

async function mount(
  onSeamCountChanged?: (count: number) => void
): Promise<{ view: EditorView; destroy: () => Promise<void> }> {
  const editor = await createTestEditor(SOURCE, [
    $prose(() => createPageGuidePlugin(onSeamCountChanged))
  ])
  let view: EditorView | null = null
  editor.action((ctx) => {
    view = ctx.get(editorViewCtx)
  })
  if (!view) throw new Error('editor view was not available after create()')
  return {
    view,
    destroy: async () => {
      await editor.destroy()
    }
  }
}

function guideElements(view: EditorView): HTMLElement[] {
  return Array.from(view.dom.querySelectorAll<HTMLElement>(`.${PAGE_GUIDE_CLASS}`))
}

function input(breaks: PageBreakPosition[], blockCount = 3): PageGuideInput {
  return { breaks, blockCount }
}

describe('formatPageGuideLabel', () => {
  it('states a clean break as fact', () => {
    expect(formatPageGuideLabel({ blockIndex: 1, pages: [1], splitsBlock: false })).toBe(
      'Page 1 ends here'
    )
  })

  // These two are the feature's honesty contract, not cosmetics: the editor
  // has no sub-block coordinate to draw at, so a break inside a block is
  // reported AS approximate rather than presented as exact (design:69).
  it('says so when the break falls inside the block', () => {
    expect(formatPageGuideLabel({ blockIndex: 1, pages: [2], splitsBlock: true })).toBe(
      'Page 2 ends inside this block'
    )
  })

  it('names the whole range when several pages break inside one block', () => {
    expect(formatPageGuideLabel({ blockIndex: 1, pages: [2, 3, 4], splitsBlock: true })).toBe(
      'Pages 2–4 end inside this block'
    )
  })
})

describe('buildPageGuideDecorations', () => {
  it('places a guide at the boundary after the named block', async () => {
    const { view, destroy } = await mount()
    try {
      const doc = view.state.doc
      const set = buildPageGuideDecorations(
        doc,
        input([{ page: 1, blockIndex: 0, splitsBlock: false }])
      )
      const found = set.find()
      expect(found).toHaveLength(1)
      // Position after the first top-level node is exactly that node's size.
      expect(found[0].from).toBe(doc.child(0).nodeSize)
    } finally {
      await destroy()
    }
  })

  // The structural staleness guard. This is the single most important
  // behaviour in the file: a stale break set describes a document whose
  // blocks have since shifted, so every guide below the edit would be drawn
  // somewhere wrong. No guide beats a wrong guide.
  it('suppresses every guide when the block count no longer matches the document', async () => {
    const { view, destroy } = await mount()
    try {
      const stale = buildPageGuideDecorations(
        view.state.doc,
        input([{ page: 1, blockIndex: 0, splitsBlock: false }], 7)
      )
      expect(stale.find()).toHaveLength(0)
    } finally {
      await destroy()
    }
  })

  it('renders an approximate guide with a distinguishing class and label', async () => {
    const { view, destroy } = await mount()
    try {
      const set = buildPageGuideDecorations(
        view.state.doc,
        input([{ page: 2, blockIndex: 1, splitsBlock: true }])
      )
      const [decoration] = set.find()
      const dom = (decoration as unknown as { type: { toDOM: HTMLElement | (() => HTMLElement) } })
        .type.toDOM
      const element = typeof dom === 'function' ? dom() : dom
      expect(element.className).toContain('is-approximate')
      expect(element.textContent).toBe('Page 2 ends inside this block')
      // Widget DOM is not part of the document; without this a caret can land
      // in it and typing produces mutations against a node that does not exist.
      expect(element.getAttribute('contenteditable')).toBe('false')
    } finally {
      await destroy()
    }
  })
})

describe('the seam a guide actually draws', () => {
  // The guide used to be a zero-height absolutely-positioned hairline. It is
  // now a real page BOUNDARY that occupies real vertical space -- the ending
  // page's remaining bottom margin, a gutter, and the starting page's top
  // margin. Its height comes from CSS custom properties (base.css reading
  // pageSeamCssVariables), so jsdom cannot measure it; what IS checkable here
  // is that the structure those rules target really gets built.
  it('builds a gutter band, with the label inside it', async () => {
    const { view, destroy } = await mount()
    try {
      applyPageGuides(view, input([{ page: 1, blockIndex: 0, splitsBlock: false }]))
      const [seam] = guideElements(view)
      const gutter = seam.querySelector(`.${PAGE_SEAM_GUTTER_CLASS}`)
      expect(gutter, 'the seam must contain the gutter band base.css sizes').not.toBeNull()
      // Inside the gutter, not beside it: there is a real band to caption now,
      // and a caption inside it cannot overlap document text.
      expect(gutter?.textContent).toBe('Page 1 ends here')
    } finally {
      await destroy()
    }
  })

  it('keeps the approximate marker on the OUTER element, where the CSS looks for it', async () => {
    // base.css restyles the gutter's edges via
    // `.pagedown-page-guide.is-approximate .pagedown-page-seam-gutter`, so
    // moving the class onto the gutter itself would silently stop the
    // approximate boundary from looking any different -- while leaving the
    // label (the other half of the honesty contract) still correct, which is
    // exactly the kind of half-failure that ships.
    const { view, destroy } = await mount()
    try {
      applyPageGuides(view, input([{ page: 2, blockIndex: 1, splitsBlock: true }]))
      const [seam] = guideElements(view)
      expect(seam.classList.contains('is-approximate')).toBe(true)
      expect(seam.querySelector(`.${PAGE_SEAM_GUTTER_CLASS}`)?.className).toBe(
        PAGE_SEAM_GUTTER_CLASS
      )
    } finally {
      await destroy()
    }
  })
})

describe('the drawn-seam count reported back to the page card', () => {
  it('reports zero on mount, then the real drawn count', async () => {
    const counts: number[] = []
    const { view, destroy } = await mount((count) => counts.push(count))
    try {
      // Seeded at -1 inside the plugin precisely so this first zero fires:
      // EditorScreen starts from its own default and this is what makes the
      // two provably agree rather than agree by coincidence.
      expect(counts).toEqual([0])
      applyPageGuides(
        view,
        input([
          { page: 1, blockIndex: 0, splitsBlock: false },
          { page: 2, blockIndex: 1, splitsBlock: false }
        ])
      )
      expect(counts).toEqual([0, 2])
    } finally {
      await destroy()
    }
  })

  it('reports the COLLAPSED count, not the number of breaks', async () => {
    // The reason this is a callback from the plugin at all rather than
    // `pageGuides.breaks.length` computed in EditorScreen: several pages
    // breaking inside one block collapse onto ONE boundary (groupPageGuides),
    // so a card sized from the break count would be two sheets too tall.
    const counts: number[] = []
    const { view, destroy } = await mount((count) => counts.push(count))
    try {
      applyPageGuides(
        view,
        input([
          { page: 1, blockIndex: 1, splitsBlock: true },
          { page: 2, blockIndex: 1, splitsBlock: true },
          { page: 3, blockIndex: 1, splitsBlock: true }
        ])
      )
      expect(guideElements(view)).toHaveLength(1)
      expect(counts.at(-1)).toBe(1)
    } finally {
      await destroy()
    }
  })

  it('reports zero again when the guides fail closed on a stale block count', async () => {
    // The card must shrink back with the seams. A five-sheet-tall card with no
    // boundaries drawn in it is unexplained blank paper -- the exact
    // wrong-layout-with-no-explanation outcome the fail-closed guard exists
    // to prevent, just relocated to the card's height.
    const counts: number[] = []
    const { view, destroy } = await mount((count) => counts.push(count))
    try {
      applyPageGuides(view, input([{ page: 1, blockIndex: 0, splitsBlock: false }]))
      expect(counts.at(-1)).toBe(1)
      // A structural edit: split the first paragraph in two, so doc.childCount
      // no longer matches the count the breaks were computed from.
      view.dispatch(view.state.tr.split(3))
      expect(guideElements(view)).toHaveLength(0)
      expect(counts.at(-1)).toBe(0)
    } finally {
      await destroy()
    }
  })

  it('does not re-report an unchanged count', async () => {
    const counts: number[] = []
    const { view, destroy } = await mount((count) => counts.push(count))
    try {
      const guides = input([{ page: 1, blockIndex: 0, splitsBlock: false }])
      applyPageGuides(view, guides)
      const afterFirst = counts.length
      // A no-op re-apply, then an intra-block edit that leaves every index
      // valid. Neither changes how many seams are drawn, so neither may cost
      // the page card a re-render -- this fires on a ~500ms tick.
      applyPageGuides(view, guides)
      view.dispatch(view.state.tr.insertText('x', 3))
      expect(counts.length).toBe(afterFirst)
    } finally {
      await destroy()
    }
  })
})

describe('createPageGuidePlugin / applyPageGuides', () => {
  it('renders a real guide element into the live editor DOM', async () => {
    const { view, destroy } = await mount()
    try {
      expect(guideElements(view)).toHaveLength(0)
      applyPageGuides(view, input([{ page: 1, blockIndex: 0, splitsBlock: false }]))
      expect(guideElements(view)).toHaveLength(1)
      expect(guideElements(view)[0].textContent).toBe('Page 1 ends here')
    } finally {
      await destroy()
    }
  })

  // Mirrors find-plugin.ts's own load-bearing invariant, asserted the same
  // way: a guide appearing must never make a clean document look edited. The
  // transaction carries no steps at all, so MilkdownEditor's own
  // `docChanged || storedMarksSet` dirty predicate cannot see it.
  it('applies guides through a transaction that cannot mark the document dirty', async () => {
    const { view, destroy } = await mount()
    try {
      const seen: boolean[] = []
      const dispatch = view.dispatch.bind(view)
      view.dispatch = (tr) => {
        // MilkdownEditor's own editedSinceMountRef predicate, restated
        // verbatim rather than approximated -- that is the thing this
        // transaction must not trip, so it is the thing to assert.
        seen.push((tr.docChanged || tr.storedMarksSet) && tr.getMeta('addToHistory') !== false)
        dispatch(tr)
      }
      applyPageGuides(view, input([{ page: 1, blockIndex: 0, splitsBlock: false }]))
      expect(seen).toHaveLength(1)
      expect(seen[0]).toBe(false)
    } finally {
      await destroy()
    }
  })

  it('does not dispatch at all when the guides have not changed', async () => {
    const { view, destroy } = await mount()
    try {
      const breaks = [{ page: 1, blockIndex: 0, splitsBlock: false }]
      applyPageGuides(view, input(breaks))
      let dispatches = 0
      const dispatch = view.dispatch.bind(view)
      view.dispatch = (tr) => {
        dispatches += 1
        dispatch(tr)
      }
      // A fresh but equal object -- the ~500ms page-count tick produces one of
      // these on every cycle of an idle document.
      applyPageGuides(view, input([{ page: 1, blockIndex: 0, splitsBlock: false }]))
      expect(dispatches).toBe(0)
    } finally {
      await destroy()
    }
  })

  // A structural edit invalidates every index after it, and the plugin has to
  // notice IMMEDIATELY rather than leaving stale guides on screen for the
  // ~500ms+ until the next render settles.
  it('drops the guides as soon as an edit changes the block count', async () => {
    const { view, destroy } = await mount()
    try {
      applyPageGuides(view, input([{ page: 1, blockIndex: 0, splitsBlock: false }]))
      expect(guideElements(view)).toHaveLength(1)

      // Deleting a whole top-level node, which is what an edit that changes
      // the block COUNT looks like -- note `insertText('\n\n...')` does NOT
      // do this: a newline inside a textblock is plain text to ProseMirror,
      // not a block split.
      view.dispatch(view.state.tr.delete(0, view.state.doc.child(0).nodeSize))
      expect(view.state.doc.childCount).toBe(2)
      expect(guideElements(view)).toHaveLength(0)
    } finally {
      await destroy()
    }
  })

  // The complement of the test above, and the reason the guard is a COUNT
  // check rather than a content check: typing inside a block leaves every
  // index valid, so the guides must survive it. This is the disclosed
  // "true but slightly stale" behaviour (design:71) -- the guide keeps its
  // boundary while the real break may have drifted a line.
  it('keeps the guides through an edit that does not change the block count', async () => {
    const { view, destroy } = await mount()
    try {
      applyPageGuides(view, input([{ page: 1, blockIndex: 0, splitsBlock: false }]))
      expect(guideElements(view)).toHaveLength(1)

      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)).insertText('More. ')
      )
      expect(view.state.doc.childCount).toBe(3)
      expect(guideElements(view)).toHaveLength(1)
    } finally {
      await destroy()
    }
  })

  it('exposes its state under the shared plugin key', async () => {
    const { view, destroy } = await mount()
    try {
      applyPageGuides(view, input([{ page: 1, blockIndex: 1, splitsBlock: true }]))
      expect(pageGuidePluginKey.getState(view.state)?.input.breaks).toEqual([
        { page: 1, blockIndex: 1, splitsBlock: true }
      ])
    } finally {
      await destroy()
    }
  })
})
