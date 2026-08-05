// Structured, surgical read/write access to the small subset of a
// document's YAML frontmatter that PageDown itself owns: page size,
// orientation, margins, header/footer visibility + footer content,
// page-number format, and theme.
//
// This is the FIRST structured parser for frontmatter content in this
// codebase -- everywhere else (`src/markdown/pipeline.ts`,
// `src/renderer/src/milkdown/nodes/frontmatter.ts`) treats the YAML block
// as one opaque string, by design. This module operates on that same
// opaque string -- the raw text *between* the `---` fences, not including
// the fences themselves, exactly matching `remark-frontmatter`'s `yaml`
// mdast node `value` and `frontmatterNode`'s own `value` attribute in
// `src/renderer/src/milkdown/nodes/frontmatter.ts` -- as a new layer built
// on top of it, per the master design doc's explicit requirement
// (docs/superpowers/specs/2026-07-25-pagedown-design.md):
//
//   "PageDown parses out only the keys it owns... and writes back via
//   surgical text mutation of just those keys, never by re-serializing
//   the whole YAML object -- this preserves other tools' keys, comments,
//   and key order."
//
// YAML key convention
// --------------------
// `phase0/corpus/foreign-frontmatter.md` (an existing fixture, predating
// this module) already establishes `page:` (a bare scalar page-size name,
// e.g. `page: Letter`) and `margins:` as the intended key names from
// earlier design-doc-referenced examples -- this module keeps both names.
// That fixture's `margins:` is a single scalar (`margins: 1in`), too coarse
// for PageConfig's real per-side needs, so this module *extends* it to a
// nested per-side block on write, while still tolerating the old
// bare-scalar form as a "uniform margin on every side" shorthand on read
// (see `parseMargins` below) so an existing document using that shorthand
// doesn't get treated as malformed. Full convention this module reads and
// writes:
//
//   page: Letter                # 'Letter' | 'A4' | 'Legal' | 'Custom'
//   orientation: portrait       # 'portrait' | 'landscape'
//   margins:
//     top: 1
//     bottom: 1
//     left: 1
//     right: 1
//   header: true                # showHeader
//   footer: true                # showFooter
//   footerLeft: ""
//   footerCenter: "Page {n} of {total}"
//   footerRight: ""
//   pageNumberFormat: decimal   # 'decimal' | 'roman'
//   theme: default              # 'default' | 'resume' | 'letter' | 'report'
//
// Footer *visibility* (`footer: true/false`) and footer *content*
// (`footerLeft`/`footerCenter`/`footerRight`) are deliberately separate
// top-level keys rather than one nested `footer: { show, left, center,
// right }` object: PageConfig itself has no header-content fields (the
// design mockup only gives footer a Left/Center/Right row, header is a
// bare toggle), so nesting footer's show-flag together with its content
// would create an asymmetric, one-off shape unlike everything else here.
// Flat keys also keep every owned key at most one YAML "block" deep except
// `margins`, which keeps the line-based surgical mutation below simple to
// reason about.
//
// Reading vs. writing
// --------------------
// `extractPageConfig` is read-only and free to use a real YAML parser
// (`js-yaml`, already a pinned dependency -- see package.json, also
// already the parser named for this exact purpose in the master design
// doc's Security section) to correctly handle quoting, escaping, and
// nested structure. Nothing is written back from a full parse here, so
// there's no risk of reformatting/reordering the document's own
// frontmatter on a mere read.
//
// `applyPageConfig` is the write path the design doc's "surgical text
// mutation" requirement is actually about, and therefore does NOT run
// `yaml.load` + `yaml.dump` -- that would fully re-serialize the whole
// YAML object, destroying comments, key order, and any formatting choices
// made by other tools that share this frontmatter block. Instead it
// operates line-by-line on the existing raw text: an owned key's existing
// line (or, for `margins`, its whole indented block) is replaced in
// place; an owned key that doesn't exist yet is appended at the end, in
// PageConfig's own field order. Every other line -- unrelated keys,
// comments, blank lines, ordering -- is left byte-for-byte untouched.
//
// Missing frontmatter block
// --------------------------
// `applyPageConfig('', updates)` (an empty raw YAML string -- the shape a
// document with no frontmatter block at all would hand this module, since
// there is no `---`-delimited block to isolate a non-empty string from in
// the first place) synthesizes a fresh block containing exactly the
// provided keys, each on its own line, in PageConfig's canonical field
// order. It is the CALLER's responsibility -- not built here, and not
// needed by this task -- to wrap the returned string back between `---`
// fences and splice it into the document (e.g. inserting a new Milkdown
// `frontmatter` node) if the document didn't have a frontmatter block at
// all; this module only ever deals in the raw YAML text itself, matching
// `frontmatterNode`'s own `value`-attribute boundary.
//
// Known limitations of the surgical write path (accepted, not bugs)
// --------------------------------------------------------------------
// - Flow-style values: a hand-authored `margins: { top: 1, bottom: 1,
//   left: 1, right: 1 }` all on one line round-trips fine (the whole thing
//   is one line, no special handling needed). A flow value deliberately
//   split across *several* lines with its closing `}`/`]` on its own line
//   is bounded by bracket-depth counting (`findBlockEnd`/`bracketDelta`
//   below) rather than indentation, since a flow collection's closing
//   bracket has no required indentation at all -- this is a best-effort,
//   quote/comment-aware character scan, not a real YAML tokenizer, so a
//   sufficiently adversarial line (e.g. an unbalanced bracket inside a
//   single-quoted string containing an escaped quote) can still miscount.
//   Considered low-risk: this module's own writer never produces flow
//   style, so it only matters for a document some other tool authored
//   this way before PageDown ever touched it.
// - A YAML comment or blank line that sits *inside* one of PageDown's own
//   multi-line blocks (e.g. between `margins`'s `top:` and `bottom:`
//   sub-lines, or in the middle of a block-scalar value, rather than after
//   the whole block) is treated as part of that block and does not survive
//   a rewrite of that key -- only a comment/blank line that has no further
//   indented content after it (i.e. it truly follows the block, not sits
//   inside it) is preserved. See `findBlockEnd`'s own comment for the
//   exact rule and the two-round history of getting this right (over-
//   swallowing an unrelated comment, then under-swallowing a block
//   scalar's own content -- both real, reviewer-found bugs).

import { load } from 'js-yaml'

export type PageSize = 'Letter' | 'A4' | 'Legal' | 'Custom'
export type Orientation = 'portrait' | 'landscape'
export type PageNumberFormat = 'decimal' | 'roman'
export type PageTheme = 'default' | 'resume' | 'letter' | 'report'

export interface PageMargins {
  top: number
  bottom: number
  left: number
  right: number
}

export interface PageFooter {
  left: string
  center: string
  right: string
}

export interface PageConfig {
  pageSize: PageSize
  orientation: Orientation
  margins: PageMargins
  showHeader: boolean
  showFooter: boolean
  footer: PageFooter
  pageNumberFormat: PageNumberFormat
  theme: PageTheme
}

// Sensible defaults for a brand-new document / any owned key missing or
// malformed in an existing document's frontmatter. `showFooter: true` with
// a pre-filled `Page {n} of {total}` center token matches the design
// mockup's own default-selected state; `showHeader: false` because the
// mockup shows no default header content, only an empty toggle.
export const DEFAULT_PAGE_CONFIG: PageConfig = {
  pageSize: 'Letter',
  orientation: 'portrait',
  margins: { top: 1, bottom: 1, left: 1, right: 1 },
  showHeader: false,
  showFooter: true,
  footer: { left: '', center: 'Page {n} of {total}', right: '' },
  pageNumberFormat: 'decimal',
  theme: 'default'
}

const PAGE_SIZES: readonly PageSize[] = ['Letter', 'A4', 'Legal', 'Custom']
const ORIENTATIONS: readonly Orientation[] = ['portrait', 'landscape']
const PAGE_NUMBER_FORMATS: readonly PageNumberFormat[] = ['decimal', 'roman']
const THEMES: readonly PageTheme[] = ['default', 'resume', 'letter', 'report']

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Tolerates the legacy bare-scalar `margins: 1in` shorthand seen in
// phase0/corpus/foreign-frontmatter.md (uniform margin on every side, with
// or without a trailing unit suffix, and whether or not the YAML parser
// resolved it to a number already) as well as PageConfig's own structured
// per-side object. Anything else (wrong shape, non-finite sub-values,
// missing sides) is treated as absent so the caller's own default margins
// apply instead of a corrupted partial value.
function parseMargins(raw: unknown): PageMargins | undefined {
  if (isPlainObject(raw)) {
    const { top, bottom, left, right } = raw
    if (
      isFiniteNumber(top) &&
      isFiniteNumber(bottom) &&
      isFiniteNumber(left) &&
      isFiniteNumber(right)
    ) {
      return { top, bottom, left, right }
    }
    return undefined
  }
  if (isFiniteNumber(raw)) {
    return { top: raw, bottom: raw, left: raw, right: raw }
  }
  if (typeof raw === 'string') {
    const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(?:in)?$/i)
    if (match) {
      const value = Number(match[1])
      return { top: value, bottom: value, left: value, right: value }
    }
  }
  return undefined
}

/**
 * Parses only the YAML frontmatter keys PageDown owns out of a raw YAML
 * string (the opaque block `remark-frontmatter`/`frontmatterNode` already
 * isolate). Tolerates and ignores any other keys (other tools' `tags:`,
 * `draft:`, etc.) and never throws: malformed YAML, or a malformed/missing
 * value for any individual owned key, simply omits that key (or all keys,
 * if the whole block fails to parse) from the returned object rather than
 * throwing -- callers should merge the result over `DEFAULT_PAGE_CONFIG`
 * (`{ ...DEFAULT_PAGE_CONFIG, ...extractPageConfig(raw) }`) to get a
 * complete `PageConfig`.
 */
export function extractPageConfig(rawFrontmatterYaml: string): Partial<PageConfig> {
  let parsed: unknown
  try {
    parsed = load(rawFrontmatterYaml)
  } catch {
    return {}
  }
  if (!isPlainObject(parsed)) return {}

  const result: Partial<PageConfig> = {}

  if (typeof parsed.page === 'string' && (PAGE_SIZES as string[]).includes(parsed.page)) {
    result.pageSize = parsed.page as PageSize
  }
  if (
    typeof parsed.orientation === 'string' &&
    (ORIENTATIONS as string[]).includes(parsed.orientation)
  ) {
    result.orientation = parsed.orientation as Orientation
  }

  const margins = parseMargins(parsed.margins)
  if (margins) result.margins = margins

  if (typeof parsed.header === 'boolean') result.showHeader = parsed.header
  if (typeof parsed.footer === 'boolean') result.showFooter = parsed.footer

  const footerLeft = typeof parsed.footerLeft === 'string' ? parsed.footerLeft : undefined
  const footerCenter = typeof parsed.footerCenter === 'string' ? parsed.footerCenter : undefined
  const footerRight = typeof parsed.footerRight === 'string' ? parsed.footerRight : undefined
  if (footerLeft !== undefined || footerCenter !== undefined || footerRight !== undefined) {
    result.footer = {
      left: footerLeft ?? DEFAULT_PAGE_CONFIG.footer.left,
      center: footerCenter ?? DEFAULT_PAGE_CONFIG.footer.center,
      right: footerRight ?? DEFAULT_PAGE_CONFIG.footer.right
    }
  }

  if (
    typeof parsed.pageNumberFormat === 'string' &&
    (PAGE_NUMBER_FORMATS as string[]).includes(parsed.pageNumberFormat)
  ) {
    result.pageNumberFormat = parsed.pageNumberFormat as PageNumberFormat
  }
  if (typeof parsed.theme === 'string' && (THEMES as string[]).includes(parsed.theme)) {
    result.theme = parsed.theme as PageTheme
  }

  return result
}

// Up to 3 decimal places, no trailing zeros (1 -> "1", 1.5 -> "1.5",
// 1.333333 -> "1.333") -- plenty of precision for an inches measurement
// entered through a numeric UI field, without emitting ugly float noise
// (e.g. 0.1 + 0.2's classic 0.30000000000000004) into the user's document.
function formatMarginNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return String(Math.round(value * 1000) / 1000)
}

// Always double-quotes: this module's own footer text fields are free-form
// author text that can legally contain a colon, a leading `-`, or even the
// literal three-character sequence `---` (see page-config.test.ts's
// adversarial case) -- any of which would otherwise be ambiguous with a
// YAML plain-scalar, sequence-item, or document-separator token if written
// unquoted. JSON's escaping rules are a safe subset of YAML's
// double-quoted-scalar escaping, so `JSON.stringify` always produces a
// valid, unambiguous YAML double-quoted scalar.
function quoteYamlString(value: string): string {
  return JSON.stringify(value)
}

interface OwnedLine {
  key: string
  // May itself be multi-line (`\n`-joined) -- e.g. `margins`'s 4-line
  // nested block -- but always represents exactly one owned key's worth
  // of YAML text, replacing exactly that key's own existing line(s), or
  // appended as a unit if the key doesn't exist yet.
  text: string
}

// Builds the new YAML text for every owned key present in `updates`, in
// PageConfig's own field order -- this fixed order is what any newly
// *appended* keys (i.e. not already present in the document) end up in,
// since there's no existing position to preserve for them.
function buildOwnedLines(updates: Partial<PageConfig>): OwnedLine[] {
  const lines: OwnedLine[] = []

  if (updates.pageSize !== undefined) {
    lines.push({ key: 'page', text: `page: ${updates.pageSize}` })
  }
  if (updates.orientation !== undefined) {
    lines.push({ key: 'orientation', text: `orientation: ${updates.orientation}` })
  }
  if (updates.margins !== undefined) {
    const m = updates.margins
    lines.push({
      key: 'margins',
      text: [
        'margins:',
        `  top: ${formatMarginNumber(m.top)}`,
        `  bottom: ${formatMarginNumber(m.bottom)}`,
        `  left: ${formatMarginNumber(m.left)}`,
        `  right: ${formatMarginNumber(m.right)}`
      ].join('\n')
    })
  }
  if (updates.showHeader !== undefined) {
    lines.push({ key: 'header', text: `header: ${updates.showHeader}` })
  }
  if (updates.showFooter !== undefined) {
    lines.push({ key: 'footer', text: `footer: ${updates.showFooter}` })
  }
  if (updates.footer !== undefined) {
    const f = updates.footer
    lines.push({ key: 'footerLeft', text: `footerLeft: ${quoteYamlString(f.left)}` })
    lines.push({ key: 'footerCenter', text: `footerCenter: ${quoteYamlString(f.center)}` })
    lines.push({ key: 'footerRight', text: `footerRight: ${quoteYamlString(f.right)}` })
  }
  if (updates.pageNumberFormat !== undefined) {
    lines.push({ key: 'pageNumberFormat', text: `pageNumberFormat: ${updates.pageNumberFormat}` })
  }
  if (updates.theme !== undefined) {
    lines.push({ key: 'theme', text: `theme: ${updates.theme}` })
  }

  return lines
}

// A line is a genuine continuation of the immediately preceding owned
// key's own value if it is indented at all (column > 0). Every owned key
// this module ever anchors on sits at column 0 (top-level), so YAML's own
// grammar guarantees there is no *other* valid interpretation of a
// more-indented line directly following it: it can only be (a) a nested
// mapping/sequence entry belonging to that key (the only owned key shaped
// this way is `margins`), (b) a block scalar's (`|`/`>`) own content
// lines, or (c) a plain scalar's line-folded continuation. Verified
// directly against js-yaml rather than assumed: an indented line that
// *looks* like an unrelated mapping entry immediately after a scalar
// (`theme: default\n  nested: value`) does not parse as anything else at
// all -- `js-yaml.load` throws ("bad indentation of a mapping entry"),
// confirming there is no competing valid shape "indented" needs to
// distinguish itself from here, other than a comment or blank line (which
// never form part of any value).
//
// Fix-wave history (two rounds, both reviewer-found real bugs):
// 1. The very first version of this scan treated *any* indented line as a
//    continuation, which silently deleted an unrelated indented *comment*
//    on the next write to a key above it (a real data-loss bug -- see
//    page-config.test.ts's "preserves an indented comment" tests).
// 2. The fix for #1 over-corrected: it required a continuation line to
//    look like a mapping entry or sequence item specifically
//    (`key:`/`- item`), which also stopped recognizing a block-scalar's or
//    plain-wrapped scalar's own content lines as continuations (neither
//    looks like `key:` or `- item`), silently orphaning them on the next
//    write instead -- a second real corruption bug (see
//    page-config.test.ts's "preserves a block-scalar value" and
//    "preserves a plain multi-line-wrapped scalar value" tests).
// The comment/blank exclusion below is exactly what #1 needed and is
// sufficient on its own -- no narrower "does this look like a mapping
// entry" check is needed or correct, per the js-yaml verification above.
function isIndented(line: string): boolean {
  return /^[ \t]/.test(line)
}

function isCommentOrBlankLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed === '' || trimmed.startsWith('#')
}

// Counts unbalanced flow-collection brackets (`{`/`[` vs `}`/`]`) on a
// single line, ignoring bracket characters inside a quoted string and
// anything after an unquoted `#` (a real YAML comment). Deliberately not a
// full YAML tokenizer -- good enough to track whether a flow-style value
// (e.g. `margins: {` with the rest spanning several further lines) is
// still "open", which is the one shape column-0-indentation-based
// scanning can never bound correctly on its own: a flow collection's
// closing bracket has no required indentation at all, and may legally sit
// at column 0.
function bracketDelta(line: string): number {
  let delta = 0
  let quote: '"' | "'" | null = null
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#') break
    if (ch === '{' || ch === '[') delta += 1
    else if (ch === '}' || ch === ']') delta -= 1
  }
  return delta
}

// Returns the (exclusive) end index of the block of `lines` that belongs
// to the owned key whose own line is `lines[startIndex]` -- i.e. the range
// `[startIndex, findBlockEnd(lines, startIndex))` is exactly what gets
// replaced or removed for that key, and everything from the returned
// index onward is untouched.
function findBlockEnd(lines: string[], startIndex: number): number {
  const openFlowDepth = bracketDelta(lines[startIndex])
  if (openFlowDepth > 0) {
    // Flow-style value left open on the key's own line (e.g.
    // `margins: {`): bounded by bracket balance, not indentation. Lower
    // priority, documented edge case -- see the file-level comment's
    // "Flow-style values" note for this helper's known limits (no real
    // YAML tokenization, just a best-effort quote/comment-aware bracket
    // count).
    let depth = openFlowDepth
    let index = startIndex + 1
    while (index < lines.length && depth > 0) {
      depth += bracketDelta(lines[index])
      index += 1
    }
    return index
  }

  // Block-style value: its own line plus any immediately-following
  // indented lines (see `isIndented`'s comment above for why "indented"
  // alone is the correct and sufficient test here, covering margins'
  // nested sub-lines, block-scalar content, and plain-wrapped scalar
  // continuations alike). A comment/blank line *interior* to such a run
  // (i.e. more indented content follows after it) is swallowed too, since
  // it's describing/spacing content that belongs to the block being
  // replaced -- but a comment/blank line with no further indented content
  // after it belongs to whatever comes *after* the block, not the block
  // itself, and is left alone.
  let index = startIndex + 1
  while (index < lines.length) {
    if (isIndented(lines[index]) && !isCommentOrBlankLine(lines[index])) {
      index += 1
      continue
    }
    if (isCommentOrBlankLine(lines[index])) {
      let lookahead = index
      while (lookahead < lines.length && isCommentOrBlankLine(lines[lookahead])) {
        lookahead += 1
      }
      if (lookahead < lines.length && isIndented(lines[lookahead])) {
        index = lookahead + 1
        continue
      }
    }
    break
  }
  return index
}

/**
 * Takes the existing raw YAML frontmatter text and a set of new PageConfig
 * values, and returns updated YAML text where PageDown's own keys are
 * surgically replaced or added -- preserving every other line, key,
 * comment, and key order exactly as they were. Never parses-then-fully-
 * reserializes the whole YAML object (see the file-level comment above for
 * why that would be wrong here).
 *
 * `rawFrontmatterYaml` may be an empty string (no existing frontmatter
 * block); see "Missing frontmatter block" above.
 */
export function applyPageConfig(rawFrontmatterYaml: string, updates: Partial<PageConfig>): string {
  const ownedLines = buildOwnedLines(updates)
  if (ownedLines.length === 0) return rawFrontmatterYaml

  const hasExistingContent = rawFrontmatterYaml.length > 0
  const endsWithNewline = hasExistingContent && rawFrontmatterYaml.endsWith('\n')
  let lines = hasExistingContent ? rawFrontmatterYaml.split('\n') : []
  // `split('\n')` on a string ending in `\n` produces a trailing empty-
  // string element; drop it here and restore exactly one trailing newline
  // at the end (via `endsWithNewline`) so this function reproduces the
  // input's own trailing-newline convention rather than silently adding or
  // removing one.
  if (endsWithNewline) lines = lines.slice(0, -1)

  const appended: string[] = []

  for (const { key, text } of ownedLines) {
    // Anchored so a foreign tool's own *nested* (indented) key that merely
    // happens to share a name with one PageDown owns (e.g. some other
    // tool's own sub-field literally named `page:`) is never mistaken for
    // PageDown's top-level key -- only a line with zero leading
    // whitespace whose first characters are `key` can match. `[ \t]*:`
    // (rather than a bare `:`) tolerates whitespace before the colon
    // (`page : Letter`, which js-yaml itself accepts as an ordinary
    // `page: Letter`) -- fix-wave note: the original unspaced `:` missed
    // this form entirely, so an existing `page : Letter` key was never
    // found and a *second* `page: ...` line got appended instead,
    // producing a duplicate mapping key that js-yaml then refuses to
    // parse at all on the next read (a real, reviewer-confirmed
    // corruption bug -- see page-config.test.ts's "space before colon"
    // tests).
    const topLevelPattern = new RegExp(`^${key}[ \t]*:`)
    const startIndex = lines.findIndex((line) => topLevelPattern.test(line))

    if (startIndex === -1) {
      appended.push(text)
      continue
    }

    lines.splice(startIndex, findBlockEnd(lines, startIndex) - startIndex, ...text.split('\n'))
  }

  for (const text of appended) {
    lines.push(...text.split('\n'))
  }

  const joined = lines.join('\n')
  if (!hasExistingContent) return joined
  return endsWithNewline ? `${joined}\n` : joined
}
