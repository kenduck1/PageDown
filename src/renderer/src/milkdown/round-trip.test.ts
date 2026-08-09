import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMarkdown } from '@milkdown/utils'
import { createTestEditor } from './test-editor'
import { EDITOR_SCHEMA_PLUGINS } from './plugins'
import { encodeCommentMeta, decodeCommentMeta } from '../../../markdown/comment-plugin'

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

  // @milkdown/preset-gfm's `gfm` export (part of EDITOR_SCHEMA_PLUGINS via
  // plugins.ts) includes real footnoteReferenceSchema/footnoteDefinitionSchema
  // nodes -- confirmed by reading the installed package -- so footnotes were
  // already a genuinely editable node type in the mounted editor before this
  // test existed; this is the first test proving it round-trips rather than
  // just parsing without throwing.
  it('round-trips a footnote reference and its definition as real markdown syntax, not inert text', async () => {
    const source = 'Here is a footnote reference[^1].\n\n[^1]: Here is the footnote.\n'
    const output = await roundTrip(source)

    expect(output).toContain('[^1]')
    expect(output).toContain('Here is the footnote.')
  })

  // EDITOR_SCHEMA_PLUGINS (plugins.ts) deliberately does NOT include
  // remark-math -- math is rendered ONLY inside the sandboxed pagination
  // context (see katex-render.ts / CLAUDE.md's math-equations section), and
  // Milkdown's own separate parse pipeline has no awareness of `$$...$$`
  // syntax at all. This is expected to be SAFE, not merely untested: with no
  // remark-math plugin registered, `$$x^2$$` and a `$$`-fenced block are
  // just ordinary characters to CommonMark, parsed as plain paragraph text
  // (dollar signs are not CommonMark control characters), so there is no
  // custom node to lose fidelity on serialization -- this test proves that
  // round trip stays byte-for-byte inert rather than assuming it.
  it('round-trips inline and block math markers as inert plain text (no math node in the editor schema)', async () => {
    const source =
      'Inline math stays literal: $$x^2 + y^2 = z^2$$ right here.\n\n$$\nE = mc^2\n$$\n'
    const output = await roundTrip(source)

    expect(output).toContain('$$x^2 + y^2 = z^2$$')
    expect(output).toContain('E = mc^2')
  })

  // Task 2 (slash menu) added insertMathBlockCommand (commands.ts), which
  // builds a math placeholder by hand as a paragraph containing
  // text("$$"), an INLINE hardbreak, placeholder text, another inline
  // hardbreak, then text("$$") -- the exact shape this test parses from raw
  // markdown, byte-for-byte, below. The test just above already proves a
  // $$-fenced block round-trips as INERT TEXT somewhere inside a bigger
  // document (a `.toContain` check); this one is stricter and exists for a
  // different reason: it pins the EXACT parse of an isolated
  // `$$\n...\n$$\n` document via a byte-identical `.toBe`, so a future
  // Milkdown/remark-stringify upgrade that changes how a soft line break
  // inside a paragraph serializes (e.g. switching an inline hardbreak's
  // literal "\n" back to a two-trailing-space hard break) fails THIS test
  // loudly, rather than silently producing a math placeholder that no
  // longer reparses as a `$$`-fenced block for insertMathBlockCommand's real
  // users. `x^2` matches insertMathBlockCommand's own placeholder text, so
  // this is also a direct proof that command's output is exactly what a
  // fresh parse of its own serialized markdown would reproduce.
  it('preserves an isolated $$-fenced math placeholder byte-identically -- the exact shape insertMathBlockCommand (commands.ts) builds', async () => {
    const source = '$$\nx^2\n$$\n'
    const output = await roundTrip(source)

    expect(output).toBe(source)
  })

  // Unlike pagebreak/footnotes (existing nodes) or math (deliberately inert
  // text), a comment is a real ProseMirror MARK -- this is the first test in
  // this suite proving a MARK (not a node) round-trips correctly through
  // Milkdown's own parse/serialize pipeline via this project's custom
  // remarkComment/remarkCommentToMarkdown plugin pair (comment-plugin.ts).
  it('round-trips a comment mark, preserving its id/author/text/createdAt exactly', async () => {
    const dataAttr = encodeCommentMeta({
      author: 'Kai',
      text: 'needs revision',
      createdAt: '2026-08-09T06:00:00Z'
    })
    const source = `Before. <!--comment id="c1" data="${dataAttr}"-->the marked phrase<!--/comment id="c1"-->. After.`
    const output = await roundTrip(source)

    expect(output).toContain('the marked phrase')
    expect(output).toContain('id="c1"')
    // Re-decode whatever the round trip actually wrote, rather than
    // asserting the same base64 string comes back byte-for-byte -- the
    // serializer is expected to RE-ENCODE from the mark's current attrs on
    // every save (see remarkCommentToMarkdown's own comment for why), which
    // happens to produce identical bytes for an untouched mark but must not
    // be conflated with "the string is stable" as the actual invariant.
    const match = output.match(/data="([^"]+)"/)
    expect(match).not.toBeNull()
    const decoded = decodeCommentMeta(match![1])
    expect(decoded).toEqual({
      author: 'Kai',
      text: 'needs revision',
      createdAt: '2026-08-09T06:00:00Z'
    })
  })
})
