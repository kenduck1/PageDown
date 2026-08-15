import { $markSchema, $nodeSchema } from '@milkdown/utils'
import { formatAttributeBlock } from '../../../../markdown/image-size'

// Real Milkdown schema support for the three mdast node types that make up
// Markdown's REFERENCE-STYLE link machinery -- `definition` (`[1]: https://…
// "Title"`), `linkReference` (`[text][1]`) and `imageReference`
// (`![alt][1]`). Closes the master design doc's own standing requirement to
// "require an explicit Milkdown schema node/mark for every node type
// PageDown's remark configuration can produce", with reference-style links
// named there as v1 corpus content -- and it is one of the only two
// structural causes behind the 2026-08-09 gap audit's measured round-trip
// divergence (tests/gates/corpus/reference-links-and-footnotes.md is the fixture
// that exercises it).
//
// ROOT CAUSE, and it is NOT "Milkdown has no schema for these so the parser
// falls back to something lossy". @milkdown/preset-commonmark's composed
// `plugins` array unconditionally registers `remarkInlineLinkPlugin`, which
// wraps the `remark-inline-links` remark plugin: it rewrites every
// linkReference/imageReference into a plain inline link/image by looking up
// its definition, and then DELETES the definition nodes outright. That
// transform runs inside `remark.runSync(...)` during
// ParserState.run, i.e. before the schema is ever consulted, so no amount of
// schema work alone can preserve reference syntax -- the nodes are gone by
// then. The fix therefore has two halves: this file (the schema), and
// plugins.ts filtering `remarkInlineLinkPlugin.plugin` out of the composed
// `commonmark` array (see that file for why filtering the array is the
// mechanism rather than Editor#remove).
//
// The two halves are NOT independently shippable, in one direction: once the
// inline-link transform is gone, an unmatched mdast node type is a hard
// failure, not a degradation. `ParserState.#matchTarget` throws
// `parserMatchError` when no registered schema's `parseMarkdown.match`
// claims a node, and `#runNode` does not catch it -- so a document
// containing a single `[a]: /b` definition would throw out of the whole
// parse. That is why all three types are covered here rather than only the
// two the audit named.
//
// MODELLING, chosen by reading each type's own mdast-util-to-markdown
// handler (lib/handle/{definition,link-reference,image-reference}.js) and
// matching it to the shape @milkdown/preset-commonmark already uses for that
// handler's non-reference twin, rather than picking per type in isolation:
//
//   - `linkReference` is a MARK. Its handler calls
//     `state.containerPhrasing(node, ...)`, i.e. its children are real
//     phrasing content -- structurally identical to `link`, which
//     preset-commonmark models as `$markSchema('link')`. Modelling it as an
//     inline atom NODE was ruled out for a concrete reason, not on
//     symmetry grounds: the link text would have to be flattened into a
//     string attr, so it would stop being editable in the canvas and any
//     nested emphasis/code inside it would be destroyed on the first save --
//     trading one fidelity bug for a worse one.
//   - `imageReference` is an inline ATOM NODE. Its handler reads
//     `node.alt`, a plain string, and the type has no `children` at all --
//     structurally identical to `image`, which preset-commonmark models as
//     `$nodeSchema('image')` with `atom: true`. A mark was ruled out: there
//     is no inline content for a mark to wrap.
//   - `definition` is a block ATOM NODE. It is flow content with no
//     children, carrying only association/url/title data -- the same shape
//     as the `yaml` frontmatter block this repo already models as an opaque
//     atom (nodes/frontmatter.ts). Making it EDITABLE was considered and
//     ruled out for this pass: an editable definition needs a real node view
//     with per-field inputs (url and title are not free text -- a bare space
//     in a url has to become an angle-bracket destination), which is a
//     separate UI sub-project. Losslessness -- the actual bug -- does not
//     require editability, and Source mode already edits these directly.
//
// None of this touches `markdownToHtml` (src/markdown/pipeline.ts), which
// has its own `remark-rehype` pass that resolves a linkReference against its
// definition into a real `<a href>` for the paginated preview, PDF export,
// print and thumbnails. Those surfaces are unchanged; only the Milkdown
// canvas now shows a reference AS a reference instead of showing a resolved
// inline link and silently deleting the definition on save.

/// `[text][1]` / `[text][]` / `[1]`. A mark, mirroring linkSchema.
export const linkReferenceSchema = $markSchema('linkReference', () => ({
  attrs: {
    identifier: { default: '', validate: 'string' },
    label: { default: '', validate: 'string' },
    // 'full' (`[text][1]`), 'collapsed' (`[1][]`) or 'shortcut' (`[1]`).
    // Preserved verbatim because mdast-util-to-markdown's own handler
    // branches on it to decide whether to emit the trailing `[…]` at all --
    // dropping it would silently rewrite `[1]` as `[1][1]`.
    referenceType: { default: 'full', validate: 'string' }
  },
  parseDOM: [
    {
      tag: 'span[data-link-reference]',
      getAttrs: (dom) => {
        const el = dom as HTMLElement
        return {
          identifier: el.getAttribute('data-identifier') ?? '',
          label: el.getAttribute('data-label') ?? '',
          referenceType: el.getAttribute('data-reference-type') || 'full'
        }
      }
    }
  ],
  // Deliberately a <span>, not an <a>: this is a reference whose destination
  // lives in a definition elsewhere in the document, and emitting a real
  // anchor would either need an href we do not have at mark level or produce
  // an <a> with no href -- which several places in this app query for
  // (image-security.ts's sanitizeLinkHref path, getHTML() consumers). The
  // dotted underline reads as "link-ish, but indirect".
  toDOM: (mark) => [
    'span',
    {
      'data-link-reference': '',
      'data-identifier': mark.attrs.identifier,
      'data-label': mark.attrs.label,
      'data-reference-type': mark.attrs.referenceType,
      class: 'text-accent underline decoration-dotted underline-offset-2'
    },
    0
  ],
  parseMarkdown: {
    match: ({ type }) => type === 'linkReference',
    runner: (state, node, markType) => {
      state.openMark(markType, {
        identifier: typeof node.identifier === 'string' ? node.identifier : '',
        label: typeof node.label === 'string' ? node.label : '',
        referenceType: typeof node.referenceType === 'string' ? node.referenceType : 'full'
      })
      state.next(node.children)
      state.closeMark(markType)
    }
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'linkReference',
    runner: (state, mark) => {
      state.withMark(mark, 'linkReference', undefined, {
        identifier: mark.attrs.identifier,
        label: mark.attrs.label,
        referenceType: mark.attrs.referenceType
      })
    }
  }
}))

/// `![alt][1]`. An inline atom node, mirroring imageSchema.
//
// CARRIES A `width`, for the same reason the stock `image` node does and via
// the same mechanism -- see nodes/image-size.ts and src/markdown/image-size.ts.
// `remarkImageAttrs` matches a trailing `{width=...}` block on BOTH mdast
// `image` and `imageReference` (one matcher, shared with markdownToHtml), so a
// sized reference image already rendered correctly on the paginated surface,
// in the PDF and in the HTML export. The editor was the only surface that
// dropped it, because this node had nowhere to keep it -- which made it SILENT
// DATA LOSS in the user's own file rather than a rendering gap: set a width,
// edit an unrelated paragraph, save, and the width is gone with no error.
//
// The attr lives HERE rather than as an `extendSchema` override in
// nodes/image-size.ts (where the stock `image` node's own width lives) because
// this node is declared by this repo, not by a preset -- there is nothing to
// override, and an override layer would only add indirection.
export const imageReferenceNode = $nodeSchema('imageReference', () => ({
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  marks: '',
  attrs: {
    identifier: { default: '', validate: 'string' },
    label: { default: '', validate: 'string' },
    alt: { default: '', validate: 'string' },
    referenceType: { default: 'full', validate: 'string' },
    // Default '' rather than undefined, matching imageSchemaWithWidth and
    // pagebreakNode's `raw`: ProseMirror attrs must be JSON-serializable, and
    // a missing attr is indistinguishable from an explicit undefined in
    // toDOM/parseDOM.
    width: { default: '', validate: 'string' }
  },
  parseDOM: [
    {
      tag: 'span[data-image-reference]',
      getAttrs: (dom) => {
        const el = dom as HTMLElement
        return {
          identifier: el.getAttribute('data-identifier') ?? '',
          label: el.getAttribute('data-label') ?? '',
          alt: el.getAttribute('data-alt') ?? '',
          referenceType: el.getAttribute('data-reference-type') || 'full',
          width: el.getAttribute('data-width') ?? ''
        }
      }
    }
  ],
  toDOM: (node) => [
    'span',
    {
      'data-image-reference': '',
      'data-identifier': node.attrs.identifier,
      'data-label': node.attrs.label,
      'data-alt': node.attrs.alt,
      'data-reference-type': node.attrs.referenceType,
      'data-width': node.attrs.width,
      class: 'rounded bg-chrome-light px-1 text-12 text-text-secondary'
    },
    // The width is shown in the chip's own label, unlike an inline image
    // (which the node view renders as a real, really-sized <img>). There is no
    // image to size here -- the destination lives in a definition elsewhere --
    // so without this the canvas would give the user no indication a size is
    // set at all. This is DOM rendering only: an atom node with no content
    // contributes nothing to `doc.textContent`, so it reaches neither Find nor
    // any serialized output.
    `![${String(node.attrs.alt)}][${String(node.attrs.label || node.attrs.identifier)}]${
      node.attrs.width ? formatAttributeBlock(String(node.attrs.width)) : ''
    }`
  ],
  parseMarkdown: {
    match: ({ type }) => type === 'imageReference',
    runner: (state, node, type) => {
      state.addNode(type, {
        identifier: typeof node.identifier === 'string' ? node.identifier : '',
        label: typeof node.label === 'string' ? node.label : '',
        alt: typeof node.alt === 'string' ? node.alt : '',
        referenceType: typeof node.referenceType === 'string' ? node.referenceType : 'full',
        width: typeof node.width === 'string' ? node.width : ''
      })
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'imageReference',
    runner: (state, node) => {
      state.addNode('imageReference', undefined, undefined, {
        identifier: node.attrs.identifier,
        label: node.attrs.label,
        alt: node.attrs.alt,
        referenceType: node.attrs.referenceType
      })
      // A plain TEXT sibling, exactly as the sized `image` node does -- see the
      // closing note in src/markdown/image-size.ts for why there is no
      // `remarkImageAttrsToMarkdown` counterpart and why `{`/`}`/`%`/`=` are
      // verified to serialize unescaped here.
      const width = typeof node.attrs.width === 'string' ? node.attrs.width : ''
      if (width) state.addNode('text', undefined, formatAttributeBlock(width))
    }
  }
}))

/// `[1]: https://example.com "Title"`. A block atom, mirroring frontmatterNode.
export const definitionNode = $nodeSchema('definition', () => ({
  group: 'block',
  atom: true,
  isolating: true,
  attrs: {
    identifier: { default: '', validate: 'string' },
    label: { default: '', validate: 'string' },
    url: { default: '', validate: 'string' },
    // '' means "no title", matching mdast-util-to-markdown's own handler,
    // which gates on `if (node.title)` -- so an explicitly empty title
    // (`[a]: /b ""`) is already normalized away by upstream and needs no
    // separate null representation here.
    title: { default: '', validate: 'string' }
  },
  parseDOM: [
    {
      tag: 'div[data-type="definition"]',
      getAttrs: (dom) => {
        const el = dom as HTMLElement
        return {
          identifier: el.getAttribute('data-identifier') ?? '',
          label: el.getAttribute('data-label') ?? '',
          url: el.getAttribute('data-url') ?? '',
          title: el.getAttribute('data-title') ?? ''
        }
      }
    }
  ],
  toDOM: (node) => [
    'div',
    {
      'data-type': 'definition',
      'data-identifier': node.attrs.identifier,
      'data-label': node.attrs.label,
      'data-url': node.attrs.url,
      'data-title': node.attrs.title,
      contenteditable: 'false',
      class:
        'my-1 rounded border border-border-chrome bg-chrome-light px-2 py-1 font-mono text-12 text-text-secondary'
    },
    `[${String(node.attrs.label || node.attrs.identifier)}]: ${String(node.attrs.url)}${
      node.attrs.title ? ` "${String(node.attrs.title)}"` : ''
    }`
  ],
  parseMarkdown: {
    match: ({ type }) => type === 'definition',
    runner: (state, node, type) => {
      state.addNode(type, {
        identifier: typeof node.identifier === 'string' ? node.identifier : '',
        label: typeof node.label === 'string' ? node.label : '',
        url: typeof node.url === 'string' ? node.url : '',
        title: typeof node.title === 'string' ? node.title : ''
      })
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'definition',
    runner: (state, node) => {
      state.addNode('definition', undefined, undefined, {
        identifier: node.attrs.identifier,
        label: node.attrs.label,
        url: node.attrs.url,
        title: node.attrs.title || null
      })
    }
  }
}))
