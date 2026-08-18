// The in-app updater's wire contract AND all of its decision logic, in one
// dependency-free module.
//
// Same placement reasoning as `src/menu/commands.ts`, `src/window/close-
// request.ts` and `src/preferences/channel.ts`: the MAIN process owns the
// real `electron-updater` instance, the PRELOAD needs the channel names at
// runtime, and the RENDERER needs both the state type and
// `shouldShowUpdateBanner` to decide whether to render a row. A `src/main/*`
// module could serve none of that -- src/main is outside tsconfig.web.json's
// program and every module there transitively imports `electron`. Nothing in
// this file imports anything, deliberately.
//
// WHY THE LOGIC LIVES HERE RATHER THAN INLINE IN src/main/updater.ts: that
// module cannot be unit-tested at all. `electron-updater`'s `autoUpdater`
// export is a lazy GETTER that constructs a platform updater on first access,
// and that constructor immediately reads `app.getVersion()` -- so merely
// touching it outside a running Electron process throws
// (`TypeError: Cannot read properties of undefined (reading 'getVersion')`,
// reproduced directly against the installed package, not assumed). Every
// question worth getting right -- should we check, is this version actually
// newer, what does this event do to what the user sees -- is answered here
// instead, where a plain Vitest run can exercise it. Same split, and the same
// reasoning, as recent-files.ts vs file-io.ts and app-menu-template.ts vs
// app-menu.ts.

// main -> renderer push channel, broadcast to every window on every state
// change. Pinned in a shared constant for the reason src/preferences/
// channel.ts spells out: a renderer-INITIATED channel typo surfaces
// immediately as "No handler registered for ...", while a PUSH channel typo
// means the listener simply never fires, silently, forever.
export const UPDATE_STATE_CHANNEL = 'update:state'

// Renderer -> main request channels. Plain literals would be fine (they are
// `invoke`, so a typo throws), but keeping all three names together makes the
// whole surface visible at a glance.
export const UPDATE_GET_STATE_CHANNEL = 'update:getState'
export const UPDATE_INSTALL_CHANNEL = 'update:install'
export const UPDATE_DISMISS_CHANNEL = 'update:dismiss'

export type UpdateStatus =
  // Nothing in flight and nothing to say. The status a failed check always
  // lands back on -- see `reduceUpdateState`'s `check-failed` branch.
  | 'idle'
  // A check is in flight. Deliberately NOT rendered anywhere: the launch
  // check happens seconds after startup and a "checking…" row appearing on
  // its own would be exactly the interruption this design exists to avoid.
  | 'checking'
  // An update is downloading in the background. Also not rendered -- the
  // download is meant to be invisible until it can actually be acted on.
  | 'downloading'
  // Downloaded and staged. The ONE status that offers to restart.
  | 'ready'
  // A MANUAL check completed and there was nothing to install. Only ever
  // reachable from a Help > Check for Updates… click (never from the launch
  // check), because a menu item that gives no feedback whatsoever reads as
  // broken -- this repo's own "a dead control is worse than a missing one".
  | 'up-to-date'

export interface UpdateState {
  status: UpdateStatus
  // The version being downloaded / staged, for display. `null` whenever
  // there is no specific version in play.
  version: string | null
  // Whether the check that produced this state was user-initiated. Carried on
  // the state rather than passed around separately because the answer is
  // needed at `update-not-available` time, which is a different event from
  // the one that knows it (`check-started`).
  manual: boolean
  // The user clicked "Later" (or the up-to-date notice auto-expired). Kept
  // SEPARATE from `status` on purpose: an update that is downloaded really is
  // still ready, and saying otherwise would mean lying about it in the one
  // place that decides whether `quitAndInstall` is allowed to run. A manual
  // check clears this, which is what gives a user who dismissed the banner a
  // way back to it without relaunching.
  dismissed: boolean
}

export const INITIAL_UPDATE_STATE: UpdateState = {
  status: 'idle',
  version: null,
  manual: false,
  dismissed: false
}

// Normalized from electron-updater's own event set by src/main/updater.ts, so
// this module never has to know that library's payload shapes.
export type UpdateEvent =
  | { type: 'check-started'; manual: boolean }
  | { type: 'update-available'; version: string }
  | { type: 'update-not-available' }
  | { type: 'update-downloaded'; version: string }
  | { type: 'check-failed' }
  | { type: 'dismissed' }

// Splits a version into its numeric release components plus its prerelease
// identifiers. Tolerant on purpose -- this reads a string that arrives over
// the network from a release feed, so it must never throw.
function parseVersion(version: string): { release: number[]; prerelease: string[] } | null {
  const trimmed = version.trim().replace(/^v/i, '')
  if (trimmed === '') return null
  // Build metadata (`+sha`) is explicitly NOT part of precedence per semver,
  // so it is dropped before anything else looks at the string.
  const withoutBuild = trimmed.split('+')[0]
  const dashIndex = withoutBuild.indexOf('-')
  const core = dashIndex === -1 ? withoutBuild : withoutBuild.slice(0, dashIndex)
  const prerelease = dashIndex === -1 ? [] : withoutBuild.slice(dashIndex + 1).split('.')
  const release = core.split('.').map((part) => {
    const value = Number.parseInt(part, 10)
    return Number.isFinite(value) && value >= 0 ? value : Number.NaN
  })
  if (release.length === 0 || release.some((value) => Number.isNaN(value))) return null
  return { release, prerelease }
}

function comparePrerelease(a: string[], b: string[]): number {
  // Semver: a version WITHOUT a prerelease outranks the same version WITH
  // one. 1.0.0 > 1.0.0-beta.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i]
    const right = b[i]
    // A longer identifier list outranks a shorter prefix of itself.
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftNumeric && !rightNumeric) return -1
    if (!leftNumeric && rightNumeric) return 1
    if (leftNumeric && rightNumeric) {
      const diff = Number.parseInt(left, 10) - Number.parseInt(right, 10)
      if (diff !== 0) return diff < 0 ? -1 : 1
      continue
    }
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

// -1 / 0 / 1, or `null` when either side is not a version this module is
// willing to reason about. `null` rather than a silent 0 so callers have to
// decide what an unparseable version means for them -- see `isNewerVersion`,
// which fails CLOSED.
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  const length = Math.max(left.release.length, right.release.length)
  for (let i = 0; i < length; i++) {
    // A missing component is 0, so `1.2` and `1.2.0` compare equal.
    const diff = (left.release[i] ?? 0) - (right.release[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

// Defence in depth over electron-updater's own `allowDowngrade: false`
// default, and the reason it is worth having independently: this is the one
// predicate standing between a release feed and an offer to REPLACE the
// user's installed application. A feed that is stale, rolled back, or simply
// wrong must never produce a "Restart to update" button that quietly
// downgrades them. Fails CLOSED on anything it cannot parse.
export function isNewerVersion(candidate: string, current: string): boolean {
  const result = compareVersions(candidate, current)
  return result !== null && result > 0
}

// Whether a check is worth actually making. Note what is NOT here: any
// notion of "have we checked recently" / a persisted timestamp. The launch
// check fires once per app run and the manual check is an explicit user
// action, so there is no repeat-check pressure to throttle.
export function shouldCheckForUpdates(input: { isPackaged: boolean; state: UpdateState }): boolean {
  // The hard gate. `autoUpdater` refuses to run against an unpackaged app
  // anyway (it logs and resolves null), but relying on a third-party
  // library's own guard for something this consequential is not a guard.
  if (!input.isPackaged) return false
  // A check already in flight, or a download already running, makes a second
  // request pure waste -- the answer is on its way.
  if (input.state.status === 'checking' || input.state.status === 'downloading') return false
  // Already downloaded. There is nothing a network round trip could tell us
  // that we do not already have staged on disk. A MANUAL check in this state
  // still does something useful, but it happens in the reducer (it clears
  // `dismissed`, re-surfacing the banner) rather than on the network.
  if (input.state.status === 'ready') return false
  return true
}

// Starting a check is TWO decisions -- what the user should now see, and
// whether to do any network work -- and they MUST be made against the same
// snapshot of state. They are returned together, from one function, because
// making them separately in the wrong order is a defect this project already
// shipped: it disabled auto-update completely, and nothing detected it.
//
// The trap is genuinely easy to walk into, which is why the fix is structural
// rather than a comment. `check-started` resolves to `status: 'checking'`, and
// shouldCheckForUpdates rejects 'checking' as "a check is already in flight".
// So a caller that dispatches first and then consults the gate against its own
// updated state gets `false` every single time. Both halves are individually
// correct and individually tested; only their composition was wrong.
//
// Ordering here is the whole point: `shouldCheck` is computed from `state` as
// it stands on entry, BEFORE `next` is derived from it.
export function beginUpdateCheck(
  state: UpdateState,
  input: { manual: boolean; isPackaged: boolean; currentVersion: string }
): { next: UpdateState; shouldCheck: boolean } {
  const shouldCheck = shouldCheckForUpdates({ isPackaged: input.isPackaged, state })
  const next = reduceUpdateState(
    state,
    { type: 'check-started', manual: input.manual },
    input.currentVersion
  )
  return { next, shouldCheck }
}

// The whole state machine, as one pure function.
//
// `currentVersion` is the running app's own version (app.getVersion()),
// passed in rather than imported so this stays Electron-free.
export function reduceUpdateState(
  state: UpdateState,
  event: UpdateEvent,
  currentVersion: string
): UpdateState {
  switch (event.type) {
    case 'check-started':
      // An already-downloaded update SURVIVES a new check. Resetting to
      // 'checking' here would blank the restart banner the user was about to
      // click, and if the check then failed (offline) they would be left with
      // an update sitting on disk and no way to reach it.
      if (state.status === 'ready') {
        return { ...state, manual: event.manual, dismissed: false }
      }
      return { status: 'checking', version: null, manual: event.manual, dismissed: false }

    case 'update-available':
      if (!isNewerVersion(event.version, currentVersion)) return state
      return {
        status: 'downloading',
        version: event.version,
        manual: state.manual,
        dismissed: false
      }

    case 'update-not-available':
      if (state.status === 'ready') return state
      return {
        // Silent for the launch check, a visible "you are up to date" for a
        // manual one. This is the ONLY place `manual` changes anything.
        status: state.manual ? 'up-to-date' : 'idle',
        version: null,
        manual: state.manual,
        dismissed: false
      }

    case 'update-downloaded':
      if (!isNewerVersion(event.version, currentVersion)) return state
      return { status: 'ready', version: event.version, manual: state.manual, dismissed: false }

    case 'check-failed':
      // SILENT, unconditionally, for both automatic and manual checks. An
      // updater that nags on every launch because the user is offline -- or,
      // for this repo specifically, because the GitHub releases API 404s for
      // a PRIVATE repository -- is worse than no updater at all. There is no
      // 'error' status to render because there is nothing to render.
      //
      // A failure must also not erase an update that is already staged: a
      // second check going wrong is no reason to take away a working
      // restart button.
      if (state.status === 'ready') return state
      return { status: 'idle', version: null, manual: false, dismissed: false }

    case 'dismissed':
      return { ...state, dismissed: true }
  }
}

// The only thing the renderer branches on. Downloading is deliberately
// invisible (see UpdateStatus above); a dismissed notice stays dismissed
// until the next manual check clears the flag.
export function shouldShowUpdateBanner(state: UpdateState): boolean {
  if (state.dismissed) return false
  return state.status === 'ready' || state.status === 'up-to-date'
}

// Whether `quitAndInstall` may run. Checked in the MAIN process, not merely
// in the component that renders the button: the renderer can call any exposed
// IPC method with any arguments it likes, and this one replaces the user's
// installed application. `dismissed` deliberately does NOT block it -- a
// dismissed update is still a real, staged update, and this predicate answers
// "is there something to install", not "is a button on screen".
export function canInstallUpdate(state: UpdateState): boolean {
  return state.status === 'ready'
}
