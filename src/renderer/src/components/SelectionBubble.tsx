import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject
} from 'react'
import { computeFloatingPosition, type Rect } from '../lib/floating-position'
import type { SelectionSnapshot } from '../milkdown/selection-plugin'
import type { TableAlignment } from '../milkdown/table-context'

// The floating formatting toolbar that appears near a text selection in the
// Milkdown (Format mode) canvas -- an explicit v1 requirement of the master
// design doc's "Tooling for non-Markdown-fluent users", alongside the
// already-built persistent toolbar.
//
// THIS WAS THE FIRST FLOATING SURFACE IN THIS APP, and the argument it had to
// make is now load-bearing for three more. FindBar, CommentComposer and
// LinkComposer were all LAYOUT ROWS because a WebContentsView (Split mode's
// live preview) composites above ALL DOM unconditionally. A selection bubble
// cannot be a layout row and still be a selection bubble, so instead of
// dodging the native view it is CLAMPED out of its column: everything it
// renders is confined to `intersect(canvas, editor pane)`, computed by
// lib/floating-position.ts, which the editor pane and the preview view are
// disjoint halves of. See that module's header for the measurements and for
// why the PageSetupModal zero-rect workaround is the wrong tool here (it would
// strobe the whole preview on every drag-select, through the same serialized
// native queue that carries real renders). The slash palette reused that clamp
// next, and the two COMPOSERS followed (FloatingCard.tsx) once it was clear
// the guarantee generalises -- FindBar is now the only surface that is still
// deliberately a row, because a find bar is conventionally full-width and
// being a row is what lets it RESIZE the preview rather than cover it.
//
// Rendered by EditorScreen at ITS ROOT, as a sibling of PageSetupModal /
// ShortcutsHelpModal / Toast -- never inside the zoom wrapper. There is no
// createPortal anywhere in src/renderer/src; "render fixed overlays at
// EditorScreen root" is this app's established pattern and Toast already
// proves it works.
//
// THIS CONSTRAINT SURVIVED THE MECHANISM CHANGE, BUT ITS REASON DID NOT.
// This comment used to cite CSS Transforms Level 1 §3: a `transform` other
// than `none` establishes a containing block for FIXED-position descendants,
// so a nested bubble would be positioned relative to the scaled wrapper. That
// wrapper is now CSS `zoom`, and `zoom` establishes no such containing block --
// so the stated reason stopped applying while the conclusion stayed correct,
// which is the more dangerous shape of stale comment (it invites deleting the
// rule along with its dead justification).
//
// MEASURED in the real shipped Chromium rather than re-reasoned. A
// `position: fixed` box at left:400px top:300px, 100x20, font-size 20px:
//
//   no wrapper                x 400  y 300  100 x 20
//   inside zoom: 0.6          x 240  y 180   60 x 12
//   inside transform: 0.6     x 440  y 988   60 x 12
//
// So under `zoom` the containing block really is the viewport (240 is measured
// from the viewport origin, not from the wrapper) -- but the OFFSETS are
// multiplied by the zoom too, so 400px lands at 240px, and the box is still
// rendered at 60% size. Nesting this bubble in the wrapper would therefore
// still give both a wrong anchor and 60%-size hit targets, by a different
// mechanism than before. Note also that `getComputedStyle().fontSize` reports
// 20px under both wrappers: zoom moves the USED value, not the computed one,
// so a probe reading computed style would report no problem at all -- the same
// computed-vs-used trap Gate 19 hit reading `content: counter(page)`.
//
// ACCESSIBILITY, stated honestly rather than cleverly: this is a POINTER-FIRST
// CONVENIENCE, not the only path to any action it offers. It is never focused
// programmatically and never enters the tab order ahead of the editor, because
// a bubble that stole focus on every selection would be strictly worse for
// keyboard users than one they can ignore. Every command here also exists on
// the persistent toolbar and in the presets' own keymaps (Mod-b / Mod-i /
// Mod-e, all listed in ShortcutsHelpModal), so nothing is keyboard-unreachable.
// It is a real `role="toolbar"` with a label, marks genuine toggles (and only
// genuine toggles) with aria-pressed, and Escape dismisses it.
//
// Chrome, not document content: every colour below is a --color-chrome-*/
// --color-text-* token, all of which carry real :root[data-theme='dark']
// values, so dark mode is free. It must NOT copy .pagedown-document's
// hardcoded light values, which exist only because a sheet of paper has no
// dark mode.

export interface SelectionBubbleCommands {
  toggleBold: () => void
  toggleItalic: () => void
  toggleInlineCode: () => void
  toggleHeading: (level: 1 | 2 | 3) => void
  setParagraph: () => void
  // Both of these OPEN A COMPOSER (LinkComposer / CommentComposer), rather
  // than embedding an input in the bubble itself. Those composers are now
  // selection-anchored POPOVERS too -- they were full-width layout rows when
  // this comment was first written, and reusing the clamp proved out here is
  // what let them move (see FloatingCard.tsx) -- so the reason for keeping
  // them separate is no longer "a field cannot float." It is that a bubble is
  // a row of one-click toggles the user reads at a glance, and growing a text
  // field inside it would resize the toolbar under the pointer mid-gesture.
  // Both composers anchor to the same selection rect this bubble does, which
  // is exactly why opening either one must SUPPRESS this bubble (see
  // `suppressed` below) -- otherwise the two would open on top of each other.
  insertLink: () => void
  addComment: () => void
  // Removing a link is the one link action that does NOT need a composer --
  // there is nothing to type -- so unlike insertLink it dispatches directly.
  removeLink: () => void
  // ---- Table structure editing -----------------------------------------
  // These are why this bubble now appears for a bare CARET (see `visible`
  // below), not only for a text selection: a user working in a table has a
  // caret, not a range, and until this pass none of @milkdown/preset-gfm's
  // table commands except "insert table" was reachable from any surface in
  // the app at all.
  addRowBefore: () => void
  addRowAfter: () => void
  addColumnBefore: () => void
  addColumnAfter: () => void
  deleteRow: () => void
  deleteColumn: () => void
  deleteTable: () => void
  setColumnAlignment: (alignment: TableAlignment) => void
}

export interface SelectionBubbleProps {
  /** The live selection state, straight from milkdown/selection-plugin.ts. */
  snapshot: SelectionSnapshot | null
  /** The selection's on-screen box, measured by the parent. */
  anchor: Rect | null
  /** intersect(canvas, editor pane) -- null when there is nothing to clamp into. */
  safe: Rect | null
  /** Any modal or composer is open, so the bubble must get out of the way. */
  suppressed: boolean
  /**
   * Asks the parent to re-measure `anchor`/`safe`. Called from scroll/resize/
   * ResizeObserver listeners, never from an effect body. Expected to be
   * referentially stable, and read through a ref below so it need not be.
   */
  onRemeasure: () => void
  /** The scrolling editor pane, watched for size changes. */
  paneRef: RefObject<HTMLElement | null>
  commands: SelectionBubbleCommands
}

function BubbleIcon({ children }: { children: ReactNode }): ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

interface BubbleButtonProps {
  label: string
  onClick: () => void
  // Present ONLY for a genuine toggle -- its mere presence (not its value)
  // decides whether aria-pressed renders at all, matching EditorToolbar's own
  // documented rule: announcing "toggle button, currently off" for a one-shot
  // action (Link, Add comment, the ¶ reset) is actively misleading.
  active?: boolean
  children: ReactNode
}

function BubbleButton({ label, onClick, active, children }: BubbleButtonProps): ReactElement {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`flex h-[26px] min-w-[26px] flex-none items-center justify-center rounded-sm px-1.5 text-text-secondary transition-colors ${
        active ? 'bg-accent/14 text-accent' : 'hover:bg-chrome-light'
      }`}
    >
      {children}
    </button>
  )
}

function BubbleDivider(): ReactElement {
  return <div className="mx-0.5 h-4 w-px flex-none bg-border-subtle" aria-hidden="true" />
}

function SelectionBubble({
  snapshot,
  anchor,
  safe,
  suppressed,
  onRemeasure,
  paneRef,
  commands
}: SelectionBubbleProps): ReactElement | null {
  // The bubble's own measured size, needed to centre it on the anchor and to
  // decide whether it fits above. Measured through a CALLBACK REF rather than
  // a layout effect: a callback ref runs during commit (so the measurement is
  // in before paint, same as useLayoutEffect) but is not an effect, so it does
  // not trip react-hooks' `set-state-in-effect` -- and, being stable, React
  // only invokes it when the node actually mounts or unmounts, which is
  // exactly when this size can change (the button set is fixed).
  const [size, setSize] = useState({ width: 0, height: 0 })
  const measureSelf = useCallback((el: HTMLDivElement | null): void => {
    if (!el) return
    const rect = el.getBoundingClientRect()
    setSize((prev) =>
      Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5
        ? prev
        : { width: rect.width, height: rect.height }
    )
  }, [])

  // Escape dismisses the bubble for THIS context only. Stored as the dismissed
  // context KEY rather than a boolean specifically so it self-clears when the
  // selection changes, with no effect and no setState-during-render: a boolean
  // would need an effect to reset it, which is both the lint rule's target and
  // a real extra render.
  const [dismissedRange, setDismissedRange] = useState<string | null>(null)
  // Two kinds of context can raise this bubble, and the key has to say which,
  // so that dismissing one does not also dismiss the other. A ranged selection
  // is keyed by its own two ends (as it always was). A bare caret inside a
  // table is keyed by the TABLE -- deliberately not by the caret position,
  // which is not even reported for a collapsed selection (sameSnapshot ignores
  // collapsed positions, so they can be stale by design) and which would in
  // any case re-raise a dismissed bubble on every keystroke.
  const contextKey =
    snapshot == null
      ? null
      : !snapshot.empty
        ? `range:${snapshot.from}:${snapshot.to}`
        : snapshot.table
          ? `table:${snapshot.table.tablePos}`
          : null

  const visible =
    snapshot != null &&
    snapshot.hasFocus &&
    // A NodeSelection is an image / pagebreak / frontmatter atom -- none of
    // this bubble's commands mean anything for one.
    !snapshot.nodeSelection &&
    !suppressed &&
    // Non-null exactly when there is either a real text selection or a caret
    // inside a table -- i.e. this replaces the old bare `!snapshot.empty`,
    // which is what kept the table controls unreachable from the one selection
    // a user editing a table actually has.
    contextKey !== null &&
    dismissedRange !== contextKey &&
    anchor != null &&
    // No measurable safe rect means no non-occlusion guarantee, so nothing is
    // rendered at all -- see intersectRect's own comment. (Consequence worth
    // knowing before writing a test: jsdom has no layout, so every rect it
    // reports is zero and this component renders nothing unless a test injects
    // real rects through the `anchor`/`safe` props, which is exactly how
    // SelectionBubble.test.tsx drives it.)
    safe != null

  const onRemeasureRef = useRef(onRemeasure)
  useEffect(() => {
    onRemeasureRef.current = onRemeasure
  })

  // Re-measure on anything that moves the selection on screen WITHOUT changing
  // the ProseMirror selection (which would have reported through the plugin
  // already). Scroll is registered with capture:true on window because the
  // editor pane is `overflow-auto` in both branches and element scroll events
  // do not bubble -- they do propagate in the capture phase. The
  // ResizeObserver covers a layout row (FindBar/CommentComposer/the error
  // banner) opening or closing, which resizes the pane with no scroll or
  // window resize at all.
  useEffect(() => {
    if (!visible) return
    const handle = (): void => onRemeasureRef.current()
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
  }, [visible, paneRef])

  // Latest-refs so the Escape listener below can be registered ONCE, on mount,
  // and still read current values -- matching Toast.tsx's onDismiss and
  // MilkdownEditor.tsx's onChangeRef convention.
  const visibleRef = useRef(visible)
  const contextKeyRef = useRef(contextKey)
  useEffect(() => {
    visibleRef.current = visible
    contextKeyRef.current = contextKey
  })

  // **Registered unconditionally on mount, NOT gated on `visible` — that gate
  // was a real, gate-caught bug, not a hypothetical.** This is a passive
  // effect, so React flushes it AFTER paint; gating it on `visible` meant that
  // in the frame between the bubble entering the DOM and the effect running,
  // there was no Escape listener at all, and a keypress landing in that window
  // was silently dropped. Gate 28 caught it once in ~25 runs (an Escape that
  // left the bubble up for a full 5s assertion window) and could not reproduce
  // it in ~25 further attempts — exactly the profile of a one-frame race.
  // Registering once and reading the current values through refs removes the
  // window by construction rather than narrowing it. The handler still no-ops
  // while hidden, so behaviour is otherwise unchanged.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      // Deliberately not preventDefault()'d: Escape has other meanings in this
      // app (FindBar closes on it) and swallowing it here would make which one
      // wins depend on listener registration order.
      if (event.key !== 'Escape') return
      if (!visibleRef.current) return
      setDismissedRange(contextKeyRef.current)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  if (!visible || !anchor || !safe) return null

  const placement = computeFloatingPosition(anchor, size, safe)
  // Until the first measurement lands (the frame it mounts), the position was
  // computed against a zero size and would be visibly off-centre. The node has
  // to exist to be measurable, so it is rendered and hidden rather than
  // deferred -- and because the measurement happens in a callback ref during
  // commit, this state never reaches paint in a real browser.
  //
  // Hidden with `opacity`, deliberately NOT `visibility: hidden`: the latter
  // removes the element from the ACCESSIBILITY TREE as well as from view, so
  // for that first frame the toolbar would not exist for a screen reader --
  // and it is genuinely absent from jsdom's own role queries, which is how
  // this was caught (every getByRole in SelectionBubble.test.tsx failed
  // against a DOM that was plainly right, because jsdom never measures
  // anything and so never leaves this state).
  //
  // And deliberately NO `pointer-events: none` alongside it, though that looks
  // like the obvious companion: the unmeasured state cannot survive the commit
  // that mounts the node (the callback ref measures during that same commit,
  // before paint), so there is no frame in which a real user could click a
  // mispositioned bubble -- while jsdom, which never measures, would be stuck
  // in this state forever and every click test became literally unperformable
  // ("Unable to perform pointer interaction as the element has
  // `pointer-events: none`"). Measured, not assumed.
  const measured = size.width > 0

  return (
    <div
      ref={measureSelf}
      role="toolbar"
      aria-label="Text formatting"
      // NEVER call view.focus() from a bubble command -- direct sibling of
      // applyFindState's documented rule. preventDefault on mousedown is the
      // other half: it stops DOM focus leaving the ProseMirror node in the
      // first place, so the browser keeps painting the selection as active and
      // the plugin's own blur listener never fires and hides this bubble
      // mid-click. state.selection would survive a blur regardless, and
      // editor.action(callCommand(...)) needs no focus -- this is about the
      // selection staying VISIBLE and the bubble staying put.
      onMouseDown={(event) => event.preventDefault()}
      style={{
        position: 'fixed',
        left: placement.left,
        top: placement.top,
        maxWidth: placement.maxWidth,
        opacity: measured ? 1 : 0
      }}
      // z-40: below the z-50 modals and Toast's z-60, above everything in the
      // content area. overflow-x-auto + the maxWidth above is the narrow-pane
      // fallback -- Split mode's MIN_SPLIT_RATIO leaves a ~168px left pane,
      // narrower than this bubble, and widening past the safe rect is exactly
      // what would put it under the native preview view.
      className="scrollbar-hide z-40 flex items-center gap-0.5 overflow-x-auto rounded-md border border-border-chrome bg-page px-1 py-1 shadow-float-sm"
    >
      {/* The FORMATTING half renders only for a real text selection. A bare
      caret in a table raises this bubble too (that is how the table controls
      below are reachable at all), and every control in this group is either
      meaningless or misleading there: bold/italic on a caret set a STORED mark
      that only affects the next typed character, and a table cell's content
      model is the single rigid `paragraph`, so the heading buttons cannot
      apply inside one and would render as buttons that visibly do nothing --
      exactly the failure mode this whole pass exists to remove. */}
      {!snapshot.empty && (
        <>
          <BubbleButton label="Bold" active={snapshot.marks.bold} onClick={commands.toggleBold}>
            <span className="text-13 font-bold leading-none">B</span>
          </BubbleButton>
          <BubbleButton
            label="Italic"
            active={snapshot.marks.italic}
            onClick={commands.toggleItalic}
          >
            <span className="text-13 italic leading-none">I</span>
          </BubbleButton>
          <BubbleButton
            label="Inline code"
            active={snapshot.marks.inlineCode}
            onClick={commands.toggleInlineCode}
          >
            <BubbleIcon>
              <path d="M9 8.5 5.5 12 9 15.5" />
              <path d="M15 8.5 18.5 12 15 15.5" />
            </BubbleIcon>
          </BubbleButton>

          <BubbleDivider />

          {([1, 2, 3] as const).map((level) => (
            <BubbleButton
              key={level}
              label={`Heading ${level}`}
              // A genuine toggle: toggleHeading turns an h{level} back into a
              // paragraph when it is already that level (see EditorCommands).
              active={snapshot.headingLevel === level}
              onClick={() => commands.toggleHeading(level)}
            >
              <span className="text-12-5 font-semibold leading-none">H{level}</span>
            </BubbleButton>
          ))}
          {/* One-shot: setParagraph converts unconditionally, so no aria-pressed. */}
          <BubbleButton label="Normal text" onClick={commands.setParagraph}>
            <span className="text-13 leading-none">¶</span>
          </BubbleButton>

          <BubbleDivider />

          <BubbleButton label="Insert link" onClick={commands.insertLink}>
            <BubbleIcon>
              <path d="M9.5 14.5 14.5 9.5" />
              <path d="M11 7.5l1-1a3.5 3.5 0 0 1 5 5l-1 1" />
              <path d="M13 16.5l-1 1a3.5 3.5 0 0 1-5-5l1-1" />
            </BubbleIcon>
          </BubbleButton>
          <BubbleButton label="Add comment" onClick={commands.addComment}>
            <BubbleIcon>
              <path d="M4 5.5h16v10H10l-4 3.5v-3.5H4z" />
            </BubbleIcon>
          </BubbleButton>
          {/* Only offered when there IS a link to remove -- a permanently present
      "Remove link" that silently no-ops on unlinked text would be one more
      dead control. `marks.link` is the same predicate insertLink itself
      branches on to choose update-vs-toggle, so the button's presence and the
      command's behaviour cannot disagree. */}
          {snapshot.marks.link && (
            <BubbleButton label="Remove link" onClick={commands.removeLink}>
              <BubbleIcon>
                <path d="M11 7.5l1-1a3.5 3.5 0 0 1 5 5l-1 1" />
                <path d="M13 16.5l-1 1a3.5 3.5 0 0 1-5-5l1-1" />
                <path d="M5 5l14 14" />
              </BubbleIcon>
            </BubbleButton>
          )}
        </>
      )}

      {/* The TABLE half. Present only while the selection is genuinely inside
      a table, which is the whole reason this is a context-sensitive floating
      surface rather than ten more permanently-visible toolbar buttons -- see
      this file's own module comment and the report for why the toolbar, the
      slash menu and the native context menu were each ruled out. */}
      {snapshot.table && (
        <>
          {!snapshot.empty && <BubbleDivider />}
          <BubbleButton label="Insert row above" onClick={commands.addRowBefore}>
            <BubbleIcon>
              <path d="M4 13.5h16v6H4z" />
              <path d="M12 4v6M9 7h6" />
            </BubbleIcon>
          </BubbleButton>
          <BubbleButton label="Insert row below" onClick={commands.addRowAfter}>
            <BubbleIcon>
              <path d="M4 4.5h16v6H4z" />
              <path d="M12 14v6M9 17h6" />
            </BubbleIcon>
          </BubbleButton>
          <BubbleButton label="Insert column left" onClick={commands.addColumnBefore}>
            <BubbleIcon>
              <path d="M13.5 4v16h6V4z" />
              <path d="M4 12h6M7 9v6" />
            </BubbleIcon>
          </BubbleButton>
          <BubbleButton label="Insert column right" onClick={commands.addColumnAfter}>
            <BubbleIcon>
              <path d="M4.5 4v16h6V4z" />
              <path d="M14 12h6M17 9v6" />
            </BubbleIcon>
          </BubbleButton>

          <BubbleDivider />

          <BubbleButton label="Delete row" onClick={commands.deleteRow}>
            <BubbleIcon>
              <path d="M4 9h16v6H4z" />
              <path d="M8 20h8" />
            </BubbleIcon>
          </BubbleButton>
          <BubbleButton label="Delete column" onClick={commands.deleteColumn}>
            <BubbleIcon>
              <path d="M9 4v16h6V4z" />
              <path d="M20 8v8" />
            </BubbleIcon>
          </BubbleButton>
          <BubbleButton label="Delete table" onClick={commands.deleteTable}>
            <BubbleIcon>
              <path d="M4.5 5h15v14h-15z" />
              <path d="M4.5 10h15M4.5 15h15M12 5v14" />
              <path d="M5 5l14 14" />
            </BubbleIcon>
          </BubbleButton>

          <BubbleDivider />

          {/* Genuine toggles, so these DO carry aria-pressed -- the pressed one
          is the column's current alignment, read from the column's own HEADER
          cell (table-context.ts's readColumnAlignment) because that is the only
          cell markdown actually serialises. */}
          {(['left', 'center', 'right'] as const).map((alignment) => (
            <BubbleButton
              key={alignment}
              label={`Align column ${alignment}`}
              active={snapshot.table?.alignment === alignment}
              onClick={() => commands.setColumnAlignment(alignment)}
            >
              <BubbleIcon>
                <path d="M4 7h16" />
                <path
                  d={
                    alignment === 'left'
                      ? 'M4 12h9'
                      : alignment === 'center'
                        ? 'M7.5 12h9'
                        : 'M11 12h9'
                  }
                />
                <path d="M4 17h16" />
              </BubbleIcon>
            </BubbleButton>
          ))}
        </>
      )}
    </div>
  )
}

export default SelectionBubble
