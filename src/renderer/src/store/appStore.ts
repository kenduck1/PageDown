import { create } from 'zustand'
import { DEFAULT_ZOOM } from '../lib/zoom-levels'

type Screen = 'home' | 'editor' | 'settings'
export type ViewMode = 'format' | 'split' | 'source'
type SidebarTab = 'pages' | 'outline' | 'history' | 'comments'
export type SplitLeftMode = 'source' | 'format'
type HomeActiveSection = 'recent' | 'templates'

const MIN_SPLIT_RATIO = 25
const MAX_SPLIT_RATIO = 75

// PER-WINDOW vs PER-TAB, decided field by field (product-completeness audit
// 2.4). This app is multi-tab, and `documentStore.tabs` is the established
// home for anything that belongs to a DOCUMENT (see DocumentTab: content /
// filePath / isDirty / mtimeMs / remoteImagesAllowed / currentPage, each
// mirrored to the top level by activeMirror). Everything left in this store is
// therefore a claim that the field describes THE WINDOW, not the document in
// it -- so the two fields that were reviewed and deliberately KEPT here have
// their reasoning written down, not just their defaults:
//
//   - `viewMode` (Format/Split/Source). Per-window. Three independent reasons,
//     each checked rather than assumed. (1) It is reported to the main process
//     as WINDOW state (App.tsx's setWindowState -> src/menu/window-state.ts's
//     WindowUiState), where app-menu-template.ts renders the View menu's radio
//     group from it and gates the three Zoom items on `viewMode !== 'split'`
//     -- a per-tab viewMode would make the application menu describe the
//     active tab and would have to be re-reported on every tab switch. (2) The
//     one thing view mode actually SWITCHES ON, Split's live preview, is a
//     single per-window native WebContentsView (split-preview-window.ts is
//     single-instance module state attached to one window's contentView), so
//     "two tabs in two different view modes" has no representable meaning
//     today. (3) The control is in the window toolbar, not the tab strip.
//     The observed symptom (tab A in Source makes tab B render raw Markdown
//     too) is the honest consequence of a window-level mode, is one click from
//     correction, and writes nothing -- and the two alternatives are both
//     worse: moving the field would require editing EditorToolbar (which reads
//     `viewMode`/`setViewMode` off this store directly), and RESETTING to
//     Format on every tab switch would destroy the "I work in Split" workflow
//     that the field being a preference is for.
//   - `sidebarTab` (Pages/Outline/History/Comments). Per-window. It selects
//     WHICH PANEL of the left rail is showing; all four panels are already
//     fully document-aware (each takes the live content/filePath/pageCount and
//     re-renders per document), so the panel choice is a workspace preference
//     the way a browser devtools tab is. The audit's alarming reading -- "the
//     History panel stays and shows nothing, so it looks like you lost tab A's
//     version history" -- was re-checked against the code and does not hold:
//     EditorHistory renders a real explanatory empty state for a tab with no
//     path ("Save this document first to start keeping version history.") and
//     a separate one for a saved document with no snapshots yet ("No saved
//     versions yet."). Making it per-tab would additionally reset the Outline
//     -- the panel people actually keep open -- on every document switch.
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
  // The canvas zoom level (1 = 100%), stepped through lib/zoom-levels.ts's own
  // ZOOM_OPTIONS list by both the status bar's <select> and View > Zoom In /
  // Zoom Out / Actual Size.
  //
  // PER-WINDOW, and deliberately so: zoom describes how big the paper looks on
  // THIS screen, not anything about the document -- it is absent from
  // frontmatter, absent from PageConfig, never reaches the paginator, the PDF
  // or a thumbnail, and is driven from the View menu, which is window-scoped.
  // So the audit's first half ("zoom carries across tabs") is correct
  // behaviour, not a bug.
  //
  // What WAS a bug is the audit's second half: this lived in `useState` inside
  // EditorScreen, which App.tsx unmounts entirely on `screen !== 'editor'`
  // (`{screen === 'editor' ? <EditorScreen /> : null}`), so a Home round trip
  // silently threw the level away and came back at 100%. Hoisting it into this
  // store -- which is exactly what this store is for, window-scoped UI state
  // that outlives an individual screen -- fixes that with no other change:
  // EditorScreen still hands `zoom`/`onZoomChange` to EditorStatusBar as
  // plain props, so no component API moved.
  zoom: number
  // Whether the editor's left rail (Pages/Outline/History/Comments) is
  // showing. Added for View > Toggle Sidebar in the application menu -- the
  // sidebar was previously rendered unconditionally, with no way to reclaim
  // its 216px on a narrow window. Defaults to visible: hiding chrome the user
  // never asked to hide would be a regression, and the menu item's own
  // checkmark-free label reads as an action either way.
  sidebarVisible: boolean
  // Split-mode "Follow": while true (and only while viewMode === 'split' AND
  // splitLeftMode === 'format' -- see EditorScreen's own gating, this field
  // stays a plain unconditional preference so its state survives leaving and
  // re-entering Split mode), scrolling the editor pane estimates a page from
  // that scroll offset and feeds it into the same page-navigation path the
  // status bar's chevrons already use. Defaults to true: this is the "why
  // else would you open Split mode" default per the design recon (docs/
  // superpowers/plans/2026-08-09-design-doc-gap-audit.md's "Follow, not
  // Sync" section), but a toggle exists (not always-on with no escape
  // hatch) because the preview is ALSO independently, deliberately
  // scrollable on its own -- CLAUDE.md's Page Navigation section documents
  // real manual-scroll tracking (the 400ms poll) as load-bearing precisely
  // because glancing at a different page while continuing to edit elsewhere
  // is an established, real workflow this app already protects. An
  // always-on Follow with no toggle would fight that workflow on every
  // single editor scroll tick with no way out.
  splitFollowEnabled: boolean
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
  setZoom: (zoom: number) => void
  toggleSidebar: () => void
  toggleSplitFollow: () => void
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
  zoom: DEFAULT_ZOOM,
  sidebarVisible: true,
  splitFollowEnabled: true
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
  // Rejects a non-finite or non-positive level rather than storing it. Not
  // defensive padding: the status bar's control is a controlled
  // `<select value={String(zoom)}>`, so a value that is not one of
  // ZOOM_OPTIONS' own numbers renders the control BLANK (see zoom-levels.ts's
  // own comment) -- a NaN arriving from a future free-form input would blank
  // it with no error anywhere. The list membership itself is deliberately NOT
  // enforced here: nextZoomLevel/previousZoomLevel already resolve an off-list
  // value back onto the list, and hard-rejecting one would make that recovery
  // path unreachable.
  setZoom: (zoom) => set((state) => (Number.isFinite(zoom) && zoom > 0 ? { zoom } : state)),
  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  toggleSplitFollow: () => set((state) => ({ splitFollowEnabled: !state.splitFollowEnabled }))
}))
