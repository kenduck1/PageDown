import { describe, expect, it } from 'vitest'
import {
  INITIAL_UPDATE_STATE,
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
