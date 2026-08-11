import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react'
import { useAppStore, type ViewMode } from '../store/appStore'
import { useDocumentStore } from '../store/documentStore'
import { useFindStore } from '../store/findStore'
import { isSourceEditing } from '../lib/editing-surface'
import { shouldPinToolbarGroup } from '../lib/toolbar-layout'
import Toast from './Toast'
import type { MilkdownEditorHandle } from '../milkdown/MilkdownEditor'
import type { SelectionSnapshot } from '../milkdown/selection-plugin'

// The formatting toolbar described in docs/design-handoff/README.md's
// "Editor — shared chrome" section, item 3. Mounted into EditorScreen.tsx
// (see that file's `<EditorToolbar editorRef={editorRef} ... />`) as of the
// Source Mode sub-project, which also wired the view-mode segmented control
// up to real mode-switching -- see this component's own `onSetViewMode` prop
// below and EditorScreen.tsx's `handleSetViewMode`.
//
// The CLAUDE.md deviation this comment used to record -- "calls
// `window.api.exportPdf` and `useDocumentStore.setState` directly rather than
// through a documentStore action" -- is CLOSED as of the application-menu
// sub-project, in exactly the way it prescribed: `exportPdf`/`print` are real
// documentStore actions now, and this component calls them. That was not
// merely overdue tidying; the menu gave each operation a SECOND trigger
// (File > Export as PDF / Print), and an in-flight guard living in this
// component's own useState could not have stopped a double-run started from
// the menu.
//
// ==========================================================================
// THIS TOOLBAR IS ONE ROW, AND STAYING ONE ROW IS A REQUIREMENT
// ==========================================================================
// Measured in the real built app at the shipped 1000x840 default
// (src/main/window-bounds.ts), the toolbar was 81px tall -- two rows -- and
// only collapsed to one at about 1436px. In a page-first editor, 36px of
// permanent vertical chrome is expensive, and the wrap was a fix for a
// DIFFERENT defect: at the same window size the formatting region had only
// 407px of visible width (189px in Split) for 843px of content, while the
// opaque `sticky left-0` leading group alone was 420.5px -- wider than the
// region it was pinned inside, so it covered that region at EVERY scroll
// position and eleven controls were unreachable by any means.
//
// Both constraints are real, and wrapping traded one for the other. The fix
// is to make the content genuinely FIT instead. Measured in the real built
// app after this pass, at 1000x840: toolbar height 45px (was 81), formatting
// region 691px visible for 691px of content -- maxScroll 0 -- in BOTH Format
// and Split, with all 15 controls hit-testable and every one of them on a
// single offsetTop band. At the app's own 760px minimum it is still 45px,
// with 451px visible for 635px of content, and all 15 still reachable by
// scrolling. shouldPinToolbarGroup (lib/toolbar-layout.ts)
// is kept unchanged as the structural backstop for the narrow widths that do
// still scroll (the app's own 760px minimum), where it un-pins the leading
// group rather than letting it occlude anything.
//
// THE RULE FOR REMOVING A CONTROL FROM THIS TOOLBAR: it may go only if it is
// genuinely reachable another way -- an application-menu item, ideally with
// an accelerator. A control whose only home is this toolbar must stay. What
// left, and where each one lives now:
//
//   Font family / Font size selects (208px)  -> PageSetupModal's Typography
//       section. These were never selection formatting: both write
//       PageConfig fields into the document's own YAML frontmatter, i.e.
//       they are document-wide settings, and PageSetupModal is the
//       PageConfig editor. Also File > Page Setup… (Cmd+Shift+P).
//   Print (44px)                             -> File > Print… (Cmd+P).
//   Export as HTML (44px)                    -> File > Export as HTML…
//       (Cmd+Alt+E), a menu item this pass added.
//   Keyboard shortcuts (44px)                -> Help > Keyboard Shortcuts
//       (Cmd+/), which is already ungated on documentOpen.
//   Split left pane Format/Source (142.7px)  -> View > Split Left Pane
//       (a real radio pair), Split-mode only.
//   Follow (75.5px)                          -> View > Follow Preview Scroll
//       (a real checkbox), Split-mode only.
//
// Two controls were narrowed rather than removed: the view-mode segmented
// control dropped its three icons (66px) but kept every label, and Export PDF
// became an icon-only accent button (86px) -- it keeps the accent fill, so it
// is still the visually dominant control, and it is the one action here with
// a real accelerator (Cmd+Shift+E) and a File-menu twin.
//
// WHAT WAS RULED OUT:
//   - Widening the default window. Not available: Gate 28/29 assert their
//     floating-surface clamps are BINDING, and those assertions go vacuous
//     above ~1050px (window-bounds.ts records the measured crossover).
//   - An overflow "…" popup. The occlusion objection alone is NO LONGER
//     decisive and should not be quoted as if it were -- lib/floating-
//     position.ts already clamps the selection bubble and the slash palette
//     out of the Split preview's column, so the machinery exists. It is ruled
//     out on better grounds: a FIXED overflow set is strictly worse than the
//     application menu, which already exists, already carries accelerators,
//     and is where people look for Print/Export; a DYNAMIC one needs
//     per-render measurement of every control (see how much care
//     shouldPinToolbarGroup's single measured rule already takes); and in
//     Split mode the clamp would land the popup on the far side of the window
//     from the button that opened it.
//   - Icon-only mode switching. 135px, and the cheapest of all -- rejected
//     because Format/Split/Source is the app's primary mode affordance and
//     three abstract glyphs do not name it.
//   - Dropping Undo/Redo (91px) or Find (40px). Both are one-click controls a
//     mouse-first user reaches for constantly, unlike the Split-only pills
//     and the once-per-session export actions that went instead.
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
  // The font-family and font-size selects that used to be configured through
  // this component (onSetFontFamily / onSetFontSize) are GONE from the
  // toolbar -- see this file's header. They are PageConfig fields, so they now
  // live in PageSetupModal's Typography section and reach the document
  // through the single `onApply` path every other page setting already uses;
  // EditorScreen no longer needs a second, parallel frontmatter writer for
  // them.
  // The live selection/formatting state from milkdown/selection-plugin.ts,
  // threaded through EditorScreen. Optional and defaulting to null, so this
  // component's own standalone tests (which render it with only `editorRef`)
  // keep working and simply see everything inactive -- the same optional-prop
  // convention onSetViewMode/onSetFontFamily above already use.
  //
  // This is what makes Bold/Italic/list buttons report a REAL pressed state
  // instead of the hardcoded `active={false}` they carried until the bubble
  // menu sub-project built the plugin that can answer the question. Null (no
  // live editor, e.g. Source mode) is genuinely "unknown", and rendering
  // everything unpressed is the honest reading of that -- the same buttons are
  // already disabled there anyway.
  selection?: SelectionSnapshot | null
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

function EditorToolbar({
  editorRef,
  onSetViewMode,
  selection = null
}: EditorToolbarProps): ReactElement {
  const viewMode = useAppStore((state) => state.viewMode)
  const setViewMode = useAppStore((state) => state.setViewMode)
  const splitLeftMode = useAppStore((state) => state.splitLeftMode)
  const openPageSetup = useAppStore((state) => state.openPageSetup)
  const openCommentComposer = useAppStore((state) => state.openCommentComposer)
  const openLinkComposer = useAppStore((state) => state.openLinkComposer)
  // F2 (final whole-branch review): every control below bound to
  // editorRef.current?.X() no-ops in Source mode, because MilkdownEditor is
  // unmounted there and editorRef.current is null -- but before this guard
  // they still rendered fully enabled, with no visual signal that clicking
  // them did nothing. Disabling exactly the editorRef-bound cluster
  // (undo/redo, paragraph style, bold/italic, both list buttons, checklist,
  // link, image, table, page break -- Insert image included, since its
  // hidden file input's onChange calls editorRef.current?.insertImages)
  // removes a dead control rather than a capability -- Undo/Redo in
  // particular: a plain <textarea> has real browser-native undo/redo of its
  // own, so disabling THIS toolbar's Undo/Redo buttons doesn't remove undo
  // capability in Source mode, just the redundant/dead duplicate control.
  // Everything else -- the view-mode switcher and Export PDF, neither of
  // which ever touched editorRef, and the now-wired Find button -- is
  // independent of the Milkdown instance and stays enabled. Find in
  // particular MUST stay enabled in Source mode -- it works on both editing
  // surfaces (see useFindController.ts), so disabling it here would remove a
  // real capability rather than a dead control.
  // Uses the shared isSourceEditing predicate, NOT a bare
  // `viewMode === 'source'` — that was a real bug, found while fixing Insert
  // link. Split mode's LEFT PANE is Format or Source editing per
  // splitLeftMode, so with viewMode 'split' and splitLeftMode 'source' the
  // MilkdownEditor is genuinely unmounted (EditorScreen's own left-pane
  // ternary swaps element types) and `editorRef.current` is therefore null —
  // yet every editorRef-bound control above rendered ENABLED and silently did
  // nothing when clicked. `lib/editing-surface.ts` exists precisely because
  // "which editing surface is live" cannot be answered from viewMode alone;
  // this was the one place still trying to.
  const isSourceMode = isSourceEditing(viewMode, splitLeftMode)
  const findOpen = useFindStore((state) => state.isOpen)
  const openFind = useFindStore((state) => state.openFind)
  const closeFind = useFindStore((state) => state.closeFind)
  // Both the flags and the actions now come from the store -- see this
  // component's own header comment, and documentStore's isExporting field,
  // for why a component-local useState guard stopped being sufficient.
  // Only the PDF pair is read here now: Print and Export-as-HTML lost their
  // toolbar buttons and are driven exclusively from the File menu, whose
  // handlers (EditorScreen's useMenuCommands) call the same store actions --
  // so their in-flight guards are unchanged, they simply have one trigger
  // instead of two.
  const isExporting = useDocumentStore((state) => state.isExporting)
  const exportPdf = useDocumentStore((state) => state.exportPdf)
  // Product-completeness audit 2.3: "Export gives no feedback." exportNotice
  // is store state (not this component's own useState) specifically because
  // export has TWO independent triggers -- this toolbar's own buttons, and
  // the File menu's Cmd+Shift+E accelerator (EditorScreen's useMenuCommands
  // calls documentStore's exportPdf/exportHtml directly) -- only the store
  // sees both, so rendering the Toast from whatever the store reports is
  // what makes it fire regardless of which one the user actually used.
  const exportNotice = useDocumentStore((state) => state.exportNotice)
  const clearExportNotice = useDocumentStore((state) => state.clearExportNotice)
  // A real, hidden <input type="file">, clicked programmatically by the
  // "Insert image" button. Chromium opens the genuine OS picker for it, which
  // is why this feature needed NO new main-process IPC handler at all -- worth
  // stating explicitly, because reaching for `dialog.showOpenDialog` would
  // have meant touching src/main/index.ts and inventing a second
  // path-validation story next to the isKnownPath rule. A File object from
  // this input is indistinguishable from one in a DataTransfer, so it feeds
  // the identical documentStore.saveDroppedImage path drag-and-drop uses.
  const imageInputRef = useRef<HTMLInputElement>(null)
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

  // Whether the leading group may stay pinned at all -- see
  // lib/toolbar-layout.ts for the measured bug this guards against (a 420.5px
  // pinned group inside a 407px visible region occluded eleven controls at
  // every scroll position). Unmeasured (0/0, i.e. first render and every jsdom
  // test) keeps the pinned default.
  const stickyPinned = shouldPinToolbarGroup(stickyWidth, containerWidth)

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
    // 0 when the group is NOT pinned: it then scrolls away with everything
    // else, so there is no permanently-opaque region to protect and the left
    // fade belongs at the region's own edge, exactly like the right one.
    const leftFadeStart = stickyPinned ? stickyWidth : 0
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
    // This dropdown stays a stateless ACTION TRIGGER rather than a controlled
    // indicator of the cursor's live heading level -- and as of the bubble
    // menu sub-project that is a deliberate choice rather than the missing
    // capability it used to be. The live state now exists (`selection` above;
    // the bubble's own H1/H2/H3 buttons genuinely light up from it), and the
    // mark buttons below consume it -- but binding it to this <select>'s
    // `value` is a real behaviour change, not a cosmetic one, and it is
    // deliberately not made here:
    //   - `selection` is null whenever there is no live Milkdown instance, and
    //     a controlled value would then fall back to "Normal text" while the
    //     cursor's block is genuinely an H1 -- picking "Normal text" in that
    //     state fires no change event at all (same browser behaviour as
    //     below), so the one option a user reaches for to UNDO a heading
    //     becomes the one that silently does nothing.
    //   - it turns an action control into a state control, which interacts
    //     with toggleHeading's own toggle-off-to-paragraph branch: selecting
    //     the already-selected level would become unreachable rather than
    //     reverting the block.
    // Bumping this key forces
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

  // Export/Print's own logic (filePath forwarding for local-asset
  // resolution, the in-flight guard, friendly-not-raw error text, treating a
  // cancelled print dialog as a non-failure) all moved into documentStore's
  // exportPdf/print actions verbatim -- see this component's header comment.
  // The buttons below call them directly.

  // Product-completeness audit 2.3: the export success Toast, and the
  // "Show in Folder" action it carries. Reveals via window.api.showItemInFolder
  // -- validated on the MAIN process side against a small remembered set of
  // paths this app itself just exported to (see that handler's own comment
  // in src/main/index.ts), never a blind pass-through of a renderer-supplied
  // path. Dismisses the notice immediately on click, same as letting the
  // timer expire -- there is nothing more THIS toast has to offer once its
  // one action has been taken, win or lose.
  //
  // Second-pass product-completeness audit Tier 3: the reveal used to be
  // truly fire-and-forget (a bare `void`, result discarded), so a
  // since-moved-or-deleted export dismissed the toast and did nothing else
  // visible anywhere -- shell.showItemInFolder is a silent no-op on a
  // vanished path, so "nothing happened" was the only signal a user ever
  // got. The main-process handler now stat()s before revealing and resolves
  // `false` on a genuine failure (see its own comment); surfaced here
  // through the SAME error banner every other real failure in this app
  // uses (documentStore's `error`, rendered by EditorScreen -- e.g.
  // MilkdownEditor's onError callback sets it the identical direct way),
  // rather than inventing a second notice mechanism for one more failure
  // mode.
  const handleShowExportInFolder = (): void => {
    if (!exportNotice) return
    const { filePath } = exportNotice
    clearExportNotice()
    void window.api.showItemInFolder(filePath).then((revealed) => {
      if (!revealed) {
        useDocumentStore.setState({
          error: 'Could not locate the exported file. It may have been moved or deleted.'
        })
      }
    })
  }

  return (
    <>
      {/* NO flex-wrap, deliberately and permanently -- this row must never
        become two. `flex-wrap` shipped here briefly as a fix for the
        reachability defect described in this file's header, and it worked, but
        it cost 36px of permanent vertical chrome at the default window size
        (45px -> 81px, one row again only above ~1436px) in an app whose whole
        subject is the page. The content was made to fit instead.

        Because there is no wrap, the invariant that keeps this honest is
        arithmetic: the formatting region's natural content plus the
        right-hand cluster must stay inside the toolbar's own content box
        (972px at the shipped 1000px default). Measured after this pass:
        635 + 14 + 266.9 = 915.9, i.e. 56.1px of real slack, and IDENTICAL in
        Format and Split because the two Split-only pills moved to the View
        menu -- the cluster is 266.9px in both, where it used to grow from
        551.3 to 769.4. If a future control pushes past that, the failure mode
        is a horizontally scrolling formatting region -- degraded, but not
        broken, because shouldPinToolbarGroup refuses to pin an occluding
        group -- and phase0/gate33 fails on a named assertion, not silently. */}
      <div
        className="flex flex-none items-center gap-x-3.5 border-b border-border-subtle bg-page px-3.5 py-1.5"
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

          Correction to the paragraph above, from the reachability fix: the
          `sticky` group did NOT "compose correctly" the way it claims. It
          composes correctly on the assumption that the group is narrower than
          the region it is pinned inside, and at the shipped default window
          size it was not (420.5px pinned inside 407px visible), which made it
          an opaque cover over the entire scrollable region rather than a
          convenience. Two things now hold that assumption up: the toolbar
          wraps before squeezing this region that far (see the block comment on
          the toolbar element above), and pinning is skipped outright when the
          group would not leave a usable strip beside it
          (shouldPinToolbarGroup, lib/toolbar-layout.ts).

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
        {/* `flex-1` (flex-basis: 0%), NOT the `basis-[content]` this carried
          while the toolbar wrapped. `basis: content` made this region's
          HYPOTHETICAL main size its full natural width, which is exactly what
          made flex line-breaking push the right-hand cluster onto a second
          line; with the wrap gone that basis has nothing left to do, and a
          zero basis is what makes this region simply absorb whatever the
          flex-none cluster leaves. `min-w-0` remains load-bearing on a flex
          child -- without it this div refuses to shrink below its content's
          natural width and `overflow-x-auto` never engages, so at the app's
          760px minimum the tail of the row would be pushed past the window
          edge with no way to reach it. A hardcoded `min-w-[...]` is still the
          wrong alternative for the same reason it always was: a measurement
          frozen into a class, wrong the moment a label, locale or font
          changes. */}
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
            {/* Leading group: undo/redo + paragraph-style/font/size. z-10
              so it paints above the content scrolling underneath it; bg-page
              (opaque, matching the toolbar's own background) so that
              underlying content is genuinely occluded rather than showing
              through. flex-none so this group itself is never the thing
              that shrinks -- if anything has to give at extreme widths, it's
              the plain formatting controls after it, not this. While pinned it
              is always fully opaque -- toolbarMaskImage's gradient stays black
              (unmasked) across this group's own width (tracked via stickyRef),
              so it never fades regardless of scroll position.

              PINNING IS NOW CONDITIONAL (shouldPinToolbarGroup): an opaque
              group pinned at `left-0` that is WIDER than the visible region
              occludes that region completely, which is exactly the shipped
              bug the wrap above fixes at the default window size. This guard
              covers the widths that still scroll -- below ~870px of window --
              by letting the group scroll away with the content instead. See
              lib/toolbar-layout.ts for the measured numbers. */}
            <div
              ref={stickyRef}
              className={`z-10 flex flex-none items-center gap-x-2.5 bg-page ${
                stickyPinned ? 'sticky left-0' : ''
              }`}
            >
              {/* Undo / redo */}
              <div className="flex items-center gap-0.5">
                <ToolbarIconButton
                  label="Undo"
                  onClick={() => editorRef.current?.undo()}
                  disabled={isSourceMode}
                >
                  <Icon strokeWidth={1.8}>
                    <path d="M7 7 3 11l4 4" />
                    <path d="M3 11h11.5A5.5 5.5 0 0 1 20 16.5v0" />
                  </Icon>
                </ToolbarIconButton>
                <ToolbarIconButton
                  label="Redo"
                  onClick={() => editorRef.current?.redo()}
                  disabled={isSourceMode}
                >
                  <Icon strokeWidth={1.8}>
                    <path d="M17 7l4 4-4 4" />
                    <path d="M21 11H9.5A5.5 5.5 0 0 0 4 16.5v0" />
                  </Icon>
                </ToolbarIconButton>
              </div>

              <ToolbarDivider />

              {/* Paragraph style, and ONLY paragraph style.

              THE FONT FAMILY AND FONT SIZE SELECTS THAT USED TO SIT BESIDE IT
              ARE GONE, MOVED (not deleted) INTO PageSetupModal's Typography
              section -- 208px, the single largest saving in the single-row
              pass, and the one whose justification is about meaning rather
              than pixels. Neither was ever selection formatting: both write
              `fontFamily`/`fontSize` into the DOCUMENT's own YAML frontmatter,
              affecting every page at once, and PageSetupModal is where every
              other PageConfig field is already edited. A selection-formatting
              toolbar that also carries two document-wide settings invites
              exactly the misreading that shipped once here, when Font size had
              `defaultValue="11"` and no onChange at all and read as per-
              selection sizing that silently did nothing.

              Paragraph style stays because it genuinely is a per-block
              command (it dispatches toggleHeading/setParagraph on the current
              selection), and it stays in the PINNED group because it is the
              one control worth keeping on screen while the rest scrolls. */}
              <div className="relative flex h-[30px] items-center">
                <select
                  key={headingSelectResetKey}
                  aria-label="Paragraph style"
                  className="h-full appearance-none rounded-sm bg-transparent pl-2.5 pr-6 text-12-5 text-text-primary hover:bg-chrome-light disabled:cursor-not-allowed disabled:opacity-40"
                  defaultValue="paragraph"
                  onChange={(e) => handleHeadingChange(e.target.value)}
                  disabled={isSourceMode}
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

              <ToolbarDivider />
            </div>

            {/* Bold / Italic.

          UNDERLINE AND TEXT COLOUR WERE REMOVED HERE (capability-gap pass),
          deliberately, and should not come back. Neither has any
          representation in Markdown: there is no underline syntax at all, and
          no colour syntax -- the only way to express either would be raw HTML
          (`<u>`, `<span style>`), and this pipeline's own sanitize schema
          strips both (`hast-util-sanitize`'s defaultSchema allows neither the
          `u` tag nor a `style` attribute on anything), so the mark would
          survive in the editor and then silently vanish from the paginated
          preview, the exported PDF, and the file itself. A control that
          renders at full opacity, takes hover styling and keyboard focus, and
          does nothing when clicked reads as BROKEN, not as unbuilt -- removing
          it is strictly more honest than shipping it. */}
            <div className="flex items-center gap-0.5">
              {/* Real, live pressed state as of the bubble menu sub-project --
            these two carried a hardcoded `active={false}` from the design
            handoff until then, which rendered an actively misleading
            aria-pressed="false" while the cursor sat inside bold text.
            (Underline, which used to sit here carrying that same hardcoded
            false, is gone -- see the block comment above.) */}
              <ToolbarIconButton
                label="Bold"
                active={selection?.marks.bold ?? false}
                onClick={() => editorRef.current?.toggleBold()}
                disabled={isSourceMode}
              >
                <span className="text-14 font-bold leading-none">B</span>
              </ToolbarIconButton>
              <ToolbarIconButton
                label="Italic"
                active={selection?.marks.italic ?? false}
                onClick={() => editorRef.current?.toggleItalic()}
                disabled={isSourceMode}
              >
                <span className="text-14 italic leading-none">I</span>
              </ToolbarIconButton>
            </div>

            <ToolbarDivider />

            {/* Bullet / numbered / checkbox list -- the mockup renders these as
          three plain icon buttons side by side (verified against
          PageDown.dc.html's own markup: no chevron/dropdown panel actually
          exists for this group, despite the README's prose calling it a
          "dropdown group"), so that's what's built here. Checkbox list had
          no backing command until the capability-gap pass, and now has one
          (toggleTaskListCommand, commands.ts) -- GFM task lists were supported
          end to end the whole time (the Meeting Notes template ships them,
          @milkdown/preset-gfm has a real extendListItemSchemaForTask node, and
          the sanitize schema already allows the checkbox markup); the button
          simply had nothing wired to it. Its pressed state reads
          `selection.taskList`, NOT `listType === 'bullet_list'` -- every task
          item satisfies both, so the latter would light up the bullet button
          and this one together. */}
            <div className="flex items-center gap-0.5">
              <ToolbarIconButton
                label="Bulleted list"
                active={selection?.listType === 'bullet_list'}
                onClick={() => editorRef.current?.toggleBulletList()}
                disabled={isSourceMode}
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
                active={selection?.listType === 'ordered_list'}
                onClick={() => editorRef.current?.toggleOrderedList()}
                disabled={isSourceMode}
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
              <ToolbarIconButton
                label="Checklist"
                active={selection?.taskList ?? false}
                onClick={() => editorRef.current?.toggleTaskList()}
                disabled={isSourceMode}
              >
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

            {/* Link / image / table / page-break.

          "Insert image" is real as of the capability-gap pass -- a hidden
          `<input type="file">` (below) opens the OS picker through Chromium
          itself, needing no new IPC handler at all, and the resulting File
          objects go through documentStore.saveDroppedImage, i.e. the exact
          save path drag-and-drop already uses. Before this, dragging a file in
          was the ONLY way to insert an image.

          "SPLIT CELL" WAS REMOVED, deliberately. Splitting a cell only means
          anything against merged cells, and GFM pipe tables cannot express a
          merged cell at all -- there is no colspan/rowspan syntax -- so
          @milkdown/preset-gfm ships no merge or split command (confirmed
          against the installed 7.21.3: its command list has no such entry),
          and any merged state one produced would be silently destroyed on the
          next save. Same reasoning as Underline/text colour above. */}
            <div className="flex items-center gap-0.5">
              {/* Opens LinkComposer (a FindBar-style layout row, rendered by
            EditorScreen), exactly like "Add comment" below opens
            CommentComposer. This button used to call
            `window.prompt('Link URL')` directly -- which THROWS in Electron's
            renderer ("prompt() is not supported.", measured in the real built
            app), taking the whole handler down before
            editorRef.current?.insertLink(href) was ever reached, with nothing
            surfaced to the user. Don't reintroduce window.prompt/alert/confirm
            anywhere in this renderer for the same reason; only
            dialog.showMessageBox over IPC (main process) or a real in-app row
            like this one works. Disabled in Source mode for the same reason as
            every other editorRef-bound button in this cluster. */}
              <ToolbarIconButton
                label="Insert link"
                onClick={openLinkComposer}
                disabled={isSourceMode}
              >
                <Icon strokeWidth={1.8}>
                  <path d="M9.5 14.5 14.5 9.5" />
                  <path d="M11 7.5l1-1a3.5 3.5 0 0 1 5 5l-1 1" />
                  <path d="M13 16.5l-1 1a3.5 3.5 0 0 1-5-5l1-1" />
                </Icon>
              </ToolbarIconButton>
              <ToolbarIconButton
                label="Insert image"
                onClick={() => imageInputRef.current?.click()}
                disabled={isSourceMode}
              >
                <Icon strokeWidth={1.7}>
                  <rect x="3.5" y="5" width="17" height="14" rx="2" />
                  <circle cx="9" cy="10" r="1.4" />
                  <path d="M4 16.5 9 12a2 2 0 0 1 2.7 0l5.3 4.7" />
                </Icon>
              </ToolbarIconButton>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                // aria-hidden + tabIndex -1: the real, labelled control is the
                // button above; this node exists only to open the OS picker.
                // Leaving it in the accessibility tree would announce an
                // unlabelled file input next to it.
                aria-hidden="true"
                tabIndex={-1}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? [])
                  if (files.length > 0) editorRef.current?.insertImages(files)
                  // Cleared so picking the SAME file twice in a row still fires
                  // a change event the second time -- a real, standard
                  // <input type="file"> gotcha, not defensive padding.
                  e.target.value = ''
                }}
              />
              <ToolbarIconButton
                label="Insert table"
                onClick={() => editorRef.current?.insertTable()}
                disabled={isSourceMode}
              >
                <Icon strokeWidth={1.7}>
                  <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
                  <path d="M3.5 10.3h17" />
                  <path d="M3.5 15.6h17" />
                  <path d="M10 5v14" />
                </Icon>
              </ToolbarIconButton>
              <ToolbarIconButton
                label="Insert page break"
                onClick={() => editorRef.current?.insertPageBreak()}
                disabled={isSourceMode}
              >
                <Icon strokeWidth={1.7}>
                  <rect x="5" y="3" width="14" height="18" rx="1.5" />
                  <path d="M6.5 12h3M14.5 12h3" />
                  <path d="M11 10.3v3.4" />
                </Icon>
              </ToolbarIconButton>
              {/* Opens CommentComposer (a FindBar-style layout row, rendered by
            EditorScreen) -- disabled the same way and for the same reason as
            every other editorRef-bound button in this cluster: Source mode
            unmounts MilkdownEditor, so editorRef.current is null there.
            Whether the CURRENT selection is actually valid for a comment
            (non-empty, single block) is deliberately NOT checked here --
            this toolbar has no live selection-state tracking at all (see
            the paragraph-style dropdown's own comment on why), so this
            button just opens the composer; addCommentCommand's own refusal
            is what the composer surfaces as a real inline error if the
            selection turns out not to qualify. */}
              <ToolbarIconButton
                label="Add comment"
                onClick={openCommentComposer}
                disabled={isSourceMode}
              >
                <Icon strokeWidth={1.7}>
                  <path d="M4 5.5h16v10H10l-4 3.5v-3.5H4z" />
                </Icon>
              </ToolbarIconButton>
            </div>

            {/* Wired as of the Find & Replace sub-project
          (docs/superpowers/specs/2026-08-08-find-replace-design.md) -- this
          was a placeholder trigger with no onClick since the design handoff.
          It takes `active` (and therefore renders aria-pressed) because it now
          genuinely toggles a panel, unlike the one-shot action buttons above:
          see ToolbarIconButtonProps' own comment on when that prop belongs.
          Not disabled in Source mode -- Find works on BOTH editing surfaces,
          unlike the editorRef-bound cluster. */}
            <ToolbarIconButton
              label="Find"
              active={findOpen}
              onClick={() => (findOpen ? closeFind() : openFind())}
            >
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
          the scrollable region above absorbs all the squeeze instead.

          `ml-auto` is now belt-and-braces rather than load-bearing: the
          formatting region's `flex-1` already consumes every spare pixel, so
          the auto margin resolves to 0 in practice (auto margins are
          distributed only from space left AFTER flexing). It is kept because
          it costs nothing and it is what pins this cluster right if the region
          ever stops growing. */}
        <div className="ml-auto flex flex-none items-center gap-3.5">
          {/* LABELS ONLY -- the three 16px mode icons that used to sit beside
            them are gone. They cost 66px (icon plus its gap, three times) and
            said nothing the adjacent word did not: a page outline, a split
            rectangle and a pair of chevrons are not self-describing, which is
            exactly why they were captioned in the first place. Dropping the
            LABELS instead would have saved twice as much and was rejected --
            Format/Split/Source is this app's primary mode affordance, and it
            is the one control here that must stay legible at a glance. */}
          <div className="flex items-center gap-0.5 rounded-md bg-chrome-dark p-0.5">
            {(
              [
                { mode: 'format' as const, label: 'Format' },
                { mode: 'split' as const, label: 'Split' },
                { mode: 'source' as const, label: 'Source' }
              ] as const
            ).map(({ mode, label }) => (
              <button
                key={mode}
                type="button"
                aria-pressed={viewMode === mode}
                onClick={() => (onSetViewMode ? onSetViewMode(mode) : setViewMode(mode))}
                className={`rounded-sm px-2.5 py-1 text-12-5 ${
                  viewMode === mode
                    ? 'bg-page text-text-primary shadow-flat'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* THE SPLIT-LEFT-PANE PILLS AND THE "Follow" PILL USED TO SIT HERE,
            and they are the reason this toolbar could not fit on one line.
            Together they were 218px (128.7 + 61.5 plus their gaps) and they
            appeared ONLY in Split mode -- i.e. they loaded their entire cost
            onto precisely the mode with the least room, taking the visible
            formatting region down to 189px. Both now live in the View menu
            (`View > Split Left Pane`, a real radio pair; `View > Follow
            Preview Scroll`, a real checkbox), which is why WindowUiState
            gained `splitLeftMode`/`splitFollowEnabled`: a menu is only an
            acceptable home for them if it can show their live state.

            Removing them also made the cluster mode-INDEPENDENT, which is
            worth more than the pixels: the toolbar no longer reflows when you
            switch to Split, and Format and Split now measure identically.

            The one thing genuinely lost is a one-click Follow toggle while
            editing. It is a set-once preference that defaults ON, so a menu
            round trip is an acceptable price; putting it in the status bar
            instead was measured and rejected -- at the app's 760px minimum
            that bar is already ~610px of content, and the statistics cluster
            grows with the document, so it has no dependable slack either. */}

          <ToolbarIconButton label="Page setup" onClick={openPageSetup}>
            <Icon strokeWidth={1.6}>
              <rect x="5" y="3" width="14" height="18" rx="1.5" />
              <rect x="7.5" y="6" width="9" height="12" rx="0.5" strokeDasharray="1.8 1.8" />
            </Icon>
          </ToolbarIconButton>

          {/* PRINT, EXPORT AS HTML AND KEYBOARD SHORTCUTS ALL USED TO SIT
            HERE, three 30px icon buttons costing 132px with their gaps. All
            three are now menu-only, and all three were safe to move for the
            same reason: each is a once-in-a-while command with a real
            accelerator, not something you reach for mid-sentence.
              Print              -> File > Print… (Cmd+P), pre-existing.
              Export as HTML     -> File > Export as HTML… (Cmd+Alt+E), a menu
                                    item this pass added precisely so the
                                    button had somewhere to go.
              Keyboard shortcuts -> Help > Keyboard Shortcuts (Cmd+/), which is
                                    deliberately not gated on a document being
                                    open, so it is reachable from every screen
                                    -- strictly wider than this button ever
                                    was, since this toolbar only exists inside
                                    the editor.
            Their in-flight guards (documentStore's isPrinting /
            isExportingHtml) are untouched and still correct; those flags now
            simply have one trigger instead of two. */}

          {/* ICON-ONLY, and the label loss is the deliberate cost of keeping
            Undo/Redo and Find on this toolbar. The labelled form was 118.4px
            against 32px here -- 86px, which is what pays for those two -- and
            of everything in this cluster, Export PDF is the item that loses
            least by shedding text: it keeps the accent fill (so it is still
            unmistakably the primary action), it is the ONE control here with
            both a real accelerator and a File-menu twin, and it is used once
            per session rather than once per paragraph. The alternative
            considered and rejected was shortening the label ("Export", "PDF"),
            which left only 10-12px of slack -- a measurement pretending to be
            a design. */}
          <button
            type="button"
            onClick={() => void exportPdf()}
            disabled={isExporting}
            title={isExporting ? 'Exporting…' : 'Export as PDF'}
            aria-label={isExporting ? 'Exporting…' : 'Export as PDF'}
            className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Icon strokeWidth={1.9}>
              <path d="M12 3.5v11" />
              <path d="M8 11l4 4 4-4" />
              <path d="M5 18.5h14" />
            </Icon>
          </button>
        </div>
      </div>
      <Toast
        message={exportNotice?.message ?? null}
        onDismiss={clearExportNotice}
        action={
          exportNotice ? { label: 'Show in Folder', onClick: handleShowExportInFolder } : undefined
        }
      />
    </>
  )
}

export default EditorToolbar
