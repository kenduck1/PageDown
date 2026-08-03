import { describe, it, expect } from 'vitest'
import type { Html } from 'mdast'
import type { Element, Root as HastRoot } from 'hast'
import { toHtml } from 'hast-util-to-html'
import { sanitizeRawHtmlToHast } from './sanitize-raw-html'

// Minimal stand-in for mdast-util-to-hast's State — the handler only uses
// state.patch and state.applyData, both no-ops safe to stub for a unit test
// that inspects the returned hast nodes directly.
const stubState = {
  patch: () => undefined,
  applyData: (_node: unknown, hastNode: unknown) => hastNode
} as unknown as Parameters<typeof sanitizeRawHtmlToHast>[0]

function run(value: string): string {
  const node: Html = { type: 'html', value }
  const result = sanitizeRawHtmlToHast(stubState, node, undefined)
  const children = Array.isArray(result) ? result : result ? [result] : []
  const root: HastRoot = { type: 'root', children: children as Element[] }
  return toHtml(root)
}

describe('sanitizeRawHtmlToHast', () => {
  it('preserves a safe span, dropping its class attribute', () => {
    const out = run('<span class="highlight">inline HTML</span>')
    expect(out).toContain('<span>inline HTML</span>')
  })

  it('preserves a safe block div and its inner paragraph', () => {
    const out = run('<div class="callout">\nThis is raw HTML.\n</div>')
    expect(out).toContain('This is raw HTML.')
    expect(out).toContain('<div>')
  })

  it('strips a script tag entirely', () => {
    const out = run('<script>alert(1)</script>')
    expect(out).not.toContain('alert(1)')
    expect(out).not.toContain('<script')
  })

  it('strips an onclick handler but keeps the element', () => {
    const out = run('<div onclick="alert(1)">text</div>')
    expect(out).not.toContain('onclick')
    expect(out).toContain('text')
  })

  it('strips a forged data-src-* attribute pair', () => {
    const out = run('<div data-src-start="0" data-src-end="999">forged</div>')
    expect(out).not.toContain('data-src-start')
    expect(out).not.toContain('data-src-end')
    expect(out).toContain('forged')
  })
})
