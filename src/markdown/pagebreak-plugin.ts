import { visit } from 'unist-util-visit'
import type { Root, Html, Text, Parent } from 'mdast'
import type { Node } from 'unist'
import type { Processor } from 'unified'
import type { DocumentWarning } from './document-warnings'

export interface Pagebreak extends Node {
  type: 'pagebreak'
  // The literal source text this pagebreak was matched FROM -- one of the
  // canonical `<!-- pagebreak -->` marker, LaTeX/Pandoc's `\newpage` or
  // `\pagebreak`, or the `page-break-after` div. Recorded so serializing
  // back to Markdown can reproduce what the author actually wrote instead of
  // rewriting it to the canonical marker.
  //
  // This exists to close a real, silent, irreversible prose-rewrite that
  // CLAUDE.md previously recorded as an ACCEPTED false positive: a
  // Pandoc/LaTeX tutorial whose prose is a bare `\newpage` paragraph --
  // documenting the command rather than invoking it -- had that paragraph
  // rewritten to `<!-- pagebreak -->` on the next save. Unlike the rest of
  // this app's serializer normalization (bullet char, emphasis char, fence
  // style), that changes what the document SAYS, not how it is formatted,
  // which is why it gets the opposite treatment: lossless by default, with
  // no consent prompt at all. The 2026-08-09 design-doc gap audit's B2
  // follow-up recommends exactly this, having measured that a prompt-based
  // gate would fire on 94% of real-world Markdown and is "mostly a fidelity
  // bug wearing a consent-gate costume."
  //
  // Optional rather than required because a pagebreak node can also be
  // CREATED in the editor (the toolbar/slash "Page break" command), where
  // there is no source text to preserve and the canonical marker is the
  // right thing to emit.
  raw?: string
}

declare module 'mdast' {
  interface RootContentMap {
    pagebreak: Pagebreak
  }
}

const PAGEBREAK_MARKER = '<!-- pagebreak -->'

// Common alternate page-break conventions from other Markdown toolchains,
// recognized on parse -- per the master design doc's File Format section.
// They are NOT normalized to the canonical PAGEBREAK_MARKER on serialize any
// more: `Pagebreak#raw` (above) records whichever literal matched, and
// remarkPagebreakToMarkdown emits it back verbatim. See that field's own
// comment for why normalizing was a prose rewrite rather than a formatting
// one, and therefore the one thing here that had to become lossless.
// Tolerant of quote style, internal whitespace, and an optional trailing
// semicolon, but otherwise matches this exact, narrow convention -- not an
// open-ended "any div mentioning page-break-after" matcher.
const PAGE_BREAK_DIV_RE =
  /^<div\s+style\s*=\s*(["'])page-break-after\s*:\s*always\s*;?\s*\1\s*>\s*<\/div>$/i

// LaTeX/Pandoc raw commands. Case-sensitive -- these are literal command
// names, not free text a user might casually capitalize differently.
const PAGEBREAK_TEXT_COMMANDS = new Set(['\\newpage', '\\pagebreak'])

export const PAGEBREAK_CLASS = 'pagedown-pagebreak'

// Only these mdast node types admit block-level HTML as a direct child per
// CommonMark's own grammar. Deliberately an allowlist, not a denylist of
// known phrasing-content types (paragraph, heading, strong, emphasis,
// delete, link, linkReference, ...): a denylist silently promotes any
// phrasing container nobody thought to exclude, while this allowlist's
// worst case is a safe false negative (fails to promote in some future
// block container we haven't enumerated). `listItem` is deliberately
// excluded — the master design doc states breaks inside list items are
// unsupported in v1 (docs/superpowers/specs/2026-07-25-pagedown-design.md,
// File Format section). GFM table cells need no exclusion: their grammar
// only admits inline content, so a marker inside one is always inline
// `html`, never reaching a block-container parent at all.
const BLOCK_CONTAINER_TYPES = new Set(['root', 'blockquote', 'footnoteDefinition'])

function isMatchingHtml(node: { type: string; value?: string }): node is Html {
  if (node.type !== 'html') return false
  const trimmed = (node as Html).value.trim()
  return trimmed === PAGEBREAK_MARKER || PAGE_BREAK_DIV_RE.test(trimmed)
}

function isMatchingTextCommand(node: { type: string; value?: string }): node is Text {
  return node.type === 'text' && PAGEBREAK_TEXT_COMMANDS.has((node as Text).value.trim())
}

// A leaf that counts as a pagebreak when it's the sole content of its
// paragraph -- either raw HTML (the comment or the div convention) or a
// raw-text LaTeX/Pandoc command.
function isPagebreakLeaf(node: { type: string; value?: string }): boolean {
  return isMatchingHtml(node) || isMatchingTextCommand(node)
}

// The literal the author wrote, trimmed. Trimmed rather than verbatim
// because both matchers already compare against `.trim()`, so the surrounding
// whitespace is never part of what was matched -- and re-emitting a leading
// newline inside a flow node's own serialized text would corrupt block
// spacing. Every matched shape is a single line by construction (the div
// regex is anchored and admits no newline), so nothing multi-line is lost.
function pagebreakRawOf(node: { value?: string }): string | undefined {
  const value = typeof node.value === 'string' ? node.value.trim() : ''
  return value.length > 0 ? value : undefined
}

export function remarkPagebreak() {
  return (tree: Root): void => {
    visit(tree, (node, index, parent: Parent | undefined) => {
      if (index === undefined || !parent) return

      // Raw HTML (the comment or the div convention) as a direct child of a
      // block container -- the shape plain remark-parse produces for
      // block-level HTML. \newpage/\pagebreak never reach this branch: as
      // plain text they can only ever be paragraph content, never a direct,
      // unwrapped child of root/blockquote/footnoteDefinition.
      if (isMatchingHtml(node) && BLOCK_CONTAINER_TYPES.has(parent.type)) {
        const pagebreak: Pagebreak = {
          type: 'pagebreak',
          position: node.position,
          raw: pagebreakRawOf(node)
        }
        parent.children[index] = pagebreak
        return
      }

      // A paragraph whose SOLE child is a matching leaf. Two structurally
      // distinct reasons this shape arises, both handled by the same check:
      // (1) preset-commonmark's remarkHtmlTransformer reparents a block-level
      // html node into paragraph{[html]} before this plugin runs, inside
      // Milkdown's internal pipeline only -- markdownToHtml's plain
      // remark-parse pipeline never produces this shape for raw HTML at all
      // (a real block-level marker parses as a direct root>html child, not
      // paragraph-wrapped). (2) \newpage/\pagebreak, being plain text, are
      // ALWAYS paragraph content in every pipeline -- CommonMark has no
      // "bare text" block type -- so this branch is what promotes them,
      // identically in markdownToHtml's plain pipeline and Milkdown's.
      if (
        node.type === 'paragraph' &&
        (node as Parent).children.length === 1 &&
        isPagebreakLeaf((node as Parent).children[0]) &&
        BLOCK_CONTAINER_TYPES.has(parent.type)
      ) {
        const pagebreak: Pagebreak = {
          type: 'pagebreak',
          position: (node as Parent).children[0].position,
          raw: pagebreakRawOf((node as Parent).children[0] as Html | Text)
        }
        parent.children[index] = pagebreak
      }
    })
  }
}

// design:167 ("PageDown always emits it with blank-line separation,
// validates on parse, and warns on an inline occurrence") plus the
// 2026-08-09 design-doc gap audit's A5 finding (this warning path never
// existed at all -- pipeline.ts had nothing to carry it on). Reads the
// SAME tree `remarkPagebreak` already promoted, right after
// `markdownToHtml`'s own `.runSync()` call -- a second `visit()` over an
// already-built, in-memory AST, NOT a second markdown PARSE (no
// re-tokenizing, no new `unified()` pipeline). Exported separately from
// `remarkPagebreak` itself, rather than folded into that transform's own
// single visit, so Milkdown's own use of `remarkPagebreak` (which never
// calls this function) is completely unaffected -- this is purely
// additive and read-only, and `markdownToHtml` (pipeline.ts) is its only
// caller.
//
// Two independent, aggregated (never one-warning-per-occurrence, per this
// feature's own "don't be noisy" requirement) conditions:
//
// 1. Inline occurrences of the CANONICAL marker only -- not the div
//    convention, not \newpage/\pagebreak. design:167's own text is
//    specifically about `<!-- pagebreak -->`'s HTML-comment parsing
//    gotcha ("written inline it's parsed as inline HTML inside a
//    paragraph and lands mid-paragraph unexpectedly"); the alternate
//    syntaxes have no equivalent gotcha (an embedded `\newpage` is just
//    ordinary text either way, and CLAUDE.md already documents that
//    silently NOT promoting a mid-sentence `\newpage`/`\pagebreak` is a
//    deliberate, accepted false-negative -- a Pandoc/LaTeX tutorial
//    documenting the command rather than invoking it -- which a warning
//    here would needlessly nag about).
//
//    After `.runSync()`, every occurrence remarkPagebreak COULD promote
//    already has been (no longer `type: 'html'` at all), so a leftover
//    `html` node whose trimmed value is exactly the canonical marker is,
//    by construction, one it declined to promote. Two such leftovers are
//    told apart by direct parent type: `listItem`/`tableCell` is
//    design:167's OTHER, separately-stated, NOT-warned sentence ("Breaks
//    inside tables or list items are unsupported in v1" -- a CORRECTLY
//    block-isolated marker that simply landed somewhere v1 doesn't
//    support, not "written inline"; see BLOCK_CONTAINER_TYPES' own
//    comment on why a table cell's marker is always the direct-child
//    inline shape, never paragraph-wrapped). Every other parent
//    (paragraph, heading, strong, emphasis, link, ...) is a genuine
//    mid-text occurrence.
//
// 2. Alternate syntax kept as written -- `Pagebreak#raw` (see that
//    field's own comment above) already records the literal an author
//    typed, so a promoted `pagebreak` node whose `raw` is defined and
//    isn't the canonical marker text is, by definition, one of the three
//    alternate conventions. No longer "N markers were normalized" (that
//    framing described the OLD, lossy behaviour this file's own history
//    section says was inverted) -- purely informational: "PageDown
//    recognized N alternate marker(s) and is keeping them exactly as
//    written."
export function collectPagebreakWarnings(tree: Root): DocumentWarning[] {
  let inlineCount = 0
  let alternateCount = 0

  visit(tree, (node, _index, parent: Parent | undefined) => {
    if (!parent) return

    if (node.type === 'html' && (node as Html).value.trim() === PAGEBREAK_MARKER) {
      if (parent.type !== 'listItem' && parent.type !== 'tableCell') {
        inlineCount += 1
      }
      return
    }

    if (node.type === 'pagebreak') {
      const raw = (node as Pagebreak).raw
      if (raw !== undefined && raw !== PAGEBREAK_MARKER) {
        alternateCount += 1
      }
    }
  })

  const warnings: DocumentWarning[] = []

  if (inlineCount > 0) {
    warnings.push({
      id: 'inline-pagebreak-marker',
      message:
        inlineCount === 1
          ? "A <!-- pagebreak --> marker is written inline, so it won't create a page break -- surround it with blank lines."
          : `${inlineCount} <!-- pagebreak --> markers are written inline, so they won't create a page break -- surround each with blank lines.`
    })
  }

  if (alternateCount > 0) {
    warnings.push({
      id: 'alternate-pagebreak-syntax',
      message:
        alternateCount === 1
          ? 'This document uses an alternate page-break marker (\\newpage, \\pagebreak, or a page-break-after div) -- kept as written.'
          : `This document uses ${alternateCount} alternate page-break markers (\\newpage, \\pagebreak, or a page-break-after div) -- kept as written.`
    })
  }

  return warnings
}

// Teaches mdast-util-to-markdown (the serializer remark-stringify wraps)
// how to print a `pagebreak` node — needed only by Milkdown's internal
// remark pipeline, which serializes ProseMirror content back to Markdown
// text. markdownToHtml never serializes back to Markdown, so it never
// needs this half of the plugin — only the parse-time transform above.
//
// `this` must be accessed directly in the attacher body, not in a returned
// transformer: unified only binds `this` to the processor for the attacher
// call itself (`attacher.call(self, ...options)` in unified/lib/index.js's
// `freeze()`). A transformer returned from an attacher is later invoked by
// trough's `wrap()` as a bare function call, so `this` inside it is
// `undefined` — verified empirically (TypeError: Cannot read properties of
// undefined (reading 'data')) and by reading unified's and trough's source.
// This mirrors remark-frontmatter's actual real source
// (node_modules/remark-frontmatter/lib/index.js), which reads `this.data()`
// directly in its attacher body and returns nothing, not a transformer.
export function remarkPagebreakToMarkdown(this: Processor): void {
  const data = this.data() as { toMarkdownExtensions?: unknown[] }
  const extensions = data.toMarkdownExtensions ?? (data.toMarkdownExtensions = [])
  extensions.push({
    handlers: {
      // Emit the author's own literal when we have one, falling back to the
      // canonical marker only for a node that never came from source text
      // (created by the toolbar/slash "Page break" command, or round-tripped
      // through a ProseMirror node whose `raw` attr is still its '' default).
      // See the `raw` field's own comment on Pagebreak for why this is a
      // deliberate inversion of the previous normalize-on-save behaviour and
      // NOT a regression. The `raw` values reachable here are exactly the
      // four this file's own matchers accept, so nothing arbitrary from
      // document content can be smuggled into the output through this path:
      // an `html`-typed source node's value had to equal the canonical
      // marker or satisfy the anchored PAGE_BREAK_DIV_RE, and a `text`-typed
      // one had to be exactly `\newpage` or `\pagebreak`.
      pagebreak(node: Pagebreak) {
        return node.raw ?? PAGEBREAK_MARKER
      }
    }
  })
}
