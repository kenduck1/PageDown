// Decides whether a `/` slash-command session should currently be open,
// given only the text before the cursor within its own block -- no
// ProseMirror positions, no editor access. Kept pure and Milkdown-free for
// the same reason lib/find-matches.ts and pagination/page-nav.ts are: the
// false-positive/false-negative rules ARE the feature's correctness, and a
// plain string in, plain value out shape is what makes every case in
// slash-query.test.ts a one-line assertion instead of a full editor mount.

/** A slash session that should be open, and where its trigger `/` sits. */
export interface SlashTrigger {
  /** Index of the triggering `/` within the text passed to findSlashTrigger. */
  slashOffset: number
  /** Everything after the `/` up to the cursor -- what the palette filters on. */
  query: string
}

// Exclusive of the `/` itself: a 24-character query is valid, a 25-character
// one is not. Chosen to comfortably fit every real item label/keyword this
// feature ships (see slash-filter.ts's callers) while still bailing out of
// what would otherwise be an unbounded scan the moment the user is
// obviously typing prose rather than picking a command.
//
// Exported (not just used internally) because slash-plugin.ts's own live
// session -- which tracks the query by anchor position rather than by
// re-scanning text on every keystroke (see that file's own comment for why)
// -- needs the SAME bound to decide when an already-open session's query has
// grown too long to still be a command, and a second, hand-copied `24`
// literal there would be exactly the kind of magic-number drift this
// codebase's own review process flags.
export const MAX_QUERY_LENGTH = 24

const WHITESPACE = /\s/

/**
 * Finds the currently-active slash trigger, if any, in `textBeforeCursor`.
 *
 * The approach: walk backward from the cursor to the start of the current
 * "word" -- the maximal run of non-whitespace characters ending at the
 * cursor -- and check whether THAT word starts with `/`. This is not a
 * simplification of the spec, it's an exact restatement of it: the spec's
 * "the `/` must be at the start of the block or immediately preceded by
 * whitespace, and everything after it up to the cursor must contain no
 * whitespace" describes precisely the first character of the trailing
 * whitespace-free run, because
 *   (a) a `/` that is NOT the first character of that run has some other
 *       non-whitespace character immediately before it (part of the same
 *       run), so it fails "start of block or preceded by whitespace", and
 *   (b) a `/` that IS the first character of that run is, by definition of
 *       "run", preceded only by whitespace or the start of the block, and
 *       everything after it to the cursor is whitespace-free.
 * Scanning for the trailing run is simpler than hunting for "the" `/`
 * directly and searching among multiple candidates, and it is what makes
 * "////" resolve the way it should: the FIRST `/` opens the session (start
 * of block), and the three that follow are just literal characters of the
 * query, exactly like typing "/abc" -- there is nothing in the spec that
 * excludes `/` from a query, only whitespace does. (Contrast with a naive
 * `text.lastIndexOf('/')`, which would find the fourth `/`, see it is
 * preceded by another `/` rather than whitespace, and wrongly reject the
 * whole thing.) "https://foo" and "and/or" still correctly return null
 * under this scan because their entire text is one whitespace-free run that
 * doesn't start with `/` in the first place.
 */
export function findSlashTrigger(textBeforeCursor: string): SlashTrigger | null {
  let wordStart = textBeforeCursor.length
  while (wordStart > 0 && !WHITESPACE.test(textBeforeCursor[wordStart - 1])) {
    wordStart -= 1
  }
  const word = textBeforeCursor.slice(wordStart)
  if (!word.startsWith('/')) return null

  const query = word.slice(1)
  // Provably unreachable given the scan above (`word` is, by construction,
  // a whitespace-free run, so `query` -- a suffix of it -- can't contain
  // whitespace either) but kept explicit anyway: this is the actual rule
  // the spec states, and a future edit to the scan above (e.g. widening
  // what counts as a word boundary) should not silently lose this guard
  // along with it.
  if (WHITESPACE.test(query)) return null
  if (query.length > MAX_QUERY_LENGTH) return null

  return { slashOffset: wordStart, query }
}
