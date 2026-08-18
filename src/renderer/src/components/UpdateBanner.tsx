import { useEffect, useState, type ReactElement } from 'react'
import {
  INITIAL_UPDATE_STATE,
  shouldShowUpdateBanner,
  type UpdateState
} from '../../../updates/update-state'

// How long the "you are up to date" notice stays up after a manual check.
//
// It exists only so Help > Check for Updates… is not a control that visibly
// does nothing (this repo's own "a dead control is worse than a missing
// one"), so it should acknowledge the click and get out of the way. It
// carries no action, so unlike the restart offer there is nothing to lose by
// retiring it on its own -- which is why this one auto-dismisses and the
// 'ready' state deliberately does not.
const UP_TO_DATE_NOTICE_MS = 6_000

// A LAYOUT ROW, never a floating overlay -- the same architectural
// requirement RemoteImageBanner.tsx / FindBar.tsx already document at length,
// reused rather than re-derived: Split mode's preview pane is a real native
// WebContentsView, which composites above ALL DOM unconditionally, so a
// floating banner would be silently painted over by it (and would need the
// same zero-size-rectangle special-casing PageSetupModal had to add). A
// layout row sidesteps that by construction -- inserting it SHRINKS the
// content area, which moves SplitPreview's placeholder div, which fires its
// existing ResizeObserver, which re-reports bounds over existing IPC.
//
// Rendered at App level rather than inside EditorScreen (which is where
// RemoteImageBanner lives) because an update is an APPLICATION-level fact,
// not a document-level one: it must be visible on Home and Settings too, and
// Home is exactly where a user stands after the launch check fires.
//
// Self-contained, reading main-process state directly rather than taking
// props: no parent has anything to coordinate, and the state genuinely lives
// in another process.
function UpdateBanner(): ReactElement | null {
  const [state, setState] = useState<UpdateState>(INITIAL_UPDATE_STATE)

  useEffect(() => {
    // Both halves are needed and neither is redundant. The subscription
    // catches every change from here on; the one-shot fetch covers the window
    // that mounted after a broadcast had already gone out (a second window,
    // or a slow first paint) and would otherwise sit on the initial state
    // indefinitely while an update was staged.
    //
    // ...and the ORDERING GUARD between them is load-bearing, not defensive.
    // The fetch is asynchronous, so a broadcast can and does land while it is
    // still in flight -- and that broadcast is strictly NEWER than what the
    // fetch is about to return. Without this, an update that finished
    // downloading during startup would show the banner and then have it
    // yanked away a tick later by a stale "idle" reply. Caught by this
    // component's own test, not by review.
    let pushed = false
    const unsubscribe = window.api.onUpdateState((next) => {
      pushed = true
      setState(next)
    })
    void window.api.getUpdateState().then((initial) => {
      if (!pushed) setState(initial)
    })
    return unsubscribe
  }, [])

  const visible = shouldShowUpdateBanner(state)

  useEffect(() => {
    if (!visible || state.status !== 'up-to-date') return
    const timer = setTimeout(() => void window.api.dismissUpdateNotice(), UP_TO_DATE_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [visible, state.status])

  if (!visible) return null

  if (state.status === 'up-to-date') {
    return (
      <div
        role="status"
        className="flex flex-none items-center gap-3 border-b border-border-chrome bg-chrome-dark px-3 py-1.5 text-12 text-text-secondary"
      >
        <span>PageDown is up to date.</span>
      </div>
    )
  }

  return (
    <div
      role="group"
      aria-label="Update available"
      className="flex flex-none items-center justify-between gap-3 border-b border-border-chrome bg-chrome-dark px-3 py-1.5 text-12 text-text-secondary"
    >
      <span>
        {state.version
          ? `PageDown ${state.version} is ready to install.`
          : 'An update is ready to install.'}
      </span>
      <div className="flex flex-none items-center gap-1.5">
        {/* The ONLY thing in this app that installs an update. Nothing
        happens on quit, on launch, or on any timer -- autoInstallOnAppQuit is
        off (see updater.ts), so a user who never presses this keeps the
        version they have for as long as they like. */}
        <button
          type="button"
          onClick={() => void window.api.installUpdate()}
          className="flex-none rounded-sm border border-border-chrome px-2.5 py-1 text-12 text-text-primary transition-colors hover:bg-chrome-light"
        >
          Restart & Install
        </button>
        <button
          type="button"
          onClick={() => void window.api.dismissUpdateNotice()}
          className="flex-none rounded-sm px-2.5 py-1 text-12 text-text-secondary transition-colors hover:bg-chrome-light"
        >
          Later
        </button>
      </div>
    </div>
  )
}

export default UpdateBanner
