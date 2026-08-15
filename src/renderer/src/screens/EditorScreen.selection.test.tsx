import { forwardRef, useImperativeHandle } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MilkdownEditorHandle } from '../milkdown/MilkdownEditor'
import type { SelectionSnapshot } from '../milkdown/selection-plugin'

// End-to-end wiring coverage for the selection bubble, at the level nothing
// else reaches: MilkdownEditor's onSelectionChanged -> EditorScreen state +
// geometry measurement -> SelectionBubble -> back into editorRef's commands.
// Same module-mock pattern EditorScreen.link/comments/find.test.tsx establish
// (EditorScreen owns editorRef internally, so there is no prop seam to inject
// a fake handle through), plus two environment fixtures this feature
// specifically needs:
//
//  1. A real getBoundingClientRect. jsdom performs no layout, so EVERY rect it
//     reports is zero -- and a zero-area safe rect makes intersectRect return
//     null, which correctly means "render nothing". Without stubbing this, the
//     bubble is structurally untestable at this level rather than merely
//     mispositioned. This is the same hazard selection-plugin.ts documents for
//     coordsAtPos, arriving from the other side.
//  2. The fake editor exposes a button that fires onSelectionChanged with a
//     snapshot of the test's choosing, since jsdom's own Selection API does
//     not drive ProseMirror at all.
//
// POSITION IS STILL NOT ASSERTED HERE, for the same reason: the numbers below
// are fixtures, not measurements. Placement lives in
// lib/floating-position.test.ts; painting lives in a Playwright gate.

const RANGED_SNAPSHOT: SelectionSnapshot = {
  from: 1,
  to: 5,
  empty: false,
  hasFocus: true,
  nodeSelection: false,
  marks: { bold: true, italic: false, inlineCode: false, strikethrough: false, link: false },
  headingLevel: null,
  listType: null,
  linkHref: null,
  taskList: false,
  table: null
}

const mockEditorHandle = vi.hoisted(() => ({
  flush: vi.fn(),
  toggleBold: vi.fn(),
  toggleItalic: vi.fn(),
  toggleInlineCode: vi.fn(),
  toggleStrikethrough: vi.fn(),
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
  // Mirrors the real contract (readTableRect returns a rect ONLY for a
  // collapsed selection inside a table), so the ranged-selection tests below
  // still exercise the getSelectionRect fallback rather than silently taking
  // this branch.
  getTableRect: vi.fn(() =>
    snapshotToFire.current?.empty && snapshotToFire.current.table
      ? { left: 220, top: 200, right: 520, bottom: 320 }
      : null
  ),
  setActiveSlashIndex: vi.fn()
}))

const { snapshotToFire } = vi.hoisted(() => ({
  snapshotToFire: { current: null as SelectionSnapshot | null }
}))

vi.mock('../milkdown/MilkdownEditor', () => ({
  default: forwardRef<
    MilkdownEditorHandle,
    { content: string; onSelectionChanged?: (snapshot: SelectionSnapshot | null) => void }
  >(function FakeMilkdownEditor(props, ref) {
    useImperativeHandle(ref, () => mockEditorHandle, [])
    return (
      <div data-testid="fake-milkdown-editor">
        {props.content}
        <button
          type="button"
          data-testid="fire-selection"
          onClick={() => props.onSelectionChanged?.(snapshotToFire.current)}
        >
          fire selection
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
  snapshotToFire.current = RANGED_SNAPSHOT
  Object.values(mockEditorHandle).forEach((fn) => fn.mockClear())
  mockEditorHandle.getSelectionRect.mockReturnValue({
    left: 300,
    top: 300,
    right: 400,
    bottom: 318
  })
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
    exportDocx: vi.fn(),
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

describe('EditorScreen selection bubble', () => {
  it('shows no bubble until the editor reports a real selection', async () => {
    render(<EditorScreen />)
    expect(screen.queryByRole('toolbar', { name: 'Text formatting' })).toBeNull()
    await userEvent.setup().click(screen.getByTestId('fire-selection'))
    expect(screen.getByRole('toolbar', { name: 'Text formatting' })).toBeInTheDocument()
  })

  it('dispatches bubble commands through the SAME handle the persistent toolbar uses', async () => {
    // The anti-drift property (the historyKeymap-vs-toolbar precedent): both
    // surfaces call MilkdownEditorHandle, so "Bold" cannot come to mean two
    // different things.
    const user = userEvent.setup()
    render(<EditorScreen />)
    await user.click(screen.getByTestId('fire-selection'))

    const bubble = screen.getByRole('toolbar', { name: 'Text formatting' })
    await user.click(buttonIn(bubble, 'Bold'))
    expect(mockEditorHandle.toggleBold).toHaveBeenCalledTimes(1)
    await user.click(buttonIn(bubble, 'Heading 2'))
    expect(mockEditorHandle.toggleHeading).toHaveBeenCalledWith(2)
    await user.click(buttonIn(bubble, 'Inline code'))
    expect(mockEditorHandle.toggleInlineCode).toHaveBeenCalledTimes(1)
  })

  it('opens the link and comment composer ROWS from the bubble, and hides itself while one is open', async () => {
    // Both are layout rows (the occlusion architecture), and opening either
    // shifts the whole content area -- which invalidates the anchor this
    // bubble was placed against, hence the suppression rather than a re-anchor.
    const user = userEvent.setup()
    render(<EditorScreen />)
    await user.click(screen.getByTestId('fire-selection'))

    const bubble = screen.getByRole('toolbar', { name: 'Text formatting' })
    await user.click(buttonIn(bubble, 'Add comment'))
    expect(screen.getByRole('group', { name: 'Add comment' })).toBeInTheDocument()
    expect(screen.queryByRole('toolbar', { name: 'Text formatting' })).toBeNull()
  })

  it('hides the bubble while a full-screen modal is open', async () => {
    const user = userEvent.setup()
    render(<EditorScreen />)
    await user.click(screen.getByTestId('fire-selection'))
    expect(screen.getByRole('toolbar', { name: 'Text formatting' })).toBeInTheDocument()

    act(() => useAppStore.getState().openPageSetup())
    expect(screen.queryByRole('toolbar', { name: 'Text formatting' })).toBeNull()
  })

  it('feeds the same snapshot to the persistent toolbar, so Bold shows as pressed there too', async () => {
    // Scoped to the PERSISTENT toolbar deliberately: once the bubble is up
    // there are genuinely two buttons named "Bold" on screen, and an
    // unscoped query would be ambiguous (it was, first time round). That both
    // exist and both read from one snapshot is the point of this test.
    const user = userEvent.setup()
    render(<EditorScreen />)
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting toolbar' })
    expect(buttonIn(toolbar, 'Bold')).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByTestId('fire-selection'))
    expect(buttonIn(toolbar, 'Bold')).toHaveAttribute('aria-pressed', 'true')
  })

  it('clears the bubble when the editor reports a null snapshot (its own destroy)', async () => {
    const user = userEvent.setup()
    render(<EditorScreen />)
    await user.click(screen.getByTestId('fire-selection'))
    expect(screen.getByRole('toolbar', { name: 'Text formatting' })).toBeInTheDocument()

    snapshotToFire.current = null
    await user.click(screen.getByTestId('fire-selection'))
    expect(screen.queryByRole('toolbar', { name: 'Text formatting' })).toBeNull()
  })

  it('renders the bubble OUTSIDE the zoom-transformed content wrapper', async () => {
    // Structural, and load-bearing rather than tidy: per CSS Transforms Level
    // 1 §3 a transform establishes a containing block for fixed-position
    // descendants, so a bubble nested inside `transform: scale(zoom)` would be
    // positioned relative to that wrapper AND scaled with it -- 60%-size
    // chrome and 60%-size hit targets at 60% zoom. Nothing about that is
    // observable in jsdom (no layout), so the containment is asserted directly.
    const user = userEvent.setup()
    render(<EditorScreen />)
    await user.click(screen.getByTestId('fire-selection'))

    const bubble = screen.getByRole('toolbar', { name: 'Text formatting' })
    expect(screen.getByTestId('document-content').contains(bubble)).toBe(false)
  })
})

// Capability-gap pass: the bubble is now context-sensitive, so this wiring
// test covers the two things that only exist at THIS level -- that the caret's
// enclosing table raises the bubble at all, and that its table buttons reach
// the real editor handle.
describe('EditorScreen selection bubble: table controls', () => {
  const TABLE_CARET: SelectionSnapshot = {
    ...RANGED_SNAPSHOT,
    from: 7,
    to: 7,
    empty: true,
    table: { tablePos: 0, column: 1, alignment: null }
  }

  it('raises the bubble for a bare caret inside a table and dispatches its commands', async () => {
    const user = userEvent.setup()
    render(<EditorScreen />)

    snapshotToFire.current = TABLE_CARET
    await user.click(screen.getByTestId('fire-selection'))

    const bubble = screen.getByRole('toolbar', { name: 'Text formatting' })
    await user.click(buttonIn(bubble, 'Insert row below'))
    expect(mockEditorHandle.addRowAfter).toHaveBeenCalledTimes(1)

    await user.click(buttonIn(bubble, 'Delete column'))
    expect(mockEditorHandle.deleteColumn).toHaveBeenCalledTimes(1)

    await user.click(buttonIn(bubble, 'Align column center'))
    expect(mockEditorHandle.setColumnAlignment).toHaveBeenCalledWith('center')
  })

  it('anchors to the TABLE rect for that caret case, not to the caret box', async () => {
    // getTableRect returns non-null only for a collapsed selection inside a
    // table; EditorScreen must prefer it, because sameSnapshot ignores
    // collapsed positions and so nothing would ever re-measure a caret anchor
    // as the user types or tabs across the row.
    const user = userEvent.setup()
    render(<EditorScreen />)

    snapshotToFire.current = TABLE_CARET
    await user.click(screen.getByTestId('fire-selection'))

    expect(mockEditorHandle.getTableRect).toHaveBeenCalled()
  })
})

/** Scopes a role query to the bubble, so the toolbar's own Bold isn't matched. */
function buttonIn(root: HTMLElement, name: string): HTMLElement {
  const match = Array.from(root.querySelectorAll('button')).find(
    (button) => button.getAttribute('aria-label') === name
  )
  if (!match) throw new Error(`no button labelled ${name} inside the bubble`)
  return match
}
