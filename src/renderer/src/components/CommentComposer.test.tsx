import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CommentComposer from './CommentComposer'
import { initialAppState, useAppStore } from '../store/appStore'

beforeEach(() => {
  useAppStore.setState(initialAppState)
})

afterEach(() => {
  cleanup()
})

describe('CommentComposer', () => {
  it('renders nothing when commentComposerOpen is false', () => {
    render(<CommentComposer onAddComment={vi.fn()} />)
    expect(screen.queryByRole('group', { name: 'Add comment' })).not.toBeInTheDocument()
  })

  it('renders the composer row when commentComposerOpen is true', () => {
    useAppStore.setState({ commentComposerOpen: true })
    render(<CommentComposer onAddComment={vi.fn()} />)
    expect(screen.getByRole('group', { name: 'Add comment' })).toBeInTheDocument()
  })

  it('the Add button is disabled until real text is typed', async () => {
    useAppStore.setState({ commentComposerOpen: true })
    const user = userEvent.setup()
    render(<CommentComposer onAddComment={vi.fn()} />)

    const addButton = screen.getByRole('button', { name: 'Add' })
    expect(addButton).toBeDisabled()

    await user.type(screen.getByRole('textbox', { name: 'Comment text' }), '   ')
    expect(addButton).toBeDisabled()

    await user.type(screen.getByRole('textbox', { name: 'Comment text' }), 'real text')
    expect(addButton).not.toBeDisabled()
  })

  it('Enter submits, same as clicking Add', async () => {
    useAppStore.setState({ commentComposerOpen: true })
    const onAddComment = vi.fn(() => true)
    const user = userEvent.setup()
    render(<CommentComposer onAddComment={onAddComment} />)

    await user.type(screen.getByRole('textbox', { name: 'Comment text' }), 'a note{Enter}')

    expect(onAddComment).toHaveBeenCalledWith('a note')
    expect(useAppStore.getState().commentComposerOpen).toBe(false)
  })

  it('a failed add (onAddComment returns false) shows an error and does not close', async () => {
    useAppStore.setState({ commentComposerOpen: true })
    const onAddComment = vi.fn(() => false)
    const user = userEvent.setup()
    render(<CommentComposer onAddComment={onAddComment} />)

    await user.type(screen.getByRole('textbox', { name: 'Comment text' }), 'a note{Enter}')

    expect(screen.getByText('Select some text within a single paragraph first.')).toBeVisible()
    expect(useAppStore.getState().commentComposerOpen).toBe(true)
  })

  // Product-completeness audit Tier 3, B.1: the inline error had no role at
  // all (invisible to a screen reader) and no aria-describedby tying it to
  // the field it's actually about.
  it('the error is announced via role="alert" and tied to the input via aria-describedby', async () => {
    useAppStore.setState({ commentComposerOpen: true })
    const onAddComment = vi.fn(() => false)
    const user = userEvent.setup()
    render(<CommentComposer onAddComment={onAddComment} />)
    const input = screen.getByRole('textbox', { name: 'Comment text' })

    // Before any error, the field must not claim a description that doesn't
    // exist yet.
    expect(input).not.toHaveAttribute('aria-describedby')

    await user.type(input, 'a note{Enter}')

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Select some text within a single paragraph first.')
    expect(input).toHaveAttribute('aria-describedby', alert.id)
  })

  it('editing the text after a failed attempt clears the error', async () => {
    useAppStore.setState({ commentComposerOpen: true })
    const onAddComment = vi.fn(() => false)
    const user = userEvent.setup()
    render(<CommentComposer onAddComment={onAddComment} />)

    await user.type(screen.getByRole('textbox', { name: 'Comment text' }), 'a note{Enter}')
    expect(screen.getByText('Select some text within a single paragraph first.')).toBeVisible()

    await user.type(screen.getByRole('textbox', { name: 'Comment text' }), ' more')
    expect(
      screen.queryByText('Select some text within a single paragraph first.')
    ).not.toBeInTheDocument()
  })

  // The reported bug: the field was a single-line <input>, so a user could not
  // type a multi-paragraph comment at all. Note the constraint this does NOT
  // touch -- a comment MARK still cannot span two blocks (addCommentCommand
  // refuses, by design, because remark-stringify serialises block nodes
  // independently). That is about which text can be marked; this is about what
  // the comment BODY can say, and the body is base64-encoded JSON inside an
  // HTML comment, so newlines in it are safe by construction.
  describe('multi-line comment bodies', () => {
    it('is a real textarea, so a body can have more than one line at all', () => {
      useAppStore.setState({ commentComposerOpen: true })
      render(<CommentComposer onAddComment={vi.fn()} />)

      expect(screen.getByRole('textbox', { name: 'Comment text' }).tagName).toBe('TEXTAREA')
    })

    it('Shift+Enter inserts a newline instead of submitting', async () => {
      useAppStore.setState({ commentComposerOpen: true })
      const onAddComment = vi.fn(() => true)
      const user = userEvent.setup()
      render(<CommentComposer onAddComment={onAddComment} />)

      const field = screen.getByRole('textbox', { name: 'Comment text' })
      await user.type(field, 'first line{Shift>}{Enter}{/Shift}second line')

      expect(onAddComment).not.toHaveBeenCalled()
      expect(field).toHaveValue('first line\nsecond line')
    })

    it('plain Enter still submits, and submits the whole multi-line body', async () => {
      useAppStore.setState({ commentComposerOpen: true })
      const onAddComment = vi.fn(() => true)
      const user = userEvent.setup()
      render(<CommentComposer onAddComment={onAddComment} />)

      await user.type(
        screen.getByRole('textbox', { name: 'Comment text' }),
        'Para one.{Shift>}{Enter}{Enter}{/Shift}Para two.{Enter}'
      )

      expect(onAddComment).toHaveBeenCalledWith('Para one.\n\nPara two.')
      expect(useAppStore.getState().commentComposerOpen).toBe(false)
    })

    it('trims a trailing newline the user changed their mind about', async () => {
      useAppStore.setState({ commentComposerOpen: true })
      const onAddComment = vi.fn(() => true)
      const user = userEvent.setup()
      render(<CommentComposer onAddComment={onAddComment} />)

      await user.type(
        screen.getByRole('textbox', { name: 'Comment text' }),
        'a note{Shift>}{Enter}{/Shift}{Enter}'
      )

      expect(onAddComment).toHaveBeenCalledWith('a note')
    })

    it('tells the user about Shift+Enter, which is otherwise undiscoverable', () => {
      useAppStore.setState({ commentComposerOpen: true })
      render(<CommentComposer onAddComment={vi.fn()} />)

      expect(screen.getByRole('textbox', { name: 'Comment text' })).toHaveAttribute(
        'placeholder',
        expect.stringContaining('Shift+Enter')
      )
    })
  })

  it('Cancel closes without submitting and clears the typed text', async () => {
    useAppStore.setState({ commentComposerOpen: true })
    const onAddComment = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<CommentComposer onAddComment={onAddComment} />)

    await user.type(screen.getByRole('textbox', { name: 'Comment text' }), 'a note')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onAddComment).not.toHaveBeenCalled()
    expect(useAppStore.getState().commentComposerOpen).toBe(false)

    useAppStore.setState({ commentComposerOpen: true })
    rerender(<CommentComposer onAddComment={onAddComment} />)
    expect(screen.getByRole('textbox', { name: 'Comment text' })).toHaveValue('')
  })
})
