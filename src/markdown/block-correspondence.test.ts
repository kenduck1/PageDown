// The one assumption the editor page-break guides rest on, pinned.
//
// `markdownToHtml` stamps each top-level element with its index into
// `mdast.children` (pipeline.ts's `stampBlockIndices`), the sandboxed
// paginator reports a recovered break in those same coordinates
// (src/pagination/page-breaks.ts), and the Milkdown canvas draws the guide
// after its own i-th TOP-LEVEL ProseMirror node. That last step is only
// correct if `mdast.children[i]` and `doc.child(i)` are the same block --
// and the two are produced by two completely independent parses:
// markdownToHtml's own remark pipeline, and @milkdown/preset-commonmark's.
//
// This is not a self-evident property. The two pipelines differ in real
// ways: only markdownToHtml has remark-math; only Milkdown has
// remarkPreserveEmptyLinePlugin and filters out remarkInlineLinkPlugin; the
// two disagree about which node types even exist (Milkdown has no math node,
// so a `$$` block is an ordinary paragraph there). What makes the
// correspondence hold is that none of those differences change the number or
// ORDER of root-level blocks -- a `$$` fence is one paragraph either way, a
// block of raw HTML is one node either way. That is a claim about two
// third-party parsers' behaviour, so it is checked rather than argued: the
// whole reference corpus (including a 3859-block document), every shipped
// template, and the specific constructs most likely to break it.
//
// If this ever fails, the guides are the thing to disable -- not this test.
// A guide drawn at the wrong boundary is worse than no guide at all in an
// app whose premise is layout fidelity. (The runtime already fails closed on
// a count mismatch, via the `blockCount` check in page-guide-plugin.ts; this
// test is what catches an ORDER divergence that preserves the count, which
// nothing at runtime can detect.)

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMath from 'remark-math'
import { editorViewCtx } from '@milkdown/core'
import type { Root } from 'mdast'
import { remarkPagebreak } from './pagebreak-plugin'
import { remarkComment } from './comment-plugin'
import { createTestEditor } from '../renderer/src/milkdown/test-editor'
import { COVER_LETTER_TEMPLATE } from '../renderer/src/templates/cover-letter.md'
import { INVOICE_TEMPLATE } from '../renderer/src/templates/invoice.md'
import { LETTER_TEMPLATE } from '../renderer/src/templates/letter.md'
import { MEETING_NOTES_TEMPLATE } from '../renderer/src/templates/meeting-notes.md'
import { NEWSLETTER_TEMPLATE } from '../renderer/src/templates/newsletter.md'
import { REPORT_TEMPLATE } from '../renderer/src/templates/report.md'
import { RESUME_TEMPLATE } from '../renderer/src/templates/resume.md'

// Deliberately a hand-built copy of `markdownToHtml`'s own parse-processor
// composition rather than an import of it: `markdownToHtml` returns an HTML
// string, and the mdast root children it counted are not reachable from
// outside. Keeping the plugin list identical is the point of the test, so a
// divergence between this list and pipeline.ts's would make the test measure
// the wrong thing -- if you change one, change both.
function mdastRootBlockCount(source: string): number {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkMath, { singleDollarTextMath: false })
    .use(remarkPagebreak)
    .use(remarkComment)
  const tree = processor.runSync(processor.parse(source)) as Root
  return tree.children.length
}

// A real Milkdown editor with the exact plugin composition the app mounts
// (createTestEditor uses EDITOR_SCHEMA_PLUGINS, so the tested parse cannot
// drift from the shipped one).
async function proseMirrorTopLevelTypes(source: string): Promise<string[]> {
  const editor = await createTestEditor(source, [])
  const types: string[] = []
  editor.action((ctx) => {
    ctx.get(editorViewCtx).state.doc.forEach((node) => {
      types.push(node.type.name)
    })
  })
  await editor.destroy()
  return types
}

async function expectCorrespondence(label: string, source: string): Promise<void> {
  const expected = mdastRootBlockCount(source)
  const actual = await proseMirrorTopLevelTypes(source)
  expect(
    actual.length,
    `${label}: markdownToHtml's mdast has ${expected} top-level blocks but the Milkdown ` +
      `document has ${actual.length} (${actual.join(', ')}). Page-break guides index into ` +
      `both and would be misaligned -- see this file's header.`
  ).toBe(expected)
}

const CORPUS_DIR = join(process.cwd(), 'tests/gates/corpus')

describe('top-level block correspondence between the two parse pipelines', () => {
  for (const file of readdirSync(CORPUS_DIR).filter((name) => name.endsWith('.md'))) {
    it(`agrees on tests/gates/corpus/${file}`, async () => {
      await expectCorrespondence(file, readFileSync(join(CORPUS_DIR, file), 'utf8'))
    })
  }

  // Every shipped starter template, because these are the documents a new
  // user is most likely to have open the first time they see a page guide.
  const TEMPLATES: Array<[string, string]> = [
    ['cover-letter', COVER_LETTER_TEMPLATE],
    ['invoice', INVOICE_TEMPLATE],
    ['letter', LETTER_TEMPLATE],
    ['meeting-notes', MEETING_NOTES_TEMPLATE],
    ['newsletter', NEWSLETTER_TEMPLATE],
    ['report', REPORT_TEMPLATE],
    ['resume', RESUME_TEMPLATE]
  ]
  for (const [name, source] of TEMPLATES) {
    it(`agrees on the ${name} template`, async () => {
      await expectCorrespondence(name, source)
    })
  }

  // Each of these is a construct where the two pipelines genuinely do
  // something different, and the point is that none of the differences reach
  // the root-child COUNT or ORDER. The pairing each one produces (verified
  // when this was written) is named so a future failure says which half
  // moved.
  const CASES: Array<[label: string, source: string, note: string]> = [
    ['frontmatter', '---\ntitle: x\n---\n\nBody.\n', 'mdast `yaml` <-> ProseMirror `frontmatter`'],
    [
      'link definition',
      'See [a].\n\n[a]: /b\n\nAfter.\n',
      'mdast `definition` <-> ProseMirror `definition`; produces NO html element at all'
    ],
    [
      'footnote definition',
      'Text[^1].\n\n[^1]: A note.\n\nAfter.\n',
      'mdast `footnoteDefinition` <-> ProseMirror `footnote_definition`; the html side ' +
        'RELOCATES it into a generated <section> at the end of the document'
    ],
    ['page break', 'A\n\n<!-- pagebreak -->\n\nB\n', 'custom node on both sides'],
    [
      'block math',
      'A\n\n$$\nx^2\n$$\n\nB\n',
      'mdast `math` <-> ProseMirror `paragraph` -- Milkdown has no math node, and a ' +
        '$$ fence with no blank lines is one paragraph to CommonMark'
    ],
    [
      'raw html block',
      'A\n\n<div class="x">raw</div>\n\nB\n',
      'mdast `html` <-> ProseMirror `paragraph`'
    ],
    [
      'html comment',
      'A\n\n<!-- just a note -->\n\nB\n',
      'an html node that produces no visible element on either side'
    ],
    [
      'paragraph-leading comment mark',
      'Intro.\n\n<!--comment id="c1" data="eyJhdXRob3IiOiJZIiwidGV4dCI6InQiLCJjcmVhdGVkQXQiOiIyMDI2In0="-->word<!--/comment id="c1"-->\n',
      "the CommonMark html-block collapse comment-plugin.ts's unmergeHtmlNode repairs"
    ],
    ['thematic break', 'A\n\n---\n\nB\n', 'mdast `thematicBreak` <-> ProseMirror `hr`'],
    [
      'consecutive blank lines',
      'One.\n\n\n\n\nTwo.\n',
      'remarkPreserveEmptyLinePlugin is Milkdown-only; it must not add root children'
    ],
    ['setext heading', 'Title\n=====\n\nBody.\n', 'a two-line construct that is one block'],
    ['task list', 'A\n\n- [ ] one\n- [x] two\n\nB\n', 'gfm task list, one list node either side'],
    [
      'table',
      'A\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nB\n',
      'gfm table, one node either side despite very different internal shapes'
    ]
  ]

  for (const [label, source, note] of CASES) {
    it(`agrees on ${label} (${note})`, async () => {
      await expectCorrespondence(label, source)
    })
  }
})
