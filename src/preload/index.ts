import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { Preferences } from '../main/preferences'
import {
  MENU_COMMAND_CHANNEL,
  WINDOW_STATE_CHANNEL,
  isMenuCommand,
  type MenuCommand
} from '../menu/commands'
import {
  WINDOW_CLOSE_REQUEST_CHANNEL,
  WINDOW_CLOSE_RESPONSE_CHANNEL
} from '../window/close-request'
import type { WindowUiState } from '../menu/window-state'
import { PREFERENCES_CHANGED_CHANNEL } from '../preferences/channel'
import {
  UPDATE_DISMISS_CHANNEL,
  UPDATE_GET_STATE_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_STATE_CHANNEL,
  type UpdateState
} from '../updates/update-state'

// Custom APIs for renderer
const api = {
  openFile: () => ipcRenderer.invoke('file:open'),
  openPath: (filePath: string) => ipcRenderer.invoke('file:openPath', filePath),
  saveFile: (filePath: string | null, content: string, expectedMtimeMs: number | null = null) =>
    ipcRenderer.invoke('file:save', filePath, content, expectedMtimeMs),
  getRecentFiles: () => ipcRenderer.invoke('file:getRecents'),
  // Product-completeness audit 0.6. Both only ever narrow the isKnownPath
  // allowlist (see the main-process handlers' own comments) -- removeRecent
  // returns the resulting list so HomeScreen can update its own state
  // straight from the response instead of a second getRecentFiles round trip.
  removeRecentFile: (filePath: string) => ipcRenderer.invoke('file:removeRecent', filePath),
  // Returns the SURVIVING list, not necessarily [] -- second-pass
  // product-completeness audit: main preserves any path currently open in
  // any window (see the file:clearRecents handler's own comment), so the
  // caller must set its state from the real response rather than assuming
  // an empty list.
  clearRecentFiles: () => ipcRenderer.invoke('file:clearRecents'),
  getThumbnail: (filePath: string) => ipcRenderer.invoke('file:getThumbnail', filePath),
  getTemplateThumbnail: (content: string) => ipcRenderer.invoke('template:getThumbnail', content),
  // `filePath` is optional and used ONLY to resolve the document's local
  // asset references against its own directory (the main-process handler
  // validates it with isKnownPath and drops it if unknown). Passing `null`
  // for an unsaved document is correct and denies all local assets.
  // `allowRemoteImages` mirrors the active tab's own remote-image consent
  // decision (documentStore's remoteImagesAllowed) -- defaults to false
  // (blocked), matching pipeline.ts's own default-closed posture. The
  // resolved value's `warnings` array is a plain passthrough of whatever
  // `file:getPageCount` (src/main/index.ts -> page-count-generator.ts)
  // returns -- see index.d.ts's own comment for what populates it.
  getPageCount: (content: string, filePath: string | null = null, allowRemoteImages = false) =>
    ipcRenderer.invoke('file:getPageCount', content, filePath, allowRemoteImages),
  // `documentName` is a display-only label for the dialog (which document is
  // this about) -- see confirmDiscardChanges in src/main/file-io.ts. Omitting
  // it keeps the original, document-agnostic wording.
  confirmDiscardChanges: (documentName?: string) =>
    ipcRenderer.invoke('dialog:confirmDiscard', documentName),
  // `filePath` is optional and used ONLY to resolve the document's local
  // asset references against its own directory (see getPageCount's own
  // comment above) -- the main-process handler validates it with
  // isKnownPath and drops it if unknown. Passing `null` for an unsaved
  // document is correct and denies all local assets in the export.
  // `allowRemoteImages` -- see getPageCount's own comment above.
  exportPdf: (content: string, filePath: string | null = null, allowRemoteImages = false) =>
    ipcRenderer.invoke('file:exportPdf', content, filePath, allowRemoteImages),
  // Product-completeness audit 2.3 (HTML export). Same optional/validated
  // filePath treatment as exportPdf immediately above -- see that entry's
  // own comment.
  exportHtml: (content: string, filePath: string | null = null, allowRemoteImages = false) =>
    ipcRenderer.invoke('file:exportHtml', content, filePath, allowRemoteImages),
  // .docx export. Same optional/validated filePath treatment as exportPdf
  // above -- see that entry's own comment.
  exportDocx: (content: string, filePath: string | null = null, allowRemoteImages = false) =>
    ipcRenderer.invoke('file:exportDocx', content, filePath, allowRemoteImages),
  // "Show in folder" for a just-written export. Deliberately takes the
  // FULL path back from the renderer (documentStore already has it, off the
  // exportPdf/exportHtml result) rather than the main process guessing "the
  // last one" -- but that path is NOT trusted blindly on the other end: the
  // main-process handler only reveals a path it ITSELF wrote via a real
  // export a moment ago (a small remembered set, not an arbitrary-path
  // reveal primitive) -- see the file:exportPdf/file:exportHtml handlers'
  // own comments in src/main/index.ts for the full reasoning. Resolves
  // `false` if the path isn't one this app just exported (nothing to show,
  // never a thrown error over what's ultimately a courtesy action).
  showItemInFolder: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('shell:showItemInFolder', filePath),
  // Same optional/validated filePath treatment as exportPdf immediately
  // above -- see that entry's own comment.
  print: (content: string, filePath: string | null = null, allowRemoteImages = false) =>
    ipcRenderer.invoke('file:print', content, filePath, allowRemoteImages),
  getPreferences: () => ipcRenderer.invoke('preferences:get'),
  setPreferences: (preferences: Preferences) => ipcRenderer.invoke('preferences:set', preferences),
  // Preferences are one shared file for the whole app, so a change made in
  // ANY window has to reach the others -- without this, changing the colour
  // scheme in window 2 left window 1 light until relaunch, while the
  // spellcheck half of the same change applied to both immediately (it is a
  // session-level Electron toggle). See broadcastPreferences in
  // src/main/index.ts.
  //
  // This surface's THIRD push channel, and it follows onMenuCommand's own
  // three rules verbatim: no raw `ipcRenderer.on` is exposed, the
  // `IpcRendererEvent` (which carries a live privileged `sender` handle) is
  // stripped rather than forwarded, and a real unsubscribe function is
  // returned because a bridged callback is never reference-identical to the
  // one the caller passed. The payload needs no validation here -- unlike a
  // menu command, it does not originate in this process, it is the main
  // process's own already-sanitized Preferences object (sanitizePreferences
  // runs in the `preferences:set` handler before both the write and this
  // broadcast).
  onPreferencesChanged: (callback: (preferences: Preferences) => void) => {
    const listener = (_event: IpcRendererEvent, preferences: Preferences): void => {
      callback(preferences)
    }
    ipcRenderer.on(PREFERENCES_CHANGED_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(PREFERENCES_CHANGED_CHANNEL, listener)
    }
  },
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
  // Crash protection for NEVER-SAVED documents. The four entries below are the
  // untitled counterpart of the four version-history entries just above, and
  // the shape difference is the whole design: those key on a file PATH, these
  // key on a `draftId` because there is no path -- see src/main/unsaved-
  // drafts.ts for why a synthetic path (or the renderer's own tab id, which
  // restarts at `tab-1` every launch) could not work.
  //
  // The id is MINTED BY MAIN and returned from the first write; the renderer
  // remembers it on the tab and echoes it back so later ticks overwrite the
  // same draft instead of accumulating one file per tick. `null` in means
  // "this document has no draft yet"; `null` out means nothing was written
  // (empty content, or an already-logged failure).
  //
  // No isKnownPath rule applies to any of these because none of them takes a
  // path -- containment is carried entirely by main's strict anchored
  // draft-id pattern. See the handlers' own comment in src/main/index.ts.
  autosaveUnsavedDraft: (draftId: string | null, content: string): Promise<string | null> =>
    ipcRenderer.invoke('file:autosaveUnsavedDraft', draftId, content),
  listUnsavedDrafts: () => ipcRenderer.invoke('file:listUnsavedDrafts'),
  readUnsavedDraft: (draftId: string): Promise<string | null> =>
    ipcRenderer.invoke('file:readUnsavedDraft', draftId),
  discardUnsavedDraft: (draftId: string): Promise<void> =>
    ipcRenderer.invoke('file:discardUnsavedDraft', draftId),
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
  // `allowRemoteImages` -- see getPageCount's own comment above.
  sendSplitPreviewDocument: (content: string, filePath: string | null, allowRemoteImages = false) =>
    ipcRenderer.invoke('split-preview:sendDocument', content, filePath, allowRemoteImages),
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
  // Reads ONE of the open document's own local images and hands back a
  // self-contained `data:` URI -- the only way the privileged app-shell
  // renderer ever sees local image bytes, and deliberately not a way for it
  // to name a file to read. `filePath` is the DOCUMENT's path (validated
  // with isKnownPath on the other side, dropped if unknown); `src` is the
  // relative reference exactly as it appears in the Markdown. Resolves
  // `null` -- never rejects, never distinguishes why -- for every denial
  // alike (unknown document path, absolute/`..`/symlink escape, missing
  // file, oversize file, non-image bytes), matching resolveAssetPath's own
  // "don't hand a hostile document a filesystem oracle" convention. A remote
  // `http(s)` src is refused before any of that, so this can never be the
  // path by which a remote image renders without consent.
  resolveLocalImage: (filePath: string, src: string): Promise<string | null> =>
    ipcRenderer.invoke('file:resolveLocalImage', filePath, src),
  // `filePath: null`/omitted opens a plain new window at Home, same as the
  // app's own first launch -- see createWindow's own doc comment in
  // src/main/index.ts for why no isKnownPath check is needed here
  // specifically (the new window re-validates independently).
  openInNewWindow: (filePath?: string | null) =>
    ipcRenderer.invoke('window:openInNew', filePath ?? null),
  // This surface's FIRST push channel -- every other entry above is a
  // renderer-initiated `invoke`/`send`. Three things about it are deliberate
  // security choices, not ceremony:
  //
  // 1. `ipcRenderer.on` is NOT exposed. Handing the renderer a raw `on`
  //    (or the `ipcRenderer` object) would let any renderer-side code listen
  //    on ANY channel, including ones carrying file contents or paths.
  //    Wrapping it pins the channel to exactly one.
  // 2. The `IpcRendererEvent` first argument is STRIPPED, never forwarded.
  //    That object carries a live `sender` reference (an ipcRenderer handle)
  //    and `ports`; passing it through contextBridge would hand privileged
  //    IPC objects to renderer code that is otherwise firewalled from them.
  // 3. The command is validated against the shared MENU_COMMANDS allowlist
  //    before any renderer callback runs, so an unexpected value can never
  //    reach a handler map lookup.
  //
  // Returns a real unsubscribe function (contextBridge proxies functions in
  // both directions) rather than exposing an `off`: an off-by-channel API
  // would require the caller to hand the same function reference back across
  // the bridge, and a bridged callback is not reference-identical to the one
  // the caller passed, so `removeListener` would silently never match. The
  // caller MUST call it -- EditorScreen remounts often enough (documentStore's
  // `revision` key, mode switches) that a leaked listener per mount is a real
  // accumulation, not a theoretical one.
  onMenuCommand: (callback: (command: MenuCommand, payload?: string) => void) => {
    const listener = (_event: IpcRendererEvent, command: unknown, payload: unknown): void => {
      if (!isMenuCommand(command)) return
      callback(command, typeof payload === 'string' ? payload : undefined)
    }
    ipcRenderer.on(MENU_COMMAND_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(MENU_COMMAND_CHANNEL, listener)
    }
  },
  // `send`, not `invoke` -- the main process has no result to return, and
  // this fires on ordinary UI state changes (screen navigation, view-mode
  // switches, the dirty flag flipping), the same high-frequency-no-result
  // shape as setSplitPreviewBounds above.
  setWindowState: (state: WindowUiState) => ipcRenderer.send(WINDOW_STATE_CHANNEL, state),
  // The window-close guard's two halves (src/window/close-request.ts). This is
  // this surface's SECOND push channel, and it follows onMenuCommand's own
  // three rules verbatim: no raw `ipcRenderer.on` is exposed, the
  // `IpcRendererEvent` (which carries a live privileged `sender` handle) is
  // stripped rather than forwarded, and a real unsubscribe function is
  // returned because a bridged callback is never reference-identical to the
  // one the caller passed, so an `off`-by-function API could never match.
  //
  // There is no payload in either direction: the request is "may I close?",
  // and the answer is one boolean. The main process keys the answer on
  // `BrowserWindow.fromWebContents(event.sender)`, so a renderer can only ever
  // answer for its own window -- the renderer cannot name a window to close.
  onWindowCloseRequest: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(WINDOW_CLOSE_REQUEST_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(WINDOW_CLOSE_REQUEST_CHANNEL, listener)
    }
  },
  respondToWindowClose: (allow: boolean) =>
    ipcRenderer.send(WINDOW_CLOSE_RESPONSE_CHANNEL, allow === true),
  // Drains the main process's "your configuration could not be read" notices
  // (src/main/config-warnings.ts). Deliberately a DRAIN, not a read: the first
  // window to ask shows them, once per app run.
  getStartupWarnings: (): Promise<string[]> => ipcRenderer.invoke('app:getStartupWarnings'),
  // package.json's real version, via the main process's own app.getVersion()
  // -- the renderer has no direct Node/Electron access to read it itself.
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  // --- In-app auto-update ---
  //
  // None of these four takes a renderer-supplied value of any kind: the main
  // process owns the whole state machine and every decision in it. The
  // renderer's entire role is "render what you are told" plus two explicit
  // user gestures (install, dismiss).
  //
  // This surface's FOURTH push channel, and it follows onMenuCommand's own
  // three rules verbatim: no raw `ipcRenderer.on` is exposed, the
  // `IpcRendererEvent` (which carries a live privileged `sender` handle) is
  // stripped rather than forwarded, and a real unsubscribe function is
  // returned because a bridged callback is never reference-identical to the
  // one the caller passed.
  //
  // The payload is NOT re-validated here, matching onPreferencesChanged's own
  // precedent and for the identical reason: unlike a menu command, it does
  // not originate in this process. It is the main process's own UpdateState
  // object, produced by one pure reducer that is the only thing that can
  // write it -- there is no untrusted input anywhere upstream to sanitize.
  onUpdateState: (callback: (state: UpdateState) => void) => {
    const listener = (_event: IpcRendererEvent, state: UpdateState): void => {
      callback(state)
    }
    ipcRenderer.on(UPDATE_STATE_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, listener)
    }
  },
  // For a window that mounts after a state change was already broadcast --
  // a second window, or a first one still starting up when the launch check
  // landed. Without it such a window would sit on the initial state forever
  // while an update was staged and every other window offered to install it.
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
  // Resolves `false` -- never rejects -- when there is nothing staged to
  // install, or when the user cancelled at the unsaved-work prompt that runs
  // first. The main process re-checks its own state regardless of when or how
  // this is called; see the `update:install` handler in src/main/index.ts.
  installUpdate: (): Promise<boolean> => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL),
  // "Later". Hides the banner; does NOT discard the downloaded update.
  dismissUpdateNotice: (): Promise<void> => ipcRenderer.invoke(UPDATE_DISMISS_CHANNEL)
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
