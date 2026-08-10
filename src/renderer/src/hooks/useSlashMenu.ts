import { useCallback, useEffect, useState, type RefObject } from 'react'
import { intersectRect, sameRect, type Rect } from '../lib/floating-position'
import type { MilkdownEditorHandle } from '../milkdown/MilkdownEditor'
import type { SlashItem } from '../milkdown/slash-items'
import type { SlashSession } from '../milkdown/slash-plugin'

// The slash-menu controller (Task 5, wiring) -- mirrors useFindController.ts's
// role (the one piece of code that bridges a live Milkdown plugin into React
// state a component can render) but is a narrower, more self-contained shape,
// matching the design doc's own "the plugin reports state, the handle reports
// geometry, React does layout" split that selection-plugin.ts/SelectionBubble
// already establish for the bubble menu.
//
// UNLIKE SelectionBubble's own wiring, this hook owns its capture-phase
// scroll listener ITSELF rather than delegating it back up through an
// onRemeasure prop to EditorScreen -- a deliberate difference, not an
// inconsistency: SelectionBubble is a much older, more general-purpose
// pattern (shared measurement logic EditorScreen also needs for other
// reasons), whereas this controller exists specifically to keep ALL of the
// slash menu's ephemeral wiring -- state, remeasurement, and the onChoose/
// onHover bridge -- in one place EditorScreen only has to call, not
// orchestrate.
//
// Why items must be PULLED from the editor rather than pushed alongside the
// session: slash-plugin.ts deliberately takes no dependency on the item
// catalogue (see its own header comment) -- a session only ever carries
// `itemCount`, a number, never the items themselves. Computing the real,
// isEnabled-aware array needs a live Ctx, which only exists inside the
// Milkdown editor boundary -- so this hook calls
// editorRef.current?.getSlashItems(session.query) (editor-commands.ts, built
// from slash-items.ts's enabledSlashItems) every time the session changes,
// rather than trying to recompute the list itself with no Ctx to evaluate
// isEnabled against.

export interface SlashMenuState {
  items: SlashItem[]
  activeIndex: number
  rects: { anchor: Rect | null; safe: Rect | null }
}

export interface SlashMenuControllerParams {
  editorRef: RefObject<MilkdownEditorHandle | null>
  /** The scrollable canvas area -- same ref EditorScreen already keeps for the selection bubble's own safe-rect intersection. */
  canvasRef: RefObject<HTMLElement | null>
  /** The scrolling editor pane -- same ref EditorScreen already keeps for the selection bubble. */
  editorPaneRef: RefObject<HTMLElement | null>
}

export interface SlashMenuController {
  /** Null when no session is open -- SlashMenu.tsx's own `items.length > 0` visibility check means passing an empty array here is equally safe, but null reads as "there is nothing to show" more directly at this hook's own boundary. */
  state: SlashMenuState | null
  /** Wire to MilkdownEditor's onSlashStateChanged prop. */
  handleSlashStateChanged: (session: SlashSession | null) => void
  /** Wire to SlashMenu's onChoose prop. */
  onChoose: (item: SlashItem) => void
  /** Wire to SlashMenu's onHover prop. */
  onHover: (index: number) => void
}

export function useSlashMenu(params: SlashMenuControllerParams): SlashMenuController {
  const { editorRef, canvasRef, editorPaneRef } = params
  const [state, setState] = useState<SlashMenuState | null>(null)

  // Mirrors EditorScreen's own measureSelectionGeometry -- the anchor is the
  // caret's own on-screen box (getSelectionRect, already exported for the
  // selection bubble): while a slash session is open the ProseMirror
  // selection is ALWAYS collapsed at session.queryEnd (advanceSession's own
  // right-edge guard refuses any transaction that would leave the cursor
  // outside the tracked query range), so reading the CURRENT selection's
  // rect is exactly the "/query" trigger's own on-screen position -- no new
  // handle method (e.g. "rect of an arbitrary document position") is needed
  // for this. `safe` is the same intersect(canvas, editor pane) clamp target
  // every floating overlay in this app uses (lib/floating-position.ts's own
  // header comment).
  const measureRects = useCallback((): { anchor: Rect | null; safe: Rect | null } => {
    const anchor = editorRef.current?.getSelectionRect() ?? null
    const pane = editorPaneRef.current
    const canvas = canvasRef.current
    const safe =
      pane && canvas
        ? intersectRect(canvas.getBoundingClientRect(), pane.getBoundingClientRect())
        : null
    return { anchor, safe }
  }, [editorRef, canvasRef, editorPaneRef])

  const handleSlashStateChanged = useCallback(
    (session: SlashSession | null): void => {
      if (!session) {
        setState(null)
        return
      }
      // getSlashItems(session.query) -- NOT a bare re-read of the plugin's
      // own live state -- so this always reflects exactly the query this
      // particular session report carries, matching countMatching's own
      // `(query, state)` shape rather than re-deriving it a second way.
      const items = editorRef.current?.getSlashItems(session.query) ?? []
      setState({ items, activeIndex: session.activeIndex, rects: measureRects() })
    },
    [editorRef, measureRects]
  )

  // Re-measures position ONLY (never items/activeIndex) while the palette is
  // open -- mirrors SelectionBubble's own onRemeasure effect, but owned
  // entirely inside this controller rather than delegated to a parent
  // callback (see this file's own header). capture: true is required, not
  // optional: the editor pane is `overflow-auto` in both branches it can be
  // mounted in (the single-pane zoom wrapper, and Split mode's left pane),
  // and element scroll events do not bubble to a window listener -- they
  // only propagate in the capture phase.
  const isOpen = state != null
  useEffect(() => {
    if (!isOpen) return
    const handle = (): void => {
      setState((prev) => {
        if (!prev) return prev
        const rects = measureRects()
        if (sameRect(prev.rects.anchor, rects.anchor) && sameRect(prev.rects.safe, rects.safe)) {
          return prev
        }
        return { ...prev, rects }
      })
    }
    window.addEventListener('scroll', handle, true)
    window.addEventListener('resize', handle)
    // Covers a layout row (FindBar/CommentComposer/the error banner) opening
    // or closing, which resizes the pane with no scroll or window resize at
    // all -- same reasoning as SelectionBubble's own ResizeObserver.
    const pane = editorPaneRef.current
    const observer = new ResizeObserver(handle)
    if (pane) observer.observe(pane)
    return () => {
      window.removeEventListener('scroll', handle, true)
      window.removeEventListener('resize', handle)
      observer.disconnect()
    }
  }, [isOpen, measureRects, editorPaneRef])

  // Delegates to the exact same runSlashItem the design doc's "Choosing"
  // section specifies (delete the query, then run the item, as two
  // dispatches) -- see editor-commands.ts's own doc comment for why this
  // reads the LIVE session (anchorPos/queryEnd) rather than accepting a
  // range as a parameter here.
  const onChoose = useCallback(
    (item: SlashItem): void => {
      editorRef.current?.runSlashItem(item.id)
    },
    [editorRef]
  )

  // Moves the PLUGIN's own activeIndex (not a local copy) so a subsequent
  // ArrowDown/Up continues from wherever the pointer was last hovered,
  // matching ordinary command-palette UX -- see setActiveSlashIndexIn's own
  // doc comment (slash-plugin.ts) for why hover must go through the same
  // mechanism keyboard navigation uses rather than a parallel React-only
  // index. Dispatching synchronously re-triggers the plugin's own
  // view.update -> onStateChanged -> handleSlashStateChanged round trip
  // within this same call, which is what updates `state.activeIndex` -- no
  // separate optimistic setState is needed or written here.
  const onHover = useCallback(
    (index: number): void => {
      editorRef.current?.setActiveSlashIndex(index)
    },
    [editorRef]
  )

  return { state, handleSlashStateChanged, onChoose, onHover }
}
