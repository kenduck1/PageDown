import { describe, it, expect } from 'vitest'
import { markdownToHtml } from '../../../markdown/pipeline'
import { RESUME_TEMPLATE } from './resume.md'
import { LETTER_TEMPLATE } from './letter.md'
import { REPORT_TEMPLATE } from './report.md'
import { COVER_LETTER_TEMPLATE } from './cover-letter.md'
import { MEETING_NOTES_TEMPLATE } from './meeting-notes.md'
import { INVOICE_TEMPLATE } from './invoice.md'
import { NEWSLETTER_TEMPLATE } from './newsletter.md'

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
