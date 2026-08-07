import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import SourceEditor from './SourceEditor'

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
})
