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
//   split across *several* lines is bounded by ordinary indentation like
//   every other multi-line value, because a legal one has no unindented
//   lines to bound: verified against js-yaml rather than assumed, a
//   top-level key's flow value whose closing bracket sits at column 0
//   (`margins: {` / `  top: 1` / `}`) throws "deficient indentation" and is
//   not valid YAML at all, while the same document with that closer
//   indented by even one column parses fine. (An earlier round of this file
//   claimed the opposite -- that such a closer "may legally sit at column
//   0" -- and built an unbounded bracket-hunting scan on that false
//   premise; see `findBlockEnd`'s fix-wave note #3 for the critical
//   data-loss bug that caused.) `findBlockEnd` still *repairs* the invalid
//   column-0-closer shape, since it looks like JSON and is plausibly
//   hand-authored, but only via a narrowly bounded extension that can
//   consume nothing except lines made up purely of closing brackets. That
//   extension leans on `bracketDelta`, a best-effort quote/comment-aware
//   character scan rather than a real YAML tokenizer, so a sufficiently
//   adversarial line (e.g. an unbalanced bracket inside a single-quoted
//   string containing an escaped quote) can still miscount -- now
//   low-consequence, since a miscount can only mean a stray closer line is
//   or isn't consumed, never that real content is deleted.
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
// - A `#`-leading line at the *end* of an owned key's block-scalar
//   (`|`/`>`) value is left behind as cosmetic residue when that key is
//   rewritten. Comment detection here is purely textual
//   (`trim().startsWith('#')`), so it cannot tell a real YAML comment from
//   literal block-scalar text that merely happens to start with `#` -- and
//   inside a block scalar it *is* literal text (verified:
//   `load('footerCenter: |\n  # not a comment\n  more')` yields the string
//   "# not a comment\nmore"). Only a trailing one is affected: a `#`-leading
//   line with further indented content after it is correctly swallowed as
//   interior to the block (measured across first/middle/last/sole-line
//   positions), because the interior-comment rule above sees that content.
//   Accepted, not fixed: the leftover line is orphaned *cosmetic* residue,
//   not corruption -- the result is still valid, re-parseable YAML whose
//   owned values all read back correctly, and re-applying is idempotent
//   (both verified). Fixing it properly needs real block-scalar-aware
//   tokenization (tracking each block's own indentation indicator), which
//   is not worth introducing here.
// - Replacing an owned key that carries a YAML *anchor* (`footerCenter: &fc
//   Original`) drops that anchor along with the rest of the key's old text,
//   so any alias elsewhere in the block that referenced it (`footerEcho:
//   *fc`) is orphaned and the whole frontmatter block then fails to parse
//   on the next read (verified: `load` throws `unidentified alias "fc"`,
//   and `extractPageConfig` consequently returns `{}`). Accepted, not
//   fixed: anchors/aliases are exotic in document frontmatter, and
//   preserving one correctly would mean re-emitting the anchor on a value
//   this module fully rewrites -- meaningful complexity for a shape no
//   real PageDown document is expected to contain.

import { load } from 'js-yaml'
import { extractRawFrontmatter } from './frontmatter-splice'

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

/**
 * The whole-document convenience wrapper over `extractPageConfig` above:
 * takes a FULL Markdown document (not the raw YAML block), isolates its
 * frontmatter text via `extractRawFrontmatter`
 * (src/markdown/frontmatter-splice.ts), parses the owned keys out of it, and
 * merges the result over `DEFAULT_PAGE_CONFIG` to return a COMPLETE
 * `PageConfig`.
 *
 * `extractPageConfig` stays the primitive for callers that already hold the
 * raw YAML block (Page Setup's own read/write round trip works at that
 * layer, since `applyPageConfig` writes back into that same raw text); this
 * is for the far more common caller that just has a document string and
 * wants to know how to lay it out.
 *
 * The merge over `DEFAULT_PAGE_CONFIG` is MANDATORY, not a convenience:
 * `extractPageConfig` returns a `Partial<PageConfig>` that omits every key
 * the document didn't specify -- which is nearly every key of nearly every
 * real document. Handing that `Partial` to `computePageGeometry`
 * (src/typography/page-geometry.ts) instead would read `config.margins.top`
 * off an absent `margins` and produce NaN geometry, which the render context
 * turns into a `size: NaNin NaNin; margin: NaNin ...` `@page` rule that
 * silently mis-paginates rather than failing loudly. Every geometry call
 * site should route through this function rather than restate the merge, so
 * that trap exists in exactly one place.
 *
 * Safe against partial frontmatter because of a general invariant that must
 * be preserved by anything editing `extractPageConfig`: EVERY nested value it
 * can return is all-or-nothing. A shallow spread only merges one level deep,
 * so a nested object that were ever half-populated would survive the merge
 * with `undefined` sides and defeat the completeness guarantee above. Both of
 * `PageConfig`'s nested objects satisfy this today, by different mechanisms:
 *
 * - `margins`: `parseMargins` returns `undefined` unless ALL FOUR sides are
 *   present and finite, so `result.margins` is either complete or absent.
 * - `footer`: the `footerLeft`/`footerCenter`/`footerRight` branch fills all
 *   three sides from `DEFAULT_PAGE_CONFIG.footer` whenever ANY one of them is
 *   present, so `result.footer` is likewise either complete or absent.
 *
 * Adding a new nested key to `PageConfig`, or relaxing either mechanism to
 * emit a partial object, silently breaks this function's return type in a way
 * `tsc` cannot catch (the value would still be typed complete while carrying
 * `undefined` members at runtime).
 */
export function resolvePageConfig(source: string): PageConfig {
  return { ...DEFAULT_PAGE_CONFIG, ...extractPageConfig(extractRawFrontmatter(source)) }
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
// full YAML tokenizer -- its only job is to tell whether a flow-style value
// that opened on an owned key's own line (`margins: {`) is still unclosed
// at the end of the block the indentation scan already found, which is the
// one narrow case indentation alone cannot repair. See `findBlockEnd`'s
// closer-only extension for exactly how far that is allowed to reach, and
// the file-level "Flow-style values" limitation note for what this
// best-effort scan can still miscount.
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

// True if the value beginning at `valueOffset` (the index just past the
// owned key's own `key:` / `key :` prefix) genuinely *opens* a flow
// collection -- i.e. its first non-space character is `{` or `[`.
//
// Deliberately far narrower than "this line contains an unbalanced bracket
// somewhere", which is what round 2 of this file tested and which was a
// critical, content-destroying bug (see `findBlockEnd`'s fix-wave note #3).
// A plain YAML scalar may legally contain a stray unbalanced bracket that
// has no structural meaning whatsoever -- verified directly against
// js-yaml, not assumed: `load('footerCenter: Chapter {n')` returns
// `{footerCenter: 'Chapter {n'}` and `load('footerLeft: see [1')` returns
// `{footerLeft: 'see [1'}`, both perfectly ordinary single-key documents
// with no flow collection anywhere in sight.
//
// A value that opens a flow collection only *after* a tag or anchor
// (`margins: &m {`, verified valid) is not recognized here, and that is
// correct rather than a gap: every continuation line of a legal multi-line
// flow value is indented (see `findBlockEnd`), so the ordinary indentation
// scan already bounds it exactly: this predicate only gates the extra
// repair step for the *invalid* column-0-closer shape.
function opensFlowCollection(line: string, valueOffset: number): boolean {
  const firstValueChar = line.slice(valueOffset).trimStart().charAt(0)
  return firstValueChar === '{' || firstValueChar === '['
}

// A line consisting of nothing but flow-collection closers (`}`/`]`), any
// separating commas and whitespace, and an optional trailing comment --
// `}`, `] }`, `} # done`. A line matching this carries no key, no value and
// no comment text of its own, so consuming it can never destroy content.
function isFlowCloserOnlyLine(line: string): boolean {
  const withoutComment = line.replace(/#.*$/, '')
  return /[}\]]/.test(withoutComment) && /^[\s,}\]]*$/.test(withoutComment)
}

// The indentation-based core of `findBlockEnd`: an owned key's own line
// plus any immediately-following indented lines (see `isIndented`'s comment
// above for why "indented" alone is the correct and sufficient test here,
// covering margins' nested sub-lines, block-scalar content, and
// plain-wrapped scalar continuations alike). A comment/blank line
// *interior* to such a run (i.e. more indented content follows after it) is
// swallowed too, since it's describing/spacing content that belongs to the
// block being replaced -- but a comment/blank line with no further indented
// content after it belongs to whatever comes *after* the block, not the
// block itself, and is left alone.
function findIndentedBlockEnd(lines: string[], startIndex: number): number {
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

// Returns the (exclusive) end index of the block of `lines` that belongs
// to the owned key whose own line is `lines[startIndex]` -- i.e. the range
// `[startIndex, findBlockEnd(...))` is exactly what gets replaced or
// removed for that key, and everything from the returned index onward is
// untouched. `valueOffset` is the index within `lines[startIndex]` at which
// that key's value begins (just past its `key:` / `key :` prefix).
//
// Indentation is the *only* boundary rule for valid YAML, including for
// multi-line flow-style values. Verified directly against js-yaml rather
// than assumed: a top-level key's flow value whose closing bracket sits at
// column 0 (`margins: {` / `  top: 1` / `}`) is not valid YAML at all --
// `load` throws "deficient indentation" -- while the same document with the
// closer indented by even one column parses fine. So every continuation
// line of a *legal* multi-line flow value is indented, and
// `findIndentedBlockEnd` alone already bounds it exactly.
//
// The bracket-counting extension below therefore exists only to repair one
// specific *invalid* (but natural, JSON-looking, and therefore plausibly
// hand-authored) shape: a flow value whose closer was left at column 0.
// It is bounded by construction -- it may only ever consume lines that are
// nothing but closing brackets (`isFlowCloserOnlyLine`), and only while the
// collection the key's own value opened is still unbalanced -- so unlike
// round 2's version it cannot run past, or delete, any real content.
//
// Fix-wave history (three rounds, all reviewer-found real bugs -- read
// before "simplifying" any of this):
// 1. The first version treated *any* indented line as a continuation, which
//    silently deleted an unrelated indented *comment* on the next write to
//    the key above it (see page-config.test.ts's "preserves an indented
//    comment" tests). Fixed by the comment/blank handling above.
// 2. The fix for #1 over-corrected: it required a continuation line to look
//    like a mapping entry or sequence item specifically (`key:`/`- item`),
//    which stopped recognizing a block scalar's or plain-wrapped scalar's
//    own content lines as continuations, orphaning them instead (see
//    "preserves a block-scalar value" / "preserves a plain multi-line-
//    wrapped scalar value"). Fixed by widening back to plain "indented".
// 3. Round 2 also added a flow-bracket branch that took over the whole scan
//    whenever `bracketDelta(lines[startIndex]) > 0` -- i.e. whenever an
//    unbalanced bracket appeared *anywhere* on the key's line, not only
//    when the value was really a flow collection. A plain scalar may
//    legally contain one (`footerCenter: Chapter {n`; note PageDown's own
//    footer templating syntax is `{n}`/`{total}`, so a hand-typed half-open
//    brace is realistic), and for those the branch hunted for a closing
//    bracket that does not exist, ran to end-of-input, and returned
//    `lines.length` -- silently deleting every remaining line of the
//    frontmatter block (`title`, `author`, `tags`, `draft`, ...) on the
//    next write. Strictly worse than #1/#2, which produced recoverable
//    text; this destroyed content outright. Fixed by the two independent
//    guards described above (`opensFlowCollection` + `isFlowCloserOnlyLine`)
//    -- see page-config.test.ts's "round 4" regression tests.
function findBlockEnd(lines: string[], startIndex: number, valueOffset: number): number {
  let end = findIndentedBlockEnd(lines, startIndex)
  if (!opensFlowCollection(lines[startIndex], valueOffset)) return end

  let depth = 0
  for (let index = startIndex; index < end; index += 1) {
    depth += bracketDelta(lines[index])
  }
  while (depth > 0 && end < lines.length && isFlowCloserOnlyLine(lines[end])) {
    depth += bracketDelta(lines[end])
    end += 1
  }
  return end
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

    // Matched with `exec` rather than `test` so the match's own length is
    // available as the offset at which this key's *value* begins, which
    // `findBlockEnd` needs to tell a genuine flow-collection value
    // (`margins: {`) from a plain scalar that merely contains a bracket
    // (`footerCenter: Chapter {n`).
    let startIndex = -1
    let valueOffset = 0
    for (let index = 0; index < lines.length; index += 1) {
      const match = topLevelPattern.exec(lines[index])
      if (match) {
        startIndex = index
        valueOffset = match[0].length
        break
      }
    }

    if (startIndex === -1) {
      appended.push(text)
      continue
    }

    const blockEnd = findBlockEnd(lines, startIndex, valueOffset)
    lines.splice(startIndex, blockEnd - startIndex, ...text.split('\n'))
  }

  for (const text of appended) {
    lines.push(...text.split('\n'))
  }

  const joined = lines.join('\n')
  if (!hasExistingContent) return joined
  return endsWithNewline ? `${joined}\n` : joined
}
