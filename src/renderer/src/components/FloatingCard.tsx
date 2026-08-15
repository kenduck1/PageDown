import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject
} from 'react'
import {
  computeFloatingPosition,
  sameRect,
  topCenterAnchor,
  type Rect
} from '../lib/floating-position'

// The positioning shell shared by the two COMPOSER POPOVERS (LinkComposer,
// CommentComposer) -- an input panel anchored at the text selection, rather
// than the full-width layout row both of them used to be.
//
// WHY THEY MOVED, and why the reasoning that made them rows no longer binds.
// Both were rows for a real, documented reason: Split mode's live preview is a
// native WebContentsView, which composites above ALL DOM unconditionally, so a
// floating panel gets silently painted over (the same property that partially
// occluded PageSetupModal and forced its zero-size-rectangle workaround). A
// layout row sidesteps that by construction -- it shrinks the content area,
// which moves SplitPreview's placeholder, which fires its existing
// ResizeObserver. But SelectionBubble then solved the floating case PROPERLY,
// by clamping into `intersect(canvasRect, editorPaneRect)` -- a rect the
// editor pane and the native view are disjoint halves of -- and
// lib/floating-position.ts was deliberately written generic (named `floating-`
// rather than `bubble-`) so the slash palette could reuse it. This is its
// third caller, not a second clamp: a second implementation is a second place
// the occlusion guarantee could drift out of sync with the measured geometry.
//
// FindBar deliberately did NOT move, and that is not an inconsistency. A find
// bar is conventionally full-width, and being a row is what lets it resize the
// preview rather than cover it. A URL field belongs at the cursor; a find bar
// does not.
//
// Every hard-won lesson SelectionBubble.tsx's own header records applies here
// VERBATIM and is not re-derived: render at EditorScreen's ROOT, outside the
// canvas's CSS `zoom` wrapper (measured: a fixed box at left:400 top:300 lands
// at x=240 y=180 at 60% size inside `zoom: 0.6`, so nesting gives both a wrong
// anchor and shrunken hit targets); never divide a coordinate BY that zoom
// (`coordsAtPos` bottoms out in `getClientRects()`, which already reports
// post-scale viewport coordinates); hide the pre-measurement frame with
// `opacity: 0` rather than `visibility: hidden` (the latter removes the node
// from the accessibility tree, and jsdom -- which never measures anything --
// would then be stuck in that state forever, making every role query fail).
//
// ONE DELIBERATE DIVERGENCE FROM THE BUBBLE, and it is the single most
// load-bearing difference in this file: THIS SURFACE TAKES DOM FOCUS.
// SelectionBubble calls `event.preventDefault()` on its own mousedown
// specifically so focus never leaves ProseMirror; a composer cannot do that,
// because the whole point is an input the user types into. That is safe, and
// not merely assumed to be: ProseMirror's `state.selection` is document state,
// wholly independent of DOM focus, and both composers already ran this exact
// flow as rows with an `autoFocus` field -- proven end to end in the real app
// by phase0/gate27-comments.spec.ts, which selects text, focuses the comment
// field, types, submits, saves, and reads the marker back off disk. What
// changes here is only WHERE the field is painted, never how the command is
// dispatched. See LinkComposer.tsx's own note for the one thing this file must
// therefore never do: call `view.focus()`, in either direction.
//
// DISCLOSED, MEASURED CONSEQUENCE OF THAT DIVERGENCE, not fixed here: while a
// composer holds focus, THE USER CANNOT SEE WHAT THEY SELECTED. Gate 43
// establishes this directly rather than by inference -- its first draft copied
// gate28's ordering and read the selection box AFTER opening the composer,
// which failed in 881ms on `expect(selectionBox).not.toBeNull()`: once an
// <input> holds focus, `window.getSelection()` reports THAT input's own
// collapsed selection, so the contenteditable's range is not merely painted in
// Chromium's muted unfocused grey -- it is gone from the DOM Selection API
// entirely.
//
// Two things follow, and the second is why this is recorded rather than
// quietly fixed. First, a `::selection` rule cannot help: there is no
// selection left to style, so the obvious one-line fix (which was written,
// committed, and then reverted once this gate measured the real behaviour) is
// dead CSS that reads like a solution. Second, this is NOT a regression -- the
// layout rows lost the highlight in exactly the same way, for exactly the same
// reason -- but it is more noticeable now that the popover sits on the words in
// question. The real fix is a ProseMirror DECORATION over the composer's target
// range, driven by the composer-open flag, i.e. the same machinery
// find-plugin.ts already uses for match highlighting; that is a new plugin plus
// handle wiring, and deliberately out of scope for a change that was about
// WHERE the field appears.

export interface FloatingCardProps {
  /** Renders nothing while false. */
  open: boolean
  /**
   * Reads the anchor (the selection's on-screen box) and the safe rect
   * (`intersect(canvas, editor pane)`) at CALL TIME.
   *
   * A function rather than two props, deliberately: this component calls it
   * from its own mount callback ref, so the very first placement is measured
   * during the same commit that put the card in the DOM -- never one frame
   * stale, and never dependent on a parent effect having run first. Passing
   * rects as props would have meant the parent measuring them from an effect
   * keyed on the open flag, which is both a render later and exactly the shape
   * this project's `react-hooks/set-state-in-effect` rule exists to reject.
   */
  measure: () => { anchor: Rect | null; safe: Rect | null }
  /** The scrolling editor pane, watched for size changes -- same contract as SelectionBubble's. */
  paneRef: RefObject<HTMLElement | null>
  /** Escape, from anywhere. Must be referentially free -- it is read through a latest-ref. */
  onClose: () => void
  /** The accessible name of the panel (`role="group"`), e.g. "Insert link". */
  label: string
  /** Preferred width in px, clamped down by the safe rect when the pane is narrow. */
  widthPx: number
  children: ReactNode
}

/**
 * The viewport, as a Rect -- the last-resort safe area when `measure()` cannot
 * produce one.
 *
 * UNREACHABLE IN THE REAL APP, and recorded as such rather than left to look
 * like a real code path: `safe` is `intersect(canvas.getBoundingClientRect(),
 * pane.getBoundingClientRect())`, and both of those elements are mounted
 * unconditionally by EditorScreen in every view mode, so the intersection is
 * only ever null when the two rects are degenerate. That happens in exactly one
 * environment -- JSDOM, which reports every rect as all-zero (see
 * selection-plugin.ts's own JSDOM HAZARD note) -- where the alternative,
 * rendering nothing, would make every composer test unwritable.
 *
 * SelectionBubble makes the OPPOSITE call for the same input (`safe == null`
 * renders nothing) and both are right, because the cost of being wrong is not
 * symmetric: a bubble that declines to appear costs the user nothing (every
 * command it offers is also on the toolbar and in a keymap), whereas a
 * composer that declines to appear after an explicit "Insert link" click is a
 * dead control -- the defect class this codebase repeatedly rates as worse
 * than any visual glitch.
 */
function viewportRect(): Rect {
  return {
    left: 0,
    top: 0,
    right: typeof window === 'undefined' ? 0 : window.innerWidth,
    bottom: typeof window === 'undefined' ? 0 : window.innerHeight
  }
}

function FloatingCard({
  open,
  measure,
  paneRef,
  onClose,
  label,
  widthPx,
  children
}: FloatingCardProps): ReactElement | null {
  const [rects, setRects] = useState<{ anchor: Rect | null; safe: Rect | null }>({
    anchor: null,
    safe: null
  })
  const [size, setSize] = useState({ width: 0, height: 0 })

  // Latest-refs for everything the stable callbacks below read, matching
  // Toast.tsx's onDismiss and MilkdownEditor.tsx's onChangeRef convention.
  // Without them, `measure`/`onClose` -- both fresh closures on every parent
  // render -- would force the callback ref and the Escape listener to be
  // re-created constantly, which for the ref means React detaching and
  // reattaching it (re-measuring) on every keystroke in the field.
  const measureRef = useRef(measure)
  const onCloseRef = useRef(onClose)
  const openRef = useRef(open)
  useEffect(() => {
    measureRef.current = measure
    onCloseRef.current = onClose
    openRef.current = open
  })

  const readRects = useCallback((): void => {
    const next = measureRef.current()
    setRects((prev) =>
      sameRect(prev.anchor, next.anchor) && sameRect(prev.safe, next.safe) ? prev : next
    )
  }, [])

  // A ResizeObserver on the card ITSELF, not SlashMenu's dependency-keyed
  // callback ref. That trick exists because its rendered list shrinks as the
  // query narrows, and a `[]`-dep ref would keep a stale height; here the size
  // changes for a reason no prop identity tracks at all -- CommentComposer's
  // field auto-grows to its content as the user types, and its inline error
  // row appears and disappears. Observing the real box is the only measurement
  // that cannot go stale. There is no feedback loop: a size change moves the
  // card (left/top) without resizing it.
  const selfObserverRef = useRef<ResizeObserver | null>(null)
  const attach = useCallback(
    (el: HTMLDivElement | null): void => {
      selfObserverRef.current?.disconnect()
      selfObserverRef.current = null
      if (!el) return
      // Measured in the SAME commit that mounts the card, which is what makes
      // the popover's first painted frame already correctly placed -- and,
      // because `open` gates the whole render below, this re-runs on every
      // open rather than once per lifetime.
      readRects()
      const applySize = (): void => {
        const rect = el.getBoundingClientRect()
        setSize((prev) =>
          Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5
            ? prev
            : { width: rect.width, height: rect.height }
        )
      }
      applySize()
      const observer = new ResizeObserver(applySize)
      observer.observe(el)
      selfObserverRef.current = observer
    },
    [readRects]
  )

  // Follow the selection while the popover is open. `capture: true` is
  // required rather than optional: the editor pane is `overflow-auto` in both
  // branches it can be mounted in, and element scroll events do not bubble to
  // a window listener -- they only propagate in the capture phase. The
  // ResizeObserver covers a layout row (FindBar, the remote-image banner)
  // opening or closing, which resizes the pane with no scroll or window resize
  // at all. Identical reasoning to SelectionBubble's and useSlashMenu's own
  // copies of this effect.
  useEffect(() => {
    if (!open) return
    const handle = (): void => readRects()
    window.addEventListener('scroll', handle, true)
    window.addEventListener('resize', handle)
    const pane = paneRef.current
    const observer = new ResizeObserver(handle)
    if (pane) observer.observe(pane)
    return () => {
      window.removeEventListener('scroll', handle, true)
      window.removeEventListener('resize', handle)
      observer.disconnect()
    }
  }, [open, paneRef, readRects])

  // REGISTERED UNCONDITIONALLY ON MOUNT, NOT from an effect gated on `open` --
  // and that gate was a real, gate-caught bug in SelectionBubble, not a
  // hypothetical. A passive effect is flushed AFTER paint, so gating it leaves
  // a one-frame window in which the surface is on screen with no Escape
  // listener at all, and a keypress landing there is silently dropped
  // (Gate 28 caught exactly that once in ~25 runs and could not reproduce it in
  // ~25 more -- the profile of a one-frame race). Registering once and reading
  // `open`/`onClose` through the latest-refs above removes the window by
  // construction rather than narrowing it.
  //
  // This is the ONLY Escape path that works when focus is NOT in the composer's
  // own field -- the user can click into the canvas or the tab bar while the
  // popover is open, and each composer's own field-level `onKeyDown` handler
  // cannot see a keypress that never reaches it. When focus IS in the field
  // both fire; `onClose` is an idempotent "set false" store action, so the
  // double call is a no-op rather than something to guard.
  //
  // No `preventDefault()`, matching SelectionBubble: Escape has other meanings
  // in this app (useFindShortcuts closes the find bar on it) and swallowing it
  // here would make which one wins depend on listener registration order.
  // Note the pre-existing consequence, unchanged by this file: an Escape typed
  // in a composer field already bubbled to that window listener while these
  // were rows, so "Escape closes the composer AND the find bar" is not new.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (!openRef.current) return
      onCloseRef.current()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  if (!open) return null

  const safe = rects.safe ?? viewportRect()
  // `?? topCenterAnchor(safe)` is reachable for real, unlike the viewport
  // fallback above: EditorToolbar's buttons and the Mod-Shift-M shortcut both
  // fire in SOURCE mode, where there is no Milkdown instance and therefore no
  // selection rect to measure. It lands the popover at the top of the editing
  // area -- exactly where the layout row this replaced used to sit -- and,
  // being a real anchor fed through the real clamp, keeps the occlusion
  // guarantee rather than bypassing it. See topCenterAnchor's own doc comment.
  const anchor = rects.anchor ?? topCenterAnchor(safe)
  const placement = computeFloatingPosition(anchor, size, safe)
  const measured = size.width > 0

  return (
    <div
      ref={attach}
      // `group`, not `dialog`. The rows these replaced were already
      // `role="group"`, so every existing query keeps working -- but the real
      // reason is that `dialog` would promise a focus trap this must NOT have:
      // the canvas, the tab bar and the toolbar all stay live and reachable
      // behind an open composer (that is precisely why the `{tabId, revision}`
      // target-document guard in EditorScreen exists at all), and claiming
      // modality we do not implement is the same false claim useModalDialog
      // was built to stop PageSetupModal making.
      role="group"
      aria-label={label}
      style={{
        position: 'fixed',
        left: placement.left,
        top: placement.top,
        width: widthPx,
        maxWidth: placement.maxWidth,
        opacity: measured ? 1 : 0
      }}
      // z-40, the same layer as SelectionBubble: below the z-50 modals and
      // Toast's z-60, above everything in the content area. Note that no
      // z-index can put this above Split mode's native preview view -- that is
      // what the clamp is for.
      className="z-40 rounded-md border border-border-chrome bg-page p-2 text-12 text-text-secondary shadow-float-sm"
    >
      {children}
    </div>
  )
}

export default FloatingCard
