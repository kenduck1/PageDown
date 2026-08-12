import { create } from 'zustand'
import { tabLabel } from '../lib/tab-label'
import { resolveCachedLocalImage } from '../lib/local-image-cache'

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
  // The 1-based page of THIS document the paginated (Split-mode) preview is
  // showing. Product-completeness audit 2.4: this used to be a single
  // per-WINDOW `appStore.currentPage`, which is the wrong scope by inspection
  // -- "page 7" is a fact about one document, and there is no sense in which
  // two documents share one. Two real symptoms came out of that:
  //   - page 7 of tab A became page 1 on return, because the only thing
  //     stopping tab A's page leaking onto tab B was an `useEffect` in
  //     EditorScreen keyed on document identity that reset it to 1;
  //   - that reset ran AFTER the render that switched tabs, so there was one
  //     committed render in which the new document was on screen carrying the
  //     OTHER document's page number -- passed to the status bar, the Pages
  //     sidebar, and (as `targetPage`) to SplitPreview.
  // Living on the tab removes both by construction rather than by timing:
  // switchTab writes activeTabId and this mirror in the SAME set(), so no
  // render can ever see them disagree, and each tab keeps its own place.
  //
  // Reset is likewise structural, not an effect: every route that puts a
  // DIFFERENT document on screen either builds a fresh DocumentTab (which
  // starts at 1) or focuses an existing one (which keeps its own page).
  currentPage: number
  // Crash protection for a NEVER-SAVED document: the id of this tab's
  // unsaved-draft file (src/main/unsaved-drafts.ts), or `null` when it has
  // none -- which is every tab that either has a real `filePath` (the
  // path-keyed version-history machinery protects those instead) or has not
  // yet reached its first autosave tick.
  //
  // MINTED BY THE MAIN PROCESS, never here, and that is load-bearing rather
  // than incidental. `DocumentTab.id` above is the obvious candidate and is
  // WRONG: generateTabId is a module-level `tab-1`, `tab-2`, ... counter that
  // RESTARTS at 1 on every launch, so it is neither stable across the crash
  // it would have to survive nor unique across launches -- yesterday's
  // `tab-1` and today's would be two different documents sharing one storage
  // key. `draftId` is 128 bits of main-process randomness, handed back by the
  // first `autosaveUnsavedDraft` call and echoed on every later one so a
  // document keeps overwriting ONE draft file rather than leaving one per
  // 45-second tick.
  //
  // INVARIANT: non-null only while `filePath === null`. runSave clears it (and
  // discards the draft) the moment the document gets a real path, so exactly
  // one mechanism protects a document at any time -- see runSave's promotion
  // step and snapshotUnsavedDrafts' own post-await re-check, which both exist
  // to keep this true across their respective await gaps.
  draftId: string | null
}

/**
 * What a save attempt actually did.
 *
 * Reported EXPLICITLY rather than left to be re-derived from store state,
 * because it genuinely cannot be: `'reloaded'` and `'saved'` both leave the
 * tab clean with a fresh mtimeMs, and are indistinguishable afterwards. A
 * caller that inferred success from `isDirty` alone therefore treated a
 * Reload -- which writes nothing and DISCARDS the user's pending edit -- as a
 * completed save. That is precisely how the window-close guard came to close
 * a window whose unsaved work had just been thrown away, with no snapshot
 * anywhere to recover it from.
 *
 * - `saved`     the write happened; the file on disk now holds this content.
 * - `reloaded`  the file had changed on disk and the user chose "Reload" at
 *               the external-change dialog. NOTHING was written, and the
 *               tab's content was replaced with what is on disk -- so the
 *               edit that was about to be saved is gone, deliberately, and
 *               deliberately without a version-history snapshot (see the
 *               reload branch in runSave for why recording one would be
 *               worse). Callers doing something IRREVERSIBLE on the strength
 *               of a save -- closing a window, navigating away, discarding a
 *               tab -- must treat this as "stop", not as success.
 * - `cancelled` no write happened and nothing changed: a cancelled Save-As
 *               dialog, or Cancel at the external-change dialog.
 * - `error`     the attempt threw; the message is in `error`.
 */
export type SaveOutcome = 'saved' | 'reloaded' | 'cancelled' | 'error'

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
  // Mirrors the active tab's own DocumentTab.currentPage -- see that field's
  // own doc comment for why the page belongs to the document rather than to
  // the window.
  currentPage: number
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
  // Product-completeness audit 2.3 (HTML export): a THIRD, independent
  // in-flight guard, not folded into `isExporting` -- PDF export and HTML
  // export are two genuinely different operations a user can trigger from
  // two different toolbar buttons, and sharing one flag would make clicking
  // "Export HTML" grey out "Export PDF" (and vice versa) for no reason; the
  // two don't contend over any shared resource the way PDF export/print do
  // (html-exporter.ts never touches the pagination harness at all -- see
  // its own module comment).
  isExportingHtml: boolean
  // A FOURTH in-flight guard, for the same reason isExportingHtml is a third
  // rather than folded into isExporting: .docx export is its own operation
  // with its own trigger, contends over nothing (it never touches the
  // pagination harness), and sharing a flag would grey out an unrelated
  // export button for the duration.
  isExportingDocx: boolean
  // Product-completeness audit 2.3: "Export gives no feedback." Surfaces the
  // outcome of the most recent SUCCESSFUL Export PDF / Export HTML action as
  // a short-lived notice for EditorToolbar's own Toast (a generic, reusable
  // primitive -- see Toast.tsx -- already used for the undo-barrier notice).
  // Store-owned rather than component-local state, because export has TWO
  // independent triggers per format: this toolbar's own buttons, AND the
  // File menu's Cmd+Shift+E accelerator/menu item (EditorScreen's
  // useMenuCommands calls this SAME store action directly) -- only the store
  // sees both, so only the store can notify regardless of which one fired.
  // `null` between actions and once EditorToolbar's Toast auto-dismisses it
  // via clearExportNotice. A CANCELLED native Save dialog does NOT set this
  // (exportPdf/exportHtml's own `window.api` calls resolve `null` for a
  // cancel, matching print()'s own pre-existing "cancel is not a failure"
  // treatment) -- there is nothing to announce for a choice the user made on
  // purpose.
  exportNotice: { message: string; filePath: string } | null
  // Bumped on every action that changes *what* is displayed for reasons
  // other than an in-place edit -- new tab opened, tab switched, active tab
  // closed -- so EditorScreen's `key={revision}` remounts MilkdownEditor
  // with the newly-active tab's content. Never bumped by updateContent.
  revision: number
  tabs: DocumentTab[]
  activeTabId: string
}

interface DocumentState extends DocumentStateValues {
  // Opens a new, untitled document. REUSES a pristine blank tab (empty, never
  // saved, never touched) when one exists rather than appending beside it --
  // see openDocumentState/isPristineBlankTab for why, and for what "pristine"
  // deliberately excludes.
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
  // Resolves with what the attempt actually DID -- see SaveOutcome, and note
  // in particular that a clean tab afterwards does not imply a successful
  // write. Never rejects.
  save: () => Promise<SaveOutcome>
  // Save As: writes the active tab to a path the user picks in a real native
  // dialog, regardless of whether it already has one. Shares runSave's whole
  // body with save() -- the only differences are that it passes a null target
  // path (which is what makes file-io.ts's saveFile open its Save dialog) and
  // a null mtime baseline. See runSave's own comment for why null is right
  // for the baseline too, rather than merely convenient.
  saveAs: () => Promise<SaveOutcome>
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
  // Product-completeness audit 2.3: HTML export, same shape and same
  // reasoning as exportPdf immediately above (one implementation behind one
  // in-flight guard, friendly-not-raw error text, success surfaced via
  // exportNotice rather than silently discarding the returned path).
  exportHtml: () => Promise<void>
  // .docx (Microsoft Word) export -- same shape and reasoning again. Worth
  // stating where a caller will read it: this is a CONTENT export. Word
  // repaginates with its own layout engine, so exportPdf remains the path for
  // anything where the page layout itself matters.
  exportDocx: () => Promise<void>
  print: () => Promise<void>
  // Dismisses the current export success notice -- called by Toast's own
  // auto-dismiss timer (via EditorToolbar) and available for an explicit
  // dismiss click too. A plain `set` wrapped as a named action rather than a
  // bare `useDocumentStore.setState({ exportNotice: null })` call from
  // EditorToolbar, matching this store's own "screen components call
  // actions, never mutate state directly" convention stated in CLAUDE.md's
  // State management section.
  clearExportNotice: () => void
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
  // Resolves ONE of the active document's own relative local image
  // references to a self-contained `data:` URI, for the Format-mode canvas's
  // image node view (milkdown/image-security.ts). Reads the ACTIVE tab's own
  // filePath internally for the same reason saveDroppedImage does -- the
  // caller is a ProseMirror node view, not a component with store access.
  //
  // Resolves `null` for an unsaved document (no path to resolve against),
  // which is the established, correct "deny all local assets until saved"
  // behaviour every other surface already takes -- and it is enforced HERE
  // as well as in main so an unsaved document does not even generate the
  // IPC traffic. Never rejects and never surfaces an error: a document can
  // legitimately reference an image that is not there yet, and one broken
  // reference must not produce an error banner over the whole document.
  resolveLocalImage: (src: string) => Promise<string | null>
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
  /**
   * Writes an unsaved-draft snapshot for EVERY dirty, never-saved, non-empty
   * tab. Called on useAutosave's tick; never rejects.
   *
   * DELIBERATELY NOT ACTIVE-TAB-ONLY, unlike the path-keyed autosave beside
   * it. `useAutosave` is fed EditorScreen's top-level `content`/`filePath`/
   * `isDirty` mirror fields, so it structurally cannot see a background tab
   * -- a documented, accepted limitation for SAVED documents, where the cost
   * of inheriting it is bounded (the file on disk still holds the last saved
   * state). For a never-saved document that cost is total: the draft is the
   * only copy in existence, so a background untitled tab inheriting that
   * limitation would leave exactly the hole this whole feature exists to
   * close, one tab-switch away. Avoiding it is cheap here precisely because
   * this action reads `tabs` from the store itself rather than taking the
   * document as an argument, so no call site has to know which tab is
   * active.
   *
   * `content !== ''` mirrors isPristineBlankTab's own byte-exact predicate:
   * an empty tab has nothing to recover, and writing one would put an
   * "unsaved document" row on Home for every blank tab ever opened.
   */
  snapshotUnsavedDrafts: () => Promise<void>
  /**
   * Reopens a draft offered by the Home screen's recovery section as a real,
   * dirty, still-untitled tab that keeps writing to the SAME draft file.
   *
   * Lands dirty on purpose, reusing the flag `loadDocument` already threads
   * for autosave-recovered files: a recovered draft genuinely has unsaved
   * changes (it has never been saved anywhere), so it must inherit every
   * existing unsaved-changes protection -- the close/quit guard, the
   * dirty-check before Home navigation, the Save/Don't Save/Cancel prompt --
   * rather than masquerading as a clean document one careless Cmd+W away
   * from being lost a second time.
   *
   * Carrying the ORIGINAL draftId (rather than letting the next tick mint a
   * fresh one) is what stops recovery from doubling the draft: without it,
   * recovering and typing one character would leave two rows on Home, the
   * stale original and the live copy, with nothing to tell them apart.
   *
   * Resolves false when the draft could not be read (already discarded in
   * another window, or removed underneath us) -- the caller removes the row.
   */
  recoverUnsavedDraft: (draftId: string) => Promise<boolean>
  // Closing a dirty tab is a simple in-memory discard for this pass -- no
  // "Save changes before closing?" confirmation. EditorScreen's existing
  // dirty-check-before-navigate flow (window.api.confirmDiscardChanges) only
  // guards leaving the editor screen entirely, not per-tab close. A real
  // tab-close confirmation is deferred, not silently dropped: whatever wires
  // EditorTabBar's close button into real navigation should decide whether
  // to prompt before calling this for a dirty tab.
  closeTab: (tabId: string) => void
  switchTab: (tabId: string) => void
  // Moves an EXPLICIT tab to an explicit final position. `tabs` order is what
  // EditorTabBar renders, so this array IS the tab order -- there is no
  // separate ordering field to keep in sync.
  //
  // Takes a tabId rather than acting on the active tab, following
  // updateContentForTab/replaceContentForTab/setRemoteImagesAllowed: the
  // caller is a drag gesture (or a keyboard reorder) that names the tab it
  // grabbed, and the dragged tab is very often NOT the active one -- dragging
  // a background tab must not first switch to it.
  //
  // CONTRACT: `toIndex` is the index the moved tab ENDS UP AT, in the
  // resulting array -- not an insertion point in the pre-move array. Those
  // two differ by one whenever the tab moves rightward (removing it first
  // shifts everything after it left), which is the classic off-by-one in
  // every hand-rolled array-move; naming the contract as the FINAL index
  // makes both the implementation and every test unambiguous. Out-of-range
  // values are clamped rather than rejected.
  //
  // Deliberately touches NOTHING but the array: not activeTabId (reordering
  // is not selection -- a drag must not steal focus from the document you are
  // editing), not the activeMirror fields (no tab's content/path/dirtiness
  // changed), not `revision` (bumping it would remount MilkdownEditor and
  // destroy the live editor's undo history on every drag), and not isDirty
  // (tab order is window state, not document content -- it is not saved to
  // the .md file and must never make a clean document look unsaved).
  reorderTab: (tabId: string, toIndex: number) => void
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
  // Records which page of the ACTIVE document the paginated preview is on.
  //
  // Deliberately active-tab-scoped (like updateContent, not like
  // updateContentForTab): all three writers -- the status bar's chevrons/jump
  // field, the Pages sidebar, and SplitPreview's own scroll/poll callback --
  // are talking about whatever is currently on screen, and there is no caller
  // that captures a tab id before an await the way handleRestoreVersion does
  // for content.
  //
  // Disclosed, accepted residual (not a regression -- the per-window version
  // had it too, less visibly): SplitPreview's 400ms page poll is a real IPC
  // round trip, so a tick dispatched just before a tab switch can resolve just
  // after it and write the OUTGOING document's page onto the incoming tab. It
  // self-corrects within one poll interval and cannot cause a scroll jump,
  // because SplitPreview writes lastAppliedPageRef before calling
  // onPageChange, so the echoed targetPage is recognised as already-applied.
  // Fixing it properly belongs in SplitPreview (ignore poll results older than
  // the last sendDocument), not in a tab id here -- the closure that would
  // carry the id is re-created with the NEW tab's id on the switch render, so
  // an explicit tabId parameter would not actually catch this case.
  setCurrentPage: (page: number) => void
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
    remoteImagesAllowed: null,
    currentPage: 1,
    // Deliberately null rather than eagerly minted: minting is a main-process
    // IPC round trip, and a blank tab that is never typed into must leave
    // nothing on disk at all. The first autosave tick that finds real content
    // gets the id (see snapshotUnsavedDrafts).
    draftId: null
  }
}

/**
 * A tab holding nothing anybody would miss: never saved to a path, never
 * typed into, byte-empty. Opening a document REPLACES one of these instead of
 * appending beside it (see openDocumentState) -- without that, every single
 * entry into the editor left a stray "Untitled" behind, because this store
 * always seeds one blank tab at construction and every open path appended.
 * Measured on a fresh launch before this fix: one click on "New document"
 * produced TWO identical Untitled tabs, and opening a file or picking a
 * template from Home produced the leftover blank plus the real document.
 *
 * All three conditions are load-bearing, and the second and third are what
 * make this safe rather than merely tidy:
 *   - `filePath === null`: a tab pointing at a real file is a real document
 *     even if its content happens to match what is being opened.
 *   - `content === ''`: an untitled tab that has anything in it -- typed
 *     prose, a template's body, or the frontmatter useCreateDocument applies
 *     from the user's default page config -- is work in progress, not a
 *     placeholder. This is deliberately byte-exact rather than "looks empty"
 *     (trimmed, or frontmatter-only): a whitespace-only or frontmatter-only
 *     document is still something the user or a template produced on purpose,
 *     and the price of getting this predicate WRONG is silently destroying it.
 *   - `!isDirty`: catches the case `content === ''` alone cannot -- typing a
 *     character into an Untitled tab and then deleting it again leaves the
 *     content empty but the document genuinely touched (and it may carry
 *     undo history and an autosave snapshot).
 *
 * `mtimeMs`/`remoteImagesAllowed`/`currentPage`/`draftId` are deliberately not
 * checked: none can be anything but its default on a tab satisfying the three
 * conditions above (mtime only ever arrives alongside a real path, the
 * remote-image banner can only appear for a document that contains remote
 * images, i.e. not an empty one, an empty document is one page, and
 * snapshotUnsavedDrafts refuses to write -- and therefore to mint an id for
 * -- byte-empty content). Checking them would imply they are independent
 * signals, which they are not.
 */
export function isPristineBlankTab(tab: DocumentTab): boolean {
  return tab.filePath === null && tab.content === '' && !tab.isDirty
}

/**
 * The one reducer behind opening a document -- shared by openTab (the tab
 * bar's own "+", which always wants a genuinely new tab) and by
 * newDocument/loadDocument (which reuse a pristine blank one).
 *
 * `reusePristine` is a parameter rather than universal behaviour precisely
 * because those two intents differ: "open this document" should not stack up
 * empty placeholders, while "+" is an explicit request for another blank tab
 * and must never appear to do nothing. That distinction is why this is a
 * shared reducer instead of the reuse being folded into openTab itself.
 *
 * Preference order when reusing: the ACTIVE tab first, then the first
 * pristine tab in document order. Active-first matters -- reusing a pristine
 * background tab while the active one is also pristine would move the user to
 * a different position in the tab bar for no reason.
 */
function openDocumentState(
  state: DocumentStateValues,
  next: {
    filePath: string | null
    content: string
    startDirty: boolean
    mtimeMs: number | null
    reusePristine: boolean
    // Non-null ONLY for recoverUnsavedDraft, which reopens a document that
    // already has a draft file on disk and must keep writing to that same
    // file rather than minting a second one beside it. Every other caller
    // passes null and lets the first autosave tick mint an id.
    draftId?: string | null
  }
): Partial<DocumentStateValues> {
  if (next.filePath !== null) {
    const existing = state.tabs.find((tab) => tab.filePath === next.filePath)
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

  const reusable = next.reusePristine
    ? (state.tabs.find((tab) => tab.id === state.activeTabId && isPristineBlankTab(tab)) ??
      state.tabs.find(isPristineBlankTab))
    : undefined

  const tab: DocumentTab = {
    // Keeps the reused tab's OWN id, rather than minting a fresh one: the id
    // is this tab's React key and its position identity in EditorTabBar, so
    // reusing it makes the document appear in place instead of the tab
    // visibly disappearing and a new one arriving.
    id: reusable?.id ?? generateTabId(),
    filePath: next.filePath,
    content: next.content,
    isDirty: next.startDirty,
    mtimeMs: next.mtimeMs,
    remoteImagesAllowed: null,
    // A freshly-opened document starts at its first page -- including when
    // this reuses a pristine blank tab's id, because that builds a whole new
    // tab object rather than patching the old one. This is what replaced
    // EditorScreen's own identity-keyed "reset currentPage to 1" effect.
    currentPage: 1,
    draftId: next.draftId ?? null
  }
  return {
    tabs: reusable
      ? state.tabs.map((existing) => (existing.id === reusable.id ? tab : existing))
      : [...state.tabs, tab],
    activeTabId: tab.id,
    ...activeMirror(tab),
    error: null,
    // Bumped even when reusing an already-active tab: MilkdownEditor is
    // uncontrolled after mount, so the freshly-opened content only reaches
    // the canvas through EditorScreen's `key={revision}` remount.
    revision: state.revision + 1
  }
}

// Fields that mirror whichever tab is active -- factored out so every action
// that changes the active tab (or the active tab's own fields) sets all of
// them together, keeping `tabs` and the top-level mirror fields from ever
// drifting apart.
function activeMirror(
  tab: DocumentTab
): Pick<
  DocumentTab,
  'content' | 'filePath' | 'isDirty' | 'mtimeMs' | 'remoteImagesAllowed' | 'currentPage'
> {
  return {
    content: tab.content,
    filePath: tab.filePath,
    isDirty: tab.isDirty,
    mtimeMs: tab.mtimeMs,
    remoteImagesAllowed: tab.remoteImagesAllowed,
    currentPage: tab.currentPage
  }
}

const initialTab = createBlankTab()

export const initialDocumentState: DocumentStateValues = {
  ...activeMirror(initialTab),
  error: null,
  isExporting: false,
  isPrinting: false,
  isExportingHtml: false,
  isExportingDocx: false,
  exportNotice: null,
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
async function runSave(forceSaveAs: boolean): Promise<SaveOutcome> {
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
  // Captured synchronously alongside `tabId`, and for exactly the same reason
  // spelled out above: a tab switch during the IPC round trip below would
  // make a resolve-time read describe a different document, and here that
  // would mean discarding an UNRELATED untitled document's only copy.
  const draftIdAtSave =
    useDocumentStore.getState().tabs.find((tab) => tab.id === tabId)?.draftId ?? null
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
        // NOT a save. The user's pending edit has just been discarded in
        // favour of what is on disk, with nothing written and -- per the
        // branch above -- no snapshot recorded either, so there is no copy of
        // it left anywhere. Any caller about to do something irreversible on
        // the strength of "the document is clean now" has to be able to tell
        // this apart from a real write; see SaveOutcome.
        return 'reloaded'
      }
      useDocumentStore.setState((state) => {
        const tabs = state.tabs.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                filePath: result.filePath,
                isDirty: false,
                mtimeMs: result.mtimeMs,
                // PROMOTION. This document now has a real path, so the
                // path-keyed version-history machinery below takes over and
                // this tab must stop being an unsaved draft -- kept in the
                // SAME setState as filePath so no render can ever observe a
                // tab that has both, which is the invariant DocumentTab.
                // draftId documents.
                draftId: null
              }
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
      // The other half of promotion: the draft file itself. The content it
      // holds is now on disk under a real path AND recorded as a
      // version-history snapshot by the line above, so leaving it would put a
      // permanent, un-dismissable "unsaved document" row on the Home screen
      // for a document the user demonstrably DID save -- and offer it back,
      // stale, forever. Fire-and-forget after an already-succeeded save, same
      // best-effort contract (and same ordering) as the snapshot call it
      // follows: a failed discard costs one orphaned row, never the save.
      if (draftIdAtSave !== null) void window.api.discardUnsavedDraft(draftIdAtSave)
      return 'saved'
    }
    // A null result is saveFile's own "no write happened" -- a cancelled
    // Save-As dialog, or Cancel at the external-change dialog. Nothing
    // changed, and the tab is deliberately still dirty.
    return 'cancelled'
  } catch (err) {
    useDocumentStore.setState({ error: errorMessage(err) })
    return 'error'
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
  //
  // Deliberately does NOT reuse a pristine blank tab, unlike
  // newDocument/loadDocument below: its one caller is EditorTabBar's own "+"
  // button, an explicit "give me another blank tab" request, and reuse there
  // would make the button visibly do nothing whenever the current tab happens
  // to be an untouched Untitled -- which is most of the time it gets pressed.
  openTab: (filePath, content, startDirty = false, mtimeMs = null) =>
    set((state) =>
      openDocumentState(state, { filePath, content, startDirty, mtimeMs, reusePristine: false })
    ),
  closeTab: (tabId) => {
    // DISCARD-ON-CLOSE, read and dispatched BEFORE the set() below rather
    // than inside it -- a set() callback is a reducer, and firing IPC from
    // inside one hides a real side effect in something that reads as pure.
    //
    // This one line is what makes "Don't Save" genuinely discard an untitled
    // document, and it is deliberately here rather than at any of the four
    // call sites that ask the question. EVERY discard path in the app ends in
    // closeTab: close-guard.ts's window/quit guard, EditorScreen's "<- Home"
    // handler, and both of its tab-close handlers. Putting the discard at
    // those call sites would mean four copies of it, and the one that got
    // missed would silently resurrect explicitly-discarded work on the next
    // launch -- precisely the failure CLAUDE.md records as this feature
    // area's one shipped Critical bug. Here it is unmissable by construction.
    //
    // Note that the SAVE paths are already safe when they reach this: a
    // successful save promotes the tab (clearing draftId and discarding the
    // draft) before the close, so this finds nothing left to do, and a FAILED
    // save never reaches closeTab at all -- both guards re-read the tab by id
    // and bail while it is still dirty.
    const closing = get().tabs.find((tab) => tab.id === tabId)
    if (closing?.draftId) void window.api.discardUnsavedDraft(closing.draftId)
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
    })
  },
  // See this action's own declaration comment above for the toIndex contract
  // and for why nothing but `tabs` is written. Returning `{}` for a no-op
  // (unknown tab, or a move that would not change the order) matches
  // switchTab/closeTab's own convention and keeps Zustand from notifying
  // subscribers -- which matters here because this fires on every drop,
  // including a drag that ends exactly where it started.
  reorderTab: (tabId, toIndex) =>
    set((state) => {
      const fromIndex = state.tabs.findIndex((tab) => tab.id === tabId)
      if (fromIndex === -1) return {}
      const target = Math.min(Math.max(toIndex, 0), state.tabs.length - 1)
      if (target === fromIndex) return {}
      const next = state.tabs.slice()
      const [moved] = next.splice(fromIndex, 1)
      next.splice(target, 0, moved)
      return { tabs: next }
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
  // newDocument/loadDocument open a NEW tab rather than replacing the active
  // tab's content in place, matching real multi-document-app behavior -- both
  // run the same openDocumentState reducer openTab does, so there is exactly
  // one place ("what does opening a document do") to reason about.
  //
  // They differ from openTab in ONE flag: they REUSE a pristine blank tab
  // (empty, never saved, never touched -- see isPristineBlankTab) instead of
  // appending beside it. Without that, every route into the editor left a
  // stray Untitled behind, because this store seeds one blank tab at
  // construction and nothing ever consumed it: a single "New document" click
  // on a fresh launch produced two identical Untitled tabs, and opening a
  // file or a template produced the leftover blank plus the real document.
  // Multiple blank tabs are still perfectly allowed -- newDocument on a tab
  // that has ANY content (including a template's body, or the frontmatter
  // useCreateDocument applies from the user's default page config) appends,
  // and so does the tab bar's own "+" unconditionally.
  newDocument: (initialContent = '') =>
    set((state) =>
      openDocumentState(state, {
        filePath: null,
        content: initialContent,
        startDirty: false,
        mtimeMs: null,
        reusePristine: true
      })
    ),
  loadDocument: (filePath, content, startDirty = false, mtimeMs = null) =>
    set((state) =>
      openDocumentState(state, { filePath, content, startDirty, mtimeMs, reusePristine: true })
    ),
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
  // See this action's own declaration comment above for why it iterates every
  // tab rather than taking the active document as an argument.
  snapshotUnsavedDrafts: async () => {
    const pending = get().tabs.filter(
      (tab) => tab.filePath === null && tab.isDirty && tab.content !== ''
    )
    if (pending.length === 0) return
    await Promise.all(
      pending.map(async (tab) => {
        try {
          const draftId = await window.api.autosaveUnsavedDraft(tab.draftId, tab.content)
          // Re-validated across the untyped IPC boundary rather than trusting
          // the declared `string | null` return type, the same posture
          // coercePageNavState takes for split-preview:getPage: main returns
          // null for "nothing written", but an `undefined` leaking through
          // would otherwise be written onto the tab as its draft id and then
          // echoed back on the next tick, where it fails validation.
          if (typeof draftId !== 'string' || draftId === '') return
          // Re-read the tab AFTER the await, and re-check that it is still an
          // untitled document. Both matter, and the second is a real race
          // rather than a defensive flourish: the user can hit Cmd+S during
          // this round trip, in which case runSave has ALREADY promoted this
          // tab (draftId null, nothing to discard) and writing the id back
          // would strand a draft file holding pre-save content, offered
          // forever on Home for a document that was saved. Discarding it here
          // is the only moment anything still knows that id exists.
          const current = useDocumentStore.getState().tabs.find((t) => t.id === tab.id)
          if (!current || current.filePath !== null) {
            void window.api.discardUnsavedDraft(draftId)
            return
          }
          if (current.draftId === draftId) return
          useDocumentStore.setState((state) => ({
            tabs: state.tabs.map((t) => (t.id === tab.id ? { ...t, draftId } : t))
          }))
        } catch (err) {
          // Best-effort, matching every other autosave path: a failed tick
          // means slightly less protection until the next one, never an error
          // in front of someone who was only typing.
          console.error('Failed to write unsaved-document draft', err)
        }
      })
    )
  },
  recoverUnsavedDraft: async (draftId) => {
    try {
      const content = await window.api.readUnsavedDraft(draftId)
      if (content === null) return false
      set((state) =>
        openDocumentState(state, {
          filePath: null,
          content,
          startDirty: true,
          mtimeMs: null,
          // Reuses a pristine blank tab, like newDocument/loadDocument and
          // unlike openTab: recovery is "show me this document", not "give me
          // another blank tab", so it must not leave a stray Untitled beside
          // the recovered work.
          reusePristine: true,
          draftId
        })
      )
      return true
    } catch (err) {
      set({ error: errorMessage(err) })
      return false
    }
  },
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
      const result = await window.api.exportPdf(content, filePath, remoteImagesAllowed === true)
      // Product-completeness audit 2.3: this used to discard `result` (and
      // therefore the real written path) entirely -- the button stopped
      // saying "Exporting..." and nothing else ever told the user the export
      // actually happened, let alone where. `result === null` means the user
      // cancelled the native Save dialog -- their own choice, not a failure,
      // so no notice fires for that branch (mirroring print()'s own
      // cancelled-dialog non-error treatment just below).
      if (result) {
        set({
          exportNotice: {
            message: `Exported PDF: ${tabLabel(result.filePath)}`,
            filePath: result.filePath
          }
        })
      }
    } catch (err) {
      // Log the real error for diagnosis, but never put a raw IPC error
      // string in front of the user.
      console.error('Failed to export PDF', err)
      set({ error: 'Failed to export PDF. Please try again.' })
    } finally {
      set({ isExporting: false })
    }
  },
  exportHtml: async () => {
    if (get().isExportingHtml) return
    set({ isExportingHtml: true })
    const { content, filePath, remoteImagesAllowed } = get()
    try {
      const result = await window.api.exportHtml(content, filePath, remoteImagesAllowed === true)
      if (result) {
        set({
          exportNotice: {
            message: `Exported HTML: ${tabLabel(result.filePath)}`,
            filePath: result.filePath
          }
        })
      }
    } catch (err) {
      console.error('Failed to export HTML', err)
      set({ error: 'Failed to export HTML. Please try again.' })
    } finally {
      set({ isExportingHtml: false })
    }
  },
  exportDocx: async () => {
    if (get().isExportingDocx) return
    set({ isExportingDocx: true })
    const { content, filePath, remoteImagesAllowed } = get()
    try {
      const result = await window.api.exportDocx(content, filePath, remoteImagesAllowed === true)
      if (result) {
        set({
          exportNotice: {
            message: `Exported Word document: ${tabLabel(result.filePath)}`,
            filePath: result.filePath
          }
        })
      }
    } catch (err) {
      console.error('Failed to export Word document', err)
      set({ error: 'Failed to export Word document. Please try again.' })
    } finally {
      set({ isExportingDocx: false })
    }
  },
  clearExportNotice: () => set({ exportNotice: null }),
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
  resolveLocalImage: async (src) => {
    const { filePath } = get()
    if (!filePath) return null
    // The cache (lib/local-image-cache.ts) sits between here and IPC, not
    // inside the node view, so a document with the same image referenced
    // many times -- and a document remounted repeatedly by key={revision} --
    // costs one read rather than N. See that module for the TTL/eviction
    // reasoning.
    return resolveCachedLocalImage(filePath, src, window.api.resolveLocalImage)
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
    }),
  // Same finite/floor validation the per-window appStore version carried
  // before this moved (a NaN would render as "Page NaN of 12"), just written
  // through the tab as well as the mirror so the position survives a tab
  // switch. Silently ignores a non-finite page rather than clamping it to 1:
  // clamping would replace a real position with a wrong one, while ignoring
  // leaves the last known-good page in place.
  setCurrentPage: (page) =>
    set((state) => {
      if (!Number.isFinite(page)) return state
      const currentPage = Math.max(1, Math.floor(page))
      return {
        tabs: state.tabs.map((tab) =>
          tab.id === state.activeTabId ? { ...tab, currentPage } : tab
        ),
        currentPage
      }
    })
}))
