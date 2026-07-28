import { create } from 'zustand'

type Screen = 'home' | 'editor'
type ViewMode = 'format' | 'split' | 'source'
type SidebarTab = 'pages' | 'outline'
type SplitLeftMode = 'source' | 'format'

const MIN_SPLIT_RATIO = 25
const MAX_SPLIT_RATIO = 75

interface AppState {
  screen: Screen
  viewMode: ViewMode
  sidebarTab: SidebarTab
  splitLeftMode: SplitLeftMode
  splitRatio: number
  pageSetupOpen: boolean
  goEditor: () => void
  goHome: () => void
  setViewMode: (mode: ViewMode) => void
  setSidebarTab: (tab: SidebarTab) => void
  setSplitLeftMode: (mode: SplitLeftMode) => void
  setSplitRatio: (percent: number) => void
  openPageSetup: () => void
  closePageSetup: () => void
}

function clampSplitRatio(percent: number): number {
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, percent))
}

export const useAppStore = create<AppState>()((set) => ({
  screen: 'home',
  viewMode: 'format',
  sidebarTab: 'pages',
  splitLeftMode: 'format',
  splitRatio: 50,
  pageSetupOpen: false,
  goEditor: () => set({ screen: 'editor' }),
  goHome: () => set({ screen: 'home' }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  setSplitLeftMode: (mode) => set({ splitLeftMode: mode }),
  setSplitRatio: (percent) => set({ splitRatio: clampSplitRatio(percent) }),
  openPageSetup: () => set({ pageSetupOpen: true }),
  closePageSetup: () => set({ pageSetupOpen: false })
}))
