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
  // treatment the design already gives to pure markup syntax like "**". Also
  // null for every non-anchor position in a run that fell back to the
  // block-level guide (see `degraded` on `buildRunOffsetTables`'s return).
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
 * bidirectional offset table between source and rendered positions.
 *
 * For ordinary characters this is a 1:1 identity mapping. For a *genuine*
 * escape (`\*`) or character reference (`&amp;`, `&#65;`, `&#x42;`) — one
 * where `decodeMatch` actually produces something different from the raw
 * matched text — the whole source sequence collapses to (usually) one
 * rendered character: the sequence's first source byte anchors that
 * rendered position, and any remaining interior bytes map to `null` (no
 * rendered position of their own, same as markup syntax). A reference-
 * *shaped* match that isn't a real reference (`decodeMatch` returns the
 * text unchanged — e.g. "&A;" in ordinary prose, not a recognized named
 * entity) is identity-mapped character-for-character like anything else;
 * it must NOT take the collapse branch just because the regex matched it.
 *
 * `groundTruthRenderedText`, when supplied, is the real `node.value` a live
 * parse produced for this exact source slice. If the table this function
 * computes doesn't match it, some transform beyond escapes/entities is at
 * play that this function doesn't model — confirmed to happen for e.g.
 * list-item/blockquote continuation-line prefix stripping across a soft
 * line break within a single run (Gate 1 / Task 5 review found this; a
 * correct fix needs the enclosing list/blockquote's container context —
 * marker width, nesting depth — which isn't available from a run's own
 * source slice alone, unlike escapes/entities, which are fully
 * self-contained). Rather than return a silently-wrong per-character table
 * for an unmodeled transform, the whole run falls back to the design's
 * documented block-level guide: every rendered offset anchors to the run's
 * own start, and every source offset except the run's first byte reports
 * "not independently addressable" (`null`), exactly like markup syntax.
 * This is a general safety net — it downgrades gracefully for *any* future
 * unmodeled transform, not just the two found so far, and never lies.
 */
export function buildRunOffsetTables(
  sourceSlice: string,
  groundTruthRenderedText?: string
): {
  renderedText: string
  renderedToSrc: number[]
  srcToRendered: (number | null)[]
  degraded: boolean
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

    if (decoded === match[0]) {
      // Reference-shaped but not a real reference (e.g. "&A;", "&notreal;")
      // — genuinely identity-mapped, character for character.
      for (let i = matchStart; i < matchEnd; i++) {
        srcToRendered[i] = renderedText.length
        renderedToSrc.push(i)
        renderedText += sourceSlice[i]
      }
    } else {
      srcToRendered[matchStart] = renderedText.length
      for (let k = 0; k < decoded.length; k++) {
        renderedToSrc.push(matchStart)
        renderedText += decoded[k]
      }
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

  if (groundTruthRenderedText !== undefined && renderedText !== groundTruthRenderedText) {
    // Unmodeled transform — fall back to the block-level guide for this
    // whole run rather than report a table we know disagrees with reality.
    const fallbackSrcToRendered: (number | null)[] = new Array(sourceSlice.length).fill(null)
    if (sourceSlice.length > 0) fallbackSrcToRendered[0] = 0
    return {
      renderedText: groundTruthRenderedText,
      renderedToSrc: new Array(groundTruthRenderedText.length).fill(0),
      srcToRendered: fallbackSrcToRendered,
      degraded: true
    }
  }

  return { renderedText, renderedToSrc, srcToRendered, degraded: false }
}

/**
 * Walks every inline text node in the mdast tree (remark provides `position`
 * with absolute character offsets into the original source for every node)
 * and records, per run, the exact source range it came from plus a source
 * offset table built by `buildRunOffsetTables`, passing the node's real
 * `node.value` as the ground truth so any run whose source-to-rendered
 * transform isn't fully modeled (escapes/entities are; see
 * `buildRunOffsetTables`'s doc comment for the one confirmed exception —
 * continuation-line prefix stripping) degrades safely to a block-level
 * guide instead of returning a wrong per-character mapping.
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
      source.slice(srcStart, srcEnd),
      node.value
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
      if (htmlOffset === run.renderedToSrc.length) {
        // One past the last rendered character — a normal, valid caret
        // position (end of this run), not an error.
        return run.srcEnd
      }
      if (htmlOffset < 0 || htmlOffset > run.renderedToSrc.length) {
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
