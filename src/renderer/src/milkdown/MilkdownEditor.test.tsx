import { describe, expect, it, afterEach, vi } from 'vitest'
import { createRef } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import {
  Editor,
  rootCtx,
  defaultValueCtx,
  remarkStringifyOptionsCtx,
  editorViewCtx
} from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { getMarkdown, insert } from '@milkdown/utils'
import { TextSelection } from '@milkdown/prose/state'
import { PINNED_STRINGIFY_OPTIONS } from './stringify-options'
import { EDITOR_SCHEMA_PLUGINS } from './plugins'
import { EDITOR_COMMAND_PLUGINS } from './commands'
import { createTestEditor } from './test-editor'
import MilkdownEditor, { type MilkdownEditorHandle } from './MilkdownEditor'
import { buildEditorCommands } from './editor-commands'

describe('Milkdown listener plugin — API pattern verification', () => {
  it('markdownUpdated fires with the new serialized markdown after a real edit', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)

    const updates: string[] = []

    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
        ctx.set(defaultValueCtx, '# Hello')
        ctx.set(remarkStringifyOptionsCtx, PINNED_STRINGIFY_OPTIONS)
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          updates.push(markdown)
        })
      })
      .use(commonmark)
      .use(gfm)
      .use(listener)
      .create()

    expect(updates, 'no update should have fired yet for the initial mount').toHaveLength(0)

    editor.action(insert('\n\nWorld'))

    // @milkdown/plugin-listener's markdownUpdated fires through a lodash
    // debounce(200) (confirmed by reading its source), so it never fires
    // synchronously right after the edit -- wait past the debounce window.
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(updates.length, 'expected exactly one markdownUpdated call for one edit').toBe(1)
    expect(updates[0]).toContain('World')
    expect(updates[0]).toBe(editor.action(getMarkdown()))

    await editor.destroy()
    root.remove()
  })
})

// jsdom's own Selection/Range API does not sync into ProseMirror's internal
// `state.selection` -- verified empirically with a throwaway scratch test
// (deleted after use, per this project's own established practice for these
// spikes): setting a real, non-collapsed jsdom Range via
// `window.getSelection().addRange(...)` over existing rendered text left
// ProseMirror's `state.selection` collapsed at its original position
// regardless. That rules out reusing the DOM-mutation techniques the
// `MilkdownEditor` describe block below relies on (which work by letting
// ProseMirror's MutationObserver diff a raw DOM change, independent of
// `state.selection` entirely) for verifying a mark TOGGLE against
// already-selected existing text: the underlying toggleMark-backed commands
// only rewrite existing text when `state.selection` is a real, non-empty
// range -- an empty/collapsed selection just flips a *stored* mark for the
// next typed character, with no visible DOM change to assert against. The
// only reliable way found to establish a genuine non-empty ProseMirror
// selection here is to dispatch a transaction that sets one directly
// (proven to work in the same scratch test), so that's what this block
// does.
//
// Fix-round change: this block now calls `buildEditorCommands(editor)` --
// the exact, real, exported function MilkdownEditor.tsx's own mount effect
// calls to build the imperative handle -- rather than calling
// `editor.action(callCommand(commandKey, payload))` directly with a
// hardcoded command key. The earlier version of this block did the latter,
// and a mutation-testing pass found the real gap that left: rewiring
// MilkdownEditorHandle.toggleBold to dispatch toggleEmphasisCommand instead
// (a genuine wiring bug) passed every test in the suite, because this block
// verified the underlying command MECHANISM works, never that
// MilkdownEditorHandle.toggleBold is wired to the RIGHT command key. Going
// through buildEditorCommands closes that gap: this IS the shipped
// implementation, not a stand-in for it, so a wiring bug like the
// mutation-tested one now fails here directly.
describe('MilkdownEditorHandle commands needing a real ranged selection — wired-implementation verification', () => {
  const PLUGINS = [...EDITOR_SCHEMA_PLUGINS.flat(), ...EDITOR_COMMAND_PLUGINS]

  // Fix-round (second round) change: destroy is now handled by this
  // afterEach rather than inline at the end of each test body. Reviewer
  // finding: with an inline `await editor.destroy()` at the end of each
  // test, ONE real assertion failure earlier in a test body skips that
  // test's own destroy() call (a thrown assertion exits the test function
  // before reaching it) -- leaving that test's Editor instance, and its
  // DOM node appended to `document.body` by createTestEditor, alive for
  // every subsequent test in the file. Demonstrated by the reviewer: one
  // real mutation produced 4 reported failures where only 1 was the actual
  // bug. `currentEditor` is set by each test right after
  // `createTestEditor` resolves, and this `afterEach` always runs
  // (regardless of whether the test body threw), so a real failure no
  // longer leaks a live editor/DOM node into later tests.
  let currentEditor: Editor | null = null
  afterEach(async () => {
    if (currentEditor) {
      await currentEditor.destroy()
      currentEditor = null
    }
  })

  // "# Hello World" parses to doc(heading("Hello World")). Position 7 is
  // immediately before "W", position 12 immediately after the final "d" --
  // verified empirically against this exact content/plugin combination in
  // the scratch test referenced above.
  function selectWorld(editor: Editor): void {
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7, 12)))
    })
  }

  it('toggleBold() wraps a real selection in <strong>, and calling it again removes it', async () => {
    const editor = await createTestEditor('# Hello World', PLUGINS)
    currentEditor = editor
    const root = document.querySelector('.ProseMirror') as HTMLElement
    const commands = buildEditorCommands(editor)

    selectWorld(editor)
    commands.toggleBold()
    expect(root.querySelector('h1')?.innerHTML).toBe('Hello <strong>World</strong>')

    selectWorld(editor)
    commands.toggleBold()
    expect(root.querySelector('h1')?.innerHTML).toBe('Hello World')
  })

  it('toggleItalic() wraps a real selection in <em>, and calling it again removes it', async () => {
    const editor = await createTestEditor('# Hello World', PLUGINS)
    currentEditor = editor
    const root = document.querySelector('.ProseMirror') as HTMLElement
    const commands = buildEditorCommands(editor)

    selectWorld(editor)
    commands.toggleItalic()
    expect(root.querySelector('h1')?.innerHTML).toBe('Hello <em>World</em>')

    selectWorld(editor)
    commands.toggleItalic()
    expect(root.querySelector('h1')?.innerHTML).toBe('Hello World')
  })

  it('insertLink(href) wraps a real selection in a real <a href>', async () => {
    const editor = await createTestEditor('# Hello World', PLUGINS)
    currentEditor = editor
    const root = document.querySelector('.ProseMirror') as HTMLElement
    const commands = buildEditorCommands(editor)

    selectWorld(editor)
    commands.insertLink('https://example.com')

    const link = root.querySelector('h1 a')
    expect(link?.getAttribute('href')).toBe('https://example.com')
    expect(link?.textContent).toBe('World')
  })

  it('insertPageBreak() does not delete a non-empty selection -- selected text survives the insertion', async () => {
    // Fix-round finding (verified, not theorized): the original
    // insertPagebreakCommand called `state.tr.replaceSelectionWith(...)`
    // directly against whatever the current selection was, which REPLACES
    // (consumes) a ranged selection rather than just inserting at it --
    // "Hello World" with "Hello" selected produced a pagebreak node
    // followed by "<p> World</p>", with "Hello" silently gone. This test
    // reproduces that exact repro and asserts it no longer happens.
    const editor = await createTestEditor('# Hello World', PLUGINS)
    currentEditor = editor
    const root = document.querySelector('.ProseMirror') as HTMLElement
    const commands = buildEditorCommands(editor)

    // Select "Hello" (positions 1-6 inside the heading: position 1 is
    // right before "H", position 6 is right after the second "l" -- 5
    // characters).
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)))
    })

    commands.insertPageBreak()

    expect(root.querySelector('div[data-type="pagebreak"]')).toBeInTheDocument()
    expect(root.textContent).toContain('Hello')
    expect(root.textContent).toContain('World')
  })
})

describe('MilkdownEditor', () => {
  afterEach(() => {
    cleanup()
  })

  it('mounts and renders the initial content', async () => {
    const onChange = vi.fn()
    const onError = vi.fn()
    const { container } = render(
      <MilkdownEditor content="# Hello World" onChange={onChange} onError={onError} />
    )

    await waitFor(() => {
      expect(container.querySelector('.ProseMirror')).toBeInTheDocument()
    })
    expect(container.querySelector('h1')?.textContent).toBe('Hello World')
    expect(onError).not.toHaveBeenCalled()
  })

  it('calls onChange with serialized markdown after a real edit', async () => {
    const onChange = vi.fn()
    const onError = vi.fn()
    const { container } = render(
      <MilkdownEditor content="# Hello" onChange={onChange} onError={onError} />
    )

    const proseMirror = await waitFor(() => {
      const el = container.querySelector('.ProseMirror')
      if (!el) throw new Error('not mounted yet')
      return el as HTMLElement
    })

    // jsdom does not implement document.execCommand at all (confirmed
    // empirically; see task-2-report.md), so the brief's suggested trigger
    // can't run here. The real edit is instead driven the way ProseMirror
    // itself actually detects edits in a real browser too: a direct DOM
    // mutation under the ProseMirror-managed contenteditable root, which its
    // internal MutationObserver picks up and turns into a transaction --
    // confirmed empirically to reach the listener and call onChange the same
    // as any other real edit.
    const h1 = proseMirror.querySelector('h1')
    if (!h1?.firstChild) throw new Error('expected a text node inside the mounted h1')
    const range = document.createRange()
    range.selectNodeContents(h1)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    h1.firstChild.textContent = `${h1.firstChild.textContent} World`

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled()
    })
    expect(onChange.mock.calls.at(-1)?.[0]).toContain('World')
  })

  it('destroys the previous editor and mounts a fresh one when key changes', async () => {
    const onChange = vi.fn()
    const onError = vi.fn()
    const { container, rerender } = render(
      <MilkdownEditor key="a" content="# Doc A" onChange={onChange} onError={onError} />
    )
    await waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('Doc A'))

    rerender(<MilkdownEditor key="b" content="# Doc B" onChange={onChange} onError={onError} />)

    await waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('Doc B'))
    // Exactly one editor mount, not two stacked on top of each other.
    expect(container.querySelectorAll('.ProseMirror')).toHaveLength(1)
  })

  it('calls onError if editor construction fails', async () => {
    const onChange = vi.fn()
    const onError = vi.fn()
    // Empirically determined trigger (see task-2-report.md): the brief's
    // suggested trigger -- mounting into a root already removed from the
    // document -- was tried first and does NOT reject Editor.create() in
    // practice (ProseMirror mounts into detached DOM nodes without
    // complaint; verified directly against @milkdown/core in a throwaway
    // scratch test). What genuinely rejects Editor.create() is
    // defaultValueCtx receiving a value the markdown parser can't handle
    // at all -- confirmed directly against @milkdown/core, which rejects
    // with "Doc type error, unsupported type: ...". `content` is typed
    // `string`, so the only way to reach this through the real component
    // (not by calling Milkdown internals directly) is a caller violating
    // that contract -- exactly the kind of defensive case onError exists
    // for (e.g. a store bug handing the component a non-string value). An
    // object is used rather than `null`/`undefined` because those trip a
    // *different* internal null-dereference before reaching Milkdown's own
    // "Doc type error" check (verified empirically) -- still a rejection
    // that reaches onError, just a less on-point one to assert against.
    render(
      <MilkdownEditor
        content={{ not: 'a string' } as unknown as string}
        onChange={onChange}
        onError={onError}
      />
    )

    await waitFor(() => {
      expect(onError).toHaveBeenCalled()
    })
    expect(onError.mock.calls[0]?.[0]).toEqual(expect.stringContaining('Doc type error'))
  })

  it('flush() (via ref) is a no-op when called with zero edits since mount', async () => {
    const onChange = vi.fn()
    const onError = vi.fn()
    const ref = createRef<MilkdownEditorHandle>()
    const { container } = render(
      <MilkdownEditor ref={ref} content="# Hello" onChange={onChange} onError={onError} />
    )

    await waitFor(() => {
      expect(container.querySelector('.ProseMirror')).toBeInTheDocument()
    })

    // Review-round finding (see task-8-report.md): flush() must be a no-op
    // right after mount, before any edit -- otherwise every Save click (or
    // Home-navigation flush) on an untouched document would silently
    // re-serialize it through Milkdown's canonical stringify form. This
    // also guards against the concrete false positive that was found and
    // fixed here: preset-commonmark's own internal heading-ID-assignment
    // plugin dispatches a synthetic post-mount transaction with
    // `docChanged: true` (but `addToHistory: false`), which without the
    // addToHistory filter in MilkdownEditor.tsx's editedTrackerProse plugin
    // would incorrectly flip the edited flag on every single mount, not
    // just on a real user edit.
    ref.current?.flush()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('flush() (via ref) pushes a real edit through onChange before the debounced onChange fires', async () => {
    const onChange = vi.fn()
    const onError = vi.fn()
    const ref = createRef<MilkdownEditorHandle>()
    const { container } = render(
      <MilkdownEditor ref={ref} content="# Hello" onChange={onChange} onError={onError} />
    )

    const proseMirror = await waitFor(() => {
      const el = container.querySelector('.ProseMirror')
      if (!el) throw new Error('not mounted yet')
      return el as HTMLElement
    })

    const h1 = proseMirror.querySelector('h1')
    if (!h1?.firstChild) throw new Error('expected a text node inside the mounted h1')
    const range = document.createRange()
    range.selectNodeContents(h1)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    h1.firstChild.textContent = `${h1.firstChild.textContent} World`

    // ProseMirror's own MutationObserver needs one tick to turn the DOM
    // mutation into a real transaction (same mechanism the existing "real
    // edit" test above already relies on) before editedSinceMountRef flips
    // and flush() has anything to push -- so flush() is called repeatedly
    // from inside waitFor's own polling predicate rather than once, up
    // front. This wait must stay well under plugin-listener's 200ms
    // debounce, which is exactly the property under test. If this is flaky
    // at 100ms, that's useful information about the actual
    // mutation-to-transaction latency in this jsdom environment -- adjust
    // the timeout empirically rather than widening it past ~150ms, which
    // would stop distinguishing this test from the debounced case.
    await waitFor(
      () => {
        ref.current?.flush()
        expect(onChange).toHaveBeenCalled()
      },
      { timeout: 100 }
    )
    // The whole point of this fix: flush() via the ref must push the edit
    // through onChange before onChange's own debounce has had any chance to
    // fire on its own.
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0]?.[0]).toContain('World')
  })

  // Fix-round (second round) finding: mutation-testing
  // `useImperativeHandle`'s DELEGATION lines themselves (e.g. rewiring
  // `toggleBold: () => commandsRef.current?.toggleBold()` to call
  // `commandsRef.current?.toggleItalic()` instead -- a wrong delegation,
  // not a wrong underlying command key) passed all 186 tests from the
  // previous fix round. `MilkdownEditorHandle extends EditorCommands` only
  // enforces that each method on the handle *exists* with the right
  // signature, not that `useImperativeHandle`'s own body actually forwards
  // to the identically-named `commandsRef.current` method. This gap was
  // real for exactly the three methods that need a genuine ranged
  // selection to demonstrate via DOM assertions (toggleBold, toggleItalic,
  // insertLink) -- those were the ones routed around a full mounted-`ref`
  // test into the raw-Editor "wired-implementation verification" block
  // above, which calls `buildEditorCommands(editor)` directly and so never
  // exercises `MilkdownEditor.tsx`'s own `useImperativeHandle` delegation
  // lines at all. Every other method (toggleHeading, setParagraph, both
  // list toggles, insertTable, insertPageBreak, undo, redo) already has
  // mounted-`ref` coverage below and was NOT part of this gap.
  //
  // The three tests below close it, through the real mounted component +
  // `ref`, without needing a ranged selection: `toggleBold`/`toggleItalic`/
  // `insertLink` all call ProseMirror's `toggleMark` (or a toggleMark-
  // backed command) under the hood, which -- with a COLLAPSED selection --
  // sets a *stored mark* rather than rewriting existing text (see
  // MilkdownEditorHandle's own doc comments). A stored mark applies to the
  // NEXT typed character. Verified empirically (a throwaway scratch test,
  // deleted after use) that the raw-DOM-mutation "type a character" trick
  // these existing tests already use for edits DOES pick up a stored mark
  // -- confirmed by reading prosemirror-state's own `Transaction.
  // insertText` source (`node_modules/.pnpm/prosemirror-state.../dist/
  // index.js`), which reads `this.storedMarks` when constructing the
  // inserted text node. This is a different, and reliable, mechanism from
  // `@testing-library/user-event`'s `.type()`, which was tried FIRST and
  // does NOT work for this in this environment (also verified empirically,
  // also via a deleted throwaway test): it produced plain, unmarked text,
  // and separately threw an uncaught `TypeError` from ProseMirror's own
  // `posAtCoords` during the click userEvent performs first (jsdom doesn't
  // implement `document.elementFromPoint`).
  it('toggleBold() at a collapsed cursor sets a stored mark: the next typed character renders as <strong>', async () => {
    const onChange = vi.fn()
    const onError = vi.fn()
    const ref = createRef<MilkdownEditorHandle>()
    const { container } = render(
      <MilkdownEditor ref={ref} content="Hello" onChange={onChange} onError={onError} />
    )
    const proseMirror = await waitFor(() => {
      const el = container.querySelector('.ProseMirror')
      if (!el) throw new Error('not mounted yet')
      return el as HTMLElement
    })
    const p = proseMirror.querySelector('p')
    if (!p?.firstChild) throw new Error('expected a text node inside the mounted p')

    ref.current?.toggleBold()
    p.firstChild.textContent = `${p.firstChild.textContent}X`

    await waitFor(() => {
      expect(proseMirror.querySelector('strong')?.textContent).toBe('X')
    })
    expect(proseMirror.innerHTML).toBe('<p>Hello<strong>X</strong></p>')
  })

  it('toggleItalic() at a collapsed cursor sets a stored mark: the next typed character renders as <em>', async () => {
    const onChange = vi.fn()
    const onError = vi.fn()
    const ref = createRef<MilkdownEditorHandle>()
    const { container } = render(
      <MilkdownEditor ref={ref} content="Hello" onChange={onChange} onError={onError} />
    )
    const proseMirror = await waitFor(() => {
      const el = container.querySelector('.ProseMirror')
      if (!el) throw new Error('not mounted yet')
      return el as HTMLElement
    })
    const p = proseMirror.querySelector('p')
    if (!p?.firstChild) throw new Error('expected a text node inside the mounted p')

    ref.current?.toggleItalic()
    p.firstChild.textContent = `${p.firstChild.textContent}X`

    await waitFor(() => {
      expect(proseMirror.querySelector('em')?.textContent).toBe('X')
    })
    expect(proseMirror.innerHTML).toBe('<p>Hello<em>X</em></p>')
  })

  it('insertLink(href) at a collapsed cursor sets a stored mark: the next typed character renders inside a real <a href>', async () => {
    const onChange = vi.fn()
    const onError = vi.fn()
    const ref = createRef<MilkdownEditorHandle>()
    const { container } = render(
      <MilkdownEditor ref={ref} content="Hello" onChange={onChange} onError={onError} />
    )
    const proseMirror = await waitFor(() => {
      const el = container.querySelector('.ProseMirror')
      if (!el) throw new Error('not mounted yet')
      return el as HTMLElement
    })
    const p = proseMirror.querySelector('p')
    if (!p?.firstChild) throw new Error('expected a text node inside the mounted p')

    ref.current?.insertLink('https://example.com')
    p.firstChild.textContent = `${p.firstChild.textContent}X`

    await waitFor(() => {
      expect(proseMirror.querySelector('a')?.textContent).toBe('X')
    })
    const link = proseMirror.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://example.com')
    expect(proseMirror.innerHTML).toBe('<p>Hello<a href="https://example.com">X</a></p>')
  })

  // The block-level command tests below rely on the editor's OWN default
  // initial selection (ProseMirror's `Selection.atStart(doc)`, resolving
  // inside the first block) rather than the DOM Range/Selection trick used
  // above, for the same reason the mark-toggle describe block above gives:
  // jsdom's Selection/Range API does not sync into ProseMirror's
  // `state.selection` at all (verified empirically there), so it can't be
  // used to move the cursor to a specific position either. Each test's
  // `content` is written as a single block so that the default start-of-doc
  // selection already resolves inside the exact block under test.
  it('toggleHeading(2) turns the current paragraph into an h2, and calling it again reverts to a paragraph', async () => {
    const onChange = vi.fn()
    const onError = vi.fn()
    const ref = createRef<MilkdownEditorHandle>()
    const { container } = render(
      <MilkdownEditor
        ref={ref}
        content="Some paragraph text"
        onChange={onChange}
        onError={onError}
      />
    )
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeInTheDocument())
    expect(container.querySelector('p')?.textContent).toBe('Some paragraph text')

    ref.current?.toggleHeading(2)
    expect(container.querySelector('h2')?.textContent).toBe('Some paragraph text')
    expect(container.querySelector('p')).not.toBeInTheDocument()

    ref.current?.toggleHeading(2)
    expect(container.querySelector('p')?.textContent).toBe('Some paragraph text')
    expect(container.querySelector('h2')).not.toBeInTheDocument()
  })

  it('toggleBulletList wraps the current block in a bullet list, and calling it again lifts it back out', async () => {
    const onChange = vi.fn()
    const onError = vi.fn()
    const ref = createRef<MilkdownEditorHandle>()
    const { container } = render(
      <MilkdownEditor ref={ref} content="List target" onChange={onChange} onError={onError} />
    )
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeInTheDocument())

    ref.current?.toggleBulletList()
    expect(container.querySelector('ul > li')?.textContent).toBe('List target')

    ref.current?.toggleBulletList()
    expect(container.querySelector('ul')).not.toBeInTheDocument()
    expect(container.querySelector('p')?.textContent).toBe('List target')
  })

  it('toggleOrderedList wraps the current block in an ordered list, and calling it again lifts it back out', async () => {
    const onChange = vi.fn()
    const onError = vi.fn()
    const ref = createRef<MilkdownEditorHandle>()
    const { container } = render(
      <MilkdownEditor ref={ref} content="Ordered target" onChange={onChange} onError={onError} />
    )
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeInTheDocument())

    ref.current?.toggleOrderedList()
    expect(container.querySelector('ol > li')?.textContent).toBe('Ordered target')

    ref.current?.toggleOrderedList()
    expect(container.querySelector('ol')).not.toBeInTheDocument()
    expect(container.querySelector('p')?.textContent).toBe('Ordered target')
  })

  it('Fix-round: toggleBulletList() SWITCHES an ordered list to a bullet list (not a silent no-op)', async () => {
    // Fix-round finding (verified, not theorized): the original
    // isInListType helper only checked the TARGET type, so with the cursor
    // in an `ordered_list`, toggleBulletList() took the "wrap" branch --
    // and ProseMirror's `wrapIn` (which wrapInBulletListCommand calls)
    // silently no-ops when the selection is already inside ANY list. The
    // `<ol>` stayed an `<ol>`, byte-identical before/after, with zero
    // feedback. This test starts the document already inside an ordered
    // list (real markdown source, "1. Ordered item") and asserts
    // toggleBulletList() genuinely converts it.
    const onChange = vi.fn()
    const onError = vi.fn()
    const ref = createRef<MilkdownEditorHandle>()
    const { container } = render(
      <MilkdownEditor ref={ref} content="1. Ordered item" onChange={onChange} onError={onError} />
    )
    await waitFor(() =>
      expect(container.querySelector('ol > li')?.textContent).toBe('Ordered item')
    )

    ref.current?.toggleBulletList()

    expect(container.querySelector('ol')).not.toBeInTheDocument()
    expect(container.querySelector('ul > li')?.textContent).toBe('Ordered item')
  })

  it('Fix-round: toggleOrderedList() SWITCHES a bullet list to an ordered list (not a silent no-op)', async () => {
    const onChange = vi.fn()
    const onError = vi.fn()
    const ref = createRef<MilkdownEditorHandle>()
    const { container } = render(
      <MilkdownEditor ref={ref} content="- Bullet item" onChange={onChange} onError={onError} />
    )
    await waitFor(() => expect(container.querySelector('ul > li')?.textContent).toBe('Bullet item'))

    ref.current?.toggleOrderedList()

    expect(container.querySelector('ul')).not.toBeInTheDocument()
    expect(container.querySelector('ol > li')?.textContent).toBe('Bullet item')
  })

  it('setParagraph() unconditionally converts the current block to a plain paragraph', async () => {
    // Fix-round finding: an earlier version of this method (and its own
    // doc comment) incorrectly claimed there was no way to clear a heading
    // back to a paragraph without knowing its current level first.
    // wrapInHeadingCommand(0) -> paragraph works regardless of the
    // starting level -- this test checks it against both h1 and h3 to
    // demonstrate it genuinely doesn't depend on the current level.
    const onChange = vi.fn()
    const onError = vi.fn()
    const ref = createRef<MilkdownEditorHandle>()
    const { container } = render(
      <MilkdownEditor ref={ref} content="# Heading One" onChange={onChange} onError={onError} />
    )
    await waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('Heading One'))

    ref.current?.setParagraph()

    expect(container.querySelector('h1')).not.toBeInTheDocument()
    expect(container.querySelector('p')?.textContent).toBe('Heading One')
  })

  it('setParagraph() works from a deeper heading level too (h3), not just h1', async () => {
    const onChange = vi.fn()
    const onError = vi.fn()
    const ref = createRef<MilkdownEditorHandle>()
    const { container } = render(
      <MilkdownEditor ref={ref} content="### Heading Three" onChange={onChange} onError={onError} />
    )
    await waitFor(() => expect(container.querySelector('h3')?.textContent).toBe('Heading Three'))

    ref.current?.setParagraph()

    expect(container.querySelector('h3')).not.toBeInTheDocument()
    expect(container.querySelector('p')?.textContent).toBe('Heading Three')
  })

  it('insertTable inserts a real 2x2 table (one header row + one body row) at the cursor', async () => {
    const onChange = vi.fn()
    const onError = vi.fn()
    const ref = createRef<MilkdownEditorHandle>()
    const { container } = render(
      <MilkdownEditor ref={ref} content="Doc" onChange={onChange} onError={onError} />
    )
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeInTheDocument())

    ref.current?.insertTable()

    const table = container.querySelector('table')
    expect(table).toBeInTheDocument()
    // `row: 2` counts the header row (see insertTableCommand's own
    // createTable helper) -- one header row (`<th>` cells) plus one plain
    // body row (`<td>` cells), two columns each.
    expect(table?.querySelectorAll('th')).toHaveLength(2)
    expect(table?.querySelectorAll('td')).toHaveLength(2)
  })

  it('insertPageBreak inserts the shared pagebreak node at the cursor', async () => {
    const onChange = vi.fn()
    const onError = vi.fn()
    const ref = createRef<MilkdownEditorHandle>()
    const { container } = render(
      <MilkdownEditor ref={ref} content="Doc" onChange={onChange} onError={onError} />
    )
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeInTheDocument())

    ref.current?.insertPageBreak()

    expect(container.querySelector('div[data-type="pagebreak"]')).toBeInTheDocument()
  })

  it('undo() reverts a real edit and redo() re-applies it', async () => {
    const onChange = vi.fn()
    const onError = vi.fn()
    const ref = createRef<MilkdownEditorHandle>()
    const { container } = render(
      <MilkdownEditor ref={ref} content="# Hello" onChange={onChange} onError={onError} />
    )

    const proseMirror = await waitFor(() => {
      const el = container.querySelector('.ProseMirror')
      if (!el) throw new Error('not mounted yet')
      return el as HTMLElement
    })

    // Same real-DOM-mutation edit technique as the existing "real edit"
    // test above (ProseMirror's own MutationObserver turns this into a real,
    // undoable transaction -- confirmed by this test's own assertions below).
    const h1 = proseMirror.querySelector('h1')
    if (!h1?.firstChild) throw new Error('expected a text node inside the mounted h1')
    h1.firstChild.textContent = `${h1.firstChild.textContent} World`

    await waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('Hello World'))

    ref.current?.undo()
    await waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('Hello'))

    ref.current?.redo()
    await waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('Hello World'))
  })
})
