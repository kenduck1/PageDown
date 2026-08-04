import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMarkdown } from '@milkdown/utils'
import { createTestEditor } from './test-editor'
import { EDITOR_SCHEMA_PLUGINS } from './plugins'

const CORPUS_DIR = join(__dirname, '..', '..', '..', '..', 'phase0', 'corpus')

// EDITOR_SCHEMA_PLUGINS is the exact composition MilkdownEditor.tsx (the
// real, mounted editor) builds -- shared so this test's composition cannot
// silently drift from what's actually shipped. $remark()/$nodeSchema()
// return heterogeneous 2-tuples ([$Ctx, MilkdownPlugin]), not a bare
// MilkdownPlugin -- same fix as
// src/renderer/src/milkdown/nodes/frontmatter.test.ts and
// src/renderer/src/milkdown/nodes/pagebreak.test.ts, so this typechecks
// against createTestEditor's MilkdownPlugin[] parameter. commonmark/gfm are
// re-included here even though createTestEditor's own builder already adds
// them unconditionally -- Milkdown's `.use()` is idempotent per plugin
// instance (confirmed: re-using the same already-installed plugin instance
// is a documented no-op, not a duplicate-registration error), so this stays
// harmless while keeping PLUGINS a faithful, literal copy of
// EDITOR_SCHEMA_PLUGINS rather than a hand-filtered subset that could drift.
const PLUGINS = EDITOR_SCHEMA_PLUGINS.flat()

async function roundTrip(markdown: string): Promise<string> {
  const editor = await createTestEditor(markdown, PLUGINS)
  const result = editor.action(getMarkdown())
  await editor.destroy()
  return result
}

describe('Full node-set round trip (frontmatter + pagebreak + commonmark + gfm together)', () => {
  it('preserves frontmatter as a real, distinct YAML block, not a garbled heading', async () => {
    const source = readFileSync(join(CORPUS_DIR, 'short.md'), 'utf8')
    const output = await roundTrip(source)

    expect(output.startsWith('---\n')).toBe(true)
    expect(output).toContain('title: Short Reference Letter')
    // The exact failure Phase 1 Gate 1 found without a frontmatter node:
    // the closing --- misread as a Setext heading underline, turning the
    // metadata into a garbled "## title: ..." heading. Confirm that does
    // NOT happen now.
    expect(output).not.toContain('## title:')
    expect(output).not.toMatch(/^-{3,}\s*\n\s*\n?title:.*\n-{3,}\n\n#/)
  })

  it('preserves a pagebreak marker with real round-trip semantics, not as inert text mangled by reflow', async () => {
    const source = readFileSync(join(CORPUS_DIR, 'raw-html.md'), 'utf8')
    const output = await roundTrip(source)

    expect(output).toContain('<!-- pagebreak -->')
  })

  it('normalizes an alternate \\newpage marker to the canonical pagebreak marker on save', async () => {
    const source = 'Before.\n\n\\newpage\n\nAfter.\n'
    const output = await roundTrip(source)

    expect(output).toContain('<!-- pagebreak -->')
    expect(output).not.toContain('\\newpage')
  })

  it('round-trips a document containing both frontmatter and a pagebreak together', async () => {
    const source = `---\ntitle: Combined Test\npage: Letter\n---\n\n# Heading\n\nBefore.\n\n<!-- pagebreak -->\n\nAfter.\n`
    const output = await roundTrip(source)

    expect(output.startsWith('---\n')).toBe(true)
    expect(output).toContain('title: Combined Test')
    expect(output).toContain('<!-- pagebreak -->')
    expect(output).toContain('Before.')
    expect(output).toContain('After.')
  })
})
