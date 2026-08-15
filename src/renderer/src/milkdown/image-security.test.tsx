import { describe, expect, it, afterEach, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { getMarkdown } from '@milkdown/utils'
import { createImageResolverPlugin, isSafeImageSrc, safeImageViewProse } from './image-security'
import MilkdownEditor from './MilkdownEditor'
import { createTestEditor } from './test-editor'
import { historyGroupingProse, historyProse } from './commands'
import { $prose } from '@milkdown/utils'
import { editorViewCtx } from '@milkdown/core'
import { EDITOR_SCHEMA_PLUGINS } from './plugins'
import { computePageGeometry } from '../../../typography/page-geometry'
import { DEFAULT_DOCUMENT_STYLE } from '../../../typography/document-style'
import { DEFAULT_PAGE_CONFIG } from '../../../markdown/page-config'

// MilkdownEditor's `geometry` prop (Page Geometry Wiring sub-project) sizes
// the mount's own text column. Nothing in this file is about page sizing, so
// every mount here takes the Letter/1in default -- exactly what a document
// with no page frontmatter resolves to.
const DEFAULT_GEOMETRY = computePageGeometry(DEFAULT_PAGE_CONFIG)

afterEach(() => {
  cleanup()
})

describe('isSafeImageSrc', () => {
  it('allows a data: image URI', () => {
    expect(isSafeImageSrc('data:image/png;base64,iVBORw0KGgo=')).toBe(true)
  })

  it('blocks a remote http(s) URL', () => {
    expect(isSafeImageSrc('http://evil.example.com/track.png')).toBe(false)
    expect(isSafeImageSrc('https://evil.example.com/track.png')).toBe(false)
  })

  it('blocks a local file:// URL', () => {
    expect(isSafeImageSrc('file:///etc/passwd')).toBe(false)
  })

  it('blocks a bare relative path', () => {
    expect(isSafeImageSrc('./figures/chart.png')).toBe(false)
    expect(isSafeImageSrc('../assets/photo.jpg')).toBe(false)
  })

  it('blocks an empty string', () => {
    expect(isSafeImageSrc('')).toBe(false)
  })

  it('blocks a data: URI that is not an image (defense in depth)', () => {
    expect(isSafeImageSrc('data:text/html,<script>alert(1)</script>')).toBe(false)
  })
})

describe('image node view — real editor mount', () => {
  it('never assigns an unsafe src to the actual rendered <img> element (file:)', async () => {
    const content = '![local](file:///etc/hosts)\n'
    render(
      <MilkdownEditor
        geometry={DEFAULT_GEOMETRY}
        documentStyle={DEFAULT_DOCUMENT_STYLE}
        content={content}
        onChange={() => {}}
        onError={() => {}}
      />
    )

    await waitFor(() => {
      expect(document.querySelector('.milkdown-mount img')).toBeInTheDocument()
    })

    const img = document.querySelector('.milkdown-mount img') as HTMLImageElement
    expect(img.getAttribute('src')).not.toBe('file:///etc/hosts')
    expect(img.src).not.toContain('file:///etc/hosts')
  })

  it('never assigns an unsafe src to the actual rendered <img> element (http:)', async () => {
    const content = '![remote](http://evil.example.com/track.png)\n'
    render(
      <MilkdownEditor
        geometry={DEFAULT_GEOMETRY}
        documentStyle={DEFAULT_DOCUMENT_STYLE}
        content={content}
        onChange={() => {}}
        onError={() => {}}
      />
    )

    await waitFor(() => {
      expect(document.querySelector('.milkdown-mount img')).toBeInTheDocument()
    })

    const img = document.querySelector('.milkdown-mount img') as HTMLImageElement
    expect(img.getAttribute('src')).not.toBe('http://evil.example.com/track.png')
    expect(img.src).not.toContain('evil.example.com')
  })

  it('allows a data: image URI through to the rendered <img> element', async () => {
    const dataUri =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const content = `![local](${dataUri})\n`
    render(
      <MilkdownEditor
        geometry={DEFAULT_GEOMETRY}
        documentStyle={DEFAULT_DOCUMENT_STYLE}
        content={content}
        onChange={() => {}}
        onError={() => {}}
      />
    )

    await waitFor(() => {
      expect(document.querySelector('.milkdown-mount img')).toBeInTheDocument()
    })

    const img = document.querySelector('.milkdown-mount img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe(dataUri)
  })

  it('round-trips the ORIGINAL src back out through getMarkdown -- sanitization is render-only, not data loss', async () => {
    // The node view (safeImageViewProse, EDITOR_COMMAND_PLUGINS) only
    // intercepts DOM rendering -- it's deliberately excluded from
    // EDITOR_SCHEMA_PLUGINS (see plugins.ts/commands.ts's own comments), so
    // parseMarkdown/toMarkdown are completely untouched by it. This test
    // uses ONLY EDITOR_SCHEMA_PLUGINS (no safeImageViewProse at all,
    // matching round-trip.test.ts's own pattern) to confirm the document's
    // real content -- what actually gets saved to disk -- still contains the
    // original, unmodified image reference. Sanitizing what's SHOWN must
    // never silently rewrite what's SAVED.
    const source = '![local](file:///etc/hosts)\n'
    const editor = await createTestEditor(source, EDITOR_SCHEMA_PLUGINS.flat())
    const output = editor.action(getMarkdown())
    await editor.destroy()

    expect(output).toContain('file:///etc/hosts')
  })
})

describe('local image resolution — real editor mount', () => {
  // A real, minimal 1x1 PNG, so a resolved image is a genuinely decodable
  // data: URI rather than a string that merely starts with the right prefix.
  // A second, distinguishable data: image, for the stale-resolution race.
  const SECOND_PNG = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
  const RESOLVED_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

  function mountWithResolver(
    content: string,
    onResolveLocalImage: (src: string) => Promise<string | null>
  ): void {
    render(
      <MilkdownEditor
        geometry={DEFAULT_GEOMETRY}
        documentStyle={DEFAULT_DOCUMENT_STYLE}
        content={content}
        onChange={() => {}}
        onError={() => {}}
        onResolveLocalImage={onResolveLocalImage}
      />
    )
  }

  async function mountedImage(): Promise<HTMLImageElement> {
    await waitFor(() => {
      expect(document.querySelector('.milkdown-mount img')).toBeInTheDocument()
    })
    return document.querySelector('.milkdown-mount img') as HTMLImageElement
  }

  it('renders a relative local image once main resolves it to a data: URI', async () => {
    mountWithResolver('![chart](figures/chart.png)\n', async () => RESOLVED_PNG)

    const img = await mountedImage()
    await waitFor(() => {
      expect(img.getAttribute('src')).toBe(RESOLVED_PNG)
    })
    expect(img.closest('.pagedown-image')?.getAttribute('data-state')).toBe('ok')
  })

  it('asks the resolver for the ORIGINAL relative src, exactly as authored', async () => {
    const resolve = vi.fn(async () => RESOLVED_PNG)
    mountWithResolver('![chart](figures/chart.png)\n', resolve)

    await mountedImage()
    await waitFor(() => {
      expect(resolve).toHaveBeenCalledWith('figures/chart.png')
    })
  })

  // The security invariant this whole file exists for, restated for the new
  // capability: the relative path must NEVER reach the element, not even for
  // the moment before resolution lands. A relative src in this renderer
  // resolves against the app's own file:// origin.
  it('never puts the raw relative path on the element while resolving', async () => {
    let release: (value: string | null) => void = () => {}
    mountWithResolver(
      '![chart](figures/chart.png)\n',
      () =>
        new Promise<string | null>((resolve) => {
          release = resolve
        })
    )

    const img = await mountedImage()
    expect(img.getAttribute('src')).toBeNull()
    expect(img.src).not.toContain('figures/chart.png')
    expect(img.closest('.pagedown-image')?.getAttribute('data-state')).toBe('pending')

    release(RESOLVED_PNG)
    await waitFor(() => {
      expect(img.getAttribute('src')).toBe(RESOLVED_PNG)
    })
  })

  it('shows an honest "not found" note when the resolver declines, not a silent blank', async () => {
    mountWithResolver('![chart](missing.png)\n', async () => null)

    const img = await mountedImage()
    await waitFor(() => {
      expect(img.closest('.pagedown-image')?.getAttribute('data-state')).toBe('missing')
    })
    const note = document.querySelector('.pagedown-image-note') as HTMLElement
    expect(note.hidden).toBe(false)
    expect(note.textContent).toContain('Image not found')
    expect(note.textContent).toContain('missing.png')
    expect(img.getAttribute('src')).toBeNull()
  })

  // Defence in depth against the OTHER side of the bridge: this is the one
  // place a value from outside this module reaches a live `src`, so it is
  // re-checked rather than trusted.
  it('refuses a resolver result that is not a data: image URI', async () => {
    mountWithResolver('![chart](chart.png)\n', async () => 'file:///etc/hosts')

    const img = await mountedImage()
    await waitFor(() => {
      expect(img.closest('.pagedown-image')?.getAttribute('data-state')).toBe('missing')
    })
    expect(img.getAttribute('src')).toBeNull()
    expect(img.src).not.toContain('/etc/hosts')
  })

  it('never asks the resolver about a remote src, so consent cannot be routed around', async () => {
    const resolve = vi.fn(async () => RESOLVED_PNG)
    mountWithResolver('![tracker](https://evil.example.com/track.png)\n', resolve)

    const img = await mountedImage()
    await waitFor(() => {
      expect(img.closest('.pagedown-image')?.getAttribute('data-state')).toBe('blocked')
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(img.getAttribute('src')).toBeNull()
    expect(document.querySelector('.pagedown-image-note')?.textContent).toContain('Remote image')
  })

  it('never asks the resolver about a file: src either', async () => {
    const resolve = vi.fn(async () => RESOLVED_PNG)
    mountWithResolver('![local](file:///etc/hosts)\n', resolve)

    const img = await mountedImage()
    await waitFor(() => {
      expect(img.closest('.pagedown-image')?.getAttribute('data-state')).toBe('blocked')
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(document.querySelector('.pagedown-image-note')?.textContent).toContain(
      'blocked for security'
    )
  })

  // Without a host-supplied resolver (the round-trip/schema tests compose only
  // EDITOR_SCHEMA_PLUGINS) nothing throws and nothing unsafe renders -- it
  // degrades to exactly the pre-existing behaviour.
  it('degrades to "missing" with no resolver wired up at all', async () => {
    render(
      <MilkdownEditor
        geometry={DEFAULT_GEOMETRY}
        documentStyle={DEFAULT_DOCUMENT_STYLE}
        content={'![chart](chart.png)\n'}
        onChange={() => {}}
        onError={() => {}}
      />
    )

    const img = await mountedImage()
    await waitFor(() => {
      expect(img.closest('.pagedown-image')?.getAttribute('data-state')).toBe('missing')
    })
    expect(img.getAttribute('src')).toBeNull()
  })

  // The lifecycle hazard EditorScreen's key={revision} remount creates: a
  // resolution can land after its own editor has gone away. Note what this
  // does and does NOT claim. Milkdown's own destroy() is asynchronous
  // (MilkdownEditor's cleanup calls it with `void`), so a resolution landing
  // in the window right after React unmounts can still find the node view
  // alive and will still assign to its <img>. That is harmless and is not
  // what the guard is for: the element is already detached from the document
  // by then, holds no listeners and no timers, and a `data:` URI needs no
  // revoking (which is exactly why the resolver returns one rather than a
  // blob: URL -- see lib/local-image-cache.ts). What must not happen is a
  // throw, which in this environment would surface as an unhandled rejection.
  it('survives a resolution that lands after the editor was unmounted', async () => {
    let release: (value: string | null) => void = () => {}
    const { unmount } = render(
      <MilkdownEditor
        geometry={DEFAULT_GEOMETRY}
        documentStyle={DEFAULT_DOCUMENT_STYLE}
        content={'![chart](chart.png)\n'}
        onChange={() => {}}
        onError={() => {}}
        onResolveLocalImage={() =>
          new Promise<string | null>((resolve) => {
            release = resolve
          })
        }
      />
    )

    await mountedImage()
    unmount()
    expect(document.querySelector('.milkdown-mount')).not.toBeInTheDocument()

    release(RESOLVED_PNG)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Reaching here at all is the assertion: no throw, no unhandled rejection.
    expect(document.querySelector('.milkdown-mount')).not.toBeInTheDocument()
  })

  // The race the generation counter actually exists for, and the one with a
  // user-visible wrong answer: edit an image's URL while the OLD reference is
  // still resolving, and without the guard the old bytes land on the new
  // reference. Driven through a real editor + a real setNodeMarkup
  // transaction (which is what makes ProseMirror reuse the node view via
  // update() rather than rebuilding it) because that reuse is the whole
  // mechanism under test.
  it('discards a stale resolution when the image src changed while it was in flight', async () => {
    const pending = new Map<string, (value: string | null) => void>()
    const editor = await createTestEditor('![chart](first.png)\n', [
      safeImageViewProse,
      $prose(() =>
        createImageResolverPlugin({
          resolveLocalImage: (src) =>
            new Promise<string | null>((resolve) => {
              pending.set(src, resolve)
            })
        })
      )
    ])

    try {
      await waitFor(() => {
        expect(pending.has('first.png')).toBe(true)
      })

      const view = editor.ctx.get(editorViewCtx)
      const img = view.dom.querySelector('img') as HTMLImageElement

      // Retarget the SAME image node at a different file, exactly as editing
      // its URL would.
      let imagePos = -1
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'image') imagePos = pos
      })
      expect(imagePos).toBeGreaterThanOrEqual(0)
      const imageNode = view.state.doc.nodeAt(imagePos)!
      view.dispatch(
        view.state.tr.setNodeMarkup(imagePos, undefined, { ...imageNode.attrs, src: 'second.png' })
      )

      await waitFor(() => {
        expect(pending.has('second.png')).toBe(true)
      })

      // The OLD request completes last. Without the generation guard its
      // bytes would win, leaving `first.png`'s image showing for a reference
      // that now points at `second.png`.
      pending.get('second.png')!(SECOND_PNG)
      pending.get('first.png')!(RESOLVED_PNG)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(img.getAttribute('src')).toBe(SECOND_PNG)
    } finally {
      await editor.destroy()
    }
  })
})

// ---------------------------------------------------------------------------
// Drag-to-resize
// ---------------------------------------------------------------------------
// jsdom has no layout engine, so every rect here is stubbed and every number
// is one this file supplies. That is a real limit and is why
// tests/gates/gate41-image-resize.spec.ts exists: only real Chromium can say
// whether a real pointer drag lands on a real grip at a real corner. What IS
// provable here is the wiring the gate cannot isolate -- how many transactions
// a whole gesture produces, what ends up in the SAVED MARKDOWN, and that one
// undo reverts the whole drag rather than one frame of it.
const A_PNG = 'data:image/png;base64,iVBORw0KGgo='

function stubRect(element: Element, width: number): void {
  element.getBoundingClientRect = (() => ({ width, height: 10, top: 0, left: 0 })) as never
}

function drag(handle: Element, xs: number[]): void {
  handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: xs[0] }))
  for (const x of xs.slice(1)) {
    window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x }))
  }
  window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: xs[xs.length - 1] }))
}

describe('image drag-to-resize wiring', () => {
  it('offers a grip on a rendering image and withholds it from one that is not', async () => {
    const editor = await createTestEditor(
      `![ok](${A_PNG})\n\n![blocked](https://example.invalid/x.png)\n`,
      [...EDITOR_SCHEMA_PLUGINS.flat(), safeImageViewProse]
    )
    try {
      const view = editor.ctx.get(editorViewCtx)
      const wrappers = Array.from(view.dom.querySelectorAll('.pagedown-image'))
      const handles = wrappers.map((w) => w.querySelector('.pagedown-image-resize-handle'))

      expect(handles.every(Boolean)).toBe(true)
      // There is no corner to grab on an image that is not on screen, and the
      // width a drag would start from is not knowable for one.
      expect(wrappers.map((w) => w.getAttribute('data-state'))).toEqual(['ok', 'blocked'])
      expect(handles.map((h) => (h as HTMLElement).hidden)).toEqual([false, true])
    } finally {
      await editor.destroy()
    }
  })

  it('writes the dragged size as real {width=...} Markdown, in ONE transaction', async () => {
    const editor = await createTestEditor(`![ok](${A_PNG})\n`, [
      ...EDITOR_SCHEMA_PLUGINS.flat(),
      safeImageViewProse
    ])
    try {
      const view = editor.ctx.get(editorViewCtx)
      const wrapper = view.dom.querySelector('.pagedown-image') as HTMLElement
      const img = wrapper.querySelector('img') as HTMLImageElement
      const handle = wrapper.querySelector('.pagedown-image-resize-handle') as HTMLElement

      // 600px container, image starting at 300px (= 50%), dragged +120px.
      stubRect(wrapper.parentElement!, 600)
      stubRect(img, 300)

      const dispatched: unknown[] = []
      const original = view.dispatch.bind(view)
      view.dispatch = (tr): void => {
        dispatched.push(tr)
        original(tr)
      }

      drag(handle, [0, 40, 80, 120])

      // THE assertion this feature exists for, and the one that separates it
      // from the mistake columnResizingPlugin was not built to repeat: the
      // resize has to survive as portable Markdown, not as a ProseMirror-only
      // attribute the paginator, the PDF and the thumbnails all know nothing
      // about.
      expect(editor.action(getMarkdown())).toBe(`![ok](${A_PNG}){width=70%}\n`)

      // Exactly one transaction for the whole gesture -- the live feedback
      // during the drag is DOM-only. Three pointermoves producing three
      // transactions would be three undo steps and three debounced
      // re-serializations of the document.
      expect(dispatched).toHaveLength(1)
    } finally {
      await editor.destroy()
    }
  })

  it('is one undo step for the whole gesture, not one per frame', async () => {
    const { undo } = await import('@milkdown/prose/history')
    const editor = await createTestEditor(`![ok](${A_PNG})\n`, [
      ...EDITOR_SCHEMA_PLUGINS.flat(),
      safeImageViewProse,
      historyProse,
      historyGroupingProse
    ])
    try {
      const view = editor.ctx.get(editorViewCtx)
      const wrapper = view.dom.querySelector('.pagedown-image') as HTMLElement
      stubRect(wrapper.parentElement!, 600)
      stubRect(wrapper.querySelector('img')!, 300)

      drag(wrapper.querySelector('.pagedown-image-resize-handle') as HTMLElement, [0, 40, 80, 120])
      expect(editor.action(getMarkdown())).toContain('{width=70%}')

      undo(view.state, view.dispatch)
      // Back to the original size in ONE undo. Under a transaction-per-frame
      // implementation this would land on an intermediate width instead.
      expect(editor.action(getMarkdown())).toBe(`![ok](${A_PNG})\n`)
    } finally {
      await editor.destroy()
    }
  })

  it('writes nothing at all for a click that never becomes a drag', async () => {
    const editor = await createTestEditor(`![ok](${A_PNG})\n`, [
      ...EDITOR_SCHEMA_PLUGINS.flat(),
      safeImageViewProse
    ])
    try {
      const view = editor.ctx.get(editorViewCtx)
      const wrapper = view.dom.querySelector('.pagedown-image') as HTMLElement
      stubRect(wrapper.parentElement!, 600)
      stubRect(wrapper.querySelector('img')!, 300)

      const dispatched: unknown[] = []
      const original = view.dispatch.bind(view)
      view.dispatch = (tr): void => {
        dispatched.push(tr)
        original(tr)
      }

      // pointerdown then straight to pointerup, no movement between: a stray
      // click on the grip must not mark a clean document dirty.
      drag(wrapper.querySelector('.pagedown-image-resize-handle') as HTMLElement, [0])

      expect(dispatched).toHaveLength(0)
      expect(editor.action(getMarkdown())).toBe(`![ok](${A_PNG})\n`)
    } finally {
      await editor.destroy()
    }
  })

  it('keeps a resolved local image on screen across a resize instead of re-resolving it', async () => {
    // update() short-circuits a width-only change rather than re-running
    // syncFrom, which unconditionally removes `src` and starts a fresh
    // resolve. Without this the picture blinks out on the release of every
    // single drag. Asserted through the resolver's own call count, since that
    // is what the flash is made of.
    let resolveCalls = 0
    const editor = await createTestEditor('![chart](chart.png)\n', [
      ...EDITOR_SCHEMA_PLUGINS.flat(),
      safeImageViewProse,
      $prose(() =>
        createImageResolverPlugin({
          resolveLocalImage: async () => {
            resolveCalls += 1
            return A_PNG
          }
        })
      )
    ])
    try {
      const view = editor.ctx.get(editorViewCtx)
      const wrapper = view.dom.querySelector('.pagedown-image') as HTMLElement
      const img = wrapper.querySelector('img') as HTMLImageElement
      await waitFor(() => expect(img.getAttribute('src')).toBe(A_PNG))
      expect(resolveCalls).toBe(1)

      stubRect(wrapper.parentElement!, 600)
      stubRect(img, 300)
      drag(wrapper.querySelector('.pagedown-image-resize-handle') as HTMLElement, [0, 120])

      expect(editor.action(getMarkdown())).toContain('{width=70%}')
      expect(img.getAttribute('width')).toBe('70%')
      // Still showing the same resolved bytes, never torn off and re-fetched.
      expect(img.getAttribute('src')).toBe(A_PNG)
      expect(resolveCalls).toBe(1)
    } finally {
      await editor.destroy()
    }
  })

  it('tears its pointer listeners down when the node view is destroyed mid-drag', async () => {
    const editor = await createTestEditor(`![ok](${A_PNG})\n`, [
      ...EDITOR_SCHEMA_PLUGINS.flat(),
      safeImageViewProse
    ])
    const view = editor.ctx.get(editorViewCtx)
    const wrapper = view.dom.querySelector('.pagedown-image') as HTMLElement
    const img = wrapper.querySelector('img') as HTMLImageElement
    stubRect(wrapper.parentElement!, 600)
    stubRect(img, 300)
    const handle = wrapper.querySelector('.pagedown-image-resize-handle') as HTMLElement

    handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 0 }))
    await editor.destroy()

    // The listeners live on `window`, so without destroy() ending the drag
    // they would outlive the element they were opened for -- one leaked
    // listener per image per key={revision} remount.
    window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 400 }))
    expect(img.getAttribute('width')).toBeNull()
  })
})
