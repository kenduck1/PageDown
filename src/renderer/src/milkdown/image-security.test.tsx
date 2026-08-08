import { describe, expect, it, afterEach } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { getMarkdown } from '@milkdown/utils'
import { isSafeImageSrc } from './image-security'
import MilkdownEditor from './MilkdownEditor'
import { createTestEditor } from './test-editor'
import { EDITOR_SCHEMA_PLUGINS } from './plugins'
import { computePageGeometry } from '../../../typography/page-geometry'
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
