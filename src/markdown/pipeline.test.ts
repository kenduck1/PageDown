import { describe, it, expect } from 'vitest'
import { markdownToHtml } from './pipeline'

describe('markdownToHtml', () => {
  it('converts a simple paragraph with bold text to HTML', () => {
    const { html } = markdownToHtml('Hello **world**.')
    expect(html).toContain('<strong')
    expect(html).toContain('world')
  })
})
