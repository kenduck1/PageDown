import { describe, expect, it } from 'vitest'
import { Editor, rootCtx, defaultValueCtx, remarkStringifyOptionsCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { getMarkdown, insert } from '@milkdown/utils'
import { PINNED_STRINGIFY_OPTIONS } from './stringify-options'

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

import { createRef } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import MilkdownEditor, { type MilkdownEditorHandle } from './MilkdownEditor'

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

  it('getMarkdown (via ref) reflects a real edit before the debounced onChange fires', async () => {
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

    // Review-round finding (see task-8-report.md): getMarkdown() must be
    // null right after mount, before any edit -- otherwise every Save click
    // on an untouched document would silently re-serialize it through
    // Milkdown's canonical stringify form. This also guards against the
    // concrete false positive that was found and fixed here:
    // preset-commonmark's own internal heading-ID-assignment plugin
    // dispatches a synthetic post-mount transaction with `docChanged: true`
    // (but `addToHistory: false`), which without the addToHistory filter in
    // MilkdownEditor.tsx's editedTrackerProse plugin would incorrectly flip
    // the edited flag on every single mount, not just on a real user edit.
    expect(ref.current?.getMarkdown()).toBeNull()

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
    // edit" test above already relies on) -- but this wait must stay well
    // under plugin-listener's 200ms debounce, which is exactly the property
    // under test. If this is flaky at 100ms, that's useful information about
    // the actual mutation-to-transaction latency in this jsdom environment --
    // adjust the timeout empirically rather than widening it past ~150ms,
    // which would stop distinguishing this test from the debounced case.
    await waitFor(
      () => {
        expect(ref.current?.getMarkdown()).toContain('World')
      },
      { timeout: 100 }
    )
    // The whole point of this fix: getMarkdown() via the ref must see the
    // edit before onChange's debounce has had any chance to fire.
    expect(onChange).not.toHaveBeenCalled()
  })
})
