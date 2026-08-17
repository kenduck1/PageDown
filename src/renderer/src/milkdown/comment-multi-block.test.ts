import { describe, it, expect, afterEach } from 'vitest'
import { editorViewCtx, serializerCtx } from '@milkdown/core'
import { TextSelection } from '@milkdown/prose/state'
import { createTestEditor } from './test-editor'
import { EDITOR_SCHEMA_PLUGINS } from './plugins'
import { EDITOR_COMMAND_PLUGINS } from './commands'
import { buildEditorCommands } from './editor-commands'
import { extractComments } from '../lib/extractComments'
import type { Editor } from '@milkdown/core'

let ed: Editor | undefined
afterEach(async () => {
  await ed?.destroy()
  ed = undefined
})

// A comment used to be REFUSED outright when the selection crossed a block
// boundary (`$from.sameParent($to)` in addCommentCommand). The stated worry
// was that splitting a mark across independently-serialized blocks could leave
// an HTML comment open across a blank line.
//
// This pins what actually happens instead, which is why the guard could go:
// ProseMirror marks the inline content within EACH block, and the serializer
// closes an open mark at every block end, so a three-paragraph comment emits
// three SELF-CONTAINED marker pairs sharing one id. Nothing is ever left open.
//
// Red-green verified: restoring the sameParent guard fails this with
// `expected false to be true` on the addComment call.
describe('comment spanning multiple blocks', () => {
  it('marks every block, serializes one pair per block sharing an id, and reads back as ONE comment', async () => {
    ed = await createTestEditor('First para.\n\nSecond para.\n\nThird para.\n', [
      ...EDITOR_SCHEMA_PLUGINS.flat(),
      ...EDITOR_COMMAND_PLUGINS.flat()
    ])
    const cmds = buildEditorCommands(ed)

    // Select from inside paragraph 1 through inside paragraph 3.
    ed.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const { doc } = view.state
      view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, 1, doc.content.size - 1)))
    })

    expect(cmds.addComment('A', 'spans blocks')).toBe(true)

    const md = ed.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      return ctx.get(serializerCtx)(view.state.doc)
    })
    const ids = [...md.matchAll(/<!--comment id="([^"]+)"/g)].map((m) => m[1])
    const closers = [...md.matchAll(/<!--\/comment id="([^"]+)"/g)].map((m) => m[1])

    expect(ids.length).toBeGreaterThan(1)
    expect(new Set(ids).size).toBe(1)
    expect(closers.length).toBe(ids.length)

    const found = extractComments(md)
    expect(found).toHaveLength(1)
    expect(found[0].text).toBe('spans blocks')

    cmds.resolveComment(found[0].id)
    const after = ed.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc))
    expect(after).not.toContain('<!--comment')
  })
})
