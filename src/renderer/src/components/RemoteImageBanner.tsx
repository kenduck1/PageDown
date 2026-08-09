import { useMemo, type ReactElement } from 'react'
import { useDocumentStore } from '../store/documentStore'
import { documentHasRemoteImages } from '../lib/detectRemoteImages'

// A LAYOUT ROW, never a floating banner -- the exact same architectural
// requirement FindBar.tsx/CommentComposer.tsx already document at length,
// reused rather than re-derived: Split mode's preview pane is a real native
// WebContentsView, which composites above ALL DOM unconditionally, so any
// floating overlay needs the same special-casing PageSetupModal had to add.
// A layout row sidesteps this by construction.
//
// Design doc Security section: "Remote images blocked by default per
// document, with an explicit 'This document wants to load images from the
// internet — Load / Keep blocked' prompt." Self-contained (reads/writes
// documentStore directly, like CommentComposer reads/writes appStore) rather
// than taking props -- consent is per-tab DOCUMENT state, not UI state a
// parent needs to coordinate.
function RemoteImageBanner(): ReactElement | null {
  const activeTabId = useDocumentStore((state) => state.activeTabId)
  const content = useDocumentStore((state) => state.content)
  const remoteImagesAllowed = useDocumentStore((state) => state.remoteImagesAllowed)
  const setRemoteImagesAllowed = useDocumentStore((state) => state.setRemoteImagesAllowed)

  // Re-parses only when `content` actually changes -- a real cost (a fresh
  // remark parse), so this must not re-run on every unrelated EditorScreen
  // re-render (e.g. a page-count poll tick).
  const hasRemoteImages = useMemo(() => documentHasRemoteImages(content), [content])

  // Undecided (null) is the only state that shows the banner -- an explicit
  // true/false decision, once made, stays hidden for the rest of this tab's
  // session even if hasRemoteImages is still true (see documentStore's own
  // remoteImagesAllowed doc comment for why this is session-scoped, not
  // persisted).
  if (!hasRemoteImages || remoteImagesAllowed !== null) return null

  return (
    <div
      role="group"
      aria-label="Remote image consent"
      className="flex flex-none items-center justify-between gap-3 border-b border-border-chrome bg-chrome-dark px-3 py-1.5 text-12 text-text-secondary"
    >
      <span>This document wants to load images from the internet.</span>
      <div className="flex flex-none items-center gap-1.5">
        <button
          type="button"
          onClick={() => setRemoteImagesAllowed(activeTabId, true)}
          className="flex-none rounded-sm border border-border-chrome px-2.5 py-1 text-12 text-text-primary transition-colors hover:bg-chrome-light"
        >
          Load
        </button>
        <button
          type="button"
          onClick={() => setRemoteImagesAllowed(activeTabId, false)}
          className="flex-none rounded-sm px-2.5 py-1 text-12 text-text-secondary transition-colors hover:bg-chrome-light"
        >
          Keep blocked
        </button>
      </div>
    </div>
  )
}

export default RemoteImageBanner
