import { describe, it, expect } from 'vitest'
import { extractMarkdownPathFromArgv, looksLikeMarkdownPath } from './open-file-args'

describe('extractMarkdownPathFromArgv', () => {
  it('finds a trailing .md path after the executable', () => {
    expect(
      extractMarkdownPathFromArgv(['/Applications/PageDown.app/pagedown', '/Users/x/report.md'])
    ).toBe('/Users/x/report.md')
  })

  it('finds a trailing .markdown path too', () => {
    expect(extractMarkdownPathFromArgv(['pagedown.exe', 'C:\\docs\\notes.markdown'])).toBe(
      'C:\\docs\\notes.markdown'
    )
  })

  it('matches the extension case-insensitively', () => {
    expect(extractMarkdownPathFromArgv(['pagedown.exe', 'C:\\docs\\NOTES.MD'])).toBe(
      'C:\\docs\\NOTES.MD'
    )
  })

  it('skips flags (anything starting with "-"), even ones ending in .md', () => {
    expect(
      extractMarkdownPathFromArgv(['pagedown.exe', '--not-a-real-flag.md', '/Users/x/report.md'])
    ).toBe('/Users/x/report.md')
  })

  it('skips Electron/Chromium switches inserted ahead of the real document path', () => {
    expect(
      extractMarkdownPathFromArgv([
        'pagedown.exe',
        '--user-data-dir=/tmp/x',
        '--no-sandbox',
        '/Users/x/report.md'
      ])
    ).toBe('/Users/x/report.md')
  })

  it('never returns argv[0] itself, even if it ends in .md', () => {
    expect(extractMarkdownPathFromArgv(['/Users/x/pagedown.md'])).toBeUndefined()
  })

  it('returns undefined for a plain launch with no document argument', () => {
    expect(extractMarkdownPathFromArgv(['pagedown.exe'])).toBeUndefined()
    expect(extractMarkdownPathFromArgv(['electron', '.'])).toBeUndefined()
  })

  it('returns undefined for an empty argv', () => {
    expect(extractMarkdownPathFromArgv([])).toBeUndefined()
  })

  it('does not match a non-Markdown trailing argument', () => {
    expect(extractMarkdownPathFromArgv(['pagedown.exe', '/Users/x/photo.png'])).toBeUndefined()
  })

  it('picks the LAST matching argument when more than one is present', () => {
    expect(
      extractMarkdownPathFromArgv(['pagedown.exe', '/Users/x/first.md', '/Users/x/second.md'])
    ).toBe('/Users/x/second.md')
  })
})

describe('looksLikeMarkdownPath', () => {
  it('accepts .md and .markdown, case-insensitively', () => {
    expect(looksLikeMarkdownPath('/Users/x/report.md')).toBe(true)
    expect(looksLikeMarkdownPath('/Users/x/report.MARKDOWN')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(looksLikeMarkdownPath('/Users/x/report.txt')).toBe(false)
    expect(looksLikeMarkdownPath('/Users/x/report')).toBe(false)
  })
})
