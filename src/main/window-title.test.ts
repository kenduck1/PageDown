import { describe, expect, it } from 'vitest'
import { APP_NAME, formatWindowTitle } from './window-title'
import { DEFAULT_WINDOW_UI_STATE } from '../menu/window-state'

describe('formatWindowTitle', () => {
  it('shows the app name alone when no document is on screen', () => {
    // Home and Settings. A "• Untitled — PageDown" title there would be
    // actively wrong: documentStore always keeps one blank tab alive, but the
    // user has not opened a document.
    expect(formatWindowTitle(DEFAULT_WINDOW_UI_STATE)).toBe('PageDown')
    expect(formatWindowTitle({ ...DEFAULT_WINDOW_UI_STATE, isDirty: true })).toBe('PageDown')
  })

  it('shows filename then app name for a clean document', () => {
    expect(
      formatWindowTitle({
        ...DEFAULT_WINDOW_UI_STATE,
        documentOpen: true,
        fileName: 'report.md'
      })
    ).toBe('report.md — PageDown')
  })

  it('prefixes a bullet for unsaved changes', () => {
    expect(
      formatWindowTitle({
        ...DEFAULT_WINDOW_UI_STATE,
        documentOpen: true,
        fileName: 'report.md',
        isDirty: true
      })
    ).toBe('• report.md — PageDown')
  })

  it('calls a never-saved document Untitled', () => {
    expect(
      formatWindowTitle({
        ...DEFAULT_WINDOW_UI_STATE,
        documentOpen: true,
        viewMode: 'source',
        isDirty: true
      })
    ).toBe('• Untitled — PageDown')
  })

  it('is unaffected by view mode', () => {
    // viewMode rides along in the same message purely because the MENU needs
    // it; the title must not move when the user switches Format/Split/Source.
    // Spread from the shared default rather than a hand-built literal, so a
    // new reported field does not break a title test that has nothing to do
    // with it.
    const base = { ...DEFAULT_WINDOW_UI_STATE, documentOpen: true, fileName: 'a.md' } as const
    expect(formatWindowTitle({ ...base, viewMode: 'format' })).toBe(
      formatWindowTitle({ ...base, viewMode: 'split' })
    )
  })

  it('exports the product name rather than deriving it from package.json', () => {
    // app.getName() returns "pagedown" in development and "PageDown" only
    // once packaged -- see APP_NAME's own comment. This pins the user-facing
    // spelling.
    expect(APP_NAME).toBe('PageDown')
  })
})
