import { beforeEach, describe, expect, it } from 'vitest'
import { initialFindState, useFindStore } from './findStore'

beforeEach(() => {
  useFindStore.setState(initialFindState)
})

describe('findStore', () => {
  // Mirrors appStore.test.ts's own convention: assert the live initial state
  // against the exported constant, so a silently changed default fails here
  // rather than passing every test that hand-duplicates the old values.
  it('starts at initialFindState', () => {
    expect(useFindStore.getState()).toMatchObject(initialFindState)
  })

  it('openFind opens the bar without expanding replace', () => {
    useFindStore.getState().openFind()
    expect(useFindStore.getState().isOpen).toBe(true)
    expect(useFindStore.getState().replaceExpanded).toBe(false)
  })

  it('openFindAndReplace opens the bar with replace expanded', () => {
    useFindStore.getState().openFindAndReplace()
    expect(useFindStore.getState().isOpen).toBe(true)
    expect(useFindStore.getState().replaceExpanded).toBe(true)
  })

  it('closeFind clears match state but keeps the query', () => {
    useFindStore.setState({
      isOpen: true,
      query: 'cat',
      matchCount: 4,
      activeIndex: 2,
      capped: true
    })
    useFindStore.getState().closeFind()
    const state = useFindStore.getState()
    expect(state.isOpen).toBe(false)
    expect(state.query).toBe('cat')
    expect(state.matchCount).toBe(0)
    expect(state.activeIndex).toBe(-1)
    expect(state.capped).toBe(false)
  })

  it('setQuery resets the cursor to the first match', () => {
    useFindStore.setState({ matchCount: 5, activeIndex: 3 })
    useFindStore.getState().setQuery('dog')
    expect(useFindStore.getState().query).toBe('dog')
    expect(useFindStore.getState().activeIndex).toBe(0)
  })

  it('toggling either option resets the cursor to the first match', () => {
    useFindStore.setState({ matchCount: 5, activeIndex: 3 })
    useFindStore.getState().toggleCaseSensitive()
    expect(useFindStore.getState().options.caseSensitive).toBe(true)
    expect(useFindStore.getState().activeIndex).toBe(0)

    useFindStore.setState({ activeIndex: 3 })
    useFindStore.getState().toggleWholeWord()
    expect(useFindStore.getState().options.wholeWord).toBe(true)
    expect(useFindStore.getState().activeIndex).toBe(0)
  })

  it('setMatches clamps an out-of-range cursor into the new list', () => {
    useFindStore.setState({ matchCount: 10, activeIndex: 7 })
    useFindStore.getState().setMatches(3, false)
    expect(useFindStore.getState().matchCount).toBe(3)
    expect(useFindStore.getState().activeIndex).toBe(0)
  })

  it('setMatches reports no cursor when there are no matches', () => {
    useFindStore.setState({ matchCount: 10, activeIndex: 7 })
    useFindStore.getState().setMatches(0, false)
    expect(useFindStore.getState().activeIndex).toBe(-1)
  })

  it('setMatches leaves an in-range cursor alone', () => {
    useFindStore.setState({ matchCount: 10, activeIndex: 7 })
    useFindStore.getState().setMatches(9, false)
    expect(useFindStore.getState().activeIndex).toBe(7)
  })

  it('goToNext wraps past the end', () => {
    useFindStore.setState({ matchCount: 3, activeIndex: 2 })
    useFindStore.getState().goToNext()
    expect(useFindStore.getState().activeIndex).toBe(0)
  })

  it('goToPrevious wraps past the start', () => {
    useFindStore.setState({ matchCount: 3, activeIndex: 0 })
    useFindStore.getState().goToPrevious()
    expect(useFindStore.getState().activeIndex).toBe(2)
  })

  it('goToPrevious from no cursor selects the last match', () => {
    useFindStore.setState({ matchCount: 3, activeIndex: -1 })
    useFindStore.getState().goToPrevious()
    expect(useFindStore.getState().activeIndex).toBe(2)
  })

  it('navigation is a no-op with no matches', () => {
    useFindStore.setState({ matchCount: 0, activeIndex: -1 })
    useFindStore.getState().goToNext()
    expect(useFindStore.getState().activeIndex).toBe(-1)
    useFindStore.getState().goToPrevious()
    expect(useFindStore.getState().activeIndex).toBe(-1)
  })
})
