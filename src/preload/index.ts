import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  openFile: () => ipcRenderer.invoke('file:open'),
  openPath: (filePath: string) => ipcRenderer.invoke('file:openPath', filePath),
  saveFile: (filePath: string | null, content: string) =>
    ipcRenderer.invoke('file:save', filePath, content),
  getRecentFiles: () => ipcRenderer.invoke('file:getRecents'),
  getThumbnail: (filePath: string) => ipcRenderer.invoke('file:getThumbnail', filePath),
  getTemplateThumbnail: (content: string) => ipcRenderer.invoke('template:getThumbnail', content),
  // `filePath` is optional and used ONLY to resolve the document's local
  // asset references against its own directory (the main-process handler
  // validates it with isKnownPath and drops it if unknown). Passing `null`
  // for an unsaved document is correct and denies all local assets.
  getPageCount: (content: string, filePath: string | null = null) =>
    ipcRenderer.invoke('file:getPageCount', content, filePath),
  confirmDiscardChanges: () => ipcRenderer.invoke('dialog:confirmDiscard'),
  // `filePath` is optional and used ONLY to resolve the document's local
  // asset references against its own directory (see getPageCount's own
  // comment above) -- the main-process handler validates it with
  // isKnownPath and drops it if unknown. Passing `null` for an unsaved
  // document is correct and denies all local assets in the export.
  exportPdf: (content: string, filePath: string | null = null) =>
    ipcRenderer.invoke('file:exportPdf', content, filePath)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
