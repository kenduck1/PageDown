import { $nodeSchema, $remark } from '@milkdown/utils'
import remarkFrontmatter from 'remark-frontmatter'

export const frontmatterRemark = $remark('remarkFrontmatter', () => remarkFrontmatter, ['yaml'])

export const frontmatterNode = $nodeSchema('frontmatter', () => ({
  group: 'block',
  atom: true,
  isolating: true,
  attrs: { value: { default: '' } },
  parseDOM: [
    {
      tag: 'div[data-type="frontmatter"]',
      getAttrs: (dom) => ({
        value: (dom as HTMLElement).getAttribute('data-value') || ''
      })
    }
  ],
  toDOM: (node) => [
    'div',
    {
      'data-type': 'frontmatter',
      'data-value': node.attrs.value,
      contenteditable: 'false',
      class:
        'mb-4 rounded border border-border-chrome bg-chrome-light px-3 py-2 text-12 text-text-secondary'
    },
    `Frontmatter (${String(node.attrs.value).split('\n').length} lines)`
  ],
  parseMarkdown: {
    match: ({ type }) => type === 'yaml',
    runner: (state, node, type) => {
      state.addNode(type, { value: typeof node.value === 'string' ? node.value : '' })
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'frontmatter',
    runner: (state, node) => {
      state.addNode('yaml', undefined, node.attrs.value as string)
    }
  }
}))
