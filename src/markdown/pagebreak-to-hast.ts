import type { Element } from 'hast'
import type { Handler } from 'mdast-util-to-hast'

export const pagebreakToHast: Handler = (state, node) => {
  const result: Element = {
    type: 'element',
    tagName: 'div',
    properties: { className: ['pagedown-pagebreak'] },
    children: []
  }
  state.patch(node, result)
  return state.applyData(node, result)
}
