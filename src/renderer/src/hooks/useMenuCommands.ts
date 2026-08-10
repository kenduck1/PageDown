import { useEffect, useRef } from 'react'
import type { MenuCommand } from '../../../menu/commands'

// Subscribes to the native application menu's commands and dispatches them
// through a handler map.
//
// PARTIAL BY DESIGN: every subscriber receives every command and silently
// ignores the ones it has no handler for. That is what lets the handlers live
// where the actions already do -- App.tsx owns New/Open/Preferences (they are
// meaningful on every screen), EditorScreen owns Save/Export/Find/view modes
// (they need editorRef, the find controller, and this screen's own zoom
// state). The alternative -- one central switch -- would have to reach into
// another component's refs to do half of it.
//
// The alternative shape, a `command` string plus a `switch` at each call
// site, was rejected for a concrete reason: a `Partial<Record<MenuCommand, …>>`
// makes a typo a compile error, and adding a command to MENU_COMMANDS without
// wiring it anywhere stays visible as a command with no handler rather than
// as a `default:` case that quietly does nothing.
export type MenuCommandHandlers = Partial<Record<MenuCommand, (payload?: string) => void>>

export function useMenuCommands(handlers: MenuCommandHandlers): void {
  // Latest-ref, matching MilkdownEditor.tsx's own onChangeRef/onErrorRef
  // convention (and Toast's dismiss timer). Call sites pass a fresh inline
  // object literal on every render; depending on it directly would tear down
  // and re-register the IPC listener on EVERY render of the editor screen --
  // i.e. on every keystroke -- which is both wasteful and a real window in
  // which a command could arrive with nothing listening.
  const handlersRef = useRef(handlers)
  useEffect(() => {
    handlersRef.current = handlers
  })

  useEffect(() => {
    // The returned unsubscribe is the whole reason the preload API returns
    // one: EditorScreen is remounted by ordinary navigation, and the
    // subscription would otherwise accumulate one live listener per mount for
    // the life of the window.
    const unsubscribe = window.api.onMenuCommand((command, payload) => {
      handlersRef.current[command]?.(payload)
    })
    return unsubscribe
  }, [])
}
