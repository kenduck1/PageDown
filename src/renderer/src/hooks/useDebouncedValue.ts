import { useEffect, useState } from 'react'

/**
 * Returns `value`, but only advances to a NEW value after `delayMs` has
 * elapsed with no further change -- a fast burst of updates (the canonical
 * case: every keystroke of typing) collapses into whichever value was
 * current once the burst actually paused, instead of propagating every
 * intermediate one.
 *
 * Seeded directly from `value` via `useState(value)`, not `null`/a sentinel,
 * so the FIRST render already reflects the real current value with no
 * artificial delay -- only a SUBSEQUENT change to `value` while this stays
 * mounted is debounced. This matters for every caller here: a freshly opened
 * document (or a freshly switched-to tab) must show its real word count/
 * outline/remote-image state immediately, not a stale placeholder for
 * `delayMs`. The cost this accepts in exchange -- switching tabs shows the
 * PREVIOUS tab's derived value for up to `delayMs` before the new one
 * settles, since a tab switch is just another `value` change with nothing to
 * distinguish it from an ordinary edit -- mirrors `usePageCount`'s own
 * accepted tradeoff (see that hook's comment): both hooks debounce every
 * `value` change uniformly rather than special-casing "this change means a
 * different document," and both accept a few hundred ms of stale-but-honest
 * display in exchange for not needing a second identity input (e.g. a tab
 * id) threaded through every call site just to bypass the debounce on that
 * one transition.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}
