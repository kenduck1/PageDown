import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import userEvent from '@testing-library/user-event'
import SelectionBubble, { type SelectionBubbleCommands } from './SelectionBubble'
import type { SelectionSnapshot } from '../milkdown/selection-plugin'
import type { Rect } from '../lib/floating-position'

// POSITIONING IS DELIBERATELY NOT ASSERTED IN THIS FILE. jsdom performs no
// layout, so every rect it produces is zero -- which is also why this
// component's `anchor`/`safe` props are INJECTED here rather than measured:
// the real measurement path (view.coordsAtPos) silently returns {0,0,0,0}
// under jsdom instead of throwing (see selection-plugin.ts's own warning), so
// a "the bubble sits above the selection" assertion here would pass against
// zeros and prove nothing. The placement arithmetic is tested for real in
// lib/floating-position.test.ts, where the occlusion guarantee actually lives;
// what IS testable here is render/aria/hide/dispatch behaviour.

const SNAPSHOT: SelectionSnapshot = {
  from: 1,
  to: 5,
  empty: false,
  hasFocus: true,
  nodeSelection: false,
  marks: { bold: false, italic: false, inlineCode: false, link: false },
  headingLevel: null,
  listType: null
}

const ANCHOR: Rect = { left: 300, top: 300, right: 400, bottom: 318 }
const SAFE: Rect = { left: 216, top: 123, right: 561, bottom: 606 }

function createCommands(): SelectionBubbleCommands {
  return {
    toggleBold: vi.fn(),
    toggleItalic: vi.fn(),
    toggleInlineCode: vi.fn(),
    toggleHeading: vi.fn(),
    setParagraph: vi.fn(),
    insertLink: vi.fn(),
    addComment: vi.fn()
  }
}

interface RenderOptions {
  snapshot?: SelectionSnapshot | null
  anchor?: Rect | null
  safe?: Rect | null
  suppressed?: boolean
  commands?: SelectionBubbleCommands
  onRemeasure?: () => void
}

function renderBubble(options: RenderOptions = {}): {
  commands: SelectionBubbleCommands
  rerender: (next: RenderOptions) => void
} {
  const commands = options.commands ?? createCommands()
  const paneRef = createRef<HTMLDivElement>()
  const props = (next: RenderOptions): React.ComponentProps<typeof SelectionBubble> => ({
    snapshot: next.snapshot === undefined ? SNAPSHOT : next.snapshot,
    anchor: next.anchor === undefined ? ANCHOR : next.anchor,
    safe: next.safe === undefined ? SAFE : next.safe,
    suppressed: next.suppressed ?? false,
    onRemeasure: next.onRemeasure ?? ((): void => {}),
    paneRef,
    commands
  })
  const view = render(<SelectionBubble {...props(options)} />)
  return {
    commands,
    rerender: (next) => view.rerender(<SelectionBubble {...props(next)} />)
  }
}

afterEach(() => {
  cleanup()
})

describe('SelectionBubble visibility', () => {
  it('renders a labelled toolbar for a real, focused, ranged selection', () => {
    renderBubble()
    expect(screen.getByRole('toolbar', { name: 'Text formatting' })).toBeInTheDocument()
  })

  it('renders nothing without a snapshot', () => {
    renderBubble({ snapshot: null })
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('renders nothing for a collapsed selection', () => {
    renderBubble({ snapshot: { ...SNAPSHOT, empty: true } })
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('renders nothing when the editor does not have focus', () => {
    // This is what stops Find popping a bubble on every match: applyFindState
    // deliberately selects without focusing.
    renderBubble({ snapshot: { ...SNAPSHOT, hasFocus: false } })
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('renders nothing for a NodeSelection (image / pagebreak / frontmatter atom)', () => {
    renderBubble({ snapshot: { ...SNAPSHOT, nodeSelection: true } })
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('renders nothing while a modal or composer is open', () => {
    renderBubble({ suppressed: true })
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('renders nothing when there is no measurable safe rect', () => {
    // No safe rect means no non-occlusion guarantee, and this bubble is the
    // one floating surface in an app whose Split preview composites above all
    // DOM -- so "cannot guarantee" must mean "do not render".
    renderBubble({ safe: null })
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('renders nothing when the selection could not be measured', () => {
    renderBubble({ anchor: null })
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('hides on Escape, and comes back for a DIFFERENT selection', () => {
    const { rerender } = renderBubble()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('toolbar')).toBeNull()
    // Same range still dismissed...
    rerender({})
    expect(screen.queryByRole('toolbar')).toBeNull()
    // ...but a new selection is a new question.
    rerender({ snapshot: { ...SNAPSHOT, from: 20, to: 26 } })
    expect(screen.getByRole('toolbar', { name: 'Text formatting' })).toBeInTheDocument()
  })
})

describe('SelectionBubble interaction', () => {
  it('never lets a mousedown steal focus from the editor', () => {
    // The whole reason this component never calls view.focus(): preventing the
    // mousedown default means DOM focus never leaves ProseMirror, so the
    // browser keeps painting the selection as active and the plugin's own blur
    // listener never fires and hides the bubble mid-click.
    renderBubble()
    const toolbar = screen.getByRole('toolbar', { name: 'Text formatting' })
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    toolbar.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('dispatches the mark commands', async () => {
    const user = userEvent.setup()
    const { commands } = renderBubble()
    await user.click(screen.getByRole('button', { name: 'Bold' }))
    await user.click(screen.getByRole('button', { name: 'Italic' }))
    await user.click(screen.getByRole('button', { name: 'Inline code' }))
    expect(commands.toggleBold).toHaveBeenCalledTimes(1)
    expect(commands.toggleItalic).toHaveBeenCalledTimes(1)
    expect(commands.toggleInlineCode).toHaveBeenCalledTimes(1)
  })

  it('dispatches the block commands, with the right heading level', async () => {
    const user = userEvent.setup()
    const { commands } = renderBubble()
    await user.click(screen.getByRole('button', { name: 'Heading 2' }))
    await user.click(screen.getByRole('button', { name: 'Normal text' }))
    expect(commands.toggleHeading).toHaveBeenCalledTimes(1)
    expect(commands.toggleHeading).toHaveBeenCalledWith(2)
    expect(commands.setParagraph).toHaveBeenCalledTimes(1)
  })

  it('opens the link and comment composers rather than embedding inputs', async () => {
    // Both composers are LAYOUT ROWS for the same occlusion reason this bubble
    // had to argue around; duplicating them as floating fields would
    // reintroduce it.
    const user = userEvent.setup()
    const { commands } = renderBubble()
    await user.click(screen.getByRole('button', { name: 'Insert link' }))
    await user.click(screen.getByRole('button', { name: 'Add comment' }))
    expect(commands.insertLink).toHaveBeenCalledTimes(1)
    expect(commands.addComment).toHaveBeenCalledTimes(1)
  })
})

describe('SelectionBubble active state', () => {
  it('marks genuine toggles pressed from the snapshot', () => {
    renderBubble({
      snapshot: {
        ...SNAPSHOT,
        marks: { bold: true, italic: false, inlineCode: true, link: false },
        headingLevel: 2
      }
    })
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Italic' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Inline code' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Heading 2' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Heading 1' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })

  it('omits aria-pressed entirely on one-shot buttons', () => {
    // EditorToolbar's own documented rule: a screen reader announces
    // aria-pressed="false" as "toggle button, currently off", which is
    // actively misleading for an action that isn't a toggle.
    renderBubble()
    expect(screen.getByRole('button', { name: 'Normal text' })).not.toHaveAttribute('aria-pressed')
    expect(screen.getByRole('button', { name: 'Insert link' })).not.toHaveAttribute('aria-pressed')
    expect(screen.getByRole('button', { name: 'Add comment' })).not.toHaveAttribute('aria-pressed')
  })
})

describe('SelectionBubble re-measurement', () => {
  it('asks the parent to re-measure on scroll and resize, and stops once hidden', () => {
    // Scroll is captured on window because the editor pane is overflow-auto
    // and element scroll events do not bubble -- they only propagate in the
    // capture phase. Nothing about that is visible from the rendered DOM, so
    // it is asserted through real dispatched events.
    const onRemeasure = vi.fn()
    const { rerender } = renderBubble({ onRemeasure })
    fireEvent.scroll(window)
    fireEvent(window, new Event('resize'))
    expect(onRemeasure.mock.calls.length).toBeGreaterThanOrEqual(2)
    const whileVisible = onRemeasure.mock.calls.length
    rerender({ snapshot: null })
    fireEvent.scroll(window)
    expect(onRemeasure.mock.calls.length).toBe(whileVisible)
  })
  it('registers its Escape listener on mount, even while hidden', () => {
    // Regression test for a real, Gate-28-caught bug. The Escape listener used
    // to be registered from an effect gated on `visible`. That is a PASSIVE
    // effect, so React flushes it after paint -- meaning in the frame between
    // the bubble entering the DOM and the effect running there was no listener
    // at all, and an Escape landing in that window was silently dropped. Gate
    // 28 saw it once in ~25 runs and could not reproduce it in ~25 more, which
    // is exactly the profile of a one-frame race.
    //
    // jsdom cannot reproduce that race at all -- Testing Library's render()
    // flushes effects synchronously inside act(), so the window never exists
    // here. What jsdom CAN pin is the structural change that closed it: the
    // listener is registered unconditionally on mount rather than when the
    // bubble becomes visible. Asserting the registration directly is the
    // honest test; asserting "Escape dismisses it" would pass against the old
    // code too and prove nothing.
    const addSpy = vi.spyOn(window, 'addEventListener')
    renderBubble({ snapshot: null })
    expect(addSpy.mock.calls.some(([type]) => type === 'keydown')).toBe(true)
    addSpy.mockRestore()
  })
})
