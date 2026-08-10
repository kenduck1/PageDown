import { create } from 'zustand'

// One open document "tab". Deliberately a subset of DocumentStateValues'
// per-document fields (content/filePath/isDirty) -- `error` and `revision`
// stay global/top-level rather than per-tab (see DocumentStateValues below).
export interface DocumentTab {
  id: string
  filePath: string | null
  content: string
  isDirty: boolean
  // The file's on-disk mtime as of the last open/save of this path -- null
  // for a document with no such baseline yet (never saved, or saved for the
  // first time via Save-As, which picks a fresh target with no prior mtime
  // to compare against). save() sends this to file:save so the main process
  // can detect a change made on disk since this baseline (another program,
  // or another PageDown window on the same file) rather than silently
  // clobbering it -- see file-io.ts's saveFile.
  mtimeMs: number | null
  // The user's consent decision for loading this document's remote (http/
  // https) images -- design doc Security section: "Remote images blocked by
  // default per document, with an explicit ... Load / Keep blocked prompt."
  // `null` means undecided (not yet prompted, or the document has no remote
  // images to prompt about at all); `false`/`true` are explicit decisions.
  // Deliberately session-only, reset to `null` on every fresh open/new
  // document -- never persisted across app restarts or even a re-open of the
  // same path within one session, matching this feature's own "blocked by
  // default" posture rather than remembering a prior grant indefinitely.
  remoteImagesAllowed: boolean | null
}

interface DocumentStateValues {
  // content/filePath/isDirty always mirror the active tab (tabs.find(t =>
  // t.id === activeTabId)) -- kept in sync on every action that can change
  // the active tab or its fields, rather than computed via a selector, so
  // every existing consumer (EditorScreen, MilkdownEditor, and their tests)
  // that reads these fields directly off the store keeps working unchanged.
  content: string
  filePath: string | null
  isDirty: boolean
  // Mirrors the active tab's own DocumentTab.mtimeMs -- see that field's own
  // doc comment.
  mtimeMs: number | null
  // Mirrors the active tab's own DocumentTab.remoteImagesAllowed -- see that
  // field's own doc comment.
  remoteImagesAllowed: boolean | null
  // Deliberately global, not per-tab: nothing in this codebase surfaces a
  // per-background-tab error today (the only producers -- openFile/openPath/
  // save -- all operate on whatever tab is currently active), so scoping
  // error to a tab would be unobservable complexity. Revisit if a future
  // feature needs a background tab to carry its own error.
  error: string | null
  // In-flight guards for the two long-running, dialog-opening document
  // operations. In the STORE rather than in EditorToolbar's own useState
  // (where they used to live) because there are now two independent triggers
  // for each -- the toolbar button and the File menu item -- and a guard held
  // by one of them cannot stop a double-run started from the other. Also
  // closes the CLAUDE.md deviation EditorToolbar.tsx's own header comment
  // records ("should add a real `exportPdf` action to documentStore.ts and
  // have this component call that instead"): screen components should call
  // store actions, never window.api directly.
  isExporting: boolean
  isPrinting: boolean
  // Bumped on every action that changes *what* is displayed for reasons
  // other than an in-place edit -- new tab opened, tab switched, active tab
  // closed -- so EditorScreen's `key={revision}` remounts MilkdownEditor
  // with the newly-active tab's content. Never bumped by updateContent.
  revision: number
  tabs: DocumentTab[]
  activeTabId: string
}

interface DocumentState extends DocumentStateValues {
  newDocument: (initialContent?: string) => void
  // startDirty defaults to false so every existing call site (newDocument,
  // and any future plain load) is unchanged; openFile/openPath pass through
  // `result.recoveredFromAutosave` so a document recovered from a crash
  // lands dirty, reusing the app's existing unsaved-changes protections
  // (dirty-check-before-navigate, the "Save"/"Don't Save"/"Cancel" prompt)
  // rather than adding recovery-specific UI.
  loadDocument: (
    filePath: string,
    content: string,
    startDirty?: boolean,
    mtimeMs?: number | null
  ) => void
  openFile: () => Promise<boolean>
  openPath: (filePath: string) => Promise<boolean>
  save: () => Promise<void>
  // Save As: writes the active tab to a path the user picks in a real native
  // dialog, regardless of whether it already has one. Shares runSave's whole
  // body with save() -- the only differences are that it passes a null target
  // path (which is what makes file-io.ts's saveFile open its Save dialog) and
  // a null mtime baseline. See runSave's own comment for why null is right
  // for the baseline too, rather than merely convenient.
  saveAs: () => Promise<void>
  // Export/Print, moved here from EditorToolbar's local handlers so the
  // toolbar button and the File menu item run ONE implementation behind ONE
  // in-flight guard. Neither ever rejects: a failure lands in `error` as a
  // friendly message (never the raw IPC error string, which Electron wraps as
  // `Error invoking remote method 'file:exportPdf': ...`), and a cancelled
  // print dialog is the user's own choice, not a failure, so it is not an
  // error either. Success deliberately does NOT clear `error` -- an unrelated
  // failed Save from moments earlier must not vanish because an export
  // succeeded.
  exportPdf: () => Promise<void>
  print: () => Promise<void>
  // Reads the ACTIVE tab's own filePath internally (same rationale as
  // save() capturing it before its own await -- see that action's comment)
  // rather than requiring the caller to look it up, since callers here are
  // MilkdownEditor's/SourceEditor's own drop handlers, not a screen
  // component with easy store access via a hook. Returns the result rather
  // than mutating store state -- the actual document-content change (a real
  // ![alt](relativePath) reference) is applied by the CALLER inserting it
  // into the editor at the drop position, which this action has no way to
  // do generically for both Format and Source mode.
  saveDroppedImage: (file: File) => Promise<{ relativePath: string } | { error: string }>
  updateContent: (content: string) => void
  // Same update as updateContent, but targets an EXPLICIT tab id rather
  // than "whichever tab is active right now" -- needed because
  // MilkdownEditor's onChange can fire asynchronously (its own 200ms
  // plugin-listener debounce, or the flush() its unmount cleanup calls)
  // AFTER activeTabId has already changed. Real, reproduced bug this
  // closes: switchTab/openTab/closeTab all change activeTabId AND bump
  // revision synchronously (in the same tab-bar click handler); the
  // revision bump forces EditorScreen's key={revision} to remount
  // MilkdownEditor, whose OUTGOING instance's unmount cleanup calls
  // flush() to push any not-yet-debounced edit through onChange. If
  // onChange were still `updateContent` (which reads state.activeTabId at
  // CALL time, not at bind time), that final flush from the tab being
  // LEFT would land in the tab being SWITCHED TO instead -- silently
  // moving/losing a just-typed edit the instant the user switches tabs
  // within the debounce window. EditorScreen closes this by binding
  // onChange to `(markdown) => updateContentForTab(activeTabId, markdown)`
  // with `activeTabId` read from THIS render's hook value: since any
  // change to activeTabId always bumps revision (forcing a fresh
  // MilkdownEditor key), the activeTabId captured in the render that
  // produced a given key={revision} instance is guaranteed correct for
  // that instance's entire lifetime, even after the store's own
  // activeTabId has since moved on.
  updateContentForTab: (tabId: string, content: string) => void
  // Same active-tab/mirror update as updateContent, but ALSO bumps revision
  // -- for a content change that originates OUTSIDE the live mounted editor
  // (e.g. Page Setup applying a frontmatter edit), not from the editor's own
  // onChange. MilkdownEditor is uncontrolled after mount (content only seeds
  // defaultValueCtx at construction -- see MilkdownEditor.tsx) and never
  // re-reads the `content` prop on a later render, so a plain updateContent
  // call here would update the store but leave the live editor showing its
  // own stale in-memory document; the next real edit would then serialize
  // and push THAT stale document back through onChange, silently reverting
  // this change. Bumping revision forces EditorScreen's `key={revision}`
  // remount, the same mechanism newDocument/loadDocument already rely on to
  // re-seed the editor from fresh content.
  replaceContent: (content: string) => void
  // Same active-tab/mirror update + revision bump as replaceContent, but
  // targets an EXPLICIT tab id rather than "whichever tab is active right
  // now" -- the exact race class updateContentForTab already exists to
  // prevent for MilkdownEditor's onChange, reopened here through a
  // DIFFERENT async door. Any caller with a real await gap between
  // deciding to replace a tab's content and actually calling this (e.g.
  // EditorScreen's handleRestoreVersion, which awaits a flush+Save round
  // trip first) can have the user switch tabs via the always-visible
  // EditorTabBar during that gap. replaceContent reads state.activeTabId
  // at CALL time, so it would silently land the new content on whatever
  // tab is active BY THEN, not the tab the caller actually meant to
  // replace -- overwriting an unrelated document and leaving the tab that
  // should have received it untouched. Callers with such a gap must
  // capture the target tab id BEFORE the await and pass it here instead of
  // calling replaceContent after the await resolves.
  //
  // isDirty same-value guard (final whole-branch review, F1): a caller
  // that replaces a tab's content with content BYTE-IDENTICAL to what that
  // tab already holds leaves isDirty UNTOUCHED rather than forcing it to
  // true -- revision still bumps unconditionally. EditorScreen's
  // handleSetViewMode is exactly this caller on every Source -> Format
  // switch: it rewrites the SAME content Source mode's own controlled
  // textarea already synced into the store, purely to force the revision
  // bump that remounts MilkdownEditor. Before this guard, that same-value
  // rewrite still unconditionally set isDirty: true, so a Format -> Source
  // -> Format round trip with zero real edits marked a clean document
  // dirty -- a false positive in the app's principal data-loss guard
  // (spurious unsaved-changes indicator, a spurious native Save/Don't
  // Save/Cancel prompt on Home navigation, a spurious 45s-later
  // autosave-version-history entry). The same guard is semantically
  // correct for every other caller too: Page Setup applying a no-op
  // config, or a History restore to content identical to what's already
  // loaded, should equally not dirty a clean document. If content DID
  // change, behavior is unchanged (isDirty: true); if the document was
  // already dirty, it stays dirty either way.
  replaceContentForTab: (tabId: string, content: string) => void
  clearError: () => void
  // startDirty defaults to false, same as loadDocument above -- a recovered
  // document is the only caller that ever passes true. mtimeMs defaults to
  // null, same as loadDocument -- only openFile/openPath (real reads of an
  // existing file) ever pass a real value.
  //
  // DEDUPS on a non-null filePath already open in THIS window's tabs --
  // focuses the existing tab (leaving its content/isDirty/mtimeMs untouched)
  // instead of appending a second one for the same file. See this action's
  // own implementation comment for the full reasoning (dirty-tab handling,
  // raw-vs-canonical path comparison, why this can't and shouldn't reach
  // across windows).
  openTab: (
    filePath: string | null,
    content: string,
    startDirty?: boolean,
    mtimeMs?: number | null
  ) => void
  // Closing a dirty tab is a simple in-memory discard for this pass -- no
  // "Save changes before closing?" confirmation. EditorScreen's existing
  // dirty-check-before-navigate flow (window.api.confirmDiscardChanges) only
  // guards leaving the editor screen entirely, not per-tab close. A real
  // tab-close confirmation is deferred, not silently dropped: whatever wires
  // EditorTabBar's close button into real navigation should decide whether
  // to prompt before calling this for a dirty tab.
  closeTab: (tabId: string) => void
  switchTab: (tabId: string) => void
  // Records the user's Load/Keep-blocked decision for a specific tab's
  // remote images -- takes an explicit tabId (not "whichever tab is active
  // right now") for the same reason updateContentForTab/replaceContentForTab
  // do: the banner's own click handler in EditorScreen is bound to the tab
  // id captured at the time it was shown, which could in principle no longer
  // be the active tab by the time the user clicks (e.g. a fast tab switch).
  // Does NOT bump revision -- unlike a content change, this never needs
  // MilkdownEditor to remount; it only affects what image srcs the NEXT
  // render (Split preview / page count / export) is allowed to include.
  setRemoteImagesAllowed: (tabId: string, allowed: boolean) => void
}

// Monotonically increasing, not crypto-random: these ids are only ever used
// as React keys / internal lookups within a single running app session, so
// uniqueness (not unguessability) is the only real requirement, and this
// avoids depending on crypto.randomUUID's availability across every test/
// runtime environment this store runs in.
let nextTabId = 1
function generateTabId(): string {
  const id = `tab-${nextTabId}`
  nextTabId += 1
  return id
}

function createBlankTab(): DocumentTab {
  return {
    id: generateTabId(),
    filePath: null,
    content: '',
    isDirty: false,
    mtimeMs: null,
    remoteImagesAllowed: null
  }
}

// Fields that mirror whichever tab is active -- factored out so every action
// that changes the active tab (or the active tab's own fields) sets all of
// them together, keeping `tabs` and the top-level mirror fields from ever
// drifting apart.
function activeMirror(
  tab: DocumentTab
): Pick<DocumentTab, 'content' | 'filePath' | 'isDirty' | 'mtimeMs' | 'remoteImagesAllowed'> {
  return {
    content: tab.content,
    filePath: tab.filePath,
    isDirty: tab.isDirty,
    mtimeMs: tab.mtimeMs,
    remoteImagesAllowed: tab.remoteImagesAllowed
  }
}

const initialTab = createBlankTab()

export const initialDocumentState: DocumentStateValues = {
  ...activeMirror(initialTab),
  error: null,
  isExporting: false,
  isPrinting: false,
  revision: 0,
  tabs: [initialTab],
  activeTabId: initialTab.id
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// FileReader.readAsDataURL, not a hand-rolled ArrayBuffer->base64 loop --
// the standard, browser-native way to get a base64 encoding of a File's
// bytes without touching Node's Buffer (unavailable here: this renderer
// runs with contextIsolation on and nodeIntegration off, per this app's
// security model). Strips the `data:<mime>;base64,` prefix so the IPC call
// carries pure base64, matching what Buffer.from(data, 'base64') on the
// main-process side expects.
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('Failed to read dropped file'))
        return
      }
      const commaIndex = result.indexOf(',')
      resolve(commaIndex === -1 ? result : result.slice(commaIndex + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read dropped file'))
    reader.readAsDataURL(file)
  })
}

// The one implementation behind both save() and saveAs(). A module-level
// function reaching the store through useDocumentStore.getState()/setState()
// -- rather than a helper defined inside create()'s own callback -- purely to
// keep this diff to what actually changed: wrapping the store literal in a
// block to host a closure would have re-indented every action in the file for
// no behavioural reason. The two accessors are identical to the `get`/`set`
// the actions themselves receive.
//
// `forceSaveAs` changes exactly two arguments, and both matter:
//   - a null target path is what makes file-io.ts's saveFile open a real
//     native Save dialog instead of writing to the current path;
//   - a null mtime baseline suppresses the external-change conflict check,
//     which is correct rather than merely convenient: the check asks "has THE
//     FILE THIS DOCUMENT CAME FROM changed under us," and a Save-As target is
//     a path the user is about to choose in a dialog, which this app has no
//     baseline for at all. Passing the OLD file's mtime would compare a
//     baseline for one file against the mtime of a different one. This
//     mirrors saveFileToKnownOrChosenPath's own existing Save-As fallback,
//     which already passes null for the same reason.
async function runSave(forceSaveAs: boolean): Promise<void> {
  // Capture WHICH tab is being saved synchronously, before the `await`
  // below -- window.api.saveFile is a real IPC round trip, and the user
  // can switch tabs via the always-visible EditorTabBar during that gap.
  // The `setState()` callback further down used to read `state.activeTabId`
  // at RESOLVE time instead, which is the same race class
  // replaceContentForTab was introduced to close for restore: it would
  // silently mark whichever tab is active WHEN THE WRITE FINISHES as
  // saved/clean, not the tab whose content was actually written to disk
  // -- corrupting an unrelated background tab's isDirty/filePath while
  // leaving the tab that was truly saved still marked dirty.
  const { content, filePath, activeTabId: tabId, mtimeMs } = useDocumentStore.getState()
  try {
    const result = await window.api.saveFile(
      forceSaveAs ? null : filePath,
      content,
      forceSaveAs ? null : mtimeMs
    )
    if (result) {
      if (result.reloadedContent !== undefined) {
        // The main process detected the file changed on disk since this
        // tab's own mtimeMs baseline, and the user chose "Reload" in the
        // resulting native dialog -- nothing was written. Adopt what's
        // actually on disk as this tab's content instead of what the user
        // was about to save, matching Reload's own stated meaning ("load
        // the file as it is on disk now"). Bumping revision only when this
        // is still the active tab mirrors replaceContentForTab's own
        // guard: MilkdownEditor is uncontrolled after mount, so a
        // Format-mode canvas showing this tab needs a fresh key to pick up
        // content that changed outside its own onChange path.
        const reloadedContent = result.reloadedContent
        useDocumentStore.setState((state) => {
          const tabs = state.tabs.map((tab) =>
            tab.id === tabId
              ? { ...tab, content: reloadedContent, isDirty: false, mtimeMs: result.mtimeMs }
              : tab
          )
          if (tabId !== state.activeTabId) return { tabs, error: null }
          return {
            tabs,
            content: reloadedContent,
            isDirty: false,
            mtimeMs: result.mtimeMs,
            error: null,
            revision: state.revision + 1
          }
        })
        return
      }
      useDocumentStore.setState((state) => {
        const tabs = state.tabs.map((tab) =>
          tab.id === tabId
            ? { ...tab, filePath: result.filePath, isDirty: false, mtimeMs: result.mtimeMs }
            : tab
        )
        // Only refresh the top-level mirror fields when the SAVED tab is
        // still the active one -- same guard as updateContentForTab/
        // replaceContentForTab. If the user switched tabs during the
        // `await` above, `tabs` still picks up the saved tab's new
        // filePath/isDirty (so switching back to it later shows the
        // correct saved state), but nothing about what's CURRENTLY on
        // screen changed, so the mirror fields (and the currently
        // displayed tab's own state) are left alone. `error` stays
        // unconditionally cleared either way -- it's deliberately a
        // global, not per-tab, field (see its own doc comment above),
        // and a just-succeeded save clearing a stale global error is
        // reasonable regardless of which tab it belonged to.
        if (tabId !== state.activeTabId) return { tabs, error: null }
        return {
          tabs,
          filePath: result.filePath,
          isDirty: false,
          mtimeMs: result.mtimeMs,
          error: null
        }
      })
      // Best-effort -- see version-history's own "never blocks a real
      // Save" invariant. This call happens AFTER the real save already
      // succeeded and the store has already been updated above, so even a
      // rejected promise here (autosaveSnapshot's own IPC handler already
      // swallows failures and never rejects, but this stays fire-and-
      // forget regardless) can never undo or fail the Save the user just
      // performed.
      void window.api.autosaveSnapshot(content, result.filePath)
    }
  } catch (err) {
    useDocumentStore.setState({ error: errorMessage(err) })
  }
}

export const useDocumentStore = create<DocumentState>()((set, get) => ({
  ...initialDocumentState,
  // Product-completeness audit 0.5: opening a path already open IN THIS
  // WINDOW now focuses that existing tab instead of appending a duplicate --
  // this is the behavior every tabbed editor has, and closes two real bugs a
  // duplicate tab caused: the mtime-on-save conflict check only fires when
  // two saves of the same path land >2s apart (MTIME_TOLERANCE_MS), so two
  // tabs saving inside that window silently clobbered each other with no
  // warning; and both tabs autosaved into the SAME path-keyed
  // version-history directory (sha256 of the canonical path), interleaving
  // snapshots from two independently-diverging in-memory documents and
  // corrupting that file's whole recovery story.
  //
  // Guarded on `filePath !== null`: a null filePath means an untitled/blank
  // tab, and this app deliberately allows any number of those side by side
  // (EditorTabBar's own "+" button, and newDocument, both call
  // openTab(null, ...) precisely to open ANOTHER blank tab) -- two blank
  // tabs are two genuinely different, unrelated documents, not a duplicate
  // of anything.
  //
  // DIRTY-TAB reasoning (the audit's own explicit question): the matched
  // tab's content/isDirty/mtimeMs are left completely untouched -- the
  // freshly-read `content`/`startDirty`/`mtimeMs` this call was given are
  // simply discarded. Focusing (not reloading) is correct whether the
  // existing tab is dirty or clean:
  //   - DIRTY: the user's in-memory, unsaved edits are the thing this whole
  //     audit finding exists to protect. Silently replacing them with
  //     whatever is on disk right now (or a just-recovered autosave) would
  //     itself BE a silent-data-loss bug of exactly the kind Tier 0 is
  //     about, just moved one step earlier than the save-clobber it's
  //     already known for.
  //   - CLEAN: re-reading isn't needed for correctness either. If the file
  //     changed on disk since this tab was opened, the EXISTING mtime
  //     conflict check (file-io.ts's saveFile, keyed off the tab's own
  //     mtimeMs baseline, left untouched here) still catches that the next
  //     time this tab is saved -- Reload/Overwrite/Cancel. Leaving mtimeMs
  //     alone is what keeps that baseline meaningful; overwriting it here
  //     with "now" would make a genuinely-external change since the
  //     original open silently invisible to that check.
  //
  // PATH-COMPARISON reasoning (the audit's other explicit question): this
  // compares the raw `filePath` string, not a canonicalized (fs.realpath)
  // form, even though canonicalizeDocumentPath (file-io.ts) exists in this
  // codebase precisely because two spellings of one file are otherwise
  // possible (see its own doc comment: a symlinked temp dir vs. its
  // realpath). Deliberate, not an oversight:
  //   - Every route BY WHICH this app lets a user "open a file again" is
  //     app-mediated and echoes back a string this app itself already
  //     recorded: a native Open dialog result (file:open), a Recent row or
  //     the File > Open Recent submenu (both sourced from recent-files.json,
  //     itself only ever populated from a prior dialog/openPath result), or
  //     the `?openPath=` query param a second WINDOW is launched with (a
  //     different window entirely -- see below). None of these re-derive or
  //     retype a path; they all replay a string this app already has on
  //     file. Two opens of the same real file through this app's own UI
  //     therefore produce byte-identical strings in the overwhelming
  //     majority of cases -- exactly the case 0.5 describes.
  //   - The realpath-divergence case canonicalizeDocumentPath guards against
  //     is, by CLAUDE.md's own account, a `mkdtemp(tmpdir())` TEST-fixture
  //     artifact (macOS resolving /tmp to /private/tmp) -- not a spelling a
  //     real user produces by hand through Finder/the native dialog twice.
  //   - Canonicalizing here would need either a renderer->main IPC round
  //     trip before every single open (this renderer has no fs access,
  //     contextIsolation is on) -- adding real latency to a same-window,
  //     should-be-instant tab-focus decision -- or threading a
  //     `canonicalPath` field through OpenedFile/DocumentTab and keeping it
  //     fresh across every write that can change a tab's filePath (Save-As
  //     in particular), which is real, separate surface with its own new
  //     staleness-bug risk (a canonicalPath computed once at open time and
  //     never invalidated after a later Save-As would misdedupe), to close
  //     a gap narrower than the one 0.5 is actually about.
  //   - Residual, disclosed gap: two DIFFERENT spellings of the same real
  //     file (a raw symlinked path vs. its resolved form) opened within one
  //     window will NOT be deduped by this check. If that ever proves to
  //     matter for real users, the fix is the same pattern version-history
  //     already uses -- add a canonicalPath alongside filePath and keep it
  //     current on every write, not just at open time.
  //
  // CROSS-WINDOW: deliberately NOT extended there. `state.tabs` here is
  // this store's own in-memory array, and Zustand's `create()` produces a
  // module-level singleton PER RENDERER PROCESS -- Multi-window support
  // gives every window its own separate renderer process (and therefore its
  // own separate instance of this whole module), so there is structurally
  // no `state.tabs` from window B this check could ever see while running
  // in window A. Two windows showing the same file is the case
  // CLAUDE.md's "External file-change detection on Save" section already
  // names as the intended job of the mtime-on-save conflict check, not
  // something a tab-list dedup could reach across a process boundary to
  // fix even if it tried.
  openTab: (filePath, content, startDirty = false, mtimeMs = null) =>
    set((state) => {
      if (filePath !== null) {
        const existing = state.tabs.find((tab) => tab.filePath === filePath)
        if (existing) {
          if (existing.id === state.activeTabId) return {}
          return {
            activeTabId: existing.id,
            ...activeMirror(existing),
            error: null,
            revision: state.revision + 1
          }
        }
      }
      const tab: DocumentTab = {
        id: generateTabId(),
        filePath,
        content,
        isDirty: startDirty,
        mtimeMs,
        remoteImagesAllowed: null
      }
      return {
        tabs: [...state.tabs, tab],
        activeTabId: tab.id,
        ...activeMirror(tab),
        error: null,
        revision: state.revision + 1
      }
    }),
  closeTab: (tabId) =>
    set((state) => {
      const closingIndex = state.tabs.findIndex((tab) => tab.id === tabId)
      if (closingIndex === -1) return {}

      const remaining = state.tabs.filter((tab) => tab.id !== tabId)

      // Never leave zero tabs -- a closed last tab is replaced by a fresh
      // blank "Untitled" one rather than leaving no editor surface at all.
      if (remaining.length === 0) {
        const blank = createBlankTab()
        return {
          tabs: [blank],
          activeTabId: blank.id,
          ...activeMirror(blank),
          error: null,
          revision: state.revision + 1
        }
      }

      // Closing a background tab doesn't change what's displayed -- no need
      // to touch the mirror fields or bump revision (no remount needed).
      if (state.activeTabId !== tabId) {
        return { tabs: remaining }
      }

      // The active tab was closed: activate its neighbor (the tab that
      // slides into the closed tab's index, or the new last tab if it was
      // rightmost) -- the conventional browser-tab-close behavior.
      const nextActive = remaining[Math.min(closingIndex, remaining.length - 1)]
      return {
        tabs: remaining,
        activeTabId: nextActive.id,
        ...activeMirror(nextActive),
        error: null,
        revision: state.revision + 1
      }
    }),
  switchTab: (tabId) =>
    set((state) => {
      if (tabId === state.activeTabId) return {}
      const tab = state.tabs.find((t) => t.id === tabId)
      if (!tab) return {}
      return {
        activeTabId: tab.id,
        ...activeMirror(tab),
        error: null,
        revision: state.revision + 1
      }
    }),
  // newDocument/loadDocument now open a NEW tab rather than replacing the
  // active tab's content in place, matching real multi-document-app
  // behavior -- both are thin wrappers around openTab so there is exactly
  // one place ("what does opening a document do") to reason about.
  // newDocument passes filePath: null through unchanged -- openTab's own
  // dedup guard (below) only ever applies to a non-null filePath, so
  // "New document" (and EditorTabBar's own "+" button, which also calls
  // openTab(null, '')) keeps allowing any number of blank Untitled tabs,
  // matching the pre-existing, still-correct behavior.
  newDocument: (initialContent = '') => get().openTab(null, initialContent),
  loadDocument: (filePath, content, startDirty = false, mtimeMs = null) =>
    get().openTab(filePath, content, startDirty, mtimeMs),
  openFile: async () => {
    try {
      const result = await window.api.openFile()
      if (!result) return false
      get().loadDocument(
        result.filePath,
        result.content,
        result.recoveredFromAutosave,
        result.mtimeMs
      )
      return true
    } catch (err) {
      set({ error: errorMessage(err) })
      return false
    }
  },
  openPath: async (filePath) => {
    try {
      const result = await window.api.openPath(filePath)
      get().loadDocument(
        result.filePath,
        result.content,
        result.recoveredFromAutosave,
        result.mtimeMs
      )
      return true
    } catch (err) {
      set({ error: errorMessage(err) })
      return false
    }
  },
  save: () => runSave(false),
  saveAs: () => runSave(true),
  exportPdf: async () => {
    // Guard, set, and clear all read/write the STORE's own flag rather than a
    // component's local state -- see the isExporting field's own comment for
    // why that move was required rather than tidier.
    if (get().isExporting) return
    set({ isExporting: true })
    const { content, filePath, remoteImagesAllowed } = get()
    try {
      // filePath is what resolves local image references in the exported PDF
      // against the document's own directory (src/main/pdf-exporter.ts) --
      // null (an unsaved document) correctly denies all local assets.
      await window.api.exportPdf(content, filePath, remoteImagesAllowed === true)
    } catch (err) {
      // Log the real error for diagnosis, but never put a raw IPC error
      // string in front of the user.
      console.error('Failed to export PDF', err)
      set({ error: 'Failed to export PDF. Please try again.' })
    } finally {
      set({ isExporting: false })
    }
  },
  print: async () => {
    if (get().isPrinting) return
    set({ isPrinting: true })
    const { content, filePath, remoteImagesAllowed } = get()
    try {
      // A cancelled OS print dialog resolves { cancelled: true } rather than
      // rejecting (see print-exporter.ts's PRINT_CANCELLED_REASON handling),
      // so cancelling never lands in the error banner.
      await window.api.print(content, filePath, remoteImagesAllowed === true)
    } catch (err) {
      console.error('Failed to print', err)
      set({ error: 'Failed to print. Please try again.' })
    } finally {
      set({ isPrinting: false })
    }
  },
  saveDroppedImage: async (file) => {
    const { filePath } = get()
    try {
      const base64Data = await readFileAsBase64(file)
      return await window.api.saveDroppedImage(filePath, base64Data, file.name)
    } catch (err) {
      return { error: errorMessage(err) }
    }
  },
  updateContent: (content) => get().updateContentForTab(get().activeTabId, content),
  updateContentForTab: (tabId, content) =>
    set((state) => {
      const tabs = state.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, content, isDirty: true } : tab
      )
      // The tab being updated may no longer be the active one (see this
      // action's own doc comment above) -- only refresh the top-level
      // mirror fields when it still is, so a late flush from a tab the
      // user has already switched away from doesn't clobber what's
      // currently on screen.
      if (tabId !== state.activeTabId) return { tabs }
      return { tabs, content, isDirty: true }
    }),
  replaceContent: (content) => get().replaceContentForTab(get().activeTabId, content),
  replaceContentForTab: (tabId, content) =>
    set((state) => {
      // Same-value isDirty guard (F1, see this action's own doc comment on
      // the DocumentState interface above for the full rationale): compare
      // against the TARGET tab's own current content, not the top-level
      // mirror, since tabId may not be the active tab. A tab id that
      // doesn't match any real tab (shouldn't happen in practice) is
      // treated as "changed" -- the pre-existing behavior for an unknown id
      // was already to write through unconditionally, and this guard only
      // narrows that, never widens it.
      const targetTab = state.tabs.find((tab) => tab.id === tabId)
      const contentChanged = targetTab ? content !== targetTab.content : true
      const tabs = state.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, content, isDirty: contentChanged ? true : tab.isDirty } : tab
      )
      // Only refresh the top-level mirror fields (and bump revision, which
      // forces EditorScreen's key={revision} remount) when the target tab
      // is STILL the active one -- mirrors updateContentForTab's own guard
      // above. If the user has since switched away, `tabs` still picks up
      // the new content (so switching back to that tab later shows it),
      // but nothing about what's CURRENTLY on screen changed, so there's
      // nothing to remount.
      if (tabId !== state.activeTabId) return { tabs }
      // revision bumps UNCONDITIONALLY even when content is unchanged --
      // callers like handleSetViewMode rely on the bump alone to force a
      // remount, independent of whether isDirty should change.
      return {
        tabs,
        content,
        isDirty: contentChanged ? true : state.isDirty,
        revision: state.revision + 1
      }
    }),
  clearError: () => set({ error: null }),
  setRemoteImagesAllowed: (tabId, allowed) =>
    set((state) => {
      const tabs = state.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, remoteImagesAllowed: allowed } : tab
      )
      if (tabId !== state.activeTabId) return { tabs }
      return { tabs, remoteImagesAllowed: allowed }
    })
}))
