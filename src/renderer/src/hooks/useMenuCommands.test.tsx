import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, render } from '@testing-library/react'
import { useMenuCommands, type MenuCommandHandlers } from './useMenuCommands'
import type { MenuCommand } from '../../../menu/commands'

let registered: Array<(command: MenuCommand, payload?: string) => void> = []
const unsubscribe = vi.fn()

function Harness({ handlers }: { handlers: MenuCommandHandlers }): React.JSX.Element {
  useMenuCommands(handlers)
  return <div />
}

function emit(command: MenuCommand, payload?: string): void {
  act(() => {
    for (const callback of registered) callback(command, payload)
  })
}

beforeEach(() => {
  registered = []
  unsubscribe.mockClear()
  window.api = {
    ...window.api,
    onMenuCommand: vi.fn((callback) => {
      registered.push(callback)
      return unsubscribe
    })
  } as typeof window.api
})

afterEach(() => {
  cleanup()
})

describe('useMenuCommands', () => {
  it('dispatches a command to its handler, with the payload', () => {
    const openRecent = vi.fn()
    render(<Harness handlers={{ 'file:openRecent': openRecent }} />)

    emit('file:openRecent', '/tmp/report.md')

    expect(openRecent).toHaveBeenCalledWith('/tmp/report.md')
  })

  it('silently ignores a command with no handler', () => {
    // Every subscriber receives every command -- App.tsx handles file:new,
    // EditorScreen does not -- so a missing handler must be a no-op rather
    // than a crash on `undefined(...)`.
    render(<Harness handlers={{ 'file:save': vi.fn() }} />)
    expect(() => emit('view:zoomIn')).not.toThrow()
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = render(<Harness handlers={{}} />)
    expect(unsubscribe).not.toHaveBeenCalled()

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('subscribes exactly ONCE across re-renders, not once per render', () => {
    // The latest-ref is what makes this true: call sites pass a fresh inline
    // handler object every render, and depending on it directly would tear
    // down and re-register the IPC listener on every keystroke in the editor.
    const { rerender } = render(<Harness handlers={{ 'file:save': vi.fn() }} />)
    rerender(<Harness handlers={{ 'file:save': vi.fn() }} />)
    rerender(<Harness handlers={{ 'file:save': vi.fn() }} />)

    expect(window.api.onMenuCommand).toHaveBeenCalledTimes(1)
    expect(unsubscribe).not.toHaveBeenCalled()
  })

  it('runs the LATEST handler, not the one captured at subscribe time', () => {
    // The other half of the latest-ref contract: subscribing once must not
    // freeze the handlers, or a command would act on stale closure state
    // (e.g. Save writing the content from the render that first mounted).
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<Harness handlers={{ 'file:save': first }} />)
    rerender(<Harness handlers={{ 'file:save': second }} />)

    emit('file:save')

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
