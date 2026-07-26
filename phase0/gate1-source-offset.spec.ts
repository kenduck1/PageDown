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
import { markdownToHtml, type SourceMap } from '../src/markdown/pipeline'
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

/**
 * Exhaustive, independent reconstruction of one run's expected source
 * <-> rendered mapping, checked against the real `SourceMap` in BOTH
 * directions: every single source byte in `[srcStart, srcEnd)` (via
 * `srcToRun`), and every single rendered offset in `[0, renderedLength]`
 * inclusive of the one-past-the-end position (via `htmlOffsetToSrc`). Not a
 * sample, not gated on any condition, not scoped to only certain byte
 * classes, and not one direction only.
 *
 * This replaced three narrower, partial checks this task went through in
 * turn (a run-level aggregate length comparison, then a per-match-only
 * loop, then a rendered-offset loop with a "&"/"\" skip heuristic) after
 * review found each had its own blind spot the others didn't cover — most
 * pointedly, a bug that nulls an ordinary, non-match byte was invisible to
 * all of them at once, since none of them checked ordinary bytes as a
 * matter of course. A later review round found this function *itself* had
 * a further blind spot even after that fix: it only ever walked SOURCE
 * bytes and asked "what rendered offset does this map to" — it never
 * independently walked RENDERED offsets and asked "what source offset does
 * this map to," so a bug that corrupts `htmlOffsetToSrc` for a rendered
 * offset that's never the *first* one produced by any source byte (e.g.
 * the second UTF-16 code unit of a decoded surrogate pair, as `&Afr;`
 * produces) was completely unchecked. Both directions are walked here,
 * independently, against the same reconstructed expectation:
 *
 * - An ordinary (non-match) byte must be addressable at the current
 *   running rendered offset (identity).
 * - The first byte of a *real* match (decodes to something different)
 *   anchors every rendered offset the decode produces (one or more, for a
 *   multi-code-unit decode); every other source byte in that match must be
 *   `null` (non-addressable), same as markup syntax.
 * - Every byte of a *fake* match (decodes to itself) is addressable in
 *   lockstep with the running rendered offset, exactly like ordinary
 *   bytes — this is the byte range the original "&A;" bug got wrong.
 * - `htmlOffsetToSrc(j, runId)` for every rendered offset `j` (including
 *   `j === renderedLength`, the end-of-run position) must equal the source
 *   anchor above, unconditionally — checked in its own loop, not derived
 *   from the source-byte loop's results.
 *
 * Only meaningful for a run whose escape/entity-only model actually
 * explains its real `node.value` — the caller only invokes this for runs
 * that already passed a hard, unconditional decoded-text equality check;
 * `continuation-prefixes.md`'s degraded runs are covered by the separate
 * known-gap test below, not by this function, and are not in `corpusFiles`.
 *
 * Returns `matchCount` and `multiCodeUnitMatchCount` (REAL matches only —
 * decode to something different — whose decode produces more than one
 * UTF-16 code unit, e.g. `&Afr;`; a fake match's `decodedLength` is just its
 * own possibly-multi-character source text reproduced unchanged, e.g.
 * `"&A;"`, which is not a "multi-code-unit decode" in the relevant sense) so
 * the caller can pin that the multi-code-unit case is actually present in
 * the corpus, not just handled in the abstract — a reviewer found that
 * without this pin, editing the one fixture entity that exercises it (e.g.
 * swapping `&Afr;` for `&copy;`) leaves `totalRuns`/`totalMatches` unchanged
 * and the whole direction-2 rendered-offset check silently untested again.
 */
function verifyRunExhaustively(
  sourceMap: SourceMap,
  source: string,
  srcStart: number,
  srcEnd: number,
  mismatches: string[],
  file: string
): { matchCount: number; multiCodeUnitMatchCount: number } {
  const sourceSlice = source.slice(srcStart, srcEnd)

  const matches: {
    start: number
    end: number
    decodedLength: number
    isReal: boolean
    whole: string
  }[] = []
  ESCAPE_OR_REFERENCE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ESCAPE_OR_REFERENCE.exec(sourceSlice))) {
    const decoded = decodeMatchForOracle(m[1], m[2], m[0])
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      decodedLength: decoded.length,
      isReal: decoded !== m[0],
      whole: m[0]
    })
  }

  // Independent reconstruction: for every rendered offset (0 through
  // renderedLength inclusive), the source offset it's expected to anchor
  // to. Built once, straight from `matches`, with no reference to what the
  // real SourceMap says — this is the shared expectation both direction
  // loops below check against.
  const expectedAnchorForRendered: number[] = []
  {
    let i = 0
    let matchIdx = 0
    while (i < sourceSlice.length) {
      const match = matches[matchIdx]
      if (match && match.start === i) {
        if (match.isReal) {
          // A real match's every produced rendered position (one or more,
          // for a multi-code-unit decode) anchors to the SAME single source
          // byte — the match's first byte — same as direction 1's anchor
          // treatment above.
          for (let k = 0; k < match.decodedLength; k++) {
            expectedAnchorForRendered.push(srcStart + i)
          }
        } else {
          // A fake match is plain identity, lockstep: each byte maps to its
          // OWN source position, not all to the first byte's.
          for (let k = i; k < match.end; k++) {
            expectedAnchorForRendered.push(srcStart + k)
          }
        }
        i = match.end
        matchIdx++
      } else {
        expectedAnchorForRendered.push(srcStart + i)
        i += 1
      }
    }
  }
  expectedAnchorForRendered.push(srcEnd) // one-past-the-end position

  // --- Direction 1: every SOURCE byte resolves correctly (srcToRun) ---
  {
    let renderedOffset = 0
    let i = 0
    let matchIdx = 0
    while (i < sourceSlice.length) {
      const match = matches[matchIdx]
      if (match && match.start === i) {
        if (match.isReal) {
          checkAddressable(
            sourceMap,
            mismatches,
            file,
            srcStart + i,
            renderedOffset,
            `anchor byte of real reference/escape ${JSON.stringify(match.whole)}`
          )
          for (let k = i + 1; k < match.end; k++) {
            checkNotAddressable(
              sourceMap,
              mismatches,
              file,
              srcStart + k,
              `interior byte of real reference/escape ${JSON.stringify(match.whole)}`
            )
          }
          renderedOffset += match.decodedLength
        } else {
          for (let k = i; k < match.end; k++) {
            checkAddressable(
              sourceMap,
              mismatches,
              file,
              srcStart + k,
              renderedOffset + (k - i),
              `byte of fake (non-decoding) reference/escape-shaped match ${JSON.stringify(match.whole)}`
            )
          }
          renderedOffset += match.end - i // === decodedLength here, since a fake match's decoded output equals its own source text
        }
        i = match.end
        matchIdx++
      } else {
        checkAddressable(sourceMap, mismatches, file, srcStart + i, renderedOffset, 'ordinary byte')
        renderedOffset += 1
        i += 1
      }
    }
  }

  // --- Direction 2: every RENDERED offset resolves correctly
  // (htmlOffsetToSrc), independently of direction 1 above. This is the
  // direction that catches a bug in an interior code unit of a
  // multi-code-unit decode (e.g. the second UTF-16 unit of a surrogate
  // pair), since direction 1 never queries `htmlOffsetToSrc` for any
  // rendered offset except the one the FIRST source byte of a match maps
  // to.
  {
    const anchorInfo = sourceMap.srcToRun(srcStart)
    if (!anchorInfo) {
      mismatches.push(
        `${file}@[${srcStart},${srcEnd}): srcToRun(srcStart) unexpectedly returned null`
      )
    } else {
      const runId = anchorInfo.runId
      for (let j = 0; j < expectedAnchorForRendered.length; j++) {
        const recovered = sourceMap.htmlOffsetToSrc(j, runId)
        if (recovered !== expectedAnchorForRendered[j]) {
          mismatches.push(
            `${file} run[${srcStart},${srcEnd}) rendered offset ${j}: htmlOffsetToSrc(${j}) => ${recovered}, expected ${expectedAnchorForRendered[j]}`
          )
        }
      }
    }
  }

  return {
    matchCount: matches.length,
    // Only REAL matches count as a "multi-code-unit decode" — a fake match's
    // `decodedLength` is just its own (possibly multi-character) source text
    // reproduced unchanged (e.g. "&A;", 3 code units), which is plain
    // identity, not a decode producing multiple rendered code units from one
    // anchor the way a surrogate-pair-producing reference does.
    multiCodeUnitMatchCount: matches.filter((match) => match.isReal && match.decodedLength > 1)
      .length
  }
}

function checkAddressable(
  sourceMap: SourceMap,
  mismatches: string[],
  file: string,
  srcOffset: number,
  expectedHtmlOffset: number,
  label: string
): void {
  const run = sourceMap.srcToRun(srcOffset)
  if (!run) {
    mismatches.push(
      `${file}@${srcOffset}: ${label} should be addressable at rendered offset ${expectedHtmlOffset}, got null`
    )
    return
  }
  if (run.htmlOffset !== expectedHtmlOffset) {
    mismatches.push(
      `${file}@${srcOffset}: ${label} addressable but at the wrong rendered offset — expected ${expectedHtmlOffset}, got ${run.htmlOffset}`
    )
    return
  }
  const recovered = sourceMap.htmlOffsetToSrc(run.htmlOffset, run.runId)
  if (recovered !== srcOffset) {
    mismatches.push(
      `${file}@${srcOffset}: ${label} round-trip mismatch — htmlOffsetToSrc(${run.htmlOffset}) => ${recovered}, expected ${srcOffset}`
    )
  }
}

function checkNotAddressable(
  sourceMap: SourceMap,
  mismatches: string[],
  file: string,
  srcOffset: number,
  label: string
): void {
  const run = sourceMap.srcToRun(srcOffset)
  if (run) {
    mismatches.push(
      `${file}@${srcOffset}: ${label} should be null (non-addressable), got htmlOffset ${run.htmlOffset}`
    )
  }
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
// This second test re-parses each corpus file directly (independent of
// pipeline.ts/source-map.ts's internal wiring) to get the real `node.value`
// mdast/micromark produces for every text run. Three successive, narrower
// versions of the check that followed were each found to have their own
// blind spot in review: (1) comparing only `renderedText === node.value`
// missed offset bugs that don't change the decoded text (the "&A;" bug); (2)
// a run-level aggregate length comparison missed the same bug when it shared
// a run with a real, genuinely-collapsing reference, since the real one's
// length change masks the fake one's zero net change in the aggregate; (3) a
// per-match-only loop missed bugs in *ordinary* (non-match) bytes entirely,
// since it never looked at anything outside a regex match.
// `verifyRunExhaustively` above replaces all three: it checks every single
// source byte AND every single rendered offset in a run, unconditionally, so
// there's no gap left for a bug to hide in between checks.
//
// A version of this test between the third and fourth review rounds made the
// decoded-text mismatch below conditional on `isDegraded`, on the theory that
// `continuation-prefixes.md`-style degradation is an expected outcome. That
// was itself the exact mistake this whole chain of fixes has been about:
// `isDegraded` is computed by comparing the table's own decode against
// `node.value` in the first place (see `source-map.ts`), so ANY decode bug in
// one of these 8 files makes `isDegraded` true for that run, which made the
// check never fire regardless of how wrong the decode was — confirmed by a
// reviewer reproduction (corrupting `&mdash;`/`&lt;`/`&gt;` to all decode to
// `"?"`) that passed the entire suite green while two runs silently collapsed
// to 1 addressable byte out of 143 and 181. None of these 8 `corpusFiles` is
// `continuation-prefixes.md` — no run in any of them is EVER supposed to
// degrade — so a decoded-text mismatch here is an unconditional hard
// failure, full stop, no exception, and the check does not consult
// `isDegraded` at all. `isDegraded` is still checked below, but as its own
// separate, equally unconditional hard failure ("this file must never
// degrade"), not as a way to excuse a decoded-text mismatch.
test('Gate 1 (independent oracle): the offset-correction table decodes every real corpus run identically to a live remark parse, and every source byte and rendered offset in it resolves through SourceMap to the correct answer', async () => {
  const mismatches: string[] = []
  let totalRuns = 0
  let verifiedRuns = 0
  let totalMatches = 0
  let totalMultiCodeUnitMatches = 0

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
        return
      }

      // Every run that reaches here must genuinely not be degraded — not
      // just "the decoded text happened to match" (which is all the check
      // above proves), but `isDegraded` itself must say so.
      const runInfo = sourceMap.srcToRun(srcStart)
      if (!runInfo) {
        mismatches.push(
          `${file}@[${srcStart},${srcEnd}): srcToRun(srcStart) unexpectedly returned null`
        )
        return
      }
      if (sourceMap.isDegraded(runInfo.runId)) {
        mismatches.push(
          `${file}@[${srcStart},${srcEnd}): isDegraded is true, but this file must never degrade`
        )
        return
      }

      verifiedRuns++
      const { matchCount, multiCodeUnitMatchCount } = verifyRunExhaustively(
        sourceMap,
        source,
        srcStart,
        srcEnd,
        mismatches,
        file
      )
      totalMatches += matchCount
      totalMultiCodeUnitMatches += multiCodeUnitMatchCount
    })
  }

  if (mismatches.length > 0) {
    console.log(
      `Gate 1 independent oracle: ${mismatches.length}/${totalRuns} runs (${totalMatches} escape/reference matches) mismatched:`
    )
    console.log(mismatches.slice(0, 40).join('\n'))
  }
  expect(mismatches.slice(0, 40), mismatches.slice(0, 40).join('\n')).toHaveLength(0)
  // Pinned to the actual known values (not just "> 0"): a decode bug that
  // still parses without throwing can leave a count like "> 0" satisfied at
  // some other, wrong number — confirmed in review that a ">0" bound alone
  // survived a corrupted-decoder reproduction at several different counts.
  expect(totalRuns).toBe(1440)
  expect(totalMatches).toBe(16)
  // Every run that reached the exhaustive check genuinely was not degraded
  // (checked via `isDegraded` above, not merely implied).
  expect(verifiedRuns).toBe(totalRuns)
  // Pins that the multi-code-unit (surrogate-pair) decode case — the one
  // `&Afr;` fixture entity — is actually present in the corpus, not just
  // handled in the abstract. Without this, editing that one fixture entity
  // (e.g. swapping `&Afr;` for `&copy;`) would leave `totalRuns`/
  // `totalMatches` unchanged and silently remove all coverage of the
  // direction-2 rendered-offset check's reason for existing — confirmed by
  // a reviewer reproduction that did exactly that and passed clean.
  expect(totalMultiCodeUnitMatches).toBe(1)
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
// just a sampled offset or two.
//
// Review also found the `isDegraded` check only ever asserted the `true`
// direction: hardcoding `isDegraded` to always return `true` still passed
// every test, because the "this run isn't degraded" branch below just
// silently skipped its own coverage instead of failing. Fixed by also
// asserting `isDegraded(...) === false` for the runs that should NOT be
// degraded, so a lying accessor in either direction is caught.
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
  const unaffectedRuns: { srcStart: number; srcEnd: number }[] = []
  visit(tree, 'text', (node: Text) => {
    const srcStart = node.position?.start.offset
    const srcEnd = node.position?.end.offset
    if (srcStart == null || srcEnd == null) return
    const sourceSlice = source.slice(srcStart, srcEnd)
    if (sourceSlice === node.value) {
      unaffectedRuns.push({ srcStart, srcEnd })
      return
    }
    // (a) the raw gap is genuine: without ground truth, the escape/entity
    // table alone really does disagree with the real parse.
    expect(buildRunOffsetTables(sourceSlice).renderedText).not.toBe(node.value)
    degradedRuns.push({ srcStart, srcEnd, renderedLength: node.value.length })
  })
  // This fixture is specifically built to exercise both cases — if either
  // drops to 0, the fixture broke or the transform stopped reproducing, and
  // the true/false split below would no longer be exercising anything.
  expect(degradedRuns.length).toBeGreaterThan(0)
  expect(unaffectedRuns.length).toBeGreaterThan(0)

  for (const { srcStart, srcEnd, renderedLength } of degradedRuns) {
    const anchor = sourceMap.srcToRun(srcStart)
    expect(anchor).not.toBeNull()
    const runId = anchor!.runId

    // (b) isDegraded correctly flags this run as degraded.
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

  // The false direction: runs that should NOT be degraded must report
  // isDegraded === false, and every offset in them must resolve correctly —
  // a lying "everything is degraded" accessor must fail here, not just
  // silently skip coverage the way the previous version of this test did.
  for (const { srcStart, srcEnd } of unaffectedRuns) {
    const anchor = sourceMap.srcToRun(srcStart)
    expect(anchor).not.toBeNull()
    expect(sourceMap.isDegraded(anchor!.runId)).toBe(false)
    for (let srcOffset = srcStart; srcOffset < srcEnd; srcOffset++) {
      const run = sourceMap.srcToRun(srcOffset)
      expect(run).not.toBeNull()
      expect(sourceMap.isDegraded(run!.runId)).toBe(false)
      const recovered = sourceMap.htmlOffsetToSrc(run!.htmlOffset, run!.runId)
      expect(source[recovered]).toBe(source[srcOffset])
    }
  }
})
