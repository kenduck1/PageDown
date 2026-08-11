import { describe, it, expect } from 'vitest'
import { SignificantWhitespaceHandler } from './break-handlers'

// Unit coverage for the ONE half of this file that does not depend on real
// layout. `OverflowFitHandler` is deliberately absent here: every decision it
// makes comes from `Range.getClientRects()`, and jsdom implements no layout
// engine at all (every rect is 0x0 at 0,0), so a jsdom test of it could only
// assert that it declines to act -- which is exactly what it would also do if
// it were completely broken. Its real coverage is
// phase0/gate4-export.spec.ts's split-code-block regression section, against
// the actual built app. Same split, same reasoning, as
// milkdown/commands.test.ts vs. gate20 for keymaps.
//
// `SignificantWhitespaceHandler.beforeParsed`, by contrast, is pure DOM
// rewriting with no measurement in it, so jsdom exercises it faithfully -- and
// it is the piece whose NARROWNESS the gate cannot check. The gate can prove
// the whitespace survived; only these tests can prove the handler is not
// simply wrapping every whitespace node in the document.

// The handler's hook methods are registered by Paged.js's own `Handler` base
// constructor, which needs a live chunker/polisher/previewer trio. Calling the
// prototype method directly sidesteps constructing any of that: the method
// reads nothing off `this`.
function wrapWhitespace(root: ParentNode): void {
  SignificantWhitespaceHandler.prototype.beforeParsed.call(
    Object.create(SignificantWhitespaceHandler.prototype),
    root
  )
}

function fragmentFrom(html: string): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = html
  return template.content
}

function wrapperCount(root: ParentNode): number {
  return root.querySelectorAll('span[data-pagedown-space]').length
}

describe('SignificantWhitespaceHandler', () => {
  it('wraps the whitespace between two syntax-highlighted spans inside a pre', () => {
    // The exact shape rehype-highlight emits for `def acquire(...)`, and the
    // exact shape that rendered as `defacquire(` before this handler existed.
    const fragment = fragmentFrom(
      '<pre><code><span class="hljs-keyword">def</span> <span class="hljs-title">acquire</span>(x)</code></pre>'
    )
    wrapWhitespace(fragment)

    expect(wrapperCount(fragment)).toBe(1)
    const wrapper = fragment.querySelector('span[data-pagedown-space]')
    expect(wrapper?.textContent).toBe(' ')
    expect(wrapper?.previousSibling?.nodeName).toBe('SPAN')
  })

  it('preserves the document text exactly', () => {
    const html =
      '<pre><code><span class="hljs-keyword">import</span> <span class="hljs-title">time</span>\n' +
      '<span class="hljs-keyword">from</span> <span class="hljs-title">x</span> ' +
      '<span class="hljs-keyword">import</span> <span class="hljs-title">y</span></code></pre>'
    const before = fragmentFrom(html).textContent
    const fragment = fragmentFrom(html)
    wrapWhitespace(fragment)

    // Wrapping must be a pure re-parenting: same characters, same order. A
    // wrapper that dropped or duplicated the node it wrapped would still
    // satisfy the count assertions above.
    expect(fragment.textContent).toBe(before)
    expect(wrapperCount(fragment)).toBe(5)
  })

  it('wraps whitespace separating two inline elements outside a pre', () => {
    // `**bold** *italic*`: the space is collapsible, but it is the only thing
    // separating two inline boxes, so losing it glues the words together.
    const fragment = fragmentFrom('<p><strong>bold</strong> <em>italic</em></p>')
    wrapWhitespace(fragment)

    expect(wrapperCount(fragment)).toBe(1)
    expect(fragment.textContent).toBe('bold italic')
  })

  it('leaves whitespace between two BLOCK elements alone', () => {
    // Paged.js skips this node too, but the whitespace is collapsible and
    // renders as nothing either way, so wrapping it would add stray inline
    // boxes between blocks for no benefit. This is the narrowness the gate
    // cannot observe.
    const fragment = fragmentFrom(
      '<div><p>one</p>\n<p>two</p>\n<table><tbody></tbody></table></div>'
    )
    wrapWhitespace(fragment)

    expect(wrapperCount(fragment)).toBe(0)
  })

  it('leaves whitespace with no preceding element alone', () => {
    // The skip this handler defends against only happens via `nodeAfter` from
    // an element Paged.js just deep-cloned. With a text node (or nothing)
    // before it, the ordinary walk reaches this node and renders it.
    const fragment = fragmentFrom(
      '<pre><code>  indented\n<span class="hljs-x">tok</span></code></pre>'
    )
    wrapWhitespace(fragment)

    expect(wrapperCount(fragment)).toBe(0)
  })

  it('does not treat a non-breaking space as ignorable whitespace', () => {
    // Matches Paged.js's own `isAllWhitespace` definition (tab/LF/CR/space
    // only, deliberately not the `\s` class). A NBSP node is never skipped by
    // Paged.js, so rewriting it here would be a change with no bug behind it.
    const fragment = fragmentFrom('<p><strong>a</strong> <em>b</em></p>')
    wrapWhitespace(fragment)

    expect(wrapperCount(fragment)).toBe(0)
  })

  it('wraps every occurrence in a realistic highlighted block, and only those', () => {
    const fragment = fragmentFrom(
      '<div><h2>Heading</h2>\n' +
        '<p>Prose with <code>inline</code> code.</p>\n' +
        '<pre><code class="hljs language-python"><span class="hljs-keyword">class</span> ' +
        '<span class="hljs-title">C</span>:\n    <span class="hljs-keyword">pass</span></code></pre></div>'
    )
    wrapWhitespace(fragment)

    // Exactly one: the space between `class` and `C`. The `\n` between the
    // block elements is collapsible-between-blocks, the `:\n    ` run is not
    // whitespace-only, and the text before `<code>inline</code>` has no
    // element before it.
    expect(wrapperCount(fragment)).toBe(1)
    expect(fragment.querySelector('span[data-pagedown-space]')?.textContent).toBe(' ')
  })
})
