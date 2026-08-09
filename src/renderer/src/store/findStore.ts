import { create } from 'zustand'
import type { FindOptions } from '../lib/find-matches'

// A THIRD store, deliberately, rather than more fields on appStore. The
// counter-precedent is real and worth naming: pageSetupOpen lives in appStore
// and has the same "toolbar opens it, EditorScreen renders it" shape. But
// appStore is documented as UI-only NAVIGATION/VIEW-MODE state, and a query
// string, a replacement string, two matcher options, a live match count and a
// match cursor are none of those -- they are one feature's working state, and
// folding them in would roughly double that store's surface (and its
// initialAppState equality assertion) with fields no navigation code will ever
// read. documentStore is the standing precedent for splitting a coherent
// concern out rather than growing appStore. initialFindState is exported and
// asserted the same way initialAppState is, so the regression that convention
// exists to catch is caught here too.
interface FindStateValues {
  isOpen: boolean
  replaceExpanded: boolean
  query: string
  replacement: string
  options: FindOptions
  // Published by whichever surface is active (see useFindController) -- this
  // store never computes matches itself, because the two surfaces search
  // genuinely different text.
  matchCount: number
  // -1 means "no cursor", which is the only correct value when matchCount is
  // 0. Never let this be 0 with an empty match list: every consumer treats a
  // non-negative index as addressable.
  activeIndex: number
  // matchCount hit MAX_MATCHES and the real total is unknown.
  capped: boolean
}

interface FindState extends FindStateValues {
  openFind: () => void
  openFindAndReplace: () => void
  closeFind: () => void
  setQuery: (query: string) => void
  setReplacement: (replacement: string) => void
  toggleCaseSensitive: () => void
  toggleWholeWord: () => void
  toggleReplaceExpanded: () => void
  setMatches: (count: number, capped: boolean) => void
  goToNext: () => void
  goToPrevious: () => void
}

export const initialFindState: FindStateValues = {
  isOpen: false,
  replaceExpanded: false,
  query: '',
  replacement: '',
  options: { caseSensitive: false, wholeWord: false },
  matchCount: 0,
  activeIndex: -1,
  capped: false
}

// Changing the query or either option recomputes the match list wholesale, so
// there is no meaningful old position to preserve -- typing jumps to the
// first match, live, on every keystroke. Kept as one helper so all three call
// sites provably agree.
const CURSOR_RESET = { activeIndex: 0 }

export const useFindStore = create<FindState>()((set) => ({
  ...initialFindState,
  openFind: () => set({ isOpen: true }),
  openFindAndReplace: () => set({ isOpen: true, replaceExpanded: true }),
  // The query survives a close so reopening remembers it (every editor does
  // this); the derived match state does NOT, so a stale count can never be
  // read by whatever reopens the bar before the controller has re-run.
  closeFind: () => set({ isOpen: false, matchCount: 0, activeIndex: -1, capped: false }),
  setQuery: (query) => set({ query, ...CURSOR_RESET }),
  setReplacement: (replacement) => set({ replacement }),
  toggleCaseSensitive: () =>
    set((state) => ({
      options: { ...state.options, caseSensitive: !state.options.caseSensitive },
      ...CURSOR_RESET
    })),
  toggleWholeWord: () =>
    set((state) => ({
      options: { ...state.options, wholeWord: !state.options.wholeWord },
      ...CURSOR_RESET
    })),
  toggleReplaceExpanded: () => set((state) => ({ replaceExpanded: !state.replaceExpanded })),
  // Clamping here rather than at each call site is what keeps activeIndex a
  // genuinely addressable index at all times: the document can shrink under a
  // live cursor (an edit deleting matched text, or a Replace All), and a
  // dangling index would read undefined out of the match array.
  setMatches: (count, capped) =>
    set((state) => ({
      matchCount: count,
      capped,
      activeIndex:
        count === 0
          ? -1
          : state.activeIndex < 0 || state.activeIndex >= count
            ? 0
            : state.activeIndex
    })),
  goToNext: () =>
    set((state) =>
      state.matchCount === 0 ? {} : { activeIndex: (state.activeIndex + 1) % state.matchCount }
    ),
  goToPrevious: () =>
    set((state) => {
      if (state.matchCount === 0) return {}
      // From "no cursor" (-1), Previous means the LAST match, not the
      // second-to-last -- which is what the plain modular formula below would
      // give ((-1 - 1 + n) % n === n - 2).
      if (state.activeIndex < 0) return { activeIndex: state.matchCount - 1 }
      return { activeIndex: (state.activeIndex - 1 + state.matchCount) % state.matchCount }
    })
}))
