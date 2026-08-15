import { createRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Editor } from '@milkdown/core'
import { commandsCtx, editorViewCtx } from '@milkdown/core'
import { getMarkdown } from '@milkdown/utils'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { toggleLinkCommand } from '@milkdown/preset-commonmark'
import { createTestEditor } from '../milkdown/test-editor'
import { EDITOR_COMMAND_PLUGINS, addCommentCommand } from '../milkdown/commands'
import CommentComposer from './CommentComposer'
import LinkComposer from './LinkComposer'
import { initialAppState, useAppStore } from '../store/appStore'
import { extractComments } from '../lib/extractComments'

// THE ONE PROPERTY THE POPOVER MOVE COULD HAVE BROKEN, PROVEN RATHER THAN
// ARGUED.
//
// SelectionBubble is safe to click because it calls `preventDefault()` on its
// own mousedown, so DOM focus never leaves the ProseMirror node at all. A
// composer cannot do that: the entire point is a field the user types into, so
// the editor genuinely loses DOM focus the moment either popover opens. If
// ProseMirror's `state.selection` were tied to DOM focus, the Insert/Add
// button would then apply its command to nothing, or to the wrong range -- and
// because the popover now sits directly over the words in question, a
// wrong-range application would be far more visible than it ever was from a
// strip at the top of the window.
//
// It is NOT tied to DOM focus: a ProseMirror selection is document state,
// carried in `EditorState`, and blurring the view dispatches no transaction.
// That is the claim, and reasoning it out is exactly what this project's own
// notes say not to settle for -- so these tests drive a REAL Milkdown editor
// (createTestEditor, the shipped EDITOR_SCHEMA_PLUGINS composition) with a
// REAL selection, mount the REAL composer so its `autoFocus` field genuinely
// takes `document.activeElement`, and then run the REAL command the composer
// dispatches, asserting on the REAL serialized markdown.
//
// Note precisely what jsdom can and cannot vouch for here, so this is not
// over-read. It CAN vouch for all of the above: activeElement is real, the
// ProseMirror state is real, and remark-stringify's output is real. It CANNOT
// vouch for anything pixel-shaped (every rect is all-zero -- see
// FloatingCard.test.tsx's header), nor for a real Chromium input pipeline;
// tests/gates/gate34 covers the end-to-end version, including the disk round trip.

afterEach(() => {
  cleanup()
  useAppStore.setState(initialAppState)
})

const paneRef = createRef<HTMLElement>()
const noRects = (): { anchor: null; safe: null } => ({ anchor: null, safe: null })

// Selects `word` inside the editor's first paragraph, the way a real
// double-click would -- but through a transaction, because jsdom has no
// hit-testing (drop-image.ts documents `posAtCoords` throwing there for the
// same underlying reason).
function selectWord(view: EditorView, word: string): { from: number; to: number } {
  const text = view.state.doc.textBetween(0, view.state.doc.content.size, '\n')
  const index = text.indexOf(word)
  expect(index).toBeGreaterThanOrEqual(0)
  // +1 for the paragraph's own opening token: the fixture is a single
  // paragraph, so document position 1 is its first character.
  const from = index + 1
  const to = from + word.length
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))
  return { from, to }
}

function selectedText(view: EditorView): string {
  const { from, to } = view.state.selection
  return view.state.doc.textBetween(from, to, '\n')
}

describe('the composer popovers take DOM focus without disturbing the selection', () => {
  it('LinkComposer’s field takes focus, the selection survives, and the link lands on it', async () => {
    const editor: Editor = await createTestEditor(
      'Alpha bravo charlie.',
      EDITOR_COMMAND_PLUGINS.flat()
    )
    let view!: EditorView
    editor.action((ctx) => {
      view = ctx.get(editorViewCtx)
    })
    const range = selectWord(view, 'bravo')
    expect(selectedText(view)).toBe('bravo')

    useAppStore.setState({ linkComposerOpen: true })
    const user = userEvent.setup()
    render(
      <LinkComposer
        initialHref=""
        onInsertLink={(href) => {
          // The exact dispatch editor-commands.ts's own `insertLink` performs
          // for the not-yet-linked branch. Reproduced here rather than reached
          // through MilkdownEditorHandle because this test owns its editor
          // directly; the branch itself (update vs toggle) is covered by
          // EditorScreen.link.test.tsx and by the handle's own tests.
          editor.action((ctx) => ctx.get(commandsCtx).call(toggleLinkCommand.key, { href }))
        }}
        onRemoveLink={() => {}}
        measure={noRects}
        paneRef={paneRef}
      />
    )

    // (1) The field really did take DOM focus -- if it had not, the rest of
    // this test would prove nothing at all, because there would be no blur to
    // survive.
    const field = screen.getByRole('textbox', { name: 'Link URL' })
    expect(document.activeElement).toBe(field)
    // ...and the editor really did lose it. `view.hasFocus()` is the same
    // predicate selection-plugin.ts reports as `snapshot.hasFocus`, i.e. the
    // one that hides the bubble.
    expect(view.hasFocus()).toBe(false)

    // (2) THE PROPERTY. The document selection is byte-identical to what it
    // was before focus moved: same positions, same text.
    expect(view.state.selection.from).toBe(range.from)
    expect(view.state.selection.to).toBe(range.to)
    expect(selectedText(view)).toBe('bravo')

    // (3) ...and the command therefore still applies to the intended range.
    // Typing into the field is a long run of real keystrokes with focus firmly
    // outside the editor, which is the realistic version of "did anything
    // during typing quietly collapse it".
    await user.type(field, 'https://example.com{Enter}')

    let markdown = ''
    editor.action((ctx) => {
      markdown = getMarkdown()(ctx)
    })
    expect(markdown).toContain('[bravo](https://example.com)')
    // The neighbouring words are untouched -- a selection that had silently
    // collapsed to a caret, or widened, would still produce SOME link.
    expect(markdown.trim()).toBe('Alpha [bravo](https://example.com) charlie.')

    await editor.destroy()
  })

  it('CommentComposer’s field takes focus, and the comment marks the selected words', async () => {
    const editor: Editor = await createTestEditor(
      'Alpha bravo charlie.',
      EDITOR_COMMAND_PLUGINS.flat()
    )
    let view!: EditorView
    editor.action((ctx) => {
      view = ctx.get(editorViewCtx)
    })
    selectWord(view, 'bravo charlie')

    useAppStore.setState({ commentComposerOpen: true })
    const user = userEvent.setup()
    render(
      <CommentComposer
        onAddComment={(text) => {
          let applied = false
          editor.action((ctx) => {
            applied = ctx.get(commandsCtx).call(addCommentCommand.key, { author: 'Kai', text })
          })
          return applied
        }}
        measure={noRects}
        paneRef={paneRef}
      />
    )

    const field = screen.getByRole('textbox', { name: 'Comment text' })
    expect(document.activeElement).toBe(field)
    expect(view.hasFocus()).toBe(false)
    expect(selectedText(view)).toBe('bravo charlie')

    // Multi-line, because Shift+Enter must still insert a newline rather than
    // submit -- the popover move deliberately did not touch that contract.
    await user.type(field, 'first line{Shift>}{Enter}{/Shift}second line{Enter}')

    let markdown = ''
    editor.action((ctx) => {
      markdown = getMarkdown()(ctx)
    })

    // Read back through the real extractor the Comments sidebar uses, rather
    // than by pattern-matching the marker syntax: that is what proves the mark
    // genuinely wraps the intended words rather than merely appearing
    // somewhere in the line.
    const comments = extractComments(markdown)
    expect(comments).toHaveLength(1)
    expect(comments[0].matchedText).toBe('bravo charlie')
    expect(comments[0].author).toBe('Kai')
    expect(comments[0].text).toBe('first line\nsecond line')

    await editor.destroy()
  })
})
