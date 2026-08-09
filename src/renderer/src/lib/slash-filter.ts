// Ranks and filters slash-menu items against the live query. Pure and
// Milkdown-free, same reasoning as slash-query.ts -- the ranking rules ARE
// the feature's correctness (which item ends up first as the user types),
// so they belong in a plain-data function directly testable with array
// literals rather than a real palette component.

/** The minimum shape filterSlashItems needs to rank an item. */
export interface SlashFilterable {
  label: string
  keywords: string[]
}

/**
 * Case-insensitive filter/rank of `items` against `query`:
 *   1. label starts with the query
 *   2. label contains the query, but doesn't start with it
 *   3. some keyword contains the query
 * An item that matches none of the three is dropped. An empty query is a
 * pass-through (every item, unfiltered, in its original order) -- there is
 * no "query" to rank against yet, matching the palette's own opened-with-no-
 * text-typed state.
 *
 * Implemented as three concatenated buckets rather than a single pass with
 * a numeric rank + `Array.prototype.sort`. Both are stable in modern JS
 * (sort has been spec-required stable since ES2019), but concatenation
 * makes that guarantee structural rather than borrowed from the sort
 * implementation: each bucket is built with one forward pass over `items`
 * via `Array.prototype.push`, which is unconditionally order-preserving, so
 * "stable order within a rank" holds by construction and needs no reliance
 * on `sort`'s stability contract at all.
 *
 * Note this doesn't need find-matches.ts's RegExp-over-toLowerCase-indexOf
 * trick: that trick exists to keep MATCH OFFSETS valid when case-folding
 * changes a string's length (e.g. 'İ'.toLowerCase() is two UTF-16 units).
 * filterSlashItems never returns an offset into anything -- only whether an
 * item qualifies, and for which bucket -- so a plain `.toLowerCase()` +
 * `.startsWith()`/`.includes()` comparison is exact for this use.
 */
export function filterSlashItems<T extends SlashFilterable>(items: T[], query: string): T[] {
  if (query === '') return [...items]

  const needle = query.toLowerCase()
  const prefixMatches: T[] = []
  const substringMatches: T[] = []
  const keywordMatches: T[] = []

  for (const item of items) {
    const label = item.label.toLowerCase()
    if (label.startsWith(needle)) {
      prefixMatches.push(item)
    } else if (label.includes(needle)) {
      substringMatches.push(item)
    } else if (item.keywords.some((keyword) => keyword.toLowerCase().includes(needle))) {
      keywordMatches.push(item)
    }
  }

  return [...prefixMatches, ...substringMatches, ...keywordMatches]
}
