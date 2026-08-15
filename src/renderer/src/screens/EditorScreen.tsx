import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore, type ViewMode } from '../store/appStore'
import { useDocumentStore } from '../store/documentStore'
import { usePreferencesStore } from '../store/preferencesStore'
import MilkdownEditor, { type MilkdownEditorHandle } from '../milkdown/MilkdownEditor'
import SourceEditor, { type SourceEditorHandle } from '../components/SourceEditor'
import SplitPreview from '../components/SplitPreview'
import EditorTabBar from '../components/EditorTabBar'
import EditorToolbar from '../components/EditorToolbar'
import EditorSidebar from '../components/EditorSidebar'
import EditorStatusBar from '../components/EditorStatusBar'
import PageSetupModal from '../components/PageSetupModal'
import FindBar from '../components/FindBar'
import CommentComposer from '../components/CommentComposer'
import LinkComposer from '../components/LinkComposer'
import RemoteImageBanner from '../components/RemoteImageBanner'
import DocumentWarningsBanner from '../components/DocumentWarningsBanner'
import SelectionBubble from '../components/SelectionBubble'
import SlashMenu from '../components/SlashMenu'
import Toast from '../components/Toast'
import { intersectRect, sameRect, type Rect } from '../lib/floating-position'
import { setCloseGuardFlush } from '../lib/close-guard'
import { tabLabel } from '../lib/tab-label'
import type { SelectionSnapshot } from '../milkdown/selection-plugin'
import { extractOutline } from '../lib/extractOutline'
import { isFormatEditing, isSourceEditing } from '../lib/editing-surface'
import { usePageCount } from '../hooks/usePageCount'
import { useAutosave } from '../hooks/useAutosave'
import { useSplitFollowScroll } from '../hooks/useSplitFollowScroll'
import { useFindController } from '../hooks/useFindController'
import { useFindShortcuts, openFindFromShortcut } from '../hooks/useFindShortcuts'
import { useSlashMenu } from '../hooks/useSlashMenu'
import { useMenuCommands } from '../hooks/useMenuCommands'
import { useFindStore } from '../store/findStore'
import { DEFAULT_ZOOM, nextZoomLevel, previousZoomLevel } from '../lib/zoom-levels'
import { computeFitScale } from '../lib/fit-scale'
import { extractRawFrontmatter, replaceRawFrontmatter } from '../../../markdown/frontmatter-splice'
import { resolvePageConfig, applyPageConfig, type PageConfig } from '../../../markdown/page-config'
import { computePageGeometry } from '../../../typography/page-geometry'
import { computeEditorPagePitchPx, computePageCardMinHeightPx } from '../../../typography/page-seam'
import { resolveDocumentStyle } from '../../../typography/document-style'

// Exact copy pinned in docs/superpowers/specs/2026-08-08-undo-barrier-notice-design.md
// -- a single, direction-agnostic sentence (not "Switched to Source"/"Switched
// to Format") because Split mode's left pane makes "which surface" ambiguous
// to name briefly and accurately; this one sentence covers all four real
// transition pairs that destroy undo history.
const UNDO_BARRIER_TOAST_MESSAGE = 'Undo history resets when switching between Format and Source.'

/**
 * Whether a composer row's captured target document is still the one on
 * screen -- the submit-time half of the audit-2.5 fix (see the capture refs'
 * own comment in EditorScreen for the measured bug and for why the target is
 * `{ tabId, revision }` rather than a tab id alone).
 *
 * Reads the live store rather than taking the current values as arguments,
 * because its callers are click handlers whose enclosing render closure can be
 * arbitrarily old -- the same `getState()` convention handleSetViewMode and
 * handleRestoreVersion already use for exactly this risk.
 *
 * A null target (no composer was ever opened this session) refuses. That
 * direction is deliberate: every real path into these handlers goes through a
 * composer row, which cannot render without having been opened, so a null here
 * means something dispatched a composer command out of band -- and refusing an
 * unexplained write to a document is always the recoverable choice.
 */
function composerTargetIsLive(target: { tabId: string; revision: number } | null): boolean {
  if (!target) return false
  const { activeTabId, revision } = useDocumentStore.getState()
  return target.tabId === activeTabId && target.revision === revision
}

function EditorScreen(): React.JSX.Element {
  const goHome = useAppStore((state) => state.goHome)
  const pageSetupOpen = useAppStore((state) => state.pageSetupOpen)
  // Read here as well as in EditorToolbar (which still renders the Page setup
  // button) because File > Page Setup… is a second, independent trigger --
  // added in the single-row-toolbar pass so the font family/size controls that
  // moved into this dialog gained a keyboard route (Cmd+Shift+P).
  const openPageSetup = useAppStore((state) => state.openPageSetup)
  const closePageSetup = useAppStore((state) => state.closePageSetup)
  const shortcutsHelpOpen = useAppStore((state) => state.shortcutsHelpOpen)
  const commentComposerOpen = useAppStore((state) => state.commentComposerOpen)
  const openCommentComposer = useAppStore((state) => state.openCommentComposer)
  const linkComposerOpen = useAppStore((state) => state.linkComposerOpen)
  const openLinkComposer = useAppStore((state) => state.openLinkComposer)
  // Read here, not just by the composer components themselves: EditorScreen
  // closes both rows when the document they were opened against stops being
  // the one on screen -- see the composer-target refs further down.
  const closeLinkComposer = useAppStore((state) => state.closeLinkComposer)
  const closeCommentComposer = useAppStore((state) => state.closeCommentComposer)
  // No `closeShortcutsHelp` read here anymore -- App.tsx owns the modal's
  // render (and therefore its onClose) as of the product-completeness audit
  // Tier 3, C hoist. `openShortcutsHelp` and `shortcutsHelpOpen` are still
  // read here: this screen still triggers the open (its own Mod-/ listener
  // and `app:shortcuts` menu handler below, both for the closeSlashMenu()
  // side effect that only makes sense while a Milkdown instance exists) and
  // still needs to know whether it's open (SplitPreview's overlayOpen,
  // SelectionBubble's suppressed list).
  const openShortcutsHelp = useAppStore((state) => state.openShortcutsHelp)
  const viewMode = useAppStore((state) => state.viewMode)
  const setViewMode = useAppStore((state) => state.setViewMode)
  const splitLeftMode = useAppStore((state) => state.splitLeftMode)
  // Bound here (not only in EditorToolbar, which no longer renders either
  // control) because View > Split Left Pane and View > Follow Preview Scroll
  // are now the only way to reach them -- see this screen's useMenuCommands
  // map, and EditorToolbar.tsx's header for why they left the toolbar.
  const setSplitLeftMode = useAppStore((state) => state.setSplitLeftMode)
  const toggleSplitFollow = useAppStore((state) => state.toggleSplitFollow)
  const splitRatio = useAppStore((state) => state.splitRatio)
  const setSplitRatio = useAppStore((state) => state.setSplitRatio)
  // Per-TAB now, not per-window (product-completeness audit 2.4) -- "page 7"
  // is a fact about one document. See DocumentTab.currentPage's own comment
  // for the two symptoms that move fixed, including the one committed render
  // in which the new tab showed the old tab's page.
  const currentPage = useDocumentStore((state) => state.currentPage)
  const setCurrentPage = useDocumentStore((state) => state.setCurrentPage)
  const splitFollowEnabled = useAppStore((state) => state.splitFollowEnabled)
  const sidebarVisible = useAppStore((state) => state.sidebarVisible)
  const toggleSidebar = useAppStore((state) => state.toggleSidebar)
  const filePath = useDocumentStore((state) => state.filePath)
  const content = useDocumentStore((state) => state.content)
  const remoteImagesAllowed = useDocumentStore((state) => state.remoteImagesAllowed)
  const revision = useDocumentStore((state) => state.revision)
  const activeTabId = useDocumentStore((state) => state.activeTabId)
  const updateContentForTab = useDocumentStore((state) => state.updateContentForTab)
  const replaceContent = useDocumentStore((state) => state.replaceContent)
  const replaceContentForTab = useDocumentStore((state) => state.replaceContentForTab)
  const closeTab = useDocumentStore((state) => state.closeTab)
  const switchTab = useDocumentStore((state) => state.switchTab)
  const isDirty = useDocumentStore((state) => state.isDirty)
  const error = useDocumentStore((state) => state.error)
  const clearError = useDocumentStore((state) => state.clearError)
  const save = useDocumentStore((state) => state.save)
  const saveAs = useDocumentStore((state) => state.saveAs)
  const exportPdf = useDocumentStore((state) => state.exportPdf)
  // Print and HTML export are now MENU-ONLY (their toolbar buttons went in the
  // single-row-toolbar pass), so these two selectors are the sole remaining
  // call sites for either action.
  const exportHtml = useDocumentStore((state) => state.exportHtml)
  const print = useDocumentStore((state) => state.print)
  const saveDroppedImage = useDocumentStore((state) => state.saveDroppedImage)
  const resolveLocalImage = useDocumentStore((state) => state.resolveLocalImage)
  const editorRef = useRef<MilkdownEditorHandle>(null)
  // One ref is correct even though renderSourceEditor() (below) has two call
  // sites (plain Source mode, and Split mode's left pane) -- the same
  // reasoning editorRef above already relies on for renderPageCard's two
  // call sites: only one of the two SourceEditor instances is ever actually
  // mounted at a time (Split's left-pane ternary and the top-level viewMode
  // ternary are mutually exclusive), so there's never a moment where a
  // second live instance would silently steal this ref out from under the
  // first.
  const sourceEditorRef = useRef<SourceEditorHandle>(null)
  const findQueryInputRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  // The scrolling editor pane -- attached to BOTH pane wrappers below (Split
  // mode's left pane, and the single-pane zoom wrapper). One ref is correct
  // for the same reason editorRef/sourceEditorRef already document: the two
  // are mutually exclusive branches of a ternary, so only one is ever mounted.
  // Its rect, intersected with the canvas's, is the selection bubble's safe
  // area -- the region provably disjoint from Split mode's native preview view.
  const editorPaneRef = useRef<HTMLDivElement>(null)
  const splitRowRef = useRef<HTMLDivElement>(null)
  // Window-scoped, in appStore, NOT `useState` here (product-completeness
  // audit 2.4). Zoom genuinely is a per-window preference -- it describes how
  // big the paper looks on this screen and never reaches the document, the
  // paginator or the PDF -- so it carrying across tabs is correct. What was
  // wrong is that App.tsx unmounts this whole screen on a Home round trip
  // (`{screen === 'editor' ? <EditorScreen /> : null}`), so component-local
  // state silently threw the level away and came back at 100%. See
  // appStore's `zoom` field comment.
  const zoom = useAppStore((state) => state.zoom)
  const setZoom = useAppStore((state) => state.setZoom)
  // Whether the zoom control can actually do anything right now. False in
  // Split mode, whose two-pane row deliberately renders OUTSIDE the zoom
  // wrapper (its right pane is a native WebContentsView positioned from a DOM
  // rect that a CSS scale would silently desync -- see that branch's own
  // comment). Read by the status bar's select, by the three View > Zoom menu
  // commands, and nowhere else. The zoom VALUE is deliberately left alone
  // across the transition rather than reset: a user who chose 150% in Format,
  // glanced at Split and came back should find their document still at 150%.
  // What was wrong was only ever being able to CHANGE it where it has no
  // effect.
  const zoomApplies = viewMode !== 'split'
  const [activeSourceOffset, setActiveSourceOffset] = useState<number | undefined>(undefined)
  // Product-completeness audit Tier 3, B.3: SplitPreview's own onRenderError
  // reports the most recent Split-mode render failure (or null once the next
  // attempt succeeds) -- see EditorStatusBar's own comment for why the
  // status bar, not a new layout row, is where this surfaces. This raw state
  // is NOT reset on leaving Split mode -- deliberately: SplitPreview
  // unmounts on that transition, so nothing would ever clear it again if it
  // stayed stuck, and a `useEffect` calling `setSplitPreviewError` on every
  // `viewMode` change is exactly the synchronous-setState-in-an-effect
  // cascading-render shape this codebase's own lint rule (react-hooks/
  // set-state-in-effect) flags. Gating what's actually PASSED DOWN on
  // `viewMode === 'split'` below (rather than the state itself) is simpler
  // and needs no effect at all: Format/Source mode always sees `null`
  // regardless of what's stored, and re-entering Split mode briefly shows
  // whichever value is left over from the previous session until the fresh
  // mount's own first send resolves -- the same "briefly stale, then
  // corrected" tradeoff `usePageCount` already accepts elsewhere in this
  // file, not a new one.
  const [splitPreviewError, setSplitPreviewError] = useState<string | null>(null)
  // How many page seams the Milkdown canvas is currently drawing, reported up
  // by the page-guide plugin (see createPageGuidePlugin's onSeamCountChanged).
  // The ONLY consumer is the page card's min-height, which is what makes the
  // card as many whole sheets tall as it has boundaries drawn in it. Local
  // component state rather than appStore/documentStore for the same reason
  // `toast`/`splitPreviewError` are: nothing outside this screen needs it.
  //
  // This cannot loop. The plugin reports only on a real CHANGE of count
  // (change-only in its own view.update), and the state it feeds changes only
  // the card's height -- which dispatches no ProseMirror transaction, so
  // there is nothing for the plugin to react to in turn.
  const [pageSeamCount, setPageSeamCount] = useState(0)
  // Ephemeral, EditorScreen-local UI state -- not in appStore/documentStore
  // because nothing else in the app needs it (see design doc's "kept local"
  // rationale). `id` is a monotonically increasing nonce (via the ref below),
  // not the message text, so `key={toast.id}` forces a genuinely fresh Toast
  // mount -- and therefore a freshly-restarted auto-dismiss timer -- even
  // when two triggers in a row produce byte-identical message text.
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null)
  const toastIdRef = useRef(0)
  // The selection bubble's three inputs: WHAT is selected (reported by
  // milkdown/selection-plugin.ts), WHERE it is, and the box it may be drawn
  // in. State rather than refs because the bubble is React-rendered chrome.
  const [selectionSnapshot, setSelectionSnapshot] = useState<SelectionSnapshot | null>(null)
  // Which MilkdownEditor instance the snapshot above came from, as its
  // `revision` key. A snapshot outlives the editor that produced it -- this is
  // plain React state, while the editor it describes is torn down and rebuilt
  // whenever `revision` changes (tab switch, Page Setup apply, History
  // restore, view-mode switch) -- and a snapshot describing a destroyed
  // editor is not a selection. Recorded in the same callback that stores the
  // snapshot (never an effect), so this needs no extra render pass.
  //
  // In practice a freshly mounted editor republishes almost immediately
  // (@milkdown/preset-commonmark's heading-id plugin dispatches a synthetic
  // transaction on every mount, which the selection plugin's view.update
  // reports), but "almost immediately" is exactly the kind of unverified
  // timing assumption this file avoids leaning on -- and the observable cost
  // of being wrong is the audit-2.5 stale prefill: the Insert link row opening
  // with the PREVIOUS document's href already typed in it.
  const [selectionRevision, setSelectionRevision] = useState(revision)
  const [selectionAnchor, setSelectionAnchor] = useState<Rect | null>(null)
  const [selectionSafeRect, setSelectionSafeRect] = useState<Rect | null>(null)

  // Measures both rects and publishes them, skipping the setState entirely
  // when nothing actually moved (sameRect) -- this runs on every scroll tick
  // while the bubble is up, and an unguarded setState there would re-render
  // this whole screen per tick.
  //
  // Called from a ProseMirror view.update callback and from the bubble's own
  // scroll/resize listeners -- never from an effect body, which is both what
  // react-hooks' set-state-in-effect rule wants and simply the right place:
  // the selection's on-screen box is only knowable at the moments something
  // moved it, and both of those moments are already callbacks.
  //
  // Measured UNCONDITIONALLY, including for a collapsed selection (where the
  // rect is a caret box): SelectionBubble's own visibility rules decide what
  // to do with it, and branching here would just be a second, drifting copy of
  // those rules.
  // The measurement itself, with NO state of its own -- split out from
  // measureSelectionGeometry below so the two composer popovers can call it
  // directly. FloatingCard owns its own rect state and reads it through this
  // at mount and on every scroll/resize tick, which is what lets it be placed
  // correctly in the SAME commit that opens it (see that component's own
  // `measure` doc comment). Sharing one reader rather than giving the
  // composers a second copy is the same rule findAncestorListType follows: an
  // anchor computed two ways is an anchor that can disagree with itself.
  const readSelectionGeometry = useCallback((): { anchor: Rect | null; safe: Rect | null } => {
    // getTableRect FIRST, falling back to the selection rect. It returns
    // non-null only for a COLLAPSED selection inside a table -- the one case
    // where a caret-derived anchor cannot be kept fresh, because sameSnapshot
    // deliberately ignores collapsed positions (that exemption is what stops
    // typing costing a React render per character). See readTableRect's own
    // doc comment for the full argument.
    const commands = editorRef.current
    const anchor = commands ? (commands.getTableRect() ?? commands.getSelectionRect()) : null
    const pane = editorPaneRef.current
    const canvas = canvasRef.current
    const safe =
      pane && canvas
        ? intersectRect(canvas.getBoundingClientRect(), pane.getBoundingClientRect())
        : null
    return { anchor, safe }
  }, [])

  const measureSelectionGeometry = useCallback((): void => {
    const { anchor, safe } = readSelectionGeometry()
    setSelectionAnchor((prev) => (sameRect(prev, anchor) ? prev : anchor))
    setSelectionSafeRect((prev) => (sameRect(prev, safe) ? prev : safe))
  }, [readSelectionGeometry])

  const handleSelectionChanged = useCallback(
    (snapshot: SelectionSnapshot | null): void => {
      setSelectionSnapshot(snapshot)
      setSelectionRevision(useDocumentStore.getState().revision)
      measureSelectionGeometry()
    },
    [measureSelectionGeometry]
  )

  // The snapshot, but only while it still describes the editor that is
  // actually mounted (see selectionRevision above). Everything that reads a
  // selection reads THIS, not the raw state: the toolbar's pressed states, the
  // selection bubble, and the link composer's prefill would each otherwise
  // describe a document that is no longer on screen.
  const liveSelection = selectionRevision === revision ? selectionSnapshot : null
  // The slash-menu controller (hooks/useSlashMenu.ts) -- owns its own
  // ephemeral state, its own capture-phase scroll listener, and the
  // onChoose/onHover bridge into the live Milkdown editor, so this screen
  // only has to wire its three inputs (editorRef, and the same
  // canvasRef/editorPaneRef the selection bubble's own safe-rect
  // intersection already uses) and render the result. See that hook's own
  // header comment for why it owns the listener itself rather than
  // delegating back up through a callback the way SelectionBubble does.
  const slashMenu = useSlashMenu({ editorRef, canvasRef, editorPaneRef })
  const showUndoBarrierToast = (): void => {
    toastIdRef.current += 1
    setToast({ id: toastIdRef.current, message: UNDO_BARRIER_TOAST_MESSAGE })
  }
  // `loading` is consumed, not discarded: it is the status bar's in-progress
  // indicator (see EditorStatusBar's own `pageCountPending` doc comment and
  // design:189). It was computed and thrown away here for as long as this
  // hook has existed, which is why the "never blank or flickering"
  // requirement had only its blank half solved.
  const {
    pageCount,
    loading: pageCountPending,
    warnings: documentWarnings,
    pageBreaks,
    blockCount
  } = usePageCount(content, filePath, undefined, remoteImagesAllowed === true)
  // undefined (not preferences?.autosaveIntervalMs ?? somethingElse) when
  // preferences haven't loaded yet -- useAutosave's own default parameter
  // already falls back to the pre-existing 45s constant in that case, so
  // there's no need to duplicate that fallback value here too.
  const autosaveIntervalMs = usePreferencesStore((state) => state.preferences?.autosaveIntervalMs)
  useAutosave({ content, filePath, isDirty, intervalMs: autosaveIntervalMs })
  // Same narrow, single-field selector style as autosaveIntervalMs above --
  // backs handleAddComment below.
  const authorName = usePreferencesStore((state) => state.preferences?.authorName)

  // NOTE (product-completeness audit 2.4): the identity-keyed
  // `useEffect(() => setCurrentPage(1), [activeTabId, filePath])` that used to
  // sit here is GONE, and must not come back. It existed only because
  // `currentPage` was per-window; the page now lives on the tab
  // (DocumentTab.currentPage), so a fresh document starts at 1 because its tab
  // object does, and returning to a tab restores the page you left it on.
  // The effect was also strictly worse than storing the value: it ran after
  // the switching render committed, so for one frame the new document was on
  // screen carrying the OTHER document's page -- fed to the status bar, the
  // Pages sidebar, and SplitPreview's `targetPage`. Reinstating any
  // reset-on-switch effect here would reintroduce exactly that window.
  //
  // The page count can SHRINK under an edit while `currentPage` still points
  // past the new end, so clamp for display rather than trusting the stored
  // value. The sandbox clamps for real on its side too (it is the only thing
  // that knows what actually rendered) and reports back through
  // onPageChange; this is the renderer-side half, covering the window before
  // that round trip lands.
  const effectiveCurrentPage = pageCount ? Math.min(currentPage, pageCount) : currentPage

  // Which editing surface Find should search -- see lib/editing-surface.ts's
  // own comment for why this can't be answered from viewMode alone (Split
  // mode's left pane is itself Format or Source editing, just laid out
  // differently).
  const sourceEditing = isSourceEditing(viewMode, splitLeftMode)
  const findController = useFindController({
    content,
    activeTabId,
    revision,
    sourceEditing,
    editorRef,
    sourceRef: sourceEditorRef,
    updateContentForTab
  })
  // Cmd/Ctrl+F -- this app's first and only keyboard shortcut (see
  // useFindShortcuts.ts's own module comment for why it's a bare `window`
  // listener rather than a real app-menu accelerator). getSelectedText comes
  // from the controller above, not a locally-defined function, so seeding the
  // query always reads from whichever editing surface is actually live.
  useFindShortcuts({
    getSelectedText: findController.getSelectedText,
    queryInputRef: findQueryInputRef
  })

  // The keyboard-shortcuts reference modal's own open shortcut -- same bare
  // `window` keydown listener pattern useFindShortcuts.ts established (see
  // that file's own module comment for why there's no real app Menu
  // accelerator yet), inline here rather than factored into its own hook
  // file: unlike Find, this has no selection-seeding logic to justify a
  // separate module, just "open a modal." Mod-/ (not `?` alone, which would
  // fire on every literal `/` a user types while editing) is the common
  // convention this mirrors (VS Code, Linear, Slack, ...). Escape-to-close
  // is NOT handled here -- both modals now own real Escape/focus-trap/
  // focus-restore behavior via useModalDialog.ts (see its header comment),
  // called from inside PageSetupModal/ShortcutsHelpModal themselves, which
  // is also why a stray Escape here can never race the slash menu's own
  // Escape handler (slash-plugin.ts's handleKeyDown, scoped to the
  // ProseMirror view's own DOM node): useModalDialog's focus-in moves DOM
  // focus into the modal the instant it opens, and the editor's
  // contenteditable node cannot hold focus -- and therefore cannot be the
  // target of a keydown -- while a modal does.
  //
  // Product-completeness audit Tier 3, C: App.tsx now owns a SECOND, more
  // general Mod-/ listener (and the modal's actual render) so the shortcuts
  // reference is reachable from Home/Settings too, not just from inside a
  // document. This listener stays, deliberately not removed in favor of
  // that one: its real job is the SYNCHRONOUS closeSlashMenu() call just
  // below, which only means anything while a live Milkdown instance exists
  // (i.e. only ever while this screen is mounted) -- see that call's own
  // comment for why a render-later effect isn't fast enough to replace it.
  // Both listeners firing in the same tick whenever this screen happens to
  // be mounted is harmless: `openShortcutsHelp()` is an idempotent "set
  // true" store action either way.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === '/') {
        event.preventDefault()
        // Slash menu (Task 5 addition): closes any open slash session
        // SYNCHRONOUSLY, in this same tick -- useModalDialog's own focus-in
        // effect (ShortcutsHelpModal) also blurs the editor, which the slash
        // plugin's own blur handler independently closes on, but that only
        // runs after the modal's state update is committed and its effect
        // fires, a render (or more) later. Without this explicit call, the
        // slash menu would stay visibly open, rendered underneath the
        // newly-opened modal, for that whole window. Calling it here too is
        // therefore not redundant with the later blur -- it's what makes the
        // close visually immediate -- and it's a documented no-op
        // (closeSlashIn) if no session is open, so calling it unconditionally
        // is free. See MilkdownEditorHandle.closeSlashMenu()'s own doc
        // comment in editor-commands.ts.
        editorRef.current?.closeSlashMenu()
        openShortcutsHelp()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [openShortcutsHelp])

  // Add-comment shortcut -- same bare `window` keydown pattern, same
  // "inline rather than its own hook file" reasoning as the shortcuts-help
  // listener immediately above (a one-line action, no selection-seeding/
  // focus-management to justify a separate module the way Find's does).
  // Mod-Shift-M mirrors this app's OWN established "Mod-Shift-X" shortcut
  // shape (Redo is Mod-Shift-z) rather than copying Word/Google Docs'
  // Ctrl+Alt+M convention verbatim -- consistency with this app's other
  // shortcuts matters more here than matching an external app exactly, and
  // neither Word nor Docs' own binding is even the SAME across their two
  // platforms' conventions to begin with. No live selection/view-mode check
  // here, matching the toolbar's own "Add comment" button precedent (see
  // EditorToolbar.tsx's own comment): addCommentCommand's own refusal
  // (empty selection, Source mode's null editorRef, a selection spanning
  // multiple blocks) is what the composer surfaces as a real inline error;
  // duplicating that check here would just be a second, potentially
  // drifting copy of the same logic.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault()
        useAppStore.getState().openCommentComposer()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Which document each composer ROW was opened against (product-completeness
  // audit 2.5). Both composers are layout rows that leave the whole app --
  // including the tab bar -- live and clickable, and both act through
  // `editorRef`, which always points at whichever MilkdownEditor is mounted
  // RIGHT NOW. Measured consequence: select text in tab A, open Insert link,
  // click tab B, press Insert, and the link landed in tab B. Same shape for
  // Add comment, and the composer's own prefill (`initialHref`, derived from
  // the outgoing document's selection snapshot) was stale on top of it.
  //
  // Captured as `{ tabId, revision }` rather than a tab id alone, because tab
  // identity is not quite the question. What has to still be true at submit
  // time is "the editor instance holding the selection this composer was
  // opened against is still the one on screen," and `revision` is exactly that
  // signal: EditorScreen keys MilkdownEditor on it, so every remount -- a tab
  // switch, a Page Setup apply, a History restore, a view-mode switch, and
  // notably a DIFFERENT document loaded into the SAME tab (openDocumentState
  // reusing a pristine blank tab keeps its id, so a tab-id-only check would
  // pass) -- changes it. The tab id is kept alongside it because it is the
  // thing that actually names the document, matching how
  // setRemoteImagesAllowed/updateContentForTab/replaceContentForTab all take
  // an explicit tab id for this same class of race; requiring BOTH to match
  // means neither signal alone has to be perfect.
  //
  // Written from an effect keyed on the open flags -- deliberately NOT from
  // the store actions that open the composers, because those are called from
  // three different places (the toolbar's buttons, the selection bubble, and
  // the Mod-Shift-M shortcut) and one of them, EditorToolbar, calls
  // appStore.openLinkComposer/openCommentComposer directly. Capturing here
  // covers every opener at once with no change to the store's API.
  const linkComposerTargetRef = useRef<{ tabId: string; revision: number } | null>(null)
  const commentComposerTargetRef = useRef<{ tabId: string; revision: number } | null>(null)

  useEffect(() => {
    if (!linkComposerOpen) return
    const { activeTabId: tabId, revision: rev } = useDocumentStore.getState()
    linkComposerTargetRef.current = { tabId, revision: rev }
  }, [linkComposerOpen])

  useEffect(() => {
    if (!commentComposerOpen) return
    const { activeTabId: tabId, revision: rev } = useDocumentStore.getState()
    commentComposerTargetRef.current = { tabId, revision: rev }
  }, [commentComposerOpen])

  // ...and close both rows as soon as that document is no longer the one on
  // screen. This is the USER-VISIBLE half of the 2.5 fix: a composer opened
  // over a selection in another document has nothing left to act on, so it
  // goes away with the document rather than sitting there looking usable and
  // then refusing. Keyed on `revision` alone because revision changes on every
  // one of the transitions above (including every tab switch --
  // switchTab/openTab/closeTab all bump it), so this cannot miss a case that
  // the submit-time guards below would catch.
  //
  // Zustand actions, not React setState, so this does not trip
  // react-hooks/set-state-in-effect (the same reason useFindController can
  // call setMatches from an effect). Both closes are idempotent "set false"
  // actions, so running this on mount -- and on a revision bump with nothing
  // open -- costs nothing.
  useEffect(() => {
    closeLinkComposer()
    closeCommentComposer()
  }, [revision, closeLinkComposer, closeCommentComposer])

  // Publishes the live Milkdown flush to the window-close guard, which runs
  // from App.tsx (the only component mounted on every screen) and so has no
  // way to reach `editorRef` itself. Without it, closing the window within
  // 200ms of a keystroke would read a stale `isDirty: false` and close with no
  // prompt -- the same debounce race handleSave's own flush() call exists for.
  // Cleared on unmount so a stale handle can never be called against a
  // destroyed editor.
  useEffect(() => {
    setCloseGuardFlush(() => editorRef.current?.flush())
    return () => setCloseGuardFlush(null)
  }, [])

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

  // Same flush-then-write contract as handleSave above -- Save As must not
  // write a document that is 200ms stale any more than Save must.
  const handleSaveAs = async (): Promise<void> => {
    editorRef.current?.flush()
    await saveAs()
  }

  // EditorToolbar's mode-switcher calls this instead of appStore's setViewMode
  // directly, so the two directions that need coordination with the live
  // Milkdown editor instance actually get it -- see
  // docs/superpowers/specs/2026-08-07-source-mode-design.md (the original
  // format<->source contract) and
  // docs/superpowers/specs/2026-08-07-split-mode-design.md (this function's
  // generalization onto Split mode, Task 5) for why both calls below are
  // necessary, not just one.
  //
  // Split mode's left pane IS Format or Source editing, just in a different
  // layout (see renderPageCard/renderSourceEditor below, each called from
  // BOTH its own plain-mode branch and Split's left-pane ternary) -- so
  // "am I currently in/entering Format editing" has to mean "plain Format
  // mode OR Split mode with a Format left pane," and likewise for Source.
  // isFormatEditing/isSourceEditing below are exactly that predicate, and
  // note they close over `currentSplitLeftMode` alone (read once, via
  // getState(), same as everything else in this function) -- correct
  // because `mode`/`currentViewMode` are the segmented control's own
  // Format/Split/Source argument, and splitLeftMode itself never changes as
  // part of THIS transition (that's the toolbar's separate splitLeftMode
  // toggle, calling appStore's setSplitLeftMode directly -- see
  // EditorToolbar.tsx -- which does not call this function or flush/remount
  // at all; it doesn't need to, for the same JSX-type-swap reason explained
  // in the finding below, just within Split's own left-pane ternary instead
  // of this function's format/split/source ternary).
  //
  // Anything-not-Format-editing -> Source editing: MilkdownEditor's onChange
  // is 200ms-debounced (see CLAUDE.md's Milkdown section). Without flush()
  // first, the incoming Source-editing surface could read
  // documentStore.content before a very recent edit has synced through,
  // showing stale text the instant you switch. Originally guarded on
  // `mode === 'source' && currentViewMode !== 'source'` rather than the
  // narrower `currentViewMode === 'format' && mode === 'source'` (fix-round
  // finding, F4, from the Source mode sub-project) specifically because the
  // narrower form skipped the flush on a 'split' -> 'source' transition --
  // at the time hypothetical (Split mode wasn't built yet), now real. The
  // isFormatEditing/isSourceEditing predicates below are the natural
  // generalization of that same fix: `enteringSourceEditing &&
  // leavingFormatEditing` covers format->source, split(format)->source,
  // format->split(source), AND split(format)->split(source) uniformly,
  // rather than re-deriving F4's fix by hand for each new mode pairing.
  // flush() is a documented no-op when nothing changed since mount, so this
  // condition being broad is free.
  //
  // Leaving Source editing -> entering Format editing: MilkdownEditor is
  // uncontrolled after mount (content only seeds defaultValueCtx once, at
  // construction) and Source mode writes directly to documentStore.content
  // through a path Milkdown's own instance never observes. replaceContentForTab's
  // real job here is its revision bump (a plain updateContentForTab call
  // would leave MilkdownEditor's key={revision} unchanged, so it would NOT
  // remount, and would keep showing whatever it had in memory from before
  // Source editing was entered) -- forcing EditorScreen's key={revision} to
  // remount MilkdownEditor and re-seed defaultValueCtx from the now-current
  // content, the same mechanism newDocument/loadDocument/Page-Setup-apply
  // already rely on. The content argument is the CURRENT content (already
  // fully synced by every Source-mode keystroke's own updateContentForTab
  // call -- see SourceEditor's own contract), so this is a same-value
  // rewrite whose only real effect on CONTENT is the revision bump, not a
  // second content write -- and, as of the same-value isDirty guard
  // replaceContentForTab itself now carries (F1, see documentStore.ts's own
  // doc comment on that action), it genuinely has no OTHER effect either:
  // before that guard existed, this same-value rewrite still forced
  // isDirty: true unconditionally, so a Format -> Source -> Format round
  // trip with zero real edits marked a clean, untouched document dirty.
  // Don't reintroduce that by calling a different store action here or
  // bypassing the guard -- this call depends on it now.
  //
  // Reads `viewMode`/`splitLeftMode`/`content`/`activeTabId` via getState()
  // rather than the render closure (fix-round finding, F6, from the Source
  // mode sub-project) -- this handler is synchronous end to end
  // (flush()/replaceContentForTab/setViewMode all run in the same click
  // handler with no `await` in between), so a stale closure read is not
  // reachable today the way it is for handleRestoreVersion's own post-save
  // guard below. But this file already establishes the getState()
  // convention for exactly this risk class, and a stale read here would be
  // a genuine clobber if that synchronous-handler property ever stopped
  // holding, so matching the convention costs nothing.
  //
  // Task 5 finding (Split mode sub-project) -- an UPDATE to a claim the
  // Source mode sub-project's own fix-round-1 finding made here, not a
  // restatement of it. That finding predicted both calls below would become
  // "genuinely load-bearing... the moment this JSX structure changes (e.g. a
  // future Split mode that keeps both editors permanently mounted)." Having
  // now built that Split mode (see the `document-content` JSX below), the
  // answer, checked deliberately rather than assumed: BOTH calls are STILL
  // currently belt-and-braces, not yet the sole reason either observable
  // outcome holds -- the predicted moment has not actually arrived, because
  // this implementation's JSX does NOT keep both editors permanently
  // mounted. `document-content`'s top level is `viewMode === 'split' ? (two
  // -pane row) : (single-pane view)` -- a ternary, not a shared position --
  // so the Format branch's page-card (inside the ternary's false side) and
  // Split(format)'s page-card (inside the true side's own left-pane
  // ternary) sit at completely different positions in the render tree.
  // React reconciles a ternary swap between two structurally different
  // subtrees as a full unmount-then-mount of whatever's inside, exactly the
  // same "type-swap-forces-remount" mechanism the original Source mode
  // finding described for the plain Format/Source conditional -- Split mode
  // didn't remove that mechanism, it just added more transitions that ride
  // on it too. Precisely (fix-round-1 wording tightened -- an earlier draft
  // of this paragraph said "every transition... unmounts MilkdownEditor...
  // regardless," which overstated it: only ONE direction of each pair
  // actually unmounts an existing instance; the reverse direction is a
  // fresh mount, not an unmount, because there was no MilkdownEditor
  // mounted beforehand to tear down):
  //
  // (1) Every transition that LEAVES Format editing (format->source,
  // split(format)->source, format->split(source)) unmounts the MilkdownEditor
  // instance that was actually on screen, via that ternary swap.
  // MilkdownEditor's own unmount cleanup (MilkdownEditor.tsx) already calls
  // its internal flushRef.current?.() before editor.destroy() -- so an
  // unflushed edit reaches the store via that path even without this
  // handler's own flush() call.
  //
  // (2) Symmetrically, every transition that ENTERS Format editing
  // (source->format, source->split(format), split(source)->format) mounts a
  // FRESH MilkdownEditor instance (there was none to unmount), which reads
  // the CURRENT `content` prop at mount time regardless of whether
  // key={revision} changed -- so replaceContentForTab's revision bump is,
  // right now, also not the sole reason Source-editing edits survive a
  // switch to Format editing.
  //
  // (2b) format<->split(format) is a special case worth naming separately:
  // by this function's own four-boolean model it is NEITHER entering NOR
  // leaving Format editing (both sides count as the identical editing
  // surface, so neither call below fires for it) -- but the JSX still tears
  // the DOM instance down and rebuilds it in EITHER direction regardless,
  // because the page-card literally lives at two different structural
  // positions (the plain Format branch vs. Split's nested left-pane
  // branch). That unmount/mount pair is a raw consequence of the ternary's
  // SHAPE, unrelated to what this function classifies the transition as --
  // it's why the Task 5 finding above can say Split mode still doesn't keep
  // both editors permanently mounted, even for the one pair this function
  // itself treats as a no-op.
  //
  // (3) The NEW splitLeftMode toggle (not this function -- see
  // EditorToolbar.tsx's own onClick, which has a matching comment) rides
  // the identical safety net one level down: Split's own left-pane ternary
  // (`splitLeftMode === 'source' ? renderSourceEditor() : renderPageCard()`)
  // is exactly the same kind of type-swap, which is why that toggle can
  // safely call setSplitLeftMode directly with no flush/remount
  // coordination of its own -- verified directly, not just argued from this
  // mechanism, by EditorScreen.test.tsx's 'toggling splitLeftMode... does
  // not lose an in-flight edit' tests (real MilkdownEditor, a real
  // unflushed DOM edit, a real click on the real toggle button).
  //
  // Both calls below are kept anyway -- mandated by the plan and
  // docs/superpowers/specs/2026-08-07-split-mode-design.md, and each would
  // become genuinely load-bearing if a FUTURE change restructured
  // `document-content` so the SAME MilkdownEditor instance's tree position
  // survived a Format<->Split(format) (or any other now-safety-netted)
  // transition -- e.g. a single persistent left-pane slot rendered
  // unconditionally, with only its ternary contents and the right pane's
  // presence varying by viewMode, rather than the whole two-pane row living
  // behind its own top-level ternary the way it does today. Precisely
  // because today's observable outcomes still don't discriminate between
  // "this call did it" and "an unrelated mechanism did it," the tests
  // covering these two calls remain spy/mutation-based rather than
  // outcome-only, and now cover every format<->source pair Split mode
  // introduces, not just the two the initial Task 5 pass happened to add:
  // EditorScreen.test.tsx's 'switching Source -> Format...', 'switching
  // Split(source) -> Format...', and 'switching Source -> Split(format)...'
  // tests spy on replaceContentForTab directly (the unmount/onChange path
  // only ever calls updateContentForTab, never that), and
  // EditorScreen.viewMode.test.tsx module-mocks MilkdownEditor with a fake
  // that has no unmount auto-flush, so flush() calls on its handle can only
  // come from this function -- exercised there for format<->source,
  // format<->split(source), split(source)<->format, and
  // split(format)<->source alike. Fix-round-1 also mutation-verified the two
  // newest tests (the split(format)<->source pair) genuinely discriminate --
  // see task-5-report.md's "Fix round 1" section for the real commands/
  // output, not just the claim.
  const handleSetViewMode = (mode: ViewMode): void => {
    const { viewMode: currentViewMode, splitLeftMode: currentSplitLeftMode } =
      useAppStore.getState()
    const { activeTabId: currentActiveTabId } = useDocumentStore.getState()

    // isFormatEditing/isSourceEditing now come from lib/editing-surface.ts --
    // useFindController (Find & Replace sub-project) needs the identical
    // predicate to decide what Find searches, and duplicating the
    // format/split(format) OR source/split(source) logic in two places would
    // let them silently drift. The shared versions take TWO arguments
    // (viewMode, splitLeftMode) where these old local closures took one
    // (closing over currentSplitLeftMode) -- called below as
    // `isFormatEditing(mode, currentSplitLeftMode)`/
    // `isSourceEditing(mode, currentSplitLeftMode)`/etc, which is exactly
    // equivalent to the old closures for every call site here, since
    // currentSplitLeftMode itself never changes as part of this transition
    // (see the surrounding comment block above for why that still holds).
    const enteringFormatEditing =
      isFormatEditing(mode, currentSplitLeftMode) &&
      !isFormatEditing(currentViewMode, currentSplitLeftMode)
    const leavingFormatEditing =
      isFormatEditing(currentViewMode, currentSplitLeftMode) &&
      !isFormatEditing(mode, currentSplitLeftMode)
    const enteringSourceEditing =
      isSourceEditing(mode, currentSplitLeftMode) &&
      !isSourceEditing(currentViewMode, currentSplitLeftMode)
    const leavingSourceEditing =
      isSourceEditing(currentViewMode, currentSplitLeftMode) &&
      !isSourceEditing(mode, currentSplitLeftMode)

    // Fix-round finding (Split mode final whole-branch review, C1 -- a real,
    // reproduced data-loss bug, not theoretical): format<->split(format) is
    // classified as NEITHER entering NOR leaving Format editing by the two
    // booleans above (both sides are "Format editing"), so neither branch
    // below used to fire for it -- but the JSX still tears down and rebuilds
    // MilkdownEditor across this transition regardless (see this function's
    // own (2b) comment above: the page-card lives at two different
    // structural positions, the single-pane branch and Split's left-pane
    // branch, and React reconciles a swap between them as a real unmount+
    // mount). Reproduced: switching format->split(format) or back within
    // Milkdown's 200ms debounce window silently reverted an unflushed edit,
    // and it became permanently lost the moment the user typed again (the
    // freshly-mounted instance seeded itself from the STALE `content` value
    // captured by the render that triggered the swap -- one render tick
    // before the outgoing instance's own unmount-triggered flush had a
    // chance to update the store, since React runs unmount effects, then
    // mount effects, strictly AFTER the render that decided to swap the
    // tree, not before). `formatEditingPositionChanges` names this missing
    // case explicitly and feeds it into both branches below, exactly
    // mirroring the review's own stated direction: flush() whenever the
    // outgoing Format-editing surface is about to remount, and
    // replaceContentForTab() whenever a Format-editing surface mounts fresh
    // after one, regardless of whether the transition also changes which
    // conceptual "editing surface" (Format vs Source) is active.
    const formatEditingPositionChanges =
      isFormatEditing(currentViewMode, currentSplitLeftMode) &&
      isFormatEditing(mode, currentSplitLeftMode) &&
      (currentViewMode === 'split') !== (mode === 'split')

    if ((enteringSourceEditing && leavingFormatEditing) || formatEditingPositionChanges) {
      editorRef.current?.flush()
    }
    if ((leavingSourceEditing && enteringFormatEditing) || formatEditingPositionChanges) {
      // Re-read content HERE, after the flush() call above rather than from
      // a snapshot taken at the top of this function -- load-bearing, not
      // stylistic (review finding): when formatEditingPositionChanges is
      // true, BOTH branches above can fire in the same call, and flush()
      // synchronously updates the store's content via updateContentForTab
      // (zustand's set() is synchronous, no microtask gap) -- a
      // top-of-function snapshot taken before that flush would be exactly
      // the stale pre-edit value, and passing it here would silently
      // overwrite the edit flush() JUST wrote, reintroducing C1's data loss
      // through a different mechanism. Reading fresh is always correct for
      // the pre-existing Source->Format case too (nothing else in this
      // synchronous, no-await handler can change content between the top of
      // this function and here), so this isn't a narrower fix for the new
      // case at the expense of the old one.
      replaceContentForTab(currentActiveTabId, useDocumentStore.getState().content)
    }
    // Exactly the OR of the three conditions above -- i.e. every case that
    // already gates a real flush()/replaceContentForTab() call, which are
    // themselves the two places this function forces a genuine MilkdownEditor
    // remount (destroying its prosemirror-history state). Deliberately NOT a
    // parallel/simplified condition: reusing the same booleans means this
    // can't silently drift out of sync with what this function actually
    // remounts. See the design doc's "Investigation finding" section for why
    // formatEditingPositionChanges is included here even though it's neither
    // "entering" nor "leaving" Format/Source editing by this function's own
    // four-boolean model -- it's still a real remount via the JSX ternary's
    // structural-position swap (confirmed by EditorScreen.viewMode.test.tsx's
    // own 'Format -> Split(format) DOES call flush()' test).
    const undoHistoryResets =
      (enteringSourceEditing && leavingFormatEditing) ||
      (leavingSourceEditing && enteringFormatEditing) ||
      formatEditingPositionChanges
    if (undoHistoryResets) {
      showUndoBarrierToast()
    }
    setViewMode(mode)
  }

  // Every application-menu command that only means something with a document
  // on screen. Registered here rather than in App.tsx because each one needs
  // something this screen owns and nothing above it can reach: the live
  // MilkdownEditor handle (Save's flush), the find controller's
  // getSelectedText/queryInputRef pair, this screen's own zoom state, and
  // handleSetViewMode's flush/remount coordination.
  //
  // The three commands whose accelerators COLLIDE with this app's existing
  // bare `window` keydown listeners (Cmd+F, Cmd+/) are the interesting ones:
  // a menu accelerator on a non-role item is consumed by the menu, so those
  // listeners no longer fire in the real app and these handlers are now the
  // live path. Each therefore runs the SAME function the listener did, rather
  // than a simplified version of it -- see openFindFromShortcut's own
  // comment, and the closeSlashMenu() call below.
  useMenuCommands({
    'file:save': () => void handleSave(),
    'file:saveAs': () => void handleSaveAs(),
    // Straight to the store actions the toolbar buttons also call, so the two
    // triggers share one in-flight guard (see documentStore's isExporting).
    'file:exportPdf': () => void exportPdf(),
    // These three lost their toolbar buttons in the single-row-toolbar pass,
    // so the menu is now their ONLY trigger rather than their second one --
    // which is exactly why each had to have a menu item before its button
    // could go (EditorToolbar.tsx's header states that rule). They call the
    // same store actions the buttons did, so the in-flight guards and the
    // export Toast are unchanged.
    'file:exportHtml': () => void exportHtml(),
    'file:print': () => void print(),
    'file:pageSetup': () => openPageSetup(),
    // Second-pass product-completeness audit: Close Tab. Deliberately the
    // SAME handleRequestCloseTab the tab bar's own "x" button calls (defined
    // further down this component) rather than a parallel, simplified
    // closing path -- routing through it is what gives Cmd+W (now Close
    // Tab's own accelerator, see app-menu-template.ts) the identical
    // confirm/flush/save/clear-autosave sequence a dirty active tab already
    // gets from the button. `useDocumentStore.getState()` here, not this
    // render's own `activeTabId` closure variable, for the same reason
    // handleRequestCloseTab itself re-reads by id after every await: a menu
    // command can be dispatched at any time, and reading the live value at
    // the moment it actually fires is what handleRequestCloseTab's own
    // internal re-reads already assume of their caller.
    'file:closeTab': () => void handleRequestCloseTab(useDocumentStore.getState().activeTabId),
    'edit:find': () =>
      openFindFromShortcut(
        { getSelectedText: findController.getSelectedText, queryInputRef: findQueryInputRef },
        false
      ),
    // Same function as `edit:find` above, just `withReplace: true` -- the
    // menu's own accelerator (Cmd+Alt+F / Ctrl+H, see app-menu-template.ts)
    // competes with useFindShortcuts.ts's bare `window` listener exactly like
    // `edit:find`'s Cmd+F does, and converges on the identical call for the
    // identical reason: whichever path fires, the observable result is the
    // same, and running both is idempotent.
    'edit:findReplace': () =>
      openFindFromShortcut(
        { getSelectedText: findController.getSelectedText, queryInputRef: findQueryInputRef },
        true
      ),
    // Next/Previous act on the find store directly and are deliberately NOT
    // gated on the bar being open: findStore's goToNext/goToPrevious are
    // already no-ops at zero matches, and a Find Next with a query still
    // loaded from a closed bar advancing the match is what every editor does.
    'edit:findNext': () => useFindStore.getState().goToNext(),
    'edit:findPrevious': () => useFindStore.getState().goToPrevious(),
    // handleSetViewMode, never the bare setViewMode -- the menu is just
    // another way to press the toolbar's segmented control, and it needs the
    // identical flush/remount coordination (and undo-barrier notice).
    'view:format': () => handleSetViewMode('format'),
    'view:split': () => handleSetViewMode('split'),
    'view:source': () => handleSetViewMode('source'),
    // The Split left-pane choice and the Follow toggle. These call the store
    // actions DIRECTLY (not through handleSetViewMode) for exactly the reason
    // the toolbar pills they replace did: Split's own left-pane ternary is a
    // real element-type swap, so toggling it already unmounts the outgoing
    // editor -- whose own cleanup flushes any pending edit -- and mounts a
    // fresh one reading the current store content, with no key change needed.
    // EditorScreen.test.tsx's 'toggling splitLeftMode ... does not lose an
    // in-flight edit' tests exercise that against a real MilkdownEditor.
    'view:splitLeftFormat': () => setSplitLeftMode('format'),
    'view:splitLeftSource': () => setSplitLeftMode('source'),
    'view:toggleSplitFollow': () => toggleSplitFollow(),
    // Stepped through the SAME level list the status bar's zoom <select>
    // renders -- an off-list value would blank that control (see
    // lib/zoom-levels.ts).
    //
    // All three no-op in Split mode, matching the status bar's own disabled
    // select and app-menu-template.ts's own `enabled` gate on these same three
    // items. Zoom genuinely CANNOT apply there -- Split's two-pane row is
    // deliberately outside the zoom wrapper, because the right pane is a
    // native WebContentsView positioned from a DOM rect that a scale would
    // silently desync (see that branch's own comment). Before this guard the
    // control stayed live and lied: setting 150% in Split left the pane
    // transform at "none" and the card rect unchanged while the readout said
    // 150%, and the document then JUMPED to 150% on switching back to Format.
    // Guarded here as well as in the menu because menu enablement is reported
    // asynchronously (the renderer pushes window UI state, main rebuilds the
    // menu), so a command dispatched from a momentarily-stale menu must still
    // do nothing rather than something invisible.
    // Read the live level via getState() rather than through a functional
    // updater: appStore's setZoom takes a value (it is a plain store action,
    // not a React setState), and reading `zoom` from this render's closure
    // instead would be the stale-closure risk this file already avoids
    // elsewhere -- useMenuCommands' handler map is captured per render, but a
    // menu command can arrive at any time.
    'view:zoomIn': () => {
      if (!zoomApplies) return
      setZoom(nextZoomLevel(useAppStore.getState().zoom))
    },
    'view:zoomOut': () => {
      if (!zoomApplies) return
      setZoom(previousZoomLevel(useAppStore.getState().zoom))
    },
    'view:zoomReset': () => {
      if (!zoomApplies) return
      setZoom(DEFAULT_ZOOM)
    },
    'view:toggleSidebar': () => toggleSidebar(),
    'app:shortcuts': () => {
      // Same closeSlashMenu() call the Mod-/ keydown listener below makes,
      // for the same reason -- see that handler's own comment: this closes
      // the slash session synchronously, a render sooner than
      // useModalDialog's own focus-in-driven blur would.
      editorRef.current?.closeSlashMenu()
      openShortcutsHelp()
    }
  })

  const handleGoHome = async (): Promise<void> => {
    if (!isDirty) {
      goHome()
      return
    }
    const choice = await window.api.confirmDiscardChanges()
    if (choice === 'cancel') return
    if (choice === 'save') {
      editorRef.current?.flush()
      const outcome = await save()
      // "Reload" at an mtime conflict is NOT an answer to "save before
      // leaving?" -- it is a request to SEE the file as it now is, and it
      // deliberately writes nothing (see file-io.ts's saveFile). Navigating
      // Home on the strength of it would discard the edit AND deny the user
      // the one thing they just asked for. So abandon the navigation and
      // leave them on the reloaded document.
      //
      // This needs the explicit outcome rather than the isDirty check below:
      // 'reloaded' and 'saved' BOTH leave the tab clean with a fresh
      // mtimeMs, so they are indistinguishable from store state alone.
      if (outcome === 'reloaded') return
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
  // sequence -- but for closing a tab via EditorTabBar's own "x" button
  // instead of navigating to Home.
  //
  // Handles EVERY close now, not just a dirty ACTIVE tab's, and both halves of
  // that widening close a real silent-data-loss path:
  //
  //   - A dirty BACKGROUND tab used to go straight to closeTab with no
  //     confirmation at all. That is unrecoverable rather than merely
  //     unconfirmed: useAutosave only ever sees the ACTIVE tab (its own
  //     documented limitation), so a background tab has no version-history
  //     snapshot to fall back on either.
  //   - Dirtiness itself was read by EditorTabBar, which cannot know it.
  //     @milkdown/plugin-listener's onChange is 200ms-debounced, so clicking
  //     "x" within 200ms of a keystroke read isDirty: false and discarded the
  //     edit with no prompt. flush() below is what makes the check honest --
  //     it is a documented no-op when nothing changed since mount, so calling
  //     it on every close costs nothing.
  //
  // The flush is scoped to the ACTIVE tab because that is the only tab the
  // live Milkdown instance is bound to; a background tab's content is already
  // fully synced in the store by construction.
  //
  // The target tab is re-read from `tabs` BY ID at every decision point,
  // never from the top-level mirror. For the 'save' branch specifically that
  // is required, not stylistic: save() is a plain async IPC round trip with no
  // modal dialog whenever the document already has a known path (file-io.ts's
  // saveFile calls writeFile directly; even its Save-As fallback opens
  // dialog.showSaveDialog with no parent window, so it isn't modal either), so
  // the always-visible EditorTabBar lets the user switch to a DIFFERENT tab
  // while it's in flight. If they do, and THIS tab's save actually failed, the
  // mirror describes the NEWLY active tab: if that one happens to be clean,
  // `isDirty` reads false even though the tab being closed is still genuinely
  // dirty, and a mirror-based check would fall through to closeTab --
  // silently discarding real unsaved content whose save just failed. Same race
  // class replaceContentForTab/updateContentForTab and handleRestoreVersion's
  // own post-save guard already exist to close.
  const handleRequestCloseTab = async (tabId: string): Promise<void> => {
    if (tabId === useDocumentStore.getState().activeTabId) editorRef.current?.flush()

    const target = useDocumentStore.getState().tabs.find((tab) => tab.id === tabId)
    if (!target) return
    if (!target.isDirty) {
      closeTab(tabId)
      return
    }

    // Show the document being asked about before asking. Also load-bearing
    // rather than cosmetic for the 'save' branch: documentStore.save() only
    // ever writes the ACTIVE tab, so saving a background tab is only reachable
    // by making it active first. A cancel therefore leaves this tab selected
    // rather than the one the user was on -- a visible consequence of having
    // shown what was at stake, preferred over prompting about an invisible
    // document.
    if (tabId !== useDocumentStore.getState().activeTabId) switchTab(tabId)

    const choice = await window.api.confirmDiscardChanges(tabLabel(target.filePath))
    if (choice === 'cancel') return
    if (choice === 'save') {
      const outcome = await save()
      // Same reasoning as handleGoHome's own 'reloaded' guard, and the
      // consequence here is strictly worse: closing the tab would discard
      // BOTH the user's edit and the disk content that was just loaded to
      // replace it, leaving nothing on screen and nothing recoverable.
      if (outcome === 'reloaded') return
      const targetTab = useDocumentStore.getState().tabs.find((tab) => tab.id === tabId)
      if (targetTab?.isDirty) return
    }
    if (choice === 'discard' && target.filePath) {
      // Same reasoning as handleGoHome's own clearPendingAutosave call --
      // a discarded edit must never silently reappear as "recovered" the
      // next time this file is opened.
      void window.api.clearPendingAutosave(target.filePath)
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

  // Simpler than handleSelectHeading above -- a comment mark's own id is
  // already a precise, unique CSS selector (`data-comment-id`, set by
  // comment.ts's toDOM), so this needs no index-matching against a
  // separately-extracted list the way headings do (headings have no id of
  // their own to select by).
  const handleSelectComment = (id: string): void => {
    const el = canvasRef.current?.querySelector(`.pagedown-comment-mark[data-comment-id="${id}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const handleResolveComment = (id: string): void => {
    editorRef.current?.resolveComment(id)
  }

  // Backs LinkComposer (the layout row that replaced EditorToolbar's dead
  // `window.prompt('Link URL')` call -- see that component's own module
  // comment for what "dead" means precisely). Optional-chained like every
  // other editorRef-bound handler here: MilkdownEditor is unmounted in Source
  // mode, and although the toolbar's Insert link button is disabled there,
  // this stays a no-op rather than a crash if the composer is ever reachable
  // from a surface that isn't.
  const handleInsertLink = (href: string): void => {
    if (!composerTargetIsLive(linkComposerTargetRef.current)) {
      closeLinkComposer()
      return
    }
    editorRef.current?.insertLink(href)
  }

  // The composer's "Remove link" button. Separate from handleInsertLink
  // because it is a genuinely different command (unlinkCommand, which removes
  // the mark across the WHOLE link rather than only the selected characters),
  // not insertLink with an empty href.
  const handleRemoveLink = (): void => {
    if (!composerTargetIsLive(linkComposerTargetRef.current)) {
      closeLinkComposer()
      return
    }
    editorRef.current?.removeLink()
  }

  // authorName '' (the default -- no accounts system, see Preferences'
  // own comment) falls back to the literal label "You" here, matching
  // EditorComments.tsx's own identical fallback for DISPLAYING an existing
  // comment's author -- keeping both fallbacks in the same place they're
  // used, rather than baking "You" into the stored preference default
  // itself, which would make an genuinely-blank preference indistinguishable
  // from a user who deliberately typed "You" as their name.
  const handleAddComment = (text: string): boolean => {
    if (!composerTargetIsLive(commentComposerTargetRef.current)) {
      closeCommentComposer()
      return false
    }
    const author = authorName || 'You'
    return editorRef.current?.addComment(author, text) ?? false
  }

  // Page navigation targets the Split-mode preview, because it is the ONLY
  // surface in this app with real page boundaries: renderPageCard() below
  // emits ONE continuous card for the whole document, with page width and
  // side margins but no vertical page divisions, so there is no "page 3"
  // element in the Format canvas to scroll to. Mapping a page number onto a
  // Format-canvas offset is not a viable substitute either -- Gate 10's
  // parity proof is single-page, and Paged.js SPLITS content across page
  // boundaries (a table fragmented over two pages has no counterpart element
  // in the editor at all). See the design doc's "architectural constraint".
  //
  // So navigating from Format/Source switches to Split rather than being
  // inert. That is deliberate: viewMode defaults to 'format', so disabling
  // navigation there would ship a feature that is dead on arrival in the
  // view the app actually opens in. The controls' own tooltips name the
  // consequence BEFORE the click ("shown in Split view") rather than
  // surprising the user after it.
  //
  // Routed through handleSetViewMode, NOT the bare setViewMode, so the
  // Milkdown flush/remount coordination that switch requires actually runs.
  // Sequencing needs no readiness handshake: enqueueSplitPreviewWork
  // serializes every harness call, and SplitPreview's mount effect enqueues
  // its sendDocument first, so the scroll necessarily runs after the render.
  const handleNavigateToPage = (page: number): void => {
    const clamped = pageCount ? Math.min(Math.max(page, 1), pageCount) : Math.max(page, 1)
    setCurrentPage(clamped)
    if (viewMode !== 'split') handleSetViewMode('split')
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
  // frontmatter is this integration's job. The READ side is
  // `resolvePageConfig` (src/markdown/page-config.ts), the shared
  // whole-document helper the main-process geometry callers use too, so this
  // screen and the renderer surfaces can't drift on how a partial/absent
  // frontmatter block resolves. The WRITE side still works at the raw-YAML
  // layer -- `applyPageConfig` operates on the text BETWEEN the `---` fences
  // (that's what makes its mutation surgical), so frontmatter-splice.ts
  // isolates that text from the full document and splices the updated text
  // back in.
  const pageConfig: PageConfig = useMemo(() => resolvePageConfig(content), [content])

  // The on-screen page card's real pixel geometry, derived from the
  // PageConfig memo directly above rather than re-derived from `content` --
  // resolvePageConfig does a real YAML parse, and doing it twice per render
  // (once here, once there) would be exactly the avoidable per-keystroke
  // work these memos exist to amortize. computePageGeometry itself is the
  // same pure function every main-process geometry caller uses
  // (src/typography/page-geometry.ts), so the editor canvas, the paginated
  // preview, the page count, and PDF export cannot disagree about what
  // "this document's page" means. It requires a COMPLETE PageConfig, which
  // is why this derives from resolvePageConfig's fully-merged result and not
  // from extractPageConfig's Partial (a partial would yield NaN geometry for
  // every key a document's frontmatter happens to omit).
  const pageGeometry = useMemo(() => computePageGeometry(pageConfig), [pageConfig])

  // The non-geometric half of the same story: theme, font family, and the
  // running header/footer content. Derived from the very same pageConfig
  // the geometry above comes from, and handed to the same two surfaces, so
  // the editor canvas and the sandboxed paginator cannot disagree about a
  // document's typography any more than they can about its page box.
  const documentStyle = useMemo(() => resolveDocumentStyle(pageConfig), [pageConfig])

  // Bundles the two halves of one settled pagination result into the single
  // stable object MilkdownEditor's own guide effect keys on. Memoized on the
  // two values it wraps, so it changes identity exactly when a NEW render
  // settles -- not on every keystroke, which is what an inline literal would
  // do (and which would dispatch a ProseMirror transaction per keystroke for
  // guides that had not moved).
  const pageGuides = useMemo(() => ({ breaks: pageBreaks, blockCount }), [pageBreaks, blockCount])

  // Split mode's fit-to-width scale (src/renderer/src/lib/fit-scale.ts holds
  // the arithmetic and, more importantly, the argued FLOOR).
  //
  // The page card is a fixed `width` by design, and in Split mode it sat in a
  // pane roughly half the canvas -- 816px of Letter page inside a measured
  // 389px pane at this app's own default window, i.e. the user horizontally
  // scrolling their own document to read a line of it. Scaling the card down
  // is the only fix that leaves its real layout width (and therefore Gate 10's
  // editor/paginator parity) untouched.
  //
  // MEASURED FROM `clientWidth`, NOT from `splitRatio` arithmetic. The ratio is
  // a percentage of a row whose own pixel width depends on the window, the
  // sidebar rail and whatever layout rows (FindBar, CommentComposer,
  // RemoteImageBanner) happen to be open, so deriving px from it would mean
  // re-deriving every one of those here. `clientWidth` also has the scrollbar
  // already excluded, which a `getBoundingClientRect()` width does not.
  const [splitPaneWidthPx, setSplitPaneWidthPx] = useState(0)
  const splitFitApplies = viewMode === 'split' && splitLeftMode === 'format'
  useEffect(() => {
    if (!splitFitApplies) return
    const el = editorPaneRef.current
    if (!el) return
    // ResizeObserver rather than a window 'resize' listener: this pane changes
    // width for THREE independent reasons (window resize, a Split-divider
    // drag, and a layout row opening or closing above it) and only the first
    // of those fires a window event. It also delivers an initial observation
    // on observe(), which is why nothing needs to setState synchronously in
    // this effect body -- doing so would trip react-hooks/set-state-in-effect,
    // the same rule SettingsScreen's own buffered input had to work around.
    //
    // NO FEEDBACK LOOP, and that is a property of WHAT is observed rather than
    // luck: the callback reads the pane's own `clientWidth`, which depends on
    // the pane's assigned width and the vertical scrollbar's gutter -- never on
    // the scaled content's width. The gutter is pinned by `scrollbar-gutter:
    // stable` on the pane itself (see the JSX below), so it does not appear and
    // disappear with the scaled content's height either. Without that pin the
    // loop would be real: smaller scale -> shorter content -> no scrollbar ->
    // wider clientWidth -> larger scale -> taller content -> scrollbar back.
    const observer = new ResizeObserver(() => {
      const current = editorPaneRef.current
      if (!current) return
      setSplitPaneWidthPx((previous) =>
        previous === current.clientWidth ? previous : current.clientWidth
      )
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [splitFitApplies])

  // 1 whenever fit-to-width is not the thing driving the canvas -- Format and
  // Source mode keep their own user-chosen `zoom` on the single-pane wrapper,
  // untouched, and Split(source) is a `h-full w-full` textarea with no fixed
  // page width to fit in the first place (scaling it would just shrink text
  // for no reason).
  const splitFitScale = useMemo(
    () => (splitFitApplies ? computeFitScale(splitPaneWidthPx, pageGeometry.pageWidthPx) : 1),
    [splitFitApplies, splitPaneWidthPx, pageGeometry.pageWidthPx]
  )

  // Split-mode "Follow" (docs/superpowers/plans/
  // 2026-08-09-design-doc-gap-audit.md's "Follow, not Sync" recommendation):
  // scrolling the editor pane estimates a page from that scroll offset and
  // feeds it into handleNavigateToPage below -- the SAME page-navigation
  // path the status bar's chevrons and the Pages sidebar already use. See
  // useSplitFollowScroll.ts's own module comment for the full mechanism and
  // why zero new IPC is needed.
  //
  // `splitLeftMode === 'format'` is required, not just `viewMode ===
  // 'split'`: the pitch below is the Milkdown page card's own page box, which
  // has no relationship to a plain <textarea>'s scroll position in Source
  // mode's left pane -- see the hook's own `enabled` doc comment for why this
  // is checked explicitly rather than relied upon only being reachable by
  // construction.
  const splitFollowScroll = useSplitFollowScroll({
    enabled: splitFollowEnabled && viewMode === 'split' && splitLeftMode === 'format',
    scrollElementRef: editorPaneRef,
    // A whole sheet plus a gutter, NOT the bare content height this used to
    // pass. The canvas now draws a real seam at every page boundary, so it
    // advances by a page rather than by a content box; see
    // computeEditorPagePitchPx for why the old divisor would have
    // under-reported silently rather than failed.
    pagePitchPx: computeEditorPagePitchPx(pageGeometry),
    // The pane this hook samples `scrollTop` from also contains a CSS-`zoom`ed
    // wrapper, so its scroll offset is not in the same coordinate space as the
    // pitch -- see the hook's own `scale` doc comment for the measurement and
    // for why omitting this silently under-reports the page rather than
    // failing.
    scale: splitFitScale,
    pageCount,
    onNavigate: handleNavigateToPage
  })

  const handleApplyPageConfig = (config: PageConfig): void => {
    const newRawYaml = applyPageConfig(extractRawFrontmatter(content), config)
    // replaceContent (not updateContent): this edit originates outside the
    // live mounted editor, so the editor must remount to pick it up rather
    // than silently overwrite it on the next real edit -- see
    // documentStore.ts's replaceContent doc comment.
    replaceContent(replaceRawFrontmatter(content, newRawYaml))
    closePageSetup()
  }

  // handleSetFontFamily / handleSetFontSize USED TO LIVE HERE, as a second
  // frontmatter writer serving the toolbar's own font-family and font-size
  // selects. Both are deleted: those selects moved into PageSetupModal's
  // Typography section (single-row-toolbar pass -- see EditorToolbar.tsx's
  // header for why they were never selection formatting in the first place),
  // which routes through handleApplyPageConfig immediately above. That is
  // strictly one path instead of two writing the same two PageConfig fields,
  // and it removes the divergence risk that came with the duplication.

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
        const outcome = await save()
        // A 'reloaded' outcome defeats the very guard this block exists to
        // provide, which is why it is checked FIRST and separately. Reload
        // writes nothing and leaves the tab clean, so the isDirty re-read
        // below would read "the save succeeded" and fall through to
        // replaceContentForTab -- overwriting the disk content that was
        // just loaded, on top of the edit already discarded to load it.
        // Abandon the restore instead; the document now shows what is on
        // disk, and the user can restore again from there if they still
        // want to.
        if (outcome === 'reloaded') return
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

  // The Source-editing surface, factored into a function (not a plain JSX
  // variable computed once per render) rather than left inline at each of
  // its two call sites below (plain Source mode, and Split mode's left pane
  // when splitLeftMode === 'source') -- same reasoning, and the same
  // "don't duplicate" rule, as renderPageCard just below.
  const renderSourceEditor = (): React.JSX.Element => (
    <SourceEditor
      ref={sourceEditorRef}
      content={content}
      onChange={(value) => updateContentForTab(activeTabId, value)}
      onDropImage={saveDroppedImage}
      onError={(message) => useDocumentStore.setState({ error: message })}
    />
  )

  // The "page" card -- per the design handoff (PageDown.dc.html, Format-mode
  // mock): a white sheet with a real drop shadow, floating on the
  // canvas-gray scroll area, not a flat borderless region flush with the
  // background. Was entirely missing before an earlier fix -- MilkdownEditor's
  // own root div has no background/shadow/width constraint of its own, so
  // the editor rendered as plain canvas-gray with no visible document
  // boundary at all. Background/shadow/radius/font values match the mock's
  // own numbers, using tokens that already existed in base.css for exactly
  // this purpose (--shadow-page, --color-page) but were never applied here.
  //
  // Width/side-padding do NOT match the mock's own 640px/64px --
  // merge-conflict finding (Document Typography sub-project vs that earlier
  // fix, both landing the same night): the mock's numbers were an eyeballed
  // approximation authored before this project had a single authoritative
  // page geometry. The card's real content width -- what MilkdownEditor's
  // own root div is capped to (see that component) -- is enforced by Gate 10
  // to stay pixel-identical to the paginated preview/PDF, the exact
  // print-fidelity guarantee this whole app exists for. The mock's 640px
  // total width with 64px padding each side only leaves 512px for content,
  // which failed Gate 10 outright (measured: 624 expected, 512 received).
  //
  // As of the Page Geometry Wiring sub-project these are no longer the fixed
  // constants `w-[816px]`/`pl-24 pr-24` (816px = PAGE_WIDTH_PX, 96px =
  // PAGE_MARGIN_PX) but inline styles computed by computePageGeometry
  // (src/typography/page-geometry.ts) from the document's OWN frontmatter
  // page size/orientation/margins, via the pageGeometry memo above. The
  // identity that Gate 10 actually depends on is preserved and generalized:
  //
  //     pageWidthPx - marginLeftPx - marginRightPx = contentWidthPx
  //
  // For a document with no frontmatter (Gate 10's own fixture, and
  // DEFAULT_PAGE_CONFIG's Letter/portrait/1in) that is still exactly
  // 816 - 96 - 96 = 624 -- the old hardcoded numbers were only this
  // identity's Letter instance, not a separate decision. Tailwind classes
  // cannot express this at all: the values are per-document runtime numbers,
  // and Tailwind's JIT scanner only emits classes it can see as literal
  // strings in the source.
  //
  // A fixed `width`, NOT `maxWidth` -- verified empirically, not assumed
  // (and the reason it was `w-[816px]` rather than `max-w-[816px]` back when
  // it was a class): a max-width cap only shrinks a block box below its
  // container's available width, it never forces one WIDER than its
  // container, and this app's default window (900px, minus the 216px
  // sidebar) leaves only 684px for the canvas area -- narrower than a Letter
  // page's 816px. With `max-w-[816px]`, the card just filled that 684px and
  // reflowed its content down to 492px, failing Gate 10 differently but just
  // as badly (confirmed by rerunning it). A real page must stay at its true
  // size regardless of window width -- exactly what the zoom-scaled wrapper
  // around this card's OWN call site below already exists to handle (fitting
  // an unchanged, full-size layout visually into a smaller viewport, the
  // same way Word/Google Docs zoom out rather than reflow text at less than
  // 100%) -- so the card needs a width the CSS box model won't shrink on its
  // own, letting that wrapper's `overflow-auto` scroll horizontally at low
  // zoom/narrow windows instead of silently changing the content's real
  // layout width. (MilkdownEditor's own mount div uses `maxWidth` for its
  // contentWidthPx, which is the correct choice THERE: it sits inside this
  // already-fixed-width box and only has to cap the text column.)
  //
  // TOP/BOTTOM PADDING ARE NOW THE DOCUMENT'S REAL MARGINS, and this reverses
  // an earlier decision that used to be pinned by a test in
  // EditorScreen.test.tsx. That decision was right for what the card was and
  // wrong for what it is: it argued the fixed 22px/34px were "cosmetic card
  // chrome, not the page's own vertical margin," because "this single
  // unpaginated card has no page boundaries to place them against in the
  // first place." It has them now -- every page break the paginator reports
  // is drawn as a real seam inside this card (see page-guide-plugin.ts and
  // src/typography/page-seam.ts) -- so the top of the card IS the top edge of
  // sheet one, and the first line has to sit exactly one top margin below it
  // or the sheet is lying about its own geometry. MilkdownEditor's mount div
  // dropped its own `py-6` in the same change, for the same reason: two
  // ambient paddings stacked on the real margin put the first line 24px too
  // low. Gate 10 is unaffected either way -- it measures block positions
  // relative to each surface's own content root, so uniform vertical chrome
  // outside the editing root cancels; verified by running it, not assumed.
  //
  // A MIN-HEIGHT OF ONE WHOLE SHEET is the other half. An empty document used
  // to render as a ~78px-tall page-WIDTH strip, which is the specific thing
  // that made the canvas not look like pages at all. `min-height`, never
  // `height`: content longer than a page still grows the card past it.
  // `seamCount` is the number of page boundaries actually drawn inside the
  // card, reported up from the plugin that draws them, so the LAST page is a
  // full sheet like every other one rather than ending wherever the text
  // stopped -- see computePageCardMinHeightPx for the proof that the minimum
  // always binds and therefore never fights the content, and for why it has
  // to follow the DRAWN count rather than the last render's break count.
  //
  // Note what min-height deliberately does NOT do: it does not make the blank
  // space below the last line part of the editable region. An earlier fix
  // tried exactly that (a min-height/flexbox chain forcing ProseMirror's own
  // DOM to physically fill the card) and it was the wrong goal, not merely
  // hard to get right -- a real editor's text only exists where you have
  // actually typed, so clicking below the last line should move the caret to
  // the nearest real position, not start new content wherever you clicked.
  // The min-height here is on the CARD, outside the editing root;
  // handlePageCardClick implements the click behaviour.
  //
  // Split mode's own draggable divider. Tracks the drag on `window`, not the
  // divider element itself -- the cursor routinely moves faster than the
  // element under it during a fast drag, and a real `mousemove` on the
  // divider alone would lose tracking the instant the pointer outruns a
  // 6px-wide target. `splitRowRef` (not `canvasRef`) is the percentage base
  // because it's the actual flex row the two panes size themselves against;
  // `canvasRef` also wraps the sidebar-adjacent single-pane branch, whose
  // width isn't what `splitRatio`'s percentage means. Reads `getBoundingClientRect()`
  // fresh on every mousedown rather than once at mount -- the row's own width
  // changes with the window, and a stale rect would compute the wrong
  // percentage after any resize since the drag started.
  const handleSplitDividerMouseDown = (event: React.MouseEvent): void => {
    event.preventDefault()
    const row = splitRowRef.current
    if (!row) return
    const rect = row.getBoundingClientRect()
    const handleMouseMove = (moveEvent: MouseEvent): void => {
      const percent = ((moveEvent.clientX - rect.left) / rect.width) * 100
      setSplitRatio(percent)
    }
    const handleMouseUp = (): void => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }

  // Factored into a function (Task 5, Split mode sub-project) rather than
  // left inline in the old Format-only branch, specifically so Split mode's
  // left pane (when splitLeftMode === 'format') can reuse the EXACT same
  // element -- same ref/key/onChange/onError wiring -- instead of a second,
  // independently-wired MilkdownEditor instance. See handleSetViewMode's own
  // doc comment above for why this function's two call sites still produce
  // two entirely separate MilkdownEditor mounts at runtime (never both at
  // once) rather than one instance that survives a Format<->Split(format)
  // transition -- that's a property of WHERE this function is called from
  // in the JSX below, not of the function itself.
  const renderPageCard = (): React.JSX.Element => (
    <div
      data-testid="page-card"
      // bg-white, not bg-page -- deliberate, App-level Dark Mode's own
      // invariant. `--color-page` (bg-page's token) gets a real dark value
      // in base.css's :root[data-theme='dark'] block for every OTHER card
      // surface in the app; this one page-card wrapper represents an
      // actual sheet of paper and must render identically regardless of
      // app theme, matching document-typography.css's own hardcoded
      // background/color pin on .pagedown-document (the Milkdown mount
      // this div wraps) for the same reason -- see that file's comment.
      className="mx-auto my-8 shrink-0 rounded-sm bg-white shadow-page"
      style={{
        width: pageGeometry.pageWidthPx,
        minHeight: computePageCardMinHeightPx(pageGeometry, pageSeamCount),
        paddingLeft: pageGeometry.marginLeftPx,
        paddingRight: pageGeometry.marginRightPx,
        paddingTop: pageGeometry.marginTopPx,
        paddingBottom: pageGeometry.marginBottomPx
      }}
      onMouseDown={handlePageCardMouseDown}
      onClick={handlePageCardClick}
    >
      <MilkdownEditor
        ref={editorRef}
        key={revision}
        content={content}
        geometry={pageGeometry}
        documentStyle={documentStyle}
        // Bound to THIS render's activeTabId, not the bare updateContent
        // store action -- see documentStore.ts's updateContentForTab doc
        // comment for the tab-switch race this closes: any change to
        // activeTabId always bumps revision (remounting this component with
        // a fresh key), so the activeTabId captured here is guaranteed
        // correct for this specific MilkdownEditor instance's entire
        // lifetime, even after a late flush() fires (e.g. on unmount, when
        // the user has switched tabs) well after the store's own
        // activeTabId has moved on.
        onChange={(markdown) => updateContentForTab(activeTabId, markdown)}
        onError={(message) => useDocumentStore.setState({ error: message })}
        onFindMatchesChanged={findController.handleFormatMatches}
        // How many page boundaries the canvas is really drawing right now,
        // which is what the card's own min-height above is sized from. Comes
        // back from the plugin rather than being derived here from
        // `pageGuides`: the two disagree whenever breaks collapse onto a
        // shared boundary or the guides fail closed on a stale block count,
        // and the card has to follow what is DRAWN.
        onPageSeamsChanged={setPageSeamCount}
        onDropImage={saveDroppedImage}
        // Deliberately the STORE action, not a closure over this render's
        // `filePath`: the resolver is published into ProseMirror plugin
        // state and read at image-render time, which can be well after this
        // render (a resolution in flight, an image scrolled into view). The
        // action reads the active tab's own filePath when it actually runs.
        onResolveLocalImage={resolveLocalImage}
        onSelectionChanged={handleSelectionChanged}
        onSlashStateChanged={slashMenu.handleSlashStateChanged}
        // Editor page-break guides (design:50-58), derived from the SAME
        // Paged.js render the status bar's page count already comes from --
        // see usePageCount / page-count-generator.ts for why that reuse is
        // the point rather than a shortcut. Memoized because MilkdownEditor
        // applies it through an effect keyed on identity: a fresh object
        // literal every render would dispatch a ProseMirror transaction on
        // every unrelated EditorScreen re-render (of which there are many --
        // every keystroke moves `content`).
        pageGuides={pageGuides}
      />
    </div>
  )

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
      {/* Product-completeness audit Tier 3, B.1: this banner had no role at
      all, so a failed Save (or any other store-level error) was completely
      invisible to a screen-reader user -- nothing announces its own
      appearance the way sighted feedback (a red bar appearing) does.
      `role="alert"` is the right strength, not `aria-live="polite"`: this is
      a genuinely discrete event (a save either just failed or it didn't),
      not a value that updates continuously the way FindBar's match count
      does, so there's no "chatter" risk an assertive interruption would
      cause -- see FindBar.tsx's own comment for the case where that
      distinction actually matters. */}
      {error && (
        <div
          role="alert"
          className="flex flex-none items-center gap-3 border-b border-border-chrome bg-red-50 px-3 py-2 text-13 text-red-600"
        >
          <span className="flex-1">{error}</span>
          <button onClick={clearError} className="text-12 font-semibold text-red-600">
            Dismiss
          </button>
        </div>
      )}
      <EditorTabBar onRequestCloseTab={(tabId) => void handleRequestCloseTab(tabId)} />
      <EditorToolbar
        editorRef={editorRef}
        onSetViewMode={handleSetViewMode}
        // The same snapshot the selection bubble runs on, reused here so
        // Bold/Italic/list buttons show real pressed state instead of the
        // hardcoded `active={false}` they carried since the design handoff.
        // One source, so the two toolbars can never disagree about whether the
        // cursor is in bold text.
        selection={liveSelection}
      />
      {/* Position is load-bearing, not cosmetic (see FindBar.tsx's own module
      comment) -- rendering FindBar here, as a LAYOUT ROW between the toolbar
      and the content row below, is what makes opening it shrink the content
      area rather than float over it. Split mode's right pane hosts a real
      native WebContentsView, which composites above ALL DOM unconditionally
      (the same property PageSetupModal had to work around with a zero-size-
      rectangle trick) -- shrinking the content area moves SplitPreview's own
      placeholder div, which fires its existing ResizeObserver, which
      re-reports bounds over the existing IPC, so the preview simply moves
      down with no new occlusion handling required. A floating panel over the
      canvas would need that same special-casing all over again. */}
      <FindBar
        onReplace={findController.replaceActive}
        onReplaceAll={findController.replaceAll}
        queryInputRef={findQueryInputRef}
      />
      {/* NOTE: CommentComposer and LinkComposer used to sit HERE, as layout
      rows between FindBar and the banners. They are now selection-anchored
      popovers rendered at this screen's own root, down beside SelectionBubble
      -- see FloatingCard.tsx for why, and for why FindBar deliberately stayed
      a row. Do not move them back into this stack: a `position: fixed` child
      of this flex column is out of flow and would take no space anyway, so
      putting them here again would only misfile them. */}
      {/* Same layout-row placement/reasoning as FindBar above
      -- see RemoteImageBanner.tsx's own module comment. */}
      <RemoteImageBanner />
      {/* Same layout-row family, one row below RemoteImageBanner -- order
      between the two has no functional weight (each independently gates its
      own visibility), kept adjacent since both are dismissible, non-blocking
      document-level notices. See DocumentWarningsBanner.tsx's own module
      comment for why `warnings` is passed as a prop here rather than
      re-derived locally the way RemoteImageBanner derives its own. */}
      <DocumentWarningsBanner warnings={documentWarnings} />
      <div className="flex flex-1 overflow-hidden">
        {/* Genuinely unmounted, not merely hidden, when View > Toggle Sidebar
        turns it off -- which is also what makes it compose with Split mode for
        free: removing the rail widens the content row, which moves
        SplitPreview's placeholder, which fires its existing ResizeObserver,
        which re-reports the native preview's bounds over the existing IPC. A
        `display: none` rail would do the same, but would keep EditorOutline/
        EditorComments re-parsing the document on every keystroke to render
        something nobody can see. */}
        {sidebarVisible && (
          <EditorSidebar
            content={content}
            onSelectHeading={handleSelectHeading}
            activeSourceOffset={activeSourceOffset}
            pageCount={pageCount ?? undefined}
            currentPage={effectiveCurrentPage}
            onSelectPage={handleNavigateToPage}
            filePath={filePath}
            onRestoreVersion={handleRestoreVersion}
            onSelectComment={handleSelectComment}
            onResolveComment={handleResolveComment}
          />
        )}
        <div ref={canvasRef} data-testid="document-content" className="flex-1 overflow-hidden">
          {viewMode === 'split' ? (
            // Split mode's own two-pane row lives in a SEPARATE top-level
            // branch from the single-pane view below, not nested inside its
            // zoom-scaled/scrolling wrapper -- two independent reasons, both
            // load-bearing, not a style preference:
            //
            // (1) The right pane hosts a real native WebContentsView,
            // positioned by SplitPreview's own placeholder reporting its
            // getBoundingClientRect() via ResizeObserver + window 'resize'
            // (see SplitPreview.tsx). A CSS `transform: scale()` on an
            // ancestor changes that rect's on-screen size WITHOUT firing
            // either listener (transform affects paint, not the border-box
            // ResizeObserver watches, and it isn't a window resize) -- so
            // reusing the zoom transform here would silently desync the
            // native view's bounds from its placeholder the instant zoom
            // changed, with no error. Split's left pane therefore always
            // renders at 100% regardless of the zoom control.
            //
            // (2) The right pane must also not be inside anything that
            // SCROLLS -- SplitPreview's own comment documents this as its
            // own accepted limitation (it tracks resize, not scroll): an
            // ancestor scroll shifts the placeholder's on-screen position
            // with no event to tell SplitPreview to re-report it, which
            // would silently desync the native view the same way. This
            // row's own height is pinned to `h-full` (exactly its parent's
            // box, from flexbox), so its LEFT pane's own `overflow-auto`
            // (below) is where scrolling actually happens for a
            // taller-than-viewport document -- this row itself never grows
            // past the viewport and never needs to scroll.
            <div ref={splitRowRef} className="flex h-full">
              <div
                ref={editorPaneRef}
                // `scrollbarGutter: 'stable'` is what makes `clientWidth` a
                // content-INDEPENDENT measurement, which is the whole reason
                // the fit-scale effect above cannot feed back on itself. On
                // macOS (overlay scrollbars) it reserves nothing and changes
                // nothing; on Windows/Linux it keeps the classic scrollbar's
                // track reserved whether or not the scrollbar is currently
                // showing. Without it, a document that got short enough to stop
                // scrolling would widen the pane by the scrollbar's width,
                // raise the scale, grow taller, and bring the scrollbar back.
                style={{ width: `calc(${splitRatio}% - 3px)`, scrollbarGutter: 'stable' }}
                className="h-full overflow-auto"
              >
                {/* Fit-to-width. CSS `zoom` on an INNER wrapper, exactly like
                the single-pane branch below -- not `transform: scale()`, which
                is the mistake that fix already made and measured: a transform
                does not participate in layout, so the scroller's
                scrollWidth/scrollHeight ignore it and content is clipped with
                no way to reach it (196px per side at 150%). `zoom` does
                participate (standardized, layout-affecting, Chromium >= 128;
                this app ships Chromium via Electron 39), so this pane's own
                `overflow-auto` scrolls the SCALED extent with no ResizeObserver
                on the content, no spacer layer and no scrollbar feedback loop.

                The two facts the single-pane branch records about `zoom` hold
                here unchanged, and one of them matters more in Split than
                anywhere else: `coordsAtPos` still reports post-zoom viewport
                coordinates, so SelectionBubble/SlashMenu must still NOT divide
                by this scale -- and because both clamp into
                `intersect(canvasRect, editorPaneRect)`, and `editorPaneRef` is
                the UNSCALED pane outside this wrapper, the occlusion guarantee
                against the native preview view is untouched by construction.

                Only the Format branch is wrapped. Source mode's `h-full w-full`
                textarea has no fixed page width to fit, and wrapping it would
                additionally break the `h-full` chain it resolves its own height
                against. */}
                {splitLeftMode === 'source' ? (
                  renderSourceEditor()
                ) : (
                  <div style={{ zoom: splitFitScale }}>{renderPageCard()}</div>
                )}
              </div>
              {/* 6px wide, split evenly (3px) into each pane's own calc() above,
              so the row always totals exactly 100% regardless of container
              size -- avoids relying on flexbox's own shrink algorithm to
              absorb the divider's width, which would fight the panes' own
              explicit percentages. `setSplitRatio` already clamps to
              MIN/MAX_SPLIT_RATIO (25-75), so dragging past either pane's
              practical minimum just stops there rather than collapsing a
              pane to zero. */}
              <div
                onMouseDown={handleSplitDividerMouseDown}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize split view"
                data-testid="split-divider"
                className="group flex h-full w-1.5 shrink-0 cursor-col-resize items-stretch justify-center"
              >
                {/* The 6px outer div is the drag/hover HIT TARGET, kept wide
                for a comfortable cursor grab area; this 1px inner line is
                the only part actually painted at rest (matching
                FindBar.tsx's own `bg-border-chrome` vertical-divider
                precedent), so the divider reads as a real, visible seam
                rather than invisible until the pointer happens to land on
                it -- `group-hover`/`group-active` widen and accent-color it
                on the outer div's own hover/active state, not this line's
                own (a 1px target would be unusably narrow to hover). */}
                <div className="w-px bg-border-chrome group-hover:w-1 group-hover:bg-accent/40 group-active:w-1 group-active:bg-accent" />
              </div>
              {/* Deliberately NOT overflow-auto/overflow-scroll -- see this
              branch's own comment above for why a scrolling right pane would
              silently desync the native preview from its placeholder. */}
              <div style={{ width: `calc(${100 - splitRatio}% - 3px)` }} className="h-full">
                <SplitPreview
                  content={content}
                  filePath={filePath}
                  // Every full-screen `fixed inset-0` overlay this screen can
                  // show, OR'd together -- the native preview view composites
                  // above ALL DOM, so each of them would otherwise be
                  // partially painted over (see SplitPreview's own overlayOpen
                  // doc comment for the measured ShortcutsHelpModal overlap
                  // that this second term fixes). Any future full-screen
                  // overlay rendered from this screen belongs in this
                  // expression too; audited 2026-08-09 and these are the only
                  // two in src/renderer/src.
                  overlayOpen={pageSetupOpen || shortcutsHelpOpen}
                  targetPage={effectiveCurrentPage}
                  onPageChange={(state) => {
                    setCurrentPage(state.currentPage)
                    // Any confirmation here (poll, click-nav, or Follow's
                    // own request) proves -- via the harness queue's FIFO
                    // ordering -- that whatever Follow last dispatched has
                    // already drained, so this clears its in-flight guard
                    // early rather than making it always wait out its own
                    // bounded safety timeout. See useSplitFollowScroll.ts's
                    // notifySettled doc comment.
                    splitFollowScroll.notifySettled()
                  }}
                  remoteImagesAllowed={remoteImagesAllowed === true}
                  onRenderError={setSplitPreviewError}
                />
              </div>
            </div>
          ) : (
            // The scroll container is NOT the scaled element -- that was a
            // measured, highly visible bug. `transform: scale()` on the
            // scroller itself scaled the scroller's own painted box while
            // leaving its LAYOUT box (and therefore scrollWidth/scrollHeight)
            // completely unchanged, so above 100% the content simply grew past
            // the clipping `overflow-hidden` parent with no scrollable extent
            // to reach it: measured at 150% in the real built app, the canvas
            // box was 216->1000 while the pane painted 20->1196, i.e. 196px
            // clipped off the left and 244px off the right, with
            // maxScrollLeft stuck at 32px and maxScrollTop at 0. Below 100% it
            // failed the opposite way -- the whole scroller shrank (392x327
            // inside a 784x653 box), leaving dead grey where the pane should
            // still have been.
            //
            // The fix is the standard one: keep the scroller unscaled and at
            // full size, and scale an INNER wrapper, so the scroller sizes
            // itself to the scaled content and scrolls normally in both axes.
            // `zoom` rather than `transform: scale()` on that wrapper is
            // deliberate, and is what makes this a two-line change instead of
            // a measurement layer: `zoom` participates in LAYOUT (Chromium has
            // implemented the standardized, layout-affecting `zoom` since 128;
            // this app ships Chromium via Electron 39), so the scroll
            // container's own scrollWidth/scrollHeight already account for it.
            // A transform does not, so keeping it would have required a
            // ResizeObserver on the content plus a spacer element sized to
            // naturalSize * zoom -- with a real feedback loop between the
            // spacer's size and scrollbar-driven client-width changes on
            // platforms with non-overlay scrollbars.
            //
            // The two `transform`-specific facts recorded elsewhere survive
            // this change unharmed, both re-checked rather than assumed:
            // coordsAtPos still reports post-zoom viewport coordinates (it
            // bottoms out in Range.getClientRects, which is zoom-adjusted the
            // same way it is transform-adjusted), so SelectionBubble must
            // still NOT divide by zoom; and the bubble/slash palette still
            // render at EditorScreen's own root rather than inside this
            // wrapper.
            //
            // That second one used to be described here as "now
            // belt-and-braces rather than load-bearing", on the grounds that a
            // `transform` establishes a containing block for fixed-position
            // descendants and `zoom` does not. The premise is right and the
            // conclusion drawn from it was wrong, so it is corrected rather
            // than softened: measuring the real app shows `zoom` multiplies a
            // fixed descendant's OFFSETS as well as its size (left:400 top:300
            // renders at x=240 y=180 under `zoom: 0.6`), so nesting either
            // surface here would still mis-anchor it. The placement stays
            // fully load-bearing; only the mechanism changed.
            //
            // The wrapper takes `h-full` only in Source mode: SourceEditor is
            // a `h-full w-full` textarea, which needs a definite height to
            // resolve against, while the page card must stay natural-height so
            // the scrollable extent matches the document rather than adding
            // empty space below it.
            <div ref={editorPaneRef} className="h-full overflow-auto">
              <div className={viewMode === 'source' ? 'h-full' : undefined} style={{ zoom }}>
                {viewMode === 'source' ? renderSourceEditor() : renderPageCard()}
              </div>
            </div>
          )}
        </div>
      </div>
      <EditorStatusBar
        content={content}
        isDirty={isDirty}
        pageCount={pageCount}
        pageCountPending={pageCountPending}
        currentPage={effectiveCurrentPage}
        onNavigateToPage={handleNavigateToPage}
        // The scale the canvas is ACTUALLY rendered at, which in Split mode is
        // the fit-to-width scale and not the user's own (inapplicable) zoom.
        // Reporting `zoom` here regardless would restate the exact defect this
        // control was already fixed for once -- a readout naming a scale the
        // pane is not rendering at -- only pointing the other way (it would now
        // say 100% while the page renders at 71%).
        //
        // KEYED ON `viewMode === 'split'`, NOT on `splitFitApplies`, and that
        // is a fix rather than a tidy-up. Split(SOURCE) has no fixed page width
        // to fit, so `splitFitScale` is 1 there -- but the old condition fell
        // back to the user's `zoom` in exactly that case, which is the ONE
        // number guaranteed not to be what the pane is rendering at: Split's
        // two-pane row lives outside the zoom wrapper entirely, so a user who
        // had picked 150% in Format saw the status bar keep saying 150% over a
        // Split(source) pane rendering at 100%. `splitFitScale` is the honest
        // answer in BOTH Split sub-modes, because "no fit applied" and "no zoom
        // applied" are the same 1.
        zoom={viewMode === 'split' ? splitFitScale : zoom}
        onZoomChange={setZoom}
        // See zoomApplies' own comment above: the control is disabled rather
        // than hidden, so the current level stays readable in Split mode
        // instead of the readout vanishing and reappearing on every mode
        // switch.
        zoomEnabled={zoomApplies}
        splitPreviewError={viewMode === 'split' ? splitPreviewError : null}
      />
      <PageSetupModal
        open={pageSetupOpen}
        initialConfig={pageConfig}
        onApply={handleApplyPageConfig}
        onClose={closePageSetup}
      />
      {/* ShortcutsHelpModal itself is rendered by App.tsx now, not here --
      product-completeness audit Tier 3, C. Rendering it in both places would
      mount two independent instances (two competing focus traps) any time a
      document happens to be open; `shortcutsHelpOpen` above is still read by
      this screen for SplitPreview's overlayOpen and SelectionBubble's
      suppressed list, which need to know the modal is open regardless of
      which component renders it. */}
      {/* Rendered HERE, at this screen's root alongside the modals and Toast,
      and deliberately NOT inside `document-content` -- both the single-pane
      branch and Split's left pane wrap their content in CSS `zoom`, which
      multiplies a fixed-position descendant's OFFSETS as well as its size
      (measured: a fixed box at left:400 top:300 lands at x=240 y=180 at 60%
      size inside `zoom: 0.6`). A bubble nested in there would be both
      mis-anchored and rendered at the zoom factor's own size. This used to
      say "a transform establishes a containing block for fixed-position
      descendants" -- true of the `transform: scale()` these wrappers once
      used, and NOT true of `zoom`; the conclusion is unchanged, the mechanism
      is not. See SelectionBubble.tsx's module comment for the measurement.

      `suppressed` is every overlay/composer that can be open at the same time:
      the two full-screen modals (which the bubble would otherwise sit on top
      of, being z-40 under their z-50) plus the two composers, which the
      bubble's own Link/Add-comment buttons open. THAT SECOND REASON CHANGED
      WITH THE COMPOSERS AND STAYED TRUE, which is the dangerous shape of
      stale comment, so it is restated rather than left: it used to be "opening
      either shifts the whole content area downward, invalidating the anchor
      this bubble was placed against," and a popover shifts nothing. It is now
      the opposite problem -- both surfaces anchor to the SAME selection rect,
      so without suppression a composer would open directly on top of the
      bubble that spawned it. Find is deliberately absent: it needs no
      suppression, because applyFindState selects each match WITHOUT focusing,
      so snapshot.hasFocus is already false while the user is in the find
      bar. */}
      <SelectionBubble
        snapshot={liveSelection}
        anchor={selectionAnchor}
        safe={selectionSafeRect}
        suppressed={pageSetupOpen || shortcutsHelpOpen || commentComposerOpen || linkComposerOpen}
        onRemeasure={measureSelectionGeometry}
        paneRef={editorPaneRef}
        commands={{
          // Dispatched through the SAME MilkdownEditorHandle methods the
          // persistent toolbar uses, not a second command path -- the
          // historyKeymap-vs-toolbar precedent, so the two surfaces cannot
          // drift apart in what "Bold" means.
          toggleBold: () => editorRef.current?.toggleBold(),
          toggleItalic: () => editorRef.current?.toggleItalic(),
          toggleInlineCode: () => editorRef.current?.toggleInlineCode(),
          toggleHeading: (level) => editorRef.current?.toggleHeading(level),
          setParagraph: () => editorRef.current?.setParagraph(),
          insertLink: openLinkComposer,
          addComment: openCommentComposer,
          removeLink: () => editorRef.current?.removeLink(),
          // Table structure editing. Same "dispatch through the SAME
          // MilkdownEditorHandle methods, never a second command path" rule as
          // the formatting commands above.
          addRowBefore: () => editorRef.current?.addRowBefore(),
          addRowAfter: () => editorRef.current?.addRowAfter(),
          addColumnBefore: () => editorRef.current?.addColumnBefore(),
          addColumnAfter: () => editorRef.current?.addColumnAfter(),
          deleteRow: () => editorRef.current?.deleteRow(),
          deleteColumn: () => editorRef.current?.deleteColumn(),
          deleteTable: () => editorRef.current?.deleteTable(),
          setColumnAlignment: (alignment) => editorRef.current?.setColumnAlignment(alignment)
        }}
      />
      {/* The two composer POPOVERS, rendered at this root for exactly the same
      reason SelectionBubble immediately above is: both the single-pane branch
      and Split's left pane wrap their content in CSS `zoom`, which multiplies
      a fixed-position descendant's OFFSETS as well as its size, so a popover
      nested in there would be both mis-anchored and rendered at the zoom
      factor's own size. They read their anchor through `readSelectionGeometry`
      -- the SAME reader that feeds the bubble -- so the popover opens exactly
      where the bubble that spawned it was, rather than at a second,
      independently-derived position. */}
      <CommentComposer
        onAddComment={handleAddComment}
        measure={readSelectionGeometry}
        paneRef={editorPaneRef}
      />
      <LinkComposer
        // Prefilled from the live selection snapshot, so editing an existing
        // link starts from its real current URL rather than a blank field --
        // half of the fix for the "correcting a link's URL DELETED the link"
        // bug (EditorCommands.insertLink's update-vs-toggle branch is the
        // other half). Empty string when the selection carries no link, which
        // is also what switches the popover between Insert and Update wording
        // and decides whether "Remove link" is offered at all.
        initialHref={liveSelection?.linkHref ?? ''}
        onInsertLink={handleInsertLink}
        onRemoveLink={handleRemoveLink}
        measure={readSelectionGeometry}
        paneRef={editorPaneRef}
      />
      {/* Same "render unconditionally at EditorScreen root" convention as
      SelectionBubble immediately above -- the component's own `items.length
      > 0 && anchor != null && safe != null` check (SlashMenu.tsx) decides
      visibility, so this screen doesn't need a second, parallel `slashMenu.state
      && (...)` gate here. No `suppressed` prop, unlike SelectionBubble: every
      overlay that could otherwise occlude/conflict with an open session
      (Page Setup, Comment/Link composers, and now ShortcutsHelpModal too,
      via useModalDialog's focus-in) already blurs the editor on open, which
      the slash plugin's own blur handler already closes the session for.
      ShortcutsHelpModal's Mod-/ path additionally closes it explicitly via
      closeSlashMenu() in that shortcut's own handler above, for the reason
      documented there: useModalDialog's blur is real but lands a render
      later, and the explicit call is what makes the close visually
      immediate rather than adding a suppressed prop this component doesn't
      otherwise need. */}
      <SlashMenu
        items={slashMenu.state?.items ?? []}
        activeIndex={slashMenu.state?.activeIndex ?? 0}
        anchor={slashMenu.state?.rects.anchor ?? null}
        safe={slashMenu.state?.rects.safe ?? null}
        onChoose={slashMenu.onChoose}
        onHover={slashMenu.onHover}
      />
      {toast && <Toast key={toast.id} message={toast.message} onDismiss={() => setToast(null)} />}
    </div>
  )
}

export default EditorScreen
