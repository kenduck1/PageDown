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

export interface FileApi {
  openFile: () => Promise<{
    filePath: string
    content: string
    recoveredFromAutosave: boolean
  } | null>
  openPath: (
    filePath: string
  ) => Promise<{ filePath: string; content: string; recoveredFromAutosave: boolean }>
  saveFile: (filePath: string | null, content: string) => Promise<{ filePath: string } | null>
  getRecentFiles: () => Promise<RecentFileEntry[]>
  getThumbnail: (filePath: string) => Promise<{ dataUrl: string; pageCount: number }>
  getTemplateThumbnail: (content: string) => Promise<{ dataUrl: string; pageCount: number }>
  getPageCount: (content: string, filePath?: string | null) => Promise<{ pageCount: number }>
  confirmDiscardChanges: () => Promise<'save' | 'discard' | 'cancel'>
  exportPdf: (content: string, filePath?: string | null) => Promise<{ filePath: string } | null>
  autosaveSnapshot: (content: string, filePath: string) => Promise<void>
  getVersionHistory: (filePath: string) => Promise<SnapshotMeta[]>
  restoreVersionContent: (filePath: string, snapshotId: string) => Promise<string | null>
  clearPendingAutosave: (filePath: string) => Promise<void>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: FileApi
  }
}
