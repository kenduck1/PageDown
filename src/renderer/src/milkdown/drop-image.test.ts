import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { editorViewCtx } from '@milkdown/core'
import { getMarkdown } from '@milkdown/utils'
import { createTestEditor } from './test-editor'
import { insertDroppedImages, type DropImageHandlers } from './drop-image'

afterEach(() => {
  cleanup()
})

// Only insertDroppedImages is tested here -- createDropImagePlugin's own
// `handleDOMEvents.drop` handler calls `view.posAtCoords`, which THROWS
// under jsdom (confirmed directly: `document.elementFromPoint is not a
// function`, since jsdom implements no real layout/hit-testing at all).
// insertDroppedImages is everything downstream of already knowing the
// insertion position, which jsdom genuinely can exercise -- see this
// function's own comment in drop-image.ts for the full split, matching
// commands.test.ts's identical "test the callback, gate covers the DOM
// wiring" precedent for historyKeymap.
describe('insertDroppedImages', () => {
  it('inserts a real markdown image reference at the given position for a successfully saved file', async () => {
    const editor = await createTestEditor('Hello world', [])
    const onDropImage = vi.fn().mockResolvedValue({ relativePath: 'photo.png' })
    const onError = vi.fn()
    const handlers: DropImageHandlers = { onDropImage, onError }
    const file = new File(['fake-bytes'], 'photo.png', { type: 'image/png' })

    await editor.action((ctx) =>
      insertDroppedImages(ctx.get(editorViewCtx), ctx, 0, [file], handlers)
    )

    expect(onDropImage).toHaveBeenCalledWith(file)
    expect(editor.action(getMarkdown())).toContain('![photo.png](photo.png)')
    expect(onError).not.toHaveBeenCalled()
  })

  it('inserts multiple dropped files in drop order, each a real distinct image node', async () => {
    const editor = await createTestEditor('', [])
    const onDropImage = vi
      .fn()
      .mockResolvedValueOnce({ relativePath: 'first.png' })
      .mockResolvedValueOnce({ relativePath: 'second.png' })
    const onError = vi.fn()
    const handlers: DropImageHandlers = { onDropImage, onError }
    const files = [
      new File(['a'], 'first.png', { type: 'image/png' }),
      new File(['b'], 'second.png', { type: 'image/png' })
    ]

    await editor.action((ctx) =>
      insertDroppedImages(ctx.get(editorViewCtx), ctx, 0, files, handlers)
    )

    const markdown = editor.action(getMarkdown())
    expect(markdown).toContain('![first.png](first.png)')
    expect(markdown).toContain('![second.png](second.png)')
    // Drop order preserved, not reversed by insertion-position arithmetic.
    expect(markdown.indexOf('first.png')).toBeLessThan(markdown.indexOf('second.png'))
  })

  it('surfaces a failed save via onError and inserts nothing for that file', async () => {
    const editor = await createTestEditor('Hello', [])
    const onDropImage = vi
      .fn()
      .mockResolvedValue({ error: 'Save the document before adding images.' })
    const onError = vi.fn()
    const handlers: DropImageHandlers = { onDropImage, onError }
    const file = new File(['fake-bytes'], 'photo.png', { type: 'image/png' })
    const before = editor.action(getMarkdown())

    await editor.action((ctx) =>
      insertDroppedImages(ctx.get(editorViewCtx), ctx, 0, [file], handlers)
    )

    expect(onError).toHaveBeenCalledWith('Save the document before adding images.')
    expect(editor.action(getMarkdown())).toBe(before)
  })

  it('continues inserting remaining files after one fails, rather than aborting the whole drop', async () => {
    const editor = await createTestEditor('', [])
    const onDropImage = vi
      .fn()
      .mockResolvedValueOnce({ error: 'That file does not look like a real image.' })
      .mockResolvedValueOnce({ relativePath: 'second.png' })
    const onError = vi.fn()
    const handlers: DropImageHandlers = { onDropImage, onError }
    const files = [
      new File(['a'], 'not-an-image.txt', { type: 'image/png' }),
      new File(['b'], 'second.png', { type: 'image/png' })
    ]

    await editor.action((ctx) =>
      insertDroppedImages(ctx.get(editorViewCtx), ctx, 0, files, handlers)
    )

    expect(onError).toHaveBeenCalledWith('That file does not look like a real image.')
    expect(editor.action(getMarkdown())).toContain('![second.png](second.png)')
  })
})
