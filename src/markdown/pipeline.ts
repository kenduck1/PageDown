import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import type { Root } from 'mdast'
import { annotateSourceOffsets, type SourceMap } from './source-map'
import { remarkPagebreak } from './pagebreak-plugin'
import { pagebreakToHast } from './pagebreak-to-hast'

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

  const hastTree = unified()
    .use(remarkRehype, {
      allowDangerousHtml: false,
      handlers: { pagebreak: pagebreakToHast }
    })
    .runSync(tree)
  const html = unified().use(rehypeStringify).stringify(hastTree)

  return { html, sourceMap }
}
