import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, useState } from 'react'
import SourceEditor, { type SourceEditorHandle } from './SourceEditor'

afterEach(() => {
  cleanup()
})

describe('SourceEditor', () => {
  it('renders the given content as the textarea value', () => {
    render(<SourceEditor content="# Hello" onChange={vi.fn()} />)
    expect(screen.getByRole('textbox')).toHaveValue('# Hello')
  })

  it('calls onChange with the full new value on every keystroke, synchronously -- no debounce', async () => {
    // Stateful wrapper simulates how EditorScreen will use this component:
    // it holds content in state, renders SourceEditor with that state, and
    // feeds onChange values back into state on every keystroke.
    const onChange = vi.fn()
    function StatefulSourceEditorTest(): React.JSX.Element {
      const [content, setContent] = useState('')
      return (
        <SourceEditor
          content={content}
          onChange={(value) => {
            onChange(value)
            setContent(value)
          }}
        />
      )
    }

    const user = userEvent.setup()
    render(<StatefulSourceEditorTest />)
    const textbox = screen.getByRole('textbox')
    await user.type(textbox, 'hi')
    // Two keystrokes, two synchronous onChange calls -- contrast with
    // MilkdownEditor's 200ms-debounced markdownUpdated (see
    // MilkdownEditor.test.tsx's own ~250ms waits). SourceEditor has no
    // internal model to debounce around: the DOM value IS the content.
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenNthCalledWith(1, 'h')
    expect(onChange).toHaveBeenNthCalledWith(2, 'hi')
    expect(textbox).toHaveValue('hi')
    expect(textbox).toHaveFocus()
  })

  it('has no page-card chrome -- renders a bare textarea, not wrapped in [data-testid="page-card"]', () => {
    render(<SourceEditor content="x" onChange={vi.fn()} />)
    expect(screen.queryByTestId('page-card')).not.toBeInTheDocument()
  })

  it('exposes its textarea through the ref handle', () => {
    const ref = createRef<SourceEditorHandle>()
    render(<SourceEditor ref={ref} content="alpha beta" onChange={() => {}} />)
    const textarea = ref.current?.getTextarea()
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement)
    expect(textarea?.value).toBe('alpha beta')
  })

  it('reports the selected text, and an empty string when nothing is selected', () => {
    const ref = createRef<SourceEditorHandle>()
    render(<SourceEditor ref={ref} content="alpha beta" onChange={() => {}} />)
    expect(ref.current?.getSelectedText()).toBe('')
    ref.current?.getTextarea()?.setSelectionRange(6, 10)
    expect(ref.current?.getSelectedText()).toBe('beta')
  })

  it('still forces the DOM value to match the content prop after an external change', () => {
    // Guards the documented controlled-binding invariant: swapping value= for
    // defaultValue= must not pass. See this component's own doc comment.
    const ref = createRef<SourceEditorHandle>()
    const { rerender } = render(<SourceEditor ref={ref} content="before" onChange={() => {}} />)
    rerender(<SourceEditor ref={ref} content="after" onChange={() => {}} />)
    expect(ref.current?.getTextarea()?.value).toBe('after')
  })
})
