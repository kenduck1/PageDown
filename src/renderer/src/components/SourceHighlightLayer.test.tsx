import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createRef } from 'react'
import SourceHighlightLayer from './SourceHighlightLayer'

// The node-building itself is covered in lib/source-highlight-nodes.test.tsx;
// what is left for this file is the wrapper element's own contract, which is
// small and entirely about how the mirror relates to the textarea above it.

afterEach(() => {
  cleanup()
})

describe('SourceHighlightLayer', () => {
  it('renders a <pre> that is hidden from assistive technology', () => {
    // The textarea directly above already exposes this exact text as the value
    // of a real form control; without aria-hidden every screen reader would
    // read the whole document twice.
    const preRef = createRef<HTMLPreElement>()
    const { container } = render(<SourceHighlightLayer content="# Hi" preRef={preRef} />)
    const pre = container.querySelector('pre')
    expect(pre).toBeInstanceOf(HTMLPreElement)
    expect(pre).toHaveAttribute('aria-hidden', 'true')
    expect(pre).toHaveClass('pagedown-source-highlight')
    // SourceEditor drives scroll sync through this ref; a component that
    // rendered correctly but never forwarded it would break silently.
    expect(preRef.current).toBe(pre)
  })

  it('paints the exact source text into the DOM, including the token spans', () => {
    const preRef = createRef<HTMLPreElement>()
    const { container } = render(
      <SourceHighlightLayer content={'# Title\n\nplain **bold**'} preRef={preRef} />
    )
    const pre = container.querySelector('pre')!
    expect(pre.textContent).toBe('# Title\n\nplain **bold**\n')
    expect(pre.querySelector('.pagedown-src-heading')?.textContent).toBe(' Title')
    expect(pre.querySelector('.pagedown-src-strong')?.textContent).toBe('**bold**')
  })
})
