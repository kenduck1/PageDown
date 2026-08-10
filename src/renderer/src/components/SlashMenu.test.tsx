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

interface RenderOptions {
  items?: SlashItem[]
  activeIndex?: number
  anchor?: Rect | null
  safe?: Rect | null
  onChoose?: (item: SlashItem) => void
  onHover?: (index: number) => void
}

function renderMenu(options: RenderOptions = {}): {
  items: SlashItem[]
  onChoose: (item: SlashItem) => void
  onHover: (index: number) => void
} {
  const items = options.items ?? makeItems()
  const onChoose = options.onChoose ?? vi.fn()
  const onHover = options.onHover ?? vi.fn()
  render(
    <SlashMenu
      items={items}
      activeIndex={options.activeIndex ?? 0}
      anchor={options.anchor === undefined ? ANCHOR : options.anchor}
      safe={options.safe === undefined ? SAFE : options.safe}
      onChoose={onChoose}
      onHover={onHover}
    />
  )
  return { items, onChoose, onHover }
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
