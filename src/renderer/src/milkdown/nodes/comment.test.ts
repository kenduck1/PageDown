import { describe, it, expect } from 'vitest'
import { commandsCtx, editorViewCtx } from '@milkdown/core'
import { getMarkdown } from '@milkdown/utils'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import type { Node as ProseNode } from '@milkdown/prose/model'
import { createTestEditor } from '../test-editor'
import { EDITOR_SCHEMA_PLUGINS } from '../plugins'
import { EDITOR_COMMAND_PLUGINS, addCommentCommand } from '../commands'
import { extractComments } from '../../lib/extractComments'
import { markdownToHtml } from '../../../../markdown/pipeline'

// The whole point of this file: a HAND-WRAPPED paragraph. `commands.test.ts`
// already covers commenting inside a single-line paragraph, and that fixture
// structurally CANNOT distinguish correct from incorrect behaviour here --
// with no line break in the marked span there is nothing to split around.
// Same anti-pattern CLAUDE.md records for Gate 29's empty-paragraph fixture,
// so this fixture is deliberately the one that discriminates.
const HAND_WRAPPED = 'Intro paragraph.\n\nfirst line\nsecond line tail.\n'

const PLUGINS = [...EDITOR_SCHEMA_PLUGINS.flat(), ...EDITOR_COMMAND_PLUGINS]

function findParagraph(doc: ProseNode, startsWith: string): { pos: number; node: ProseNode } {
  let found: { pos: number; node: ProseNode } | null = null
  doc.forEach((node, offset) => {
    if (node.type.name === 'paragraph' && node.textContent.startsWith(startsWith)) {
      found = { pos: offset, node }
    }
  })
  if (!found) throw new Error(`no paragraph starting with ${JSON.stringify(startsWith)}`)
  return found
}

function inlineTypes(paragraph: ProseNode): string[] {
  const types: string[] = []
  paragraph.forEach((child) => types.push(child.type.name))
  return types
}

async function commentWholeWrappedParagraph(source = HAND_WRAPPED): Promise<{
  view: EditorView
  applied: boolean
  saved: string
}> {
  const editor = await createTestEditor(source, PLUGINS)
  const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView

  const { pos, node } = findParagraph(view.state.doc, 'first line')
  const from = pos + 1
  const to = from + node.content.size
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))

  const applied = editor.action((ctx) =>
    ctx.get(commandsCtx).call(addCommentCommand.key, { author: 'Kai', text: 'a note' })
  ) as boolean

  return { view, applied, saved: editor.action(getMarkdown()) }
}

describe('comment mark across a hand-wrapped (soft line break) paragraph', () => {
  it('parses the hand-wrapped paragraph as one block containing a hardbreak', async () => {
    const editor = await createTestEditor(HAND_WRAPPED, PLUGINS)
    const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    const { pos, node } = findParagraph(view.state.doc, 'first line')

    // Asserted on doc.content node TYPES, not just on bytes: CLAUDE.md
    // records that Milkdown round-tripped the pagebreak marker perfectly as
    // inert text with zero custom plugins, so a byte assertion alone proves
    // nothing about what the schema actually built.
    expect(inlineTypes(node)).toEqual(['text', 'hardbreak', 'text'])

    // The single-block scope guard is CORRECTLY satisfied here -- a hardbreak
    // lives INSIDE one block, so this is not a case addCommentCommand should
    // start refusing. The defect is in serialisation, not in the guard.
    const from = pos + 1
    const to = from + node.content.size
    expect(view.state.doc.resolve(from).sameParent(view.state.doc.resolve(to))).toBe(true)
  })

  it('emits exactly ONE marker pair for one comment', async () => {
    const { applied, saved } = await commentWholeWrappedParagraph()
    expect(applied).toBe(true)

    expect((saved.match(/<!--comment id=/g) ?? []).length).toBe(1)
    expect((saved.match(/<!--\/comment id=/g) ?? []).length).toBe(1)
  })

  it('reads back as ONE sidebar entry, not a duplicate-id pair', async () => {
    const { saved } = await commentWholeWrappedParagraph()
    const extracted = extractComments(saved)

    expect(extracted).toHaveLength(1)
    // The mark covers the whole wrapped paragraph, both lines.
    expect(extracted[0]?.matchedText).toContain('first line')
    expect(extracted[0]?.matchedText).toContain('second line tail.')
  })

  it('renders the same number of paragraphs as before the comment, with no stray backslash', async () => {
    const before = markdownToHtml(HAND_WRAPPED).html
    const { saved } = await commentWholeWrappedParagraph()
    const after = markdownToHtml(saved).html

    const paragraphCount = (html: string): number => (html.match(/<p[\s>]/g) ?? []).length
    expect(paragraphCount(before)).toBe(2)
    expect(paragraphCount(after)).toBe(paragraphCount(before))

    // A comment renders as nothing at all on the paginated surface, so the
    // rendered body has to be byte-identical to the uncommented document
    // apart from block-index attributes.
    expect(after).not.toContain('\\')
    expect(after).toContain('first line')
    expect(after).toContain('second line tail.')
    // A soft wrap must stay a soft wrap: it renders as collapsible
    // whitespace, never as a <br>.
    expect(after).not.toContain('<br')
  })

  it('round-trips: reloading the saved bytes and re-saving is byte-identical', async () => {
    const { saved } = await commentWholeWrappedParagraph()

    const reloaded = await createTestEditor(saved, PLUGINS)
    const resaved = reloaded.action(getMarkdown())
    expect(resaved).toBe(saved)

    // ...and the mark is a real, live mark on the reloaded document, not
    // inert literal text that merely happens to serialise back unchanged.
    const view = reloaded.action((ctx) => ctx.get(editorViewCtx)) as EditorView
    const { node } = findParagraph(view.state.doc, 'first line')
    const marked: string[] = []
    node.forEach((child) => {
      if (child.marks.some((mark) => mark.type.name === 'comment')) marked.push(child.type.name)
    })
    expect(marked.length).toBeGreaterThan(0)
  })

  it('survives a Format-mode edit after reload', async () => {
    const { saved } = await commentWholeWrappedParagraph()
    const reloaded = await createTestEditor(saved, PLUGINS)
    const view = reloaded.action((ctx) => ctx.get(editorViewCtx)) as EditorView

    const { pos } = findParagraph(view.state.doc, 'Intro')
    view.dispatch(view.state.tr.insertText(' Edited.', pos + 1 + 'Intro paragraph.'.length))

    const edited = reloaded.action(getMarkdown())
    expect(edited).toContain('Intro paragraph. Edited.')
    expect((edited.match(/<!--comment id=/g) ?? []).length).toBe(1)
    expect(extractComments(edited)).toHaveLength(1)
  })
})
