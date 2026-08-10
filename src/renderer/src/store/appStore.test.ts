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

  it('starts with recent as the active home section', () => {
    expect(useAppStore.getState().homeActiveSection).toBe('recent')
  })

  it('setHomeActiveSection switches sections without touching screen', () => {
    useAppStore.getState().setHomeActiveSection('templates')
    expect(useAppStore.getState().homeActiveSection).toBe('templates')
    expect(useAppStore.getState().screen).toBe('home')
  })

  it('goSettings switches screen to settings', () => {
    useAppStore.getState().goSettings()
    expect(useAppStore.getState().screen).toBe('settings')
  })

  it('starts on page 1', () => {
    expect(useAppStore.getState().currentPage).toBe(1)
  })

  it('setCurrentPage sets the current page', () => {
    useAppStore.getState().setCurrentPage(4)
    expect(useAppStore.getState().currentPage).toBe(4)
  })

  it('setCurrentPage floors below 1', () => {
    useAppStore.getState().setCurrentPage(0)
    expect(useAppStore.getState().currentPage).toBe(1)
    useAppStore.getState().setCurrentPage(-3)
    expect(useAppStore.getState().currentPage).toBe(1)
  })

  it('setCurrentPage ignores a non-finite page', () => {
    useAppStore.getState().setCurrentPage(6)
    useAppStore.getState().setCurrentPage(Number.NaN)
    expect(useAppStore.getState().currentPage).toBe(6)
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
})
