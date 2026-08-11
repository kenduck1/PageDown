import { useState, type ReactElement } from 'react'
import { useDocumentStore } from '../store/documentStore'
import type { DocumentWarning } from '../../../markdown/document-warnings'

interface DocumentWarningsBannerProps {
  warnings: DocumentWarning[]
}

/**
 * A LAYOUT ROW, never a floating banner -- the exact same architectural
 * requirement RemoteImageBanner.tsx/FindBar.tsx/CommentComposer.tsx already
 * document at length, reused rather than re-derived: Split mode's preview
 * pane is a real native `WebContentsView`, which composites above ALL DOM
 * unconditionally, so any floating overlay would need the same special-
 * casing `PageSetupModal` had to add (a zero-size-rectangle workaround). A
 * layout row sidesteps this by construction -- it shrinks the content area
 * instead, which the existing `ResizeObserver` chain already handles.
 *
 * UNLIKE `RemoteImageBanner`, this component takes `warnings` as a PROP
 * rather than re-deriving them from `documentStore` itself. RemoteImageBanner
 * re-runs its OWN cheap, local, renderer-side remark parse on a debounce it
 * owns; these warnings are produced inside `getPageCount`'s own already-
 * running MAIN-PROCESS `markdownToHtml`/`resolvePageConfigWithWarnings` pass
 * (see `page-count-generator.ts` and `pipeline.ts`) and threaded back over
 * the SAME IPC round trip `usePageCount` already makes for the status bar's
 * page count. A second, independent detection pass here would either
 * duplicate that IPC work or require its own renderer-side parse of
 * frontmatter/pagebreak syntax the main-process pipeline already resolves
 * authoritatively -- worse on both counts than accepting these as a prop
 * from the one call site (`EditorScreen`) that already has them via
 * `usePageCount`.
 *
 * Dismissal rule, deliberately simple: a "Dismiss" click hides the banner
 * for the CURRENTLY ACTIVE TAB until either (a) the warning set fully clears
 * (the user fixes whatever it was, or switches to a tab/document with none)
 * and then something warning-worthy happens again -- even the exact same
 * category recurring counts as fresh news, not a re-trigger of an old
 * suppression -- or (b) the active tab changes to one that was never
 * dismissed. What this deliberately does NOT do: track dismissal per
 * warning id, or persist it anywhere (matching `remoteImagesAllowed`'s own
 * documented "session-scoped, not persisted" precedent) -- these are
 * low-stakes notices, not consent decisions, and the goal is "stop nagging
 * about the CURRENT problem," not a permanent per-category mute list.
 */
function DocumentWarningsBanner({ warnings }: DocumentWarningsBannerProps): ReactElement | null {
  const activeTabId = useDocumentStore((state) => state.activeTabId)

  const isEmpty = warnings.length === 0

  // "Adjust state during render" (the same pattern `usePageCount`'s own
  // `prevContent`/`setPrevContent` uses, and `SettingsScreen.tsx`'s
  // `lastSyncedAutosaveMs` per CLAUDE.md) rather than a `useEffect` -- avoids
  // this project's `react-hooks/set-state-in-effect` lint rule for exactly
  // the "mirror a transition in a prop into local state" shape this is.
  //
  // `wasEmpty` exists ONLY to detect the 0 -> >0 -> 0 -> >0 transition and
  // re-arm `dismissedTabId` on the trip back through empty -- without it, a
  // dismissed warning that later got fixed and then genuinely recurred would
  // stay silently suppressed forever, since `dismissedTabId` alone can't
  // tell "still the same unresolved problem" from "a brand new one."
  const [wasEmpty, setWasEmpty] = useState(isEmpty)
  const [dismissedTabId, setDismissedTabId] = useState<string | null>(null)

  if (isEmpty !== wasEmpty) {
    setWasEmpty(isEmpty)
    if (isEmpty) {
      setDismissedTabId(null)
    }
  }

  if (isEmpty || dismissedTabId === activeTabId) return null

  // Aggregated into ONE row (never one row per warning) -- each producer
  // already aggregates its OWN category ("N inline markers", not N separate
  // entries), and joining categories into a single line here is the same
  // "don't be noisy" treatment applied one level up, for the rare case where
  // more than one category is active on the same document at once.
  const message = warnings.map((warning) => warning.message).join('  ·  ')

  return (
    <div
      role="group"
      aria-label="Document warnings"
      className="flex flex-none items-center justify-between gap-3 border-b border-border-chrome bg-chrome-dark px-3 py-1.5 text-12 text-text-secondary"
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={() => setDismissedTabId(activeTabId)}
        className="flex-none rounded-sm px-2.5 py-1 text-12 text-text-secondary transition-colors hover:bg-chrome-light"
      >
        Dismiss
      </button>
    </div>
  )
}

export default DocumentWarningsBanner
