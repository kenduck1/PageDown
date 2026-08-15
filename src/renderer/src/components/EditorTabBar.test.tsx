import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditorTabBar from './EditorTabBar'
import { useDocumentStore, initialDocumentState } from '../store/documentStore'

beforeEach(() => {
  useDocumentStore.setState(initialDocumentState)
})

afterEach(() => {
  cleanup()
})

describe('EditorTabBar', () => {
  it('renders one tab per open document', () => {
    useDocumentStore.getState().openTab('/tmp/a.md', '# A')
    useDocumentStore.getState().openTab('/tmp/b.md', '# B')
    render(<EditorTabBar />)

    // The initial blank tab plus the two opened above.
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(screen.getByRole('tab', { name: 'Untitled' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'a.md' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'b.md' })).toBeInTheDocument()
  })

  it('marks exactly the active tab as selected', () => {
    useDocumentStore.getState().openTab('/tmp/a.md', '# A')
    render(<EditorTabBar />)

    expect(screen.getByRole('tab', { name: 'a.md' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Untitled' })).toHaveAttribute('aria-selected', 'false')
  })

  it('clicking a tab switches the active one', async () => {
    useDocumentStore.getState().openTab('/tmp/a.md', '# A')
    const tabAId = useDocumentStore.getState().activeTabId
    useDocumentStore.getState().openTab('/tmp/b.md', '# B')
    const user = userEvent.setup()
    render(<EditorTabBar />)

    // "b.md" is currently active; clicking "a.md" should switch to it.
    await user.click(screen.getByRole('tab', { name: 'a.md' }))

    expect(useDocumentStore.getState().activeTabId).toBe(tabAId)
    expect(useDocumentStore.getState()).toMatchObject({ content: '# A', filePath: '/tmp/a.md' })
    expect(screen.getByRole('tab', { name: 'a.md' })).toHaveAttribute('aria-selected', 'true')
  })

  it('clicking "+" opens a new blank tab and makes it active', async () => {
    const before = useDocumentStore.getState().tabs.length
    const user = userEvent.setup()
    render(<EditorTabBar />)

    await user.click(screen.getByRole('button', { name: 'New tab' }))

    const state = useDocumentStore.getState()
    expect(state.tabs).toHaveLength(before + 1)
    expect(state).toMatchObject({ content: '', filePath: null })
    expect(screen.getAllByRole('tab')).toHaveLength(before + 1)
  })

  it('clicking "x" closes that tab', async () => {
    useDocumentStore.getState().openTab('/tmp/a.md', '# A')
    useDocumentStore.getState().openTab('/tmp/b.md', '# B')
    const user = userEvent.setup()
    render(<EditorTabBar />)

    await user.click(screen.getByRole('button', { name: 'Close a.md' }))

    expect(screen.queryByRole('tab', { name: 'a.md' })).not.toBeInTheDocument()
    expect(useDocumentStore.getState().tabs.some((tab) => tab.filePath === '/tmp/a.md')).toBe(false)
    // Closing a background tab must not switch the active one away from b.md.
    expect(useDocumentStore.getState().filePath).toBe('/tmp/b.md')
  })

  it('closing the active tab switches the displayed tab without leaving zero tabs', async () => {
    useDocumentStore.getState().openTab('/tmp/a.md', '# A')
    const user = userEvent.setup()
    render(<EditorTabBar />)

    // "a.md" is active; close it via its own close button.
    await user.click(screen.getByRole('button', { name: 'Close a.md' }))

    expect(screen.queryByRole('tab', { name: 'a.md' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(useDocumentStore.getState().tabs).toHaveLength(1)
  })

  // The next three tests cover onRequestCloseTab, which replaced the older
  // onCloseDirtyActiveTab. That prop only fired when the tab was BOTH dirty
  // AND active, so a dirty BACKGROUND tab was discarded with no confirmation
  // at all -- and unrecoverably, since useAutosave only ever snapshots the
  // ACTIVE tab. This component also cannot decide dirtiness for itself (the
  // 200ms onChange debounce means a just-edited tab still reads isDirty:
  // false), so the whole decision moved to the parent, which can flush first.
  it('clicking "x" routes EVERY close through onRequestCloseTab, including a DIRTY BACKGROUND tab', async () => {
    useDocumentStore.getState().openTab('/tmp/a.md', '# A', true)
    const backgroundId = useDocumentStore.getState().activeTabId
    // Opening b.md makes it active, leaving a.md dirty but in the background.
    useDocumentStore.getState().openTab('/tmp/b.md', '# B')
    const onRequestCloseTab = vi.fn()
    const user = userEvent.setup()
    render(<EditorTabBar onRequestCloseTab={onRequestCloseTab} />)

    await user.click(screen.getByRole('button', { name: 'Close a.md' }))

    expect(onRequestCloseTab).toHaveBeenCalledWith(backgroundId)
    expect(onRequestCloseTab).toHaveBeenCalledTimes(1)
    // The tab must still be open -- EditorTabBar defers the ENTIRE close
    // decision to the callback; it must not also call the store's closeTab
    // itself (that would close the tab twice-over: once for real here, and
    // again whenever the callback eventually decides to).
    expect(useDocumentStore.getState().tabs.some((tab) => tab.id === backgroundId)).toBe(true)
  })

  it('routes a CLEAN tab close through onRequestCloseTab too, rather than closing it directly', async () => {
    // A clean tab looks safe to close here, but only the parent can know that
    // for sure -- see this component's own prop comment on the debounce.
    useDocumentStore.getState().openTab('/tmp/a.md', '# A')
    const cleanId = useDocumentStore.getState().activeTabId
    const onRequestCloseTab = vi.fn()
    const user = userEvent.setup()
    render(<EditorTabBar onRequestCloseTab={onRequestCloseTab} />)

    await user.click(screen.getByRole('button', { name: 'Close a.md' }))

    expect(onRequestCloseTab).toHaveBeenCalledWith(cleanId)
    expect(useDocumentStore.getState().tabs.some((tab) => tab.id === cleanId)).toBe(true)
  })

  it('closes directly, with no callback, when no onRequestCloseTab prop is given at all', async () => {
    // Every pre-existing test in this file renders <EditorTabBar /> with no
    // props -- this locks in that the fallback degrades to the exact old
    // store-level behavior when the prop is simply absent.
    useDocumentStore.getState().openTab('/tmp/a.md', '# A', true)
    const activeId = useDocumentStore.getState().activeTabId
    const user = userEvent.setup()
    render(<EditorTabBar />)

    await user.click(screen.getByRole('button', { name: 'Close a.md' }))

    expect(useDocumentStore.getState().tabs.some((tab) => tab.id === activeId)).toBe(false)
  })

  // The unsaved-changes marker. It used to render unconditionally (a
  // decorative "kind tag" square), so it conveyed nothing -- isDirty reached
  // the UI in exactly one place, the status bar, for the active tab only.
  describe('unsaved-changes marker', () => {
    it('shows a named marker on exactly the dirty tabs', () => {
      useDocumentStore.getState().openTab('/tmp/dirty.md', '# D', true)
      useDocumentStore.getState().openTab('/tmp/clean.md', '# C')
      render(<EditorTabBar />)

      // Exactly one marker, for the one dirty tab -- not one per tab, which
      // is what the unconditional version rendered.
      const markers = screen.getAllByRole('img', { name: 'Unsaved changes' })
      expect(markers).toHaveLength(1)
      // Inside the dirty tab, not merely somewhere on screen.
      expect(screen.getByRole('tab', { name: 'dirty.md' })).toContainElement(markers[0])
      // Not conveyed by colour alone: a real title tooltip as well as the
      // accessible name.
      expect(markers[0]).toHaveAttribute('title', 'Unsaved changes')
    })

    it('drops the marker once the tab is saved', () => {
      useDocumentStore.getState().openTab('/tmp/dirty.md', '# D', true)
      const { rerender } = render(<EditorTabBar />)
      expect(screen.getAllByRole('img', { name: 'Unsaved changes' })).toHaveLength(1)

      act(() => {
        useDocumentStore.setState((state) => ({
          isDirty: false,
          tabs: state.tabs.map((tab) => ({ ...tab, isDirty: false }))
        }))
      })
      rerender(<EditorTabBar />)

      expect(screen.queryByRole('img', { name: 'Unsaved changes' })).not.toBeInTheDocument()
    })
  })

  // Product-completeness audit, Tier 1 section 1.5: roving tabIndex was set
  // up (tabIndex={isActive ? 0 : -1}) but nothing ever MOVED it -- a keyboard
  // user could reach exactly one tab (the active one) no matter how many were
  // open, and Enter/Space could only ever activate whatever already had
  // focus. Arrow keys now move focus AND switch the active tab together
  // (automatic activation -- see handleTabKeyDown's own comment for why that,
  // not "focus-only", is the correct completion of THIS component's existing
  // model).
  describe('keyboard navigation across tabs', () => {
    it('ArrowRight moves focus to, and activates, the next tab', () => {
      useDocumentStore.getState().openTab('/tmp/a.md', '# A')
      useDocumentStore.getState().openTab('/tmp/b.md', '# B')
      render(<EditorTabBar />)

      // b.md is active (and therefore the only tab in the roving Tab
      // sequence) after the two opens above -- focus it directly, the way a
      // real Tab keypress into the bar would have landed here.
      const tabB = screen.getByRole('tab', { name: 'b.md' })
      tabB.focus()
      fireEvent.keyDown(tabB, { key: 'ArrowRight' })

      // Wraps: b.md (index 1 of [Untitled, a.md, b.md]) -> Untitled (index 0).
      const untitled = screen.getByRole('tab', { name: 'Untitled' })
      expect(untitled).toHaveFocus()
      expect(untitled).toHaveAttribute('aria-selected', 'true')
      expect(untitled).toHaveAttribute('tabindex', '0')
      expect(tabB).toHaveAttribute('aria-selected', 'false')
      expect(tabB).toHaveAttribute('tabindex', '-1')
      // The store's own activeTabId (an internal id, e.g. "tab-1" -- not the
      // display label) actually moved too, not just the DOM attributes above.
      // The blank/"Untitled" tab is the one with filePath === null.
      const untitledId = useDocumentStore.getState().tabs.find((tab) => tab.filePath === null)?.id
      expect(useDocumentStore.getState().activeTabId).toBe(untitledId)
    })

    it('ArrowLeft moves focus to, and activates, the previous tab, wrapping past the start', () => {
      useDocumentStore.getState().openTab('/tmp/a.md', '# A')
      useDocumentStore.getState().openTab('/tmp/b.md', '# B')
      render(<EditorTabBar />)

      const tabB = screen.getByRole('tab', { name: 'b.md' })
      switchTabByClick(tabB)
      // b.md is index 2 (last) of [Untitled, a.md, b.md] -- ArrowLeft should
      // land on a.md, not wrap.
      fireEvent.keyDown(tabB, { key: 'ArrowLeft' })

      const tabA = screen.getByRole('tab', { name: 'a.md' })
      expect(tabA).toHaveFocus()
      expect(tabA).toHaveAttribute('aria-selected', 'true')
    })

    it('Home moves focus to, and activates, the first tab', () => {
      useDocumentStore.getState().openTab('/tmp/a.md', '# A')
      useDocumentStore.getState().openTab('/tmp/b.md', '# B')
      render(<EditorTabBar />)

      const tabB = screen.getByRole('tab', { name: 'b.md' })
      tabB.focus()
      fireEvent.keyDown(tabB, { key: 'Home' })

      const untitled = screen.getByRole('tab', { name: 'Untitled' })
      expect(untitled).toHaveFocus()
      expect(untitled).toHaveAttribute('aria-selected', 'true')
    })

    it('End moves focus to, and activates, the last tab', () => {
      useDocumentStore.getState().openTab('/tmp/a.md', '# A')
      useDocumentStore.getState().openTab('/tmp/b.md', '# B')
      render(<EditorTabBar />)

      // Untitled (first) is the only one focusable/active right after setup
      // above ends on b.md -- switch back to Untitled by click first so this
      // test starts from a known, non-last tab.
      const untitled = screen.getByRole('tab', { name: 'Untitled' })
      switchTabByClick(untitled)
      fireEvent.keyDown(untitled, { key: 'End' })

      const tabB = screen.getByRole('tab', { name: 'b.md' })
      expect(tabB).toHaveFocus()
      expect(tabB).toHaveAttribute('aria-selected', 'true')
    })

    function switchTabByClick(tab: HTMLElement): void {
      tab.focus()
      fireEvent.click(tab)
    }
  })

  // The other half of the same audit finding: a keyboard user tabbing
  // through could already land on a BACKGROUND tab's close button (it has no
  // tabIndex override, so it's in the normal Tab sequence regardless of the
  // roving-tabindex scheme its parent tab div follows) while it was still
  // opacity-0 -- reachable and activatable, but invisible. Asserted against
  // the className string, not a real computed style: this project's Vitest
  // config runs jsdom with no CSS pipeline (no `css: true`, no stylesheet
  // import in test-setup.ts), so Tailwind's generated rules are never
  // actually loaded into the test DOM -- getComputedStyle(...).opacity here
  // would read the CSS-initial value (1) regardless of which utility classes
  // are present, proving nothing. Same limitation CLAUDE.md documents for
  // dark mode (gate24-dark-mode.spec.ts exists specifically because "jsdom
  // can prove data-theme gets set, not that anything actually paints
  // differently"); real paint verification for this fix would need the same
  // kind of Playwright gate, not a unit test.
  // ------------------------------------------------------------------
  // Drag to reorder
  // ------------------------------------------------------------------
  //
  // jsdom implements no drag-and-drop pipeline and no layout, so both halves
  // of a real drop have to be staged: a hand-built DataTransfer (jsdom has no
  // DataTransfer constructor at all -- confirmed by `typeof DataTransfer`
  // being 'undefined' here), and a stubbed getBoundingClientRect so
  // isDropAfter has a real geometry to answer against. What that leaves
  // genuinely covered is everything above the browser's own event plumbing:
  // that the component reads the drag's payload, resolves left-half/right-half
  // against the target's box, and calls the store with the right FINAL index.
  // The index arithmetic itself is separately and exhaustively covered in
  // lib/tab-reorder.test.ts.
  describe('drag to reorder', () => {
    interface FakeDataTransfer {
      types: string[]
      dropEffect: string
      effectAllowed: string
      setData: (type: string, value: string) => void
      getData: (type: string) => string
    }

    function makeDataTransfer(initial?: Record<string, string>): FakeDataTransfer {
      const store = new Map<string, string>(Object.entries(initial ?? {}))
      return {
        get types() {
          return [...store.keys()]
        },
        dropEffect: 'none',
        effectAllowed: 'none',
        setData: (type, value) => {
          store.set(type, value)
        },
        getData: (type) => store.get(type) ?? ''
      } as FakeDataTransfer
    }

    // Stakes out a 100px-wide tab starting at x=0, so clientX 10 is the left
    // half and clientX 90 the right half.
    function stubBox(el: HTMLElement): void {
      el.getBoundingClientRect = (() =>
        ({ left: 0, width: 100, right: 100, top: 0, bottom: 30, height: 30 }) as DOMRect) as never
    }

    // fireEvent.dragOver/.drop CANNOT carry clientX, and this is a real trap
    // rather than a nicety: jsdom implements no DragEvent constructor, so
    // @testing-library/dom falls back to a plain Event, which silently ignores
    // every unknown init field -- `clientX` arrives as `undefined`, and
    // `undefined >= midpoint` is false, so EVERY drop reads as a left-half
    // drop. That made a right-half test pass against the wrong final index
    // while a left-half test passed for the wrong reason. Constructing a real
    // MouseEvent (which jsdom does implement, and which honours clientX)
    // fixes it; dataTransfer is attached by hand because that is the one
    // property MouseEvent has no init for.
    function fireDragEvent(
      el: HTMLElement,
      type: 'dragover' | 'drop',
      dataTransfer: FakeDataTransfer,
      clientX: number
    ): void {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX })
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      fireEvent(el, event)
    }

    function openThree(): void {
      useDocumentStore.getState().openTab('/tmp/a.md', '# A')
      useDocumentStore.getState().openTab('/tmp/b.md', '# B')
      useDocumentStore.getState().openTab('/tmp/c.md', '# C')
    }

    function paths(): (string | null)[] {
      return useDocumentStore.getState().tabs.map((tab) => tab.filePath)
    }

    it('dragging a tab onto the RIGHT half of a later tab moves it after that tab', () => {
      openThree()
      render(<EditorTabBar />)
      const dataTransfer = makeDataTransfer()

      const dragged = screen.getByRole('tab', { name: 'a.md' })
      const target = screen.getByRole('tab', { name: 'c.md' })
      stubBox(target)

      fireEvent.dragStart(dragged, { dataTransfer })
      fireDragEvent(target, 'dragover', dataTransfer, 90)
      fireDragEvent(target, 'drop', dataTransfer, 90)

      expect(paths()).toEqual([null, '/tmp/b.md', '/tmp/c.md', '/tmp/a.md'])
    })

    it('dragging a tab onto the LEFT half of an earlier tab moves it before that tab', () => {
      openThree()
      render(<EditorTabBar />)
      const dataTransfer = makeDataTransfer()

      const dragged = screen.getByRole('tab', { name: 'c.md' })
      const target = screen.getByRole('tab', { name: 'a.md' })
      stubBox(target)

      fireEvent.dragStart(dragged, { dataTransfer })
      fireDragEvent(target, 'dragover', dataTransfer, 10)
      fireDragEvent(target, 'drop', dataTransfer, 10)

      expect(paths()).toEqual([null, '/tmp/c.md', '/tmp/a.md', '/tmp/b.md'])
    })

    it('a drag carrying no tab payload (e.g. a real file from the OS) is ignored entirely', () => {
      openThree()
      render(<EditorTabBar />)
      const before = paths()
      // What a file drag from Finder actually looks like -- and the case that
      // must fall through untouched, since dropping an image on the editor is
      // a real feature elsewhere in this app.
      const dataTransfer = makeDataTransfer({ 'text/plain': '/tmp/some-image.png' })
      const target = screen.getByRole('tab', { name: 'a.md' })
      stubBox(target)

      fireDragEvent(target, 'dragover', dataTransfer, 90)
      fireDragEvent(target, 'drop', dataTransfer, 90)

      expect(paths()).toEqual(before)
    })

    it('the drag payload carries ONLY the private tab type, never text/plain', () => {
      openThree()
      render(<EditorTabBar />)
      const dataTransfer = makeDataTransfer()

      fireEvent.dragStart(screen.getByRole('tab', { name: 'a.md' }), { dataTransfer })

      // Advertising text/plain would make a tab dropped on the document body
      // insert its own id as literal text, via ProseMirror's default drop
      // handling -- see EditorTabBar's TAB_DRAG_TYPE comment.
      expect(dataTransfer.types).toEqual(['application/x-pagedown-tab'])
      expect(dataTransfer.getData('application/x-pagedown-tab')).toBe(
        useDocumentStore.getState().tabs[1].id
      )
    })

    // ----------------------------------------------------------------
    // The drop indicator: ONE gap, ONE position
    // ----------------------------------------------------------------
    //
    // User-reported: "when you move it there's two different places where the
    // blue bar can snap to between two tabs". The hint used to be
    // {overIndex, dropAfter}, so the gap between tabs N and N+1 had two
    // painters -- tab N's right edge and tab N+1's left edge -- landing 4px
    // apart across the row's 2px `gap-0.5`. Same drop, two indicators, no way
    // to tell which you were getting.
    //
    // Asserted on the emitted class rather than on paint: as the comment
    // further up this file records, base.css is never loaded into the test
    // DOM, so getComputedStyle would read initial values here and prove
    // nothing. The class names ARE the two positions -- inset +2px is a strip
    // on a tab's left edge, inset -2px one on its right edge -- so which class
    // lands on which tab is exactly the fact in question.
    type DropStrip = { tab: number; edge: 'left' | 'right' }

    function dropStrips(): DropStrip[] {
      return screen.getAllByRole('tab').flatMap((el, tab): DropStrip[] => {
        if (el.className.includes('shadow-[inset_2px')) return [{ tab, edge: 'left' }]
        if (el.className.includes('shadow-[inset_-2px')) return [{ tab, edge: 'right' }]
        return []
      })
    }

    // Every tab 100px wide and butted together, so tab i spans x = i*100.
    function stubRow(): void {
      screen.getAllByRole('tab').forEach((el, i) => {
        el.getBoundingClientRect = (() =>
          ({ left: i * 100, width: 100, right: i * 100 + 100 }) as DOMRect) as never
      })
    }

    it('paints the SAME single strip whether a gap is approached from its left or its right', () => {
      openThree()
      render(<EditorTabBar />)
      stubRow()
      const dataTransfer = makeDataTransfer()
      const tabs = screen.getAllByRole('tab')
      fireEvent.dragStart(tabs[0], { dataTransfer })

      // Every interior gap of the 4-tab bar (a blank Untitled tab precedes the
      // three opened ones), approached from both sides. Enumerated rather than
      // spot-checked: the pre-fix code was CORRECT at both ends and wrong at
      // every gap in between, so a test that only probed gap 0 or gap N would
      // have passed against it.
      for (let gap = 1; gap < tabs.length; gap++) {
        // Right half of the tab left of the gap: x = (gap-1)*100 .. +100.
        fireDragEvent(tabs[gap - 1], 'dragover', dataTransfer, (gap - 1) * 100 + 90)
        const fromLeft = dropStrips()
        // Left half of the tab right of the gap.
        fireDragEvent(tabs[gap], 'dragover', dataTransfer, gap * 100 + 10)
        const fromRight = dropStrips()

        expect(fromLeft).toHaveLength(1)
        expect(fromRight).toEqual(fromLeft)
      }
    })

    it('never paints more than one strip, at any pointer position across the whole row', () => {
      openThree()
      render(<EditorTabBar />)
      stubRow()
      const dataTransfer = makeDataTransfer()
      const tabs = screen.getAllByRole('tab')
      fireEvent.dragStart(tabs[0], { dataTransfer })

      for (let tab = 0; tab < tabs.length; tab++) {
        for (const offset of [0, 10, 49, 50, 51, 90, 99]) {
          fireDragEvent(tabs[tab], 'dragover', dataTransfer, tab * 100 + offset)
          expect(dropStrips()).toHaveLength(1)
        }
      }
    })

    it('gives the two END gaps their own positions, distinct from every interior one', () => {
      openThree()
      render(<EditorTabBar />)
      stubRow()
      const dataTransfer = makeDataTransfer()
      const tabs = screen.getAllByRole('tab')
      const last = tabs.length - 1
      fireEvent.dragStart(tabs[0], { dataTransfer })

      // Before the first tab.
      fireDragEvent(tabs[0], 'dragover', dataTransfer, 10)
      expect(dropStrips()).toEqual([{ tab: 0, edge: 'left' }])

      // After the last tab -- the one gap with no tab to its right, so the
      // only place it can be drawn is inside the last tab's right edge.
      fireDragEvent(tabs[last], 'dragover', dataTransfer, last * 100 + 90)
      expect(dropStrips()).toEqual([{ tab: last, edge: 'right' }])
    })

    it('clears the strip when the drag ends without a drop (Escape, or off the bar)', () => {
      openThree()
      render(<EditorTabBar />)
      stubRow()
      const dataTransfer = makeDataTransfer()
      const tabs = screen.getAllByRole('tab')

      fireEvent.dragStart(tabs[0], { dataTransfer })
      fireDragEvent(tabs[2], 'dragover', dataTransfer, 210)
      expect(dropStrips()).toHaveLength(1)

      fireEvent.dragEnd(tabs[0])
      expect(dropStrips()).toEqual([])
    })

    it('reordering does not switch the active tab', () => {
      openThree()
      render(<EditorTabBar />)
      const activeBefore = useDocumentStore.getState().activeTabId
      const dataTransfer = makeDataTransfer()

      const dragged = screen.getByRole('tab', { name: 'a.md' })
      const target = screen.getByRole('tab', { name: 'c.md' })
      stubBox(target)
      fireEvent.dragStart(dragged, { dataTransfer })
      fireDragEvent(target, 'drop', dataTransfer, 90)

      expect(useDocumentStore.getState().activeTabId).toBe(activeBefore)
    })
  })

  // ------------------------------------------------------------------
  // Keyboard reordering
  // ------------------------------------------------------------------
  //
  // Drag-only reordering is unreachable without a pointer, and this bar
  // already has a full keyboard model to hang the modifier off.
  describe('keyboard reordering', () => {
    it('Mod+Shift+ArrowRight moves the focused tab one place right', async () => {
      useDocumentStore.getState().openTab('/tmp/a.md', '# A')
      useDocumentStore.getState().openTab('/tmp/b.md', '# B')
      render(<EditorTabBar />)

      const tabA = screen.getByRole('tab', { name: 'a.md' })
      tabA.focus()
      fireEvent.keyDown(tabA, { key: 'ArrowRight', metaKey: true, shiftKey: true })

      expect(useDocumentStore.getState().tabs.map((tab) => tab.filePath)).toEqual([
        null,
        '/tmp/b.md',
        '/tmp/a.md'
      ])
      // Focus follows the tab to its new position, so the chord can be
      // pressed again without re-finding it. Deferred by one microtask (see
      // focusTabAt) because the DOM order only settles after React re-renders.
      await waitFor(() => expect(screen.getByRole('tab', { name: 'a.md' })).toHaveFocus())
    })

    it('Ctrl+Shift+ArrowLeft moves the focused tab one place left', () => {
      useDocumentStore.getState().openTab('/tmp/a.md', '# A')
      useDocumentStore.getState().openTab('/tmp/b.md', '# B')
      render(<EditorTabBar />)

      const tabB = screen.getByRole('tab', { name: 'b.md' })
      tabB.focus()
      fireEvent.keyDown(tabB, { key: 'ArrowLeft', ctrlKey: true, shiftKey: true })

      expect(useDocumentStore.getState().tabs.map((tab) => tab.filePath)).toEqual([
        null,
        '/tmp/b.md',
        '/tmp/a.md'
      ])
    })

    it('clamps at the ends rather than wrapping, unlike plain-arrow navigation', () => {
      useDocumentStore.getState().openTab('/tmp/a.md', '# A')
      render(<EditorTabBar />)
      const before = useDocumentStore.getState().tabs.map((tab) => tab.filePath)

      const tabA = screen.getByRole('tab', { name: 'a.md' })
      tabA.focus()
      // Already last -- a wrapping move would teleport it to the front.
      fireEvent.keyDown(tabA, { key: 'ArrowRight', metaKey: true, shiftKey: true })

      expect(useDocumentStore.getState().tabs.map((tab) => tab.filePath)).toEqual(before)
    })

    it('plain ArrowRight still only moves focus/selection, never the tab order', () => {
      useDocumentStore.getState().openTab('/tmp/a.md', '# A')
      useDocumentStore.getState().openTab('/tmp/b.md', '# B')
      render(<EditorTabBar />)
      const before = useDocumentStore.getState().tabs.map((tab) => tab.filePath)

      const tabB = screen.getByRole('tab', { name: 'b.md' })
      tabB.focus()
      fireEvent.keyDown(tabB, { key: 'ArrowRight' })

      expect(useDocumentStore.getState().tabs.map((tab) => tab.filePath)).toEqual(before)
      expect(screen.getByRole('tab', { name: 'Untitled' })).toHaveAttribute('aria-selected', 'true')
    })
  })

  // The "+" button was visibly low against the tabs. Root cause: the tablist
  // is `items-end`, which aligns a flex item by the BOTTOM of its margin box,
  // so the `mt-[5px]` it used to carry could not move it at all -- a top
  // margin only extends the box upward. Asserted against the className for the
  // same reason the close-button opacity test below does: this project's
  // Vitest config runs jsdom with no CSS pipeline, so a computed style here
  // would read the CSS-initial value regardless of which utilities are
  // present. The real numbers (label centre 57.63 vs button centre 65 before;
  // 58.0 after) were measured in the real built app.
  it('aligns the "+" button with a BOTTOM margin, the only side items-end responds to', () => {
    render(<EditorTabBar />)
    const plus = screen.getByRole('button', { name: 'New tab' })

    expect(plus.className).toContain('mb-[7px]')
    expect(plus.className).not.toContain('mt-[')
  })

  it("keeps focus:opacity-100 on an inactive tab's close button", () => {
    useDocumentStore.getState().openTab('/tmp/a.md', '# A')
    useDocumentStore.getState().openTab('/tmp/b.md', '# B')
    render(<EditorTabBar />)

    // a.md is the inactive (background) tab once b.md is opened second.
    const closeA = screen.getByRole('button', { name: 'Close a.md' })
    expect(closeA.className).toContain('opacity-0')
    expect(closeA.className).toContain('focus:opacity-100')
  })
})
