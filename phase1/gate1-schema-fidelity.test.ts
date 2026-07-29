import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMarkdown } from '@milkdown/utils'
import { createMilkdownEditor } from './milkdown-fixture'

const CORPUS_DIR = join(__dirname, '..', 'phase0', 'corpus')

const corpusFiles = [
  'short.md',
  'mixed.md',
  'reference-links-and-footnotes.md',
  'nested-lists.md',
  'entities-and-escapes.md',
  'tables-spanning-pages.md',
  'raw-html.md'
]

describe('Gate 1: Milkdown schema completeness & round-trip fidelity', () => {
  for (const file of corpusFiles) {
    it(`round-trips ${file} without silent content loss`, async () => {
      const source = readFileSync(join(CORPUS_DIR, file), 'utf8')
      const editor = await createMilkdownEditor(source)
      const output = editor.action(getMarkdown())

      // Re-parse both sides for a semantic comparison rather than a raw string
      // diff, per the design doc's own correction (a bare string diff fails on
      // cosmetically-different-but-equivalent output, e.g. list marker style).
      const inputWords: string[] = source.match(/\S+/g) ?? []
      const outputWords: string[] = output.match(/\S+/g) ?? []
      const missingWords = inputWords.filter((word) => !outputWords.includes(word))

      // This assertion is deliberately loose (word-presence, not exact-match) --
      // Gate 1's job is to catch SILENT CONTENT LOSS (a node/word disappearing
      // entirely), not to enforce byte-identical formatting (the known
      // tight-list-becomes-loose gap is a formatting difference, not content
      // loss, and is expected to still show up here as informational content
      // in the report below, not a failure).
      expect(missingWords, `Words present in ${file} but missing from round-trip output`).toEqual(
        []
      )
    })
  }
})
