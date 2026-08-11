import { describe, it, expect, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { getMarkdown } from '@milkdown/utils'
import { editorViewCtx } from '@milkdown/core'
import type { EditorView } from '@milkdown/prose/view'
import { createTestEditor } from '../test-editor'
import { EDITOR_SCHEMA_PLUGINS } from '../plugins'
import { EDITOR_COMMAND_PLUGINS } from '../commands'
import { markdownToHtml } from '../../../../markdown/pipeline'

afterEach(() => {
  cleanup()
})

// Schema-only for the round-trip half (that is what round-trip fidelity
// depends on), plus the behaviour half for the rendering assertions -- the
// <img> is drawn by image-security.ts's node view, which lives there.
const SCHEMA_ONLY = EDITOR_SCHEMA_PLUGINS.flat()
const FULL = [...SCHEMA_ONLY, ...EDITOR_COMMAND_PLUGINS]

async function roundTrip(source: string): Promise<string> {
  const editor = await createTestEditor(source, SCHEMA_ONLY)
  const result = editor.action(getMarkdown())
  await editor.destroy()
  return result
}

async function open(source: string, plugins = FULL): Promise<EditorView> {
  const editor = await createTestEditor(source, plugins)
  return editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
}

function imageAttrs(view: EditorView): Record<string, unknown> {
  let attrs: Record<string, unknown> | undefined
  view.state.doc.descendants((node) => {
    if (node.type.name === 'image') attrs = node.attrs
    return true
  })
  if (!attrs) throw new Error('no image node')
  return attrs
}

describe('Milkdown image width: round trip', () => {
  it('survives a Format-mode edit byte-for-byte', async () => {
    // THE assertion this half of the feature exists for. Without the `width`
    // attr on the ProseMirror node, remarkImageAttrs still recognizes the
    // block on parse and the editor still round-trips the DOCUMENT -- it just
    // silently drops the size, which is exactly the failure a byte test on a
    // document with no image would never see.
    expect(await roundTrip('![Logo](logo.png){width=50%}\n')).toBe('![Logo](logo.png){width=50%}\n')
  })

  it('normalizes an absolute unit once, then stays stable', async () => {
    // `{width=3in}` becomes `{width=288px}` on the first save (the same 96dpi
    // conversion every rendering surface applies) and then does not move
    // again -- a size that kept re-normalizing would make every save dirty.
    const once = await roundTrip('![Logo](logo.png){width=3in}\n')
    expect(once).toBe('![Logo](logo.png){width=288px}\n')
    expect(await roundTrip(once)).toBe(once)
  })

  it('stores the width as a real node attr, not as inert trailing text', async () => {
    // The node-types equivalent of CLAUDE.md's pagebreak trap: a document
    // whose `{width=50%}` came back as a text sibling would pass the byte test
    // above while being completely unwired.
    const view = await open('![Logo](logo.png){width=50%}\n', SCHEMA_ONLY)
    expect(imageAttrs(view).width).toBe('50%')
    const paragraph = view.state.doc.firstChild
    expect(paragraph?.childCount).toBe(1)
    expect(paragraph?.firstChild?.type.name).toBe('image')
  })

  it('leaves an image with no block completely untouched', async () => {
    expect(await roundTrip('![Logo](logo.png)\n')).toBe('![Logo](logo.png)\n')
    const view = await open('![Logo](logo.png)\n', SCHEMA_ONLY)
    expect(imageAttrs(view).width).toBe('')
  })

  it('keeps a title and prose around a sized image', async () => {
    const source = 'Before ![Logo](logo.png "A title"){width=200px} after.\n'
    expect(await roundTrip(source)).toBe(source)
  })

  it('leaves an unrecognized block as literal text on both sides', async () => {
    const source = '![Logo](logo.png){height=200px}\n'
    const view = await open(source, SCHEMA_ONLY)
    expect(imageAttrs(view).width).toBe('')
    expect(view.state.doc.textContent).toContain('{height=200px}')
    expect(await roundTrip(source)).toBe(source)
  })
})

describe('Milkdown image width: what the canvas actually renders', () => {
  it('puts the width on the real <img> as the same HTML attribute the paginator emits', async () => {
    // Editor/paginator parity, and the reason it has to be applied in the NODE
    // VIEW: that view takes priority over the schema's toDOM, so a width
    // applied only in toDOM would render on every surface except the canvas.
    const view = await open('![Logo](data:image/png;base64,iVBORw0KGgo=){width=50%}\n')
    const img = view.dom.querySelector('img')
    expect(img?.getAttribute('width')).toBe('50%')
  })

  it('emits no width attribute at all for an unsized image', async () => {
    const view = await open('![Logo](data:image/png;base64,iVBORw0KGgo=)\n')
    expect(view.dom.querySelector('img')?.hasAttribute('width')).toBe(false)
  })

  it('drops the attribute again when the width is cleared', async () => {
    const view = await open('![Logo](data:image/png;base64,iVBORw0KGgo=){width=50%}\n')
    let pos = -1
    view.state.doc.descendants((node, at) => {
      if (node.type.name === 'image') pos = at
      return true
    })
    const image = view.state.doc.nodeAt(pos)!
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...image.attrs, width: '' }))

    expect(view.dom.querySelector('img')?.hasAttribute('width')).toBe(false)
  })

  it('does not leave a stray empty width on a copied image (toDOM path)', async () => {
    // The schema's toDOM spreads `...node.attrs`, so without the explicit
    // delete an unsized image would serialize to `width=""` -- which parseDOM
    // reads straight back in, making every pasted image look sized.
    const view = await open('![Logo](logo.png)\n', SCHEMA_ONLY)
    const image = view.state.doc.firstChild!.firstChild!
    const rendered = image.type.spec.toDOM!(image) as [string, Record<string, unknown>]
    expect('width' in rendered[1]).toBe(false)
  })
})

describe('Milkdown image width: the two surfaces agree', () => {
  // The Gate 10 question, asked directly and cheaply. Gate 10 pins the editor
  // and the paginator at 0.000px, so an image sized on only one surface would
  // be a large, obvious divergence -- but Gate 10's own fixture (REPORT_TEMPLATE)
  // contains no images at all, so it structurally cannot catch this. jsdom has
  // no layout engine either, so what CAN be asserted here is the thing that
  // actually decides the layout: both surfaces put the identical value in the
  // identical HTML `width` attribute, and neither has any other sizing
  // mechanism (no style attribute, no class, no inline CSS anywhere).
  const CASES = ['50%', '200px', '3in', '144pt', '2cm']

  for (const written of CASES) {
    it(`resolves {width=${written}} to the same attribute on both surfaces`, async () => {
      const source = `![Logo](data:image/png;base64,iVBORw0KGgo=){width=${written}}`

      const paginated = /<img[^>]*\swidth="([^"]*)"/.exec(markdownToHtml(source).html)?.[1]
      const view = await open(`${source}\n`)
      const canvas = view.dom.querySelector('img')?.getAttribute('width')

      expect(paginated).toBeDefined()
      expect(canvas).toBe(paginated)
    })
  }

  it('and neither surface reaches for a style attribute or a generated class to do it', async () => {
    const source = '![Logo](data:image/png;base64,iVBORw0KGgo=){width=50%}'
    expect(markdownToHtml(source).html).not.toContain('style=')

    const view = await open(`${source}\n`)
    const img = view.dom.querySelector('img')!
    expect(img.getAttribute('style')).toBeNull()
    // `.pagedown-image` is image-security.ts's own wrapper, present for every
    // image sized or not -- the <img> itself carries no sizing class.
    expect(img.className).toBe('')
  })
})
