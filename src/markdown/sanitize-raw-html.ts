import { fromHtml } from 'hast-util-from-html'
import { sanitize, defaultSchema } from 'hast-util-sanitize'
import type { Root as HastRoot, ElementContent } from 'hast'
import type { Handler } from 'mdast-util-to-hast'

export const sanitizeRawHtmlToHast: Handler = (state, node) => {
  const html = typeof node.value === 'string' ? node.value : ''
  const fragment = fromHtml(html, { fragment: true }) as HastRoot
  const sanitized = sanitize(fragment, defaultSchema) as HastRoot
  const children = sanitized.children as ElementContent[]

  for (const child of children) {
    state.patch(node, child)
  }

  return children
}
