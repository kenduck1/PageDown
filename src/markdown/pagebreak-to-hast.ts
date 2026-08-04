import type { Element } from 'hast'
import type { Handler } from 'mdast-util-to-hast'

export function createPagebreakToHast(className: string): Handler {
  return (state, node) => {
    const result: Element = {
      type: 'element',
      tagName: 'div',
      properties: { className: [className] },
      children: []
    }
    state.patch(node, result)
    return state.applyData(node, result)
  }
}
