import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOW_UI_STATE,
  coerceWindowUiState,
  menuRelevantStateChanged
} from './window-state'

describe('coerceWindowUiState', () => {
  it('passes a well-formed state through unchanged', () => {
    const state = { documentOpen: true, viewMode: 'split', fileName: 'report.md', isDirty: true }
    expect(coerceWindowUiState(state)).toEqual(state)
  })

  it('falls back to the default for a non-object payload', () => {
    expect(coerceWindowUiState(null)).toEqual(DEFAULT_WINDOW_UI_STATE)
    expect(coerceWindowUiState('editor')).toEqual(DEFAULT_WINDOW_UI_STATE)
    expect(coerceWindowUiState(undefined)).toEqual(DEFAULT_WINDOW_UI_STATE)
  })

  it('degrades PER FIELD rather than discarding the whole message', () => {
    // Same governing rule as preferences.ts's sanitizePreferences: one bad
    // field must not throw away three good ones.
    expect(
      coerceWindowUiState({ documentOpen: true, viewMode: 'nonsense', fileName: 7, isDirty: 'yes' })
    ).toEqual({ documentOpen: true, viewMode: 'format', fileName: null, isDirty: false })
  })

  it('rejects a non-string fileName, which would otherwise reach setTitle()', () => {
    // The concrete failure this guards: `win.setTitle(formatWindowTitle(...))`
    // with an object fileName puts a literal "[object Object]" in the OS
    // title bar rather than surfacing an error anywhere.
    expect(coerceWindowUiState({ fileName: { toString: () => 'x' } }).fileName).toBeNull()
  })
})

describe('menuRelevantStateChanged', () => {
  const base = { documentOpen: true, viewMode: 'format' as const, fileName: 'a.md', isDirty: false }

  it('is true when there was no previous state at all', () => {
    expect(menuRelevantStateChanged(undefined, base)).toBe(true)
  })

  it('is true when documentOpen or viewMode changed', () => {
    expect(menuRelevantStateChanged(base, { ...base, documentOpen: false })).toBe(true)
    expect(menuRelevantStateChanged(base, { ...base, viewMode: 'source' })).toBe(true)
  })

  it('is FALSE for a dirty flip or a filename change', () => {
    // The reason this predicate exists: isDirty flips on the first keystroke
    // after every save, and rebuilding the whole application menu for that
    // would be pure waste. Both still update the window TITLE -- that path
    // does not consult this function.
    expect(menuRelevantStateChanged(base, { ...base, isDirty: true })).toBe(false)
    expect(menuRelevantStateChanged(base, { ...base, fileName: 'b.md' })).toBe(false)
  })
})
