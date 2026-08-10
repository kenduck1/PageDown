import { describe, expect, it } from 'vitest'
import { MENU_COMMANDS, isMenuCommand } from './commands'

describe('isMenuCommand', () => {
  it('accepts every command in the shared list', () => {
    for (const command of MENU_COMMANDS) {
      expect(isMenuCommand(command)).toBe(true)
    }
  })

  it('rejects a string that is not a known command', () => {
    // The whole point of the guard: the preload layer runs it on whatever
    // actually arrives over IPC, so an unknown channel payload can never
    // reach a renderer handler-map lookup.
    expect(isMenuCommand('file:deleteEverything')).toBe(false)
    expect(isMenuCommand('')).toBe(false)
  })

  it('rejects non-strings without throwing', () => {
    // `typeof value === 'string'` first, deliberately -- an object payload
    // would otherwise reach Array.prototype.includes, which is harmless here
    // but would be a real crash if this guard ever grew a `.startsWith`.
    expect(isMenuCommand(undefined)).toBe(false)
    expect(isMenuCommand(null)).toBe(false)
    expect(isMenuCommand({ command: 'file:save' })).toBe(false)
    expect(isMenuCommand(42)).toBe(false)
  })

  it('has no duplicate entries', () => {
    // A duplicate would be invisible everywhere else (the union type dedupes,
    // and includes() does not care) while silently doubling any future
    // iteration over the list.
    expect(new Set(MENU_COMMANDS).size).toBe(MENU_COMMANDS.length)
  })
})
