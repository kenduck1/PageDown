import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkFrontmatter from 'remark-frontmatter'
import type { Root, Yaml } from 'mdast'

// Locates the document's frontmatter block (mdast `yaml` node, only ever the
// tree's first child per remark-frontmatter's own grammar) using the exact
// same parse-time plugin stack as extractOutline.ts / pipeline.ts (remark-parse
// + remark-frontmatter(['yaml'])) -- see CLAUDE.md's "One parser everywhere"
// rule. `node.position` spans the WHOLE block including both `---` fences
// (verified directly rather than assumed); `node.value` holds only the inner
// text between them, matching page-config.ts's `extractPageConfig`/
// `applyPageConfig` boundary exactly.
function findYamlNode(source: string): Yaml | undefined {
  const tree = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).parse(source) as Root
  const first = tree.children[0]
  return first?.type === 'yaml' ? (first as Yaml) : undefined
}

/**
 * Returns the raw YAML text between a document's `---` frontmatter fences
 * (not including the fences themselves), or `''` if the document has no
 * frontmatter block. This is the exact input `extractPageConfig`
 * (src/markdown/page-config.ts) expects.
 */
export function extractRawFrontmatter(source: string): string {
  return findYamlNode(source)?.value ?? ''
}

/**
 * Splices new raw YAML text (the output of `applyPageConfig`) back into a
 * full document, replacing an existing frontmatter block in place or
 * inserting a fresh one at the very top if the document doesn't have one
 * yet. Everything outside the frontmatter block -- the rest of the document,
 * verbatim -- is left untouched.
 */
export function replaceRawFrontmatter(source: string, newRawYaml: string): string {
  const node = findYamlNode(source)
  if (node?.position?.start.offset != null && node.position.end.offset != null) {
    const before = source.slice(0, node.position.start.offset)
    const after = source.slice(node.position.end.offset)
    return `${before}---\n${newRawYaml}\n---${after}`
  }
  if (newRawYaml.length === 0) return source
  return `---\n${newRawYaml}\n---\n\n${source}`
}
