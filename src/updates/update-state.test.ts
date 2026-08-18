import { describe, expect, it } from 'vitest'
import {
  INITIAL_UPDATE_STATE,
  beginUpdateCheck,
  canInstallUpdate,
  compareVersions,
  isNewerVersion,
  reduceUpdateState,
  shouldCheckForUpdates,
  shouldShowUpdateBanner,
  type UpdateEvent,
  type UpdateState
} from './update-state'

const CURRENT = '0.1.0'

function reduce(state: UpdateState, ...events: UpdateEvent[]): UpdateState {
  return events.reduce((acc, event) => reduceUpdateState(acc, event, CURRENT), state)
}

describe('compareVersions', () => {
  it('orders release components numerically, not lexically', () => {
    // The lexical trap: '10' < '9' as strings.
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    expect(compareVersions('0.1.0', '0.1.1')).toBe(-1)
  })

  it('treats a missing component as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1', '1.0.0')).toBe(0)
  })

  it('tolerates a leading v and ignores build metadata', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3+abc123', '1.2.3+def456')).toBe(0)
  })

  it('ranks a prerelease below its own release', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBe(1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1)
    expect(compareVersions('1.0.0-beta', '1.0.0-beta.1')).toBe(-1)
  })

  it('returns null rather than guessing for an unparseable version', () => {
    expect(compareVersions('', '1.0.0')).toBeNull()
    expect(compareVersions('not-a-version', '1.0.0')).toBeNull()
    expect(compareVersions('1.0.0', '   ')).toBeNull()
  })
})

describe('isNewerVersion', () => {
  it('is true only for a genuine upgrade', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true)
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.0.9', '0.1.0')).toBe(false)
  })

  it('fails closed on anything it cannot parse', () => {
    expect(isNewerVersion('latest', '0.1.0')).toBe(false)
    expect(isNewerVersion('', '0.1.0')).toBe(false)
  })
})

describe('shouldCheckForUpdates', () => {
  it('never runs against an unpackaged app', () => {
    expect(shouldCheckForUpdates({ isPackaged: false, state: INITIAL_UPDATE_STATE })).toBe(false)
  })

  it('runs from a packaged, idle app', () => {
    expect(shouldCheckForUpdates({ isPackaged: true, state: INITIAL_UPDATE_STATE })).toBe(true)
  })

  it('does not stack a second check on an in-flight one', () => {
    for (const status of ['checking', 'downloading'] as const) {
      expect(
        shouldCheckForUpdates({
          isPackaged: true,
          state: { ...INITIAL_UPDATE_STATE, status }
        })
      ).toBe(false)
    }
  })

  it('does not re-check once an update is already staged', () => {
    expect(
      shouldCheckForUpdates({
        isPackaged: true,
        state: { status: 'ready', version: '0.2.0', manual: false, dismissed: false }
      })
    ).toBe(false)
  })

  // Pins the interaction that made this gate reject every real check. It is
  // stated as its own test because the value is the EXPLANATION: the state
  // `check-started` produces always fails this gate, so anything that
  // dispatches first and gates afterwards can never check for updates.
  it('rejects the very state that check-started produces', () => {
    const afterDispatch = reduce(INITIAL_UPDATE_STATE, { type: 'check-started', manual: false })
    expect(afterDispatch.status).toBe('checking')
    expect(shouldCheckForUpdates({ isPackaged: true, state: afterDispatch })).toBe(false)
    // ...while the same gate, asked about the state as it stood BEFORE that
    // dispatch, permits it. Both answers are correct; only the choice of which
    // snapshot to ask about is not.
    expect(shouldCheckForUpdates({ isPackaged: true, state: INITIAL_UPDATE_STATE })).toBe(true)
  })

  it('runs again after a previous check was silently abandoned', () => {
    const afterFailure = reduce(
      INITIAL_UPDATE_STATE,
      { type: 'check-started', manual: false },
      {
        type: 'check-failed'
      }
    )
    expect(shouldCheckForUpdates({ isPackaged: true, state: afterFailure })).toBe(true)
  })
})

// The actual regression guard for the auto-update outage. shouldCheckForUpdates
// and reduceUpdateState were each correct and each tested; the bug lived purely
// in the ORDER a caller combined them, in src/main/updater.ts -- a module that
// cannot be unit-tested at all (importing it outside Electron throws, because
// electron-updater's `autoUpdater` export is a lazy getter that reads
// app.getVersion() on first access). So the composition was moved in here,
// where it can be tested, rather than left as a comment asking future callers
// to remember the ordering.
describe('beginUpdateCheck', () => {
  it('permits a real check from a packaged, idle app while still moving to checking', () => {
    const { next, shouldCheck } = beginUpdateCheck(INITIAL_UPDATE_STATE, {
      manual: false,
      isPackaged: true,
      currentVersion: CURRENT
    })
    // This is the assertion that fails if the gate is ever evaluated against
    // the post-dispatch state again -- the exact defect that shipped, where
    // this was false on every call and no update check ever ran.
    expect(shouldCheck).toBe(true)
    expect(next.status).toBe('checking')
  })

  it('still refuses network work for an unpackaged app', () => {
    const { shouldCheck } = beginUpdateCheck(INITIAL_UPDATE_STATE, {
      manual: false,
      isPackaged: false,
      currentVersion: CURRENT
    })
    expect(shouldCheck).toBe(false)
  })

  it('does no network work when an update is already staged, but still clears the dismissal', () => {
    const staged: UpdateState = {
      status: 'ready',
      version: '0.2.0',
      manual: false,
      dismissed: true
    }
    const { next, shouldCheck } = beginUpdateCheck(staged, {
      manual: true,
      isPackaged: true,
      currentVersion: CURRENT
    })
    // Both halves matter: a staged update needs no round trip, but the manual
    // check must still re-surface the banner the user clicked "Later" on --
    // which is the whole reason the dispatch happens even when the gate says
    // no, and therefore the reason the two decisions are entangled at all.
    expect(shouldCheck).toBe(false)
    expect(next.status).toBe('ready')
    expect(next.dismissed).toBe(false)
  })

  it('does not stack a second check on one already in flight', () => {
    const { shouldCheck } = beginUpdateCheck(
      { ...INITIAL_UPDATE_STATE, status: 'checking' },
      { manual: false, isPackaged: true, currentVersion: CURRENT }
    )
    expect(shouldCheck).toBe(false)
  })
})

describe('reduceUpdateState', () => {
  it('downloads in the background without showing anything', () => {
    const state = reduce(
      INITIAL_UPDATE_STATE,
      { type: 'check-started', manual: false },
      { type: 'update-available', version: '0.2.0' }
    )
    expect(state.status).toBe('downloading')
    expect(state.version).toBe('0.2.0')
    expect(shouldShowUpdateBanner(state)).toBe(false)
  })

  it('offers to restart only once the download has landed', () => {
    const state = reduce(
      INITIAL_UPDATE_STATE,
      { type: 'check-started', manual: false },
      { type: 'update-available', version: '0.2.0' },
      { type: 'update-downloaded', version: '0.2.0' }
    )
    expect(state.status).toBe('ready')
    expect(shouldShowUpdateBanner(state)).toBe(true)
    expect(canInstallUpdate(state)).toBe(true)
  })

  it('ignores an update that is not actually newer than the running app', () => {
    const checking = reduce(INITIAL_UPDATE_STATE, { type: 'check-started', manual: false })
    // A rolled-back or misconfigured feed advertising the running version, or
    // an older one, must never produce an install offer.
    expect(reduce(checking, { type: 'update-available', version: CURRENT })).toEqual(checking)
    expect(reduce(checking, { type: 'update-downloaded', version: '0.0.1' }).status).toBe(
      'checking'
    )
  })

  describe('a failed check surfaces nothing', () => {
    it('lands back on idle with nothing to render, for an automatic check', () => {
      const state = reduce(
        INITIAL_UPDATE_STATE,
        { type: 'check-started', manual: false },
        { type: 'check-failed' }
      )
      expect(state).toEqual(INITIAL_UPDATE_STATE)
      expect(shouldShowUpdateBanner(state)).toBe(false)
    })

    it('surfaces nothing for a MANUAL check either', () => {
      // The stricter half: a manual check that fails is exactly when a naive
      // implementation would show an error, and the design says it must not.
      const state = reduce(
        INITIAL_UPDATE_STATE,
        { type: 'check-started', manual: true },
        { type: 'check-failed' }
      )
      expect(state.status).toBe('idle')
      expect(shouldShowUpdateBanner(state)).toBe(false)
    })

    it('does not take away an update that is already staged', () => {
      const ready = reduce(
        INITIAL_UPDATE_STATE,
        { type: 'check-started', manual: false },
        { type: 'update-available', version: '0.2.0' },
        { type: 'update-downloaded', version: '0.2.0' }
      )
      const afterFailedRecheck = reduce(
        ready,
        { type: 'check-started', manual: true },
        { type: 'check-failed' }
      )
      expect(afterFailedRecheck.status).toBe('ready')
      expect(shouldShowUpdateBanner(afterFailedRecheck)).toBe(true)
    })
  })

  describe('up-to-date is manual-only', () => {
    it('says nothing when the LAUNCH check finds nothing', () => {
      const state = reduce(
        INITIAL_UPDATE_STATE,
        { type: 'check-started', manual: false },
        { type: 'update-not-available' }
      )
      expect(state.status).toBe('idle')
      expect(shouldShowUpdateBanner(state)).toBe(false)
    })

    it('reports back when the user asked', () => {
      const state = reduce(
        INITIAL_UPDATE_STATE,
        { type: 'check-started', manual: true },
        { type: 'update-not-available' }
      )
      expect(state.status).toBe('up-to-date')
      expect(shouldShowUpdateBanner(state)).toBe(true)
      // ...but "up to date" is not something that can be installed.
      expect(canInstallUpdate(state)).toBe(false)
    })
  })

  describe('dismissal', () => {
    const ready = reduce(
      INITIAL_UPDATE_STATE,
      { type: 'check-started', manual: false },
      { type: 'update-available', version: '0.2.0' },
      { type: 'update-downloaded', version: '0.2.0' }
    )

    it('hides the banner without discarding the staged update', () => {
      const dismissed = reduce(ready, { type: 'dismissed' })
      expect(shouldShowUpdateBanner(dismissed)).toBe(false)
      expect(dismissed.status).toBe('ready')
      // The install itself is still legal -- dismissal is about the row, not
      // about whether an update exists.
      expect(canInstallUpdate(dismissed)).toBe(true)
    })

    it('is undone by a manual check, which is the only way back to the banner', () => {
      const dismissed = reduce(ready, { type: 'dismissed' })
      const rechecked = reduce(dismissed, { type: 'check-started', manual: true })
      expect(rechecked.status).toBe('ready')
      expect(shouldShowUpdateBanner(rechecked)).toBe(true)
    })
  })
})

describe('canInstallUpdate', () => {
  it('refuses every status except a genuinely staged update', () => {
    for (const status of ['idle', 'checking', 'downloading', 'up-to-date'] as const) {
      expect(canInstallUpdate({ ...INITIAL_UPDATE_STATE, status })).toBe(false)
    }
    expect(canInstallUpdate({ ...INITIAL_UPDATE_STATE, status: 'ready' })).toBe(true)
  })
})
