import { Editor, rootCtx, defaultValueCtx, remarkStringifyOptionsCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'

// No pinned remark-stringify options object exists anywhere else in this repo yet
// (src/markdown/pipeline.ts only does Markdown->HTML, never Markdown->Markdown) --
// this is the first place one is defined. Reuse this exact object anywhere else
// in the app that eventually needs remark-stringify configuration, rather than
// re-deriving a second, possibly-divergent pin.
export const PINNED_STRINGIFY_OPTIONS = {
  bullet: '-' as const,
  emphasis: '_' as const,
  strong: '*' as const,
  fence: '`' as const,
  rule: '-' as const,
  listItemIndent: 'one' as const,
  resourceLink: true
}

export async function createMilkdownEditor(markdown: string): Promise<Editor> {
  const root = document.createElement('div')
  document.body.appendChild(root)

  return Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root)
      ctx.set(defaultValueCtx, markdown)
      ctx.set(remarkStringifyOptionsCtx, PINNED_STRINGIFY_OPTIONS)
    })
    .use(commonmark)
    .use(gfm)
    .create()
}
