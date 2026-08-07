import { useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store/appStore'
import { useDocumentStore } from '../store/documentStore'
import MilkdownEditor, { type MilkdownEditorHandle } from '../milkdown/MilkdownEditor'
import EditorTabBar from '../components/EditorTabBar'
import EditorToolbar from '../components/EditorToolbar'
import EditorSidebar from '../components/EditorSidebar'
import EditorStatusBar from '../components/EditorStatusBar'
import PageSetupModal from '../components/PageSetupModal'
import { extractOutline } from '../lib/extractOutline'
import { usePageCount } from '../hooks/usePageCount'
import { useAutosave } from '../hooks/useAutosave'
import { extractRawFrontmatter, replaceRawFrontmatter } from '../lib/frontmatterSplice'
import {
  DEFAULT_PAGE_CONFIG,
  extractPageConfig,
  applyPageConfig,
  type PageConfig
} from '../../../markdown/page-config'

function EditorScreen(): React.JSX.Element {
  const goHome = useAppStore((state) => state.goHome)
  const pageSetupOpen = useAppStore((state) => state.pageSetupOpen)
  const closePageSetup = useAppStore((state) => state.closePageSetup)
  const filePath = useDocumentStore((state) => state.filePath)
  const content = useDocumentStore((state) => state.content)
  const revision = useDocumentStore((state) => state.revision)
  const activeTabId = useDocumentStore((state) => state.activeTabId)
  const updateContentForTab = useDocumentStore((state) => state.updateContentForTab)
  const replaceContent = useDocumentStore((state) => state.replaceContent)
  const replaceContentForTab = useDocumentStore((state) => state.replaceContentForTab)
  const closeTab = useDocumentStore((state) => state.closeTab)
  const isDirty = useDocumentStore((state) => state.isDirty)
  const error = useDocumentStore((state) => state.error)
  const clearError = useDocumentStore((state) => state.clearError)
  const save = useDocumentStore((state) => state.save)
  const editorRef = useRef<MilkdownEditorHandle>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [activeSourceOffset, setActiveSourceOffset] = useState<number | undefined>(undefined)
  const { pageCount } = usePageCount(content, filePath)
  useAutosave({ content, filePath, isDirty })

  const handleSave = async (): Promise<void> => {
    // @milkdown/plugin-listener's onChange fires through an internal 200ms
    // debounce (see CLAUDE.md) -- if the user clicks Save within that
    // window of their last keystroke, documentStore.content can still hold
    // the PRE-edit value. flush() reads the editor's true current markdown
    // and pushes it through onChange (= updateContent) synchronously, IF
    // AND ONLY IF a real edit happened since mount -- a no-op otherwise, so
    // it's always safe to call defensively here.
    editorRef.current?.flush()
    await save()
  }

  const handleGoHome = async (): Promise<void> => {
    if (!isDirty) {
      goHome()
      return
    }
    const choice = await window.api.confirmDiscardChanges()
    if (choice === 'cancel') return
    if (choice === 'save') {
      editorRef.current?.flush()
      await save()
      // documentStore.save() only ever clears isDirty on a genuine
      // successful save -- checking isDirty (not error) here also catches
      // the case a thrown error wouldn't: the user cancelling the native
      // Save-As dialog for a never-saved document, which resolves save()
      // with no error at all and leaves isDirty untouched. Either way,
      // don't navigate away from a document that wasn't actually written.
      if (useDocumentStore.getState().isDirty) return
    }
    if (choice === 'discard') {
      // "Don't Save" means exactly that -- a pending autosave snapshot must
      // never silently reappear on next open. `clearPendingAutosave` takes
      // ONLY the file path now, not a renderer-supplied cutoff -- a real,
      // shipped bug (found in review) used `new Date().toISOString()` (the
      // moment of this click) as the cutoff, but every snapshot that
      // already exists was written in the PAST relative to "now," so
      // `entry.timestamp > sinceIso` was false for all of them and nothing
      // was ever deleted. The pending snapshot then survived, was more than
      // MTIME_TOLERANCE_MS newer than the file's untouched mtime, and got
      // silently "recovered" on the next open -- the exact failure this
      // feature exists to prevent. The main-process handler now computes
      // the correct cutoff itself, from the validated path's real on-disk
      // mtime (see its own comment in src/main/index.ts) -- not something
      // the renderer can supply, since it has no way to know the mtime
      // anyway. Fire-and-forget: clearPendingAutosave's own IPC handler
      // already validates the path and swallows failures (never rejects),
      // and this runs after the discard decision is already final, so it
      // can't affect navigation either way.
      //
      // Guarded on `filePath` because version-history storage is keyed by
      // path -- an unsaved document has no snapshots to clear (useAutosave
      // never fires without a path either). The tab close below is NOT so
      // guarded: discarded content is discarded content, path or no path.
      if (filePath) {
        void window.api.clearPendingAutosave(filePath)
      }
      // Clearing the snapshots on disk is only half of "Don't Save" -- the
      // other half, missing until the final whole-branch review found it, is
      // the in-memory tab. goHome() only sets `screen: 'home'`; it does not
      // touch documentStore, so the discarded tab used to survive with
      // isDirty: true and the discarded content still in it (the unmount
      // flush() even re-pushed the editor's copy into the store on the way
      // out). The user then returns to the editor later, clicks that old tab,
      // switchTab restores isDirty: true, useAutosave sees a clean->dirty
      // transition, and 45s later writes the DISCARDED content back out as a
      // snapshot -- which the next open silently recovers. A direct reversal
      // of this feature's core promise that a deliberately discarded edit
      // never silently reappears.
      //
      // Closing the tab removes that resurrection path at the source, and is
      // also just the honest reading of the user's choice. Ordered AFTER the
      // clearPendingAutosave dispatch above so the snapshot clear still
      // happens (it only needs `filePath`, already captured, and it's
      // fire-and-forget, so the call is already in flight by this line).
      // Note closeTab never leaves zero tabs: closing the last one replaces
      // it with a fresh blank "Untitled" tab (see documentStore.closeTab), so
      // the store is left in exactly the state a fresh launch would produce.
      // Any late unmount flush() from the outgoing MilkdownEditor targets the
      // now-removed tab id and is a no-op by construction, since
      // updateContentForTab only ever maps over tabs that still exist.
      closeTab(activeTabId)
    }
    goHome()
  }

  // Mirrors handleGoHome above -- same confirm/flush/save/clear-autosave
  // sequence -- but for closing the active tab via EditorTabBar's own "x"
  // button instead of navigating to Home. Only ever invoked for the
  // ACTIVE, dirty tab (EditorTabBar's own guard on `onCloseDirtyActiveTab`
  // ensures that).
  //
  // The 'discard' branch's `filePath` read below is the top-level mirror,
  // same as handleGoHome, and that IS safe: the only await before it is
  // confirmDiscardChanges' own native dialog, and Electron makes that modal
  // to this window (disables it on Windows, sheets it on macOS -- see
  // file-io.ts's confirmDiscardChanges, which passes `win` as the dialog's
  // parent), so no tab switch can happen in that gap.
  //
  // The 'save' branch's post-save check is NOT safe to treat the same way,
  // and must NOT read the top-level isDirty mirror. save() itself is a
  // plain async IPC round trip with no modal dialog whenever the document
  // already has a known path (file-io.ts's saveFile calls writeFile
  // directly; even its Save-As fallback opens dialog.showSaveDialog with no
  // parent window, so it isn't modal either) -- the always-visible
  // EditorTabBar lets the user switch to a DIFFERENT tab while it's in
  // flight. If they do, and THIS tab's save actually failed, the top-level
  // mirror reflects the NEWLY active tab by the time save() resolves: if
  // that other tab happens to be clean, `isDirty` reads false even though
  // the tab actually being closed is still genuinely dirty, and the old
  // mirror-based check would fall through to closeTab(tabId) below --
  // silently discarding real unsaved content whose save just failed. This
  // is the exact race class replaceContentForTab/updateContentForTab and
  // handleRestoreVersion's own post-save guard already exist to close (see
  // their doc comments) -- re-reading the TARGET tab's own entry from the
  // live `tabs` array by id, not the mirror, is required here too.
  const handleCloseDirtyActiveTab = async (tabId: string): Promise<void> => {
    const choice = await window.api.confirmDiscardChanges()
    if (choice === 'cancel') return
    if (choice === 'save') {
      editorRef.current?.flush()
      await save()
      const targetTab = useDocumentStore.getState().tabs.find((tab) => tab.id === tabId)
      if (targetTab?.isDirty) return
    }
    if (choice === 'discard' && filePath) {
      // Same reasoning as handleGoHome's own clearPendingAutosave call --
      // a discarded edit must never silently reappear as "recovered" the
      // next time this file is opened.
      void window.api.clearPendingAutosave(filePath)
    }
    closeTab(tabId)
  }

  // Best-effort DOM-based scroll: the outline (EditorOutline, fed by the
  // same extractOutline used here) and the real mounted editor both derive
  // their heading list from the same document in the same order, so the
  // Nth heading in extractOutline's list is the Nth h1/h2/h3 element
  // actually rendered inside the editor's own DOM. No scroll-to-position
  // API exists on MilkdownEditorHandle (a real ProseMirror-coordinate API
  // is a larger addition, out of scope for this integration pass), so this
  // reads the live DOM directly rather than leaving the callback inert --
  // consistent with this project's "build real behavior when it's cheaply
  // buildable now" convention.
  const handleSelectHeading = (sourceOffset: number): void => {
    setActiveSourceOffset(sourceOffset)
    const headings = extractOutline(content)
    const index = headings.findIndex((heading) => heading.sourceOffset === sourceOffset)
    if (index === -1) return
    const headingEls = canvasRef.current?.querySelectorAll('h1, h2, h3')
    headingEls?.[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // The page card (below) has real padding/blank space beyond the last
  // line of actual content, matching a real sheet of paper -- but unlike a
  // physically-enlarged editable region (an earlier, wrong-goal version of
  // this fix), that blank space isn't itself editable content. This
  // mirrors real editors (Word, Google Docs): clicking below your last
  // line moves the cursor to the nearest REAL position -- the end of the
  // document -- rather than either doing nothing (the bug this fixes) or
  // silently creating new content wherever you clicked (what an enlarged
  // editable region would do).
  //
  // Only acts when the click didn't already land inside the real
  // ProseMirror content -- `.closest('.ProseMirror')` is how every other
  // click (on actual text, actually placing the cursor exactly where
  // clicked) is left alone; this only ever handles the "clicked blank
  // page" case.
  //
  // Delegates to MilkdownEditorHandle.focusEnd() (editor-commands.ts) --
  // two DOM-only approaches were tried first and reverted, both verified
  // NOT to work empirically (document.activeElement stayed <body> either
  // way, checked directly, not assumed): manually setting the native
  // Selection/Range then calling element.focus(), and dispatching
  // synthetic mousedown/mouseup MouseEvents at a computed coordinate.
  // ProseMirror's EditorView owns its own selection state independently of
  // the native DOM Selection and only reacts to a real dispatched
  // transaction or a genuine, OS-trusted input event -- neither of which a
  // JS-constructed MouseEvent/Range is, however plausible either looked.
  //
  // Review-round finding: `.closest('.ProseMirror')` on the CLICK event's
  // own target is not, by itself, a reliable "did the user actually click
  // real content" check. Per the UI Events spec (confirmed against MDN and
  // real Chromium bug reports, not assumed) -- and this app is a Chromium
  // Electron app, so this applies directly -- when a mousedown and the
  // following mouseup land on two DIFFERENT elements (a click-drag text
  // selection, e.g. selecting the last paragraph and releasing slightly
  // past it), the browser fires `click` on the nearest common ancestor of
  // the two, not on either original element. Selecting real text that
  // starts inside `.ProseMirror` and ends (mouse released) in the page
  // card's own blank padding is exactly this case: the resulting click's
  // `target` is the page card div itself (an ancestor of both), which
  // fails the `.closest('.ProseMirror')` check even though the user's
  // whole gesture was a normal in-content selection -- and calling
  // focusEnd() would silently collapse/discard the selection they just
  // made. mouseDownInsideProseMirrorRef, set on this same div's onMouseDown
  // below, tracks where the GESTURE actually started; focusEnd() only
  // fires when both the click's own target AND its originating mousedown
  // were outside real content, so a drag that starts on real text is left
  // alone no matter where the mouse is released.
  const mouseDownInsideProseMirrorRef = useRef(false)

  const handlePageCardMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    mouseDownInsideProseMirrorRef.current = target.closest('.ProseMirror') != null
  }

  const handlePageCardClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    if (target.closest('.ProseMirror')) return
    if (mouseDownInsideProseMirrorRef.current) return
    editorRef.current?.focusEnd()
  }

  // Page Setup itself only edits an in-memory PageConfig draft (see its own
  // module comment) -- reading/writing it into the document's real YAML
  // frontmatter is this integration's job. extractPageConfig/applyPageConfig
  // (src/markdown/page-config.ts) operate on the raw text BETWEEN the `---`
  // fences; frontmatterSplice.ts isolates that text from the full document
  // and splices the updated text back in.
  const pageConfig: PageConfig = useMemo(
    () => ({ ...DEFAULT_PAGE_CONFIG, ...extractPageConfig(extractRawFrontmatter(content)) }),
    [content]
  )

  const handleApplyPageConfig = (config: PageConfig): void => {
    const newRawYaml = applyPageConfig(extractRawFrontmatter(content), config)
    // replaceContent (not updateContent): this edit originates outside the
    // live mounted editor, so the editor must remount to pick it up rather
    // than silently overwrite it on the next real edit -- see
    // documentStore.ts's replaceContent doc comment.
    replaceContent(replaceRawFrontmatter(content, newRawYaml))
    closePageSetup()
  }

  // Returns the underlying flush+Save+replace promise (rather than
  // void-discarding it) so EditorHistory's handleRestore can `await` this
  // before refetching the snapshot list -- without that, the refetch
  // typically resolves before the flush+Save round trip below even starts,
  // returning the same stale list. See EditorHistory.tsx's own comment on
  // its post-restore refetch for the residual gap this doesn't close
  // (documentStore.save()'s own version-history snapshot write stays
  // fire-and-forget, by design, so it can still lag behind this promise's
  // resolution in rare timing).
  const handleRestoreVersion = (restoredContent: string): Promise<void> => {
    // Capture the tab being restored into BEFORE the async gap below -- see
    // documentStore.ts's replaceContentForTab doc comment for the exact
    // race this closes. `activeTabId` here is this render's own hook
    // value, correct as of click time (EditorHistory's restore button is
    // bound to a fresh onClick closure on every render), and determines
    // which tab actually receives the restored content -- regardless of
    // which tab is active by the time flushAndRestore resumes after
    // `await save()`.
    const targetTabId = activeTabId
    const flushAndRestore = async (): Promise<void> => {
      // flush() runs UNCONDITIONALLY, BEFORE anything reads isDirty -- and
      // the dirty check that follows reads the live store, not this render's
      // closed-over `isDirty`. Both halves fix one real bug found in the
      // final whole-branch review.
      //
      // The window: Milkdown's markdownUpdated is 200ms-debounced (see
      // CLAUDE.md), so between a keystroke and that debounce firing, the
      // editor holds a real unflushed edit while documentStore.isDirty is
      // still false. Type a character, then click a History row inside that
      // window, and the OLD code took this path:
      //   1. `isDirty` (bound at render, and genuinely false) => skip flush,
      //      skip save, fall straight through to replaceContentForTab, which
      //      bumps revision.
      //   2. The revision bump remounts MilkdownEditor; the OUTGOING
      //      instance's unmount cleanup calls flush(), which pushes the
      //      unsynced edit through onChange => updateContentForTab, silently
      //      OVERWRITING the content just restored -- and without a revision
      //      bump of its own.
      //   3. The incoming editor is already mounted showing the restored
      //      content and never re-reads the `content` prop (uncontrolled
      //      after mount).
      // End state: the editor DISPLAYS the restored version, the store HOLDS
      // the pre-restore edit, and the user's next Save writes the pre-restore
      // edit to disk. The restore silently didn't happen, with no error shown.
      //
      // Calling flush() first collapses that window: the edit lands in the
      // store synchronously, so the dirty check below sees the truth and the
      // pre-restore Save actually happens. flush() is a documented no-op when
      // nothing has changed since mount (see MilkdownEditorHandle), so making
      // it unconditional costs nothing on a genuinely clean document.
      editorRef.current?.flush()
      // Read the TARGET TAB's own dirty state from the live store rather than
      // the top-level `isDirty` mirror bound at render -- stale for the reason
      // above, and (as with the post-save re-read below) mirror-scoped rather
      // than tab-scoped.
      const dirtyBeforeRestore = useDocumentStore
        .getState()
        .tabs.find((tab) => tab.id === targetTabId)?.isDirty
      if (dirtyBeforeRestore) {
        await save()
        // documentStore.save() never throws -- a failure (disk error, or
        // the user cancelling a Save-As dialog for a never-saved document)
        // is caught into `error` and leaves the target tab's OWN isDirty
        // untouched, i.e. still true. Re-read THAT TAB's entry directly
        // from the live `tabs` array -- NOT the top-level `isDirty`
        // mirror, which by now reflects whichever tab is active, possibly
        // a DIFFERENT one if the user switched tabs (via the
        // always-visible EditorTabBar) during the `await` above. If the
        // target tab is still dirty, its save didn't actually happen, so
        // abandon the restore rather than falling through to
        // replaceContentForTab below, which would silently overwrite and
        // permanently lose content that was never written anywhere. Same
        // guard, same reasoning, as handleGoHome's own save-then-recheck
        // above, just tab-scoped instead of mirror-scoped so it survives a
        // concurrent tab switch. Don't remove this: without it, a failed
        // pre-restore save is a one-click, silent, unrecoverable
        // data-loss path.
        const targetTab = useDocumentStore.getState().tabs.find((tab) => tab.id === targetTabId)
        if (targetTab?.isDirty) return
      }
      replaceContentForTab(targetTabId, restoredContent)
    }
    return flushAndRestore()
  }

  return (
    <div className="flex h-full flex-col bg-canvas font-sans text-text-primary">
      <div className="flex h-10 flex-none items-center gap-3 border-b border-border-chrome bg-chrome-dark px-3">
        <button onClick={() => void handleGoHome()} className="text-12 text-text-secondary">
          ← Home
        </button>
        <span className="text-12 text-text-secondary">{filePath ?? 'Untitled'}</span>
        <button
          onClick={() => void handleSave()}
          className="ml-auto text-12 font-semibold text-accent"
        >
          Save
        </button>
      </div>
      {error && (
        <div className="flex flex-none items-center gap-3 border-b border-border-chrome bg-red-50 px-3 py-2 text-13 text-red-600">
          <span className="flex-1">{error}</span>
          <button onClick={clearError} className="text-12 font-semibold text-red-600">
            Dismiss
          </button>
        </div>
      )}
      <EditorTabBar onCloseDirtyActiveTab={handleCloseDirtyActiveTab} />
      <EditorToolbar editorRef={editorRef} />
      <div className="flex flex-1 overflow-hidden">
        <EditorSidebar
          content={content}
          onSelectHeading={handleSelectHeading}
          activeSourceOffset={activeSourceOffset}
          pageCount={pageCount ?? undefined}
          filePath={filePath}
          onRestoreVersion={handleRestoreVersion}
        />
        <div
          ref={canvasRef}
          data-testid="document-content"
          className="flex-1 overflow-auto"
          style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}
        >
          {/* The "page" card -- per the design handoff (PageDown.dc.html,
              Format-mode mock): a white sheet with a real drop shadow,
              floating on the canvas-gray scroll area, not a flat borderless
              region flush with the background. Was entirely missing before
              this fix -- MilkdownEditor's own root div has no background/
              shadow/width constraint of its own, so the editor rendered as
              plain canvas-gray with no visible document boundary at all.
              Values match the mock's own numbers (640px, 22px/64px/34px
              padding) using tokens that already existed in base.css for
              exactly this purpose (--shadow-page, --color-page) but were
              never applied here.

              Deliberately natural-height (grows/shrinks with the document,
              not stretched to fill the canvas) -- an earlier version of
              this fix tried to make the WHOLE card's blank space part of
              the clickable editable region (via a min-height/flexbox
              chain forcing ProseMirror's own DOM to physically fill the
              card), which was the wrong goal entirely, not just hard to
              get right: a real editor's text only exists where you've
              actually typed content or pressed Enter, so clicking below
              the last real line should move the cursor to the nearest
              real position (the end of the document), not silently start
              new content wherever you happened to click, which is what a
              physically-enlarged editable region would do. handlePageCardClick
              above implements the actual correct behavior instead. */}
          <div
            data-testid="page-card"
            className="mx-auto my-8 max-w-[640px] rounded-sm bg-page pb-[34px] pl-16 pr-16 pt-[22px] shadow-page"
            onMouseDown={handlePageCardMouseDown}
            onClick={handlePageCardClick}
          >
            <MilkdownEditor
              ref={editorRef}
              key={revision}
              content={content}
              // Bound to THIS render's activeTabId, not the bare
              // updateContent store action -- see documentStore.ts's
              // updateContentForTab doc comment for the tab-switch race
              // this closes: any change to activeTabId always bumps
              // revision (remounting this component with a fresh key), so
              // the activeTabId captured here is guaranteed correct for
              // this specific MilkdownEditor instance's entire lifetime,
              // even after a late flush() fires (e.g. on unmount, when the
              // user has switched tabs) well after the store's own
              // activeTabId has moved on.
              onChange={(markdown) => updateContentForTab(activeTabId, markdown)}
              onError={(message) => useDocumentStore.setState({ error: message })}
            />
          </div>
        </div>
      </div>
      <EditorStatusBar
        content={content}
        filePath={filePath}
        isDirty={isDirty}
        zoom={zoom}
        onZoomChange={setZoom}
      />
      <PageSetupModal
        open={pageSetupOpen}
        initialConfig={pageConfig}
        onApply={handleApplyPageConfig}
        onClose={closePageSetup}
      />
    </div>
  )
}

export default EditorScreen
