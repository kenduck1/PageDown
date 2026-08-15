import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, useState } from 'react'
import SourceEditor, { type SourceEditorHandle } from './SourceEditor'

function dropWithFiles(files: File[]): { dataTransfer: { files: File[] } } {
  return { dataTransfer: { files } }
}

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

  describe('syntax-highlight mirror', () => {
    // jsdom has no layout engine, so nothing here can prove ALIGNMENT -- that
    // is tests/gates/gate38's job, measuring a real painted token's box against the
    // real character under it in Chromium. What jsdom can prove is the
    // structural contract the alignment rests on, and these are those parts.
    it('renders a mirror painting exactly the textarea value, hidden from assistive tech', () => {
      const { container } = render(
        <SourceEditor content={'# Title\n\n**bold**'} onChange={vi.fn()} />
      )
      const pre = container.querySelector('pre.pagedown-source-highlight')!
      // The trailing newline is deliberate -- see SourceHighlightLayer.
      expect(pre.textContent).toBe('# Title\n\n**bold**\n')
      expect(pre).toHaveAttribute('aria-hidden', 'true')
      expect(pre.querySelector('.pagedown-src-strong')?.textContent).toBe('**bold**')
    })

    // The textarea must remain THE accessible control and THE value holder:
    // gate17 and gate21 both read exact document bytes off this element, and
    // gate23 finds it by its accessible name.
    it('keeps a single textbox, still named "Markdown source", still holding the bytes', () => {
      render(<SourceEditor content="# Hello" onChange={vi.fn()} />)
      const textareas = screen.getAllByRole('textbox')
      expect(textareas).toHaveLength(1)
      expect(textareas[0]).toHaveAccessibleName('Markdown source')
      expect(textareas[0]).toHaveValue('# Hello')
      // The mirror must carry NO Tailwind utility class competing with the
      // shared metrics rule -- utilities beat @layer base, so one left here
      // would silently move the textarea's text off the mirror's.
      expect(textareas[0].className).toBe('pagedown-source-editor')
    })

    it('mirrors the external content change that the controlled binding lands', () => {
      const { container, rerender } = render(<SourceEditor content="before" onChange={() => {}} />)
      rerender(<SourceEditor content="after" onChange={() => {}} />)
      expect(container.querySelector('pre.pagedown-source-highlight')?.textContent).toBe('after\n')
    })

    it('publishes the measured scrollbar gutter onto the shell', () => {
      // jsdom reports 0 for every box, so the VALUE here is necessarily 0px;
      // what this pins is that the measurement runs at all and reaches the
      // custom property the mirror's padding-right reads. Its real, non-zero
      // behaviour under classic scrollbars is gate38's.
      const { container } = render(<SourceEditor content="x" onChange={vi.fn()} />)
      const shell = container.querySelector<HTMLElement>('.pagedown-source-shell')!
      expect(shell.style.getPropertyValue('--pagedown-source-gutter')).toBe('0px')
    })

    it('syncs the mirror scroll offset from the textarea scroll event', () => {
      const ref = createRef<SourceEditorHandle>()
      const { container } = render(
        <SourceEditor ref={ref} content={'a\n'.repeat(200)} onChange={vi.fn()} />
      )
      const textarea = ref.current!.getTextarea()!
      const pre = container.querySelector<HTMLPreElement>('pre.pagedown-source-highlight')!
      // jsdom will not move an unlaid-out element's scrollTop on its own, so
      // both sides are driven explicitly; the assertion is that the handler
      // copies across, which is the only logic this component owns here.
      Object.defineProperty(textarea, 'scrollTop', { value: 137, configurable: true })
      fireEvent.scroll(textarea)
      expect(pre.scrollTop).toBe(137)
    })

    // An IME paints uncommitted text inside the textarea itself, where the
    // mirror cannot see it -- transparent text would make every CJK
    // composition invisible until the moment it committed.
    it('reveals the real text and hides the mirror while an IME composition is in flight', () => {
      const ref = createRef<SourceEditorHandle>()
      const { container } = render(<SourceEditor ref={ref} content="x" onChange={vi.fn()} />)
      const textarea = ref.current!.getTextarea()!
      const shell = container.querySelector('.pagedown-source-shell')!
      expect(shell).not.toHaveClass('pagedown-source-composing')
      fireEvent.compositionStart(textarea)
      expect(shell).toHaveClass('pagedown-source-composing')
      fireEvent.compositionEnd(textarea)
      expect(shell).not.toHaveClass('pagedown-source-composing')
    })
  })

  describe('image drag-and-drop', () => {
    it('inserts a real markdown image reference at the cursor for a dropped image file', async () => {
      const onChange = vi.fn()
      const onDropImage = vi.fn().mockResolvedValue({ relativePath: 'photo.png' })
      const ref = createRef<SourceEditorHandle>()
      render(
        <SourceEditor
          ref={ref}
          content="beforeafter"
          onChange={onChange}
          onDropImage={onDropImage}
        />
      )
      const textarea = ref.current!.getTextarea()!
      textarea.setSelectionRange(6, 6)

      const file = new File(['fake-bytes'], 'photo.png', { type: 'image/png' })
      fireEvent.drop(textarea, dropWithFiles([file]))

      await waitFor(() => expect(onDropImage).toHaveBeenCalledWith(file))
      await waitFor(() =>
        expect(onChange).toHaveBeenCalledWith('before![photo.png](photo.png)\nafter')
      )
    })

    it('wraps the destination in angle brackets when the saved relative path contains a space', async () => {
      const onChange = vi.fn()
      const onDropImage = vi.fn().mockResolvedValue({ relativePath: 'my photo.png' })
      const ref = createRef<SourceEditorHandle>()
      render(<SourceEditor ref={ref} content="" onChange={onChange} onDropImage={onDropImage} />)
      const textarea = ref.current!.getTextarea()!
      textarea.setSelectionRange(0, 0)

      const file = new File(['fake-bytes'], 'my photo.png', { type: 'image/png' })
      fireEvent.drop(textarea, dropWithFiles([file]))

      await waitFor(() =>
        expect(onChange).toHaveBeenCalledWith('![my photo.png](<my photo.png>)\n')
      )
    })

    it('surfaces a save failure via onError and does not insert anything', async () => {
      const onChange = vi.fn()
      const onError = vi.fn()
      const onDropImage = vi.fn().mockResolvedValue({ error: 'Save the document first.' })
      const ref = createRef<SourceEditorHandle>()
      render(
        <SourceEditor
          ref={ref}
          content="x"
          onChange={onChange}
          onDropImage={onDropImage}
          onError={onError}
        />
      )
      const textarea = ref.current!.getTextarea()!

      const file = new File(['fake-bytes'], 'photo.png', { type: 'image/png' })
      fireEvent.drop(textarea, dropWithFiles([file]))

      await waitFor(() => expect(onError).toHaveBeenCalledWith('Save the document first.'))
      expect(onChange).not.toHaveBeenCalled()
    })

    it('ignores a drop carrying no image files, leaving onDropImage/onChange untouched', () => {
      const onChange = vi.fn()
      const onDropImage = vi.fn()
      const ref = createRef<SourceEditorHandle>()
      render(<SourceEditor ref={ref} content="x" onChange={onChange} onDropImage={onDropImage} />)
      const textarea = ref.current!.getTextarea()!

      const file = new File(['plain text'], 'notes.txt', { type: 'text/plain' })
      fireEvent.drop(textarea, dropWithFiles([file]))

      expect(onDropImage).not.toHaveBeenCalled()
      expect(onChange).not.toHaveBeenCalled()
    })

    it('does nothing (no throw) when no onDropImage prop is provided', () => {
      const ref = createRef<SourceEditorHandle>()
      render(<SourceEditor ref={ref} content="x" onChange={vi.fn()} />)
      const textarea = ref.current!.getTextarea()!

      const file = new File(['fake-bytes'], 'photo.png', { type: 'image/png' })
      expect(() => fireEvent.drop(textarea, dropWithFiles([file]))).not.toThrow()
    })
  })
})
