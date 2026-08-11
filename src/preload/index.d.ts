import { ElectronAPI } from '@electron-toolkit/preload'
// The ONE cross-directory import in this file, and the exception proves the
// rule the local copies below are justified by: every other shared shape here
// (RecentFileEntry, Preferences, SplitPreviewResult, PageNavState) is
// re-declared locally because its real definition lives in `src/main/**`,
// which is outside tsconfig.web.json's program and transitively imports
// Electron. `src/menu/*` is neither -- it is a deliberately dependency-free
// contract module shared by main, preload and renderer alike (same shape as
// `src/typography/*`, which the renderer already imports directly), so
// duplicating it here would create exactly the silent-drift risk those local
// copies otherwise accept as a cost.
import type { MenuCommand } from '../menu/commands'
import type { WindowUiState } from '../menu/window-state'

export interface RecentFileEntry {
  filePath: string
  editedAt: string
  // Product-completeness audit 0.6: a real, freshly-checked (per getRecentFiles
  // call, not cached) existence flag -- see recent-files.ts's own
  // readRecentFilesWithStatus for what this costs and why it's computed
  // there rather than per-row.
  exists: boolean
}

export interface SnapshotMeta {
  id: string
  timestamp: string
  sizeBytes: number
}

// Structurally identical to src/main/preferences.ts's own DefaultPageConfig/
// Preferences -- deliberately NOT imported from there, matching this file's
// existing RecentFileEntry/SnapshotMeta precedent (see SplitPreviewBounds's
// own comment just below for the full reasoning: src/main/**/* sits outside
// tsconfig.web.json's `include`, which is what this file is checked under).
export interface DefaultPageConfig {
  pageSize: 'Letter' | 'A4' | 'Legal' | 'Custom'
  orientation: 'portrait' | 'landscape'
  theme: 'default' | 'resume' | 'letter' | 'report'
  fontFamily: 'source-serif-4' | 'inter'
}

export type ColorScheme = 'light' | 'dark' | 'system'

export interface Preferences {
  spellcheckEnabled: boolean
  autosaveIntervalMs: number
  defaultPageConfig: DefaultPageConfig
  colorScheme: ColorScheme
  authorName: string
}

// A CSS-pixel rectangle (getBoundingClientRect()'s own shape) for the Split
// mode preview pane. Deliberately a local, structurally-shaped interface
// rather than an import from src/main/split-preview-window.ts's own
// (unexported) CssRect -- matching this file's existing precedent of
// defining RecentFileEntry/SnapshotMeta locally instead of importing from
// the main-process modules that also happen to shape data this way.
export interface SplitPreviewBounds {
  x: number
  y: number
  width: number
  height: number
}

// Structurally identical to src/main/pagination-window.ts's own exported
// PaginationResult -- deliberately NOT imported from there. That module
// lives outside tsconfig.web.json's `include` list and pulls in
// Electron-main-process-only types (WebContentsView, etc.); this file is
// type-checked as part of the WEB project (tsconfig.web.json explicitly
// includes `src/preload/*.d.ts`), and the rest of this file already avoids
// importing shared shapes from src/main/* for exactly this reason (see
// SplitPreviewBounds above).
export interface SplitPreviewResult {
  pageCount: number
  ready: boolean
  layoutMs: number
  diagramBoxes: Array<{ id: string; width: number; height: number }>
  imageBoxes: Array<{
    src: string
    resolvedSrc: string
    naturalWidth: number
    naturalHeight: number
  }>
}

// Structurally identical to src/pagination/page-nav.ts's own exported
// PageNavState -- deliberately NOT imported from there, same rationale as
// SplitPreviewBounds/SplitPreviewResult above (that module lives outside
// tsconfig.web.json's `include` list).
export interface PageNavState {
  currentPage: number
  pageCount: number
}

export interface FileApi {
  openFile: () => Promise<{
    filePath: string
    content: string
    recoveredFromAutosave: boolean
    mtimeMs: number
  } | null>
  openPath: (filePath: string) => Promise<{
    filePath: string
    content: string
    recoveredFromAutosave: boolean
    mtimeMs: number
  }>
  // expectedMtimeMs is the mtime baseline from the last open/save of this
  // path (null when there is none, e.g. a brand-new document) -- used to
  // detect an external change since that baseline. A conflict resolved via
  // "Reload" returns reloadedContent instead of completing the save; the
  // caller (documentStore.save()) must adopt it as the document's new
  // content rather than treating the call as a normal successful save.
  saveFile: (
    filePath: string | null,
    content: string,
    expectedMtimeMs?: number | null
  ) => Promise<{ filePath: string; mtimeMs: number; reloadedContent?: string } | null>
  getRecentFiles: () => Promise<RecentFileEntry[]>
  // Product-completeness audit 0.6 ("Remove from recents" / "Clear recents").
  // Both only ever narrow the isKnownPath allowlist -- see the main-process
  // handlers' own comments in src/main/index.ts. removeRecentFile returns
  // the resulting list so the caller can update its own state directly.
  removeRecentFile: (filePath: string) => Promise<RecentFileEntry[]>
  clearRecentFiles: () => Promise<void>
  getThumbnail: (filePath: string) => Promise<{ dataUrl: string; pageCount: number }>
  getTemplateThumbnail: (content: string) => Promise<{ dataUrl: string; pageCount: number }>
  // allowRemoteImages mirrors the active tab's own remote-image consent
  // decision (documentStore's remoteImagesAllowed) -- see
  // src/markdown/pipeline.ts's stripRemoteImageSrcs for the real enforcement.
  getPageCount: (
    content: string,
    filePath?: string | null,
    allowRemoteImages?: boolean
  ) => Promise<{ pageCount: number }>
  // `documentName` is a display-only label naming WHICH document the dialog is
  // about -- required once several tabs can be prompted about in a row (the
  // window-close guard). Omitted keeps the original document-agnostic wording.
  confirmDiscardChanges: (documentName?: string) => Promise<'save' | 'discard' | 'cancel'>
  exportPdf: (
    content: string,
    filePath?: string | null,
    allowRemoteImages?: boolean
  ) => Promise<{ filePath: string } | null>
  // Product-completeness audit 2.3 (HTML export) -- same shape as exportPdf.
  exportHtml: (
    content: string,
    filePath?: string | null,
    allowRemoteImages?: boolean
  ) => Promise<{ filePath: string } | null>
  // Reveals a just-exported file (PDF or HTML) in the OS file manager.
  // `false` when `filePath` isn't a path this app itself wrote via a recent
  // export -- see the preload implementation's own comment for why this is
  // deliberately NOT an arbitrary-path reveal primitive.
  showItemInFolder: (filePath: string) => Promise<boolean>
  print: (
    content: string,
    filePath?: string | null,
    allowRemoteImages?: boolean
  ) => Promise<{ cancelled: boolean }>
  getPreferences: () => Promise<Preferences>
  setPreferences: (preferences: Preferences) => Promise<void>
  // Subscribes to "another window changed the shared preferences". Returns an
  // unsubscribe function the caller MUST invoke on unmount, same contract (and
  // same reason) as onMenuCommand below.
  onPreferencesChanged: (callback: (preferences: Preferences) => void) => () => void
  autosaveSnapshot: (content: string, filePath: string) => Promise<void>
  getVersionHistory: (filePath: string) => Promise<SnapshotMeta[]>
  restoreVersionContent: (filePath: string, snapshotId: string) => Promise<string | null>
  clearPendingAutosave: (filePath: string) => Promise<void>
  setSplitPreviewBounds: (bounds: SplitPreviewBounds) => void
  sendSplitPreviewDocument: (
    content: string,
    filePath: string | null,
    allowRemoteImages?: boolean
  ) => Promise<SplitPreviewResult>
  destroySplitPreview: () => Promise<void>
  scrollSplitPreviewToPage: (pageIndex: number) => Promise<PageNavState>
  getSplitPreviewPage: () => Promise<PageNavState>
  saveDroppedImage: (
    filePath: string | null,
    base64Data: string,
    suggestedFilename: string
  ) => Promise<{ relativePath: string } | { error: string }>
  openInNewWindow: (filePath?: string | null) => Promise<void>
  // Subscribes to native application-menu commands. Returns an unsubscribe
  // function the caller MUST invoke on unmount -- see the preload
  // implementation's own comment for why an unsubscribe function (rather than
  // an `offMenuCommand`) is the only shape that can actually work across
  // contextBridge.
  onMenuCommand: (callback: (command: MenuCommand, payload?: string) => void) => () => void
  // Reports this window's own menu-relevant/title-relevant state to the main
  // process. Fire-and-forget, like setSplitPreviewBounds.
  setWindowState: (state: WindowUiState) => void
  // Subscribes to the main process's "this window is trying to close" request.
  // Returns an unsubscribe function the caller MUST invoke on unmount, same
  // contract (and same reason) as onMenuCommand above. The callback MUST
  // eventually call respondToWindowClose exactly once -- until it does, the
  // window stays open with its close cancelled.
  onWindowCloseRequest: (callback: () => void) => () => void
  respondToWindowClose: (allow: boolean) => void
  // "Your configuration could not be read" notices collected during startup
  // (src/main/config-warnings.ts). Drains: the first caller gets them, once.
  getStartupWarnings: () => Promise<string[]>
  // package.json's real, running version (main process's app.getVersion()).
  getAppVersion: () => Promise<string>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: FileApi
  }
}
