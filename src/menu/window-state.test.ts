import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOW_UI_STATE,
  coerceWindowUiState,
  menuRelevantStateChanged
} from './window-state'

describe('coerceWindowUiState', () => {
  it('passes a well-formed state through unchanged', () => {
    const state = {
      documentOpen: true,
      viewMode: 'split',
      // Both of these became WindowUiState fields when the single-row-toolbar
      // pass moved the Split left-pane pills and the Follow pill out of
      // EditorToolbar and into View > Split Left Pane / View > Follow Preview
      // Scroll -- the menu is now the only surface either one has, so it has
      // to be able to render their live state.
      splitLeftMode: 'source',
      splitFollowEnabled: false,
      fileName: 'report.md',
      isDirty: true,
      openFilePaths: ['/tmp/docs/report.md', '/tmp/docs/notes.md']
    }
    expect(coerceWindowUiState(state)).toEqual(state)
  })

  it('validates splitLeftMode against the real union and splitFollowEnabled as a boolean', () => {
    // Same reasoning as viewMode's own allowlist immediately below: these
    // arrive over IPC as untyped data, and splitLeftMode reaches a menu radio
    // group's `checked` computation, where an out-of-union string would leave
    // NEITHER item checked -- a menu silently reporting a state the window is
    // not in.
    expect(coerceWindowUiState({ splitLeftMode: 'split' }).splitLeftMode).toBe('format')
    expect(coerceWindowUiState({ splitLeftMode: 7 }).splitLeftMode).toBe('format')
    expect(coerceWindowUiState({ splitLeftMode: 'source' }).splitLeftMode).toBe('source')
    expect(coerceWindowUiState({ splitFollowEnabled: 'no' }).splitFollowEnabled).toBe(true)
    expect(coerceWindowUiState({ splitFollowEnabled: false }).splitFollowEnabled).toBe(false)
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
    ).toEqual({
      documentOpen: true,
      viewMode: 'format',
      splitLeftMode: 'format',
      splitFollowEnabled: true,
      fileName: null,
      isDirty: false,
      openFilePaths: []
    })
  })

  it('rejects a non-string fileName, which would otherwise reach setTitle()', () => {
    // The concrete failure this guards: `win.setTitle(formatWindowTitle(...))`
    // with an object fileName puts a literal "[object Object]" in the OS
    // title bar rather than surfacing an error anywhere.
    expect(coerceWindowUiState({ fileName: { toString: () => 'x' } }).fileName).toBeNull()
  })

  describe('openFilePaths', () => {
    // This field decides which WINDOW an OS file-open request is routed to, so
    // a malformed entry must not be able to make a path "match" something it
    // isn't -- and a malformed message must not be able to make the main
    // process retain unbounded per-window state.
    it('drops non-string and empty entries rather than the whole array', () => {
      expect(
        coerceWindowUiState({ openFilePaths: ['/a.md', 7, null, '', '/b.md'] }).openFilePaths
      ).toEqual(['/a.md', '/b.md'])
    })

    it('degrades a non-array to an empty list', () => {
      // Empty is the SAFE degradation: it means "this window is showing
      // nothing I can route to", so the request falls back to opening a new
      // window rather than focusing a wrong one.
      expect(coerceWindowUiState({ openFilePaths: '/a.md' }).openFilePaths).toEqual([])
      expect(coerceWindowUiState({}).openFilePaths).toEqual([])
    })

    it('caps how many paths one window can make the main process retain', () => {
      const many = Array.from({ length: 200 }, (_, i) => `/doc-${i}.md`)
      expect(coerceWindowUiState({ openFilePaths: many }).openFilePaths).toHaveLength(64)
    })

    it('does not hand out DEFAULT_WINDOW_UI_STATE own array', () => {
      // That constant is exported and handed out as a whole state elsewhere;
      // sharing one mutable array across every coerced message is a trap.
      const coerced = coerceWindowUiState({})
      expect(coerced.openFilePaths).not.toBe(DEFAULT_WINDOW_UI_STATE.openFilePaths)
    })
  })
})

describe('menuRelevantStateChanged', () => {
  const base = {
    documentOpen: true,
    viewMode: 'format' as const,
    splitLeftMode: 'format' as const,
    splitFollowEnabled: true,
    fileName: 'a.md',
    isDirty: false
  }

  it('is true when there was no previous state at all', () => {
    expect(menuRelevantStateChanged(undefined, base)).toBe(true)
  })

  it('is true when documentOpen or viewMode changed', () => {
    expect(menuRelevantStateChanged(base, { ...base, documentOpen: false })).toBe(true)
    expect(menuRelevantStateChanged(base, { ...base, viewMode: 'source' })).toBe(true)
  })

  it('is true when splitLeftMode or splitFollowEnabled changed', () => {
    // Not merely "more fields is more correct": both render as live menu
    // state (a radio checkmark, a checkbox), and they are now the ONLY
    // surface either control has. A change that did not rebuild the menu
    // would leave it reporting a state the window is not in.
    expect(menuRelevantStateChanged(base, { ...base, splitLeftMode: 'source' })).toBe(true)
    expect(menuRelevantStateChanged(base, { ...base, splitFollowEnabled: false })).toBe(true)
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
