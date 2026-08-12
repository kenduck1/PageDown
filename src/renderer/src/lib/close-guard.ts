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

// One answered prompt, held until the WHOLE sequence has been answered. See
// confirmWindowClose's two-phase comment for why nothing is acted on as it is
// answered.
interface CloseDecision {
  tabId: string
  action: 'save' | 'discard'
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
  // within 200ms of a window-close request (the red button, Cmd+Shift+W,
  // Cmd+Q -- second-pass product-completeness audit: NOT Cmd+W any more,
  // which now closes the active TAB instead and never reaches this guard at
  // all, see app-menu-template.ts's own comment) is still `isDirty: false`
  // in the store -- exactly the race `flush()` exists for on Save (CLAUDE.md's
  // own writeup), and the one that would make this guard wave a
  // genuinely-unsaved document straight through with no prompt at all.
  // flush() is a documented no-op when nothing changed since mount, so
  // calling it unconditionally is free.
  //
  // It also has to happen before the loop's first `switchTab`: switching tabs
  // remounts the editor, and the outgoing instance's own unmount flush would
  // otherwise land AFTER we had already decided a tab was clean.
  flushEditor?.()

  // TWO PHASES, and the split is the whole point -- the document-level twin of
  // the window-level sequence main/index.ts's `before-quit` handler already
  // runs, and the same bug it already fixed.
  //
  // This used to be ONE loop that cleared the pending autosave and closed each
  // tab AS IT WAS ANSWERED, then returned false on a later Cancel. So "Cancel"
  // did not cancel: with two dirty tabs, answering "Don't Save" for the first
  // and then Cancel for the second left the first ALREADY closed and its
  // version-history snapshots ALREADY cleared -- unrecoverably, with no way
  // back for a user who had been intending to reconsider by the end of the
  // sequence. Nothing may be destroyed until the whole decision is known.
  //
  // Phase 1 therefore only ASKS, recording each answer and touching nothing.
  // Phase 2 applies the recorded answers, and only runs at all once every
  // prompt has been answered without a Cancel.
  const decisions: CloseDecision[] = []
  // Tabs already answered for. Phase 1 changes nothing about a tab's own
  // dirtiness, so -- unlike the old loop, where saving/closing removed each
  // tab from consideration on its own -- this set is what makes the pass
  // terminate: every iteration adds exactly one id and `tabs` is finite.
  const answered = new Set<string>()

  for (;;) {
    const state = useDocumentStore.getState()
    // Re-read from the store on every pass, never from a list captured before
    // the first await: switching tabs mutates `tabs`, and a late flush from a
    // remounting editor can still dirty one during this phase.
    const dirtyTab = state.tabs.find((tab) => tab.isDirty && !answered.has(tab.id))
    if (!dirtyTab) break

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
    // Nothing has been applied yet, so there is nothing to undo -- which is
    // exactly what makes this return honest.
    if (choice === 'cancel') return false

    answered.add(dirtyTab.id)
    decisions.push({ tabId: dirtyTab.id, action: choice === 'save' ? 'save' : 'discard' })
  }

  // PHASE 2a -- every save, BEFORE any discard. That ordering is load-bearing
  // rather than tidy: a save can still fail (a cancelled Save-As, a disk
  // error) or be answered "Reload" at the external-change dialog, and both are
  // only discoverable here, after every prompt has been answered. Running the
  // discards first would mean a save failing at that point had already
  // destroyed an unrelated tab's work.
  for (const { tabId, action } of decisions) {
    if (action !== 'save') continue
    const state = useDocumentStore.getState()
    // A tab can genuinely vanish between the two phases (an ErrorBoundary
    // "Save my work" pass, another window's IPC). Nothing left to save.
    if (!state.tabs.some((tab) => tab.id === tabId)) continue
    if (tabId !== state.activeTabId) state.switchTab(tabId)

    const outcome = await useDocumentStore.getState().save()
    // "Reload" at the external-change dialog is NOT a save, and cannot be
    // detected from store state: it leaves the tab clean with a fresh mtime,
    // exactly like a successful write. It writes nothing, replaces the tab's
    // content with what is on disk, and deliberately records no
    // version-history snapshot -- so the edit the user was about to save is
    // gone, with no copy left anywhere.
    //
    // WHAT IT MEANS HERE: abandon the close. Reload is a request to SEE the
    // file as it now is, not an answer to "save before closing?" -- closing
    // the window on the strength of it would deny the user the one thing they
    // asked for, having just thrown away their work to get it. The window
    // stays open showing what was loaded.
    //
    // Ruled out, because both are worse: snapshotting the discarded edit here
    // so the close could proceed (the next open would then silently "recover"
    // the edit the user chose to discard -- the exact failure the
    // clearPendingAutosave machinery exists to prevent, and why that branch
    // records nothing in the first place); and treating it as a failed save
    // and re-prompting (the tab is clean now, so there is nothing coherent
    // left to ask about).
    if (outcome === 'reloaded') return false
    // Re-read THIS tab by id, never the top-level isDirty mirror -- the same
    // race EditorScreen's own dirty-tab close documents at length: save() is
    // a plain IPC round trip with no modal dialog for an already-known path,
    // and a tab switch during it would make the mirror describe a different
    // document. A still-dirty tab means the write genuinely did not happen
    // (an error, or a cancelled Save-As for a never-saved document), and a
    // failed save must never fall through into closing the window.
    const saved = useDocumentStore.getState().tabs.find((tab) => tab.id === tabId)
    if (saved?.isDirty) return false
  }

  // PHASE 2b -- the discards, now that every save has genuinely landed.
  for (const { tabId, action } of decisions) {
    if (action !== 'discard') continue
    const discarding = useDocumentStore.getState().tabs.find((tab) => tab.id === tabId)
    if (!discarding) continue
    // Clear any pending autosave snapshot first, so the discarded edit cannot
    // silently reappear as a "recovered" document on the next open (the exact
    // failure EditorScreen's own discard path documents), then close the tab
    // so a later switch back cannot resurrect it either. Guarded on filePath
    // because version-history storage is keyed by path -- an unsaved document
    // has no snapshots to clear. Fire-and-forget: the discard decision is
    // final by now, and clearPendingAutosave's own IPC handler validates the
    // path and never rejects.
    if (discarding.filePath) void window.api.clearPendingAutosave(discarding.filePath)
    // closeTab additionally discards the tab's unsaved DRAFT if it has one --
    // see its own comment for why that lives there rather than here.
    useDocumentStore.getState().closeTab(tabId)
  }

  return true
}
