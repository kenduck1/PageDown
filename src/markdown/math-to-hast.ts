import type { Element } from 'hast'
import type { Handler } from 'mdast-util-to-hast'

// Mirrors pagebreak-to-hast.ts's own pattern exactly: markdownToHtml never
// renders math itself (that would mean running KaTeX inside the privileged
// main process / app-shell renderer, exactly the architecture Mermaid's own
// design doc section guards against) -- it only ever emits an inert
// placeholder carrying the raw LaTeX source as plain text. The ONE place
// that ever turns this into real typeset math is
// resources/pagination-render/katex-render.ts, running inside the
// sandboxed pagedown-render:// context, mirroring src/diagrams/
// render-mermaid.ts's own placement exactly.
//
// The placeholder's `<code class="language-X">` half deliberately reuses the
// SAME convention a fenced ```mermaid code block already produces for free
// (see CLAUDE.md's Mermaid section): hast-util-sanitize's defaultSchema
// already allows a `code` element's `className` to match `/^language-./`
// (node_modules/hast-util-sanitize/lib/schema.js) -- the exact GitHub-style
// convention this whole pipeline already follows for fenced code info
// strings -- so neither handler below needs a schema exception for that
// part.
//
// Block math's WRAPPER is deliberately `<div>`, NOT `<pre>`, and that is a
// real, tested finding, not a stylistic choice -- an earlier version of
// this file used `<pre>` (matching Mermaid's own placeholder shape exactly)
// on the assumption that rehype-highlight would leave an unrecognized
// `language-math-block` completely alone. That assumption was WRONG, caught
// by this file's own pipeline.test.ts: rehype-highlight's `language()`
// helper unconditionally unshifts its `hljs` class onto ANY `pre > code`
// element with a `language-*` class BEFORE it ever attempts highlighting
// (confirmed by reading rehype-highlight's own source directly) -- the
// "Unknown language" catch path this file originally relied on only skips
// re-highlighting the TEXT, not the class it had already added a few lines
// earlier. A math placeholder carrying a stray `hljs` class would then
// silently pick up document-typography.css's own `.hljs` code-block
// background/padding styling in the sandboxed preview and exported PDF,
// which nothing in this codebase wants for math. Using `<div>` instead
// sidesteps the problem by construction: rehype-highlight's own top-level
// guard (`parent.tagName !== 'pre'`, confirmed by reading its source) skips
// a `<code>` whose parent isn't `<pre>` before touching it at all -- no
// sanitize schema change needed either, since `div` is already an allowed
// bare tag with no attributes required here.
//
// Deliberately calls `state.patch(node, result)` and returns `result`
// DIRECTLY -- NOT `state.applyData(node, result)`, unlike
// createPagebreakToHast's own version of this same pattern. This is a real,
// found-by-testing divergence, not an inconsistency to "fix" back into
// line: `mdast-util-to-hast`'s own docs say `applyData` "honor[s] the
// `data` of `from`, and generate[s] an element INSTEAD OF" the passed
// result -- and `mdast-util-math`'s `mathFromMarkdown` (confirmed by
// dumping the real parsed mdast tree, not assumed) already stamps its OWN
// default `data.hName: 'pre'` / `data.hChildren` (a `<code class="language-math
// math-display">`-shaped default, its own opinionated "render as a
// highlightable math-labeled code block" fallback) onto every `math`/
// `inlineMath` node at PARSE time, before this handler ever runs. Calling
// `applyData` therefore silently DISCARDS the placeholder shape built below
// in favor of that library default -- caught directly by this file's own
// pipeline.test.ts cases, which expected `language-math-block` and got
// `language-math` instead (its second class, `math-display`, then got
// stripped by hast-util-sanitize's `/^language-./`-only allowlist, since
// `math-display` doesn't match that pattern -- compounding, not causing,
// the divergence). `pagebreak`-typed nodes never carry any `data.hName` of
// their own, so `applyData` is a safe no-op there; it is not here.
export function createMathBlockToHast(): Handler {
  return (state, node) => {
    const value = 'value' in node && typeof node.value === 'string' ? node.value : ''
    const code: Element = {
      type: 'element',
      tagName: 'code',
      properties: { className: ['language-math-block'] },
      children: [{ type: 'text', value }]
    }
    const result: Element = {
      type: 'element',
      tagName: 'div',
      properties: {},
      children: [code]
    }
    state.patch(node, result)
    return result
  }
}

export function createMathInlineToHast(): Handler {
  return (state, node) => {
    const value = 'value' in node && typeof node.value === 'string' ? node.value : ''
    const result: Element = {
      type: 'element',
      tagName: 'code',
      properties: { className: ['language-math-inline'] },
      children: [{ type: 'text', value }]
    }
    state.patch(node, result)
    return result
  }
}
