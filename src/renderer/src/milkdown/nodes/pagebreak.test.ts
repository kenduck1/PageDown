import { describe, it, expect } from 'vitest'
import { getMarkdown } from '@milkdown/utils'
import { createTestEditor } from '../test-editor'
import { pagebreakNode, pagebreakRemark, pagebreakRemarkToMarkdown } from './pagebreak'

// $remark()/$nodeSchema() return heterogeneous 2-tuples ([$Ctx, MilkdownPlugin]),
// not a bare MilkdownPlugin — the exact same shape @milkdown/preset-commonmark's
// own composed exports have, which is why that package's real source
// (@milkdown/preset-commonmark/lib/index.js) builds its `commonmark` export via
// `[...].flat()` before declaring it as MilkdownPlugin[]. Mirroring that here
// (same fix as src/renderer/src/milkdown/nodes/frontmatter.test.ts) so this
// typechecks against createTestEditor's MilkdownPlugin[] parameter.
const PLUGINS = [pagebreakRemark, pagebreakRemarkToMarkdown, pagebreakNode].flat()

describe('Milkdown pagebreak node', () => {
  it('round-trips a pagebreak marker byte-for-byte', async () => {
    const markdown = 'Paragraph one.\n\n<!-- pagebreak -->\n\nParagraph two.'
    const editor = await createTestEditor(markdown, PLUGINS)

    const result = editor.action(getMarkdown())
    // mdast-util-to-markdown (the serializer underlying remark-stringify, which
    // underlies Milkdown's serializerCtx) unconditionally appends a trailing
    // newline when the output doesn't already end in one — see
    // node_modules/mdast-util-to-markdown/lib/index.js's toMarkdown(): this is
    // not gated by any stringify option, so it fires on every document. Same
    // fix as the frontmatter node's test (src/renderer/src/milkdown/nodes/frontmatter.test.ts).
    expect(result).toBe(markdown + '\n')
  })

  it('round-trips multiple pagebreak markers', async () => {
    const markdown = 'One.\n\n<!-- pagebreak -->\n\nTwo.\n\n<!-- pagebreak -->\n\nThree.'
    const editor = await createTestEditor(markdown, PLUGINS)

    const result = editor.action(getMarkdown())
    expect(result).toBe(markdown + '\n')
  })
})
