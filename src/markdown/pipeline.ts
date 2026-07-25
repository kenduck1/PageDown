import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import type { Root } from 'mdast'
import { annotateSourceOffsets, type SourceMap } from './source-map'

export type { SourceMap }

export function markdownToHtml(source: string): { html: string; sourceMap: SourceMap } {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .parse(source) as Root

  const sourceMap = annotateSourceOffsets(tree, source)

  const hastTree = unified().use(remarkRehype, { allowDangerousHtml: false }).runSync(tree)
  const html = unified().use(rehypeStringify).stringify(hastTree)

  return { html, sourceMap }
}
