import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import EditorComments from './EditorComments'
import { encodeCommentMeta } from '../../../markdown/comment-plugin'

afterEach(() => {
  cleanup()
})

function documentWithComment(text: string): string {
  const data = encodeCommentMeta({ author: 'Kai', text, createdAt: '2026-08-11T09:00:00.000Z' })
  return `Before. <!--comment id="c1" data="${data}"-->marked phrase<!--/comment id="c1"--> after.\n`
}

describe('EditorComments', () => {
  it('renders a single-line comment body', () => {
    render(
      <EditorComments
        content={documentWithComment('needs revision')}
        onSelectComment={vi.fn()}
        onResolveComment={vi.fn()}
      />
    )

    expect(screen.getByText('needs revision')).toBeInTheDocument()
  })

  // The other half of the multi-line-body fix: HTML collapses whitespace, so
  // without `whitespace-pre-wrap` a two-paragraph comment renders here as one
  // run-on line -- the blank line vanishes and the paragraphs fuse. A user
  // could then type a structured comment and never see it again.
  it('preserves the line structure of a multi-line body rather than collapsing it', () => {
    const body = 'First paragraph.\n\nSecond paragraph.'
    render(
      <EditorComments
        content={documentWithComment(body)}
        onSelectComment={vi.fn()}
        onResolveComment={vi.fn()}
      />
    )

    // textContent keeps the real newlines regardless of CSS, so this proves
    // the DATA arrived intact...
    const rendered = screen.getByText((_, element) => element?.textContent === body)
    expect(rendered).toBeInTheDocument()
    // ...and this proves it is actually rendered as separate lines. Asserted
    // against the className because this project's Vitest config runs jsdom
    // with no CSS pipeline at all (see EditorTabBar.test.tsx's own note on the
    // same limitation), so a computed white-space here would read the initial
    // value no matter which utilities are present.
    expect(rendered.className).toContain('whitespace-pre-wrap')
  })

  it('wraps long unbroken tokens instead of overflowing the 216px rail', () => {
    render(
      <EditorComments
        content={documentWithComment('https://example.com/a/very/long/path/that/never/breaks')}
        onSelectComment={vi.fn()}
        onResolveComment={vi.fn()}
      />
    )

    expect(
      screen.getByText('https://example.com/a/very/long/path/that/never/breaks').className
    ).toContain('break-words')
  })
})
