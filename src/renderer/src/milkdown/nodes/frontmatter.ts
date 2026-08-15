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
  // INVISIBLE, and it must stay that way.
  //
  // Frontmatter is the document's own page CONFIGURATION (page size,
  // orientation, margins, running header/footer) -- settings, not content. It
  // renders to nothing in the paginated preview, the exported PDF, print, and
  // HTML/DOCX export, because `mdast-util-to-hast` emits nothing at all for a
  // `yaml` node.
  //
  // This node exists ONLY so the YAML survives a round trip through the
  // WYSIWYG canvas: every part of the file has to map to something in the
  // ProseMirror document, or serializing back out would silently delete it --
  // one keystroke in Format mode would destroy the user's page setup.
  //
  // It previously rendered a bordered grey `Frontmatter (N lines)` box at the
  // top of the page card. That was a real editor/paginator divergence in the
  // one product whose entire premise is that the canvas matches the printed
  // page: the editor painted a box onto page 1 that no output surface has.
  // Do not give this node visible styling, a label, a border, or any layout
  // height again -- render it exactly as it prints, which is not at all.
  //
  // `data-value` carries the raw YAML for the parseDOM rule above, so a
  // copy/paste round trip through the DOM keeps the real content.
  toDOM: (node) => [
    'div',
    {
      'data-type': 'frontmatter',
      'data-value': node.attrs.value,
      contenteditable: 'false',
      // Not `display: none`: ProseMirror needs a real box to map positions
      // against for an atom node. Zero-size and unpainted is the equivalent
      // that keeps the document structurally addressable.
      style: 'display:block;height:0;margin:0;padding:0;overflow:hidden'
    }
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
