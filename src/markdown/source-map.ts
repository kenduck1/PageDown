import { visit } from 'unist-util-visit'
import type { Root, Text } from 'mdast'

interface Run {
  runId: string
  srcStart: number
  srcEnd: number
  renderedText: string
}

export interface SourceMap {
  htmlOffsetToSrc(htmlOffset: number, runId: string): number
  srcToRun(srcOffset: number): { runId: string; htmlOffset: number } | null
}

/**
 * Walks every inline text node in the mdast tree (remark provides `position`
 * with absolute character offsets into the original source for every node)
 * and records, per run, the exact source range it came from. For plain-text
 * runs, source and rendered text are character-identical, so offset mapping
 * is a direct index. Runs nested inside emphasis/strong/link nodes still
 * get their own entry with their own source range — the *rendered* text may
 * differ from the source only in the surrounding delimiters (**, *, [...](...)),
 * which are outside the text node's own position range, so the text node's
 * own content remains identity-mapped in the common case. Escaped characters
 * and entities are the cases where this assumption needs a correction pass;
 * gate 1 (Task 5) is what proves whether that's needed on the full corpus.
 */
// `source` is part of the documented signature above for a future entity/escape correction
// pass; the identity-mapping implementation below doesn't need it yet.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function annotateSourceOffsets(tree: Root, source: string): SourceMap {
  const runs: Run[] = []
  let counter = 0

  visit(tree, 'text', (node: Text) => {
    if (!node.position) return
    const srcStart = node.position.start.offset
    const srcEnd = node.position.end.offset
    if (srcStart == null || srcEnd == null) return
    runs.push({
      runId: `run-${counter++}`,
      srcStart,
      srcEnd,
      renderedText: node.value
    })
  })

  const byId = new Map(runs.map((r) => [r.runId, r]))

  return {
    htmlOffsetToSrc(htmlOffset: number, runId: string): number {
      const run = byId.get(runId)
      if (!run) throw new Error(`Unknown runId ${runId}`)
      // Identity mapping for the common case (see doc comment above).
      return run.srcStart + htmlOffset
    },
    srcToRun(srcOffset: number): { runId: string; htmlOffset: number } | null {
      for (const run of runs) {
        if (srcOffset >= run.srcStart && srcOffset < run.srcEnd) {
          return { runId: run.runId, htmlOffset: srcOffset - run.srcStart }
        }
      }
      return null
    }
  }
}
