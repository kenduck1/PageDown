import { useCallback, useEffect, useMemo, type RefObject } from 'react'
import { findMatches, MAX_MATCHES, type FindMatch } from '../lib/find-matches'
import { useFindStore } from '../store/findStore'
import type { MilkdownEditorHandle } from '../milkdown/MilkdownEditor'
import type { SourceEditorHandle } from '../components/SourceEditor'

export interface FindControllerParams {
  content: string
  activeTabId: string
  revision: number
  sourceEditing: boolean
  editorRef: RefObject<MilkdownEditorHandle | null>
  sourceRef: RefObject<SourceEditorHandle | null>
  updateContentForTab: (tabId: string, content: string) => void
}

export interface FindController {
  replaceActive: () => void
  replaceAll: () => void
  getSelectedText: () => string
  handleFormatMatches: (count: number, activeIndex: number) => void
}

// The cross-surface controller: the ONE piece of code that knows Find has to
// mean something different depending on whether Format or Source editing is
// live -- Format mode searches the rendered ProseMirror document (via
// MilkdownEditorHandle.setFindState, backed by milkdown/find-plugin.ts's own
// decoration/navigation machinery), Source mode searches the raw Markdown
// string directly (via the shared findMatches engine, same one the plugin
// itself uses per text run -- see find-matches.ts's own module comment on why
// that sharing is what keeps the two surfaces from disagreeing about what
// counts as a match). findStore holds the query/options/count/cursor; this
// hook is what keeps that store's state and whichever surface is actually on
// screen in sync with each other.
export function useFindController(params: FindControllerParams): FindController {
  const {
    content,
    activeTabId,
    revision,
    sourceEditing,
    editorRef,
    sourceRef,
    updateContentForTab
  } = params

  const isOpen = useFindStore((state) => state.isOpen)
  const query = useFindStore((state) => state.query)
  const replacement = useFindStore((state) => state.replacement)
  const options = useFindStore((state) => state.options)
  const activeIndex = useFindStore((state) => state.activeIndex)
  const setMatches = useFindStore((state) => state.setMatches)
  const resetForDocument = useFindStore((state) => state.resetForDocument)

  // Find state is per-DOCUMENT (see findStore.resetForDocument's own comment
  // for the two observed symptoms this closes). This is the one place that
  // knows both halves -- which document is live, and what Find currently
  // believes -- so it is where the two are re-synchronised.
  //
  // Keyed on `activeTabId` ALONE, deliberately, and both halves of that matter:
  //   - NOT on `revision`, even though revision is what remounts the editor.
  //     revision also bumps for in-place rewrites of the SAME document (a
  //     view-mode switch, Page Setup's Apply, a History restore), and resetting
  //     the cursor there would throw away the user's position mid-search -- the
  //     exact mistake the currentPage reset made before it moved onto the tab.
  //   - `activeTabId` alone is nonetheless sufficient. The one document change
  //     that does NOT change the tab id is openDocumentState reusing a
  //     PRISTINE blank tab, and a pristine tab is byte-empty by definition
  //     (isPristineBlankTab), so its match list is necessarily already empty --
  //     there is nothing stale to clear.
  //
  // An effect rather than a synchronous call from documentStore's own actions:
  // making documentStore reach into findStore would invert this codebase's
  // store layering (findStore knows nothing about documents today, and
  // documentStore knows nothing about any UI feature) for a difference of one
  // commit. Accepted, disclosed consequence of the effect: for that single
  // commit the bar can still show the previous document's count, and in Format
  // mode the push effect below can select the old index once in the newly
  // mounted editor before this correction lands. Both are visual-only and
  // resolve in the same tick's follow-up render; no edit and no navigation is
  // performed on the wrong document, because the count/cursor drive only
  // decoration and selection.
  useEffect(() => {
    resetForDocument()
  }, [activeTabId, resetForDocument])

  // Source-mode matches: a plain scan over the raw Markdown string, recomputed
  // only when something that could actually change the result changes --
  // deliberately NOT on activeIndex (navigating Next/Previous must not
  // re-scan the whole document). Empty whenever Source editing isn't the live
  // surface or the bar is closed, so Source's own effects below are cheap
  // no-ops the rest of the time rather than needing their own extra guards.
  const sourceMatches = useMemo<FindMatch[]>(() => {
    if (!sourceEditing || !isOpen) return []
    return findMatches(content, query, options)
  }, [sourceEditing, isOpen, content, query, options])

  // Publishes the Source-mode count into findStore. Format mode publishes its
  // OWN count via handleFormatMatches below (the ProseMirror plugin's own
  // view.update callback) -- gating this on sourceEditing is what stops the
  // two publishers from racing/overwriting each other's counts the instant
  // the live surface changes.
  useEffect(() => {
    if (!sourceEditing) return
    setMatches(sourceMatches.length, sourceMatches.length >= MAX_MATCHES)
  }, [sourceEditing, sourceMatches, setMatches])

  // Selects (and reveals) the active Source-mode match in the real textarea.
  //
  // Deliberately does NOT call textarea.focus(): findStore's setQuery resets
  // activeIndex to 0 on every keystroke (CURSOR_RESET), which means this
  // effect re-runs on every keystroke typed into the Find input while Source
  // editing is live. Focusing the textarea here would steal focus away from
  // that input mid-keystroke -- the very next character the user types would
  // land in the document instead of the query, which is exactly backwards.
  // Revealing the match is instead done by computing scrollTop directly
  // ("blur()-free" scrolling, i.e. no focus()+blur() trick either): count the
  // newlines before the match to get its line number, and convert that to a
  // pixel offset via the textarea's own computed line-height, falling back to
  // a fixed estimate under jsdom (which has no real font metrics/layout, so
  // getComputedStyle's line-height there is unresolved).
  useEffect(() => {
    if (!sourceEditing) return
    const match = sourceMatches[activeIndex]
    const textarea = sourceRef.current?.getTextarea()
    if (!match || !textarea) return
    textarea.setSelectionRange(match.from, match.to)
    const linesBeforeMatch = content.slice(0, match.from).split('\n').length - 1
    const computedLineHeight = parseFloat(getComputedStyle(textarea).lineHeight)
    const lineHeightPx = Number.isFinite(computedLineHeight) ? computedLineHeight : 18
    textarea.scrollTop = Math.max(0, linesBeforeMatch * lineHeightPx - textarea.clientHeight / 2)
  }, [sourceEditing, activeIndex, sourceMatches, sourceRef, content])

  // Format-mode: pushes the live query/options/cursor into the mounted
  // Milkdown handle on every relevant change. `query` collapses to '' when
  // the bar is closed OR Source editing is the live surface -- both cases
  // must clear the Format-mode decorations, not just leave them showing a
  // stale highlight: closing the bar should visibly clear the highlight, and
  // Source editing means Format's own instance (if even mounted) has no
  // reason to keep decorating a search the user isn't looking at.
  //
  // `revision`/`content` are in the dependency list because switching
  // documents (revision bump) or the underlying content changing out from
  // under an open bar both remount/re-render the Format surface -- without
  // them this effect could skip re-pushing state into a freshly mounted
  // handle whose internal find-plugin state starts empty.
  useEffect(() => {
    editorRef.current?.setFindState({
      query: isOpen && !sourceEditing ? query : '',
      options,
      activeIndex
    })
  }, [sourceEditing, isOpen, query, options, activeIndex, revision, content, editorRef])

  // Bridges milkdown/find-plugin.ts's own view.update callback (wired via
  // MilkdownEditor's onFindMatchesChanged prop) back into findStore. This is
  // the ONLY thing that publishes Format-mode's count -- unlike Source mode
  // above, there is no local re-scan here, because the plugin already did the
  // real work against the live ProseMirror document and this would just be
  // recomputing the same answer worse (and against the wrong text: Format
  // mode's own `content` prop is the ORIGINAL markdown fed in at mount, not
  // what's currently rendered).
  //
  // Convergence, load-bearing to get right (do not break either property):
  // the effect above pushes {query, options, activeIndex} into the handle,
  // the plugin recomputes and calls this back with a new {count, activeIndex},
  // and setMatches below can itself change activeIndex (when it's clamped
  // back into range), which re-triggers the push effect above with the
  // corrected index. This settles in at most two rounds rather than
  // oscillating forever because of two independent guarantees, one on each
  // side of the loop: setMatches only changes activeIndex when it is
  // genuinely OUT of range (findStore.ts's own clamp -- an already-valid
  // index is returned unchanged), and the plugin's view.update only invokes
  // this callback when the match count or active index actually CHANGED
  // (find-plugin.ts's own early-return when both are equal to the previous
  // state) -- so a round that pushes the exact state the plugin already has
  // produces no callback at all, terminating the cycle.
  const handleFormatMatches = useCallback(
    (count: number, matchActiveIndex: number) => {
      void matchActiveIndex
      setMatches(count, count >= MAX_MATCHES)
    },
    [setMatches]
  )

  // The two surfaces search genuinely different text -- Source mode scans the
  // raw Markdown string, Format mode scans the rendered ProseMirror document
  // (where e.g. `**` markers are consumed into a bold mark, not literal
  // characters) -- so a Format-mode match at index 7 has no relationship
  // whatsoever to a Source-mode match at index 7. That's why activeIndex is
  // allowed to reset (via findStore's own clamp, triggered by the fresh
  // setMatches call each surface's own effect fires above) rather than being
  // preserved across a surface change: preserving it would point the cursor
  // at an arbitrary, unrelated position on the new surface.
  const replaceActive = useCallback(() => {
    if (!sourceEditing) {
      editorRef.current?.replaceActiveMatch(replacement)
      return
    }
    const match = sourceMatches[activeIndex]
    if (!match) return
    const next = content.slice(0, match.from) + replacement + content.slice(match.to)
    updateContentForTab(activeTabId, next)
  }, [
    sourceEditing,
    editorRef,
    replacement,
    sourceMatches,
    activeIndex,
    content,
    updateContentForTab,
    activeTabId
  ])

  // Builds the ENTIRE new string in a single forward pass over sourceMatches
  // and calls updateContentForTab exactly once -- one store update, one dirty
  // transition, one undo entry (mirroring milkdown/find-plugin.ts's own
  // replaceAllMatchesIn, which applies every replacement as one ProseMirror
  // transaction for the same reason). Looping and calling updateContentForTab
  // per match would multiply all three of those, and would also be wrong:
  // each earlier replacement can change the length of the string, silently
  // invalidating every later match's own [from, to) offsets.
  const replaceAll = useCallback(() => {
    if (!sourceEditing) {
      editorRef.current?.replaceAllMatches(replacement)
      return
    }
    if (sourceMatches.length === 0) return
    let next = ''
    let cursor = 0
    for (const match of sourceMatches) {
      next += content.slice(cursor, match.from) + replacement
      cursor = match.to
    }
    next += content.slice(cursor)
    updateContentForTab(activeTabId, next)
  }, [
    sourceEditing,
    editorRef,
    replacement,
    sourceMatches,
    content,
    updateContentForTab,
    activeTabId
  ])

  const getSelectedText = useCallback((): string => {
    if (sourceEditing) return sourceRef.current?.getSelectedText() ?? ''
    return editorRef.current?.getSelectedText() ?? ''
  }, [sourceEditing, sourceRef, editorRef])

  return { replaceActive, replaceAll, getSelectedText, handleFormatMatches }
}
