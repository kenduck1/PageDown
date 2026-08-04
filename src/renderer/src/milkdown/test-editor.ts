import { Editor, rootCtx, defaultValueCtx, remarkStringifyOptionsCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import type { MilkdownPlugin } from '@milkdown/ctx'
import { PINNED_STRINGIFY_OPTIONS } from './stringify-options'

export async function createTestEditor(
  markdown: string,
  extraPlugins: MilkdownPlugin[]
): Promise<Editor> {
  const root = document.createElement('div')
  document.body.appendChild(root)

  let builder = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root)
      ctx.set(defaultValueCtx, markdown)
      ctx.set(remarkStringifyOptionsCtx, PINNED_STRINGIFY_OPTIONS)
    })
    .use(commonmark)
    .use(gfm)

  for (const plugin of extraPlugins) {
    builder = builder.use(plugin)
  }

  return builder.create()
}
