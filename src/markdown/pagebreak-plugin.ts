import { visit } from 'unist-util-visit'
import type { Root, Html, Parent } from 'mdast'
import type { Node } from 'unist'

export interface Pagebreak extends Node {
  type: 'pagebreak'
}

declare module 'mdast' {
  interface RootContentMap {
    pagebreak: Pagebreak
  }
}

const PAGEBREAK_MARKER = '<!-- pagebreak -->'

export function remarkPagebreak() {
  return (tree: Root): void => {
    visit(tree, 'html', (node: Html, index, parent: Parent | undefined) => {
      if (index === undefined || !parent) return
      if (parent.type === 'paragraph') return
      if (node.value.trim() !== PAGEBREAK_MARKER) return

      const pagebreak: Pagebreak = { type: 'pagebreak', position: node.position }
      parent.children[index] = pagebreak
    })
  }
}
