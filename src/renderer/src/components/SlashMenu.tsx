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
  /** Called on pointer hover, so the controller can move activeIndex to match -- mirrors onChoose in shape, not fired on every render. */
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
                id={optionDomId(item.id)}
                role="option"
                aria-selected={active}
                onMouseEnter={() => onHover(index)}
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
