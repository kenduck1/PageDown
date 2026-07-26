import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { visit } from 'unist-util-visit'
import type { Root, Text } from 'mdast'
import { annotateSourceOffsets, buildRunOffsetTables } from './source-map'

describe('annotateSourceOffsets', () => {
  it('maps an identity run (plain text) back to the exact source characters', () => {
    const source = 'Hello world, this is plain text.'
    const tree = unified().use(remarkParse).parse(source) as Root
    const map = annotateSourceOffsets(tree, source)

    // Pick an arbitrary offset inside the plain-text run and confirm round trip.
    const run = map.srcToRun(6) // inside "world"
    expect(run).not.toBeNull()
    const srcBack = map.htmlOffsetToSrc(run!.htmlOffset, run!.runId)
    expect(source[srcBack]).toBe(source[6])
  })

  it('maps offsets inside a bold run back to the correct source character, not the rendered one', () => {
    const source = 'Text with **bold word** inside.'
    const tree = unified().use(remarkParse).parse(source) as Root
    const map = annotateSourceOffsets(tree, source)

    // "bold word" starts at source index 12 (after "Text with **"); rendered text starts at 0 within the run.
    const boldWordSrcStart = source.indexOf('bold word')
    const run = map.srcToRun(boldWordSrcStart + 2) // inside "bold word", at the "l" in "bold"
    expect(run).not.toBeNull()
    const srcBack = map.htmlOffsetToSrc(run!.htmlOffset, run!.runId)
    expect(source[srcBack]).toBe(source[boldWordSrcStart + 2])
  })

  // Gate 1 (Task 5) found that the plain round-trip pattern above
  // (srcToRun -> htmlOffsetToSrc -> compare to the *same* srcOffset) can
  // never fail: htmlOffsetToSrc(srcToRun(x).htmlOffset) collapses back to x
  // by construction for any implementation shaped like this one, regardless
  // of whether the offsets are actually correct. It passed on the corpus
  // fixtures that don't contain entities/escapes only because, for those,
  // the identity assumption happens to be genuinely true (verified
  // separately by comparing node.value to the raw source slice). It does
  // NOT prove correctness for runs where source and rendered text diverge
  // (HTML entities, backslash escapes) — the tests below check that case
  // against an independent oracle instead: the real `node.value` a full
  // remark parse produces, and a concrete real-world htmlOffset (not one
  // manufactured by srcToRun from the answer we're checking).
  describe('buildRunOffsetTables (entity/escape correction)', () => {
    it('decodes a named character reference identically to remark', () => {
      const sourceSlice = 'A &amp; B'
      const tree = unified().use(remarkParse).parse(sourceSlice) as Root
      let nodeValue = ''
      visit(tree, 'text', (node: Text) => {
        nodeValue += node.value
      })
      const { renderedText } = buildRunOffsetTables(sourceSlice)
      expect(renderedText).toBe(nodeValue)
      expect(renderedText).toBe('A & B')
    })

    it('decodes numeric and hexadecimal character references identically to remark', () => {
      const sourceSlice = '&#65;&#x42;'
      const tree = unified().use(remarkParse).parse(sourceSlice) as Root
      let nodeValue = ''
      visit(tree, 'text', (node: Text) => {
        nodeValue += node.value
      })
      const { renderedText } = buildRunOffsetTables(sourceSlice)
      expect(renderedText).toBe(nodeValue)
      expect(renderedText).toBe('AB')
    })

    it('decodes a backslash escape identically to remark', () => {
      const sourceSlice = '\\*not emphasis\\*'
      const tree = unified().use(remarkParse).parse(sourceSlice) as Root
      let nodeValue = ''
      visit(tree, 'text', (node: Text) => {
        nodeValue += node.value
      })
      const { renderedText } = buildRunOffsetTables(sourceSlice)
      expect(renderedText).toBe(nodeValue)
      expect(renderedText).toBe('*not emphasis*')
    })

    it('is the concrete failing case: recovers the correct source character after an entity in the same run (not just a self-consistent round trip)', () => {
      // Before the fix, annotateSourceOffsets assumed htmlOffset === srcOffset
      // - srcStart for the whole run. For "Rights &copy; 2026 PageDown",
      // that meant a *real* rendered offset (e.g. the "2" of "2026" in the
      // decoded text "Rights © 2026 PageDown", rendered index 9) was mapped
      // via srcStart + 9 to source index 9 relative to the run -- landing on
      // "o" (from "copy"), not "2". Confirmed empirically against the
      // pre-fix implementation during this task's investigation.
      const source = 'Rights &copy; 2026 PageDown.'
      const tree = unified().use(remarkParse).parse(source) as Root
      const map = annotateSourceOffsets(tree, source)

      let renderedValue = ''
      visit(tree, 'text', (node: Text) => {
        renderedValue += node.value
      })
      const renderedOffsetOf2026 = renderedValue.indexOf('2026')
      expect(renderedOffsetOf2026).toBeGreaterThan(-1)

      // runId is internal, but any offset in the run resolves to the same
      // runId; use the run's own start (offset 0) purely to obtain it.
      const anyRunInfo = map.srcToRun(0)
      expect(anyRunInfo).not.toBeNull()

      const recoveredSrc = map.htmlOffsetToSrc(renderedOffsetOf2026, anyRunInfo!.runId)
      expect(source.slice(recoveredSrc, recoveredSrc + 4)).toBe('2026')
    })

    it('treats interior bytes of an entity/escape sequence as non-addressable, like markup syntax', () => {
      const source = 'Rights &copy; 2026.'
      const tree = unified().use(remarkParse).parse(source) as Root
      const map = annotateSourceOffsets(tree, source)

      const ampersandOffset = source.indexOf('&copy;')
      // The "&" itself is the anchor for the decoded "©".
      expect(map.srcToRun(ampersandOffset)).not.toBeNull()
      // "c", "o", "p", "y", ";" are consumed by the same reference and have
      // no rendered position of their own.
      for (let i = 1; i <= 5; i++) {
        expect(map.srcToRun(ampersandOffset + i)).toBeNull()
      }
    })

    it('does NOT collapse a reference-shaped match that is not a real reference (regression: "&A;" in ordinary prose)', () => {
      // Found in review: the ESCAPE_OR_REFERENCE regex matches "&A;" (it's
      // shaped like a character reference), but "A" is not a recognized
      // named entity, so decodeNamedCharacterReference returns `false` and
      // decodeMatch correctly falls back to the literal "&A;" unchanged.
      // The bug was that buildRunOffsetTables still took the "this is a
      // special construct" branch and anchored/nulled the interior "A" and
      // ";" bytes anyway, even though nothing was actually decoded — so
      // htmlOffsetToSrc returned wrong offsets for them and srcToRun
      // wrongly returned null for two ordinary, addressable characters.
      const source = 'We ran a Q&A; the results were shared.'
      const tree = unified().use(remarkParse).parse(source) as Root
      const map = annotateSourceOffsets(tree, source)

      const ampIdx = source.indexOf('&A;')
      // "&", "A", and ";" are all ordinary identity-mapped characters here —
      // none of them should return null.
      for (const offset of [ampIdx, ampIdx + 1, ampIdx + 2]) {
        const run = map.srcToRun(offset)
        expect(run, `srcToRun(${offset}) ("${source[offset]}") should not be null`).not.toBeNull()
        const back = map.htmlOffsetToSrc(run!.htmlOffset, run!.runId)
        expect(source[back]).toBe(source[offset])
      }

      const { renderedText, degraded } = buildRunOffsetTables(source)
      expect(degraded).toBe(false)
      expect(renderedText).toBe(source)
    })
  })

  describe('buildRunOffsetTables (unmodeled-transform safety net)', () => {
    it('falls back to a block-level guide, without lying, for a construct it cannot model (list-item continuation-line indentation stripping)', () => {
      // Confirmed against a live parse: mdast strips the continuation-line
      // indentation from a wrapped list item's merged text node, but keeps
      // the node's `position` spanning the original (indented) source. This
      // is a container-context-dependent transform (the stripped amount
      // depends on the enclosing list item's marker width) that can't be
      // recovered from the run's own source slice alone, unlike escapes/
      // entities — so this is the one case `buildRunOffsetTables` cannot
      // genuinely model, per the design's documented block-level fallback.
      const source = '1. Requirements\n   1. Interview stakeholders\n      continuation text\n'
      const tree = unified().use(remarkParse).parse(source) as Root

      let sawDegradedRun = false
      visit(tree, 'text', (node: Text) => {
        const s = node.position?.start.offset
        const e = node.position?.end.offset
        if (s == null || e == null) return
        const sourceSlice = source.slice(s, e)
        if (sourceSlice === node.value) return // not the affected run

        // Proves the raw gap is real: without ground truth, the table
        // (pure identity + escape/entity modeling) disagrees with reality.
        const raw = buildRunOffsetTables(sourceSlice)
        expect(raw.renderedText).not.toBe(node.value)

        // Proves the safety net: given the ground truth, the table falls
        // back safely instead of reporting the (wrong) raw table above.
        const safe = buildRunOffsetTables(sourceSlice, node.value)
        expect(safe.degraded).toBe(true)
        expect(safe.renderedText).toBe(node.value)
        sawDegradedRun = true
      })
      expect(sawDegradedRun).toBe(true)
    })

    it('exposes degradation via isDegraded, and htmlOffsetToSrc/srcToRun honor the block-level contract across the FULL run, not just its first byte', () => {
      // Review found: a version of this test that only asserted inside
      // `if (!run) continue` was tautological in the same shape the very
      // first Gate 1 fix addressed — for a degraded run, `srcToRun` returns
      // non-null for exactly one source offset (the run's first byte), so
      // that loop only ever asserted on 1 offset, and the assertion itself
      // (`source[recovered] === source[srcOffset]` where `recovered ===
      // srcOffset` by construction for that one position) proved nothing.
      // It also never called `isDegraded`, so a real gap (`htmlOffsetToSrc`
      // silently returning `srcStart` for every rendered offset with no
      // signal) went unchecked. This version checks the real, full contract.
      const source = '> Reviewers should read the brief\n> before the meeting begins.\n'
      const tree = unified().use(remarkParse).parse(source) as Root

      let srcStart = -1
      let srcEnd = -1
      let renderedLength = -1
      visit(tree, 'text', (node: Text) => {
        const s = node.position?.start.offset
        const e = node.position?.end.offset
        if (s == null || e == null) return
        srcStart = s
        srcEnd = e
        renderedLength = node.value.length
      })
      expect(srcStart).toBeGreaterThanOrEqual(0)
      // Sanity: this fixture must actually exercise the gap (source strictly
      // longer than rendered), or the rest of this test proves nothing.
      expect(srcEnd - srcStart).toBeGreaterThan(renderedLength)

      const map = annotateSourceOffsets(tree, source)
      const anchor = map.srcToRun(srcStart)
      expect(anchor).not.toBeNull()
      const runId = anchor!.runId
      expect(map.isDegraded(runId)).toBe(true)

      // The real (limited) contract: EVERY rendered offset in this run
      // resolves to the run's own start — checked across the full rendered
      // length, not just offset 0.
      for (let j = 0; j < renderedLength; j++) {
        expect(map.htmlOffsetToSrc(j, runId)).toBe(srcStart)
      }

      // EVERY source offset in the run's span is either the anchor (first
      // byte only) or explicitly non-addressable (null) — checked across
      // the full source span, not just one offset.
      for (let offset = srcStart; offset < srcEnd; offset++) {
        const run = map.srcToRun(offset)
        if (offset === srcStart) {
          expect(run).toEqual({ runId, htmlOffset: 0 })
        } else {
          expect(run).toBeNull()
        }
      }
    })
  })
})
