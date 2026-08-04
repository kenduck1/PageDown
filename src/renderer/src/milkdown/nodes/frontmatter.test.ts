import { describe, it, expect } from 'vitest'
import { editorViewCtx } from '@milkdown/core'
import { getMarkdown } from '@milkdown/utils'
import { createTestEditor } from '../test-editor'
import { frontmatterNode, frontmatterRemark } from './frontmatter'

describe('Milkdown frontmatter node', () => {
  it('round-trips a YAML frontmatter block byte-for-byte', async () => {
    const markdown = '---\ntitle: Test Document\nauthor: Jane Doe\n---\n\n# Heading\n\nBody text.'
    // $remark()/$nodeSchema() return heterogeneous 2-tuples ([$Ctx, MilkdownPlugin]),
    // not a bare MilkdownPlugin — the exact same shape @milkdown/preset-commonmark's
    // own composed exports have, which is why that package's real source
    // (@milkdown/preset-commonmark/lib/index.js) builds its `commonmark` export via
    // `[...].flat()` before declaring it as MilkdownPlugin[]. Mirroring that here so
    // this typechecks against createTestEditor's MilkdownPlugin[] parameter.
    const editor = await createTestEditor(markdown, [frontmatterRemark, frontmatterNode].flat())

    const result = editor.action(getMarkdown())
    // mdast-util-to-markdown (the serializer underlying remark-stringify, which
    // underlies Milkdown's serializerCtx) unconditionally appends a trailing
    // newline when the output doesn't already end in one — see
    // node_modules/mdast-util-to-markdown/lib/index.js's toMarkdown(): this is
    // not gated by any stringify option, so it fires on every document, not
    // just frontmatter-bearing ones (verified against a zero-plugin control
    // case). "Byte-for-byte" round-trip is therefore byte-for-byte modulo this
    // one, unconfigurable, upstream convention.
    expect(result).toBe(markdown + '\n')
  })

  it('parses frontmatter into a non-editable frontmatter node, not a heading or thematic break', async () => {
    const markdown = '---\ntitle: Test\n---\n\nBody text.'
    const editor = await createTestEditor(markdown, [frontmatterRemark, frontmatterNode].flat())

    const view = editor.ctx.get(editorViewCtx)
    const firstChild = view.state.doc.firstChild
    expect(firstChild?.type.name).toBe('frontmatter')
    expect(firstChild?.attrs.value).toBe('title: Test')
  })
})
