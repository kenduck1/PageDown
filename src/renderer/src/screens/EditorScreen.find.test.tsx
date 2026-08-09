import { forwardRef, useImperativeHandle } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MilkdownEditorHandle } from '../milkdown/MilkdownEditor'

// Task 7 (Find & Replace sub-project) covers useFindController's wiring into
// EditorScreen: the FindBar's layout position, the Source-mode search/select/
// replace path (driven by a real DOM <textarea>), and the cross-surface
// re-run behavior when the live editing surface changes. Cmd/Ctrl+F, Escape,
// and the toolbar's own Find button are deliberately NOT covered here even
// though the Task 7 brief's own test-description list names them --
// useFindShortcuts (which Cmd+F/Escape depend on) and EditorToolbar's Find
// button wiring both arrive in Task 8, after this file's own commit, so a
// test exercising either here would fail until Task 8 lands, breaking the
// "each task's own commit has a green test suite" invariant this sub-project
// follows the same way every other one in this codebase does. Both are
// covered directly at their own layer instead: useFindShortcuts.test.ts
// (Task 8) exercises Cmd+F/Escape/query-seeding against the hook itself, and
// EditorToolbar.test.tsx's own new "the Find button opens and closes the find
// bar" test (Task 8) exercises the toolbar button directly. Task 8 also
// extends THIS file with the one test that genuinely needs both halves
// present at once -- Cmd+F seeding its query from a live Source-mode
// selection -- once useFindShortcuts is actually wired in below.
//
// Format-mode assertions module-mock MilkdownEditor, the same pattern
// EditorScreen.viewMode.test.tsx already establishes (see that file's own
// module comment for the full rationale) -- EditorScreen owns editorRef
// internally and constructs the real MilkdownEditor itself, so there's no
// prop seam to inject a fake handle through from outside, and asserting
// real ProseMirror-computed match counts/decorations under jsdom is neither
// reliable nor necessary to prove the WIRING (as opposed to the plugin
// itself, already covered by find-plugin's own tests) is correct.
const { mockEditorHandle, findMatchesListeners } = vi.hoisted(() => ({
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
  },
  // Captures whatever onFindMatchesChanged EditorScreen most recently passed
  // to MilkdownEditor, so a test can invoke it directly to simulate
  // milkdown/find-plugin.ts's own view.update callback firing with a REAL
  // surface's real answer -- e.g. "0 matches" for a query that only matches
  // literal Markdown syntax, which the rendered ProseMirror document (Format
  // mode's real search target) never contains. This is what lets the "re-runs
  // the search against the new surface" test below prove the count actually
  // changes for the new surface, without needing real ProseMirror layout
  // under jsdom to compute that 0 itself.
  findMatchesListeners: [] as Array<(count: number, activeIndex: number) => void>
}))

vi.mock('../milkdown/MilkdownEditor', () => ({
  default: forwardRef<
    MilkdownEditorHandle,
    { content: string; onFindMatchesChanged?: (count: number, activeIndex: number) => void }
  >(function FakeMilkdownEditor(props, ref) {
    useImperativeHandle(ref, () => mockEditorHandle, [])
    findMatchesListeners.length = 0
    if (props.onFindMatchesChanged) findMatchesListeners.push(props.onFindMatchesChanged)
    return <div data-testid="fake-milkdown-editor">{props.content}</div>
  })
}))

import EditorScreen from './EditorScreen'
import { useAppStore, initialAppState } from '../store/appStore'
import { useDocumentStore, initialDocumentState } from '../store/documentStore'
import { useFindStore, initialFindState } from '../store/findStore'

beforeEach(() => {
  useAppStore.setState(initialAppState)
  useDocumentStore.setState(initialDocumentState)
  useFindStore.setState(initialFindState)
  Object.values(mockEditorHandle).forEach((fn) => fn.mockClear())
  findMatchesListeners.length = 0
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
    sendSplitPreviewDocument: vi.fn().mockResolvedValue({ pageCount: 1 }),
    destroySplitPreview: vi.fn(),
    scrollSplitPreviewToPage: vi.fn().mockResolvedValue({ currentPage: 1, pageCount: 0 }),
    getSplitPreviewPage: vi.fn().mockResolvedValue({ currentPage: 1, pageCount: 0 }),
    saveDroppedImage: vi.fn()
  }
})

afterEach(() => {
  cleanup()
})

describe('EditorScreen find & replace', () => {
  describe('Source mode', () => {
    it('selects the active match in the Source textarea, and Next match advances it', async () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: 'alpha beta alpha' })
      useAppStore.setState({ viewMode: 'source' })
      const user = userEvent.setup()
      render(<EditorScreen />)

      act(() => {
        useFindStore.getState().openFind()
        useFindStore.getState().setQuery('alpha')
      })

      const textarea = screen.getByRole('textbox', {
        name: 'Markdown source'
      }) as HTMLTextAreaElement
      expect(textarea.selectionStart).toBe(0)
      expect(textarea.selectionEnd).toBe(5)

      await user.click(screen.getByRole('button', { name: 'Next match' }))

      expect(textarea.selectionStart).toBe(11)
      expect(textarea.selectionEnd).toBe(16)
    })

    it('publishes the Source-mode match count into findStore', () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: 'cat dog cat cat' })
      useAppStore.setState({ viewMode: 'source' })
      render(<EditorScreen />)

      act(() => {
        useFindStore.getState().openFind()
        useFindStore.getState().setQuery('cat')
      })

      expect(useFindStore.getState().matchCount).toBe(3)
      expect(useFindStore.getState().capped).toBe(false)
    })

    it('replaces the active match in Source mode and advances to the next one', async () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: 'alpha beta alpha' })
      useAppStore.setState({ viewMode: 'source' })
      const user = userEvent.setup()
      render(<EditorScreen />)

      act(() => {
        useFindStore.getState().openFindAndReplace()
        useFindStore.getState().setQuery('alpha')
        useFindStore.getState().setReplacement('omega')
      })

      await user.click(screen.getByRole('button', { name: 'Replace' }))

      expect(useDocumentStore.getState().content).toBe('omega beta alpha')
      // The match that was just replaced is gone from the list, so the
      // remaining (formerly second) match becomes the new active one --
      // findStore's own setMatches clamp is what produces this "advance",
      // not any special-cased logic in the controller itself.
      const textarea = screen.getByRole('textbox', {
        name: 'Markdown source'
      }) as HTMLTextAreaElement
      expect(textarea.selectionStart).toBe(11)
      expect(textarea.selectionEnd).toBe(16)
    })

    it('replaces every Source-mode match in exactly one store update', async () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: 'alpha beta alpha' })
      useAppStore.setState({ viewMode: 'source' })
      const updateContentForTabSpy = vi.fn(useDocumentStore.getState().updateContentForTab)
      useDocumentStore.setState({ updateContentForTab: updateContentForTabSpy })
      const user = userEvent.setup()
      render(<EditorScreen />)

      act(() => {
        useFindStore.getState().openFindAndReplace()
        useFindStore.getState().setQuery('alpha')
        useFindStore.getState().setReplacement('omega')
      })

      await user.click(screen.getByRole('button', { name: 'Replace all' }))

      expect(useDocumentStore.getState().content).toBe('omega beta omega')
      expect(updateContentForTabSpy).toHaveBeenCalledTimes(1)
    })
  })

  // Format-mode assertions below use the mocked MilkdownEditor handle (see
  // this file's own module comment).
  describe('Format mode', () => {
    it('clears the highlight (pushes an empty query) when the bar closes', () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
      useAppStore.setState({ viewMode: 'format' })
      render(<EditorScreen />)

      act(() => {
        useFindStore.getState().openFind()
        useFindStore.getState().setQuery('Report')
      })

      expect(mockEditorHandle.setFindState).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: 'Report' })
      )

      act(() => {
        useFindStore.getState().closeFind()
      })

      expect(mockEditorHandle.setFindState).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: '' })
      )
    })

    // The whole point of re-running the search on a surface change: Source
    // mode's raw-Markdown scan and Format mode's rendered-document scan can
    // (and here, deliberately do) disagree about the SAME query, so a stale
    // carried-over count would be actively wrong, not just imprecise.
    it('re-runs the search against the new surface when the view mode changes', async () => {
      useDocumentStore.setState({ filePath: '/tmp/report.md', content: '**bold** text' })
      useAppStore.setState({ viewMode: 'source' })
      const user = userEvent.setup()
      render(<EditorScreen />)

      act(() => {
        useFindStore.getState().openFind()
        useFindStore.getState().setQuery('**')
      })

      // Source mode finds the literal '**' characters twice in the raw text.
      expect(useFindStore.getState().matchCount).toBe(2)

      await user.click(screen.getByRole('button', { name: 'Format' }))

      // Switching surfaces must genuinely re-push the CURRENT query into the
      // now-live Format handle -- not just leave Source's stale count sitting
      // in the store.
      expect(mockEditorHandle.setFindState).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: '**' })
      )

      // Simulate milkdown/find-plugin.ts's own view.update callback: in the
      // REAL rendered document, '**bold**' is a bold MARK, not two literal
      // asterisk characters, so a real Format-mode search for '**' finds
      // nothing -- a genuinely different answer than Source mode's 2, which
      // is exactly the scenario this test exists to prove is handled.
      act(() => {
        findMatchesListeners.forEach((listener) => listener(0, -1))
      })

      expect(useFindStore.getState().matchCount).toBe(0)
    })
  })
})
