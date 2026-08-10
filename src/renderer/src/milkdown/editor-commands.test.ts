import { describe, it, expect, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { editorViewCtx, type Editor } from '@milkdown/core'
import { getMarkdown } from '@milkdown/utils'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { createTestEditor } from './test-editor'
import { EDITOR_COMMAND_PLUGINS } from './commands'
import { EDITOR_SCHEMA_PLUGINS } from './plugins'
import { buildEditorCommands, type EditorCommands } from './editor-commands'
import { readLinkHref, readSelectionSnapshot } from './selection-plugin'

afterEach(() => {
  cleanup()
})

const PLUGINS = [...EDITOR_SCHEMA_PLUGINS.flat(), ...EDITOR_COMMAND_PLUGINS]

interface Harness {
  editor: Editor
  view: EditorView
  commands: EditorCommands
  markdown: () => string
  selectText: (text: string) => void
  /** Selects `length` characters starting `offset` characters into `text`. */
  selectWithin: (text: string, offset: number, length: number) => void
  caretIn: (text: string) => void
}

async function harness(source: string): Promise<Harness> {
  const editor = await createTestEditor(source, PLUGINS)
  const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
  // Substring-aware: 'See docs here.' is ONE text node, so an exact-match
  // finder would never locate 'docs' inside it.
  const find = (text: string): number => {
    let pos: number | null = null
    view.state.doc.descendants((node, p) => {
      if (pos !== null) return false
      const index = node.isText ? (node.text ?? '').indexOf(text) : -1
      if (index !== -1) pos = p + index
      return true
    })
    if (pos === null) throw new Error(`no text "${text}"`)
    return pos
  }
  return {
    editor,
    view,
    commands: buildEditorCommands(editor),
    markdown: () => editor.action(getMarkdown()),
    selectText: (text) => {
      const from = find(text)
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + text.length))
      )
    },
    selectWithin: (text, offset, length) => {
      const from = find(text) + offset
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + length))
      )
    },
    caretIn: (text) => {
      const from = find(text)
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from + 1)))
    }
  }
}

// THE regression this whole link half exists for, and the one worth reading the
// mechanism for before touching it.
//
// `insertLink` used to call `toggleLinkCommand` unconditionally. That is a
// plain ProseMirror `toggleMark`, which defaults `removeWhenPresent` to true
// and branches on `rangeHasMark(..., markType)` -- THE ATTRS ARE NOT CONSULTED.
// So selecting an already-linked phrase and submitting a corrected URL ran
// `tr.removeMark(...)`: the link was stripped and the new href thrown away,
// silently. Submitting a second time re-added it, which is how the bug read as
// "you have to do it twice" rather than as data loss.
//
// The fix branches on markActive and dispatches @milkdown/preset-commonmark's
// own `updateLinkCommand` (which exists, does exactly the right thing, and was
// imported nowhere in this project) for the already-linked case.
describe('insertLink', () => {
  it('UPDATES an existing link in place rather than destroying it', async () => {
    const { commands, markdown, selectText } = await harness(
      'See [docs](https://old.example.com) here.\n'
    )
    selectText('docs')
    commands.insertLink('https://new.example.com')
    expect(markdown()).toBe('See [docs](https://new.example.com) here.\n')
  })

  it('is idempotent -- submitting the same corrected URL twice keeps the link', async () => {
    // Pinning this specifically because the OLD behaviour was a toggle: two
    // submissions used to be strip-then-restore, so a test that submitted once
    // and then again could pass against the broken code.
    const { commands, markdown, selectText } = await harness(
      'See [docs](https://old.example.com) here.\n'
    )
    selectText('docs')
    commands.insertLink('https://new.example.com')
    selectText('docs')
    commands.insertLink('https://new.example.com')
    expect(markdown()).toBe('See [docs](https://new.example.com) here.\n')
  })

  it('still CREATES a link over unlinked text', async () => {
    const { commands, markdown, selectText } = await harness('See docs here.\n')
    selectText('docs')
    commands.insertLink('https://example.com')
    expect(markdown()).toBe('See [docs](https://example.com) here.\n')
  })

  it('updates from a bare caret inside the link, not only from a selection', async () => {
    const { commands, markdown, caretIn } = await harness(
      'See [docs](https://old.example.com) here.\n'
    )
    caretIn('docs')
    commands.insertLink('https://new.example.com')
    expect(markdown()).toBe('See [docs](https://new.example.com) here.\n')
  })
})

describe('removeLink', () => {
  it('removes the whole link from a bare caret inside it', async () => {
    const { commands, markdown, caretIn } = await harness('See [docs](https://example.com) here.\n')
    caretIn('docs')
    commands.removeLink()
    expect(markdown()).toBe('See docs here.\n')
  })

  it('removes the WHOLE link from a partial selection, never half of it', async () => {
    // toggleLinkCommand would have split this into `[do](url)cs`; the point of
    // a separate unlinkCommand is that "Remove link" has exactly one sensible
    // meaning wherever the caret happens to be.
    const { commands, markdown, selectWithin } = await harness(
      'See [documents](https://example.com) here.\n'
    )
    // "cum" -- strictly inside the linked run, touching neither end.
    selectWithin('documents', 3, 3)
    commands.removeLink()
    expect(markdown()).toBe('See documents here.\n')
  })

  it('is a no-op on unlinked text', async () => {
    const { commands, markdown, selectText } = await harness('See docs here.\n')
    selectText('docs')
    commands.removeLink()
    expect(markdown()).toBe('See docs here.\n')
  })
})

// The composer prefills from this, which is the other half of making an
// existing link editable at all: before it, the URL field opened blank every
// time, so there was no way to even SEE the current URL.
describe('readLinkHref (what the composer prefills from)', () => {
  it('reads the href under a selection', async () => {
    const { view, selectText } = await harness('See [docs](https://example.com) here.\n')
    selectText('docs')
    expect(readLinkHref(view.state)).toBe('https://example.com')
  })

  it('reads the href under a bare caret inside the link', async () => {
    const { view, caretIn } = await harness('See [docs](https://example.com) here.\n')
    caretIn('docs')
    expect(readLinkHref(view.state)).toBe('https://example.com')
  })

  it('is null when the selection carries no link', async () => {
    const { view, selectText } = await harness('See docs here.\n')
    selectText('docs')
    expect(readLinkHref(view.state)).toBeNull()
  })

  it('is reported on the selection snapshot, which is what EditorScreen threads', async () => {
    const { view, selectText } = await harness('See [docs](https://example.com) here.\n')
    selectText('docs')
    expect(readSelectionSnapshot(view).linkHref).toBe('https://example.com')
  })
})

// The toolbar's Checklist button had NO backing command at all until this pass,
// despite GFM task lists working end to end everywhere else in the app.
describe('toggleTaskList', () => {
  it('turns a plain paragraph into an unchecked task item', async () => {
    const { commands, markdown } = await harness('Buy milk\n')
    commands.toggleTaskList()
    expect(markdown()).toBe('- [ ] Buy milk\n')
  })

  it('turns a task item back into a plain bullet (a real toggle, unlike the slash item)', async () => {
    const { commands, markdown } = await harness('- [ ] Buy milk\n')
    commands.toggleTaskList()
    expect(markdown()).toBe('- Buy milk\n')
  })

  it('un-tasks a CHECKED item too, rather than only an unchecked one', async () => {
    const { commands, markdown } = await harness('- [x] Buy milk\n')
    commands.toggleTaskList()
    expect(markdown()).toBe('- Buy milk\n')
  })

  it('turns an ordinary bullet into a task item', async () => {
    const { commands, markdown } = await harness('- Buy milk\n')
    commands.toggleTaskList()
    expect(markdown()).toBe('- [ ] Buy milk\n')
  })

  it('is reported on the selection snapshot, distinctly from plain bullet membership', async () => {
    const plain = await harness('- Buy milk\n')
    expect(readSelectionSnapshot(plain.view).taskList).toBe(false)
    expect(readSelectionSnapshot(plain.view).listType).toBe('bullet_list')

    const task = await harness('- [ ] Buy milk\n')
    expect(readSelectionSnapshot(task.view).taskList).toBe(true)
    // Every task item is ALSO a bullet list item -- which is exactly why the
    // toolbar's Checklist button reads `taskList` and not `listType`.
    expect(readSelectionSnapshot(task.view).listType).toBe('bullet_list')
  })
})
