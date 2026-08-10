import { $nodeSchema, $remark } from '@milkdown/utils'
import {
  remarkPagebreak,
  remarkPagebreakToMarkdown,
  PAGEBREAK_CLASS
} from '../../../../markdown/pagebreak-plugin'

export const pagebreakRemark = $remark('remarkPagebreak', () => remarkPagebreak)
export const pagebreakRemarkToMarkdown = $remark(
  'remarkPagebreakToMarkdown',
  () => remarkPagebreakToMarkdown
)

export const pagebreakNode = $nodeSchema('pagebreak', () => ({
  group: 'block',
  atom: true,
  attrs: {
    // Carries mdast Pagebreak#raw across the ProseMirror round trip -- see
    // that field's own comment in src/markdown/pagebreak-plugin.ts for why
    // an alternate marker (`\newpage`, `\pagebreak`, a `page-break-after`
    // div) must survive a Format-mode edit as itself rather than being
    // silently rewritten to the canonical marker. Without this attr the
    // literal is recovered on parse and then thrown away the moment the
    // editor serializes, so the plugin-level fix alone would do nothing for
    // the editing surface it exists to protect.
    //
    // Default '' (not undefined) because ProseMirror attrs must be
    // JSON-serializable and a missing attr is not distinguishable from an
    // explicit undefined in `toDOM`/`parseDOM`; the toMarkdown runner below
    // maps '' back to "no raw", which is the correct state for a pagebreak
    // the user INSERTED rather than parsed.
    raw: { default: '', validate: 'string' }
  },
  parseDOM: [
    {
      tag: 'div[data-type="pagebreak"]',
      getAttrs: (dom) => ({ raw: (dom as HTMLElement).getAttribute('data-raw') || '' })
    }
  ],
  toDOM: (node) => [
    'div',
    {
      'data-type': 'pagebreak',
      'data-raw': node.attrs.raw,
      class: `${PAGEBREAK_CLASS} my-2 border-t border-dashed border-border-chrome text-center text-eyebrow text-text-tertiary`
    },
    'Page break'
  ],
  parseMarkdown: {
    match: ({ type }) => type === 'pagebreak',
    runner: (state, node, type) => {
      state.addNode(type, { raw: typeof node.raw === 'string' ? node.raw : '' })
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'pagebreak',
    runner: (state, node) => {
      const raw = typeof node.attrs.raw === 'string' ? node.attrs.raw : ''
      state.addNode('pagebreak', undefined, undefined, raw ? { raw } : undefined)
    }
  }
}))
