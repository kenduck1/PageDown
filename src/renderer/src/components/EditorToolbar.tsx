import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react'
import { useAppStore, type ViewMode } from '../store/appStore'
import { useDocumentStore } from '../store/documentStore'
import type { MilkdownEditorHandle } from '../milkdown/MilkdownEditor'

// The formatting toolbar described in docs/design-handoff/README.md's
// "Editor — shared chrome" section, item 3. Mounted into EditorScreen.tsx
// (see that file's `<EditorToolbar editorRef={editorRef} ... />`) as of the
// Source Mode sub-project, which also wired the view-mode segmented control
// up to real mode-switching -- see this component's own `onSetViewMode` prop
// below and EditorScreen.tsx's `handleSetViewMode`.
//
// KNOWN CLAUDE.md DEVIATION, still outstanding: this component calls
// `window.api.exportPdf` and `useDocumentStore.setState` directly (see
// handleExportPdf below) rather than through a documentStore action, which
// CLAUDE.md's State Management section requires ("screen components should
// call its actions, never window.api directly"). `documentStore.ts` is not
// off-limits any longer (the concurrent track that once owned it finished
// long ago) -- this simply hasn't been cleaned up yet. Whoever picks this up
// should add a real `exportPdf` action to documentStore.ts and have this
// component call that instead.
export interface EditorToolbarProps {
  editorRef: RefObject<MilkdownEditorHandle | null>
  // Optional: when provided, mode-switch clicks call this INSTEAD of the
  // store's setViewMode action directly -- lets EditorScreen intercept the
  // transition to flush Milkdown's pending edit before entering Source
  // mode, or force a remount before leaving it (see EditorScreen's
  // handleSetViewMode and docs/superpowers/specs/2026-08-07-source-mode-design.md).
  // Falls back to calling the store action directly when omitted, so this
  // component's existing standalone tests (rendered with only `editorRef`)
  // keep passing unchanged.
  onSetViewMode?: (mode: ViewMode) => void
}

// All icon paths below are adapted from docs/design-handoff/PageDown.dc.html's
// own real prototype markup (searched for `<svg` there) rather than drawn
// from scratch, per this task's brief -- kept at the spec's own 24x24
// viewBox / stroke-based / no-fill convention (small deviations noted per
// icon below where the source material itself isn't a pure outline shape).
function Icon({
  children,
  strokeWidth = 1.75
}: {
  children: ReactElement | ReactElement[]
  strokeWidth?: number
}): ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function ChevronDownIcon(): ReactElement {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

function ToolbarDivider(): ReactElement {
  return <div className="mx-1 h-5 w-px flex-none bg-border-subtle" aria-hidden="true" />
}

interface ToolbarIconButtonProps {
  label: string
  onClick?: () => void
  // Only pass this for a genuinely toggleable button (Bold, Italic,
  // Underline, Bulleted/Numbered list, Checklist) -- its mere PRESENCE (not
  // just its value) controls whether `aria-pressed` is rendered at all.
  // Fix-round finding: every button previously rendered `aria-pressed`
  // (defaulting to `false`) regardless of whether it represented a toggle
  // state -- a screen reader announces `aria-pressed="false"` as "this is a
  // toggle button, currently off," which is actively misleading for a
  // one-shot action button (Undo, Insert table, Find, Insert page break,
  // ...) that isn't a toggle at all. One-shot buttons must omit this prop
  // entirely, not pass `active={false}`.
  active?: boolean
  disabled?: boolean
  children: ReactElement
}

// 30x30 hit target / 6px radius, per the mockup's own spec (README's
// "All toolbar icon buttons: 30x30px hit target, 6px radius" line).
function ToolbarIconButton({
  label,
  onClick,
  active,
  disabled = false,
  children
}: ToolbarIconButtonProps): ReactElement {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-[30px] w-[30px] flex-none items-center justify-center rounded-sm text-text-secondary transition-colors ${
        active ? 'bg-accent/14 text-accent' : 'hover:bg-chrome-light'
      } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
    >
      {children}
    </button>
  )
}

function EditorToolbar({ editorRef, onSetViewMode }: EditorToolbarProps): ReactElement {
  const viewMode = useAppStore((state) => state.viewMode)
  const setViewMode = useAppStore((state) => state.setViewMode)
  const openPageSetup = useAppStore((state) => state.openPageSetup)
  const content = useDocumentStore((state) => state.content)
  const filePath = useDocumentStore((state) => state.filePath)
  const [isExporting, setIsExporting] = useState(false)
  // Forces the paragraph-style <select> below to remount (fresh DOM node,
  // back to its uncontrolled default) after every use -- see
  // handleHeadingChange's own comment for why. Not a value store; only
  // ever incremented.
  const [headingSelectResetKey, setHeadingSelectResetKey] = useState(0)

  // Drives the scroll-fade indicators on the toolbar's horizontally
  // scrollable region (see the JSX below) -- a plain native scrollbar was
  // both visually heavy for a 45px-tall toolbar and gave no clear signal
  // that there was more content, let alone which direction.
  //
  // The right edge fades whenever there's more content to reach
  // (`canScrollRight`). The left edge is trickier: the sticky-positioned
  // left group (undo/redo + paragraph/font, below) permanently occupies
  // that space and must stay fully opaque -- it never disappears, so it
  // can't fade the way trailing content does. What DOES need a left-edge
  // fade is the plain scrollable content once it's scrolled partway under
  // that sticky group (`hasScrolledUnderSticky`, true once scrollLeft > 0):
  // it should fade out right at the sticky group's trailing edge, mirroring
  // the right-edge treatment instead of introducing a different technique
  // (an earlier box-shadow version was tried and reverted -- see git
  // history -- once it became clear a shadow reads as a visually distinct
  // affordance from the mask fade already used on the right, not "the same
  // fade," which is what was actually being asked for).
  //
  // Because the fade needs to start exactly where the sticky group's own
  // rendered width ends -- not a fixed pixel offset, since the paragraph-
  // style/font-family/font-size selects can render at different widths
  // depending on the current selection -- `stickyWidth` tracks that
  // element's real width via the same ResizeObserver used for scroll
  // dimensions, and toolbarMaskImage (below) builds the gradient stops
  // around it.
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef<HTMLDivElement>(null)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const [hasScrolledUnderSticky, setHasScrolledUnderSticky] = useState(false)
  const [stickyWidth, setStickyWidth] = useState(0)
  const [containerWidth, setContainerWidth] = useState(0)

  useEffect(() => {
    const el = scrollRef.current
    const stickyEl = stickyRef.current
    if (!el || !stickyEl) return

    const updateScrollState = (): void => {
      // A 1px tolerance -- some browsers report a fractional scrollLeft
      // that never quite reaches the exact scrollWidth - clientWidth
      // value at the true end, which would otherwise leave the indicator
      // visible forever even when fully scrolled.
      setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1)
      setHasScrolledUnderSticky(el.scrollLeft > 0)
      // Both measured via getBoundingClientRect so they land in the same
      // coordinate space -- see toolbarMaskImage below for why mixing this
      // with a percentage-based stop (e.g. `calc(100% - 36px)`) is exactly
      // the bug that shipped and had to be reverted here.
      setStickyWidth(stickyEl.getBoundingClientRect().width)
      setContainerWidth(el.getBoundingClientRect().width)
    }

    updateScrollState()
    el.addEventListener('scroll', updateScrollState)
    const resizeObserver = new ResizeObserver(updateScrollState)
    resizeObserver.observe(el)
    resizeObserver.observe(stickyEl)

    return () => {
      el.removeEventListener('scroll', updateScrollState)
      resizeObserver.disconnect()
    }
  }, [])

  // The fade distance (in px) each edge ramps from fully transparent to
  // fully opaque over. Shared by both edges so the two fades feel like the
  // same effect rather than two coincidentally similar ones.
  const TOOLBAR_FADE_PX = 36

  // Builds the combined mask-image gradient for the scrollable region.
  // Both edges are expressed as stops on ONE gradient (rather than two
  // separate mask layers) because mask coordinates are relative to the
  // element's own box, which is exactly what lets the sticky group's
  // region (0 to stickyWidth) stay pinned at fully opaque regardless of
  // scroll position -- the sticky element is visually anchored to that
  // same box via `position: sticky`, so the two coordinate spaces always
  // line up. Returns undefined (no mask at all) when neither edge has
  // anything to hide, matching the toolbar's un-faded default state.
  //
  // EVERY stop is an absolute px value derived from containerWidth, never
  // a `calc(100% - Npx)` percentage. A shipped version mixed the two: at
  // any narrow width where the sticky group's own natural width exceeds
  // the visible scrollable box (verified with a real build -- e.g. 385px
  // of sticky content inside a 159px-wide visible window), the percentage
  // stop resolved to a pixel position BEFORE the preceding absolute-px
  // stop. A CSS gradient clamps an out-of-order stop forward to match the
  // one before it, which collapsed the entire gradient to solid opaque --
  // no fade anywhere, on either edge. Math.max below reproduces that same
  // clamp deliberately, in JS, so it's a visible, intentional guard against
  // the sticky group outgrowing the container rather than a silent CSS
  // fallback: once stickyWidth alone consumes the whole visible box, both
  // fade zones collapse to zero width and simply don't render, rather than
  // producing an inverted/broken gradient.
  const toolbarMaskImage = (() => {
    if (!hasScrolledUnderSticky && !canScrollRight) return undefined
    const leftFadeStart = stickyWidth
    const leftFadeEnd = Math.max(leftFadeStart, stickyWidth + TOOLBAR_FADE_PX)
    const rightFadeStart = Math.max(leftFadeEnd, containerWidth - TOOLBAR_FADE_PX)
    const rightFadeEnd = Math.max(rightFadeStart, containerWidth)

    const stops = ['black 0px', `black ${leftFadeStart}px`]
    if (hasScrolledUnderSticky) {
      stops.push(`transparent ${leftFadeStart}px`, `black ${leftFadeEnd}px`)
    }
    if (canScrollRight) {
      stops.push(`black ${rightFadeStart}px`, `transparent ${rightFadeEnd}px`)
    }
    return `linear-gradient(to right, ${stops.join(', ')})`
  })()

  const handleHeadingChange = (value: string): void => {
    // Fix-round finding: this dropdown has no live selection-state tracking
    // (a separate, larger "bubble menu / active formatting state" feature,
    // out of scope here -- see this component's own module comment), so it
    // cannot be a CONTROLLED indicator of the cursor's live heading level --
    // it's a stateless action trigger instead. Bumping this key forces
    // React to remount the <select> with a fresh DOM node (back to its
    // uncontrolled "Normal text" default) after every selection. Without
    // this, a real browser fires no `change` event when the same option is
    // selected twice in a row with no other selection in between (e.g.
    // Heading 2 on one block, then Heading 2 again on a DIFFERENT block) --
    // the <select>'s displayed value hasn't changed from the browser's own
    // point of view, so the second click silently did nothing (verified;
    // the test environment's own `userEvent.selectOptions` does NOT
    // reproduce this, since it dispatches a change event unconditionally,
    // unlike a real browser).
    setHeadingSelectResetKey((k) => k + 1)
    if (value === 'paragraph') {
      // setParagraph() converts unconditionally, regardless of the current
      // block's heading level -- no live-state knowledge is needed for
      // this, unlike an earlier, incorrect version of this comment claimed.
      editorRef.current?.setParagraph()
      return
    }
    editorRef.current?.toggleHeading(Number(value) as 1 | 2 | 3)
  }

  const handleInsertLink = (): void => {
    const href = window.prompt('Link URL')
    if (href) editorRef.current?.insertLink(href)
  }

  const handleExportPdf = async (): Promise<void> => {
    if (isExporting) return
    setIsExporting(true)
    try {
      // filePath is what resolves local image references in the exported
      // PDF against the document's own directory (src/main/pdf-exporter.ts)
      // -- omitting it (an unsaved document) correctly denies all local
      // assets, matching usePageCount's own filePath forwarding.
      await window.api.exportPdf(content, filePath)
      // Deliberately does NOT touch documentStore.error on success. An
      // earlier version cleared it unconditionally here (`setState({ error:
      // null })`), which silently discarded any unrelated, pre-existing
      // error message that had nothing to do with this export (fix-round
      // review finding) -- e.g. a failed Save from moments earlier would
      // vanish from the error banner the instant an unrelated export
      // succeeded.
    } catch (err) {
      // Log the real error for diagnosis, but don't put a raw IPC error
      // string in front of the user (fix-round review finding) -- Electron
      // wraps a thrown main-process error as something like `Error invoking
      // remote method 'file:exportPdf': Error: <original message>`, which
      // is not a message a user should have to parse.
      console.error('Failed to export PDF', err)
      useDocumentStore.setState({ error: 'Failed to export PDF. Please try again.' })
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <div
      className="flex flex-none flex-nowrap items-center gap-x-3.5 border-b border-border-subtle bg-page px-3.5 py-1.5"
      role="toolbar"
      aria-label="Formatting toolbar"
    >
      {/* Everything except the right-aligned cluster lives in ONE scrollable
          region -- Undo/Redo through Find all scroll together as far as the
          browser is concerned. The "stay visible" behavior for Undo/Redo +
          paragraph-style/font/size is achieved with `sticky left-0` (below),
          NOT by splitting them into a second, separately-reserved flex-none
          group: two independently-reserved flex-none groups (this one AND
          the right cluster) have no shared mechanism to give way to each
          other, so at a narrow enough width their combined minimum size can
          exceed the toolbar's own width with nothing left to shrink --
          verified this the hard way (Export PDF's own bounding box stayed
          pinned past the visible edge, entirely unreachable, once the
          window got narrow enough that both fixed groups no longer fit
          together). `sticky` composes correctly instead: it visually stays
          pinned to the scrollable region's own left edge for as long as
          there's room, and only when truly out of room does it start
          scrolling away WITH the rest of the region -- the right cluster
          (still genuinely flex-none, outside this scrollable region
          entirely) is what actually keeps its unconditional guarantee.
          min-w-0 is load-bearing on a flex child -- without it this div
          refuses to shrink below its content's natural width and
          overflow-x-auto never actually engages.

          The native scrollbar is hidden (scrollbar-hide, base.css) in favor
          of a mask-image fade on the scrollable element itself: a visible
          scrollbar track was both heavy for a 45px toolbar and gave no
          clear signal of which direction had more content. Both edges use
          the same fade technique -- see toolbarMaskImage above for how the
          two edges combine into one gradient, and why the left one only
          fades the plain content, never the sticky group itself.

          Approaches tried and rejected before landing here, in order: (1) a
          separate overlay div with a background-color gradient FROM the
          toolbar's own bg-page (white) TO transparent -- had essentially
          zero visible contrast against that same white toolbar background
          (confirmed by screenshotting it, not assumed); (2) an inset
          box-shadow on the trailing edge -- fixed the contrast problem, but
          at any strength that was actually visible it read as a distinct
          rectangular shape/seam rather than a soft fade (also confirmed
          visually); (3) a drop-shadow cast by the sticky left group instead
          of a matching fade -- worked, but reads as a visually different
          affordance from the right edge's fade, when the actual ask was
          for the SAME treatment on both sides. mask-image is the
          technically correct tool: rather than drawing a shape ON TOP of
          the content, it gradually reduces the CONTENT's own opacity as it
          nears an edge -- there is no shape to see, only the real
          icons/text genuinely fading out. Needs both the standard and
          -webkit- prefixed properties (Chromium, which this app always
          runs under via Electron, still requires the prefixed form for
          `mask-image`). TOOLBAR_FADE_PX (36, shortened from an initial 48
          per feedback) compresses the same transparent-to-opaque range
          into less horizontal space, so it reads as a bit more present
          without turning into a hard edge. */}
      <div className="relative min-w-0 flex-1">
        <div
          ref={scrollRef}
          className="scrollbar-hide flex items-center gap-x-2.5 overflow-x-auto"
          style={
            toolbarMaskImage
              ? { WebkitMaskImage: toolbarMaskImage, maskImage: toolbarMaskImage }
              : undefined
          }
        >
          {/* Sticky left group: undo/redo + paragraph-style/font/size. z-10
              so it paints above the content scrolling underneath it; bg-page
              (opaque, matching the toolbar's own background) so that
              underlying content is genuinely occluded rather than showing
              through. flex-none so this group itself is never the thing
              that shrinks -- if anything has to give at extreme widths, it's
              the plain formatting controls after it, not this. Always fully
              opaque -- toolbarMaskImage's gradient stays black (unmasked)
              across this group's own width (tracked via stickyRef), so it
              never fades regardless of scroll position. */}
          <div
            ref={stickyRef}
            className="sticky left-0 z-10 flex flex-none items-center gap-x-2.5 bg-page"
          >
            {/* Undo / redo */}
            <div className="flex items-center gap-0.5">
              <ToolbarIconButton label="Undo" onClick={() => editorRef.current?.undo()}>
                <Icon strokeWidth={1.8}>
                  <path d="M7 7 3 11l4 4" />
                  <path d="M3 11h11.5A5.5 5.5 0 0 1 20 16.5v0" />
                </Icon>
              </ToolbarIconButton>
              <ToolbarIconButton label="Redo" onClick={() => editorRef.current?.redo()}>
                <Icon strokeWidth={1.8}>
                  <path d="M17 7l4 4-4 4" />
                  <path d="M21 11H9.5A5.5 5.5 0 0 0 4 16.5v0" />
                </Icon>
              </ToolbarIconButton>
            </div>

            <ToolbarDivider />

            {/* Paragraph style / font family / font size. Font family and
              font size have no backing MilkdownEditorHandle command (this
              sub-project's brief scopes editing commands to bold/italic/
              heading/lists/link/table/pagebreak/undo/redo only) -- both
              selects below are real, interactive, native <select> elements,
              but intentionally unwired, matching the same "present but
              inert" treatment as the Find button. */}
            <div className="flex items-center gap-2">
              <div className="relative flex h-[30px] items-center">
                <select
                  key={headingSelectResetKey}
                  aria-label="Paragraph style"
                  className="h-full appearance-none rounded-sm bg-transparent pl-2.5 pr-6 text-12-5 text-text-primary hover:bg-chrome-light"
                  defaultValue="paragraph"
                  onChange={(e) => handleHeadingChange(e.target.value)}
                >
                  <option value="paragraph">Normal text</option>
                  <option value="1">Heading 1</option>
                  <option value="2">Heading 2</option>
                  <option value="3">Heading 3</option>
                </select>
                <span className="pointer-events-none absolute right-2 text-text-tertiary">
                  <ChevronDownIcon />
                </span>
              </div>
              <div className="relative flex h-[30px] items-center">
                <select
                  aria-label="Font family"
                  className="h-full appearance-none rounded-sm bg-transparent pl-2.5 pr-6 font-serif text-12-5 text-text-primary hover:bg-chrome-light"
                  defaultValue="Source Serif 4"
                >
                  <option value="Source Serif 4">Source Serif 4</option>
                  <option value="Sans">Sans</option>
                </select>
                <span className="pointer-events-none absolute right-2 text-text-tertiary">
                  <ChevronDownIcon />
                </span>
              </div>
              <div className="relative flex h-[30px] items-center">
                <select
                  aria-label="Font size"
                  className="h-full appearance-none rounded-sm bg-transparent pl-2 pr-5 text-12-5 text-text-primary hover:bg-chrome-light"
                  defaultValue="11"
                >
                  {['9', '10', '11', '12', '14', '16', '18'].map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
                <span className="pointer-events-none absolute right-1.5 text-text-tertiary">
                  <ChevronDownIcon />
                </span>
              </div>
            </div>

            <ToolbarDivider />
          </div>

          {/* Bold / Italic / Underline / text color. Underline and text-color
          have no backing command -- Markdown has no native underline
          syntax, and this sub-project's brief doesn't scope a color-mark
          command -- so both stay real, present, but unwired buttons. */}
          <div className="flex items-center gap-0.5">
            <ToolbarIconButton
              label="Bold"
              active={false}
              onClick={() => editorRef.current?.toggleBold()}
            >
              <span className="text-14 font-bold leading-none">B</span>
            </ToolbarIconButton>
            <ToolbarIconButton
              label="Italic"
              active={false}
              onClick={() => editorRef.current?.toggleItalic()}
            >
              <span className="text-14 italic leading-none">I</span>
            </ToolbarIconButton>
            <ToolbarIconButton label="Underline" active={false}>
              <span className="text-14 leading-none underline">U</span>
            </ToolbarIconButton>
            <ToolbarIconButton label="Text color">
              <span className="flex flex-col items-center gap-px">
                <span className="text-13 leading-none">A</span>
                <span className="h-[2.5px] w-3.5 rounded-full bg-accent" />
              </span>
            </ToolbarIconButton>
          </div>

          <ToolbarDivider />

          {/* Bullet / numbered / checkbox list -- the mockup renders these as
          three plain icon buttons side by side (verified against
          PageDown.dc.html's own markup: no chevron/dropdown panel actually
          exists for this group, despite the README's prose calling it a
          "dropdown group"), so that's what's built here. Checkbox list has
          no backing command (GFM task-list items aren't in this
          sub-project's command scope) and stays unwired. */}
          <div className="flex items-center gap-0.5">
            <ToolbarIconButton
              label="Bulleted list"
              active={false}
              onClick={() => editorRef.current?.toggleBulletList()}
            >
              <Icon strokeWidth={1.7}>
                <circle cx="4.5" cy="7" r="1.3" fill="currentColor" stroke="none" />
                <path d="M9 7h11" />
                <circle cx="4.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
                <path d="M9 12h11" />
                <circle cx="4.5" cy="17" r="1.3" fill="currentColor" stroke="none" />
                <path d="M9 17h11" />
              </Icon>
            </ToolbarIconButton>
            <ToolbarIconButton
              label="Numbered list"
              active={false}
              onClick={() => editorRef.current?.toggleOrderedList()}
            >
              <Icon strokeWidth={1.7}>
                <text x="2" y="8.5" fontSize="7" stroke="none" fill="currentColor">
                  1
                </text>
                <path d="M9 7h11" />
                <text x="2" y="13.5" fontSize="7" stroke="none" fill="currentColor">
                  2
                </text>
                <path d="M9 12h11" />
                <text x="2" y="18.5" fontSize="7" stroke="none" fill="currentColor">
                  3
                </text>
                <path d="M9 17h11" />
              </Icon>
            </ToolbarIconButton>
            <ToolbarIconButton label="Checklist" active={false}>
              <svg
                width="15"
                height="15"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="2" y="2" width="10" height="10" rx="2" />
                <path d="M4.3 7.3l1.8 1.8L10 5.8" />
              </svg>
            </ToolbarIconButton>
          </div>

          <ToolbarDivider />

          {/* Link / image / table / split-cell / page-break. Image and
          split-cell have no backing command in this sub-project's scope and
          stay unwired, same treatment as Underline/text-color above. */}
          <div className="flex items-center gap-0.5">
            <ToolbarIconButton label="Insert link" onClick={handleInsertLink}>
              <Icon strokeWidth={1.8}>
                <path d="M9.5 14.5 14.5 9.5" />
                <path d="M11 7.5l1-1a3.5 3.5 0 0 1 5 5l-1 1" />
                <path d="M13 16.5l-1 1a3.5 3.5 0 0 1-5-5l1-1" />
              </Icon>
            </ToolbarIconButton>
            <ToolbarIconButton label="Insert image">
              <Icon strokeWidth={1.7}>
                <rect x="3.5" y="5" width="17" height="14" rx="2" />
                <circle cx="9" cy="10" r="1.4" />
                <path d="M4 16.5 9 12a2 2 0 0 1 2.7 0l5.3 4.7" />
              </Icon>
            </ToolbarIconButton>
            <ToolbarIconButton
              label="Insert table"
              onClick={() => editorRef.current?.insertTable()}
            >
              <Icon strokeWidth={1.7}>
                <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
                <path d="M3.5 10.3h17" />
                <path d="M3.5 15.6h17" />
                <path d="M10 5v14" />
              </Icon>
            </ToolbarIconButton>
            <ToolbarIconButton label="Split cell">
              <Icon strokeWidth={1.7}>
                <rect x="3.5" y="4" width="7" height="5" rx="1" />
                <rect x="13.5" y="15" width="7" height="5" rx="1" />
                <path d="M7 9v3a2 2 0 0 0 2 2h1.5" />
                <path d="M14.5 14h-1a2 2 0 0 1-2-2v0" />
              </Icon>
            </ToolbarIconButton>
            <ToolbarIconButton
              label="Insert page break"
              onClick={() => editorRef.current?.insertPageBreak()}
            >
              <Icon strokeWidth={1.7}>
                <rect x="5" y="3" width="14" height="18" rx="1.5" />
                <path d="M6.5 12h3M14.5 12h3" />
                <path d="M11 10.3v3.4" />
              </Icon>
            </ToolbarIconButton>
          </div>

          {/* Find -- per docs/design-handoff/README.md's own "Not yet designed"
          list: "a search icon exists in the toolbar as a placeholder
          trigger only" (no find/replace panel exists to open). Deliberately
          unwired, matching the design handoff's own explicit call-out. */}
          <ToolbarIconButton label="Find">
            <Icon strokeWidth={1.8}>
              <circle cx="10.5" cy="10.5" r="6" />
              <path d="M19 19l-4.3-4.3" />
            </Icon>
          </ToolbarIconButton>
        </div>
      </div>

      {/* Right-aligned cluster: view-mode segmented control, page setup,
          Export PDF. flex-none (not just the implicit default) so it never
          shrinks or scrolls, regardless of how narrow the window gets --
          the scrollable region above absorbs all the squeeze instead. */}
      <div className="flex flex-none items-center gap-3.5">
        <div className="flex items-center gap-0.5 rounded-md bg-chrome-dark p-0.5">
          {(
            [
              {
                mode: 'format' as const,
                label: 'Format',
                icon: (
                  <Icon strokeWidth={1.6}>
                    <rect x="6" y="3.5" width="12" height="17" rx="1.5" />
                    <path d="M8.7 8h6.6M8.7 11h6.6M8.7 14h4" />
                  </Icon>
                )
              },
              {
                mode: 'split' as const,
                label: 'Split',
                icon: (
                  <Icon strokeWidth={1.6}>
                    <rect x="4" y="4.5" width="16" height="15" rx="1.5" />
                    <path d="M12 4.5v15" />
                  </Icon>
                )
              },
              {
                mode: 'source' as const,
                label: 'Source',
                icon: (
                  <Icon strokeWidth={1.7}>
                    <path d="M9 8.5 5.5 12 9 15.5" />
                    <path d="M15 8.5 18.5 12 15 15.5" />
                  </Icon>
                )
              }
            ] as const
          ).map(({ mode, label, icon }) => (
            <button
              key={mode}
              type="button"
              aria-pressed={viewMode === mode}
              onClick={() => (onSetViewMode ? onSetViewMode(mode) : setViewMode(mode))}
              className={`flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-12-5 ${
                viewMode === mode
                  ? 'bg-page text-text-primary shadow-flat'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>

        <ToolbarIconButton label="Page setup" onClick={openPageSetup}>
          <Icon strokeWidth={1.6}>
            <rect x="5" y="3" width="14" height="18" rx="1.5" />
            <rect x="7.5" y="6" width="9" height="12" rx="0.5" strokeDasharray="1.8 1.8" />
          </Icon>
        </ToolbarIconButton>

        <button
          type="button"
          onClick={() => void handleExportPdf()}
          disabled={isExporting}
          className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3.5 text-12-5 font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Icon strokeWidth={1.9}>
            <path d="M12 3.5v11" />
            <path d="M8 11l4 4 4-4" />
            <path d="M5 18.5h14" />
          </Icon>
          {isExporting ? 'Exporting…' : 'Export PDF'}
        </button>
      </div>
    </div>
  )
}

export default EditorToolbar
