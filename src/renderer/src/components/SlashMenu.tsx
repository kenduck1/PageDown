import { useCallback, useState, type ReactElement } from 'react'
import { computeFloatingPosition, type Rect } from '../lib/floating-position'
import type { SlashItem, SlashItemGroup } from '../milkdown/slash-items'

// The floating palette that appears when a slash-command session is open
// (Task 4 -- the presentational half; Task 5 wires this to the live
// ProseMirror plugin/session). Structurally the second floating surface in
// this app, after SelectionBubble.tsx -- read that component's own header
// comment before touching this one, since every hard-won lesson it records
// (why measure via a callback ref rather than useLayoutEffect, why hide
// pre-measurement with `opacity: 0` rather than `visibility: hidden`, why
// render at EditorScreen root outside the `transform: scale(zoom)` wrapper,
// why NEVER divide a coordinate by zoom -- coordsAtPos already returns
// post-transform viewport coordinates) applies here VERBATIM and is not
// re-derived below.
//
// Positioning reuses lib/floating-position.ts's computeFloatingPosition,
// same as SelectionBubble -- the SAME occlusion guarantee (Split mode's live
// preview is a native WebContentsView compositing above ALL DOM
// unconditionally) applies to this palette too, and that file was already
// written generic enough for both callers (see its own header comment: "the
// selection bubble today; the slash menu next"). Not writing a second clamp
// here is deliberate, not merely convenient -- a second implementation is a
// second place the occlusion guarantee could silently drift out of sync
// with the measured Split-mode geometry.
//
// One real difference from SelectionBubble worth calling out: this
// component PREFERS OPENING ABOVE its anchor too, purely because that's
// computeFloatingPosition's own built-in preference (flipping below only
// when there isn't room above) -- not a slash-menu-specific choice. Most
// editors default a slash palette to open BELOW the "/" instead, but
// diverging from that here would mean either a second positioning function
// (explicitly ruled out -- see this file's own task brief) or teaching
// computeFloatingPosition a per-caller placement preference it doesn't have
// today. Reusing the existing, already-tested function as-is was the
// judgment call; Task 5/a future pass can revisit if the "opens above"
// default reads wrong in practice.

export interface SlashMenuProps {
  /**
   * The items to display, in final display order -- already both FILTERED
   * (slash-filter.ts's filterSlashItems, by the live query) and reduced to
   * only currently-enabled items (each item's own isEnabled(ctx, state),
   * evaluated by whoever owns `ctx`/`state` -- this component is pure
   * presentation and never evaluates isEnabled itself, since doing so would
   * need a live Ctx this component has no business holding). A
   * block-replacing item (Math block, Mermaid diagram) that isn't
   * currently safe per this task's own HARD REQUIREMENT must never appear
   * in this array at all -- there is no "disabled but visible" rendering
   * path here, matching the brief's own first (offer ONLY when safe)
   * option over its parenthetical alternative (show disabled).
   *
   * THE SINGLE SOURCE OF TRUTH FOR THIS CONTRACT is slash-plugin.ts's own
   * `CountMatching` type, not this comment -- fix round 1, IMPORTANT I3.
   * `activeIndex` below is an index into THIS array, but the live session's
   * own `activeIndex`/wraparound is computed inside slash-plugin.ts against
   * a SEPARATE count (`countMatching(query, state)`) that Task 5's
   * controller must build with the IDENTICAL filter-then-isEnabled formula
   * used to build `items` here. If the two ever compute different numbers
   * (e.g. countMatching forgets the isEnabled half and only applies
   * filterSlashItems), arrow-key navigation can walk `activeIndex` past the
   * end of this shorter, rendered array -- `items[activeIndex]` undefined,
   * nothing `aria-selected`, `aria-activedescendant` pointing at nothing,
   * Enter picking nothing. This component cannot defend against that
   * mismatch itself (it has no independent way to know the "correct" count);
   * the two arrays must be built from the same formula at the call site.
   */
  items: SlashItem[]
  /** Index into `items` of the currently highlighted entry (arrow-key navigation lives in slash-plugin.ts, not here). */
  activeIndex: number
  /** The "/" trigger's on-screen box, in viewport coordinates -- what the palette anchors against. */
  anchor: Rect | null
  /** intersect(canvas, editor pane) -- null when there is nothing to clamp into (mirrors SelectionBubble's own contract). */
  safe: Rect | null
  /** Called when the user picks an item, by click or by the controller's own Enter/Tab handling. */
  onChoose: (item: SlashItem) => void
  /**
   * Called on genuine pointer MOVEMENT over an option, so the controller can
   * move activeIndex to match -- mirrors onChoose in shape, not fired on
   * every render. Fix round 1, IMPORTANT I1: wired to `onMouseMove`
   * specifically, NOT `onMouseEnter` -- see this component's own per-option
   * handler comment below for the real, reachable bug that distinction
   * closes (a stationary cursor hijacking keyboard navigation once
   * scrollIntoView moves the list underneath it).
   */
  onHover: (index: number) => void
}

// Fixed section order, independent of `items`' own array order -- so the
// palette's own layout (which section appears where) never reorders itself
// as filtering narrows which items are present within a section. A group
// with zero surviving items after filtering is simply omitted, not rendered
// empty.
const GROUP_ORDER: SlashItemGroup[] = ['Text', 'Lists', 'Insert', 'Advanced']

// A generous but bounded default width -- clamped down further by
// computeFloatingPosition's own `maxWidth` in a narrow safe rect (Split
// mode's MIN_SPLIT_RATIO left pane, same concern SelectionBubble's own
// header comment names), never widened past it.
const MENU_WIDTH_PX = 260

function optionDomId(id: string): string {
  return `pagedown-slash-item-${id}`
}

function SlashMenu({
  items,
  activeIndex,
  anchor,
  safe,
  onChoose,
  onHover
}: SlashMenuProps): ReactElement | null {
  // Own measured size, needed to decide whether the palette fits above the
  // anchor and to clamp its width -- identical callback-ref technique to
  // SelectionBubble.tsx (measures during commit, before paint; not an
  // effect, so it doesn't trip react-hooks' set-state-in-effect rule).
  //
  // Fix round 1, IMPORTANT I1: `useCallback(..., [items])`, NOT `[]`.
  // SelectionBubble's OWN identical pattern is safe with an empty dependency
  // array only because its own comment states why: "the button set is
  // fixed" -- SelectionBubble always renders the same toolbar, so it only
  // ever needs measuring once, on mount. This palette's rendered content
  // shrinks on every keystroke (the query narrows `items`), so a `[]`
  // dependency measures ONCE, on first mount, and then never again --
  // confirmed by probe: mount with 10 items records one measurement; a
  // rerender down to 1 item re-renders the DOM (now ~40px tall) but the
  // STALE 10-item height stays in `size`, so computeFloatingPosition keeps
  // placing the box as if it were still that tall -- silently wrong
  // above/below flips and a visibly floating gap beneath a now-short menu.
  // Depending on `items` gives the callback ref a NEW identity whenever the
  // rendered list changes, which makes React detach-then-reattach it (even
  // though the underlying DOM node is the same element) -- and that
  // reattach fires synchronously during the SAME commit that already
  // re-rendered the shorter list, so the measurement it takes is never
  // stale.
  const [size, setSize] = useState({ width: 0, height: 0 })
  const measureSelf = useCallback(
    (el: HTMLDivElement | null): void => {
      if (!el) return
      // `void items` -- a genuine reference react-hooks/exhaustive-deps'
      // own dependency analysis recognizes, not a value this measurement
      // logic itself needs. It exists ONLY so `items` in the dependency
      // array below isn't flagged as "unnecessary": the value is never
      // read, but its IDENTITY changing is the entire mechanism this fix
      // relies on (see this function's own header comment).
      void items
      const rect = el.getBoundingClientRect()
      setSize((prev) =>
        Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5
          ? prev
          : { width: rect.width, height: rect.height }
      )
    },
    [items]
  )

  // Fix round 1, IMPORTANT I2: the active option must be scrolled into view
  // inside THIS component's own scroll box (max-h-80 overflow-y-auto,
  // introduced by this task) -- no other component owns that
  // responsibility. Measured by probe: with activeIndex 12 of 13 (the full,
  // unfiltered catalogue is roughly 600px of content across 4 sections in a
  // 320px box), scrollIntoView was called 0 times -- ArrowDown navigation
  // past roughly the 6th item highlighted something the user could not see,
  // with no feedback anything had moved at all.
  //
  // A callback ref, matching measureSelf's own convention above over a
  // useEffect -- but UNLIKE measureSelf, this one genuinely needs no
  // dependency array at all, and is deliberately kept fully stable
  // (`[]`, i.e. the same function every render) rather than mirroring
  // measureSelf's `[items]` trick. measureSelf needs that trick because it
  // is attached UNCONDITIONALLY to the same top-level container on every
  // render -- nothing about a stable ref target ever tells React to call it
  // again on its own. This ref is different: it is only ever assigned to
  // the CURRENTLY active option (`active ? activeOptionRef : undefined`
  // below), so which DOM node (if any) actually holds this ref changes
  // every time `active` moves to a different index -- and REACT'S OWN ref
  // reconciliation (comparing the ASSIGNED ref value per element across
  // renders, entirely independent of whether the function itself is
  // memo-stable) is what calls it on the newly-active node. The same holds
  // when the ITEM at an unchanged index changes out from under it as the
  // query filters the list: each option's own `key={item.id}` (below) forces
  // React to unmount the old node and mount a new one, and a freshly
  // mounted node always receives whatever ref is currently assigned to it.
  // Confirmed empirically, not just reasoned: reverting this to `[activeIndex]`
  // changes nothing observable -- every test below still passes -- which is
  // the actual evidence this dependency was never load-bearing here.
  // `block: 'nearest'` scrolls the minimum distance needed, matching
  // ordinary list/menu keyboard-navigation convention -- never re-centers
  // or snaps to an edge.
  const activeOptionRef = useCallback((el: HTMLDivElement | null): void => {
    el?.scrollIntoView({ block: 'nearest' })
  }, [])

  const visible = items.length > 0 && anchor != null && safe != null
  if (!visible || !anchor || !safe) return null

  const placement = computeFloatingPosition(anchor, size, safe)
  // Same "hidden until measured" contract as SelectionBubble: opacity, not
  // visibility, so the node stays in the accessibility tree from the first
  // frame (a real screen reader announcing a listbox that then silently
  // vanished for one frame would be worse than a one-frame position jump no
  // real user can perceive -- the callback ref measures during the SAME
  // commit that mounts the node, before paint, so no real frame ever shows
  // the unmeasured position anyway).
  const measured = size.width > 0

  const activeItem = items[activeIndex]
  const width = Math.min(MENU_WIDTH_PX, placement.maxWidth)

  // Group items into fixed-order sections, carrying each item's own index
  // into the FLAT `items` array (not a per-section index) -- activeIndex,
  // onHover, and aria-activedescendant all key off that flat index/id, so a
  // section-local index would require translating back and forth for no
  // benefit.
  const sections = GROUP_ORDER.map((group) => ({
    group,
    entries: items
      .map((item, index) => ({ item, index }))
      .filter((entry) => entry.item.group === group)
  })).filter((section) => section.entries.length > 0)

  return (
    <div
      ref={measureSelf}
      role="listbox"
      aria-label="Slash commands"
      aria-activedescendant={activeItem ? optionDomId(activeItem.id) : undefined}
      // Load-bearing, not defensive -- see slash-plugin.ts's own comment on
      // its `blur` handleDOMEvents: without this, a click anywhere in this
      // palette moves DOM focus off the ProseMirror editor node first,
      // which fires that blur handler and closes the whole session BEFORE
      // this element's own onClick ever runs.
      onMouseDown={(event) => event.preventDefault()}
      style={{
        position: 'fixed',
        left: placement.left,
        top: placement.top,
        width,
        opacity: measured ? 1 : 0
      }}
      // z-40, matching SelectionBubble's own layer (below z-50 modals and
      // Toast's z-60, above ordinary content-area chrome). max-h-80 +
      // overflow-y-auto bounds this palette's OWN rendered height --
      // computeFloatingPosition clamps vertical POSITION into the safe
      // rect, but has no maxHeight output to shrink the box itself (unlike
      // its maxWidth, which this component already applies above) -- so a
      // safe rect shorter than the full, unfiltered catalogue's natural
      // height needs this component's own bound, the same role
      // overflow-x-auto plays for SelectionBubble's horizontal axis.
      className="z-40 max-h-80 overflow-y-auto rounded-md border border-border-chrome bg-page py-1 shadow-float-sm"
    >
      {sections.map((section) => (
        <div key={section.group}>
          <div className="px-3 pb-1 pt-2 text-eyebrow first:pt-1.5">{section.group}</div>
          {section.entries.map(({ item, index }) => {
            const active = index === activeIndex
            return (
              <div
                key={item.id}
                ref={active ? activeOptionRef : undefined}
                id={optionDomId(item.id)}
                role="option"
                aria-selected={active}
                // Fix round 1, IMPORTANT I1: onMouseMove, NOT onMouseEnter.
                // activeOptionRef's own scrollIntoView (above) runs on every
                // ArrowDown/Up, and this palette is max-h-80 over a
                // ~600px-tall catalogue -- Chromium dispatches a synthetic
                // mousemove after a scroll changes what sits under a
                // STATIONARY cursor, so onMouseEnter fires for whatever item
                // slides under the pointer mid-scroll, silently overwriting
                // the index the arrow key just set. The pointer resting over
                // the palette is the LIKELY case, not an edge case: it opens
                // anchored at the caret, exactly where the user's mouse
                // usually already is. onMouseMove only fires on genuine
                // pointer motion, so a scroll with no real mouse movement
                // cannot trigger it.
                onMouseMove={() => onHover(index)}
                onClick={() => onChoose(item)}
                className={`flex cursor-pointer flex-col px-3 py-1.5 ${
                  active ? 'bg-accent/9' : 'hover:bg-chrome-light'
                }`}
              >
                <span className="truncate text-13 text-text-primary">{item.label}</span>
                <span className="truncate text-11 text-text-tertiary">{item.description}</span>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

export default SlashMenu
