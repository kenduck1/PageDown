import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore, initialAppState } from './appStore'

function resetStore(): void {
  useAppStore.setState(initialAppState)
}

beforeEach(() => {
  resetStore()
})

describe('useAppStore', () => {
  it('starts with the documented initial state', () => {
    expect(useAppStore.getState()).toMatchObject(initialAppState)
  })

  it('goEditor switches screen to editor without touching other state', () => {
    useAppStore.getState().setViewMode('source')
    useAppStore.getState().goEditor()
    expect(useAppStore.getState().screen).toBe('editor')
    expect(useAppStore.getState().viewMode).toBe('source')
  })

  it('goHome switches screen back to home', () => {
    useAppStore.getState().goEditor()
    useAppStore.getState().goHome()
    expect(useAppStore.getState().screen).toBe('home')
  })

  it('setViewMode changes viewMode without resetting sidebarTab', () => {
    useAppStore.getState().setSidebarTab('outline')
    useAppStore.getState().setViewMode('split')
    expect(useAppStore.getState().viewMode).toBe('split')
    expect(useAppStore.getState().sidebarTab).toBe('outline')
  })

  it('setSidebarTab changes sidebarTab without resetting viewMode', () => {
    useAppStore.getState().setViewMode('source')
    useAppStore.getState().setSidebarTab('outline')
    expect(useAppStore.getState().sidebarTab).toBe('outline')
    expect(useAppStore.getState().viewMode).toBe('source')
  })

  it('setSplitLeftMode changes independently of viewMode', () => {
    useAppStore.getState().setViewMode('split')
    useAppStore.getState().setSplitLeftMode('source')
    expect(useAppStore.getState().splitLeftMode).toBe('source')
    expect(useAppStore.getState().viewMode).toBe('split')
  })

  it('setSplitRatio clamps values below the minimum to 25', () => {
    useAppStore.getState().setSplitRatio(10)
    expect(useAppStore.getState().splitRatio).toBe(25)
  })

  it('setSplitRatio clamps values above the maximum to 75', () => {
    useAppStore.getState().setSplitRatio(90)
    expect(useAppStore.getState().splitRatio).toBe(75)
  })

  it('setSplitRatio passes through in-range values unchanged', () => {
    useAppStore.getState().setSplitRatio(60)
    expect(useAppStore.getState().splitRatio).toBe(60)
  })

  it('setSplitRatio falls back to the minimum when given NaN', () => {
    useAppStore.getState().setSplitRatio(NaN)
    expect(useAppStore.getState().splitRatio).toBe(25)
  })

  it('openPageSetup and closePageSetup toggle pageSetupOpen', () => {
    useAppStore.getState().openPageSetup()
    expect(useAppStore.getState().pageSetupOpen).toBe(true)
    useAppStore.getState().closePageSetup()
    expect(useAppStore.getState().pageSetupOpen).toBe(false)
  })

  // Matches the section HomeScreen actually renders first, and the order its
  // own nav now lists them in -- see initialAppState's own comment.
  it('starts with templates as the active home section', () => {
    expect(useAppStore.getState().homeActiveSection).toBe('templates')
  })

  it('setHomeActiveSection switches sections without touching screen', () => {
    useAppStore.getState().setHomeActiveSection('recent')
    expect(useAppStore.getState().homeActiveSection).toBe('recent')
    expect(useAppStore.getState().screen).toBe('home')
  })

  it('goSettings switches screen to settings', () => {
    useAppStore.getState().goSettings()
    expect(useAppStore.getState().screen).toBe('settings')
  })

  // `currentPage` used to live here and is deliberately gone: the page you
  // are looking at belongs to a DOCUMENT, not to a window, so it now lives on
  // DocumentTab and is covered by documentStore.test.ts. This assertion is
  // what stops it being reintroduced here by reflex -- a second, per-window
  // copy would silently shadow the per-tab one for whichever consumer read it.
  it('does not carry a per-window current page any more', () => {
    expect('currentPage' in useAppStore.getState()).toBe(false)
    expect('setCurrentPage' in useAppStore.getState()).toBe(false)
  })

  it('starts at 100% zoom', () => {
    expect(useAppStore.getState().zoom).toBe(1)
  })

  it('setZoom sets the level', () => {
    useAppStore.getState().setZoom(1.5)
    expect(useAppStore.getState().zoom).toBe(1.5)
  })

  it('setZoom ignores a non-finite or non-positive level', () => {
    useAppStore.getState().setZoom(1.25)
    useAppStore.getState().setZoom(Number.NaN)
    expect(useAppStore.getState().zoom).toBe(1.25)
    useAppStore.getState().setZoom(0)
    expect(useAppStore.getState().zoom).toBe(1.25)
    useAppStore.getState().setZoom(-2)
    expect(useAppStore.getState().zoom).toBe(1.25)
  })

  it('starts with Split-mode Follow enabled', () => {
    expect(useAppStore.getState().splitFollowEnabled).toBe(true)
  })

  it('toggleSplitFollow flips splitFollowEnabled without touching other state', () => {
    useAppStore.getState().setViewMode('split')
    useAppStore.getState().toggleSplitFollow()
    expect(useAppStore.getState().splitFollowEnabled).toBe(false)
    expect(useAppStore.getState().viewMode).toBe('split')
    useAppStore.getState().toggleSplitFollow()
    expect(useAppStore.getState().splitFollowEnabled).toBe(true)
  })

  it('revealComment opens the Comments tab, shows the sidebar, and marks the comment active', () => {
    // The sidebar being hidden is the case that makes this one action rather
    // than three calls at the call site: switching the tab behind a hidden
    // rail leaves the click looking like it did nothing, which is the exact
    // bug revealComment exists to fix.
    useAppStore.setState({ sidebarVisible: false, sidebarTab: 'pages', activeCommentId: null })

    useAppStore.getState().revealComment('c1')

    expect(useAppStore.getState().sidebarTab).toBe('comments')
    expect(useAppStore.getState().sidebarVisible).toBe(true)
    expect(useAppStore.getState().activeCommentId).toBe('c1')
  })

  it('clearActiveComment drops the active comment without closing the sidebar', () => {
    useAppStore.getState().revealComment('c1')
    useAppStore.getState().clearActiveComment()
    expect(useAppStore.getState().activeCommentId).toBeNull()
    expect(useAppStore.getState().sidebarTab).toBe('comments')
    expect(useAppStore.getState().sidebarVisible).toBe(true)
  })
})
