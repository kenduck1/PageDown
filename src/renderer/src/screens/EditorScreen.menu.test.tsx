import { forwardRef, useImperativeHandle } from 'react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { MilkdownEditorHandle } from '../milkdown/MilkdownEditor'
import type { MenuCommand } from '../../../menu/commands'

// Covers the RENDERER half of the application menu: a command delivered over
// the real `window.api.onMenuCommand` surface reaches the right action, and
// the subscription is torn down on unmount.
//
// A native menu cannot exist under jsdom at all, so what a unit test can
// genuinely prove is exactly this: given a delivered command, does the right
// thing happen. That the MENU delivers those commands correctly (labels,
// accelerators, enablement) is app-menu-template.test.ts's job, and that a
// real menu is genuinely installed in a real app is phase0/gate30's.
//
// Uses the same module-mocked MilkdownEditor as EditorScreen.viewMode.test.tsx,
// and for the same discriminating reason: the fake has NO unmount side
// effect, so a `flush()` call on its handle can only have come from
// EditorScreen's own handler rather than from the real editor's
// unmount-cleanup flush.
const { mockEditorHandle } = vi.hoisted(() => ({
  mockEditorHandle: {
    flush: vi.fn(),
    toggleBold: vi.fn(),
    toggleItalic: vi.fn(),
    toggleInlineCode: vi.fn(),
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
    getSelectedText: vi.fn(() => ''),
    getSelectionRect: vi.fn(() => null),
    addComment: vi.fn(() => true),
    resolveComment: vi.fn(),
    runSlashItem: vi.fn(),
    closeSlashMenu: vi.fn(),
    getSlashItems: vi.fn(() => []),
    insertImages: vi.fn(),
    removeLink: vi.fn(),
    toggleTaskList: vi.fn(),
    addRowBefore: vi.fn(),
    addRowAfter: vi.fn(),
    addColumnBefore: vi.fn(),
    addColumnAfter: vi.fn(),
    deleteRow: vi.fn(),
    deleteColumn: vi.fn(),
    deleteTable: vi.fn(),
    setColumnAlignment: vi.fn(),
    getTableRect: vi.fn(() => null),
    setActiveSlashIndex: vi.fn()
  }
}))

vi.mock('../milkdown/MilkdownEditor', () => ({
  default: forwardRef<MilkdownEditorHandle, { content: string }>(
    function FakeMilkdownEditor(props, ref) {
      useImperativeHandle(ref, () => mockEditorHandle, [])
      return <div data-testid="fake-milkdown-editor">{props.content}</div>
    }
  )
}))

import EditorScreen from './EditorScreen'
import { useAppStore, initialAppState } from '../store/appStore'
import { useDocumentStore, initialDocumentState } from '../store/documentStore'
import { useFindStore, initialFindState } from '../store/findStore'

// The unsubscribe every onMenuCommand call returns, shared so a test can
// assert EditorScreen actually invokes it on unmount.
const unsubscribe = vi.fn()

// Delivers a command exactly the way preload does: through whatever callbacks
// are currently registered. Wrapped in act() because every handler ends in a
// React state update or a store write that re-renders.
function emitMenuCommand(command: MenuCommand, payload?: string): void {
  const calls = vi.mocked(window.api.onMenuCommand).mock.calls
  act(() => {
    for (const [callback] of calls) callback(command, payload)
  })
}

beforeEach(() => {
  useAppStore.setState(initialAppState)
  useDocumentStore.setState(initialDocumentState)
  useFindStore.setState(initialFindState)
  Object.values(mockEditorHandle).forEach((fn) => fn.mockClear())
  unsubscribe.mockClear()
  window.api = {
    openFile: vi.fn(),
    openPath: vi.fn(),
    saveFile: vi.fn().mockResolvedValue({ filePath: '/tmp/report.md', mtimeMs: 1000 }),
    getRecentFiles: vi.fn(),
    removeRecentFile: vi.fn(),
    clearRecentFiles: vi.fn(),
    getThumbnail: vi.fn(),
    getTemplateThumbnail: vi.fn(),
    getPageCount: vi.fn().mockResolvedValue({ pageCount: 1 }),
    confirmDiscardChanges: vi.fn(),
    exportPdf: vi.fn().mockResolvedValue({ filePath: '/tmp/report.pdf' }),
    exportHtml: vi.fn(),
    showItemInFolder: vi.fn(),
    print: vi.fn().mockResolvedValue({ cancelled: false }),
    getPreferences: vi.fn(),
    setPreferences: vi.fn(),
    autosaveSnapshot: vi.fn(),
    getVersionHistory: vi.fn(),
    restoreVersionContent: vi.fn(),
    clearPendingAutosave: vi.fn(),
    // Crash protection for never-saved documents. Required (not optional) on
    // FileApi, so a missing entry here is a compile error rather than a
    // runtime surprise -- see index.d.ts for why that tradeoff was taken.
    autosaveUnsavedDraft: vi.fn().mockResolvedValue(null),
    listUnsavedDrafts: vi.fn().mockResolvedValue([]),
    readUnsavedDraft: vi.fn().mockResolvedValue(null),
    discardUnsavedDraft: vi.fn().mockResolvedValue(undefined),
    setSplitPreviewBounds: vi.fn(),
    sendSplitPreviewDocument: vi.fn().mockResolvedValue({ pageCount: 1 }),
    destroySplitPreview: vi.fn(),
    scrollSplitPreviewToPage: vi.fn().mockResolvedValue({ currentPage: 1, pageCount: 0 }),
    getSplitPreviewPage: vi.fn().mockResolvedValue({ currentPage: 1, pageCount: 0 }),
    saveDroppedImage: vi.fn(),
    openInNewWindow: vi.fn(),
    onMenuCommand: vi.fn().mockReturnValue(unsubscribe),
    setWindowState: vi.fn(),
    // Preferences broadcast (multi-window): a real unsubscribe function,
    // same contract as the other push channels here.
    onPreferencesChanged: vi.fn().mockReturnValue(() => {}),
    // The window-close guard's two channels. onWindowCloseRequest must
    // return a real unsubscribe FUNCTION -- App.tsx calls it from an effect
    // cleanup, same contract as onMenuCommand above.
    onWindowCloseRequest: vi.fn().mockReturnValue(() => {}),
    respondToWindowClose: vi.fn(),
    getStartupWarnings: vi.fn().mockResolvedValue([]),
    getAppVersion: vi.fn().mockResolvedValue('1.0.0'),
    resolveLocalImage: vi.fn()
  }
})

afterEach(() => {
  cleanup()
})

describe('EditorScreen: application-menu commands', () => {
  it('file:save flushes the editor before writing, like the Save button', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report', isDirty: true })
    render(<EditorScreen />)

    emitMenuCommand('file:save')

    // flush() first is the whole Save-race fix (CLAUDE.md's flush() section):
    // a menu Save within Milkdown's 200ms debounce must not write stale text.
    expect(mockEditorHandle.flush).toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(window.api.saveFile).toHaveBeenCalledWith('/tmp/report.md', '# Report', null)
    })
  })

  it('file:saveAs passes a NULL path, which is what opens the native Save dialog', async () => {
    // The one thing that distinguishes Save As from Save at this layer: a
    // null target path makes file-io.ts's saveFile show a Save dialog rather
    // than writing to the current file. A null mtime baseline rides along,
    // because a not-yet-chosen path has no baseline to compare against.
    useDocumentStore.setState({
      filePath: '/tmp/report.md',
      content: '# Report',
      isDirty: true,
      mtimeMs: 1000
    })
    render(<EditorScreen />)

    emitMenuCommand('file:saveAs')

    expect(mockEditorHandle.flush).toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(window.api.saveFile).toHaveBeenCalledWith(null, '# Report', null)
    })
  })

  // Second-pass product-completeness audit: Close Tab. The whole point of
  // routing this command through handleRequestCloseTab (the SAME function
  // the tab bar's own "x" button calls) rather than a parallel, simplified
  // closing path is that a dirty tab gets the identical confirm/flush/save/
  // clear-autosave sequence no matter which control asked -- so the test
  // that actually matters here is the dirty one: it fails the instant a
  // future edit "simplifies" the handler back to a bare closeTab() call,
  // which is exactly the Tier-0 data-loss bug this file's own header already
  // warns against reintroducing. The full save/discard/cancel branch matrix
  // is EditorScreen.test.tsx's job (it's the same function); this only has
  // to prove the MENU path reaches it.
  describe('file:closeTab', () => {
    it('closes a clean tab immediately, with no confirmation prompt', () => {
      const initialTabId = useDocumentStore.getState().activeTabId
      render(<EditorScreen />)

      emitMenuCommand('file:closeTab')

      expect(window.api.confirmDiscardChanges).not.toHaveBeenCalled()
      // closeTab never leaves zero tabs -- closing the sole (clean) tab
      // replaces it with a fresh blank one, a DIFFERENT id than the one that
      // was just closed.
      expect(useDocumentStore.getState().tabs.some((tab) => tab.id === initialTabId)).toBe(false)
      expect(useDocumentStore.getState().tabs).toHaveLength(1)
    })

    it('prompts before closing a dirty tab, and does nothing when the user cancels', async () => {
      useDocumentStore.setState((state) => ({
        filePath: '/tmp/report.md',
        content: '# Report',
        isDirty: true,
        tabs: state.tabs.map((tab) =>
          tab.id === state.activeTabId
            ? { ...tab, filePath: '/tmp/report.md', content: '# Report', isDirty: true }
            : tab
        )
      }))
      const activeId = useDocumentStore.getState().activeTabId
      vi.mocked(window.api.confirmDiscardChanges).mockResolvedValue('cancel')
      render(<EditorScreen />)

      emitMenuCommand('file:closeTab')

      await vi.waitFor(() => {
        expect(window.api.confirmDiscardChanges).toHaveBeenCalled()
      })
      expect(window.api.saveFile).not.toHaveBeenCalled()
      expect(window.api.clearPendingAutosave).not.toHaveBeenCalled()
      // Cancel means cancel -- the dirty tab is still exactly where it was.
      expect(useDocumentStore.getState().tabs.some((tab) => tab.id === activeId)).toBe(true)
    })
  })

  // Export PDF still has a toolbar button; Print, HTML export and Page Setup's
  // keyboard route do NOT -- the single-row-toolbar pass removed the Print and
  // Export-as-HTML buttons outright, so for those two this menu path is the
  // ONLY trigger in the app and this test is their whole end-to-end coverage
  // at the renderer level.
  it('file:exportPdf, file:print and file:exportHtml run the real store actions', async () => {
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    render(<EditorScreen />)

    emitMenuCommand('file:exportPdf')
    emitMenuCommand('file:print')
    emitMenuCommand('file:exportHtml')

    await vi.waitFor(() => {
      expect(window.api.exportPdf).toHaveBeenCalledWith('# Report', '/tmp/report.md', false)
      expect(window.api.print).toHaveBeenCalledWith('# Report', '/tmp/report.md', false)
      expect(window.api.exportHtml).toHaveBeenCalledWith('# Report', '/tmp/report.md', false)
    })
  })

  it('file:pageSetup opens the Page Setup dialog', () => {
    // Matters more than it looks: Page Setup is now also the home of the
    // document's font family and body size, which used to be one click away
    // in the toolbar and have no other UI at all.
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    render(<EditorScreen />)

    expect(useAppStore.getState().pageSetupOpen).toBe(false)
    emitMenuCommand('file:pageSetup')
    expect(useAppStore.getState().pageSetupOpen).toBe(true)
  })

  it('view:splitLeftFormat / view:splitLeftSource / view:toggleSplitFollow drive the real store', () => {
    // These three replace toolbar pills that no longer exist, so the menu is
    // their only surface. EditorScreen.test.tsx separately proves, against a
    // REAL MilkdownEditor, that the left-pane switch does not lose an
    // in-flight edit -- the invariant CLAUDE.md records a shipped Critical bug
    // for.
    useAppStore.setState({ viewMode: 'split', splitLeftMode: 'format' })
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    render(<EditorScreen />)

    emitMenuCommand('view:splitLeftSource')
    expect(useAppStore.getState().splitLeftMode).toBe('source')
    emitMenuCommand('view:splitLeftFormat')
    expect(useAppStore.getState().splitLeftMode).toBe('format')

    expect(useAppStore.getState().splitFollowEnabled).toBe(true)
    emitMenuCommand('view:toggleSplitFollow')
    expect(useAppStore.getState().splitFollowEnabled).toBe(false)
    emitMenuCommand('view:toggleSplitFollow')
    expect(useAppStore.getState().splitFollowEnabled).toBe(true)
  })

  it('view:split routes through handleSetViewMode, not the bare setViewMode', () => {
    // Discriminating, not incidental: the bare store action would also change
    // viewMode, so the observable mode change alone proves nothing. The
    // flush() call on the mocked handle (which has no unmount side effect of
    // its own) is what shows the coordinated path ran -- without it, a
    // format -> split(format) switch silently loses an in-flight edit, the
    // exact shipped C1 bug EditorScreen.tsx documents.
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    render(<EditorScreen />)

    emitMenuCommand('view:split')

    expect(useAppStore.getState().viewMode).toBe('split')
    expect(mockEditorHandle.flush).toHaveBeenCalled()
  })

  it('view:toggleSidebar genuinely unmounts and restores the sidebar', () => {
    render(<EditorScreen />)
    expect(screen.getByRole('button', { name: 'Outline' })).toBeInTheDocument()

    emitMenuCommand('view:toggleSidebar')

    expect(useAppStore.getState().sidebarVisible).toBe(false)
    expect(screen.queryByRole('button', { name: 'Outline' })).not.toBeInTheDocument()

    emitMenuCommand('view:toggleSidebar')
    expect(screen.getByRole('button', { name: 'Outline' })).toBeInTheDocument()
  })

  it('zoom commands step through the same levels the status bar select renders', () => {
    render(<EditorScreen />)
    const zoomSelect = screen.getByLabelText('Zoom level') as HTMLSelectElement
    expect(zoomSelect.value).toBe('1')

    emitMenuCommand('view:zoomIn')
    // 1.25, not some off-list value -- an off-list zoom renders this
    // controlled <select> BLANK, which is why the levels are shared.
    expect(zoomSelect.value).toBe('1.25')

    emitMenuCommand('view:zoomOut')
    emitMenuCommand('view:zoomOut')
    expect(zoomSelect.value).toBe('0.9')

    emitMenuCommand('view:zoomReset')
    expect(zoomSelect.value).toBe('1')
  })

  it('zoom commands and the zoom select are both inert in Split mode', () => {
    // Zoom has no effect at all in Split mode -- that row renders outside the
    // zoom wrapper on purpose, because its right pane is a native
    // WebContentsView positioned from a DOM rect a CSS scale would silently
    // desync. Before this, the control stayed live and lied: 150% selected in
    // Split changed nothing on screen while the readout said 150%, and the
    // document then jumped to 150% on the next switch back to Format.
    //
    // Both halves are asserted because they are genuinely separate mechanisms
    // and either alone leaves a live path: app-menu-template.ts disables the
    // menu ITEMS, but menu enablement is reported asynchronously (the renderer
    // pushes window UI state, main rebuilds), so the handler must refuse too.
    render(<EditorScreen />)
    const zoomSelect = screen.getByLabelText('Zoom level') as HTMLSelectElement

    emitMenuCommand('view:split')
    expect(useAppStore.getState().viewMode).toBe('split')
    expect(zoomSelect).toBeDisabled()

    emitMenuCommand('view:zoomIn')
    expect(zoomSelect.value).toBe('1')
    emitMenuCommand('view:zoomOut')
    expect(zoomSelect.value).toBe('1')

    // ...and it comes back to life on the way out, at the same level it had
    // before -- the value is deliberately preserved across the round trip, not
    // reset.
    emitMenuCommand('view:format')
    expect(zoomSelect).toBeEnabled()
    emitMenuCommand('view:zoomIn')
    expect(zoomSelect.value).toBe('1.25')
  })

  it('edit:find opens the find bar AND seeds the query from the selection', () => {
    // The seeding is the part a naive `openFind()` handler would silently
    // drop: Cmd+F is now a menu accelerator, so this handler -- not
    // useFindShortcuts' window listener -- is what fires in the real app.
    mockEditorHandle.getSelectedText.mockReturnValue('Report')
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    render(<EditorScreen />)

    emitMenuCommand('edit:find')

    expect(useFindStore.getState().isOpen).toBe(true)
    expect(useFindStore.getState().query).toBe('Report')
  })

  it('edit:findReplace opens the find bar WITH replace expanded, and seeds the query', () => {
    // Same handler shape as edit:find above, `withReplace: true` -- proves
    // the menu's own Cmd+Alt+F/Ctrl+H accelerator (app-menu-template.ts)
    // reaches the identical openFindFromShortcut flow as useFindShortcuts.ts's
    // bare `window` listener, not a simplified stand-in that would drop the
    // seed-from-selection behavior.
    mockEditorHandle.getSelectedText.mockReturnValue('Report')
    useDocumentStore.setState({ filePath: '/tmp/report.md', content: '# Report' })
    render(<EditorScreen />)

    emitMenuCommand('edit:findReplace')

    expect(useFindStore.getState().isOpen).toBe(true)
    expect(useFindStore.getState().replaceExpanded).toBe(true)
    expect(useFindStore.getState().query).toBe('Report')
  })

  it('edit:findNext / edit:findPrevious move the match cursor', () => {
    render(<EditorScreen />)
    act(() => {
      useFindStore.setState({ isOpen: true, query: 'a', matchCount: 3, activeIndex: 0 })
    })

    emitMenuCommand('edit:findNext')
    expect(useFindStore.getState().activeIndex).toBe(1)

    emitMenuCommand('edit:findPrevious')
    expect(useFindStore.getState().activeIndex).toBe(0)
  })

  it('app:shortcuts opens the reference modal and closes any open slash session', () => {
    render(<EditorScreen />)

    emitMenuCommand('app:shortcuts')

    expect(useAppStore.getState().shortcutsHelpOpen).toBe(true)
    // ShortcutsHelpModal autofocuses nothing, so opening it never blurs the
    // ProseMirror node -- and the slash plugin's own auto-close only fires on
    // that blur. Without this call an open slash session would sit live
    // underneath the modal.
    expect(mockEditorHandle.closeSlashMenu).toHaveBeenCalled()
  })

  it('unsubscribes from menu commands on unmount', () => {
    // Not theoretical: this screen is remounted by ordinary navigation, so a
    // leaked listener per mount accumulates for the life of the window.
    const { unmount } = render(<EditorScreen />)
    expect(window.api.onMenuCommand).toHaveBeenCalledTimes(1)
    expect(unsubscribe).not.toHaveBeenCalled()

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('ignores a command it has no handler for', () => {
    // Every subscriber receives EVERY command (App.tsx handles file:new, this
    // screen does not) -- a missing handler must be a silent no-op, never a
    // crash on `undefined(...)`.
    render(<EditorScreen />)
    expect(() => emitMenuCommand('file:new')).not.toThrow()
  })
})
