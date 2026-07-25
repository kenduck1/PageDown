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
  })
})
