import { visit } from 'unist-util-visit'
import type { Root, Text } from 'mdast'
import { decodeNamedCharacterReference } from 'decode-named-character-reference'
import { decodeNumericCharacterReference } from 'micromark-util-decode-numeric-character-reference'

interface Run {
  runId: string
  srcStart: number
  srcEnd: number
  renderedText: string
  // renderedToSrc[i] = source offset (relative to srcStart) that produced
  // renderedText[i]. Always defined for every rendered character.
  renderedToSrc: number[]
  // srcToRendered[i] = rendered offset that source offset (relative to
  // srcStart) `i` maps to, or null if `i` falls *inside* a multi-character
  // escape/entity sequence (e.g. the "m" in "&amp;") and therefore has no
  // independently addressable rendered position of its own — the same
  // treatment the design already gives to pure markup syntax like "**".
  srcToRendered: (number | null)[]
}

export interface SourceMap {
  htmlOffsetToSrc(htmlOffset: number, runId: string): number
  srcToRun(srcOffset: number): { runId: string; htmlOffset: number } | null
}

// Matches exactly what mdast-util-from-markdown (via micromark) decodes
// inside text content: a backslash-escaped ASCII punctuation character, or an
// HTML character reference (named, decimal, or hexadecimal). This is the
// same regex `micromark-util-decode-string`'s `decodeString` uses internally
// — copied here (rather than imported) because we need the *position* of
// each match against the run's source slice, not just the decoded string.
const ESCAPE_OR_REFERENCE = /\\([!-/:-@[-`{-~])|&(#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/gi

/** Decodes a single regex match the same way micromark does. */
function decodeMatch(
  escape: string | undefined,
  reference: string | undefined,
  whole: string
): string {
  if (escape) return escape
  const ref = reference as string
  if (ref.charCodeAt(0) === 35 /* "#" */) {
    const isHex = ref.charCodeAt(1) === 120 /* "x" */ || ref.charCodeAt(1) === 88 /* "X" */
    return decodeNumericCharacterReference(ref.slice(isHex ? 2 : 1), isHex ? 16 : 10)
  }
  const named = decodeNamedCharacterReference(ref)
  // Unknown named reference: micromark leaves the text as-is (no decode).
  return named === false ? whole : named
}

/**
 * Scans one run's raw source slice and builds the rendered text plus a
 * bidirectional offset table between source and rendered positions. For
 * ordinary characters this is a 1:1 identity mapping. For an escape (`\*`)
 * or character reference (`&amp;`, `&#65;`, `&#x42;`), the whole source
 * sequence collapses to (usually) one rendered character: the sequence's
 * *first* source byte is recorded as the anchor for that rendered position
 * (so `srcToRun` → `htmlOffsetToSrc` round-trips exactly for it), and any
 * remaining interior source bytes of that same sequence map to `null` —
 * they don't correspond to their own rendered position, exactly as "**"
 * delimiter bytes already don't.
 */
// Exported (beyond what the `SourceMap` interface itself needs) so it can be
// unit-tested directly against known escape/entity inputs and against
// `node.value` from a real parse — see source-map.test.ts.
export function buildRunOffsetTables(sourceSlice: string): {
  renderedText: string
  renderedToSrc: number[]
  srcToRendered: (number | null)[]
} {
  const renderedToSrc: number[] = []
  const srcToRendered: (number | null)[] = new Array(sourceSlice.length).fill(null)
  let renderedText = ''
  let lastIndex = 0

  ESCAPE_OR_REFERENCE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ESCAPE_OR_REFERENCE.exec(sourceSlice))) {
    // Plain identity stretch before this match.
    for (let i = lastIndex; i < match.index; i++) {
      srcToRendered[i] = renderedText.length
      renderedToSrc.push(i)
      renderedText += sourceSlice[i]
    }

    const matchStart = match.index
    const matchEnd = matchStart + match[0].length
    const decoded = decodeMatch(match[1], match[2], match[0])

    srcToRendered[matchStart] = renderedText.length
    for (let k = 0; k < decoded.length; k++) {
      renderedToSrc.push(matchStart)
      renderedText += decoded[k]
    }

    lastIndex = matchEnd
  }

  // Trailing identity stretch after the last match (or the whole slice, if
  // there were no matches at all).
  for (let i = lastIndex; i < sourceSlice.length; i++) {
    srcToRendered[i] = renderedText.length
    renderedToSrc.push(i)
    renderedText += sourceSlice[i]
  }

  return { renderedText, renderedToSrc, srcToRendered }
}

/**
 * Walks every inline text node in the mdast tree (remark provides `position`
 * with absolute character offsets into the original source for every node)
 * and records, per run, the exact source range it came from plus a source
 * offset table built by `buildRunOffsetTables`. For plain-text runs the
 * table is a direct identity index. Runs nested inside emphasis/strong/link
 * nodes still get their own entry with their own source range — the
 * *rendered* text differs from the source only in the surrounding
 * delimiters (**, *, [...](...)), which are outside the text node's own
 * position range, so the text node's own content is identity-mapped there
 * too. Escaped characters and HTML entities are the one case where a text
 * node's rendered value is not simply `source.slice(srcStart, srcEnd)` —
 * Gate 1 (Task 5) found this empirically (an entity/escape run's rendered
 * text can be significantly shorter than its source span, e.g. "&amp;" (5
 * source chars) decodes to "&" (1 rendered char)), and confirmed the naive
 * identity formula silently mapped offsets *after* an entity within the
 * same run to the wrong source character. `buildRunOffsetTables` corrects
 * this with an explicit table, using the exact decode primitives
 * (`decode-named-character-reference`, `micromark-util-decode-numeric-character-reference`)
 * that mdast-util-from-markdown itself uses to build `node.value`.
 */
export function annotateSourceOffsets(tree: Root, source: string): SourceMap {
  const runs: Run[] = []
  let counter = 0

  visit(tree, 'text', (node: Text) => {
    if (!node.position) return
    const srcStart = node.position.start.offset
    const srcEnd = node.position.end.offset
    if (srcStart == null || srcEnd == null) return
    const { renderedText, renderedToSrc, srcToRendered } = buildRunOffsetTables(
      source.slice(srcStart, srcEnd)
    )
    runs.push({
      runId: `run-${counter++}`,
      srcStart,
      srcEnd,
      renderedText,
      renderedToSrc,
      srcToRendered
    })
  })

  const byId = new Map(runs.map((r) => [r.runId, r]))

  return {
    htmlOffsetToSrc(htmlOffset: number, runId: string): number {
      const run = byId.get(runId)
      if (!run) throw new Error(`Unknown runId ${runId}`)
      if (htmlOffset < 0 || htmlOffset >= run.renderedToSrc.length) {
        throw new Error(
          `htmlOffset ${htmlOffset} out of range for run ${runId} (rendered length ${run.renderedToSrc.length})`
        )
      }
      return run.srcStart + run.renderedToSrc[htmlOffset]
    },
    srcToRun(srcOffset: number): { runId: string; htmlOffset: number } | null {
      for (const run of runs) {
        if (srcOffset >= run.srcStart && srcOffset < run.srcEnd) {
          const htmlOffset = run.srcToRendered[srcOffset - run.srcStart]
          if (htmlOffset == null) return null
          return { runId: run.runId, htmlOffset }
        }
      }
      return null
    }
  }
}
