import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { Preferences } from '../main/preferences'

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
    ipcRenderer.invoke('file:exportPdf', content, filePath),
  // Same optional/validated filePath treatment as exportPdf immediately
  // above -- see that entry's own comment.
  print: (content: string, filePath: string | null = null) =>
    ipcRenderer.invoke('file:print', content, filePath),
  getPreferences: () => ipcRenderer.invoke('preferences:get'),
  setPreferences: (preferences: Preferences) => ipcRenderer.invoke('preferences:set', preferences),
  autosaveSnapshot: (content: string, filePath: string) =>
    ipcRenderer.invoke('file:autosaveSnapshot', content, filePath),
  getVersionHistory: (filePath: string) => ipcRenderer.invoke('file:getVersionHistory', filePath),
  restoreVersionContent: (filePath: string, snapshotId: string) =>
    ipcRenderer.invoke('file:restoreVersionContent', filePath, snapshotId),
  // No cutoff parameter -- see the file:clearPendingAutosave handler's own
  // comment in src/main/index.ts for why a correctness-critical timestamp
  // like this must be computed in the main process from the real on-disk
  // mtime, not accepted from the renderer.
  clearPendingAutosave: (filePath: string) =>
    ipcRenderer.invoke('file:clearPendingAutosave', filePath),
  // `ipcRenderer.send`, not `invoke` -- this fires on every ResizeObserver
  // tick from the Split mode preview pane and has no result the caller needs
  // to await (see the split-preview:setBounds handler's own comment in
  // src/main/index.ts for the full scale-factor rationale).
  setSplitPreviewBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send('split-preview:setBounds', bounds),
  // `filePath: null` denies all local assets for that render (an unsaved
  // document, or one the caller hasn't vetted) -- same convention as
  // getPageCount/exportPdf above. The main-process handler validates a
  // non-null path with isKnownPath and drops it if unknown.
  sendSplitPreviewDocument: (content: string, filePath: string | null) =>
    ipcRenderer.invoke('split-preview:sendDocument', content, filePath),
  destroySplitPreview: () => ipcRenderer.invoke('split-preview:destroy'),
  // Both are deliberately non-creating on the main-process side (see
  // split-preview:scrollToPage/split-preview:getPage's own comments in
  // src/main/index.ts) -- the renderer polls getSplitPreviewPage on a timer
  // while Split mode is open, so this must never spin up a harness.
  scrollSplitPreviewToPage: (pageIndex: number) =>
    ipcRenderer.invoke('split-preview:scrollToPage', pageIndex),
  getSplitPreviewPage: () => ipcRenderer.invoke('split-preview:getPage'),
  // `filePath: null` (an unsaved document) is refused with a real error by
  // the main-process handler, not silently degraded -- unlike
  // getPageCount/exportPdf/sendSplitPreviewDocument above, there's no
  // reasonable "denied but still proceeds" behavior for a feature whose
  // entire purpose is writing a new file next to the document.
  saveDroppedImage: (filePath: string | null, base64Data: string, suggestedFilename: string) =>
    ipcRenderer.invoke('file:saveDroppedImage', filePath, base64Data, suggestedFilename),
  // `filePath: null`/omitted opens a plain new window at Home, same as the
  // app's own first launch -- see createWindow's own doc comment in
  // src/main/index.ts for why no isKnownPath check is needed here
  // specifically (the new window re-validates independently).
  openInNewWindow: (filePath?: string | null) =>
    ipcRenderer.invoke('window:openInNew', filePath ?? null)
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
