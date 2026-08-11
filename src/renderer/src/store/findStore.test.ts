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

  // Product-completeness audit 2.4. Nothing used to clear this store when the
  // editor moved to a different document -- closeFind was the only writer that
  // reset the derived fields, and all three of its call sites are "the user
  // closed the bar". So the bar kept advertising the previous document's
  // count, and (worse) the cursor kept indexing the previous document's match
  // list, which is what sent the first Find Next somewhere arbitrary.
  it('resetForDocument drops the derived match state but keeps everything typed', () => {
    useFindStore.setState({
      isOpen: true,
      replaceExpanded: true,
      query: 'cat',
      replacement: 'dog',
      options: { caseSensitive: true, wholeWord: true },
      matchCount: 12,
      activeIndex: 3,
      capped: true
    })
    useFindStore.getState().resetForDocument()
    const state = useFindStore.getState()
    // Dropped: everything that described the OLD document's text.
    expect(state.matchCount).toBe(0)
    expect(state.activeIndex).toBe(-1)
    expect(state.capped).toBe(false)
    // Kept: everything the user typed or chose. Switching documents mid-search
    // means "find this same thing over here", so the bar stays open with the
    // query intact -- the same reasoning closeFind already uses.
    expect(state.isOpen).toBe(true)
    expect(state.replaceExpanded).toBe(true)
    expect(state.query).toBe('cat')
    expect(state.replacement).toBe('dog')
    expect(state.options).toEqual({ caseSensitive: true, wholeWord: true })
  })

  it('a reset cursor lands on the FIRST match once the new surface republishes', () => {
    // -1 rather than 0 is load-bearing: -1 is the only correct value while the
    // count is 0, and setMatches' own clamp turns it into 0 the moment the new
    // document reports matches. Asserting the pair together is what proves the
    // reset cannot leave a dangling index.
    useFindStore.setState({ matchCount: 12, activeIndex: 9 })
    useFindStore.getState().resetForDocument()
    useFindStore.getState().setMatches(4, false)
    expect(useFindStore.getState().activeIndex).toBe(0)
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
