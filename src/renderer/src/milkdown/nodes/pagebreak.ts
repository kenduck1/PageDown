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
  parseDOM: [{ tag: 'div[data-type="pagebreak"]' }],
  toDOM: () => [
    'div',
    {
      'data-type': 'pagebreak',
      class: `${PAGEBREAK_CLASS} my-2 border-t border-dashed border-border-chrome text-center text-eyebrow text-text-tertiary`
    },
    'Page break'
  ],
  parseMarkdown: {
    match: ({ type }) => type === 'pagebreak',
    runner: (state, _node, type) => {
      state.addNode(type)
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'pagebreak',
    runner: (state) => {
      state.addNode('pagebreak')
    }
  }
}))
