import { ElectronAPI } from '@electron-toolkit/preload'

export interface RecentFileEntry {
  filePath: string
  editedAt: string
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
  confirmDiscardChanges: () => Promise<'save' | 'discard' | 'cancel'>
  exportPdf: (
    content: string,
    filePath?: string | null,
    allowRemoteImages?: boolean
  ) => Promise<{ filePath: string } | null>
  print: (
    content: string,
    filePath?: string | null,
    allowRemoteImages?: boolean
  ) => Promise<{ cancelled: boolean }>
  getPreferences: () => Promise<Preferences>
  setPreferences: (preferences: Preferences) => Promise<void>
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
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: FileApi
  }
}
