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
