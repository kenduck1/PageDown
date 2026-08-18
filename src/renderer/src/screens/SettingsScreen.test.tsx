import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SettingsScreen from './SettingsScreen'
import { useAppStore, initialAppState } from '../store/appStore'
import { usePreferencesStore } from '../store/preferencesStore'

const REAL_PREFERENCES = {
  spellcheckEnabled: true,
  autosaveIntervalMs: 45_000,
  defaultPageConfig: {
    pageSize: 'Letter' as const,
    orientation: 'portrait' as const,
    theme: 'default' as const,
    fontFamily: 'source-serif-4' as const
  },
  colorScheme: 'system' as const,
  authorName: ''
}

beforeEach(() => {
  useAppStore.setState({ ...initialAppState, screen: 'settings' })
  usePreferencesStore.setState({ preferences: null, loaded: false })
  window.api = {
    openFile: vi.fn(),
    openPath: vi.fn(),
    saveFile: vi.fn(),
    getRecentFiles: vi.fn(),
    removeRecentFile: vi.fn(),
    clearRecentFiles: vi.fn(),
    getThumbnail: vi.fn(),
    getTemplateThumbnail: vi.fn(),
    getPageCount: vi.fn(),
    confirmDiscardChanges: vi.fn(),
    exportPdf: vi.fn(),
    exportHtml: vi.fn(),
    exportDocx: vi.fn(),
    showItemInFolder: vi.fn(),
    print: vi.fn(),
    getPreferences: vi.fn(),
    setPreferences: vi.fn().mockResolvedValue(undefined),
    autosaveSnapshot: vi.fn(),
    getVersionHistory: vi.fn(),
    restoreVersionContent: vi.fn(),
    clearPendingAutosave: vi.fn(),
    // Crash protection for never-saved documents. Required (not optional) on
    // FileApi, so a missing entry here is a compile error rather than a
    // runtime surprise -- see index.d.ts for why that tradeoff was taken.
    autosaveUnsavedDraft: vi.fn().mockResolvedValue(null),
    listUnsavedDrafts: vi.fn().mockResolvedValue([]),
    readUnsavedDraft: vi.fn().mockResolvedValue(null),
    discardUnsavedDraft: vi.fn().mockResolvedValue(undefined),
    setSplitPreviewBounds: vi.fn(),
    sendSplitPreviewDocument: vi.fn(),
    destroySplitPreview: vi.fn(),
    scrollSplitPreviewToPage: vi.fn(),
    getSplitPreviewPage: vi.fn(),
    saveDroppedImage: vi.fn(),
    openInNewWindow: vi.fn(),
    // The application menu's two channels. Both are stubbed in every
    // window.api fixture because window.api is a fully-typed FileApi here --
    // a missing method is a compile error, not just a runtime one.
    // onMenuCommand must return a real unsubscribe FUNCTION: App.tsx and
    // EditorScreen both call it from an effect cleanup, and a bare vi.fn()
    // returning undefined would throw on unmount.
    onMenuCommand: vi.fn().mockReturnValue(() => {}),
    setWindowState: vi.fn(),
    // Preferences broadcast (multi-window): a real unsubscribe function,
    // same contract as the other push channels here.
    onPreferencesChanged: vi.fn().mockReturnValue(() => {}),
    // The window-close guard's two channels. onWindowCloseRequest must
    // return a real unsubscribe FUNCTION -- App.tsx calls it from an effect
    // cleanup, same contract as onMenuCommand above.
    onWindowCloseRequest: vi.fn().mockReturnValue(() => {}),
    respondToWindowClose: vi.fn(),
    getStartupWarnings: vi.fn().mockResolvedValue([]),
    getAppVersion: vi.fn().mockResolvedValue('1.0.0'),
    // In-app auto-update. onUpdateState must return a real unsubscribe
    // FUNCTION -- UpdateBanner calls it from an effect cleanup, same
    // contract (and same reason) as onMenuCommand above.
    onUpdateState: vi.fn().mockReturnValue(() => {}),
    getUpdateState: vi
      .fn()
      .mockResolvedValue({ status: 'idle', version: null, manual: false, dismissed: false }),
    installUpdate: vi.fn().mockResolvedValue(false),
    dismissUpdateNotice: vi.fn().mockResolvedValue(undefined),
    resolveLocalImage: vi.fn()
  }
})

afterEach(() => {
  cleanup()
})

describe('SettingsScreen', () => {
  it('renders a real placeholder (not "Coming soon") while preferences have not loaded yet', () => {
    render(<SettingsScreen />)
    // App.tsx's own getPreferences() call may not have resolved by the time
    // a user navigates here -- this is a real, reachable state, not a
    // "shouldn't happen" case, so it gets a genuine (if minimal) screen
    // rather than the old permanent stub.
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('navigates back to Home on "← Home" click, even before preferences load', async () => {
    const user = userEvent.setup()
    render(<SettingsScreen />)
    await user.click(screen.getByRole('button', { name: '← Home' }))
    expect(useAppStore.getState().screen).toBe('home')
  })

  it('renders the real preference values once loaded', () => {
    usePreferencesStore.setState({ preferences: REAL_PREFERENCES, loaded: true })
    render(<SettingsScreen />)

    expect(screen.getByRole('checkbox', { name: 'Spell check' })).toBeChecked()
    expect(screen.getByRole('spinbutton', { name: /autosave interval/i })).toHaveValue(45)
    expect(screen.getByRole('combobox', { name: 'Page size' })).toHaveValue('Letter')
    expect(screen.getByRole('combobox', { name: 'Orientation' })).toHaveValue('portrait')
    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveValue('default')
    expect(screen.getByRole('combobox', { name: 'Font' })).toHaveValue('source-serif-4')
  })

  it('toggling spell check calls window.api.setPreferences with the new value, immediately', async () => {
    usePreferencesStore.setState({ preferences: REAL_PREFERENCES, loaded: true })
    const user = userEvent.setup()
    render(<SettingsScreen />)

    await user.click(screen.getByRole('checkbox', { name: 'Spell check' }))

    expect(window.api.setPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ spellcheckEnabled: false })
    )
    expect(usePreferencesStore.getState().preferences?.spellcheckEnabled).toBe(false)
  })

  it('changing the autosave interval converts seconds to milliseconds', async () => {
    usePreferencesStore.setState({ preferences: REAL_PREFERENCES, loaded: true })
    const user = userEvent.setup()
    render(<SettingsScreen />)

    const input = screen.getByRole('spinbutton', { name: /autosave interval/i })
    await user.clear(input)
    await user.type(input, '90')

    expect(window.api.setPreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({ autosaveIntervalMs: 90_000 })
    )
  })

  it('changing the default theme updates defaultPageConfig without touching the other default-config fields', async () => {
    usePreferencesStore.setState({ preferences: REAL_PREFERENCES, loaded: true })
    const user = userEvent.setup()
    render(<SettingsScreen />)

    await user.selectOptions(screen.getByRole('combobox', { name: 'Theme' }), 'resume')

    expect(window.api.setPreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPageConfig: expect.objectContaining({
          theme: 'resume',
          pageSize: 'Letter',
          orientation: 'portrait',
          fontFamily: 'source-serif-4'
        })
      })
    )
  })

  it('changing the color scheme persists it immediately and does not disturb the document-theme combobox', async () => {
    usePreferencesStore.setState({ preferences: REAL_PREFERENCES, loaded: true })
    const user = userEvent.setup()
    render(<SettingsScreen />)

    // Two distinct comboboxes named "Color scheme" and "Theme" -- proves
    // the earlier collision (both accessible-named "Theme") was really
    // fixed, not just avoided in this one assertion.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Color scheme' }), 'dark')

    expect(window.api.setPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ colorScheme: 'dark' })
    )
    expect(usePreferencesStore.getState().preferences?.colorScheme).toBe('dark')
    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveValue('default')
  })
})

describe('SettingsScreen header stickiness', () => {
  // The reported defect: leaving Settings meant scrolling back to the top,
  // because the header carrying the only "← Home" control scrolled away with
  // the content. Fixed with `sticky`, deliberately NOT by turning Settings
  // into a modal -- it stays a navigated destination that applies each
  // change immediately (see SettingsScreen.tsx's own header comment).
  //
  // jsdom has no layout engine, so this cannot assert that the header stays
  // painted at the top through a real scroll -- that is what a human or a
  // real-browser gate would do. What it CAN pin, and what actually regressed,
  // is the two structural facts stickiness depends on: the class is present,
  // and the header is a direct child of the element that owns the scrollbar
  // (a `sticky` element positions against its nearest SCROLLING ancestor, so
  // moving the overflow onto an inner wrapper would silently make this a
  // no-op with no error anywhere).
  it('renders the header sticky, inside the element that actually scrolls', () => {
    usePreferencesStore.setState({ preferences: REAL_PREFERENCES, loaded: true })
    render(<SettingsScreen />)

    const header = screen.getByRole('heading', { name: 'Settings' }).parentElement as HTMLElement
    expect(header.className).toContain('sticky')
    expect(header.className).toContain('top-0')

    const scrollContainer = header.parentElement as HTMLElement
    expect(scrollContainer.className).toContain('overflow-y-auto')
  })

  it('keeps the back control inside that sticky header', () => {
    usePreferencesStore.setState({ preferences: REAL_PREFERENCES, loaded: true })
    render(<SettingsScreen />)

    const header = screen.getByRole('heading', { name: 'Settings' }).parentElement as HTMLElement
    expect(header).toContainElement(screen.getByRole('button', { name: '← Home' }))
  })
})
