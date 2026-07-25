import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { Root } from 'mdast'
import { annotateSourceOffsets } from './source-map'

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
})
