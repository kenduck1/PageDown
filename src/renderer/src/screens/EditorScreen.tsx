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
    if (choice === 'discard' && filePath) {
      // "Don't Save" means exactly that -- a pending autosave snapshot must
      // never silently reappear on next open. `new Date().toISOString()` is
      // "now" as a reasonable stand-in for "the document's own last-saved
      // timestamp"; clearPendingAutosave only deletes snapshots STRICTLY
      // NEWER than this, so it's safe even if it's a few seconds later than
      // the document's actual on-disk mtime -- the goal is "delete the
      // pending unsaved autosave," not precise timestamp matching.
      // Fire-and-forget: clearPendingAutosave's own IPC handler already
      // validates the path and swallows failures (never rejects), and this
      // runs after the discard decision is already final, so it can't
      // affect navigation either way.
      void window.api.clearPendingAutosave(filePath, new Date().toISOString())
    }
    goHome()
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

  const handleRestoreVersion = (restoredContent: string): void => {
    // Restoring is an externally-originated content change, exactly like
    // Page Setup's Apply -- the live editor must remount to pick it up
    // rather than silently overwrite it on the next real edit. If there
    // are unsaved edits right now, flush + Save them first so nothing
    // is lost -- the currently-unsaved state becomes its own snapshot on
    // the next autosave tick or explicit Save, never silently discarded.
    const flushAndRestore = async (): Promise<void> => {
      if (isDirty) {
        editorRef.current?.flush()
        await save()
      }
      replaceContent(restoredContent)
    }
    void flushAndRestore()
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
      <EditorTabBar />
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
          <MilkdownEditor
            ref={editorRef}
            key={revision}
            content={content}
            // Bound to THIS render's activeTabId, not the bare updateContent
            // store action -- see documentStore.ts's updateContentForTab doc
            // comment for the tab-switch race this closes: any change to
            // activeTabId always bumps revision (remounting this component
            // with a fresh key), so the activeTabId captured here is
            // guaranteed correct for this specific MilkdownEditor instance's
            // entire lifetime, even after a late flush() fires (e.g. on
            // unmount, when the user has switched tabs) well after the
            // store's own activeTabId has moved on.
            onChange={(markdown) => updateContentForTab(activeTabId, markdown)}
            onError={(message) => useDocumentStore.setState({ error: message })}
          />
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
