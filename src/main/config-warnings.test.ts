import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  recordConfigWarning,
  drainConfigWarnings,
  resetConfigWarningsForTest
} from './config-warnings'

beforeEach(() => {
  resetConfigWarningsForTest()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  resetConfigWarningsForTest()
})

describe('config warnings', () => {
  it('collects warnings and hands them to the first caller that drains', () => {
    recordConfigWarning('first')
    recordConfigWarning('second')

    expect(drainConfigWarnings()).toEqual(['first', 'second'])
  })

  it('drains once -- a later caller gets nothing', () => {
    recordConfigWarning('only once')

    expect(drainConfigWarnings()).toEqual(['only once'])
    // A second window opening later must not re-surface a notice the user has
    // already been shown and cannot act on twice.
    expect(drainConfigWarnings()).toEqual([])
  })

  it('dedupes a repeated message, including across a drain', () => {
    // isKnownPath re-reads recent-files.json on EVERY renderer-supplied-path
    // validation, so a corrupt file records the same warning dozens of times
    // per session. Deduping only until the next drain would still let a second
    // window re-show it.
    recordConfigWarning('same message')
    recordConfigWarning('same message')
    expect(drainConfigWarnings()).toEqual(['same message'])

    recordConfigWarning('same message')
    expect(drainConfigWarnings()).toEqual([])
  })

  it('always logs to the console, which is the floor if nothing ever drains', () => {
    recordConfigWarning('logged')

    expect(console.warn).toHaveBeenCalledWith('[PageDown] logged')
  })
})
