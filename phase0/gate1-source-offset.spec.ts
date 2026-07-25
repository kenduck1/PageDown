import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import { visit } from 'unist-util-visit'
import type { Root, Text } from 'mdast'
import { markdownToHtml } from '../src/markdown/pipeline'
import { buildRunOffsetTables } from '../src/markdown/source-map'

// The brief's sample uses `new URL(..., import.meta.url)` to resolve corpus
// fixture paths. Playwright Test transpiles .spec.ts files to CommonJS by
// default in this project (no "type": "module" in package.json, and renaming
// to .mts hits a separate ESM-loader/package-exports resolution error deep in
// the `unified` dependency chain — confirmed empirically, not assumed). CJS
// has no `import.meta`, but does have `__dirname`, which resolves the exact
// same corpus path just as reliably. This is a mechanical path-resolution
// swap only — the sampling loop and oracle assertion below are unchanged
// from the brief.

const corpusFiles = [
  'short.md',
  'mixed.md',
  'reference-links-and-footnotes.md',
  'nested-lists.md',
  'entities-and-escapes.md'
]

test('Gate 1: source-offset mapping matches an independent oracle across the corpus', async () => {
  const failures: string[] = []

  for (const file of corpusFiles) {
    const source = readFileSync(join(__dirname, 'corpus', file), 'utf8')
    const { sourceMap } = markdownToHtml(source)

    // Sample every character offset in the document body (skip frontmatter).
    const bodyStart = source.indexOf('\n---\n') + 5
    for (let srcOffset = bodyStart; srcOffset < source.length; srcOffset++) {
      const run = sourceMap.srcToRun(srcOffset)
      if (!run) continue // offset falls in markup syntax itself (e.g. inside "**"), not a text run — expected
      const recovered = sourceMap.htmlOffsetToSrc(run.htmlOffset, run.runId)
      if (source[recovered] !== source[srcOffset]) {
        failures.push(
          `${file}@${srcOffset}: expected ${JSON.stringify(source[srcOffset])}, got ${JSON.stringify(source[recovered])} (context: ${JSON.stringify(source.slice(Math.max(0, srcOffset - 10), srcOffset + 10))})`
        )
      }
    }
  }

  if (failures.length > 0) {
    console.log(`Gate 1: ${failures.length} mismatches found. First 20:`)
    console.log(failures.slice(0, 20).join('\n'))
  }
  expect(
    failures,
    `${failures.length} source-offset mismatches — see console output above`
  ).toHaveLength(0)
})

// The test above is a self-consistent round trip: it derives the `htmlOffset`
// it feeds to `htmlOffsetToSrc` from `srcToRun(srcOffset)` on the very
// `srcOffset` it then checks. For this SourceMap's shape, that composition
// collapses back to the original `srcOffset` by construction — investigation
// during this task found it passes even when fed a build that mismapped
// offsets after an entity, because it never touches the actual rendered/
// decoded text. It is not, on its own, the independent oracle the design
// review asked for.
//
// This second test is: it re-parses each corpus file directly (independent
// of pipeline.ts/source-map.ts's internal wiring) to get the real `node.value`
// mdast/micromark produces for every text run, and separately recomputes the
// rendered text for that same run's raw source slice via
// `buildRunOffsetTables` (source-map.ts's offset-correction table). If the
// two ever disagree, the correction table is decoding differently than the
// real parser does — a genuine, non-tautological failure mode this test can
// actually detect.
test('Gate 1 (independent oracle): the offset-correction table decodes every real corpus run identically to a live remark parse', async () => {
  const mismatches: string[] = []
  let totalRuns = 0

  for (const file of corpusFiles) {
    const source = readFileSync(join(__dirname, 'corpus', file), 'utf8')
    const tree = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkFrontmatter, ['yaml'])
      .parse(source) as Root

    visit(tree, 'text', (node: Text) => {
      const srcStart = node.position?.start.offset
      const srcEnd = node.position?.end.offset
      if (srcStart == null || srcEnd == null) return
      totalRuns++
      const { renderedText } = buildRunOffsetTables(source.slice(srcStart, srcEnd))
      if (renderedText !== node.value) {
        mismatches.push(
          `${file}@[${srcStart},${srcEnd}): table says ${JSON.stringify(renderedText)}, real parse says ${JSON.stringify(node.value)}`
        )
      }
    })
  }

  if (mismatches.length > 0) {
    console.log(`Gate 1 independent oracle: ${mismatches.length}/${totalRuns} runs mismatched:`)
    console.log(mismatches.join('\n'))
  }
  expect(mismatches, mismatches.join('\n')).toHaveLength(0)
  expect(totalRuns).toBeGreaterThan(0)
})
