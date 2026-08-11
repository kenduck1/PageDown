import { forwardRef, useImperativeHandle } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MilkdownEditorHandle } from '../milkdown/MilkdownEditor'
import type { SlashSession } from '../milkdown/slash-plugin'
import type { SlashItem } from '../milkdown/slash-items'

// Final whole-branch review, item 5: neither of EditorScreen's own two
// slash-menu wiring points had ANY test coverage before this file --
// rendering <SlashMenu> at this screen's root (wired to useSlashMenu, which
// is wired to MilkdownEditor's onSlashStateChanged prop), and the Mod-/
// keydown handler's own closeSlashMenu() call, a deliberate fix for the
// ShortcutsHelpModal-does-not-blur gap (see that handler's own 12-line
// comment in EditorScreen.tsx). The review measured directly: deleting the
// closeSlashMenu() call left the ENTIRE suite AND Gate 29 green, because
// Gate 29 never opens a slash session and then opens ShortcutsHelpModal in
// the same run. Same module-mock pattern EditorScreen.selection/
// toast.test.tsx already establish (EditorScreen owns editorRef internally,
// so there is no prop seam to inject a fake handle through) -- and the same
// "fake handle exposes a button that fires the callback prop" technique
// EditorScreen.selection.test.tsx uses for onSelectionChanged, applied here
// to onSlashStateChanged instead.

const mockEditorHandle = vi.hoisted(() => ({
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
  getSelectionRect: vi.fn(() => ({ left: 300, top: 300, right: 400, bottom: 318 })),
  addComment: vi.fn(() => true),
  resolveComment: vi.fn(),
  runSlashItem: vi.fn(),
  closeSlashMenu: vi.fn(),
  getSlashItems: vi.fn(() => [] as SlashItem[]),
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
}))

// A single, minimal real SlashItem -- only label/description/group are ever
// read by SlashMenu's own rendering (run/isEnabled are the catalogue's own
// concern, already covered directly by slash-items.test.ts).
const FAKE_ITEM: SlashItem = {
  id: 'heading-1',
  group: 'Text',
  label: 'Heading 1',
  description: 'Big section heading',
  keywords: ['h1'],
  run: vi.fn(),
  isEnabled: vi.fn(() => true)
}

const FAKE_SESSION: SlashSession = {
  anchorPos: 1,
  query: '',
  queryEnd: 2,
  activeIndex: 0,
  itemCount: 1
}

vi.mock('../milkdown/MilkdownEditor', () => ({
  default: forwardRef<
    MilkdownEditorHandle,
    { content: string; onSlashStateChanged?: (session: SlashSession | null) => void }
  >(function FakeMilkdownEditor(props, ref) {
    useImperativeHandle(ref, () => mockEditorHandle, [])
    return (
      <div data-testid="fake-milkdown-editor">
        {props.content}
        <button
          type="button"
          data-testid="fire-slash-session"
          onClick={() => props.onSlashStateChanged?.(FAKE_SESSION)}
        >
          fire slash session
        </button>
      </div>
    )
  })
}))

import EditorScreen from './EditorScreen'
import { useAppStore, initialAppState } from '../store/appStore'
import { useDocumentStore, initialDocumentState } from '../store/documentStore'

let rectSpy: ReturnType<typeof vi.spyOn> | null = null

beforeEach(() => {
  useAppStore.setState(initialAppState)
  useDocumentStore.setState(initialDocumentState)
  Object.values(mockEditorHandle).forEach((fn) => fn.mockClear())
  mockEditorHandle.getSlashItems.mockReturnValue([FAKE_ITEM])
  // Same "stub every element's own rect" approach as
  // EditorScreen.selection.test.tsx -- SlashMenu's own `safe` rect comes
  // from intersecting the canvas/editor-pane DOM nodes' real
  // getBoundingClientRect (useSlashMenu.ts's own measureRects), which jsdom
  // otherwise reports as all-zero -- a zero-area safe rect makes SlashMenu
  // render nothing at all (its own `items.length > 0 && anchor != null &&
  // safe != null` visibility check), the same structural-untestability
  // hazard that file's own header comment documents for the selection
  // bubble.
  rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 216,
    top: 123,
    right: 561,
    bottom: 606,
    x: 216,
    y: 123,
    width: 345,
    height: 483,
    toJSON: () => ({})
  } as DOMRect)
  window.api = {
    openFile: vi.fn(),
    openPath: vi.fn(),
    saveFile: vi.fn(),
    getRecentFiles: vi.fn(),
    removeRecentFile: vi.fn(),
    clearRecentFiles: vi.fn(),
    getThumbnail: vi.fn(),
    getTemplateThumbnail: vi.fn(),
    getPageCount: vi.fn().mockResolvedValue({ pageCount: 1 }),
    confirmDiscardChanges: vi.fn(),
    exportPdf: vi.fn(),
    exportHtml: vi.fn(),
    showItemInFolder: vi.fn(),
    print: vi.fn(),
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
    // The application menu's two channels. Both are stubbed in every
    // window.api fixture because window.api is a fully-typed FileApi here --
    // a missing method is a compile error, not just a runtime one.
    // onMenuCommand must return a real unsubscribe FUNCTION: App.tsx and
    // EditorScreen both call it from an effect cleanup, and a bare vi.fn()
    // returning undefined would throw on unmount.
    onMenuCommand: vi.fn().mockReturnValue(() => {}),
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
  rectSpy?.mockRestore()
  cleanup()
})

describe('EditorScreen slash-menu wiring', () => {
  it('renders <SlashMenu> at EditorScreen root once the editor reports an open session', async () => {
    const user = userEvent.setup()
    render(<EditorScreen />)
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument()

    await user.click(screen.getByTestId('fire-slash-session'))

    const menu = await screen.findByRole('listbox', { name: 'Slash commands' })
    expect(menu).toBeInTheDocument()
    // Scoped to the menu itself: EditorToolbar's own paragraph-style
    // <select> also carries a native "Heading 1" <option>, an unrelated
    // role="option" match an unscoped screen-wide query would collide with.
    expect(within(menu).getByRole('option', { name: /Heading 1/ })).toBeInTheDocument()
  })

  // EditorScreen.tsx's own 12-line comment on this call site: unlike every
  // other overlay this screen can open (Page Setup, Find, Comment/Link
  // composers), ShortcutsHelpModal renders no autofocus element, so opening
  // it via this bare `window` keydown listener does NOT blur the
  // ProseMirror editor DOM node -- and the slash plugin's own auto-close
  // only fires on blur (or Escape, or the selection leaving the tracked
  // range). Without this call, a palette left open when Mod-/ fires stays
  // open (and focused) underneath the newly-opened modal.
  //
  // Product-completeness audit Tier 3, C: ShortcutsHelpModal itself is now
  // rendered by App.tsx, not this screen (a document-scoped tree by
  // construction, since it renders ONLY `<EditorScreen />` -- App.tsx isn't
  // mounted here at all), so this asserts on `shortcutsHelpOpen` store state
  // -- the real, observable effect of this screen's own listener firing --
  // rather than a dialog element that has no reason to exist in this render
  // tree. The real dialog-appears proof lives in App.test.tsx.
  it('Mod-/ calls closeSlashMenu() on the handle and sets shortcutsHelpOpen', () => {
    render(<EditorScreen />)

    fireEvent.keyDown(window, { key: '/', metaKey: true })

    expect(mockEditorHandle.closeSlashMenu).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().shortcutsHelpOpen).toBe(true)
  })

  it('Ctrl-/ also calls closeSlashMenu() -- same handler, non-Mac convention', () => {
    render(<EditorScreen />)

    fireEvent.keyDown(window, { key: '/', ctrlKey: true })

    expect(mockEditorHandle.closeSlashMenu).toHaveBeenCalledTimes(1)
  })

  it('a bare "/" with no modifier does NOT call closeSlashMenu() -- must not fire while typing a literal slash', () => {
    render(<EditorScreen />)

    fireEvent.keyDown(window, { key: '/' })

    expect(mockEditorHandle.closeSlashMenu).not.toHaveBeenCalled()
  })
})
