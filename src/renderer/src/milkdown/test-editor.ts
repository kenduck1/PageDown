import { Editor, rootCtx, defaultValueCtx, remarkStringifyOptionsCtx } from '@milkdown/core'
import { remarkGFMPlugin } from '@milkdown/preset-gfm'
import type { MilkdownPlugin } from '@milkdown/ctx'
import { EDITOR_SCHEMA_PLUGINS } from './plugins'
import { PINNED_STRINGIFY_OPTIONS, PINNED_GFM_OPTIONS } from './stringify-options'

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
      ctx.set(remarkGFMPlugin.options.key, PINNED_GFM_OPTIONS)
    })
    // The unconditional base used to be a bare `commonmark` + `gfm`, which
    // was equivalent to the shipped composition only for as long as
    // EDITOR_SCHEMA_PLUGINS was "those two plus additions". That stopped
    // being true when reference-style link support landed: it works by
    // REMOVING @milkdown/preset-commonmark's own remarkInlineLinkPlugin from
    // the composed array (see plugins.ts), so a base of raw `commonmark`
    // would re-register the very plugin the shipped editor drops -- every
    // test would have measured a composition the app does not mount, in the
    // exact area being fixed. Using EDITOR_SCHEMA_PLUGINS directly also
    // keeps the schema-override ORDER correct (table-cell/list-spread
    // extensions must register after the presets they extend). Callers that
    // pass EDITOR_SCHEMA_PLUGINS.flat() again as extras are unaffected:
    // Editor#use keys its plugin store by plugin-function identity, so
    // re-using an already-registered instance is a documented no-op.
    .use(EDITOR_SCHEMA_PLUGINS.flat())

  for (const plugin of extraPlugins) {
    builder = builder.use(plugin)
  }

  return builder.create()
}
