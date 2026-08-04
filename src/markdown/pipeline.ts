import { randomBytes } from 'node:crypto'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import { raw } from 'hast-util-raw'
import { sanitize, defaultSchema } from 'hast-util-sanitize'
import type { Schema } from 'hast-util-sanitize'
import type { Root as HastRoot } from 'hast'
import type { Root } from 'mdast'
import { annotateSourceOffsets, type SourceMap } from './source-map'
import { remarkPagebreak, PAGEBREAK_CLASS } from './pagebreak-plugin'
import { createPagebreakToHast } from './pagebreak-to-hast'

export type { SourceMap }

export function markdownToHtml(source: string): { html: string; sourceMap: SourceMap } {
  // unified's `.parse()` only performs the parse phase — it does NOT run
  // attached transformers (remarkPagebreak's tree mutation only executes
  // during `.run()`/`.runSync()`). remarkGfm/remarkFrontmatter don't need
  // this because they work by registering micromark/mdast-util-from-markdown
  // syntax extensions that `.parse()` itself consults, not by mutating the
  // tree after the fact — but remarkPagebreak IS a post-parse tree mutation,
  // so it needs an explicit `.runSync()` on the same processor instance
  // (same instance matters: that's what carries the attached transformer).
  const parseProcessor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkPagebreak)

  const parsedTree = parseProcessor.parse(source) as Root
  const tree = parseProcessor.runSync(parsedTree) as Root

  const sourceMap = annotateSourceOffsets(tree, source)

  // Per-render random token: without this, the whole-tree sanitize() pass
  // below can't tell pagebreakToHast's own trusted output apart from
  // attacker-typed raw HTML carrying the same static class name, once both
  // flow through the same schema exception (a real gap found in this
  // pipeline's own review — see this task's "Round 2 finding" note above).
  // Generating the token fresh per call, after `source` is already fixed,
  // makes it impossible for document content authored in advance to predict
  // or embed — the schema exception below only ever allows THIS render's
  // token value, and the final replace swaps it back to the stable public
  // class name real consumers (e.g. a future pagination-preview task) key
  // off of.
  const pagebreakToken = randomBytes(16).toString('hex')
  const tokenClassName = `${PAGEBREAK_CLASS}-${pagebreakToken}`

  // allowDangerousHtml: true here does NOT mean unsafe output — it means
  // "don't drop raw HTML, turn it into `raw` hast nodes for `raw()` and
  // `sanitize()` below to resolve and clean up." `pagebreak`-typed nodes are
  // unaffected either way: remarkPagebreak already promoted every matching
  // marker away from `type: 'html'` before this stage ever runs, so they
  // reach the handler below via the `handlers` map exactly as before.
  const hastTree = unified()
    .use(remarkRehype, {
      allowDangerousHtml: true,
      handlers: { pagebreak: createPagebreakToHast(tokenClassName) }
    })
    .runSync(tree) as HastRoot

  // hast-util-sanitize's default (GitHub-style) schema doesn't allow a plain
  // `class` on `div` at all — reasonable for arbitrary author-supplied raw
  // HTML, but the pagebreak div above deliberately carries this render's
  // own unguessable token class and must survive sanitization. This adds
  // one precise, per-render exception (the exact token value, not a general
  // className allowance) rather than loosening `class` generally — the same
  // pattern hast-util-sanitize's own defaultSchema uses for its GFM
  // `code`/task-list class exceptions (node_modules/hast-util-sanitize/lib/schema.js).
  const schema: Schema = {
    ...defaultSchema,
    strip: [
      ...(defaultSchema.strip ?? []),
      'style',
      'textarea',
      'title',
      'iframe',
      'noembed',
      'noframes',
      'xmp',
      'plaintext'
    ],
    attributes: {
      ...defaultSchema.attributes,
      div: [...(defaultSchema.attributes?.div ?? []), ['className', tokenClassName]]
    }
  }

  // Re-serializes the whole tree (including the `raw` nodes above) to one
  // HTML string and re-parses it as a real document — this is what actually
  // fixes interleaved/split raw-HTML tags, since resolving them correctly
  // requires seeing the whole document at once, not one fragment at a time.
  const rawProcessed = raw(hastTree) as HastRoot
  const sanitized = sanitize(rawProcessed, schema) as HastRoot

  const html = unified()
    .use(rehypeStringify)
    .stringify(sanitized)
    .replaceAll(tokenClassName, PAGEBREAK_CLASS)

  return { html, sourceMap }
}
