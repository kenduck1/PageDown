import { describe, it, expect, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { getMarkdown } from '@milkdown/utils'
import { commandsCtx, editorViewCtx } from '@milkdown/core'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { createTestEditor } from '../test-editor'
import { EDITOR_SCHEMA_PLUGINS } from '../plugins'
import { EDITOR_COMMAND_PLUGINS, insertTocCommand } from '../commands'

afterEach(() => {
  cleanup()
})

// The FULL shipped composition, schema plus behaviour, because half of what
// this file has to prove (the live node view) lives in the behaviour half and
// the other half (round-trip fidelity) lives in the schema half.
const PLUGINS = [...EDITOR_SCHEMA_PLUGINS.flat(), ...EDITOR_COMMAND_PLUGINS]

async function open(source: string): Promise<EditorView> {
  const editor = await createTestEditor(source, PLUGINS)
  return editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
}

async function roundTrip(source: string): Promise<string> {
  const editor = await createTestEditor(source, PLUGINS)
  const result = editor.action(getMarkdown())
  await editor.destroy()
  return result
}

function topLevelTypes(view: EditorView): string[] {
  const types: string[] = []
  view.state.doc.forEach((node) => types.push(node.type.name))
  return types
}

function tocDom(view: EditorView): HTMLElement {
  const element = view.dom.querySelector('.pagedown-toc')
  if (!(element instanceof HTMLElement)) throw new Error('no .pagedown-toc rendered')
  return element
}

function entryTexts(view: EditorView): string[] {
  return [...tocDom(view).querySelectorAll('a')].map((anchor) => anchor.textContent ?? '')
}

describe('Milkdown toc node: round trip', () => {
  it('round-trips a <!-- toc --> marker byte-for-byte', async () => {
    const markdown = 'Intro.\n\n<!-- toc -->\n\n# One\n'
    expect(await roundTrip(markdown)).toBe(markdown)
  })

  it('produces a REAL toc ProseMirror node, not inert text that merely round-trips', async () => {
    // THE assertion this file exists for. CLAUDE.md records the exact trap:
    // Milkdown already round-tripped the pagebreak marker byte-for-byte as
    // INERT TEXT with zero custom plugins, so a byte-identity test alone
    // cannot tell "wired up" from "not wired up at all". Only the node types
    // can. Mutation-checked: dropping tocRemark/tocNode from
    // EDITOR_SCHEMA_PLUGINS leaves the byte test above green and fails this.
    const view = await open('Intro.\n\n<!-- toc -->\n\n# One\n')
    expect(topLevelTypes(view)).toEqual(['paragraph', 'toc', 'heading'])
  })

  it("keeps an author's [TOC] as [TOC] through a Format-mode edit", async () => {
    // The `raw` losslessness path, end to end through ProseMirror attrs --
    // the plugin-level fix alone does nothing here, because the literal is
    // recovered on parse and then thrown away the moment the editor
    // serializes unless the node carries it across.
    expect(await roundTrip('[TOC]\n\n# One\n')).toBe('[TOC]\n\n# One\n')
    expect(await roundTrip('[[TOC]]\n\n# One\n')).toBe('[[TOC]]\n\n# One\n')
    const view = await open('[TOC]\n\n# One\n')
    expect(topLevelTypes(view)).toEqual(['toc', 'heading'])
  })

  it('carries an explicit depth across the round trip', async () => {
    expect(await roundTrip('<!-- toc depth="2" -->\n\n# One\n')).toBe(
      '<!-- toc depth="2" -->\n\n# One\n'
    )
    const view = await open('<!-- toc depth="2" -->\n\n# One\n')
    expect(view.state.doc.firstChild?.attrs.depth).toBe(2)
  })

  it('does not turn a bracket spelling used inside a sentence into a node', async () => {
    const view = await open('See [TOC] below.\n')
    expect(topLevelTypes(view)).toEqual(['paragraph'])
    expect(view.state.doc.textContent).toBe('See [TOC] below.')
    // Comes back with the bracket BACKSLASH-ESCAPED, and that is stock
    // mdast-util-to-markdown behaviour for any `[` in running text (it could
    // otherwise open a link), completely independent of this feature --
    // verified against `See [X] below.`, which escapes identically with no
    // TOC plugin involved. Pinned here rather than papered over so a future
    // reader does not mistake it for something this transform did.
    expect(await roundTrip('See [TOC] below.\n')).toBe('See \\[TOC] below.\n')
    expect(await roundTrip('See [X] below.\n')).toBe('See \\[X] below.\n')
  })
})

describe('Milkdown toc node: the live node view', () => {
  it("renders the document's real headings, nested, rather than an opaque summary", async () => {
    const view = await open('<!-- toc -->\n\n# One\n\n## Two\n\n# Three\n')

    expect(entryTexts(view)).toEqual(['One', 'Two', 'Three'])
    // Nesting mirrors src/markdown/toc-to-hast.ts's own builder: one <ol>
    // level per heading level, so the two surfaces indent identically.
    const nested = tocDom(view).querySelectorAll('ol ol')
    expect(nested).toHaveLength(1)
    expect(nested[0].textContent).toBe('Two')
  })

  it("honours the marker's own depth", async () => {
    const view = await open('<!-- toc depth="1" -->\n\n# One\n\n## Two\n')
    expect(entryTexts(view)).toEqual(['One'])
  })

  it("updates when a heading's text changes, WITHOUT mutating the toc node", async () => {
    // The whole point of the decoration-signature mechanism: the list has to
    // track every heading in the document, but ProseMirror only calls a node
    // view's update() when THAT node changes. Writing the entries into the
    // toc node's attrs would have kept update() firing -- and would have
    // dispatched a document-changing transaction on every keystroke, marking
    // a clean document dirty.
    const view = await open('<!-- toc -->\n\n# One\n')
    expect(entryTexts(view)).toEqual(['One'])

    const before = view.state.doc.firstChild
    let pos = -1
    view.state.doc.descendants((node, at) => {
      if (node.type.name === 'heading') pos = at
      return true
    })
    view.dispatch(view.state.tr.insertText(' Edited', pos + 1 + 'One'.length))

    expect(entryTexts(view)).toEqual(['One Edited'])
    expect(view.state.doc.firstChild?.eq(before!)).toBe(true)
  })

  it('picks up a heading added after the marker', async () => {
    const view = await open('<!-- toc -->\n\n# One\n')
    const end = view.state.doc.content.size
    const heading = view.state.schema.nodes.heading.create(
      { level: 2 },
      view.state.schema.text('Two')
    )
    view.dispatch(view.state.tr.insert(end, heading))

    expect(entryTexts(view)).toEqual(['One', 'Two'])
  })

  it('shows an editor-only placeholder when nothing is in range, and no placeholder once one appears', async () => {
    // Deliberately has NO paginated counterpart -- createTocToHast emits an
    // empty container there. This is chrome telling the author their marker
    // was recognized, in the same category as `.pagedown-image-note`; putting
    // it on the print surface would add words the source never contained.
    const view = await open('<!-- toc -->\n\nJust prose.\n')
    const placeholder = tocDom(view).querySelector('.pagedown-toc-placeholder')
    expect(placeholder?.textContent).toContain('no headings')

    const heading = view.state.schema.nodes.heading.create(
      { level: 1 },
      view.state.schema.text('Now')
    )
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, heading))
    expect(tocDom(view).querySelector('.pagedown-toc-placeholder')).toBeNull()
    expect(entryTexts(view)).toEqual(['Now'])
  })

  it('renders anchors with NO href -- this renderer is a real file:// origin', async () => {
    const view = await open('<!-- toc -->\n\n# One\n')
    expect(tocDom(view).querySelector('a')?.hasAttribute('href')).toBe(false)
  })

  it('moves the caret to a heading on click without marking the document dirty', async () => {
    const view = await open('<!-- toc -->\n\n# One\n\n## Two\n')
    const anchors = tocDom(view).querySelectorAll('a')
    const before = view.state.doc

    anchors[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

    // A selection-only transaction: the doc is untouched, which is what stops
    // this tripping MilkdownEditor's editedSinceMountRef.
    expect(view.state.doc).toBe(before)
    expect(view.state.selection.$from.parent.textContent).toBe('Two')
  })
})

describe('insertTocCommand', () => {
  async function run(
    source: string,
    prepare?: (view: EditorView) => void
  ): Promise<{ view: EditorView; applied: boolean; markdown: string }> {
    const editor = await createTestEditor(source, PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    prepare?.(view)
    const applied = editor.action((ctx) =>
      ctx.get(commandsCtx).call(insertTocCommand.key)
    ) as boolean
    return { view, applied, markdown: editor.action(getMarkdown()) }
  }

  it('inserts a real toc node and serializes it as the canonical marker', async () => {
    const { view, applied, markdown } = await run('')
    expect(applied).toBe(true)
    expect(topLevelTypes(view)).toContain('toc')
    expect(markdown).toContain('<!-- toc -->')
  })

  it('does not CONSUME a ranged selection -- the bug insertPagebreakCommand already fixed once', async () => {
    const { markdown } = await run('Hello World', (view) => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)))
    })
    expect(markdown).toContain('Hello World')
  })

  it('refuses inside a table cell rather than corrupting the table', async () => {
    // isInsideTableCell, shared with insertPagebreakCommand: replaceSelectionWith
    // does not refuse there, it walks outward and restructures the enclosing
    // table into a corrupted three-table document.
    const source = '| a | b |\n| --- | --- |\n| x | y |\n'
    const { applied, markdown } = await run(source, (view) => {
      let pos = -1
      view.state.doc.descendants((node, at) => {
        if (node.isText && node.text === 'x') pos = at
        return true
      })
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)))
    })
    expect(applied).toBe(false)
    expect(markdown).not.toContain('<!-- toc -->')
    // Still ONE table with its two original rows intact -- the corruption
    // this guard prevents produces three tables and replaces the sibling
    // cell's content with `<br />`. The delimiter row comes back as `| - |`
    // rather than `| --- |` purely because that is how @milkdown/preset-gfm's
    // own serializer writes it; unrelated to this command.
    expect(markdown).toContain('| x | y |')
    expect(markdown.match(/\| a \| b \|/g)).toHaveLength(1)
    expect(markdown).not.toContain('<br />')
  })
})
