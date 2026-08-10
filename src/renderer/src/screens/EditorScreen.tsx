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
import ShortcutsHelpModal from '../components/ShortcutsHelpModal'
import FindBar from '../components/FindBar'
import CommentComposer from '../components/CommentComposer'
import LinkComposer from '../components/LinkComposer'
import RemoteImageBanner from '../components/RemoteImageBanner'
import SelectionBubble from '../components/SelectionBubble'
import SlashMenu from '../components/SlashMenu'
import Toast from '../components/Toast'
import { intersectRect, sameRect, type Rect } from '../lib/floating-position'
import type { SelectionSnapshot } from '../milkdown/selection-plugin'
import { extractOutline } from '../lib/extractOutline'
import { isFormatEditing, isSourceEditing } from '../lib/editing-surface'
import { usePageCount } from '../hooks/usePageCount'
import { useAutosave } from '../hooks/useAutosave'
import { useFindController } from '../hooks/useFindController'
import { useFindShortcuts, openFindFromShortcut } from '../hooks/useFindShortcuts'
import { useSlashMenu } from '../hooks/useSlashMenu'
import { useMenuCommands } from '../hooks/useMenuCommands'
import { useFindStore } from '../store/findStore'
import { DEFAULT_ZOOM, nextZoomLevel, previousZoomLevel } from '../lib/zoom-levels'
import { extractRawFrontmatter, replaceRawFrontmatter } from '../../../markdown/frontmatter-splice'
import {
  resolvePageConfig,
  applyPageConfig,
  type PageConfig,
  type PageFontFamily
} from '../../../markdown/page-config'
import { computePageGeometry } from '../../../typography/page-geometry'
import { resolveDocumentStyle } from '../../../typography/document-style'

// Exact copy pinned in docs/superpowers/specs/2026-08-08-undo-barrier-notice-design.md
// -- a single, direction-agnostic sentence (not "Switched to Source"/"Switched
// to Format") because Split mode's left pane makes "which surface" ambiguous
// to name briefly and accurately; this one sentence covers all four real
// transition pairs that destroy undo history.
const UNDO_BARRIER_TOAST_MESSAGE = 'Undo history resets when switching between Format and Source.'

function EditorScreen(): React.JSX.Element {
  const goHome = useAppStore((state) => state.goHome)
  const pageSetupOpen = useAppStore((state) => state.pageSetupOpen)
  const closePageSetup = useAppStore((state) => state.closePageSetup)
  const shortcutsHelpOpen = useAppStore((state) => state.shortcutsHelpOpen)
  const commentComposerOpen = useAppStore((state) => state.commentComposerOpen)
  const openCommentComposer = useAppStore((state) => state.openCommentComposer)
  const linkComposerOpen = useAppStore((state) => state.linkComposerOpen)
  const openLinkComposer = useAppStore((state) => state.openLinkComposer)
  const openShortcutsHelp = useAppStore((state) => state.openShortcutsHelp)
  const closeShortcutsHelp = useAppStore((state) => state.closeShortcutsHelp)
  const viewMode = useAppStore((state) => state.viewMode)
  const setViewMode = useAppStore((state) => state.setViewMode)
  const splitLeftMode = useAppStore((state) => state.splitLeftMode)
  const splitRatio = useAppStore((state) => state.splitRatio)
  const setSplitRatio = useAppStore((state) => state.setSplitRatio)
  const currentPage = useAppStore((state) => state.currentPage)
  const setCurrentPage = useAppStore((state) => state.setCurrentPage)
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
  const isDirty = useDocumentStore((state) => state.isDirty)
  const error = useDocumentStore((state) => state.error)
  const clearError = useDocumentStore((state) => state.clearError)
  const save = useDocumentStore((state) => state.save)
  const saveAs = useDocumentStore((state) => state.saveAs)
  const exportPdf = useDocumentStore((state) => state.exportPdf)
  const print = useDocumentStore((state) => state.print)
  const saveDroppedImage = useDocumentStore((state) => state.saveDroppedImage)
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
  const [zoom, setZoom] = useState(1)
  const [activeSourceOffset, setActiveSourceOffset] = useState<number | undefined>(undefined)
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
  const measureSelectionGeometry = useCallback((): void => {
    const anchor = editorRef.current?.getSelectionRect() ?? null
    setSelectionAnchor((prev) => (sameRect(prev, anchor) ? prev : anchor))
    const pane = editorPaneRef.current
    const canvas = canvasRef.current
    const safe =
      pane && canvas
        ? intersectRect(canvas.getBoundingClientRect(), pane.getBoundingClientRect())
        : null
    setSelectionSafeRect((prev) => (sameRect(prev, safe) ? prev : safe))
  }, [])

  const handleSelectionChanged = useCallback(
    (snapshot: SelectionSnapshot | null): void => {
      setSelectionSnapshot(snapshot)
      measureSelectionGeometry()
    },
    [measureSelectionGeometry]
  )
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
  const { pageCount, loading: pageCountPending } = usePageCount(
    content,
    filePath,
    undefined,
    remoteImagesAllowed === true
  )
  // undefined (not preferences?.autosaveIntervalMs ?? somethingElse) when
  // preferences haven't loaded yet -- useAutosave's own default parameter
  // already falls back to the pre-existing 45s constant in that case, so
  // there's no need to duplicate that fallback value here too.
  const autosaveIntervalMs = usePreferencesStore((state) => state.preferences?.autosaveIntervalMs)
  useAutosave({ content, filePath, isDirty, intervalMs: autosaveIntervalMs })
  // Same narrow, single-field selector style as autosaveIntervalMs above --
  // backs handleAddComment below.
  const authorName = usePreferencesStore((state) => state.preferences?.authorName)

  // A different document -- or a different tab -- is a different set of
  // pages, so the current page must not carry over. Without this, opening a
  // 2-page letter while sitting on page 9 of a report leaves the status bar
  // claiming page 9 (and the Pages list highlighting a row that no longer
  // exists).
  //
  // Keyed on document IDENTITY (`activeTabId` + `filePath`), deliberately
  // NOT on `revision`. `revision` bumps on any in-place content rewrite,
  // including `handleSetViewMode`'s own `replaceContentForTab` call -- so a
  // revision-keyed reset silently broke this feature's headline path:
  // clicking "next page" in Format mode set the page, switched to Split,
  // and the resulting revision bump immediately reset the page back to 1,
  // landing the user on page 1 of a preview they had asked to open at page
  // 2. A revision bump from an in-place rewrite (mode switch, Page Setup
  // apply, History restore) is the SAME document, and the page count
  // shrinking underneath is already handled by the clamp below.
  useEffect(() => {
    setCurrentPage(1)
  }, [activeTabId, filePath, setCurrentPage])

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
  // file: unlike Find, this has no selection-seeding/focus-management logic
  // to justify a separate module, just "open a modal." Mod-/ (not `?`
  // alone, which would fire on every literal `/` a user types while
  // editing) is the common convention this mirrors (VS Code, Linear, Slack,
  // ...). Escape-to-close is NOT handled here -- the modal composes with the
  // SAME scrim-click-to-close pattern PageSetupModal already uses, and
  // ProseMirror already has meaning for a global Escape (nothing currently
  // relies on it, but Find's own Escape handling is intentionally scoped to
  // only fire `closeFind` while Find is open, matching this same
  // one-listener-per-surface discipline rather than one shared catch-all).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === '/') {
        event.preventDefault()
        // Slash menu (Task 5 addition): ShortcutsHelpModal renders no
        // autofocus element (confirmed by reading it -- unlike
        // CommentComposer/LinkComposer, both of which do), so opening it via
        // this bare keydown listener does NOT blur the ProseMirror editor
        // DOM node the way clicking a real toolbar button would -- and the
        // slash plugin's own auto-close only fires on that blur (or on
        // Escape, or on the selection leaving the tracked range). Without
        // this call, a slash session left open when Mod-/ fires would stay
        // open (and focused) underneath the newly-opened modal. Every OTHER
        // overlay this screen can open (Page Setup, Find, Comment/Link
        // composers) already blurs the editor on its own -- this is the one
        // real gap, and the reason MilkdownEditorHandle.closeSlashMenu()
        // exists at all (see its own doc comment in editor-commands.ts).
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
    'file:print': () => void print(),
    'edit:find': () =>
      openFindFromShortcut(
        { getSelectedText: findController.getSelectedText, queryInputRef: findQueryInputRef },
        false
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
    // Stepped through the SAME level list the status bar's zoom <select>
    // renders -- an off-list value would blank that control (see
    // lib/zoom-levels.ts).
    'view:zoomIn': () => setZoom((current) => nextZoomLevel(current)),
    'view:zoomOut': () => setZoom((current) => previousZoomLevel(current)),
    'view:zoomReset': () => setZoom(DEFAULT_ZOOM),
    'view:toggleSidebar': () => toggleSidebar(),
    'app:shortcuts': () => {
      // Same closeSlashMenu() call the Mod-/ keydown listener below makes,
      // for the same reason -- ShortcutsHelpModal autofocuses nothing, so
      // opening it does not blur the ProseMirror node, and the slash
      // plugin's own auto-close only fires on that blur.
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
    editorRef.current?.insertLink(href)
  }

  // authorName '' (the default -- no accounts system, see Preferences'
  // own comment) falls back to the literal label "You" here, matching
  // EditorComments.tsx's own identical fallback for DISPLAYING an existing
  // comment's author -- keeping both fallbacks in the same place they're
  // used, rather than baking "You" into the stored preference default
  // itself, which would make an genuinely-blank preference indistinguishable
  // from a user who deliberately typed "You" as their name.
  const handleAddComment = (text: string): boolean => {
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

  const handleApplyPageConfig = (config: PageConfig): void => {
    const newRawYaml = applyPageConfig(extractRawFrontmatter(content), config)
    // replaceContent (not updateContent): this edit originates outside the
    // live mounted editor, so the editor must remount to pick it up rather
    // than silently overwrite it on the next real edit -- see
    // documentStore.ts's replaceContent doc comment.
    replaceContent(replaceRawFrontmatter(content, newRawYaml))
    closePageSetup()
  }

  // The toolbar's font-family control. Deliberately routed through the same
  // frontmatter write path as Page Setup rather than held as UI-only state:
  // the font is a property OF THE DOCUMENT (it has to survive save/reopen
  // and reach the paginator and PDF export), so the document's own YAML is
  // the only correct home for it. Consequence worth knowing: like any
  // frontmatter change this bumps `revision` and therefore remounts the
  // editor, which costs the cursor position -- the same tradeoff Page
  // Setup's Apply already makes, and the reason this is a toolbar control
  // rather than something wired to every keystroke.
  const handleSetFontFamily = (fontFamily: PageFontFamily): void => {
    const newRawYaml = applyPageConfig(extractRawFrontmatter(content), {
      ...pageConfig,
      fontFamily
    })
    replaceContent(replaceRawFrontmatter(content, newRawYaml))
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
  // Top/bottom padding stay the mock's fixed 22px/34px and are deliberately
  // NOT geometry.marginTopPx/marginBottomPx, even though left/right now are
  // the document's real margins. They're cosmetic card chrome, not the
  // page's own vertical margin: where content actually sits relative to a
  // page's top/bottom edge is the paginator's concern, and this single
  // unpaginated card has no page boundaries to place them against in the
  // first place. Gate 10 only measures block positions relative to each
  // surface's own content root, so vertical chrome outside the editing root
  // doesn't affect it either way. Don't "finish the job" by wiring these two
  // up -- an EditorScreen.test.tsx test asserts they stay 22/34 for a
  // document whose real top/bottom margins are 96px.
  //
  // Deliberately natural-height (grows/shrinks with the document, not
  // stretched to fill the canvas) -- an earlier version of this fix tried to
  // make the WHOLE card's blank space part of the clickable editable region
  // (via a min-height/flexbox chain forcing ProseMirror's own DOM to
  // physically fill the card), which was the wrong goal entirely, not just
  // hard to get right: a real editor's text only exists where you've
  // actually typed content or pressed Enter, so clicking below the last real
  // line should move the cursor to the nearest real position (the end of
  // the document), not silently start new content wherever you happened to
  // click, which is what a physically-enlarged editable region would do.
  // handlePageCardClick above implements the actual correct behavior
  // instead.
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
        paddingLeft: pageGeometry.marginLeftPx,
        paddingRight: pageGeometry.marginRightPx,
        paddingTop: 22,
        paddingBottom: 34
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
        onDropImage={saveDroppedImage}
        onSelectionChanged={handleSelectionChanged}
        onSlashStateChanged={slashMenu.handleSlashStateChanged}
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
      {error && (
        <div className="flex flex-none items-center gap-3 border-b border-border-chrome bg-red-50 px-3 py-2 text-13 text-red-600">
          <span className="flex-1">{error}</span>
          <button onClick={clearError} className="text-12 font-semibold text-red-600">
            Dismiss
          </button>
        </div>
      )}
      <EditorTabBar onCloseDirtyActiveTab={handleCloseDirtyActiveTab} />
      <EditorToolbar
        editorRef={editorRef}
        onSetViewMode={handleSetViewMode}
        onSetFontFamily={handleSetFontFamily}
        // The same snapshot the selection bubble runs on, reused here so
        // Bold/Italic/list buttons show real pressed state instead of the
        // hardcoded `active={false}` they carried since the design handoff.
        // One source, so the two toolbars can never disagree about whether the
        // cursor is in bold text.
        selection={selectionSnapshot}
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
      {/* Same layout-row placement/reasoning as FindBar immediately above --
      see CommentComposer.tsx's own module comment. */}
      <CommentComposer onAddComment={handleAddComment} />
      {/* Same layout-row placement/reasoning as FindBar/CommentComposer above
      -- see LinkComposer.tsx's own module comment, including why the
      window.prompt call this replaced could never have worked in Electron. */}
      <LinkComposer onInsertLink={handleInsertLink} />
      {/* Same layout-row placement/reasoning as FindBar/CommentComposer above
      -- see RemoteImageBanner.tsx's own module comment. */}
      <RemoteImageBanner />
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
                style={{ width: `calc(${splitRatio}% - 3px)` }}
                className="h-full overflow-auto"
              >
                {splitLeftMode === 'source' ? renderSourceEditor() : renderPageCard()}
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
                  onPageChange={(state) => setCurrentPage(state.currentPage)}
                  remoteImagesAllowed={remoteImagesAllowed === true}
                />
              </div>
            </div>
          ) : (
            <div
              ref={editorPaneRef}
              className="h-full overflow-auto"
              style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}
            >
              {viewMode === 'source' ? renderSourceEditor() : renderPageCard()}
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
        zoom={zoom}
        onZoomChange={setZoom}
      />
      <PageSetupModal
        open={pageSetupOpen}
        initialConfig={pageConfig}
        onApply={handleApplyPageConfig}
        onClose={closePageSetup}
      />
      <ShortcutsHelpModal open={shortcutsHelpOpen} onClose={closeShortcutsHelp} />
      {/* Rendered HERE, at this screen's root alongside the modals and Toast,
      and deliberately NOT inside `document-content` -- the single-pane branch
      wraps its pane in `transform: scale(zoom)`, and a transform establishes a
      containing block for fixed-position descendants, so a bubble nested in
      there would be positioned relative to the scaled wrapper and rendered at
      the zoom factor's own size. See SelectionBubble.tsx's module comment.

      `suppressed` is every overlay/composer that can be open at the same time:
      the two full-screen modals (which the bubble would otherwise sit on top
      of, being z-40 under their z-50) plus the two composer ROWS, which the
      bubble's own Link/Add-comment buttons open -- opening either shifts the
      whole content area downward, invalidating the anchor this bubble was
      placed against. Find is deliberately absent: it needs no suppression,
      because applyFindState selects each match WITHOUT focusing, so
      snapshot.hasFocus is already false while the user is in the find bar. */}
      <SelectionBubble
        snapshot={selectionSnapshot}
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
          addComment: openCommentComposer
        }}
      />
      {/* Same "render unconditionally at EditorScreen root" convention as
      SelectionBubble immediately above -- the component's own `items.length
      > 0 && anchor != null && safe != null` check (SlashMenu.tsx) decides
      visibility, so this screen doesn't need a second, parallel `slashMenu.state
      && (...)` gate here. No `suppressed` prop, unlike SelectionBubble: every
      overlay that could otherwise occlude/conflict with an open session
      (Page Setup, Comment/Link composers) already blurs the editor on open,
      which the slash plugin's own blur handler already closes the session
      for -- the one real exception (ShortcutsHelpModal's Mod-/, which does
      NOT blur) is closed explicitly via closeSlashMenu() in that shortcut's
      own handler above, rather than by adding a suppressed prop this
      component doesn't otherwise need. */}
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
