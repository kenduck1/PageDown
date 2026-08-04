import { describe, it, expect } from 'vitest'
import { markdownToHtml } from '../../../markdown/pipeline'
import { RESUME_TEMPLATE } from './resume.md'
import { LETTER_TEMPLATE } from './letter.md'
import { REPORT_TEMPLATE } from './report.md'

describe('template starter content', () => {
  it.each([
    ['resume', RESUME_TEMPLATE],
    ['letter', LETTER_TEMPLATE],
    ['report', REPORT_TEMPLATE]
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
})
