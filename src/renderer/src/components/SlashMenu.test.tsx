import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SlashMenu from './SlashMenu'
import type { SlashItem } from '../milkdown/slash-items'
import type { Rect } from '../lib/floating-position'

// POSITIONING IS DELIBERATELY NOT ASSERTED IN THIS FILE, for the identical
// reason SelectionBubble.test.tsx's own header comment gives: jsdom performs
// no layout, so `anchor`/`safe` are injected directly rather than measured,
// and every rect jsdom itself would produce is zero -- asserting "the menu
// sits above the anchor" here would pass against zeros and prove nothing.
// The placement arithmetic itself is tested for real in
// lib/floating-position.test.ts; what IS testable here is render/aria/
// grouping/dispatch behaviour.

const ANCHOR: Rect = { left: 300, top: 300, right: 308, bottom: 318 }
const SAFE: Rect = { left: 216, top: 123, right: 561, bottom: 606 }

// Two groups, deliberately listed OUT of GROUP_ORDER (Insert before Text) --
// this is what lets the grouping test below distinguish "renders in a fixed
// section order" from "renders in whatever order the items array happens to
// be in".
function makeItems(overrides: Partial<Record<string, Partial<SlashItem>>> = {}): SlashItem[] {
  const base: SlashItem[] = [
    {
      id: 'gamma',
      group: 'Insert',
      label: 'Gamma',
      description: 'Third item',
      keywords: [],
      run: vi.fn(),
      isEnabled: () => true
    },
    {
      id: 'alpha',
      group: 'Text',
      label: 'Alpha',
      description: 'First item',
      keywords: [],
      run: vi.fn(),
      isEnabled: () => true
    },
    {
      id: 'beta',
      group: 'Text',
      label: 'Beta',
      description: 'Second item',
      keywords: [],
      run: vi.fn(),
      isEnabled: () => true
    }
  ]
  return base.map((item) => ({ ...item, ...overrides[item.id] }))
}

// A single-group run of `n` items, for tests that care about COUNT (I1's
// re-measurement, I2's scroll-into-view) rather than grouping -- makeItems'
// own fixed three-item, two-group fixture is deliberately awkward to resize.
function makeManyItems(n: number): SlashItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `item-${i}`,
    group: 'Text',
    label: `Item ${i}`,
    description: `Description ${i}`,
    keywords: [],
    run: vi.fn(),
    isEnabled: () => true
  }))
}

interface RenderOptions {
  items?: SlashItem[]
  activeIndex?: number
  anchor?: Rect | null
  safe?: Rect | null
  onChoose?: (item: SlashItem) => void
  onHover?: (index: number) => void
}

function props(options: RenderOptions): React.ComponentProps<typeof SlashMenu> {
  return {
    items: options.items ?? makeItems(),
    activeIndex: options.activeIndex ?? 0,
    anchor: options.anchor === undefined ? ANCHOR : options.anchor,
    safe: options.safe === undefined ? SAFE : options.safe,
    onChoose: options.onChoose ?? vi.fn(),
    onHover: options.onHover ?? vi.fn()
  }
}

function renderMenu(options: RenderOptions = {}): {
  items: SlashItem[]
  onChoose: (item: SlashItem) => void
  onHover: (index: number) => void
  rerender: (next: RenderOptions) => void
} {
  const p = props(options)
  const view = render(<SlashMenu {...p} />)
  return {
    items: p.items,
    onChoose: p.onChoose,
    onHover: p.onHover,
    rerender: (next) => view.rerender(<SlashMenu {...props(next)} />)
  }
}

afterEach(() => {
  cleanup()
})

describe('SlashMenu visibility', () => {
  it('renders a labelled listbox for a non-empty, measurable item list', () => {
    renderMenu()
    expect(screen.getByRole('listbox', { name: 'Slash commands' })).toBeInTheDocument()
  })

  it('renders nothing for an empty item list', () => {
    // The real slash-plugin.ts session cannot exist with itemCount <= 0 (see
    // its own header comment), so this should never happen in practice --
    // still, a pure presentational component should not assume its inputs
    // are always well-formed.
    renderMenu({ items: [] })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('renders nothing when there is no measurable anchor', () => {
    renderMenu({ anchor: null })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('renders nothing when there is no measurable safe rect', () => {
    // Same non-occlusion posture as SelectionBubble: no safe rect means no
    // guarantee this palette stays clear of Split mode's native preview
    // view, so "cannot guarantee" must mean "do not render".
    renderMenu({ safe: null })
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('SlashMenu grouping and content', () => {
  it('renders every item as a real option, labelled and described', () => {
    renderMenu()
    expect(screen.getByRole('option', { name: /Alpha/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Beta/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Gamma/ })).toBeInTheDocument()
    expect(screen.getByText('First item')).toBeInTheDocument()
  })

  it('renders sections in the fixed GROUP_ORDER, independent of the items array order', () => {
    // makeItems() lists Gamma (Insert) BEFORE Alpha/Beta (Text) -- if
    // grouping merely preserved array order, "Insert" would render first.
    // GROUP_ORDER is Text, Lists, Insert, Advanced, so Text must render
    // first in the DOM regardless.
    renderMenu()
    const listbox = screen.getByRole('listbox')
    const optionLabels = Array.from(listbox.querySelectorAll('[role="option"]')).map(
      (el) => el.textContent
    )
    const alphaIndex = optionLabels.findIndex((text) => text?.includes('Alpha'))
    const gammaIndex = optionLabels.findIndex((text) => text?.includes('Gamma'))
    expect(alphaIndex).toBeGreaterThanOrEqual(0)
    expect(gammaIndex).toBeGreaterThanOrEqual(0)
    expect(alphaIndex).toBeLessThan(gammaIndex)
  })

  it('omits a section header entirely for a group with zero surviving items', () => {
    renderMenu({ items: makeItems().filter((item) => item.group === 'Text') })
    expect(screen.queryByText('Insert')).toBeNull()
    expect(screen.getByText('Text')).toBeInTheDocument()
  })
})

describe('SlashMenu active index', () => {
  it('marks the item at activeIndex aria-selected and points aria-activedescendant at it', () => {
    const items = makeItems()
    renderMenu({ items, activeIndex: 1 })
    const listbox = screen.getByRole('listbox')
    const activeId = listbox.getAttribute('aria-activedescendant')
    expect(activeId).toBe(`pagedown-slash-item-${items[1].id}`)
    expect(document.getElementById(activeId as string)).toHaveAttribute('aria-selected', 'true')

    const options = screen.getAllByRole('option')
    for (const option of options) {
      if (option.id !== activeId) {
        expect(option).toHaveAttribute('aria-selected', 'false')
      }
    }
  })
})

describe('SlashMenu interaction', () => {
  it('calls onChoose with the clicked item', async () => {
    const user = userEvent.setup()
    const { onChoose, items } = renderMenu()
    await user.click(screen.getByRole('option', { name: /Beta/ }))
    expect(onChoose).toHaveBeenCalledTimes(1)
    expect(onChoose).toHaveBeenCalledWith(items.find((item) => item.id === 'beta'))
  })

  it('calls onHover with the FLAT items-array index of the hovered option, not a section-local index', async () => {
    const user = userEvent.setup()
    const items = makeItems()
    const { onHover } = renderMenu({ items })
    // Gamma is items[0] despite rendering in the "Insert" section, which
    // renders AFTER "Text" -- proving onHover reports the real array index,
    // not DOM/section position.
    await user.hover(screen.getByRole('option', { name: /Gamma/ }))
    expect(onHover).toHaveBeenCalledWith(0)
  })

  it('never lets a mousedown steal focus from the editor', () => {
    // Load-bearing per slash-plugin.ts's own comment: without this, a click
    // anywhere in the palette moves DOM focus off the ProseMirror node
    // first, firing that plugin's own blur handler and closing the whole
    // session before this element's own onClick/onChoose ever runs.
    renderMenu()
    const listbox = screen.getByRole('listbox')
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    listbox.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})

// === IMPORTANT I1 regression, fix round 1 ===
// measureSelf used to be `useCallback(fn, [])` -- copied from
// SelectionBubble.tsx, whose OWN comment justifies that with "the button
// set is fixed". This palette's rendered list shrinks on every keystroke,
// so a `[]` dependency measured ONCE, on mount, and never again: a rerender
// down to a shorter list re-rendered the DOM but kept the STALE, larger
// size, so computeFloatingPosition kept placing the box as if it were still
// that tall. jsdom performs no real layout, so this needs a dynamic
// getBoundingClientRect stub -- one whose returned height reflects
// whatever is ACTUALLY in the DOM at the moment it's called, mirroring the
// coordinator's own probe technique (40px per rendered option).
describe('SlashMenu re-measurement (fix round 1, IMPORTANT I1)', () => {
  it('re-measures after the rendered item list shrinks, instead of keeping the mount-time size', () => {
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement): DOMRect {
        const optionCount = this.querySelectorAll('[role="option"]').length
        const height = optionCount * 40
        return {
          width: 200,
          height,
          top: 0,
          left: 0,
          right: 200,
          bottom: height,
          x: 0,
          y: 0,
          toJSON: () => ({})
        } as DOMRect
      })

    // ANCHOR sits close to SAFE's own top edge, so whether the palette fits
    // ABOVE it depends entirely on how tall the palette CURRENTLY measures
    // -- chosen so a stale vs. a correctly re-measured size produce two
    // DIFFERENT, directly observable `top` pixel values (not merely the
    // same placement nudged by a few px).
    const anchor: Rect = { left: 300, top: 100, right: 308, bottom: 118 }
    const safe: Rect = { left: 0, top: 0, right: 600, bottom: 600 }

    const { rerender } = renderMenu({ items: makeManyItems(5), anchor, safe })
    const listbox = screen.getByRole('listbox')
    // 5 items * 40px = 200px tall -- doesn't fit above a 100px-from-top
    // anchor (above = 100 - 8 - 200 = -108, well under safe.top + 8), so it
    // renders BELOW: top = anchor.bottom + gap = 118 + 8 = 126.
    expect(listbox.style.top).toBe('126px')

    rerender({ items: makeManyItems(1), anchor, safe })
    // A genuinely re-measured 1-item (40px) box DOES fit above now
    // (above = 100 - 8 - 40 = 52 >= 8), so a correct re-measurement flips
    // placement to 'above' at top: 52px. The stale-measurement bug this
    // test pins would leave `top` at the OLD 126px, computed against a
    // 200px height that no longer describes anything on screen.
    expect(listbox.style.top).toBe('52px')

    rectSpy.mockRestore()
  })
})

// === IMPORTANT I2 regression, fix round 1 ===
// Probe (coordinator): activeIndex 12 of 13 -> scrollIntoView called 0
// times. 13 items is roughly 600px of content inside a max-h-80 (320px)
// scroll box, so ArrowDown navigation past roughly the 6th item highlighted
// something the user could not see, with zero feedback anything had moved.
// Element.prototype.scrollIntoView is already polyfilled as a real,
// spy-able no-op by test-setup.ts (for jsdom's own long-standing gap), so
// this is directly observable without any extra stubbing.
describe('SlashMenu active-option scroll (fix round 1, IMPORTANT I2)', () => {
  it('scrolls a deep active option into view -- 13 items, activeIndex 12', () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView')
    renderMenu({ items: makeManyItems(13), activeIndex: 12 })
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })
    scrollSpy.mockRestore()
  })

  it('scrolls again when activeIndex moves via rerender, not only once on mount', () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView')
    const items = makeManyItems(13)
    const { rerender } = renderMenu({ items, activeIndex: 0 })
    scrollSpy.mockClear()
    rerender({ items, activeIndex: 12 })
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })
    scrollSpy.mockRestore()
  })

  it('does NOT scroll on a rerender where activeIndex genuinely did not change', () => {
    // Control for the test above: proves the scroll is tied to activeIndex
    // actually moving, not fired on every rerender regardless.
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView')
    const items = makeManyItems(13)
    const { rerender } = renderMenu({ items, activeIndex: 5 })
    scrollSpy.mockClear()
    rerender({ items, activeIndex: 5 })
    expect(scrollSpy).not.toHaveBeenCalled()
    scrollSpy.mockRestore()
  })
})
