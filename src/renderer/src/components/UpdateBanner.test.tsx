import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import UpdateBanner from './UpdateBanner'
import type { UpdateState } from '../../../updates/update-state'

// Only the four update entries are stubbed, not a whole FileApi: this
// component touches nothing else on window.api, and a full fixture here would
// be 40 lines of noise that says nothing about what is being tested.
type UpdateApi = Pick<
  typeof window.api,
  'onUpdateState' | 'getUpdateState' | 'installUpdate' | 'dismissUpdateNotice'
>

let push: ((state: UpdateState) => void) | null = null

const READY: UpdateState = {
  status: 'ready',
  version: '0.2.0',
  manual: false,
  dismissed: false
}

function stubApi(initial: UpdateState): void {
  const api: UpdateApi = {
    onUpdateState: vi.fn((callback: (state: UpdateState) => void) => {
      push = callback
      return () => {
        push = null
      }
    }),
    getUpdateState: vi.fn().mockResolvedValue(initial),
    installUpdate: vi.fn().mockResolvedValue(true),
    dismissUpdateNotice: vi.fn().mockResolvedValue(undefined)
  }
  window.api = api as unknown as typeof window.api
}

beforeEach(() => {
  push = null
  stubApi({ status: 'idle', version: null, manual: false, dismissed: false })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('UpdateBanner', () => {
  it('renders nothing at all while there is no update to act on', async () => {
    render(<UpdateBanner />)
    // Every status short of a downloaded update is invisible -- including
    // 'downloading', which is the whole point of downloading in the
    // background: a document editor must not interrupt.
    for (const status of ['idle', 'checking', 'downloading'] as const) {
      act(() =>
        push?.({
          status,
          version: status === 'downloading' ? '0.2.0' : null,
          manual: false,
          dismissed: false
        })
      )
      await waitFor(() => {
        expect(screen.queryByRole('group', { name: 'Update available' })).toBeNull()
      })
      expect(screen.queryByRole('button', { name: 'Restart & Install' })).toBeNull()
    }
  })

  describe('a failed check surfaces nothing', () => {
    // The renderer half of the design's hardest rule. The reducer already
    // guarantees a failure never produces a visible status (see
    // update-state.test.ts); this pins that the COMPONENT has no error path
    // of its own either -- no error prop, no catch-and-render, nothing that
    // could reintroduce a nag on a machine that is simply offline (or, for
    // this repo today, pointed at a private repository's 404ing release API).
    it('shows no banner and no error when a check fails from idle', async () => {
      render(<UpdateBanner />)
      act(() => push?.({ status: 'checking', version: null, manual: true, dismissed: false }))
      // What main dispatches for a failure: straight back to idle.
      act(() => push?.({ status: 'idle', version: null, manual: false, dismissed: false }))
      await waitFor(() => {
        expect(screen.queryByRole('group')).toBeNull()
      })
      expect(screen.queryByRole('status')).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(document.body.textContent).toBe('')
    })

    it('keeps offering an already-staged update when a later check fails', async () => {
      render(<UpdateBanner />)
      act(() => push?.(READY))
      expect(await screen.findByRole('button', { name: 'Restart & Install' })).toBeInTheDocument()
      // A failed re-check leaves `ready` untouched (reducer's own rule) -- so
      // the banner must still be there. Taking away a working restart button
      // because the network blipped would be a real regression.
      act(() => push?.({ ...READY, manual: true }))
      expect(screen.getByRole('button', { name: 'Restart & Install' })).toBeInTheDocument()
    })
  })

  it('offers to restart once an update is downloaded, naming the version', async () => {
    render(<UpdateBanner />)
    act(() => push?.(READY))
    expect(await screen.findByText('PageDown 0.2.0 is ready to install.')).toBeInTheDocument()
    // A layout row (a real element in the flow), not a floating overlay --
    // see the component's own module comment for why that is architectural.
    // `position: fixed` would be the regression to catch.
    const banner = screen.getByRole('group', { name: 'Update available' })
    expect(banner.className).not.toContain('fixed')
    expect(banner.className).not.toContain('absolute')
  })

  it('installs only on an explicit click, never on its own', async () => {
    const user = userEvent.setup()
    render(<UpdateBanner />)
    act(() => push?.(READY))
    await screen.findByRole('button', { name: 'Restart & Install' })
    // Nothing has been installed merely by an update becoming available.
    expect(window.api.installUpdate).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Restart & Install' }))
    expect(window.api.installUpdate).toHaveBeenCalledTimes(1)
  })

  it('hides on Later without discarding the update', async () => {
    const user = userEvent.setup()
    render(<UpdateBanner />)
    act(() => push?.(READY))
    await screen.findByRole('button', { name: 'Later' })
    await user.click(screen.getByRole('button', { name: 'Later' }))

    expect(window.api.dismissUpdateNotice).toHaveBeenCalledTimes(1)
    // Dismissal is main's decision to record and broadcast back, not a local
    // hide -- so the row is still up until that lands. This is what lets a
    // second window agree with the first, and what lets a later manual check
    // bring the banner back.
    expect(window.api.installUpdate).not.toHaveBeenCalled()
    act(() => push?.({ ...READY, dismissed: true }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Restart & Install' })).toBeNull()
    })
  })

  it('acknowledges a manual check that found nothing, then gets out of the way', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<UpdateBanner />)
    act(() => push?.({ status: 'up-to-date', version: null, manual: true, dismissed: false }))
    expect(await screen.findByText('PageDown is up to date.')).toBeInTheDocument()
    // It carries no action, so it retires itself rather than needing to be
    // dismissed -- unlike the restart offer, which must not vanish under the
    // user.
    expect(window.api.dismissUpdateNotice).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(window.api.dismissUpdateNotice).toHaveBeenCalledTimes(1)
  })

  it('adopts the state a window missed while it was starting up', async () => {
    // A second window (or a slow first paint) mounts after main has already
    // broadcast. Without the one-shot fetch this component would sit on the
    // initial state forever while every other window offered the update.
    stubApi(READY)
    render(<UpdateBanner />)
    expect(await screen.findByRole('button', { name: 'Restart & Install' })).toBeInTheDocument()
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = render(<UpdateBanner />)
    expect(push).not.toBeNull()
    unmount()
    // App remounts nothing here today, but the contract is the same one
    // onMenuCommand documents: a bridged callback is never reference-identical
    // to the one passed, so the returned unsubscribe is the only way off.
    expect(push).toBeNull()
  })
})
