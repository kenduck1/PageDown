import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import { visit } from 'unist-util-visit'
import type { Root, Text } from 'mdast'
import { decodeNamedCharacterReference } from 'decode-named-character-reference'
import { decodeNumericCharacterReference } from 'micromark-util-decode-numeric-character-reference'
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
//
// Covers 8 of the 11 corpus fixtures from Task 2 — everything except
// `images-and-diagrams.md`, `headings-near-page-bottom.md`,
// `mermaid-diagrams.md`, and `foreign-frontmatter.md`, which were not run
// through this gate and are not claimed to be. `long.md`/`very-long.md`
// alone account for the large majority of total corpus bytes.
const corpusFiles = [
  'short.md',
  'mixed.md',
  'reference-links-and-footnotes.md',
  'nested-lists.md',
  'entities-and-escapes.md',
  'long.md',
  'very-long.md',
  'tables-spanning-pages.md'
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

// Independently re-derives, per match, whether an escape/character-reference
// candidate is "real" (decodes to something different) or "fake"
// (reference-shaped but not recognized — decodes to itself, e.g. "&A;" in
// ordinary prose). Uses the same authoritative decode primitives
// `source-map.ts` does (there is no more independent source of truth for
// "what does this entity actually decode to" than the real decoder), but
// this file's own regex scan and real/fake classification are written
// independently of `buildRunOffsetTables`'s internal categorization, so a
// bug in *that* categorization (this task found one) doesn't get a free
// pass just because it also happens to appear in the implementation.
const ESCAPE_OR_REFERENCE = /\\([!-/:-@[-`{-~])|&(#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/gi

function decodeMatchForOracle(
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
  return named === false ? whole : named
}

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
//
// A first version of this test only checked `renderedText === node.value`
// per run. Review found that alone is not enough: a correct decoded string
// does not imply a correct *offset* table (the "&A;"-in-ordinary-prose bug —
// see source-map.test.ts and the findings doc — decoded to the right text
// while still nulling out two ordinary, addressable source characters). A
// second version added a run-level aggregate check (below: "nothing net
// collapsed in this whole run"). Review found THAT has its own blind spot:
// if a run mixes a real, genuinely-collapsing reference (e.g. "&copy;") with
// a fake one (e.g. "&A;"), the real one's length change means the aggregate
// condition never holds for that run, so the fake one's bug — which,
// reintroduced, wrongly nulls its own interior bytes regardless of anything
// else in the run — goes completely unchecked. The fix is the per-match loop
// at the end of this test: it classifies and checks each individual
// escape/reference match's own byte range, independent of run-level
// aggregates and of what else shares its run.
test('Gate 1 (independent oracle): the offset-correction table decodes every real corpus run identically to a live remark parse, and every offset it reports resolves to the correct source character', async () => {
  const mismatches: string[] = []
  let totalRuns = 0
  let totalMatches = 0

  for (const file of corpusFiles) {
    const source = readFileSync(join(__dirname, 'corpus', file), 'utf8')
    const tree = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkFrontmatter, ['yaml'])
      .parse(source) as Root
    const { sourceMap } = markdownToHtml(source)

    visit(tree, 'text', (node: Text) => {
      const srcStart = node.position?.start.offset
      const srcEnd = node.position?.end.offset
      if (srcStart == null || srcEnd == null) return
      totalRuns++
      const sourceSlice = source.slice(srcStart, srcEnd)

      const { renderedText } = buildRunOffsetTables(sourceSlice)
      if (renderedText !== node.value) {
        mismatches.push(
          `${file}@[${srcStart},${srcEnd}): decoded text mismatch — table says ${JSON.stringify(renderedText)}, real parse says ${JSON.stringify(node.value)}`
        )
        return // decode itself is already wrong; skip the rest of the checks for this run
      }

      // Decoded text matches — now verify the *offsets*, not just the text,
      // via the real SourceMap. Any offset in this run resolves to the same
      // runId; srcStart always does (it's either an identity position or a
      // decode-sequence anchor, never a null interior byte).
      const runInfo = sourceMap.srcToRun(srcStart)
      if (!runInfo) {
        mismatches.push(
          `${file}@[${srcStart},${srcEnd}): srcToRun(srcStart) unexpectedly returned null`
        )
        return
      }

      // Run-level aggregate check: if this run's rendered length exactly
      // equals its raw source span, *nothing* collapsed anywhere in it, so
      // every offset must be plain identity. Kept because it's a cheap,
      // useful check for runs with no real entity/escape at all — but see
      // the per-match loop below for the check that actually has detection
      // power when a run mixes real and fake matches together.
      if (node.value.length === srcEnd - srcStart) {
        for (let srcOffset = srcStart; srcOffset < srcEnd; srcOffset++) {
          const run = sourceMap.srcToRun(srcOffset)
          if (!run || run.htmlOffset !== srcOffset - srcStart) {
            mismatches.push(
              `${file}@${srcOffset}: run of length srcEnd-srcStart===renderedLength should be pure identity, but srcToRun returned ${JSON.stringify(run)}`
            )
          }
        }
      }

      for (let j = 0; j < node.value.length; j++) {
        const recovered = sourceMap.htmlOffsetToSrc(j, runInfo.runId)
        const recoveredChar = source[recovered]
        // "&" or "\" at the recovered position means this rendered
        // character came from a real, genuinely-collapsing entity/escape
        // sequence (the anchor is the sequence's opening marker) — the
        // rendered character legitimately isn't the same character as the
        // marker itself, so it's excluded here, the same way markup syntax
        // positions are excluded from the first test above. (This
        // heuristic alone is not sufficient — see the per-match loop below
        // — but it still catches other offset bugs, e.g. a wrong anchor
        // position within a genuinely-collapsing run.)
        if (recoveredChar === '&' || recoveredChar === '\\') continue
        if (recoveredChar !== node.value[j]) {
          mismatches.push(
            `${file}@[${srcStart},${srcEnd}) rendered[${j}]: htmlOffsetToSrc(${j}) => src ${recovered} (${JSON.stringify(recoveredChar)}), expected ${JSON.stringify(node.value[j])}`
          )
        }
      }

      // Per-match independent check: the check with actual, verified
      // detection power for a fake reference/escape sharing a run with a
      // real one. Classifies each match independently (real vs. fake) and
      // checks only that match's own byte range — unaffected by run-level
      // aggregates or by other matches elsewhere in the same run.
      ESCAPE_OR_REFERENCE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = ESCAPE_OR_REFERENCE.exec(sourceSlice))) {
        totalMatches++
        const matchStart = srcStart + m.index
        const matchEnd = matchStart + m[0].length
        const decoded = decodeMatchForOracle(m[1], m[2], m[0])
        const isReal = decoded !== m[0]

        if (isReal) {
          // The sequence's first byte anchors the produced character(s);
          // it must be addressable. Interior bytes must not be (they were
          // consumed by the real decode, same treatment as "**" syntax).
          if (!sourceMap.srcToRun(matchStart)) {
            mismatches.push(
              `${file}@${matchStart}: anchor byte of real reference/escape ${JSON.stringify(m[0])} should be addressable, got null`
            )
          }
          for (let i = matchStart + 1; i < matchEnd; i++) {
            if (sourceMap.srcToRun(i)) {
              mismatches.push(
                `${file}@${i}: interior byte of real reference/escape ${JSON.stringify(m[0])} should be null (non-addressable), got a mapping`
              )
            }
          }
        } else {
          // Fake match (reference-shaped but not real): every byte,
          // including what would be "interior" for a real match, is
          // ordinary identity text and must be individually addressable —
          // this is exactly the byte range the "&A;" bug got wrong.
          for (let i = matchStart; i < matchEnd; i++) {
            if (!sourceMap.srcToRun(i)) {
              mismatches.push(
                `${file}@${i}: byte of fake (non-decoding) reference/escape-shaped match ${JSON.stringify(m[0])} should be addressable identity text, got null`
              )
            }
          }
        }
      }
    })
  }

  if (mismatches.length > 0) {
    console.log(
      `Gate 1 independent oracle: ${mismatches.length}/${totalRuns} runs (${totalMatches} escape/reference matches checked individually) mismatched:`
    )
    console.log(mismatches.slice(0, 40).join('\n'))
  }
  expect(mismatches.slice(0, 40), mismatches.slice(0, 40).join('\n')).toHaveLength(0)
  expect(totalRuns).toBeGreaterThan(0)
  expect(totalMatches).toBeGreaterThan(0)
})

// `continuation-prefixes.md` (a wrapped multi-line list item and a two-line
// blockquote) is deliberately NOT in `corpusFiles` above: mdast strips each
// continuation line's list-item indentation / blockquote "> " marker from
// the merged text node's rendered value while keeping `position` spanning
// the original (un-stripped) source — a container-context-dependent
// transform (the stripped amount depends on the enclosing list item's
// marker width or blockquote nesting) that can't be recovered from a run's
// own source slice alone, unlike escapes/entities. Per the design's
// documented fallback, `buildRunOffsetTables` detects when its own
// escape/entity-aware table doesn't match the real `node.value` and
// degrades that run to a block-level guide instead of reporting a
// silently-wrong per-character mapping. This test exists specifically to
// keep that finding real and checked, not just written down: it proves (a)
// the raw gap is genuine, (b) `SourceMap.isDegraded` correctly flags it, and
// (c) the real `SourceMap`'s block-level contract — every rendered offset
// in a degraded run resolves to that run's own start, every source offset
// in it is either the anchor or explicitly non-addressable — holds across
// the FULL rendered length and FULL source span of every degraded run, not
// just a sampled offset or two (an earlier version of this test asserted
// on only 2 of 307 affected source offsets, via the same tautological
// `if (!run) continue` shape the very first Gate 1 fix in this task
// addressed — the version below checks all of them).
test('Gate 1 (known gap, downgraded to block-level guides): list-item/blockquote continuation-line prefix stripping degrades safely instead of silently mismapping', async () => {
  const file = 'continuation-prefixes.md'
  const source = readFileSync(join(__dirname, 'corpus', file), 'utf8')
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .parse(source) as Root
  const { sourceMap } = markdownToHtml(source)

  const degradedRuns: { srcStart: number; srcEnd: number; renderedLength: number }[] = []
  visit(tree, 'text', (node: Text) => {
    const srcStart = node.position?.start.offset
    const srcEnd = node.position?.end.offset
    if (srcStart == null || srcEnd == null) return
    const sourceSlice = source.slice(srcStart, srcEnd)
    if (sourceSlice === node.value) return // unaffected run in this same fixture (confirms not everything degrades)
    // (a) the raw gap is genuine: without ground truth, the escape/entity
    // table alone really does disagree with the real parse.
    expect(buildRunOffsetTables(sourceSlice).renderedText).not.toBe(node.value)
    degradedRuns.push({ srcStart, srcEnd, renderedLength: node.value.length })
  })
  // This fixture is specifically built to exercise the gap — if this drops
  // to 0, either the fixture broke or the transform stopped being
  // reproduced, and the checks below would no longer be exercising anything.
  expect(degradedRuns.length).toBeGreaterThan(0)

  for (const { srcStart, srcEnd, renderedLength } of degradedRuns) {
    const anchor = sourceMap.srcToRun(srcStart)
    expect(anchor).not.toBeNull()
    const runId = anchor!.runId

    // (b) isDegraded correctly flags this run.
    expect(sourceMap.isDegraded(runId)).toBe(true)

    // (c) the block-level contract holds across the FULL run, not a sample:
    // every rendered offset resolves to the run's own start...
    for (let j = 0; j < renderedLength; j++) {
      expect(sourceMap.htmlOffsetToSrc(j, runId)).toBe(srcStart)
    }
    // ...and every source offset in the run is either the anchor (first
    // byte only) or explicitly non-addressable, never a silently wrong,
    // precise-looking mapping.
    for (let srcOffset = srcStart; srcOffset < srcEnd; srcOffset++) {
      const run = sourceMap.srcToRun(srcOffset)
      if (srcOffset === srcStart) {
        expect(run).toEqual({ runId, htmlOffset: 0 })
      } else {
        expect(run).toBeNull()
      }
    }
  }

  // Unaffected runs elsewhere in the same fixture are untouched by any of
  // this — full-document sanity check.
  for (let srcOffset = 0; srcOffset < source.length; srcOffset++) {
    const run = sourceMap.srcToRun(srcOffset)
    if (!run) continue
    if (sourceMap.isDegraded(run.runId)) continue // covered exhaustively above
    const recovered = sourceMap.htmlOffsetToSrc(run.htmlOffset, run.runId)
    expect(source[recovered]).toBe(source[srcOffset])
  }
})
