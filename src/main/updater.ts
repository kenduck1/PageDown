import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import {
  INITIAL_UPDATE_STATE,
  reduceUpdateState,
  shouldCheckForUpdates,
  type UpdateEvent,
  type UpdateState
} from '../updates/update-state'

// The Electron-touching half of in-app auto-update. Everything that can be
// decided without Electron -- what a given event does to what the user sees,
// whether a version is genuinely newer, whether a check is worth making --
// lives in src/updates/update-state.ts instead, which is directly
// unit-testable. Same split, and the same reasoning, as recent-files.ts vs
// file-io.ts and app-menu-template.ts vs app-menu.ts.
//
// This module has no unit test of its own, matching app-menu.ts's and
// index.ts's own established treatment -- and here it is not merely
// convention: `electron-updater`'s `autoUpdater` export is a lazy GETTER that
// constructs a platform updater on first access, and that constructor reads
// `app.getVersion()` immediately, so importing this module outside a running
// Electron process throws before a single test could run. Verified directly
// against the installed package (electron-updater 6.8.9), not assumed.
//
// ---------------------------------------------------------------------------
// EXPECTED-UNTIL-PUBLIC: updates genuinely cannot work yet, and that is not a
// bug to chase.
//
// electron-builder.yml publishes to the GitHub provider, which reads this
// repository's own releases API. THE REPOSITORY IS PRIVATE TODAY, and that
// endpoint 404s for a private repo unless the request carries a token. A
// token cannot be part of the answer: anything shipped inside the app is
// extractable from every copy of it by anyone who downloads one, so embedding
// a GitHub token would be publishing that token, not protecting it.
//
// So until the repository is public, EVERY check fails, and the design makes
// that failure completely silent -- no toast, no banner, no error anywhere in
// the UI (see reduceUpdateState's `check-failed` branch). An updater that
// nagged on every launch because the feed is unreachable would be worse than
// no updater at all. The failure IS logged, once per check, so it is visible
// to anyone actually looking for it.
//
// A second, independent blocker for macOS specifically: Squirrel.Mac will not
// apply an update to an app that is not signed and notarized, and
// electron-builder.yml's `notarize` is off by default (the release workflow
// only turns it on when real Apple secrets are present). So macOS updates
// need BOTH a public repo and a signed release.
//
// What to do when the repo goes public: nothing here. Publish a real (not
// draft) GitHub Release carrying the installers AND the `latest*.yml` /
// `.blockmap` files the release workflow now uploads, and this starts
// working. Note "not draft" specifically -- electron-updater reads the
// releases API's latest-release view, which excludes drafts, so a draft
// release is invisible to it no matter what is attached.
// ---------------------------------------------------------------------------

// How long after launch the automatic check waits.
//
// Not zero, and not a round "because it feels right" number either: a cold
// launch is already doing real work (restoring window bounds, creating the
// first BrowserWindow, spinning up the pagination harnesses the Home screen's
// thumbnails need). A network round trip and a background download racing all
// of that is exactly the interruption a document editor must not create, and
// it would land on the slowest part of the slowest launch. Ten seconds is
// comfortably past first paint on any machine this app targets while still
// being the same session the user is sitting in.
const LAUNCH_CHECK_DELAY_MS = 10_000

interface UpdaterDeps {
  // Pushes the new state to every window. Injected rather than reached for,
  // because src/main/index.ts owns the window set -- the same shape as
  // app-menu.ts's own `dispatch` dependency.
  broadcast: (state: UpdateState) => void
}

let deps: UpdaterDeps | null = null
let state: UpdateState = INITIAL_UPDATE_STATE

export function getUpdateState(): UpdateState {
  return state
}

// Every state change funnels through here, so there is exactly one place that
// can broadcast and exactly one place that decides. A no-op transition (the
// reducer returning the same object, e.g. an ignored downgrade) broadcasts
// nothing -- pushing an identical state to every renderer on every ignored
// event would be pure noise.
function dispatch(event: UpdateEvent): void {
  const next = reduceUpdateState(state, event, app.getVersion())
  if (next === state) return
  state = next
  deps?.broadcast(state)
}

// Wires electron-updater's own events onto this module's normalized event set.
// Called once, and only for a packaged app.
function attachUpdaterListeners(): void {
  // Downloads happen on their own, with no prompt -- the design's "a document
  // editor must not interrupt". This is electron-updater's default; pinned
  // explicitly because the whole feature's behaviour hinges on it.
  autoUpdater.autoDownload = true

  // NEVER install without an explicit click, and quitting is NOT a click.
  // Left at its default (`true`), electron-updater installs a staged update
  // during app shutdown -- so a user who quit at the end of the day would
  // find a different version of their editor tomorrow, having consented to
  // nothing. The only path to an install is the banner's own button, which
  // routes through the `update:install` IPC handler in index.ts.
  autoUpdater.autoInstallOnAppQuit = false

  // `checking-for-update` is deliberately NOT subscribed: `check-started` is
  // dispatched by `checkForUpdates` below instead, because that is the only
  // place that knows whether the user asked for this check or the launch
  // timer did -- and that distinction is the whole difference between a
  // silent result and a visible one.
  autoUpdater.on('update-available', (info) => {
    dispatch({ type: 'update-available', version: String(info?.version ?? '') })
  })

  autoUpdater.on('update-not-available', () => {
    dispatch({ type: 'update-not-available' })
  })

  autoUpdater.on('update-downloaded', (info) => {
    dispatch({ type: 'update-downloaded', version: String(info?.version ?? '') })
  })

  // LOG-ONLY, deliberately. See this module's own EXPECTED-UNTIL-PUBLIC note:
  // a private repository makes this fire on every single check, and the one
  // thing that must not happen is the user seeing it.
  autoUpdater.on('error', (error) => {
    console.warn(
      '[PageDown] Update check failed (this is expected until the repo is public):',
      error
    )
    dispatch({ type: 'check-failed' })
  })

  // `download-progress` is deliberately NOT subscribed. Nothing renders a
  // progress bar (the download is meant to be invisible until it can be acted
  // on), so subscribing would only add state nobody reads.
}

// Runs a check, if one is worth running. `manual` distinguishes the Help >
// Check for Updates… click from the launch timer, and is the ONLY thing that
// makes a "you are up to date" result visible.
export async function checkForUpdates(manual: boolean): Promise<void> {
  // Dispatched BEFORE the shouldCheckForUpdates gate on purpose: a manual
  // check while an update is already staged does no network work at all, but
  // it does clear `dismissed`, which is what re-surfaces a banner the user
  // clicked "Later" on. Without that, "Later" would be permanent until
  // relaunch and the menu item would appear to do nothing.
  dispatch({ type: 'check-started', manual })

  if (!shouldCheckForUpdates({ isPackaged: app.isPackaged, state })) return

  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    // Both halves are needed: `checkForUpdates()` rejects for a transport
    // failure, and the 'error' listener above fires for failures raised
    // asynchronously during the download. Dispatching `check-failed` twice is
    // harmless -- the reducer is idempotent on it.
    console.warn(
      '[PageDown] Update check failed (this is expected until the repo is public):',
      error
    )
    dispatch({ type: 'check-failed' })
  }
}

export function dismissUpdateNotice(): void {
  dispatch({ type: 'dismissed' })
}

// Replaces the running application. The CALLER is responsible for having
// obtained the user's consent to quit first -- see the `update:install`
// handler in index.ts, which runs the same two-phase unsaved-work approval
// the quit guard uses before ever calling this.
//
// That ordering is required, not defensive: Electron's own documented
// behaviour for `quitAndInstall` is that it "will close all application
// windows first, and automatically call app.quit() after all windows have
// been closed" -- and this app's `win.on('close')` guard cancels exactly that
// until the renderer answers. Calling this without pre-approving the quit
// would either hang the install behind a prompt nobody knows is there, or (on
// Windows, where NsisUpdater spawns the installer *before* quitting) leave an
// installer running against an app that then refuses to exit.
export function quitAndInstallUpdate(): void {
  autoUpdater.quitAndInstall()
}

// Sets the whole thing up. Safe to call unconditionally: it does nothing at
// all for an unpackaged app, so `pnpm dev` never talks to a release feed,
// never schedules a check, and never touches the lazily-constructed
// `autoUpdater` at all.
//
// `app.isPackaged` rather than `is.dev` (which is its exact negation) because
// this is the semantically correct question: "is there a real installed
// application here that an update could replace?"
export function initAutoUpdate(next: UpdaterDeps): void {
  deps = next
  if (!app.isPackaged) return

  attachUpdaterListeners()

  const launchCheckTimer = setTimeout(() => {
    void checkForUpdates(false)
  }, LAUNCH_CHECK_DELAY_MS)
  // Must not hold the process open on its own -- a launch followed
  // immediately by a quit should exit, not wait out the delay.
  launchCheckTimer.unref?.()
}
