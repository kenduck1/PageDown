import { ElectronAPI } from '@electron-toolkit/preload'

export interface RecentFileEntry {
  filePath: string
  editedAt: string
}

export interface FileApi {
  openFile: () => Promise<{ filePath: string; content: string } | null>
  openPath: (filePath: string) => Promise<{ filePath: string; content: string }>
  saveFile: (filePath: string | null, content: string) => Promise<{ filePath: string } | null>
  getRecentFiles: () => Promise<RecentFileEntry[]>
  getThumbnail: (filePath: string) => Promise<{ dataUrl: string; pageCount: number }>
  getTemplateThumbnail: (content: string) => Promise<{ dataUrl: string; pageCount: number }>
  getPageCount: (content: string, filePath?: string | null) => Promise<{ pageCount: number }>
  confirmDiscardChanges: () => Promise<'save' | 'discard' | 'cancel'>
  exportPdf: (content: string, filePath?: string | null) => Promise<{ filePath: string } | null>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: FileApi
  }
}
