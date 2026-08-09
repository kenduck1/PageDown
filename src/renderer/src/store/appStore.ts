import { create } from 'zustand'

type Screen = 'home' | 'editor' | 'settings'
export type ViewMode = 'format' | 'split' | 'source'
type SidebarTab = 'pages' | 'outline' | 'history' | 'comments'
export type SplitLeftMode = 'source' | 'format'
type HomeActiveSection = 'recent' | 'templates'

const MIN_SPLIT_RATIO = 25
const MAX_SPLIT_RATIO = 75

interface AppStateValues {
  screen: Screen
  viewMode: ViewMode
  sidebarTab: SidebarTab
  splitLeftMode: SplitLeftMode
  splitRatio: number
  pageSetupOpen: boolean
  shortcutsHelpOpen: boolean
  commentComposerOpen: boolean
  // Drives LinkComposer, the layout row that replaced the toolbar's old
  // `window.prompt('Link URL')` call. That prompt did not merely return null
  // in Electron -- it THREW ("prompt() is not supported.", measured directly
  // in the real built app), so Insert link was completely dead: no dialog, no
  // link, and nothing surfaced anywhere (the renderer has no global error
  // handler and no ErrorBoundary, and documentStore.error was never touched).
  // Modeled on commentComposerOpen directly above rather than kept as
  // EditorToolbar-local useState, because the composer itself is rendered by
  // EditorScreen (it must be a LAYOUT ROW in that screen's row stack, see
  // LinkComposer.tsx) while the button that opens it lives in EditorToolbar --
  // two different components, so the flag has to live somewhere both can see.
  linkComposerOpen: boolean
  homeActiveSection: HomeActiveSection
  currentPage: number
}

interface AppState extends AppStateValues {
  goEditor: () => void
  goHome: () => void
  goSettings: () => void
  setViewMode: (mode: ViewMode) => void
  setSidebarTab: (tab: SidebarTab) => void
  setSplitLeftMode: (mode: SplitLeftMode) => void
  setSplitRatio: (percent: number) => void
  openPageSetup: () => void
  closePageSetup: () => void
  openShortcutsHelp: () => void
  closeShortcutsHelp: () => void
  openCommentComposer: () => void
  closeCommentComposer: () => void
  openLinkComposer: () => void
  closeLinkComposer: () => void
  setHomeActiveSection: (section: HomeActiveSection) => void
  setCurrentPage: (page: number) => void
}

export const initialAppState: AppStateValues = {
  screen: 'home',
  viewMode: 'format',
  sidebarTab: 'pages',
  splitLeftMode: 'format',
  splitRatio: 50,
  pageSetupOpen: false,
  shortcutsHelpOpen: false,
  commentComposerOpen: false,
  linkComposerOpen: false,
  homeActiveSection: 'recent',
  currentPage: 1
}

function clampSplitRatio(percent: number): number {
  if (Number.isNaN(percent)) return MIN_SPLIT_RATIO
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, percent))
}

export const useAppStore = create<AppState>()((set) => ({
  ...initialAppState,
  goEditor: () => set({ screen: 'editor' }),
  goHome: () => set({ screen: 'home' }),
  goSettings: () => set({ screen: 'settings' }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  setSplitLeftMode: (mode) => set({ splitLeftMode: mode }),
  setSplitRatio: (percent) => set({ splitRatio: clampSplitRatio(percent) }),
  openPageSetup: () => set({ pageSetupOpen: true }),
  closePageSetup: () => set({ pageSetupOpen: false }),
  openShortcutsHelp: () => set({ shortcutsHelpOpen: true }),
  closeShortcutsHelp: () => set({ shortcutsHelpOpen: false }),
  openCommentComposer: () => set({ commentComposerOpen: true }),
  closeCommentComposer: () => set({ commentComposerOpen: false }),
  openLinkComposer: () => set({ linkComposerOpen: true }),
  closeLinkComposer: () => set({ linkComposerOpen: false }),
  setHomeActiveSection: (section) => set({ homeActiveSection: section }),
  setCurrentPage: (page) =>
    set((state) => (Number.isFinite(page) ? { currentPage: Math.max(1, Math.floor(page)) } : state))
}))
