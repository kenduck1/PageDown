import { describe, it, expect } from 'vitest'
import { getMarkdown } from '@milkdown/utils'
import { markdownToHtml } from '../../../markdown/pipeline'
import { createTestEditor } from '../milkdown/test-editor'
import { EDITOR_SCHEMA_PLUGINS } from '../milkdown/plugins'
import { RESUME_TEMPLATE } from './resume.md'
import { LETTER_TEMPLATE } from './letter.md'
import { REPORT_TEMPLATE } from './report.md'
import { COVER_LETTER_TEMPLATE } from './cover-letter.md'
import { MEETING_NOTES_TEMPLATE } from './meeting-notes.md'
import { INVOICE_TEMPLATE } from './invoice.md'
import { NEWSLETTER_TEMPLATE } from './newsletter.md'

// Same composition MilkdownEditor.tsx actually mounts -- see plugins.ts's own
// comment and round-trip.test.ts's precedent for why this must stay a
// literal copy of EDITOR_SCHEMA_PLUGINS rather than a hand-filtered subset.
const PLUGINS = EDITOR_SCHEMA_PLUGINS.flat()

async function roundTrip(markdown: string): Promise<string> {
  const editor = await createTestEditor(markdown, PLUGINS)
  const result = editor.action(getMarkdown())
  await editor.destroy()
  return result
}

describe('template starter content', () => {
  it.each([
    ['resume', RESUME_TEMPLATE],
    ['letter', LETTER_TEMPLATE],
    ['report', REPORT_TEMPLATE],
    ['cover letter', COVER_LETTER_TEMPLATE],
    ['meeting notes', MEETING_NOTES_TEMPLATE],
    ['invoice', INVOICE_TEMPLATE],
    ['newsletter', NEWSLETTER_TEMPLATE]
  ])('%s template parses without throwing and produces non-empty HTML', (_name, template) => {
    expect(() => markdownToHtml(template)).not.toThrow()
    const { html } = markdownToHtml(template)
    expect(html.length).toBeGreaterThan(0)
  })

  it('resume template has YAML frontmatter', () => {
    expect(RESUME_TEMPLATE.trimStart()).toMatch(/^---\n/)
  })

  it('report template contains a GFM table', () => {
    expect(REPORT_TEMPLATE).toMatch(/\|.*\|.*\|/)
    expect(REPORT_TEMPLATE).toMatch(/\|\s*-+\s*\|/)
  })

  it('invoice template contains a GFM table of line items', () => {
    expect(INVOICE_TEMPLATE).toMatch(/\|.*\|.*\|/)
    expect(INVOICE_TEMPLATE).toMatch(/\|\s*-+\s*\|/)
  })

  it('meeting notes template contains real GFM task list items, checked and unchecked', () => {
    const { html } = markdownToHtml(MEETING_NOTES_TEMPLATE)
    expect(html).toContain('<input type="checkbox" disabled>')
    expect(html).toContain('<input type="checkbox" checked disabled>')
  })

  it('cover letter template is distinct starter content from the existing letter template', () => {
    expect(COVER_LETTER_TEMPLATE).not.toBe(LETTER_TEMPLATE)
  })
})

// A design recon measured that most of these templates weren't in
// PageDown's own canonical Markdown form -- a user creates a document from
// one, types one character, and Milkdown's serializer silently reformats
// the whole file on the next flush. These templates' shipped bytes are now
// deliberately authored to already match what createTestEditor +
// EDITOR_SCHEMA_PLUGINS.flat() + getMarkdown() produces, so this asserts
// that stays true rather than only hoping it does. meeting-notes and
// newsletter are deliberately excluded here -- see the comment at the top
// of each of those two files for why (a known Milkdown list `spread`
// fidelity gap, not a defect in the template content).
describe('template starter content round-trips byte-identically through Milkdown', () => {
  it.each([
    ['resume', RESUME_TEMPLATE],
    ['letter', LETTER_TEMPLATE],
    ['report', REPORT_TEMPLATE],
    ['cover letter', COVER_LETTER_TEMPLATE],
    ['invoice', INVOICE_TEMPLATE]
  ])('%s template is already in canonical Milkdown-serialized form', async (_name, template) => {
    const output = await roundTrip(template)
    expect(output).toBe(template)
  })
})
