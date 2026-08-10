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
// against createTestEditor's MilkdownPlugin[] parameter. This list is now
// also exactly what createTestEditor's own builder mounts as its base (that
// base used to be a bare commonmark + gfm; see test-editor.ts for why it had
// to become EDITOR_SCHEMA_PLUGINS once reference-link support started
// REMOVING a plugin from the commonmark preset), so passing it again here is
// redundant -- kept anyway because Milkdown's `.use()` is idempotent per
// plugin instance and because naming the composition at the call site is
// what makes this file's subject explicit.
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

  // DELIBERATE INVERSION of what this test used to assert (it pinned
  // `\newpage` -> `<!-- pagebreak -->`). Normalizing an alternate marker
  // rewrote the user's PROSE, not its formatting: a Pandoc/LaTeX tutorial
  // whose bare `\newpage` paragraph documents the command rather than
  // invoking it had that paragraph silently and irreversibly changed on the
  // next Format-mode save. `Pagebreak#raw` (src/markdown/pagebreak-plugin.ts)
  // now records the matched literal and the serializer emits it back, so the
  // marker survives as itself while still paginating. See that field's
  // comment, and the equivalent inverted block in pagebreak-plugin.test.ts.
  it('preserves an alternate \\newpage marker verbatim through a Format-mode round trip', async () => {
    const source = 'Before.\n\n\\newpage\n\nAfter.\n'
    const output = await roundTrip(source)

    expect(output).toBe(source)
    expect(output).not.toContain('<!-- pagebreak -->')
  })

  it('preserves the page-break-after div convention verbatim too', async () => {
    const source = 'Before.\n\n<div style="page-break-after: always;"></div>\n\nAfter.\n'
    const output = await roundTrip(source)

    expect(output).toBe(source)
  })

  // Reference-style links: a linkReference plus its definition used to come
  // back with the link INLINED and the definition block DELETED -- semantics
  // preserved, syntax destroyed. See nodes/reference.ts for the root cause
  // (@milkdown/preset-commonmark's own remarkInlineLinkPlugin) and the
  // modelling rationale.
  it('round-trips a full reference link and its definition byte-identically', async () => {
    const source =
      'According to the [primary source][1], results were consistent.\n\n[1]: https://example.com/primary "Primary Source"\n'
    const output = await roundTrip(source)

    expect(output).toBe(source)
  })

  it('round-trips collapsed and shortcut reference forms without expanding them', async () => {
    const source =
      'A [collapsed][] and a [shortcut] reference.\n\n[collapsed]: /a\n\n[shortcut]: /b\n'
    const output = await roundTrip(source)

    expect(output).toBe(source)
  })

  it('round-trips a reference-style image', async () => {
    const source = 'Here: ![The logo][logo]\n\n[logo]: ./logo.png "Logo"\n'
    const output = await roundTrip(source)

    expect(output).toBe(source)
  })

  // Proves the reference link is a MARK carrying real inline content, not an
  // atom with a flattened text attr -- the nested emphasis survives AND the
  // link stays one link rather than splitting at the mark boundary. That
  // second half is link-mark-priority-fix.ts's doing; the inline-link control
  // right below it is what makes this a statement about both, since the two
  // marks must behave identically.
  it('keeps emphasis nested inside a reference link, as one reference', async () => {
    const source = 'See the [_emphatic_ source][1] here.\n\n[1]: https://example.com\n'
    const output = await roundTrip(source)

    expect(output).toBe(source)
  })

  it('keeps emphasis nested inside an ordinary inline link, as one link', async () => {
    const source = 'See the [_emphatic_ source](https://example.com) here.\n'
    const output = await roundTrip(source)

    expect(output).toBe(source)
  })

  // The other nesting direction, which the priority fix must NOT invert:
  // here the emphasis opens BEFORE the link and has to stay outermost.
  // SerializerState#orderMarks puts already-continuing marks ahead of
  // priority, which is what makes both directions work at once.
  it('keeps a link nested inside a longer emphasis run, not the other way round', async () => {
    const source = '_Emphasis with a [link](https://example.com) inside_ it.\n'
    const output = await roundTrip(source)

    expect(output).toBe(source)
  })

  // GFM task lists share the 'list_item' node id with the plain list item,
  // via @milkdown/preset-gfm's own extendSchema. list-spread-fix.ts overrides
  // that same id, and an early version of it chained off the COMMONMARK
  // original instead of the gfm one -- silently replacing gfm's version and
  // serializing every `- [ ] task` back as a plain `- task`, i.e. real data
  // loss. This pins both the checkbox state and the tightness together.
  it('round-trips a tight GFM task list with its checked state intact', async () => {
    const source = '- [ ] alpha\n- [x] beta\n- [ ] gamma\n'
    const output = await roundTrip(source)

    expect(output).toBe(source)
  })

  it('preserves reference links and definitions in the corpus fixture', async () => {
    const source = readFileSync(join(CORPUS_DIR, 'reference-links-and-footnotes.md'), 'utf8')
    const output = await roundTrip(source)

    // Deliberately NOT a byte-identity assertion, and the reason is not the
    // reference machinery: this fixture writes its two definitions on
    // adjacent lines, and plain remark-stringify -- with no Milkdown involved
    // at all, verified directly against `unified().use(remarkParse).use(
    // remarkStringify)` -- separates consecutive definitions with a blank
    // line. So the fixture simply is not in canonical form, and demanding
    // byte identity here would pin remark's block-separation policy rather
    // than anything this sub-project changed. What the fixture is FOR is
    // asserted instead: both references stay references and both definitions
    // survive, where before this landed the references were inlined and the
    // definition blocks deleted outright.
    expect(output).toContain('[primary source][1]')
    expect(output).toContain('[secondary source][2]')
    expect(output).toContain('[1]: https://example.com/primary "Primary Source"')
    expect(output).toContain('[2]: https://example.com/secondary "Secondary Source"')
    expect(output).not.toContain('](https://example.com/primary)')

    // Idempotency: whatever canonical form it lands in is STABLE, so a second
    // edit does not churn the file again.
    expect(await roundTrip(output)).toBe(output)
  })

  // List tightness (mdast `spread`). A tight list came back loose -- a blank
  // line inserted between every item -- which is why two of this app's own
  // shipped templates carried a "deliberately not byte-canonical" header
  // comment until this landed. See list-spread-fix.ts for the string-vs-
  // boolean root cause.
  it('keeps a tight bullet list tight', async () => {
    const source = '- alpha\n- beta\n- gamma\n'
    const output = await roundTrip(source)

    expect(output).toBe(source)
  })

  it('keeps a tight ordered list tight', async () => {
    const source = '1. alpha\n2. beta\n3. gamma\n'
    const output = await roundTrip(source)

    expect(output).toBe(source)
  })

  it('keeps a genuinely LOOSE list loose -- the fix preserves spread, it does not force tightness', async () => {
    const source = '- alpha\n\n- beta\n\n- gamma\n'
    const output = await roundTrip(source)

    expect(output).toBe(source)
  })

  it('keeps a tight nested list tight at both levels', async () => {
    const source = '- alpha\n  - nested one\n  - nested two\n- beta\n'
    const output = await roundTrip(source)

    expect(output).toBe(source)
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
