import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installGlobalErrorHandlers } from './global-errors'
import { useDocumentStore, initialDocumentState } from '../store/documentStore'

// Covers the failures a React error boundary structurally cannot see: anything
// thrown outside a render, and every unhandled promise rejection. The app had
// neither handler before, which is how `window.prompt` throwing in Electron
// could leave Insert-link "completely dead ... with nothing surfaced anywhere"
// (appStore.ts's own note).

let uninstall: (() => void) | null = null

beforeEach(() => {
  useDocumentStore.setState(initialDocumentState)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  uninstall = installGlobalErrorHandlers()
})

afterEach(() => {
  uninstall?.()
  uninstall = null
  vi.restoreAllMocks()
})

describe('installGlobalErrorHandlers', () => {
  it("surfaces an uncaught error through the app's existing error banner", () => {
    window.dispatchEvent(
      new ErrorEvent('error', { error: new Error('boom outside render'), message: 'boom' })
    )

    expect(useDocumentStore.getState().error).toContain('boom outside render')
    expect(console.error).toHaveBeenCalled()
  })

  it('surfaces an unhandled promise rejection too', () => {
    // jsdom does not fire `unhandledrejection` on its own, so the event is
    // dispatched directly -- what is under test is the listener, not
    // jsdom's promise bookkeeping.
    const event = new Event('unhandledrejection') as Event & { reason: unknown }
    event.reason = new Error('rejected somewhere')
    window.dispatchEvent(event)

    expect(useDocumentStore.getState().error).toContain('rejected somewhere')
  })

  it('does not itself throw on a reason that cannot be stringified', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const event = new Event('unhandledrejection') as Event & { reason: unknown }
    event.reason = circular

    expect(() => window.dispatchEvent(event)).not.toThrow()
    expect(useDocumentStore.getState().error).not.toBeNull()
  })

  it('stops reporting once uninstalled', () => {
    uninstall?.()
    uninstall = null

    // Driven through the rejection path rather than the 'error' one: an
    // ErrorEvent dispatched with no listener left is escalated by jsdom into a
    // real uncaught exception, which would fail the run for the wrong reason.
    const event = new Event('unhandledrejection') as Event & { reason: unknown }
    event.reason = new Error('after uninstall')
    window.dispatchEvent(event)

    expect(useDocumentStore.getState().error).toBeNull()
  })
})
