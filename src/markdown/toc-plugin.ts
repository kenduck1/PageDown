import { visit } from 'unist-util-visit'
import type { Root, Html, Text, Heading, Parent } from 'mdast'
import type { Node } from 'unist'
import type { Processor } from 'unified'
import type { DocumentWarning } from './document-warnings'

// One entry of a rendered table of contents: a heading this document already
// has, flattened to plain text, plus the anchor id stamped onto that heading
// so the entry can link to it. Computed once, during the mdast transform
// below, and carried ON the `toc` node -- because a `mdast-util-to-hast`
// handler is only ever handed `(state, node)` and has no way to reach the
// document root from there.
export interface TocEntry {
  /** The heading's own level, 1-6 (mdast `Heading#depth`). */
  depth: number
  /** Flattened plain text of the heading's inline content. */
  text: string
  /**
   * The `id` this transform stamped onto the heading itself, WITHOUT the
   * DOM-clobbering prefix `hast-util-sanitize` will later add -- see
   * `createTocToHast` for why the prefix is applied on the `href` side only,
   * and by pipeline.ts rather than here.
   */
  anchorId: string
}

export interface Toc extends Node {
  type: 'toc'
  /**
   * Deepest heading level this TOC lists (1-6). Not named `depth` because a
   * `toc` node sits in the same tree as `heading` nodes, whose own `depth`
   * means something else entirely -- one shadowing the other in a `visit`
   * callback is the kind of confusion that survives review.
   */
  maxDepth: number
  /**
   * Resolved at transform time from the whole document. Empty for a document
   * that has no headings within `maxDepth` -- see `collectTocWarnings`, which
   * is what tells the user why their table of contents came out blank.
   */
  entries: TocEntry[]
  /**
   * The literal source text this marker was matched FROM. Exactly the
   * `Pagebreak#raw` mechanism and exactly the same motivation: this transform
   * recognizes three spellings, and normalizing an author's `[TOC]` to
   * `<!-- toc -->` on the next Format-mode save would rewrite what the
   * document SAYS rather than how it is formatted. See
   * pagebreak-plugin.ts's own `raw` comment for the full argument -- it was
   * reached the hard way there (shipped as an accepted data loss, then
   * inverted), and is adopted here from the start rather than rediscovered.
   *
   * Optional because a `toc` node can also be CREATED in the editor (the
   * slash menu's "Table of contents" item), where there is no source literal
   * to preserve and the canonical marker is the right thing to emit.
   */
  raw?: string
}

declare module 'mdast' {
  interface RootContentMap {
    toc: Toc
  }
}

/** The class name the rendered container carries on every surface. */
export const TOC_CLASS = 'pagedown-toc'

/**
 * Prefix for the `id` stamped onto each heading a TOC links to. Deliberately
 * NOT `pagedown-toc-`: pipeline.ts strips its per-render TOC token out of the
 * final HTML with a `replaceAll('pagedown-toc-<hex>', 'pagedown-toc')`, and an
 * anchor id sharing that prefix would be a needless near-miss for that
 * replacement (see CLAUDE.md's own note on why the pagebreak and block-index
 * tokens are kept independent rather than shared).
 */
export const HEADING_ANCHOR_PREFIX = 'pd-heading-'

/**
 * Levels listed when the marker doesn't say. h1-h3 rather than all six: this
 * app's stated primary use case is reports and letters, where h4-h6 are
 * paragraph-level subdivisions that make a TOC longer without making it more
 * navigable. Overridable per marker (`<!-- toc depth="6" -->`).
 */
export const DEFAULT_TOC_DEPTH = 3

// The canonical marker, with an optional `depth` attribute. Matched
// case-INSENSITIVELY, unlike pagebreak-plugin.ts's canonical marker (an exact
// string compare) -- `<!-- TOC -->` is at least as common in the wild as the
// lowercase spelling (it is what most `markdown-toc`-style generators emit),
// and this is HTML-comment content, where the surrounding conventions are
// case-insensitive. `raw` keeps whichever spelling the author used, so
// tolerating both costs nothing on the way back out.
//
// The three alternatives for the quote style are spelled out rather than
// captured with a backreference because the quotes are OPTIONAL: `(["'])?...\1?`
// happily matches `depth="3'`, and an anchored regex that accepts a mismatched
// pair is a worse failure than three explicit branches.
const TOC_MARKER_RE = /^<!--\s*toc(?:\s+depth\s*=\s*(?:"([1-6])"|'([1-6])'|([1-6])))?\s*-->$/i

// Alternate spellings from other Markdown toolchains, recognized on parse and
// (via `raw`) emitted back exactly as written. `[TOC]` is python-markdown /
// MultiMarkdown / Typora; `[[TOC]]` is the doubled form several wikis use.
//
// GitLab's own `[[_TOC_]]` is DELIBERATELY NOT recognized, and the reason is a
// tokenizer fact rather than a preference: `_TOC_` is a valid emphasis span
// (both underscores are flanked by `[`/`]`, which are punctuation, so each can
// open/close), so CommonMark parses `[[_TOC_]]` into THREE phrasing children --
// `text("[[")`, `emphasis`, `text("]]")` -- never the single text leaf this
// matcher requires. Recognizing it would mean matching on a paragraph's
// FLATTENED text instead of on its sole child, which would also start matching
// `[[_TOC_]]` written inside a sentence. The sole-child requirement is the
// entire safety property here; it is not worth trading for one more spelling.
const TOC_TEXT_MARKER_RE = /^(?:\[toc\]|\[\[toc\]\])$/i

// Same allowlist, and the same reasoning, as pagebreak-plugin.ts's own
// BLOCK_CONTAINER_TYPES: only these mdast types admit block-level content as a
// direct child, and an allowlist's worst case is a safe false negative.
const BLOCK_CONTAINER_TYPES = new Set(['root', 'blockquote', 'footnoteDefinition'])

function parseHtmlMarker(value: string): { maxDepth: number } | null {
  const match = TOC_MARKER_RE.exec(value.trim())
  if (!match) return null
  const depth = match[1] ?? match[2] ?? match[3]
  return { maxDepth: depth ? Number(depth) : DEFAULT_TOC_DEPTH }
}

function parseTextMarker(value: string): { maxDepth: number } | null {
  if (!TOC_TEXT_MARKER_RE.test(value.trim())) return null
  // The bracket spellings carry no depth syntax anywhere they are used, so
  // there is nothing to parse and nothing to invent.
  return { maxDepth: DEFAULT_TOC_DEPTH }
}

function parseMarkerLeaf(node: { type: string; value?: string }): { maxDepth: number } | null {
  if (typeof node.value !== 'string') return null
  if (node.type === 'html') return parseHtmlMarker(node.value)
  if (node.type === 'text') return parseTextMarker(node.value)
  return null
}

/**
 * Flattens a heading's inline content to plain text by concatenating every
 * text/inlineCode leaf's value, in document order.
 *
 * Deliberately hand-rolled rather than `mdast-util-to-string`: that package is
 * a transitive dependency only (nothing in package.json declares it), and
 * under pnpm's strict node_modules layout a transitive-only package is not
 * resolvable via a plain import from application code -- the same constraint
 * `extractOutline.ts` already hit and documented.
 *
 * Exported and shared with `extractOutline.ts` (the Outline sidebar) on
 * purpose: the sidebar and the rendered table of contents must never disagree
 * about what a heading is CALLED, and two independent flatteners is exactly
 * how that drift starts.
 */
export function headingPlainText(node: Heading): string {
  let text = ''
  visit(node, (child) => {
    if (child.type === 'text' || child.type === 'inlineCode') {
      text += (child as { value: string }).value
    }
  })
  return text
}

/**
 * Promotes every `<!-- toc -->` / `[TOC]` / `[[TOC]]` marker to a real `toc`
 * mdast node carrying the document's own heading list, and stamps an anchor
 * `id` onto each heading a TOC actually links to.
 *
 * Shared by BOTH consumers, exactly like `remarkPagebreak`: `markdownToHtml`
 * (pipeline.ts) for every rendering surface, and Milkdown's own internal parse
 * pipeline (src/renderer/src/milkdown/nodes/toc.ts) for the editing surface.
 * One matcher, so the two surfaces cannot disagree about what a marker is.
 *
 * Two matching branches, and BOTH are required for the same non-obvious reason
 * `remarkPagebreak` documents: `@milkdown/preset-commonmark` reparents a
 * block-level raw-HTML node into a wrapping `paragraph` BEFORE this transform
 * runs, so Milkdown's pipeline only ever sees the second shape for a
 * `<!-- toc -->` marker while `markdownToHtml`'s plain remark-parse pipeline
 * only ever sees the first. The bracket spellings are plain TEXT and are
 * therefore always paragraph content in every pipeline (CommonMark has no
 * "bare text" block type), so they only ever hit the second branch. Collapsing
 * this to one branch silently breaks the marker on one surface only.
 *
 * Heading ids are stamped via `data.hProperties` rather than by a custom hast
 * handler for `heading`, because `mdast-util-to-hast`'s own heading handler
 * already merges `hProperties` through `applyData` -- so this needs no handler
 * override, and it cannot collide with the `data.hName` trap that forced
 * math-to-hast.ts to avoid `applyData` (a `heading` node never carries one).
 * Stamped ONLY for headings some TOC actually references, so a document with
 * no TOC marker emits byte-identical HTML to what it emitted before this
 * feature existed.
 */
export function remarkToc() {
  return (tree: Root): void => {
    const tocNodes: Toc[] = []

    visit(tree, (node, index, parent: Parent | undefined) => {
      if (index === undefined || !parent) return
      if (!BLOCK_CONTAINER_TYPES.has(parent.type)) return

      // Raw HTML as a direct child of a block container -- what plain
      // remark-parse produces for a block-level `<!-- toc -->`.
      const direct = node.type === 'html' ? parseMarkerLeaf(node as Html) : null
      if (direct) {
        const toc: Toc = {
          type: 'toc',
          position: node.position,
          maxDepth: direct.maxDepth,
          entries: [],
          raw: (node as Html).value.trim()
        }
        parent.children[index] = toc
        tocNodes.push(toc)
        return
      }

      // A paragraph whose SOLE child is a marker leaf. Covers Milkdown's
      // reparented raw-HTML shape and both bracket spellings, in every
      // pipeline. The sole-child requirement is what stops `see [TOC] below`
      // in running prose from being silently rewritten into a whole
      // generated heading list.
      if (node.type !== 'paragraph') return
      const children = (node as Parent).children
      if (children.length !== 1) return
      const parsed = parseMarkerLeaf(children[0] as Html | Text)
      if (!parsed) return

      const toc: Toc = {
        type: 'toc',
        position: children[0].position,
        maxDepth: parsed.maxDepth,
        entries: [],
        raw: ((children[0] as Html | Text).value ?? '').trim()
      }
      parent.children[index] = toc
      tocNodes.push(toc)
    })

    // Nothing to fill in, and -- deliberately -- no heading is stamped with an
    // id. A document with no TOC marker must render byte-identically to how it
    // rendered before this feature existed; that is asserted directly in
    // pipeline.test.ts rather than left as an intention.
    if (tocNodes.length === 0) return

    const headings: { depth: number; text: string; anchorId: string; node: Heading }[] = []
    visit(tree, 'heading', (node: Heading) => {
      headings.push({
        depth: node.depth,
        text: headingPlainText(node),
        anchorId: `${HEADING_ANCHOR_PREFIX}${headings.length}`,
        node
      })
    })

    const stamped = new Set<Heading>()
    for (const toc of tocNodes) {
      toc.entries = headings
        .filter((heading) => heading.depth <= toc.maxDepth)
        .map((heading) => {
          if (!stamped.has(heading.node)) {
            stamped.add(heading.node)
            const data = (heading.node.data ??= {})
            const hProperties = ((data as { hProperties?: Record<string, unknown> }).hProperties ??=
              {})
            // Never overwrite an id the document's own author put there (via
            // raw HTML or an existing `data.hProperties`) -- their anchor is
            // load-bearing for their own links, ours is not.
            hProperties.id ??= heading.anchorId
          }
          const existing = (heading.node.data as { hProperties?: { id?: unknown } } | undefined)
            ?.hProperties?.id
          return {
            depth: heading.depth,
            text: heading.text,
            anchorId: typeof existing === 'string' ? existing : heading.anchorId
          }
        })
    }
  }
}

/**
 * Read off the SAME tree `remarkToc` just built -- a second `visit()` over an
 * in-memory AST, never a second Markdown parse. Exactly the shape (and the
 * "aggregate, don't be noisy" rule) `collectPagebreakWarnings` established.
 *
 * One condition, and it is the one a user cannot diagnose on their own: a
 * document that HAS a table-of-contents marker but no headings inside its
 * depth renders an empty container, i.e. visibly nothing, with no indication
 * that the marker was even recognized. Every other outcome here is
 * self-evident on screen.
 */
export function collectTocWarnings(tree: Root): DocumentWarning[] {
  let emptyCount = 0
  let deepestSeen = 0

  visit(tree, (node) => {
    if (node.type === 'heading') {
      deepestSeen = Math.max(deepestSeen, (node as Heading).depth)
      return
    }
    if (node.type === 'toc' && (node as Toc).entries.length === 0) emptyCount += 1
  })

  if (emptyCount === 0) return []

  return [
    {
      id: 'empty-toc',
      message:
        deepestSeen === 0
          ? 'This document has a table-of-contents marker but no headings, so it renders as nothing.'
          : `This document's table of contents is empty -- its headings are all deeper than the marker's depth (try <!-- toc depth="${deepestSeen}" -->).`
    }
  ]
}

/**
 * Teaches `mdast-util-to-markdown` how to print a `toc` node. Needed only by
 * Milkdown's internal pipeline (`markdownToHtml` never serializes back to
 * Markdown), and `this` must be read in the attacher body rather than in a
 * returned transformer -- see `remarkPagebreakToMarkdown`'s own comment for
 * the unified/trough `this`-binding detail behind that.
 */
export function remarkTocToMarkdown(this: Processor): void {
  const data = this.data() as { toMarkdownExtensions?: unknown[] }
  const extensions = data.toMarkdownExtensions ?? (data.toMarkdownExtensions = [])
  extensions.push({
    handlers: {
      // Emit the author's own literal when we have one. The values reachable
      // through `raw` are exactly the spellings the matchers above accept, so
      // nothing arbitrary from document content can be smuggled out through
      // this path. Falling back only covers a node CREATED in the editor,
      // where a non-default depth still has to be expressed.
      toc(node: Toc) {
        if (node.raw) return node.raw
        const depth = typeof node.maxDepth === 'number' ? node.maxDepth : DEFAULT_TOC_DEPTH
        return depth === DEFAULT_TOC_DEPTH ? '<!-- toc -->' : `<!-- toc depth="${depth}" -->`
      }
    }
  })
}
