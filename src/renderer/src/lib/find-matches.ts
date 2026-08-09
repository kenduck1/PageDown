// The one match engine both editing surfaces share -- Format mode searches
// ProseMirror's per-textblock text runs (src/renderer/src/milkdown/find-plugin.ts),
// Source mode searches the raw Markdown string. Keeping the matcher itself a
// pure function over a plain string is what makes it impossible for the two
// surfaces to disagree about what counts as a match.
export interface FindOptions {
  caseSensitive: boolean
  wholeWord: boolean
}

// Half-open [from, to) offsets into whatever string was searched.
export interface FindMatch {
  from: number
  to: number
}

// A one-character query against a 300-page document produces on the order of
// 10^5 matches, i.e. 10^5 ProseMirror decorations -- a real, reachable freeze,
// not a hypothetical. The scan STOPS at this cap rather than truncating a
// larger result afterward, so the cost is bounded on both axes. The find bar
// renders "5000+" when the cap is reached.
export const MAX_MATCHES = 5000

// Unicode-aware, unlike a regex \b (which is defined over [A-Za-z0-9_] only,
// and would therefore report the 'café' inside 'cafés' as a whole word).
const WORD_CHAR = /[\p{L}\p{N}_]/u

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isWordChar(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false
  return WORD_CHAR.test(text[index])
}

// Case-insensitive matching goes through RegExp's own `i` flag rather than
// the obvious `haystack.toLowerCase().indexOf(needle.toLowerCase())`, and
// that is a correctness requirement, not a style choice: String#toLowerCase
// is NOT length-preserving for every input ('İ'.toLowerCase() is two UTF-16
// units, not one), so lowercasing the haystack shifts every subsequent match
// offset and the highlight/replace lands on the wrong text. Matching against
// the ORIGINAL string keeps every index in the original coordinate space by
// construction. The query is escaped to a strict literal first, so no user
// input can reach the engine as regex syntax -- this is an implementation
// detail, NOT a user-facing regex feature (deliberately out of scope; see
// the design doc's "Explicitly not built").
//
// No `u` flag: it buys nothing here (the pattern is a pure escaped literal)
// and would make a query containing a lone surrogate throw a SyntaxError.
export function findMatches(text: string, query: string, options: FindOptions): FindMatch[] {
  if (query === '') return []
  const pattern = new RegExp(escapeRegExp(query), options.caseSensitive ? 'g' : 'gi')
  const matches: FindMatch[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const from = match.index
    const to = from + match[0].length
    // An escaped non-empty query can't produce a zero-length match, but an
    // exec loop that ever saw one would spin forever -- guard rather than
    // rely on that reasoning holding for every future edit to this function.
    if (to === from) {
      pattern.lastIndex = from + 1
      continue
    }
    // Non-overlapping: resume at the end of this match, so 'aa' against
    // 'aaaa' yields 2 matches rather than 3.
    pattern.lastIndex = to
    if (!options.wholeWord || (!isWordChar(text, from - 1) && !isWordChar(text, to))) {
      matches.push({ from, to })
      if (matches.length >= MAX_MATCHES) break
    }
  }
  return matches
}
