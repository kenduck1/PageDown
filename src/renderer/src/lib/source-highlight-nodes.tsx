import type { ReactNode } from 'react'
import {
  MAX_HIGHLIGHTED_SOURCE_LENGTH,
  MAX_HIGHLIGHTED_SOURCE_TOKENS,
  tokenizeMarkdownSource,
  type SourceTokenKind
} from './markdown-source-tokens'

// Lives here rather than beside SourceHighlightLayer because it is a pure
// function, not a component, and `react-refresh/only-export-components` is
// enabled: a component file that also exports a helper silently loses fast
// refresh for the whole module.
const TOKEN_CLASS: Record<SourceTokenKind, string> = {
  marker: 'pagedown-src-marker',
  heading: 'pagedown-src-heading',
  strong: 'pagedown-src-strong',
  emphasis: 'pagedown-src-emphasis',
  strike: 'pagedown-src-strike',
  code: 'pagedown-src-code',
  'code-info': 'pagedown-src-code-info',
  'link-text': 'pagedown-src-link-text',
  'link-url': 'pagedown-src-link-url',
  list: 'pagedown-src-list',
  quote: 'pagedown-src-quote',
  rule: 'pagedown-src-rule',
  html: 'pagedown-src-html',
  frontmatter: 'pagedown-src-frontmatter',
  math: 'pagedown-src-math'
}

// Turns raw Markdown into the child list of Source mode's highlight <pre>.
//
// Pure: given a string it returns nodes, touching no DOM. The two properties
// its test pins are the two that matter and neither is visible from the
// rendered output alone -- that the concatenated text of every node is EXACTLY
// the source (plus one trailing newline; see below), and that untokenized runs
// are coalesced.
//
// COALESCING IS THE WHOLE PERFORMANCE STORY, and it is why there is no
// per-line wrapper element. Emitting one element per line would put ~7,700
// array entries on the page for the 536KB corpus fixture before a single token
// existed; buffering consecutive untokenized text ACROSS line boundaries
// instead means the array length tracks the number of TOKENS, not the number
// of lines, so that same document is ~5,000 entries and an ordinary 20KB
// document is a few hundred. Real prose is overwhelmingly untokenized, so most
// flushes are long multi-line runs.
//
// The trailing '\n' is deliberate and load-bearing for alignment, not a
// formatting accident: a <textarea> whose value ends in a newline shows a final
// empty line, and whether a trailing newline in a `white-space: pre-wrap` box
// generates a final empty line box is exactly the sort of thing that differs
// between engines. Appending one unconditionally makes the mirror at least as
// tall as the textarea's content under BOTH behaviours, which is the direction
// that matters: the textarea is the scroll container and the mirror follows it,
// so a mirror one line too short cannot be scrolled to the bottom, while one a
// line too tall costs nothing (it is clipped).
//
// dangerouslySetInnerHTML with a hand-built HTML string was the obvious faster
// alternative (one DOM mutation, the browser's own parser) and is deliberately
// NOT used: it would put a hand-rolled HTML escaper on the path that renders
// UNTRUSTED DOCUMENT TEXT inside the PRIVILEGED app-shell renderer -- the one
// context with contextBridge access -- to buy milliseconds on documents the
// caps below exclude from highlighting anyway. React elements cannot inject
// markup by construction; that is worth more here than the speed.
export function buildHighlightNodes(source: string): ReactNode[] {
  if (source.length > MAX_HIGHLIGHTED_SOURCE_LENGTH) return [source + '\n']

  const lines = tokenizeMarkdownSource(source)
  let total = 0
  for (const line of lines) total += line.tokens.length
  if (total > MAX_HIGHLIGHTED_SOURCE_TOKENS) return [source + '\n']

  const nodes: ReactNode[] = []
  let plain = ''
  let key = 0
  for (const line of lines) {
    let cursor = 0
    for (const token of line.tokens) {
      plain += line.text.slice(cursor, token.start)
      if (plain.length > 0) {
        nodes.push(plain)
        plain = ''
      }
      nodes.push(
        <span key={key++} className={TOKEN_CLASS[token.kind]}>
          {line.text.slice(token.start, token.end)}
        </span>
      )
      cursor = token.end
    }
    plain += line.text.slice(cursor) + '\n'
  }
  if (plain.length > 0) nodes.push(plain)
  return nodes
}
