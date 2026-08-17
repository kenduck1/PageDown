import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditorComments from './EditorComments'
import { encodeCommentMeta } from '../../../markdown/comment-plugin'

afterEach(() => {
  cleanup()
})

function marker(id: string, text: string, resolvedAt?: string): string {
  const data = encodeCommentMeta({
    author: 'Kai',
    text,
    createdAt: '2026-08-11T09:00:00.000Z',
    resolvedAt
  })
  return `<!--comment id="${id}" data="${data}"-->${id} span<!--/comment id="${id}"-->`
}

function documentWithComment(text: string): string {
  const data = encodeCommentMeta({ author: 'Kai', text, createdAt: '2026-08-11T09:00:00.000Z' })
  return `Before. <!--comment id="c1" data="${data}"-->marked phrase<!--/comment id="c1"--> after.\n`
}

function renderComments(
  content: string,
  overrides: Partial<React.ComponentProps<typeof EditorComments>> = {}
): {
  onResolveComment: ReturnType<typeof vi.fn>
  onUnresolveComment: ReturnType<typeof vi.fn>
  onDeleteComment: ReturnType<typeof vi.fn>
} {
  const handlers = {
    onResolveComment: vi.fn(),
    onUnresolveComment: vi.fn(),
    onDeleteComment: vi.fn()
  }
  render(
    <EditorComments content={content} onSelectComment={vi.fn()} {...handlers} {...overrides} />
  )
  return handlers
}

describe('EditorComments', () => {
  it('renders a single-line comment body', () => {
    renderComments(documentWithComment('needs revision'))

    expect(screen.getByText('needs revision')).toBeInTheDocument()
  })

  // The other half of the multi-line-body fix: HTML collapses whitespace, so
  // without `whitespace-pre-wrap` a two-paragraph comment renders here as one
  // run-on line -- the blank line vanishes and the paragraphs fuse. A user
  // could then type a structured comment and never see it again.
  it('preserves the line structure of a multi-line body rather than collapsing it', () => {
    const body = 'First paragraph.\n\nSecond paragraph.'
    renderComments(documentWithComment(body))

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
    renderComments(documentWithComment('https://example.com/a/very/long/path/that/never/breaks'))

    expect(
      screen.getByText('https://example.com/a/very/long/path/that/never/breaks').className
    ).toContain('break-words')
  })

  // BACKWARD COMPATIBILITY at the UI layer. Every comment written before
  // `resolvedAt` existed carries no such key, and must appear in the ACTIVE
  // list with a Resolve button -- never in the Resolved section, and never as
  // a comment the panel refuses to render because its payload looked wrong.
  it('treats a comment with no resolvedAt as active, with a Resolve action', async () => {
    renderComments(documentWithComment('needs revision'))

    expect(screen.getByRole('button', { name: 'Resolve' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Unresolve' })).not.toBeInTheDocument()
    // No Resolved section at all when nothing is resolved.
    expect(screen.queryByRole('button', { name: /^Resolved \(/ })).not.toBeInTheDocument()
  })

  it('separates resolved comments into their own collapsed, counted section', async () => {
    const user = userEvent.setup()
    renderComments(
      `${marker('c1', 'still open')}\n\n${marker('c2', 'dealt with', '2026-08-12T10:00:00.000Z')}\n`
    )

    // Active comment is visible immediately; the resolved one is behind the
    // disclosure, which announces how many are hidden rather than hiding the
    // fact that any exist.
    expect(screen.getByText('still open')).toBeInTheDocument()
    expect(screen.queryByText('dealt with')).not.toBeInTheDocument()

    const disclosure = screen.getByRole('button', { name: 'Resolved (1)' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')

    await user.click(disclosure)

    expect(screen.getByText('dealt with')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unresolve' })).toBeInTheDocument()
  })

  // The reveal path: clicking a RESOLVED mark in the document sets
  // activeCommentId. If the section stayed collapsed, the tab would switch and
  // show the reader nothing -- the exact "the click looks like it did nothing"
  // bug revealComment exists to fix.
  it('force-opens the Resolved section when the active comment is a resolved one', () => {
    renderComments(
      `${marker('c1', 'still open')}\n\n${marker('c2', 'dealt with', '2026-08-12T10:00:00.000Z')}\n`,
      { activeCommentId: 'c2' }
    )

    expect(screen.getByText('dealt with')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resolved (1)' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })

  // The section is opened BY the reveal, as an event -- it is not held open for
  // as long as that comment stays active. A held-open version made the
  // disclosure button visibly refuse to work, which is worse to ship than the
  // state it was protecting.
  it('lets the user collapse the Resolved section again after a reveal opened it', async () => {
    const user = userEvent.setup()
    renderComments(
      `${marker('c1', 'still open')}\n\n${marker('c2', 'dealt with', '2026-08-12T10:00:00.000Z')}\n`,
      { activeCommentId: 'c2' }
    )

    const disclosure = screen.getByRole('button', { name: 'Resolved (1)' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')

    await user.click(disclosure)

    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('dealt with')).not.toBeInTheDocument()
  })

  it('Resolve and Unresolve call their own handlers with the comment id', async () => {
    const user = userEvent.setup()
    const handlers = renderComments(
      `${marker('c1', 'still open')}\n\n${marker('c2', 'dealt with', '2026-08-12T10:00:00.000Z')}\n`,
      { activeCommentId: 'c2' }
    )

    await user.click(screen.getByRole('button', { name: 'Resolve' }))
    expect(handlers.onResolveComment).toHaveBeenCalledWith('c1')
    expect(handlers.onDeleteComment).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Unresolve' }))
    expect(handlers.onUnresolveComment).toHaveBeenCalledWith('c2')
    expect(handlers.onDeleteComment).not.toHaveBeenCalled()
  })

  // Delete must be reachable but not reachable BY ACCIDENT. One click asks;
  // only the confirm deletes. Without this, a mis-aimed click a few pixels from
  // Resolve would destroy a comment with no reachable undo (the ProseMirror
  // undo keymap only fires while the EDITOR has focus, and this click came from
  // the sidebar).
  it('requires a confirmation before deleting, and Cancel calls nothing', async () => {
    const user = userEvent.setup()
    const handlers = renderComments(documentWithComment('needs revision'))

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(handlers.onDeleteComment).not.toHaveBeenCalled()
    expect(screen.getByText('Delete this comment?')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel delete' }))
    expect(handlers.onDeleteComment).not.toHaveBeenCalled()
    expect(screen.queryByText('Delete this comment?')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(screen.getByRole('button', { name: 'Confirm delete' }))
    expect(handlers.onDeleteComment).toHaveBeenCalledWith('c1')
  })

  it('confirms deletion of the row it was opened on, not another', async () => {
    const user = userEvent.setup()
    const handlers = renderComments(`${marker('c1', 'first')}\n\n${marker('c2', 'second')}\n`)

    const rows = screen.getAllByRole('listitem')
    await user.click(within(rows[1]).getByRole('button', { name: 'Delete' }))
    // Only the row that was asked about shows the question.
    expect(screen.getAllByText('Delete this comment?')).toHaveLength(1)
    await user.click(within(rows[1]).getByRole('button', { name: 'Confirm delete' }))

    expect(handlers.onDeleteComment).toHaveBeenCalledWith('c2')
    expect(handlers.onDeleteComment).toHaveBeenCalledTimes(1)
  })

  it('says so when every comment is resolved, rather than looking empty', () => {
    renderComments(`${marker('c1', 'dealt with', '2026-08-12T10:00:00.000Z')}\n`)

    expect(screen.getByText('No active comments.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resolved (1)' })).toBeInTheDocument()
    // ...and NOT the "no comments in this document yet" empty state, which
    // would be a straightforwardly false statement about this document.
    expect(screen.queryByText(/No comments in this document yet/)).not.toBeInTheDocument()
  })
})
