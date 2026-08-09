import { forwardRef, useImperativeHandle } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MilkdownEditorHandle } from '../milkdown/MilkdownEditor'

// Companion to EditorScreen.test.tsx's 'Source mode wiring' describe block,
// covering ONE specific thing that file structurally cannot: whether
// handleSetViewMode's OWN `editorRef.current?.flush()` call (EditorScreen.tsx)
// is what makes an unflushed edit reach Source mode's textarea.
//
// Fix-round-1 finding (verified by mutation testing, not assumed): against
// the REAL MilkdownEditor, deleting that flush() call from handleSetViewMode
// does not fail EditorScreen.test.tsx's own 'switching Format -> Source
// flushes...' test. Root cause: MilkdownEditor's own unmount cleanup
// (MilkdownEditor.tsx) already calls its internal flushRef.current?.()
// before editor.destroy(), and switching to Source mode always unmounts
// MilkdownEditor (the Format/Source JSX conditional in EditorScreen.tsx
// swaps element types entirely, which React reconciles as unmount-then-
// mount, not a keyed update) -- so the pending edit reaches the store
// through that independent path regardless of whether handleSetViewMode
// itself flushes. The observable outcome (Source mode shows the edit) is
// therefore produced by a different mechanism than the one under test, and
// no assertion phrased purely in terms of that outcome can tell them apart.
//
// This file's fake MilkdownEditor deliberately has NO unmount side effect,
// which removes that confound: with the auto-flush-on-unmount path gone,
// handleSetViewMode's own flush() call becomes the ONLY thing that can call
// the mocked handle's flush method, so asserting it was called genuinely
// discriminates.
//
// Both handleSetViewMode calls this file and EditorScreen.test.tsx's
// discriminating replaceContentForTab spy cover are intentionally KEPT in
// production code even though neither is observably necessary against
// TODAY's JSX shape (see handleSetViewMode's own doc comment in
// EditorScreen.tsx) -- they're plan- and design-doc-mandated defense-in-
// depth that becomes load-bearing the moment that shape changes (e.g. Split
// mode keeping both editors permanently mounted, at which point the
// unmount-triggers-flush and type-swap-forces-remount side effects these
// calls currently ride on both disappear). Hence the mechanism-level,
// spy/mutation-based tests here and in EditorScreen.test.tsx, rather than
// deleting the calls because a first pass at outcome-only testing couldn't
// tell them apart from unrelated side effects.
const { mockEditorHandle } = vi.hoisted(() => ({
  mockEditorHandle: {
    flush: vi.fn(),
    toggleBold: vi.fn(),
    toggleItalic: vi.fn(),
    toggleHeading: vi.fn(),
    setParagraph: vi.fn(),
    toggleBulletList: vi.fn(),
    toggleOrderedList: vi.fn(),
    insertLink: vi.fn(),
    insertTable: vi.fn(),
    insertPageBreak: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    focusEnd: vi.fn(),
    setFindState: vi.fn(),
    replaceActiveMatch: vi.fn(),
    replaceAllMatches: vi.fn(),
    getSelectedText: vi.fn(() => '')
  }
}))

// Module-mocked (not just a fake ref, as EditorToolbar.test.tsx's
// createFakeEditorHandle uses for a component that already takes its editor
// handle as a prop) because EditorScreen owns its own editorRef internally
// and constructs the real MilkdownEditor itself -- there's no prop seam to
// inject a fake handle through from outside. Scoped to this dedicated file,
// not EditorScreen.test.tsx itself, because vi.mock's module-wide
// replacement would also break every one of that file's other tests, most
// of which depend on a real mounted ProseMirror instance (real DOM edits,
// real .ProseMirror queries, real ~200ms ondChange debounce timing).
vi.mock('../milkdown/MilkdownEditor', () => ({
  default: forwardRef<MilkdownEditorHandle, { content: string }>(
    function FakeMilkdownEditor(props, ref) {
      // Deliberately NO cleanup effect / unmount side effect -- the real
      // MilkdownEditor's own unmount-cleanup flush() call is exactly the
      // confound this fake exists to remove (see module comment above).
      useImperativeHandle(ref, () => mockEditorHandle, [])
      return <div data-testid="fake-milkdown-editor">{props.content}</div>
    }
  )
}))

import EditorScreen from './EditorScreen'
import { useAppStore, initialAppState } from '../store/appStore'
import { useDocumentStore, initialDocumentState } from '../store/documentStore'

beforeEach(() => {
  useAppStore.setState(initialAppState)
  useDocumentStore.setState(initialDocumentState)
  Object.values(mockEditorHandle).forEach((fn) => fn.mockClear())
  window.api = {
    openFile: vi.fn(),
    openPath: vi.fn(),
    saveFile: vi.fn(),
    getRecentFiles: vi.fn(),
    getThumbnail: vi.fn(),
    getTemplateThumbnail: vi.fn(),
    getPageCount: vi.fn().mockResolvedValue({ pageCount: 1 }),
    confirmDiscardChanges: vi.fn(),
    exportPdf: vi.fn(),
    print: vi.fn(),
    getPreferences: vi.fn(),
    setPreferences: vi.fn(),
    autosaveSnapshot: vi.fn(),
    getVersionHistory: vi.fn(),
    restoreVersionContent: vi.fn(),
    clearPendingAutosave: vi.fn(),
    setSplitPreviewBounds: vi.fn(),
    // See EditorScreen.test.tsx's own comment on this same mock -- resolved
    // (not bare) as of Task 5, since Split mode transitions in this file's
    // own new tests below genuinely mount a real SplitPreview.
    sendSplitPreviewDocument: vi.fn().mockResolvedValue({ pageCount: 1 }),
    destroySplitPreview: vi.fn(),
    // Same rationale as sendSplitPreviewDocument above -- SplitPreview.tsx's
    // own effects call .then()/.catch() on these unconditionally too.
    scrollSplitPreviewToPage: vi.fn().mockResolvedValue({ currentPage: 1, pageCount: 0 }),
    getSplitPreviewPage: vi.fn().mockResolvedValue({ currentPage: 1, pageCount: 0 }),
    saveDroppedImage: vi.fn(),
    openInNewWindow: vi.fn()
  }
})

afterEach(() => {
  cleanup()
})

describe('EditorScreen view-mode coordination: handleSetViewMode flush() call (mocked MilkdownEditor)', () => {
  it("Format -> Source calls editorRef.current.flush(), discriminated from the mocked editor's own unmount (which has none)", async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    useAppStore.setState({ viewMode: 'format' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    expect(mockEditorHandle.flush).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Source' }))

    expect(mockEditorHandle.flush).toHaveBeenCalledTimes(1)
  })

  it('Source -> Format does NOT call flush() -- only Format -> Source has an outgoing Milkdown edit to flush', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    useAppStore.setState({ viewMode: 'source' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Format' }))

    expect(mockEditorHandle.flush).not.toHaveBeenCalled()
  })

  // Split mode generalizes the format<->source flush/remount contract onto
  // "format editing" and "source editing" as abstract concepts, each
  // covering BOTH the plain mode and Split mode with that left pane (see
  // handleSetViewMode's own doc comment in EditorScreen.tsx). These two
  // tests are the Split-mode equivalents of the pair directly above,
  // discriminated the same way -- against this file's own flush-with-no-
  // unmount-side-effect fake, so a pass here can only mean
  // handleSetViewMode's OWN flush() call fired, not MilkdownEditor's
  // (absent, by this fake's design) unmount cleanup.
  it('Format -> Split(source) calls editorRef.current.flush(), same as a plain Format -> Source transition', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    useAppStore.setState({ viewMode: 'format', splitLeftMode: 'source' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    expect(mockEditorHandle.flush).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Split' }))

    expect(mockEditorHandle.flush).toHaveBeenCalledTimes(1)
  })

  it('Split(source) -> Format does NOT call flush() -- entering Format editing from Source editing has nothing outgoing to flush', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    useAppStore.setState({ viewMode: 'split', splitLeftMode: 'source' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    await user.click(screen.getByRole('button', { name: 'Format' }))

    expect(mockEditorHandle.flush).not.toHaveBeenCalled()
  })

  // Fix round 1 (post-Task-5 review, Important 1): the ONE format<->source
  // pair Split mode introduces that the initial pass above left untested --
  // split(format)<->source. The four-boolean formula covers it identically
  // to every other pair (leavingFormatEditing && enteringSourceEditing for
  // this direction), but "the formula covers it" and "a test exercises it"
  // are different claims; this closes that gap the same discriminating way
  // as its four siblings above.
  it('Split(format) -> Source calls editorRef.current.flush(), same as a plain Format -> Source transition', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    useAppStore.setState({ viewMode: 'split', splitLeftMode: 'format' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    expect(mockEditorHandle.flush).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Source' }))

    expect(mockEditorHandle.flush).toHaveBeenCalledTimes(1)
  })

  // Final whole-branch review finding, C1 (Critical, blocked merge) --
  // CORRECTED, was previously the exact inverse assertion. format and
  // split(format) are the same CONCEPTUAL editing surface (both are
  // MilkdownEditor), but they live at two different STRUCTURAL positions in
  // the JSX (the single-pane branch vs Split's own left-pane branch), so
  // React still unmounts the outgoing instance and mounts a fresh one across
  // this transition -- the fresh instance's mount-time render captures
  // `content` one tick before flush() would otherwise sync a pending edit,
  // which is exactly the data-loss bug C1 was. flush() MUST fire here now;
  // the version of this test that asserted the opposite is what let the
  // bug ship in the first place (see this describe block's own header
  // comment and docs/superpowers/plans/2026-08-04-ga-push-decisions-log.md
  // for the full story).
  it('Format -> Split(format) DOES call flush() -- same conceptual surface, but a different structural position that remounts it', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    useAppStore.setState({ viewMode: 'format', splitLeftMode: 'format' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    expect(mockEditorHandle.flush).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Split' }))

    expect(mockEditorHandle.flush).toHaveBeenCalledTimes(1)
  })

  // Symmetric case: split(format) -> Format also remounts across the same
  // structural-position change, in the opposite direction.
  it('Split(format) -> Format DOES call flush()', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    useAppStore.setState({ viewMode: 'split', splitLeftMode: 'format' })
    const user = userEvent.setup()
    render(<EditorScreen />)

    expect(mockEditorHandle.flush).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Format' }))

    expect(mockEditorHandle.flush).toHaveBeenCalledTimes(1)
  })
})
