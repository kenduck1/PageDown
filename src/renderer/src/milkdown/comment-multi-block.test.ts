import { describe, it, expect, afterEach } from 'vitest'
import { editorViewCtx, serializerCtx } from '@milkdown/core'
import { TextSelection } from '@milkdown/prose/state'
import { createTestEditor } from './test-editor'
import { EDITOR_SCHEMA_PLUGINS } from './plugins'
import { EDITOR_COMMAND_PLUGINS } from './commands'
import { buildEditorCommands } from './editor-commands'
import { extractComments } from '../lib/extractComments'
import { decodeCommentMeta, encodeCommentMeta } from '../../../markdown/comment-plugin'
import type { Editor } from '@milkdown/core'

let ed: Editor | undefined
afterEach(async () => {
  await ed?.destroy()
  ed = undefined
})

function serialize(editor: Editor): string {
  return editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc))
}

// Builds the three-paragraph document, comments across all of it, and returns
// the serialized markdown plus the one logical comment's id.
async function commentAcrossThreeParagraphs(): Promise<{
  cmds: ReturnType<typeof buildEditorCommands>
  id: string
  markdown: string
}> {
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
  const markdown = serialize(ed)
  const found = extractComments(markdown)
  expect(found).toHaveLength(1)
  return { cmds, id: found[0].id, markdown }
}

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
// Red-green verified: restoring the sameParent guard fails the first test with
// `expected false to be true` on the addComment call.
//
// That same shape is why every COMMENT ACTION is pinned here too: one logical
// comment being several marks is exactly what makes "act on all of them" a
// correctness requirement rather than tidiness, and this is the only file that
// builds a document where the difference is observable.
describe('comment spanning multiple blocks', () => {
  it('marks every block, serializes one pair per block sharing an id, and reads back as ONE comment', async () => {
    const { markdown } = await commentAcrossThreeParagraphs()

    const ids = [...markdown.matchAll(/<!--comment id="([^"]+)"/g)].map((m) => m[1])
    const closers = [...markdown.matchAll(/<!--\/comment id="([^"]+)"/g)].map((m) => m[1])

    expect(ids.length).toBeGreaterThan(1)
    expect(new Set(ids).size).toBe(1)
    expect(closers.length).toBe(ids.length)

    const found = extractComments(markdown)
    expect(found).toHaveLength(1)
    expect(found[0].text).toBe('spans blocks')
    expect(found[0].resolvedAt).toBeNull()
  })

  // THE INVARIANT EVERY COMMENT ACTION HAS TO HOLD. One logical comment is
  // several marks here (three, one per paragraph), so an action that touched
  // only the selection -- or only the first mark it found -- would leave
  // orphaned halves: half the comment resolved and half still active, or, on
  // delete, a marker pair with no partner.
  //
  // Asserted per PAIR rather than on the document as a whole, so "two of three
  // resolved" fails loudly instead of passing on the first pair it checks.
  it('resolve stamps EVERY marker pair of a multi-block comment, not just one', async () => {
    const { cmds, id, markdown } = await commentAcrossThreeParagraphs()
    const pairCount = (markdown.match(/<!--comment id=/g) ?? []).length
    expect(pairCount).toBe(3)

    cmds.resolveComment(id)
    const after = serialize(ed!)

    // Still three pairs -- resolving does not remove anything.
    expect(after.match(/<!--comment id=/g) ?? []).toHaveLength(pairCount)
    // ...and every one of them decodes to a resolved comment.
    const payloads = [...after.matchAll(/data="([^"]+)"/g)].map((m) => decodeCommentMeta(m[1]))
    expect(payloads).toHaveLength(pairCount)
    for (const payload of payloads) {
      expect(payload).not.toBeNull()
      expect(payload!.resolvedAt).toBeTruthy()
    }
    // One logical comment still, and the sidebar sees it as resolved.
    const found = extractComments(after)
    expect(found).toHaveLength(1)
    expect(found[0].resolvedAt).toBeTruthy()
  })

  // The starting document is built BY HAND rather than by calling
  // resolveComment first, and that is what makes this test discriminate on its
  // own. Seeded from resolve's output, a resolve that only stamped one of the
  // three pairs would leave the other two already unresolved -- and this test
  // would then pass while unresolve did nothing at all. Verified: under exactly
  // that mutation the seeded-from-resolve version passed and this one fails.
  it('unresolve clears EVERY marker pair of a multi-block comment', async () => {
    const data = encodeCommentMeta({
      author: 'A',
      text: 'spans blocks',
      createdAt: '2026-08-11T09:00:00.000Z',
      resolvedAt: '2026-08-12T14:30:00.000Z'
    })
    const pair = (body: string): string =>
      `<!--comment id="dup" data="${data}"-->${body}<!--/comment id="dup"-->`
    const source = `${pair('First para.')}\n\n${pair('Second para.')}\n\n${pair('Third para.')}\n`

    ed = await createTestEditor(source, [
      ...EDITOR_SCHEMA_PLUGINS.flat(),
      ...EDITOR_COMMAND_PLUGINS.flat()
    ])
    const cmds = buildEditorCommands(ed)
    // Anti-vacuity: the document really does start with three resolved pairs,
    // so "all three are unresolved afterwards" is a change rather than the
    // status quo.
    const before = [...serialize(ed).matchAll(/data="([^"]+)"/g)].map((m) =>
      decodeCommentMeta(m[1])
    )
    expect(before).toHaveLength(3)
    expect(before.every((payload) => payload?.resolvedAt !== undefined)).toBe(true)

    cmds.unresolveComment('dup')

    const after = serialize(ed)
    const payloads = [...after.matchAll(/data="([^"]+)"/g)].map((m) => decodeCommentMeta(m[1]))
    expect(payloads).toHaveLength(3)
    for (const payload of payloads) {
      expect(payload).not.toBeNull()
      expect(payload!.resolvedAt).toBeUndefined()
    }
    expect(extractComments(after)[0].resolvedAt).toBeNull()
  })

  // Delete is the action that used to be called "resolve"; this is the old
  // test's own final assertion, moved onto the command that now does it. Both
  // halves matter: every marker gone (no orphaned closer left behind) AND the
  // text the comment wrapped still present.
  it('delete removes EVERY marker pair of a multi-block comment, leaving the text', async () => {
    const { cmds, id } = await commentAcrossThreeParagraphs()

    cmds.deleteComment(id)
    const after = serialize(ed!)

    expect(after).not.toContain('<!--comment')
    expect(after).not.toContain('<!--/comment')
    expect(after).toContain('First para.')
    expect(after).toContain('Second para.')
    expect(after).toContain('Third para.')
    expect(extractComments(after)).toHaveLength(0)
  })

  // A multi-block comment's resolved state has to survive the file, not just
  // the live editor -- reparsing must produce ONE resolved comment, not three
  // rows or a partially-resolved one.
  it('a resolved multi-block comment round-trips through markdown as one resolved comment', async () => {
    const { cmds, id } = await commentAcrossThreeParagraphs()
    cmds.resolveComment(id)
    const saved = serialize(ed!)

    const reopened = await createTestEditor(saved, [
      ...EDITOR_SCHEMA_PLUGINS.flat(),
      ...EDITOR_COMMAND_PLUGINS.flat()
    ])
    const resaved = serialize(reopened)
    await reopened.destroy()

    const found = extractComments(resaved)
    expect(found).toHaveLength(1)
    expect(found[0].id).toBe(id)
    // ANTI-VACUITY: `null === null` would satisfy the comparison below if the
    // stamp were dropped on every save, so pin that it is genuinely present
    // first. Verified against a mutation that drops it in the serializer.
    expect(extractComments(saved)[0].resolvedAt).not.toBeNull()
    expect(found[0].resolvedAt).toBe(extractComments(saved)[0].resolvedAt)
    expect(resaved.match(/<!--comment id=/g) ?? []).toHaveLength(3)
  })
})
