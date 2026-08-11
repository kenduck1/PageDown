// Syntax tokenizer for the RAW Markdown bytes shown in Source mode
// (src/renderer/src/components/SourceEditor.tsx).
//
// WHY THIS IS NOT "a second Markdown parser", which CLAUDE.md forbids
// ------------------------------------------------------------------
// That rule ("One parser everywhere ... Don't introduce a second Markdown
// parser for any surface (preview, export, etc.)") is about anything that
// RENDERS a document: two parsers means the preview, the exported PDF and the
// editor can disagree about what a document MEANS. Nothing here renders
// anything. This module never produces document HTML, never reaches the
// pagination context, PDF/HTML export, thumbnails or Milkdown's schema, and
// its output is thrown away the instant the user leaves Source mode. It
// decides which CHARACTERS OF THE SOURCE TEXT get which colour, over bytes the
// user is looking at directly -- a text-decoration pass, not an
// interpretation. If it disagrees with remark about an edge case, the visible
// consequence is a mis-tinted asterisk, never a wrong page.
//
// WHY NOT remark-parse's own positions (the first thing evaluated, and
// rejected on measured evidence rather than taste)
// ------------------------------------------------------------------
// Reusing the real parser was the preferred option and was measured first,
// against the real corpus, using the exact plugin stack extractOutline.ts
// already builds (remark-parse + gfm + frontmatter), parse only, no
// traversal and no rendering:
//
//     short.md              (503B,   23 lines)     0.700 ms/parse
//     tables-spanning-pages (1.3KB,  36 lines)     1.417 ms/parse
//     code-blocks-spanning  (7KB,   209 lines)     2.171 ms/parse
//     long.md               (178KB, 2581 lines)   72.762 ms/parse
//     very-long.md          (536KB, 7723 lines)  227.373 ms/parse
//
// This has to run on EVERY KEYSTROKE (Source mode is a fully controlled
// textarea -- see SourceEditor's own comment: "the DOM value IS the content",
// no debounce anywhere in the path), so 72ms on a document this app's own
// corpus considers ordinary would put a visible stall between the key going
// down and the character appearing. Even the 1.4ms floor on a 1.3KB file is
// spent before a single token has been derived: mdast positions cover NODES
// (`strong` spans `**bold**` including its markers), so every marker range
// still has to be reconstructed by diffing a parent's position against its
// children's, i.e. a full tree walk on top of the parse.
//
// A line-oriented scanner is the standard answer for a source view for exactly
// this reason. Measured on the same corpus, same machine, same method:
//
//     short.md              0.012 ms     (58x faster)
//     tables-spanning-pages 0.031 ms     (46x)
//     code-blocks-spanning  0.062 ms     (35x)
//     long.md               0.604 ms    (120x)
//     very-long.md          1.825 ms    (125x)
//
// It also buys a property the tree cannot: block state is carried line to
// line, so `context` below is a complete description of everything a line's
// tokens depend on beyond its own text -- which is what makes the whole
// function trivially checkable line by line in tests.
//
// micromark's own event stream (the tokenizer INSIDE remark-parse, which does
// expose exact marker offsets) was the other candidate and was ruled out on
// two counts: `micromark` is not a direct dependency and is not resolvable
// under pnpm's strict node_modules without adding one (the same trap
// CLAUDE.md records for @milkdown/prose), and its low-level parse/postprocess
// entry points are internal API with no stability guarantee.

// A token is a half-open [start, end) range of a SINGLE LINE, in UTF-16 code
// units relative to that line's own start. Tokens never overlap and are
// emitted in ascending order, so the renderer can walk them once and emit the
// gaps between them as plain text -- see SourceHighlightLayer.
export interface SourceToken {
  start: number
  end: number
  kind: SourceTokenKind
}

export type SourceTokenKind =
  // Syntax punctuation that is not itself content: `#`, `>`, fence backticks,
  // link brackets/parens, table pipes.
  | 'marker'
  | 'heading'
  | 'strong'
  | 'emphasis'
  | 'strike'
  | 'code'
  // A fence's info string (the `ts` in ```ts), which names a language and
  // reads better as metadata than as code.
  | 'code-info'
  | 'link-text'
  | 'link-url'
  | 'list'
  | 'quote'
  | 'rule'
  | 'html'
  | 'frontmatter'
  | 'math'

export interface SourceLine {
  text: string
  // Everything about this line's tokens that is NOT derivable from `text`
  // alone: which block construct the line sits inside. Exported (rather than
  // kept internal) because it is half of SourceHighlightLayer's per-line cache
  // key -- `tokenizeLine` is a pure function of (context, text), so those two
  // strings together are a sound identity for the token list AND for the React
  // elements built from it. It encodes the fence's own opening run (e.g.
  // `code:\`\`\``) rather than a bare `code`, because whether a ``` line closes
  // the block depends on the fence that opened it. `start` is the first line's
  // context and occurs nowhere else, which is what lets `---` open YAML
  // frontmatter on line 0 and read as a thematic break everywhere else WITHOUT
  // making the token list depend on a line index the cache key doesn't carry.
  context: string
  tokens: SourceToken[]
}

// Past either of these the layer renders plain, untokenized text.
//
// Two limits rather than one because the two real costs scale on different
// axes and a single knob would have to be set for the worse of them. The
// tokenizer's own cost tracks CHARACTERS (1.8ms at 536KB above), while the
// per-keystroke cost that actually dominates is React reconciling one array
// entry per emitted token, which tracks TOKEN COUNT and is almost uncorrelated
// with size: 536KB of ordinary prose yields 2,577 tokens, while a synthetic
// 369KB file where every line is `- **a** _b_ \`c\` [d](e) ~~f~~ $$g$$` yields
// 48,000. A character-only cap would either let that second document through
// or shut highlighting off for the first.
//
// Degrading to plain text is safe BY CONSTRUCTION here in a way it would not
// be in most editors: the highlight layer's whole job is to sit under a
// transparent textarea, and plain text in that same box has exactly the same
// metrics as tokenized text -- so nothing about alignment, wrapping, scrolling
// or selection changes, and the surface simply looks like it did before this
// feature existed. That is why a hard cliff is preferable here to viewport
// virtualization, which would have to map a scroll offset back to a source
// line and CANNOT (`white-space: pre-wrap` means one source line is an unknown
// number of visual rows, so there is no arithmetic from scrollTop to a line
// index without measuring the DOM that is being built).
export const MAX_HIGHLIGHTED_SOURCE_LENGTH = 600_000
export const MAX_HIGHLIGHTED_SOURCE_TOKENS = 20_000

const ATX_HEADING = /^ {0,3}(#{1,6})(?=\s|$)/
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const THEMATIC_BREAK = /^ {0,3}(?:\*[ \t]*){3,}$|^ {0,3}(?:-[ \t]*){3,}$|^ {0,3}(?:_[ \t]*){3,}$/
const BLOCKQUOTE = /^ {0,3}(>[ \t]?)+/
const LIST_ITEM = /^([ \t]*)([-+*]|\d{1,9}[.)])(?=[ \t])/
const TASK_BOX = /^[ \t]+(\[[ xX]\])(?=[ \t]|$)/
const TABLE_ROW = /^[ \t]*\|.*\|[ \t]*$/
const FRONTMATTER_FENCE = /^---[ \t]*$/
const FRONTMATTER_END = /^(?:---|\.\.\.)[ \t]*$/
const LINK_DEFINITION = /^ {0,3}(\[[^\]]+\]:)([ \t]*)(\S+)?/

// One left-to-right pass covers every inline construct. Order inside the
// alternation IS the precedence rule and is load-bearing in three places:
// an escape (`\*`) must win over the thing it escapes; a code span must win
// over everything it contains (`` `**not bold**` ``); and every doubled
// delimiter must precede its single form, or `**bold**` matches as an
// emphasis `*` around `*bold*`.
//
// `$$...$$` (doubled) is inline math, NOT `$...$` -- matching pipeline.ts's
// own `singleDollarTextMath: false` pin, which exists precisely so prose like
// "from $50K to $120K" is not silently read as math. Getting this wrong here
// would tint half a sentence as an equation on a surface whose entire purpose
// is showing the user what the bytes really are.
const INLINE = new RegExp(
  [
    '\\\\[!-/:-@\\[-`{-~]', // backslash escape of an ASCII punctuation char
    '`+[^`]*`+', // code span (any backtick run length)
    '<!--[^]*?-->', // HTML comment, incl. this app's own pagebreak/comment markers
    '</?[a-zA-Z][^<>]*>', // raw HTML tag
    '<[^\\s<>]+@[^\\s<>]+>', // autolink, email form
    '<[a-zA-Z][a-zA-Z0-9+.\\-]*:[^\\s<>]*>', // autolink, URI form
    '!?\\[[^\\]]*\\](?:\\([^)]*\\)|\\[[^\\]]*\\])?', // image / inline link / reference link
    '\\$\\$[^$]+\\$\\$', // inline math (doubled delimiter -- see above)
    '\\*\\*[^*]+\\*\\*',
    '__[^_]+__',
    '~~[^~]+~~',
    '\\*[^*]+\\*',
    // Intraword `_` is NOT emphasis per CommonMark, and treating it as such
    // would tint half of every snake_case identifier in a technical document.
    '(?<![\\p{L}\\p{N}])_[^_]+_(?![\\p{L}\\p{N}])',
    'https?://[^\\s<>)\\]]+' // bare URL (GFM autolink literal)
  ].join('|'),
  'gu'
)

function classifyInline(match: string): SourceTokenKind {
  if (match.startsWith('\\')) return 'marker'
  if (match.startsWith('`')) return 'code'
  if (match.startsWith('<!--')) return 'html'
  if (match.startsWith('<')) {
    // An autolink is a link, a tag is markup -- both start with `<`, and the
    // alternation above only produces an autolink when it contains a scheme or
    // an `@`, so that is the discriminator rather than a fourth pattern.
    return match.includes('://') || match.includes('@') ? 'link-url' : 'html'
  }
  if (match.startsWith('$$')) return 'math'
  if (match.startsWith('**') || match.startsWith('__')) return 'strong'
  if (match.startsWith('~~')) return 'strike'
  if (match.startsWith('*') || match.startsWith('_')) return 'emphasis'
  return 'link-url'
}

// Splits a matched `[text](url)` / `![alt](src)` / `[text][ref]` run into its
// parts, so a destination reads as a destination rather than the label reading
// the same as the URL. Emitted as separate tokens rather than one nested one
// because the token stream is deliberately FLAT -- see SourceToken.
function pushLinkTokens(out: SourceToken[], base: number, match: string): void {
  const labelEnd = match.indexOf(']')
  // Defensive: the alternation can only produce a match containing `]`, but a
  // future edit to INLINE could change that, and a -1 here would silently emit
  // an inverted range that the renderer would slice into nonsense.
  if (labelEnd === -1) {
    out.push({ start: base, end: base + match.length, kind: 'link-text' })
    return
  }
  const labelStart = match.startsWith('!') ? 2 : 1
  out.push({ start: base, end: base + labelStart, kind: 'marker' })
  if (labelEnd > labelStart) {
    out.push({ start: base + labelStart, end: base + labelEnd, kind: 'link-text' })
  }
  out.push({ start: base + labelEnd, end: base + labelEnd + 1, kind: 'marker' })
  const rest = match.slice(labelEnd + 1)
  if (rest.length === 0) return
  out.push({ start: base + labelEnd + 1, end: base + labelEnd + 2, kind: 'marker' })
  if (rest.length > 2) {
    out.push({
      start: base + labelEnd + 2,
      end: base + match.length - 1,
      kind: 'link-url'
    })
  }
  out.push({ start: base + match.length - 1, end: base + match.length, kind: 'marker' })
}

// Scans [from, to) for inline constructs, appending to `out`.
function scanInline(out: SourceToken[], line: string, from: number, to: number): void {
  if (from >= to) return
  const region = line.slice(from, to)
  INLINE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = INLINE.exec(region)) !== null) {
    const base = from + match.index
    const text = match[0]
    // A zero-length match would spin the loop forever; the alternation cannot
    // produce one today, but `lastIndex` advancement is the kind of thing a
    // later pattern edit breaks silently.
    if (text.length === 0) {
      INLINE.lastIndex += 1
      continue
    }
    if (text.startsWith('[') || text.startsWith('![')) pushLinkTokens(out, base, text)
    else out.push({ start: base, end: base + text.length, kind: classifyInline(text) })
  }
}

// Adds a token for every occurrence of `char` that does NOT fall inside a
// token already emitted. Used for table pipes, which are structural but can
// also legitimately appear inside a code span on the same line -- running this
// AFTER the inline scan and skipping covered ranges is what keeps the two from
// producing overlapping tokens.
function markUncoveredChar(out: SourceToken[], line: string, char: string): void {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== char) continue
    if (out.some((token) => i >= token.start && i < token.end)) continue
    out.push({ start: i, end: i + 1, kind: 'marker' })
  }
}

// Offset of a `<!--` that this line never closes, or -1. Used to tint the
// opening line of a multi-line HTML comment: the INLINE alternation only
// matches a comment that opens AND closes on one line, so without this a user
// who comments out a block of prose sees the commented region tinted from the
// SECOND line onward while the line that did the commenting looks like
// ordinary text.
function unterminatedCommentStart(text: string, from: number): number {
  const start = text.lastIndexOf('<!--')
  if (start < from) return -1
  return text.indexOf('-->', start) === -1 ? start : -1
}

function tokenizeLine(text: string, context: string): SourceToken[] {
  const tokens: SourceToken[] = []

  if (context === 'start' && FRONTMATTER_FENCE.test(text)) {
    tokens.push({ start: 0, end: text.length, kind: 'frontmatter' })
    return tokens
  }

  if (context === 'frontmatter') {
    if (text.length > 0) tokens.push({ start: 0, end: text.length, kind: 'frontmatter' })
    return tokens
  }

  if (context.startsWith('code:')) {
    const fence = context.slice(5)
    if (isFenceClose(text, fence)) {
      tokens.push({ start: 0, end: text.length, kind: 'marker' })
    } else if (text.length > 0) {
      tokens.push({ start: 0, end: text.length, kind: 'code' })
    }
    return tokens
  }

  if (context === 'comment') {
    if (text.length > 0) tokens.push({ start: 0, end: text.length, kind: 'html' })
    return tokens
  }

  const fenceOpen = FENCE_OPEN.exec(text)
  if (fenceOpen) {
    const markerEnd = text.indexOf(fenceOpen[1]) + fenceOpen[1].length
    tokens.push({ start: 0, end: markerEnd, kind: 'marker' })
    if (fenceOpen[2].trim().length > 0) {
      tokens.push({ start: markerEnd, end: text.length, kind: 'code-info' })
    }
    return tokens
  }

  // Checked before the ATX/list branches because `---` and `***` are ambiguous
  // with both a setext underline and a bullet, and a thematic break is the one
  // reading that is unambiguous from the line alone.
  if (THEMATIC_BREAK.test(text)) {
    tokens.push({ start: 0, end: text.length, kind: 'rule' })
    return tokens
  }

  const heading = ATX_HEADING.exec(text)
  if (heading) {
    const hashEnd = text.indexOf('#') + heading[1].length
    tokens.push({ start: 0, end: hashEnd, kind: 'marker' })
    if (hashEnd < text.length) {
      // Deliberately NOT inline-scanned. A heading is already rendered bold in
      // its own colour, so tinting a `**` inside it would fight that rather
      // than add information, and the flat token model has no way to express
      // "strong, inside a heading" without a nesting layer that earns nothing
      // on a surface where headings are one short line.
      tokens.push({ start: hashEnd, end: text.length, kind: 'heading' })
    }
    return tokens
  }

  const definition = LINK_DEFINITION.exec(text)
  if (definition) {
    const labelStart = text.indexOf('[')
    tokens.push({ start: labelStart, end: labelStart + definition[1].length, kind: 'link-text' })
    if (definition[3]) {
      const urlStart = labelStart + definition[1].length + definition[2].length
      tokens.push({ start: urlStart, end: urlStart + definition[3].length, kind: 'link-url' })
    }
    return tokens
  }

  let cursor = 0
  const quote = BLOCKQUOTE.exec(text)
  if (quote) {
    tokens.push({ start: 0, end: quote[0].length, kind: 'quote' })
    cursor = quote[0].length
  }

  const list = LIST_ITEM.exec(text.slice(cursor))
  if (list) {
    const markerStart = cursor + list[1].length
    const markerEnd = markerStart + list[2].length
    tokens.push({ start: markerStart, end: markerEnd, kind: 'list' })
    cursor = markerEnd
    const task = TASK_BOX.exec(text.slice(cursor))
    if (task) {
      const boxStart = cursor + task[0].length - task[1].length
      tokens.push({ start: boxStart, end: boxStart + task[1].length, kind: 'marker' })
      cursor = boxStart + task[1].length
    }
  }

  const openComment = unterminatedCommentStart(text, cursor)
  scanInline(tokens, text, cursor, openComment === -1 ? text.length : openComment)
  if (openComment !== -1) tokens.push({ start: openComment, end: text.length, kind: 'html' })
  if (TABLE_ROW.test(text)) markUncoveredChar(tokens, text, '|')
  tokens.sort((a, b) => a.start - b.start)
  return tokens
}

function isFenceClose(text: string, fence: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < fence.length) return false
  const char = fence[0]
  for (const c of trimmed) if (c !== char) return false
  // A closing fence may be indented up to 3 spaces; more than that and it is
  // code content, not a close.
  return text.length - text.trimStart().length <= 3
}

// Advances the block state after a line has been tokenized. Kept separate from
// tokenizeLine so that function stays a pure (context, text) -> tokens map --
// which is exactly the property the per-line render cache relies on.
function nextContext(text: string, context: string): string {
  if (context === 'frontmatter') return FRONTMATTER_END.test(text) ? 'normal' : 'frontmatter'
  if (context.startsWith('code:')) return isFenceClose(text, context.slice(5)) ? 'normal' : context
  if (context === 'comment') return text.includes('-->') ? 'normal' : 'comment'
  // YAML frontmatter is only frontmatter on line 0 -- a `---` anywhere else is
  // a thematic break, and treating it as a fence opener would tint the whole
  // rest of the document as metadata.
  if (context === 'start' && FRONTMATTER_FENCE.test(text)) return 'frontmatter'
  const fenceOpen = FENCE_OPEN.exec(text)
  if (fenceOpen) return `code:${fenceOpen[1]}`
  return unterminatedCommentStart(text, 0) === -1 ? 'normal' : 'comment'
}

// Splits `source` into lines and tokenizes each one. Pure and allocation-only:
// no DOM, no React, so it is directly unit-testable and directly benchmarkable.
export function tokenizeMarkdownSource(source: string): SourceLine[] {
  const lines = source.split('\n')
  const out: SourceLine[] = new Array(lines.length)
  let context = 'start'
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    out[i] = { text, context, tokens: tokenizeLine(text, context) }
    context = nextContext(text, context)
  }
  return out
}
