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
  type PageGuideInput
} from './page-guide-plugin'
import type { PageBreakPosition } from '../../../pagination/page-breaks'

afterEach(() => {
  cleanup()
})

// Three top-level blocks, so a guide can sit after any of them.
const SOURCE = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n'

async function mount(): Promise<{ view: EditorView; destroy: () => Promise<void> }> {
  const editor = await createTestEditor(SOURCE, [$prose(() => createPageGuidePlugin())])
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
