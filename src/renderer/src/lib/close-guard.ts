import { useAppStore } from '../store/appStore'
import { useDocumentStore } from '../store/documentStore'
import { tabLabel } from './tab-label'

// The renderer half of the window-close / app-quit guard (main-process half:
// src/main/index.ts, wire contract: src/window/close-request.ts).
//
// Runs the app's EXISTING Save / Don't Save / Cancel confirmation -- the same
// `window.api.confirmDiscardChanges()` native dialog EditorScreen's "<- Home"
// button and its dirty-tab close already use -- once per dirty tab, and
// reports back whether the window may close.
//
// A plain module function rather than a hook, and deliberately NOT owned by
// EditorScreen: a close request can arrive while the user is sitting on the
// Home or Settings screen, where EditorScreen is unmounted but documentStore
// still holds every open tab, dirty state intact. App.tsx (always mounted) is
// the only component that can subscribe on every screen.

// The live Milkdown editor's flush(), published by EditorScreen while it is
// mounted and cleared on unmount.
//
// WHY A MODULE-LEVEL REGISTRY rather than a prop or a ref passed in: the
// subscriber is App.tsx, which has no access to EditorScreen's `editorRef`,
// and threading a ref down through the screen switch just for this would put a
// close-guard concern into every screen's props. This is the same shape as the
// latest-ref convention used across this codebase (MilkdownEditor's
// onChangeRef, Toast's onDismissRef), lifted one level to module scope because
// the two ends live in different components.
let flushEditor: (() => void) | null = null

export function setCloseGuardFlush(flush: (() => void) | null): void {
  flushEditor = flush
}

/**
 * Resolves true when every dirty document has been dealt with and the window
 * may close, false when the user cancelled.
 *
 * Never rejects: the caller (App.tsx) treats a thrown error as "do not close",
 * so a failure here can only ever keep a document alive, never discard one.
 */
export async function confirmWindowClose(): Promise<boolean> {
  // FIRST, before reading a single isDirty flag. @milkdown/plugin-listener's
  // onChange fires through an internal 200ms debounce, so a document edited
  // within 200ms of Cmd+W is still `isDirty: false` in the store -- exactly
  // the race `flush()` exists for on Save (CLAUDE.md's own writeup), and the
  // one that would make this guard wave a genuinely-unsaved document straight
  // through with no prompt at all. flush() is a documented no-op when nothing
  // changed since mount, so calling it unconditionally is free.
  //
  // It also has to happen before the loop's first `switchTab`: switching tabs
  // remounts the editor, and the outgoing instance's own unmount flush would
  // otherwise land AFTER we had already decided a tab was clean.
  flushEditor?.()

  for (;;) {
    const state = useDocumentStore.getState()
    // Re-read from the store on every pass, never from a list captured before
    // the first await: saving, discarding and switching all mutate `tabs`.
    const dirtyTab = state.tabs.find((tab) => tab.isDirty)
    if (!dirtyTab) return true

    // Show the document being asked about. Two independent reasons, and the
    // second is a correctness requirement rather than a nicety: a native
    // dialog about a document the user cannot see is unanswerable, AND
    // documentStore.save() only ever writes the ACTIVE tab (its own mirror
    // fields), so "Save" for a background tab is only reachable by making it
    // active first. A cancel therefore leaves a different tab selected than
    // before -- a visible, honest consequence of having shown what was at
    // stake, not a silent one.
    if (useAppStore.getState().screen !== 'editor') useAppStore.getState().goEditor()
    if (dirtyTab.id !== state.activeTabId) state.switchTab(dirtyTab.id)

    const choice = await window.api.confirmDiscardChanges(tabLabel(dirtyTab.filePath))
    if (choice === 'cancel') return false

    if (choice === 'save') {
      await useDocumentStore.getState().save()
      // Re-read THIS tab by id, never the top-level isDirty mirror -- the same
      // race EditorScreen's own dirty-tab close documents at length: save() is
      // a plain IPC round trip with no modal dialog for an already-known path,
      // and a tab switch during it would make the mirror describe a different
      // document. A still-dirty tab means the write genuinely did not happen
      // (an error, or a cancelled Save-As for a never-saved document), and a
      // failed save must never fall through into closing the window.
      const saved = useDocumentStore.getState().tabs.find((tab) => tab.id === dirtyTab.id)
      if (saved?.isDirty) return false
      continue
    }

    // "Don't Save": clear any pending autosave snapshot first, so the discarded
    // edit cannot silently reappear as a "recovered" document on the next open
    // (the exact failure EditorScreen's own discard path documents), then close
    // the tab so a later switch back cannot resurrect it either. Guarded on
    // filePath because version-history storage is keyed by path -- an unsaved
    // document has no snapshots to clear. Fire-and-forget: the discard decision
    // is already final, and clearPendingAutosave's own IPC handler validates
    // the path and never rejects.
    if (dirtyTab.filePath) void window.api.clearPendingAutosave(dirtyTab.filePath)
    // Terminates: closeTab removes this tab, and its "never leave zero tabs"
    // replacement is a fresh CLEAN blank tab, so the loop cannot cycle on it.
    useDocumentStore.getState().closeTab(dirtyTab.id)
  }
}
